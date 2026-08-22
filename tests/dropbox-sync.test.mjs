import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DropboxProviderError,
  batchDropboxEntries,
  createDropboxSync,
  deterministicDropboxEventId,
  dropboxProviderRequest,
  enqueueDropboxSync,
  normalizeDropboxEntry,
} from '../functions/_lib/dropbox-sync.js';
import { onRequestPost as dropboxWebhook } from '../functions/webhooks/dropbox.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const ROOT = '/Northlight';
const BASE = `${ROOT}/NL-1001-ABCD - 24 Albany Road`;
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const NOW = Date.parse('2026-08-21T12:00:00.000Z');

function providerFile(path, id, revision = 'r1', hash = HASH_A) {
  return {
    '.tag': 'file',
    id,
    name: path.split('/').at(-1),
    path_display: path,
    rev: revision,
    content_hash: hash,
    size: 101,
    server_modified: '2026-08-21T11:00:00.000Z',
    client_modified: '2026-08-21T10:59:00.000Z',
  };
}

function providerDelete(path) {
  return { '.tag': 'deleted', name: path.split('/').at(-1), path_display: path };
}

function fakeDatabase({ cursor = null, metadata = { page_limit: 200 }, claimed = true, advanceHook = null, files = [] } = {}) {
  const state = {
    cursor,
    metadata,
    generation: 7,
    files: new Map(files.map(file => [file.path.toLowerCase(), { ...file }])),
    events: new Set(),
    calls: [],
    finishes: [],
  };

  function apply(entries) {
    let matched = 0;
    let changed = 0;
    let prefixHasMore = false;
    for (const entry of entries) {
      if (entry.is_prefix_delete) {
        const prefix = entry.path.toLowerCase().replace(/\/+$/, '');
        const candidates = [...state.files.values()]
          .filter(file => !file.is_deleted && (
            file.path.toLowerCase() === prefix
            || file.path.toLowerCase().startsWith(`${prefix}/`)
          ))
          .sort((left, right) => left.path.localeCompare(right.path));
        prefixHasMore = candidates.length > 200;
        for (const file of candidates.slice(0, 200)) {
          file.is_deleted = true;
          file.sync_page_id = entry.page_id;
          file.sync_page_order = entry.page_order;
          matched += 1;
          changed += 1;
          state.events.add(`${entry.event_id}:${file.provider_file_id || file.path.toLowerCase()}`);
        }
        continue;
      }
      matched += 1;
      const key = entry.path.toLowerCase();
      let target = state.files.get(key) || null;
      let source = entry.is_deleted || !entry.provider_file_id
        ? null
        : [...state.files.values()].find(file => file.provider_file_id === entry.provider_file_id) || null;
      if ([source, target].some(file => file
        && file.sync_page_id === entry.page_id
        && Number(file.sync_page_order) > entry.page_order)) {
        continue;
      }
      if (entry.is_deleted && !target) continue;
      const before = target ? JSON.stringify(target) : null;
      if (source && source !== target) {
        if (target && !target.is_deleted) throw new Error('dropbox_path_conflict');
        if (target) state.files.delete(key);
        state.files.delete(source.path.toLowerCase());
        source = {
          ...source,
          ...entry,
          sync_page_id: entry.page_id,
          sync_page_order: entry.page_order,
        };
        state.files.set(key, source);
        target = source;
      } else if (target) {
        const preserved = entry.is_deleted ? {
          provider_file_id: target.provider_file_id,
          file_type: target.file_type,
          size_bytes: target.size_bytes,
          content_hash: target.content_hash,
          revision: target.revision,
          modified_at: target.modified_at,
        } : {};
        target = {
          ...target,
          ...entry,
          ...preserved,
          sync_page_id: entry.page_id,
          sync_page_order: entry.page_order,
        };
        state.files.set(key, target);
      } else {
        target = {
          ...entry,
          sync_page_id: entry.page_id,
          sync_page_order: entry.page_order,
        };
        state.files.set(key, target);
      }
      if (before !== JSON.stringify(target) && !state.events.has(entry.event_id)) {
        changed += 1;
        state.events.add(entry.event_id);
      }
    }
    return { matched, changed, prefix_has_more: prefixHasMore };
  }

  const database = async (_env, table, options = {}) => {
    const payload = options.payload || {};
    state.calls.push({ table, payload: structuredClone(payload) });
    if (table === 'rpc/northlight_claim_dropbox_sync') {
      return claimed
        ? { claimed: true, generation: state.generation, cursor: state.cursor, metadata: state.metadata }
        : { claimed: false, generation: state.generation };
    }
    if (table === 'rpc/northlight_apply_dropbox_sync_batch') return apply(payload.p_entries);
    if (table === 'rpc/northlight_advance_dropbox_sync') {
      if (advanceHook) await advanceHook(payload, state);
      if (payload.p_expected_cursor !== state.cursor) throw new Error('dropbox_cursor_changed');
      state.cursor = payload.p_cursor;
      state.metadata = payload.p_metadata;
      return { generation: state.generation, cursor: state.cursor, metadata: state.metadata };
    }
    if (table === 'rpc/northlight_finish_dropbox_sync') {
      state.finishes.push(payload.p_last_error);
      return { finished: true, cursor: state.cursor, last_error: payload.p_last_error };
    }
    if (table === 'external_sync_events') return null;
    throw new Error(`unexpected_database_call:${table}`);
  };
  return { database, state };
}

