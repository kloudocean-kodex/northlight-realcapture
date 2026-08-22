import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  batchEntries,
  listDropboxFiles,
  pollDropboxBatch,
  publishReviewRelease,
  verifyTemporaryLinkMetadata,
} from '../functions/_lib/review-release.js';
import {
  canSeeIndexedFile,
  canSeeReleaseFile,
} from '../functions/api/files/link.js';
import { normalizeDropboxEntry } from '../functions/_lib/dropbox-sync.js';

const releaseId = '11111111-2222-4333-8444-555555555555';
const base = '/Northlight/NL-9000 - Release Test';
const task = { id: 'task-1', dropbox_path: base, service_codes: ['photos', 'drone'] };
const edited = [
  {
    path: `${base}/02_EDITED/PHOTOS/interiors/front.jpg`,
    name: 'front.jpg',
    service_code: 'photos',
    provider_file_id: 'id:source-front',
    revision: 'source-front-r1',
    content_hash: 'a'.repeat(64),
    size_bytes: 101,
  },
  {
    path: `${base}/02_EDITED/DRONE/aerial.jpg`,
    name: 'aerial.jpg',
    service_code: 'drone',
    provider_file_id: 'id:source-aerial',
    revision: 'source-aerial-r1',
    content_hash: 'b'.repeat(64),
    size_bytes: 202,
  },
];

function sourceMetadata(file) {
  return {
    '.tag': 'file',
    id: file.provider_file_id,
    rev: file.revision,
    content_hash: file.content_hash,
    size: file.size_bytes,
    path_display: file.path,
    name: file.name,
  };
}

function dropboxMock({ batch = 'sync' } = {}) {
  const folders = new Set([base.toLowerCase(), `${base}/02_EDITED`.toLowerCase()]);
  const byPath = new Map();
  const byId = new Map();
  let copyCalls = 0;
  let checkCalls = 0;

  const put = metadata => {
    byPath.set(metadata.path_display.toLowerCase(), metadata);
    if (metadata.id) byId.set(metadata.id, metadata);
    return metadata;
  };
  for (const file of edited) put(sourceMetadata(file));

  const copy = entry => {
    const source = byId.get(entry.from_path);
    const metadata = put({
      '.tag': 'file',
      id: `id:release-${copyCalls}-${source.name}`,
      rev: `release-${copyCalls}-${source.name}-r1`,
      content_hash: source.content_hash,
      size: source.size,
      path_display: entry.to_path,
      name: source.name,
    });
    return { '.tag': 'success', success: { metadata } };
  };

  const request = async (endpoint, payload) => {
    if (endpoint === 'files/create_folder_v2') {
      if (folders.has(payload.path.toLowerCase())) {
        throw new Error('dropbox_409:{"error_summary":"path/conflict/folder"}');
      }
      const parent = String(payload.path).slice(0, String(payload.path).lastIndexOf('/')).toLowerCase();
      if (parent && !folders.has(parent)) {
        throw new Error('dropbox_409:{"error":{".tag":"path","path":{".tag":"not_found"}}}');
      }
      folders.add(payload.path.toLowerCase());
      return { metadata: { '.tag': 'folder', path_display: payload.path } };
    }
    if (endpoint === 'files/list_folder') {
      const prefix = `${String(payload.path).toLowerCase().replace(/\/$/, '')}/`;
      return {
        entries: [...byPath.values()].filter(metadata =>
          String(metadata.path_display || '').toLowerCase().startsWith(prefix),
        ),
        cursor: `cursor:${payload.path}`,
        has_more: false,
      };
    }
    if (endpoint === 'files/get_metadata') {
      const value = String(payload.path);
      const metadata = byId.get(value) || byPath.get(value.toLowerCase());
      if (metadata) return metadata;
      if (folders.has(value.toLowerCase())) return { '.tag': 'folder', path_display: value };
      throw new Error('dropbox_409:{"error":{".tag":"path","path":{".tag":"not_found"}}}');
    }
    if (endpoint === 'files/copy_batch_v2') {
      copyCalls += 1;
      if (typeof batch === 'function') return batch({ payload, copy, state });
      if (batch === 'partial') {
        const first = copy(payload.entries[0]);
        return { '.tag': 'complete', complete: { entries: [first, { '.tag': 'failure' }] } };
      }
      if (batch === 'async') return { '.tag': 'async_job_id', async_job_id: 'job-1' };
      return { '.tag': 'complete', complete: { entries: payload.entries.map(copy) } };
    }
    if (endpoint === 'files/copy_batch/check_v2') {
      checkCalls += 1;
      if (checkCalls === 1) return { '.tag': 'in_progress' };
      const entries = state.pendingEntries || [];
      return { '.tag': 'complete', complete: { entries: entries.map(copy) } };
    }
    throw new Error(`unexpected_endpoint:${endpoint}`);
  };

  const state = {
    folders,
    byPath,
    byId,
    get copyCalls() { return copyCalls; },
    get checkCalls() { return checkCalls; },
    pendingEntries: null,
    put,
  };
  return { request, state };
}