function syncHarness(database, providerRequest, extra = {}) {
  let tokenReads = 0;
  const sync = createDropboxSync({
    database,
    getTenant: async () => ({ id: TENANT_ID }),
    getToken: async (_env, provider) => {
      assert.equal(provider, 'dropbox');
      tokenReads += 1;
      return 'bounded-test-token';
    },
    providerRequest,
    enqueue: extra.enqueue || (async () => { throw new Error('unexpected_continuation'); }),
    clock: extra.clock || (() => NOW),
    ownerId: () => OWNER_ID,
  });
  return { sync, tokenReads: () => tokenReads };
}

test('normalization is root-bound, stage-bound and produces stable deterministic event UUIDs', async () => {
  const path = `${BASE}/02_EDITED/PHOTOS/front.jpg`;
  const normalized = normalizeDropboxEntry(providerFile(path, 'id:front'));
  assert.deepEqual({
    task: normalized.task_no,
    stage: normalized.stage,
    service: normalized.service_code,
    deleted: normalized.is_deleted,
  }, { task: 'NL-1001-ABCD', stage: '02_EDITED', service: 'photos', deleted: false });
  assert.equal(normalizeDropboxEntry(providerFile('/Elsewhere/NL-1001-ABCD/02_EDITED/PHOTOS/front.jpg', 'id:x')), null);
  assert.equal(normalizeDropboxEntry(providerFile(`${BASE}/releases/release-1/front.jpg`, 'id:x')), null);
  const folderDelete = normalizeDropboxEntry(providerDelete(`${BASE}/02_EDITED/PHOTOS`));
  assert.deepEqual({
    task: folderDelete.task_no,
    stage: folderDelete.stage,
    service: folderDelete.service_code,
    prefix: folderDelete.is_prefix_delete,
  }, { task: 'NL-1001-ABCD', stage: '02_EDITED', service: 'photos', prefix: true });
  const rootDelete = normalizeDropboxEntry(providerDelete(ROOT));
  assert.equal(rootDelete.task_no, null);
  assert.equal(rootDelete.is_prefix_delete, true);
  const first = await deterministicDropboxEventId(TENANT_ID, 'cursor-1', normalized);
  const retry = await deterministicDropboxEventId(TENANT_ID, 'cursor-1', normalized);
  const later = await deterministicDropboxEventId(TENANT_ID, 'cursor-2', normalized);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(first, retry);
  assert.notEqual(first, later);
});

test('bounded batching enforces both entry count and serialized payload size', () => {
  const entries = Array.from({ length: 401 }, (_, index) => ({ event_id: String(index), path: `/p/${index}` }));
  assert.deepEqual(batchDropboxEntries(entries).map(batch => batch.length), [200, 200, 1]);
  const byteBounded = batchDropboxEntries([
    { value: 'a'.repeat(80) },
    { value: 'b'.repeat(80) },
  ], { maxEntries: 200, maxBytes: 130 });
  assert.deepEqual(byteBounded.map(batch => batch.length), [1, 1]);
});

test('multi-page sync atomically covers rename, delete and overwrite without losing the cursor', async () => {
  const oldPath = `${BASE}/01_RAW/PHOTOS/old.jpg`;
  const newPath = `${BASE}/01_RAW/PHOTOS/renamed.jpg`;
  const deletePath = `${BASE}/01_RAW/PHOTOS/delete.jpg`;
  const overwritePath = `${BASE}/02_EDITED/PHOTOS/overwrite.jpg`;
  const initial = [
    { ...normalizeDropboxEntry(providerFile(oldPath, 'id:rename')), path: oldPath },
    { ...normalizeDropboxEntry(providerFile(deletePath, 'id:delete')), path: deletePath },
    { ...normalizeDropboxEntry(providerFile(overwritePath, 'id:overwrite')), path: overwritePath },
  ];
  const { database, state } = fakeDatabase({ files: initial });
  const providerCalls = [];
  const { sync, tokenReads } = syncHarness(database, async (_token, endpoint, payload) => {
    providerCalls.push([endpoint, payload]);
    if (endpoint === 'files/list_folder') {
      assert.equal(payload.limit, 200);
      return {
        entries: [providerDelete(oldPath), providerFile(newPath, 'id:rename'), providerDelete(deletePath)],
        cursor: 'cursor-1',
        has_more: true,
      };
    }
    assert.equal(endpoint, 'files/list_folder/continue');
    assert.equal(payload.cursor, 'cursor-1');
    return {
      entries: [providerFile(overwritePath, 'id:overwrite', 'r2', HASH_B)],
      cursor: 'cursor-2',
      has_more: false,
    };
  });

  const result = await sync({ DROPBOX_ROOT: ROOT });

  assert.equal(tokenReads(), 2);
  assert.equal(providerCalls.length, 2);
  assert.equal(result.processedPages, 2);
  assert.equal(result.total, 4);
  assert.equal(result.hasMore, false);
  assert.equal(state.cursor, 'cursor-2');
  assert.equal(state.files.has(oldPath.toLowerCase()), false);
  assert.equal(state.files.get(newPath.toLowerCase()).provider_file_id, 'id:rename');
  assert.equal(state.files.get(deletePath.toLowerCase()).is_deleted, true);
  assert.equal(state.files.get(deletePath.toLowerCase()).revision, 'r1');
  assert.equal(state.files.get(overwritePath.toLowerCase()).revision, 'r2');
  assert.equal(state.files.get(overwritePath.toLowerCase()).content_hash, HASH_B);
  assert.deepEqual(
    state.calls.filter(call => call.table === 'rpc/northlight_advance_dropbox_sync').map(call => [
      call.payload.p_expected_cursor,
      call.payload.p_cursor,
    ]),
    [[null, 'cursor-1'], ['cursor-1', 'cursor-2']],
  );
  assert.deepEqual(state.finishes, [null]);
});

test('provider cursor reset is fenced to null before a bounded full listing restarts', async () => {
  const path = `${BASE}/04_REFERENCE/floorplan.pdf`;
  const { database, state } = fakeDatabase({ cursor: 'stale-cursor' });
  const providerCalls = [];
  const queued = [];
  const { sync } = syncHarness(database, async (_token, endpoint, payload) => {
    providerCalls.push([endpoint, payload]);
    if (endpoint === 'files/list_folder/continue') throw new DropboxProviderError(409, 'reset');
    return { entries: [providerFile(path, 'id:reference')], cursor: 'fresh-cursor', has_more: false };
  }, { enqueue: async (_env, options) => { queued.push(options); } });

  const reset = await sync({ DROPBOX_ROOT: ROOT });
  assert.equal(reset.continuationQueued, true);
  assert.equal(state.cursor, null);
  const result = await sync({ DROPBOX_ROOT: ROOT });

  assert.equal(result.processedPages, 1);
  assert.deepEqual(providerCalls.map(call => call[0]), ['files/list_folder/continue', 'files/list_folder']);
  assert.deepEqual(queued, [{ webhookAt: null }]);
  assert.deepEqual(
    state.calls.filter(call => call.table === 'rpc/northlight_advance_dropbox_sync').map(call => [
      call.payload.p_expected_cursor,
      call.payload.p_cursor,
    ]),
    [['stale-cursor', null], [null, null], [null, 'fresh-cursor']],
  );
  assert.equal(state.cursor, 'fresh-cursor');
});