test('Dropbox V2 batch parsing supports synchronous nested results and polls through in_progress', async () => {
  assert.equal(batchEntries({ '.tag': 'complete', complete: { entries: [{ '.tag': 'success' }] } }).length, 1);
  let checks = 0;
  const result = await pollDropboxBatch(async endpoint => {
    assert.equal(endpoint, 'files/copy_batch/check_v2');
    checks += 1;
    return checks === 1
      ? { '.tag': 'in_progress' }
      : { '.tag': 'complete', complete: { entries: [{ '.tag': 'success' }] } };
  }, { '.tag': 'async_job_id', async_job_id: 'job-1' }, { sleep: async () => {} });
  assert.equal(checks, 2);
  assert.equal(batchEntries(result).length, 1);
});

test('provider verification consumes every Dropbox listing page without per-file provider calls', async () => {
  const calls = [];
  const rows = await listDropboxFiles(async (endpoint, payload) => {
    calls.push([endpoint, payload]);
    if (endpoint === 'files/list_folder') {
      return { entries: [{ '.tag': 'file', id: 'id:1' }, { '.tag': 'folder', id: 'folder:1' }], cursor: 'next-1', has_more: true };
    }
    assert.equal(endpoint, 'files/list_folder/continue');
    assert.equal(payload.cursor, 'next-1');
    return { entries: [{ '.tag': 'file', id: 'id:2' }], cursor: 'done', has_more: false };
  }, '/Northlight/edited');
  assert.deepEqual(rows.map(row => row.id), ['id:1', 'id:2']);
  assert.equal(calls.length, 2);
});

test('partial provider copy never invokes the atomic selector or replaces the prior approved release', async () => {
  const { request } = dropboxMock({ batch: 'partial' });
  const database = { approvedReleaseId: 'prior-approved-release', commits: 0 };
  await assert.rejects(async () => {
    const publication = await publishReviewRelease({}, task, edited, releaseId, { request, sleep: async () => {} });
    database.commits += 1;
    database.approvedReleaseId = publication.releaseId;
  }, /review_publish_copy_failed/);
  assert.equal(database.commits, 0);
  assert.equal(database.approvedReleaseId, 'prior-approved-release');
});

test('retry after an ambiguous accepted copy reuses the same verified release without a duplicate copy', async () => {
  let first = true;
  const { request, state } = dropboxMock({
    batch: ({ payload, copy }) => {
      const entries = payload.entries.map(copy);
      if (first) {
        first = false;
        throw new Error('dropbox_timeout_after_provider_acceptance');
      }
      return { '.tag': 'complete', complete: { entries } };
    },
  });

  await assert.rejects(
    publishReviewRelease({}, task, edited, releaseId, { request, sleep: async () => {} }),
    /dropbox_timeout_after_provider_acceptance/,
  );
  assert.equal(state.copyCalls, 1);

  const retry = await publishReviewRelease({}, task, edited, releaseId, { request, sleep: async () => {} });
  assert.equal(state.copyCalls, 1);
  assert.equal(retry.copiedCount, 0);
  assert.equal(retry.reusedCount, edited.length);
  assert.equal(retry.manifest.length, edited.length);
  for (const file of retry.manifest) {
    assert.ok(file.provider_file_id);
    assert.ok(file.provider_revision);
    assert.ok(file.content_hash);
    assert.ok(Number.isSafeInteger(file.size_bytes));
  }
});

test('extra unselected edited source files do not block the selected approved manifest', async () => {
  const { request, state } = dropboxMock();
  state.put({
    '.tag': 'file',
    id: 'id:stale-edited-export',
    rev: 'stale-r1',
    content_hash: 'c'.repeat(64),
    size: 303,
    path_display: `${base}/02_EDITED/PHOTOS/old-export.jpg`,
    name: 'old-export.jpg',
  });

  const publication = await publishReviewRelease({}, task, edited, releaseId, {
    request,
    sleep: async () => {},
  });

  assert.equal(publication.manifest.length, edited.length);
  assert.equal(publication.copiedCount, edited.length);
  assert.equal(publication.manifest.some(file => file.name === 'old-export.jpg'), false);
});