test('large folder deletion drains in bounded replay-safe chunks before advancing the provider cursor', async () => {
  const folder = `${BASE}/02_EDITED/PHOTOS/old-gallery`;
  const files = Array.from({ length: 250 }, (_, index) => {
    const path = `${folder}/image-${String(index).padStart(3, '0')}.jpg`;
    return normalizeDropboxEntry(providerFile(path, `id:old-${index}`));
  });
  const beforeDelete = providerFile(files[0].path, files[0].provider_file_id);
  const afterDeletePath = `${folder}/replacement.jpg`;
  const { database, state } = fakeDatabase({ files });
  const queued = [];
  let providerCalls = 0;
  const { sync } = syncHarness(database, async () => {
    providerCalls += 1;
    return {
      entries: [beforeDelete, providerDelete(folder), providerFile(afterDeletePath, 'id:replacement')],
      cursor: 'cursor-folder-delete',
      has_more: false,
    };
  }, { enqueue: async (_env, options) => { queued.push(options); } });

  const first = await sync({ DROPBOX_ROOT: ROOT });
  assert.equal(first.continuationQueued, true);
  assert.equal(state.cursor, null);
  assert.equal([...state.files.values()].filter(file => file.is_deleted).length, 200);

  const second = await sync({ DROPBOX_ROOT: ROOT });
  assert.equal(second.continuationQueued, false);
  assert.equal(state.cursor, 'cursor-folder-delete');
  assert.equal(providerCalls, 2);
  assert.deepEqual(queued, [{ webhookAt: null }]);
  assert.equal([...state.files.values()].filter(file => !file.is_deleted).length, 1);
  assert.equal(state.files.get(afterDeletePath.toLowerCase()).provider_file_id, 'id:replacement');
  const prefixCalls = state.calls.filter(call => call.table === 'rpc/northlight_apply_dropbox_sync_batch'
    && call.payload.p_entries[0]?.is_prefix_delete);
  assert.equal(prefixCalls.length, 2);
  assert.ok(prefixCalls.every(call => call.payload.p_entries.length === 1));
  assert.ok(prefixCalls.every(call => /^[0-9a-f-]{36}$/i.test(call.payload.p_entries[0].page_id)));
  assert.ok(prefixCalls.every(call => Number.isInteger(call.payload.p_entries[0].page_order)));
  assert.equal(prefixCalls[0].payload.p_entries[0].page_id, prefixCalls[1].payload.p_entries[0].page_id);
});

test('connection-generation reset tombstones a stale account root in bounded chunks before relisting', async () => {
  const files = Array.from({ length: 401 }, (_, index) => {
    const path = `${BASE}/01_RAW/PHOTOS/account-old-${String(index).padStart(3, '0')}.jpg`;
    return normalizeDropboxEntry(providerFile(path, `id:account-old-${index}`));
  });
  const resetSeed = '33333333-3333-4333-8333-333333333333';
  const { database, state } = fakeDatabase({
    files,
    metadata: {
      page_limit: 200,
      reset_cleanup_required: true,
      reset_cleanup_seed: resetSeed,
    },
  });
  let providerCalls = 0;
  const queued = [];
  const { sync } = syncHarness(database, async () => {
    providerCalls += 1;
    return { entries: [], cursor: 'new-account-cursor', has_more: false };
  }, { enqueue: async (_env, options) => { queued.push(options); } });

  const first = await sync({ DROPBOX_ROOT: ROOT });
  const second = await sync({ DROPBOX_ROOT: ROOT });
  const third = await sync({ DROPBOX_ROOT: ROOT });

  assert.equal(first.continuationQueued, true);
  assert.equal(second.continuationQueued, true);
  assert.equal(third.continuationQueued, false);
  assert.equal(providerCalls, 1);
  assert.equal(queued.length, 2);
  assert.equal([...state.files.values()].filter(file => !file.is_deleted).length, 0);
  assert.equal(state.cursor, 'new-account-cursor');
  assert.equal(state.metadata.reset_cleanup_required, false);
  const cleanupCalls = state.calls.filter(call => call.table === 'rpc/northlight_apply_dropbox_sync_batch'
    && call.payload.p_entries[0]?.path === ROOT);
  assert.deepEqual(cleanupCalls.map(call => call.payload.p_entries.length), [1, 1, 1]);
  assert.ok(cleanupCalls.every(call => call.payload.p_entries[0].event_id === resetSeed));
});

test('a provider page that changes during bounded prefix replay fails closed without cursor loss', async () => {
  const folder = `${BASE}/01_RAW/PHOTOS/changing-folder`;
  const files = Array.from({ length: 201 }, (_, index) => {
    const path = `${folder}/image-${String(index).padStart(3, '0')}.jpg`;
    return normalizeDropboxEntry(providerFile(path, `id:changing-${index}`));
  });
  const { database, state } = fakeDatabase({ files });
  let calls = 0;
  const { sync } = syncHarness(database, async () => {
    calls += 1;
    return {
      entries: [providerDelete(folder)],
      cursor: calls === 1 ? 'cursor-stable-a' : 'cursor-changed-b',
      has_more: false,
    };
  }, { enqueue: async () => {} });

  const first = await sync({ DROPBOX_ROOT: ROOT });
  assert.equal(first.continuationQueued, true);
  await assert.rejects(sync({ DROPBOX_ROOT: ROOT }), /dropbox_page_changed/);
  assert.equal(state.cursor, null);
  assert.equal([...state.files.values()].filter(file => !file.is_deleted).length, 1);
  assert.equal(state.finishes.at(-1), 'dropbox_page_changed');
});

test('a missing Dropbox root tombstones every indexed descendant before recording root-missing state', async () => {
  const paths = [
    `${BASE}/01_RAW/PHOTOS/one.jpg`,
    `${BASE}/04_REFERENCE/instructions.pdf`,
  ];
  const { database, state } = fakeDatabase({
    files: paths.map((path, index) => normalizeDropboxEntry(providerFile(path, `id:missing-${index}`))),
  });
  const { sync } = syncHarness(database, async () => {
    throw new DropboxProviderError(409, 'path/not_found');
  });

  const result = await sync({ DROPBOX_ROOT: ROOT });

  assert.equal(result.rootMissing, true);
  assert.equal(result.continuationQueued, false);
  assert.equal([...state.files.values()].filter(file => !file.is_deleted).length, 0);
  assert.equal(state.cursor, null);
  assert.equal(state.metadata.root_missing, true);
});

test('stale cursor advancement fails closed and persists only the stable error code', async () => {
  const path = `${BASE}/01_RAW/PHOTOS/front.jpg`;
  const { database, state } = fakeDatabase({
    cursor: 'cursor-0',
    advanceHook: async payload => {
      if (payload.p_cursor === 'cursor-1') throw new Error('database_400:{"message":"dropbox_cursor_changed","secret":"never-store"}');
    },
  });
  const { sync } = syncHarness(database, async () => ({
    entries: [providerFile(path, 'id:front')],
    cursor: 'cursor-1',
    has_more: false,
  }));

  await assert.rejects(sync({ DROPBOX_ROOT: ROOT }), error => {
    assert.equal(error.message, 'dropbox_cursor_changed');
    assert.doesNotMatch(error.message, /secret|never-store/);
    return true;
  });
  assert.equal(state.cursor, 'cursor-0');
  assert.deepEqual(state.finishes, ['dropbox_cursor_changed']);
});

test('a contended lease does no provider work and asks the queue consumer to retry', async () => {
  const { database } = fakeDatabase({ claimed: false });
  let providerCalls = 0;
  const { sync, tokenReads } = syncHarness(database, async () => { providerCalls += 1; });
  const result = await sync({ DROPBOX_ROOT: ROOT });
  assert.equal(result.busy, true);
  assert.equal(result.retryAfterSeconds, 60);
  assert.equal(providerCalls, 0);
  assert.equal(tokenReads(), 1);
});