test('an existing destination with the wrong hash is rejected and cannot become the manifest', async () => {
  const { request, state } = dropboxMock();
  state.put({
    '.tag': 'file',
    id: 'id:tampered',
    rev: 'tampered-r1',
    content_hash: 'f'.repeat(64),
    size: edited[0].size_bytes,
    path_display: `${base}/releases/${releaseId}/PHOTOS/interiors/front.jpg`,
    name: 'front.jpg',
  });
  await assert.rejects(
    publishReviewRelease({}, task, edited, releaseId, { request, sleep: async () => {} }),
    /review_publish_manifest_mismatch/,
  );
  assert.equal(state.copyCalls, 0);
});

test('asynchronous batch completion verifies every provider result and final metadata', async () => {
  const { request, state } = dropboxMock({ batch: 'async' });
  state.pendingEntries = edited.map(file => ({
    from_path: file.provider_file_id,
    to_path: file.path.replace('/02_EDITED/', `/releases/${releaseId}/`),
  }));
  const publication = await publishReviewRelease({}, task, edited, releaseId, {
    request,
    sleep: async () => {},
  });
  assert.equal(state.checkCalls, 2);
  assert.equal(publication.manifest.length, 2);
});

test('temporary links fail closed when Dropbox revision identity diverges from the approved manifest', () => {
  const releaseFile = {
    provider_file_id: 'id:approved',
    provider_revision: 'approved-r1',
    content_hash: 'a'.repeat(64),
    size_bytes: 101,
    path: '/Northlight/releases/approved/front.jpg',
  };
  assert.throws(() => verifyTemporaryLinkMetadata(releaseFile, {
    '.tag': 'file',
    id: 'id:approved',
    rev: 'approved-r2',
    content_hash: 'a'.repeat(64),
    size: 101,
    path_display: '/Northlight/releases/approved/front.jpg',
  }), /approved_release_diverged/);
  assert.throws(() => verifyTemporaryLinkMetadata(releaseFile, {
    '.tag': 'file',
    id: 'id:approved',
    rev: 'approved-r1',
    content_hash: 'a'.repeat(64),
    size: 101,
    path_display: '/Northlight/somewhere-else/front.jpg',
  }), /approved_release_diverged/);
});

test('Agent authorization rejects every mutable final and only accepts the task-selected approved release', () => {
  const selected = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const userTask = {
    id: 'task-1',
    agent_user_id: 'agent-1',
    photographer_user_id: 'photo-1',
    editor_user_id: 'editor-1',
    approved_release_id: selected,
    archived_at: null,
    deleted_at: null,
  };
  const agent = { role: 'agent', userId: 'agent-1' };
  assert.equal(canSeeIndexedFile(userTask, agent, '03_FINAL'), false);
  assert.equal(canSeeIndexedFile(userTask, agent, '04_REFERENCE'), true);
  assert.equal(canSeeReleaseFile(userTask, agent, selected), true);
  assert.equal(canSeeReleaseFile(userTask, agent, 'prior-or-unapproved-release'), false);
  assert.equal(canSeeReleaseFile(userTask, { role: 'agent', userId: 'another-agent' }, selected), false);
});

test('SQL selector records the manifest before the one atomic approved_release_id switch and never deletes a release', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260819200000_northlight_immutable_review_releases.sql', import.meta.url), 'utf8');
  const status = await readFile(new URL('../functions/api/tasks/[id]/status.js', import.meta.url), 'utf8');
  const link = await readFile(new URL('../functions/api/files/link.js', import.meta.url), 'utf8');
  const insertFiles = sql.indexOf('insert into public.media_release_files');
  const approveRelease = sql.indexOf("set status = 'approved', approved_at = now()");
  const selectRelease = sql.indexOf('approved_release_id = p_release_id');
  assert.ok(insertFiles >= 0 && insertFiles < approveRelease && approveRelease < selectRelease);
  assert.doesNotMatch(sql, /delete\s+from\s+public\.media_releases/i);
  assert.match(sql, /previous_release_id/);
  assert.match(sql, /approved_release_immutable/);
  assert.match(sql, /'reused', true/);
  assert.match(status, /idempotent:true/);
  assert.match(link, /const releasePath = releaseFile\.path \|\| releaseFile\.provider_file_id/);
  assert.match(link, /files\/get_temporary_link'[\s\S]*path: releasePath/);
  assert.match(link, /files\/get_metadata'[\s\S]*include_deleted: false/);
  assert.equal(normalizeDropboxEntry({
    '.tag': 'file',
    id: 'id:release-must-not-enter-mutable-index',
    path_display: `${base}/releases/${releaseId}/PHOTOS/front.jpg`,
    name: 'front.jpg',
  }), null);
  assert.equal(normalizeDropboxEntry({
    '.tag': 'file',
    id: 'id:mutable-final',
    path_display: `${base}/03_FINAL/PHOTOS/front.jpg`,
    name: 'front.jpg',
  })?.stage, '03_FINAL');
});