test('runtime and provider-call ceilings queue exactly one durable continuation', async () => {
  let currentTime = NOW;
  let providerCalls = 0;
  const queued = [];
  const { database, state } = fakeDatabase();
  const { sync } = syncHarness(database, async () => {
    providerCalls += 1;
    currentTime += 21_000;
    return { entries: [], cursor: `cursor-${providerCalls}`, has_more: true };
  }, {
    clock: () => currentTime,
    enqueue: async (_env, options) => { queued.push(options); },
  });

  const result = await sync({ DROPBOX_ROOT: ROOT });

  assert.equal(providerCalls, 1);
  assert.equal(result.continuationQueued, true);
  assert.equal(result.hasMore, true);
  assert.equal(state.cursor, 'cursor-1');
  assert.deepEqual(queued, [{ webhookAt: null }]);
});

test('provider errors never expose or persist malicious response bodies', async () => {
  const secret = 'victim@example.com /Northlight/private/customer.jpg oauth-refresh-token';
  await assert.rejects(
    dropboxProviderRequest('token', 'files/list_folder/continue', {}, async () => new Response(JSON.stringify({
      error_summary: `malicious/${secret}`,
      error: { '.tag': secret },
      description: secret,
    }), { status: 409, headers: { 'content-type': 'application/json' } })),
    error => {
      assert.equal(error.message, 'dropbox_409:provider_error');
      assert.doesNotMatch(error.message, /victim|customer|oauth|token/i);
      return true;
    },
  );
  await assert.rejects(
    dropboxProviderRequest('token', 'files/list_folder/continue', {}, async () => new Response(JSON.stringify({
      error_summary: `reset/${secret}`,
    }), { status: 409 })),
    error => {
      assert.equal(error.message, 'dropbox_409:reset');
      assert.doesNotMatch(error.message, /victim|customer|oauth|token/i);
      return true;
    },
  );
  await assert.rejects(
    dropboxProviderRequest('token', 'files/list_folder', {}, async () => new Response('{}', {
      status: 500,
      headers: { 'content-length': String(4 * 1024 * 1024 + 1) },
    })),
    /dropbox_500:response_too_large/,
  );

  const preclaimFailure = createDropboxSync({
    getTenant: async () => {
      throw new Error('database_500:{"token":"preclaim-secret","path":"/private/customer"}');
    },
  });
  await assert.rejects(preclaimFailure({}), error => {
    assert.equal(error.message, 'dropbox_sync_failed');
    assert.doesNotMatch(error.message, /secret|private|customer|token/i);
    return true;
  });
});

test('provider requests have a hard deadline and cursor pages must make bounded progress', async () => {
  await assert.rejects(
    dropboxProviderRequest(
      'token',
      'files/list_folder',
      {},
      async (_url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('secret timeout detail')), { once: true });
      }),
      { timeoutMs: 5 },
    ),
    error => {
      assert.equal(error.message, 'dropbox_0:request_timeout');
      assert.doesNotMatch(error.message, /secret/i);
      return true;
    },
  );

  const { database, state } = fakeDatabase({ cursor: 'cursor-stuck' });
  const { sync } = syncHarness(database, async () => ({
    entries: [],
    cursor: 'cursor-stuck',
    has_more: true,
  }));
  await assert.rejects(sync({ DROPBOX_ROOT: ROOT }), /dropbox_invalid_cursor/);
  assert.equal(state.cursor, 'cursor-stuck');
  assert.deepEqual(state.finishes, ['dropbox_invalid_cursor']);

  const oversizedPage = syncHarness(database, async () => ({
    entries: Array.from({ length: 251 }, () => ({ '.tag': 'folder' })),
    cursor: 'cursor-next',
    has_more: false,
  })).sync;
  await assert.rejects(oversizedPage({ DROPBOX_ROOT: ROOT }), /dropbox_invalid_entry/);
});

async function webhookSignature(raw, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const value = await crypto.subtle.sign('HMAC', key, encoder.encode(raw));
  return [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function callWebhook(queue) {
  const raw = JSON.stringify({ list_folder: { accounts: ['dbid:test'] } });
  const secret = 'dropbox-webhook-test-secret';
  const signature = await webhookSignature(raw, secret);
  const request = new Request('https://northlight.example/webhooks/dropbox', {
    method: 'POST',
    headers: { 'x-dropbox-signature': signature, 'content-type': 'application/json' },
    body: raw,
  });
  return dropboxWebhook({
    request,
    env: {
      DROPBOX_APP_SECRET: secret,
      TASK_HANDOFF_QUEUE: queue,
      SUPABASE_URL: 'https://database.example',
      SUPABASE_PUBLISHABLE_KEY: 'public-test-key',
      NORTHLIGHT_DEMO_KEY: 'demo-test-key',
    },
  });
}

test('webhook acknowledges only after durable queue acceptance and returns retriable 503 on rejection', async () => {
  const originalFetch = globalThis.fetch;
  const databaseCalls = [];
  globalThis.fetch = async url => {
    databaseCalls.push(String(url));
    if (String(url).includes('/rest/v1/tenants')) return Response.json([{ id: TENANT_ID }]);
    if (String(url).includes('/rest/v1/integration_state')) {
      return Response.json([{ status: 'connected', metadata: { account_id: 'dbid:test' } }]);
    }
    if (String(url).includes('/rest/v1/external_sync_events')) return new Response(null, { status: 201 });
    throw new Error(`unexpected_fetch:${url}`);
  };
  try {
    const jobs = [];
    const accepted = await callWebhook({
      async send(job, options) { jobs.push({ job, options }); },
    });
    assert.equal(accepted.status, 200);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].job.version, 1);
    assert.equal(jobs[0].job.type, 'dropbox_sync');
    assert.match(jobs[0].job.jobId, /^[0-9a-f-]{36}$/);
    assert.equal(jobs[0].options.contentType, 'json');

    const rejected = await callWebhook({ async send() { throw new Error('queue unavailable with secret'); } });
    assert.equal(rejected.status, 503);
    assert.equal(rejected.headers.get('retry-after'), '60');
    assert.equal(await rejected.text(), 'sync queue unavailable');
    assert.ok(databaseCalls.some(url => url.includes('/rest/v1/external_sync_events')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('database migration fences cursor races and applies bounded file/event batches transactionally', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260821142400_northlight_dropbox_sync_leases.sql', import.meta.url), 'utf8');
  assert.match(sql, /create or replace function public\.northlight_claim_dropbox_sync/);
  assert.match(sql, /pg_catalog\.length\(p_root_path\) not between 2 and 2000/);
  assert.match(sql, /v_state\.account_id is distinct from v_account_id\s+or \(\s+v_state\.cursor is null/s);
  assert.match(sql, /'reset_cleanup_required', true/);
  assert.match(sql, /sync_lease_until <= pg_catalog\.now\(\)/);
  assert.match(sql, /connection_generation is distinct from v_integration\.refresh_generation/);
  assert.match(sql, /v_state\.cursor is distinct from p_expected_cursor/);
  assert.match(sql, /raise exception 'dropbox_cursor_changed'/);
  assert.match(sql, /create or replace function public\.northlight_apply_dropbox_sync_batch/);
  assert.match(sql, /jsonb_array_length\(p_entries\) not between 1 and 200/);
  assert.match(sql, /v_page_order not between 0 and 999/);
  assert.match(sql, /dropbox_prefix_delete_must_be_single/);
  assert.match(sql, /limit 201\s+for update/);
  assert.match(sql, /'dropbox_sync_page_id', v_page_id::text/);
  assert.match(sql, /v_existing_page_order > v_page_order/);
  assert.match(sql, /'prefix_has_more', v_prefix_has_more/);
  assert.match(sql, /if v_is_deleted then\s+if v_target\.id is null then\s+continue;/s);
  assert.match(sql, /v_revision := coalesce\(v_revision, v_target\.revision\)/);
  assert.match(sql, /on conflict \(id\) do update/);
  assert.match(sql, /grant execute on function public\.northlight_apply_dropbox_sync_batch\(uuid, uuid, bigint, jsonb\)\s+to anon/);
});

test('queue helper fails closed when the durable binding is missing', async () => {
  await assert.rejects(enqueueDropboxSync({}), /dropbox_sync_queue_unavailable/);
});
