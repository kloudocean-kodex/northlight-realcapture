import { supa, tenant, accessToken, integration } from './core.js';
import { readBoundedText, RequestBodyTooLargeError } from './http-body.js';

export const DROPBOX_PAGE_SIZE = 200;
export const DROPBOX_BATCH_SIZE = 200;
export const DROPBOX_MAX_PROVIDER_CALLS = 4;
export const DROPBOX_RUNTIME_BUDGET_MS = 20_000;
export const DROPBOX_MAX_PAGE_ENTRIES = 250;

const DROPBOX_LEASE_SECONDS = 120;
const MAX_DROPBOX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_DROPBOX_BATCH_BYTES = 900 * 1024;
const STAGES = new Set(['01_RAW', '02_EDITED', '03_FINAL', '04_REFERENCE']);
const SAFE_DROPBOX_CODES = new Set([
  'reset',
  'path',
  'path/not_found',
  'not_found',
  'conflict',
  'too_many_requests',
  'rate_limit',
  'expired_access_token',
  'invalid_access_token',
  'insufficient_space',
  'internal_error',
  'invalid_arg',
  'unsupported_content_type',
]);
const SAFE_SYNC_ERRORS = [
  'dropbox_not_connected',
  'dropbox_connection_changed',
  'dropbox_account_identity_missing',
  'dropbox_account_identity_changed',
  'dropbox_sync_claim_lost',
  'dropbox_sync_claim_ambiguous',
  'dropbox_cursor_changed',
  'dropbox_service_not_in_task',
  'dropbox_path_conflict',
  'dropbox_event_id_conflict',
  'dropbox_prefix_delete_must_be_single',
  'dropbox_sync_state_missing',
  'invalid_dropbox_sync_entry',
  'invalid_dropbox_sync_batch',
  'invalid_dropbox_sync_claim',
  'invalid_dropbox_sync_advance',
  'invalid_dropbox_sync_finish',
  'dropbox_sync_queue_unavailable',
  'dropbox_invalid_cursor',
  'dropbox_invalid_entry',
  'dropbox_page_changed',
];

const rootPath = env => String(env.DROPBOX_ROOT || '/Northlight').replace(/\/+$/, '') || '/';
const asObject = value => Array.isArray(value) ? value[0] : value;
const nowIso = clock => new Date(clock()).toISOString();

export class DropboxProviderError extends Error {
  constructor(status, code = 'provider_error') {
    super(`dropbox_${Number(status) || 0}:${code}`);
    this.name = 'DropboxProviderError';
    this.status = Number(status) || 0;
    this.providerCode = code;
  }
}

export function safeDropboxErrorCode(value) {
  const summary = String(value?.error_summary || '');
  const tag = String(value?.error?.['.tag'] || value?.['.tag'] || '');
  const candidate = summary.split(':')[0].split('/').slice(0, 2).join('/') || tag;
  if (SAFE_DROPBOX_CODES.has(candidate)) return candidate;
  const first = candidate.split('/')[0];
  return SAFE_DROPBOX_CODES.has(first) ? first : 'provider_error';
}

export async function dropboxProviderRequest(
  token,
  endpoint,
  payload = {},
  request = fetch,
  { timeoutMs = DROPBOX_RUNTIME_BUDGET_MS } = {},
) {
  const requestTimeoutMs = Math.min(
    DROPBOX_RUNTIME_BUDGET_MS,
    Math.max(1, Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : DROPBOX_RUNTIME_BUDGET_MS),
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('dropbox_request_timeout'), requestTimeoutMs);
  let response;
  let text = '';
  try {
    response = await request(`https://api.dropboxapi.com/2/${endpoint}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    text = await readBoundedText(response, MAX_DROPBOX_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw new DropboxProviderError(response.status, 'response_too_large');
    }
    if (controller.signal.aborted) throw new DropboxProviderError(0, 'request_timeout');
    if (error instanceof DropboxProviderError) throw error;
    throw new DropboxProviderError(0, 'network_error');
  } finally {
    clearTimeout(timeout);
  }
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new DropboxProviderError(response.ok ? 502 : response.status, 'invalid_response');
  }
  if (!response.ok) throw new DropboxProviderError(response.status, safeDropboxErrorCode(data));
  return data;
}

export async function enqueueDropboxSync(env, { webhookAt = null } = {}) {
  if (!env.TASK_HANDOFF_QUEUE || typeof env.TASK_HANDOFF_QUEUE.send !== 'function') {
    throw new Error('dropbox_sync_queue_unavailable');
  }
  const job = {
    version: 1,
    type: 'dropbox_sync',
    jobId: crypto.randomUUID(),
    webhookAt: webhookAt || null,
  };
  await env.TASK_HANDOFF_QUEUE.send(job, { contentType: 'json' });
  return job;
}

function safeSyncError(error) {
  if (error instanceof DropboxProviderError) return error.message.slice(0, 160);
  const message = String(error?.message || '');
  return SAFE_SYNC_ERRORS.find(code => message.includes(code)) || 'dropbox_sync_failed';
}

function validWebhookTimestamp(value, clock) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  const now = clock();
  if (!Number.isFinite(timestamp) || timestamp < now - 23 * 60 * 60 * 1000 || timestamp > now + 5 * 60 * 1000) {
    return null;
  }
  return new Date(timestamp).toISOString();
}

function relativeDropboxParts(path, root) {
  const normalizedRoot = root.replace(/\/+$/, '') || '/';
  if (path.toLowerCase() === normalizedRoot.toLowerCase()) return [];
  const prefix = normalizedRoot === '/' ? '/' : `${normalizedRoot}/`;
  if (!path.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  return path.slice(prefix.length).split('/').filter(Boolean);
}

export function normalizeDropboxEntry(entry, root = '/Northlight') {
  const path = String(entry?.path_display || entry?.path_lower || '');
  if (!path || path.length > 2000 || /[\r\n]/.test(path)) return null;
  const parts = relativeDropboxParts(path, root);
  if (!parts) return null;
  const isDeleted = entry?.['.tag'] === 'deleted';
  if (!isDeleted && entry?.['.tag'] !== 'file') return null;
  const taskMatch = parts[0]?.match(/^(NL-\d+(?:-[A-Z0-9]{4})?)(?:\s+-\s+|$)/i) || null;
  const stage = parts[1] ? String(parts[1]).toUpperCase() : null;

  // DeletedMetadata does not identify whether the former item was a file or a
  // folder. Dropbox therefore requires recursive caches to invalidate both the
  // exact path and every descendant. The fenced RPC applies this in <=200-row
  // chunks without inventing tombstones for unknown paths.
  if (isDeleted) {
    if (parts.length && !taskMatch) return null;
    if (stage && !STAGES.has(stage)) return null;
    const serviceCode = stage && stage !== '04_REFERENCE' && parts[2]
      ? String(parts[2]).toLowerCase()
      : null;
    if (serviceCode && (!/^[a-z0-9_-]+$/.test(serviceCode) || serviceCode.length > 80)) return null;
    const name = String(entry?.name || parts.at(-1) || root.split('/').filter(Boolean).at(-1) || 'Dropbox root').trim();
    if (name.length > 512) throw new Error('dropbox_invalid_entry');
    return {
      task_no: taskMatch?.[1]?.toUpperCase() || null,
      provider_file_id: null,
      path,
      name: name || null,
      file_type: null,
      stage,
      service_code: serviceCode,
      size_bytes: null,
      content_hash: null,
      revision: null,
      is_deleted: true,
      is_prefix_delete: true,
      modified_at: null,
      client_modified_at: null,
    };
  }

  if (parts.length < 2 || !taskMatch || !STAGES.has(stage)) return null;
  if (stage !== '04_REFERENCE' && parts.length < 4) return null;
  if (stage === '04_REFERENCE' && parts.length < 3) return null;

  const name = String(entry?.name || parts.at(-1) || '').trim();
  const providerFileId = String(entry?.id || '').trim();
  const revision = String(entry?.rev || '').trim();
  const contentHash = String(entry?.content_hash || '').trim().toLowerCase();
  const serviceCode = stage === '04_REFERENCE' ? null : String(parts[2] || '').toLowerCase();
  if (!name || name.length > 512 || (!isDeleted && (!providerFileId || providerFileId.length > 512))) {
    throw new Error('dropbox_invalid_entry');
  }
  if (serviceCode && (!/^[a-z0-9_-]+$/.test(serviceCode) || serviceCode.length > 80)) {
    throw new Error('dropbox_invalid_entry');
  }
  if (contentHash && !/^[0-9a-f]{64}$/.test(contentHash)) throw new Error('dropbox_invalid_entry');
  if (revision.length > 512) throw new Error('dropbox_invalid_entry');
  const size = entry?.size === undefined || entry?.size === null ? null : Number(entry.size);
  if (size !== null && (!Number.isSafeInteger(size) || size < 0)) throw new Error('dropbox_invalid_entry');
  const modifiedAt = entry?.server_modified ? new Date(entry.server_modified) : null;
  const clientModifiedAt = entry?.client_modified ? new Date(entry.client_modified) : null;
  if (modifiedAt && !Number.isFinite(modifiedAt.getTime())) throw new Error('dropbox_invalid_entry');
  if (clientModifiedAt && !Number.isFinite(clientModifiedAt.getTime())) throw new Error('dropbox_invalid_entry');

  return {
    task_no: taskMatch[1].toUpperCase(),
    provider_file_id: providerFileId,
    path,
    name,
    file_type: 'file',
    stage,
    service_code: serviceCode,
    size_bytes: size,
    content_hash: contentHash || null,
    revision: revision || null,
    is_deleted: false,
    is_prefix_delete: false,
    modified_at: modifiedAt?.toISOString() || null,
    client_modified_at: clientModifiedAt?.toISOString() || null,
  };
}

async function deterministicUuid(identity) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity)),
  ).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function deterministicDropboxPageId(tenantId, pageIdentity) {
  return deterministicUuid(JSON.stringify([
    'northlight-dropbox-page-v1',
    tenantId,
    pageIdentity || 'root-missing',
  ]));
}

export async function deterministicDropboxEventId(tenantId, providerCursor, entry) {
  return deterministicUuid(JSON.stringify([
    'northlight-dropbox-event-v1',
    tenantId,
    providerCursor || 'root-missing',
    entry.task_no,
    entry.provider_file_id || '',
    entry.path.toLowerCase(),
    entry.is_deleted,
    entry.revision || '',
    entry.content_hash || '',
  ]));
}

export async function normalizeDropboxEntries(entries, {
  tenantId,
  providerCursor,
  pageId = null,
  root = '/Northlight',
}) {
  const normalized = [];
  const resolvedPageId = pageId || await deterministicDropboxPageId(tenantId, providerCursor);
  for (let pageOrder = 0; pageOrder < (entries || []).length; pageOrder += 1) {
    const value = entries[pageOrder];
    const entry = normalizeDropboxEntry(value, root);
    if (!entry) continue;
    normalized.push({
      event_id: await deterministicDropboxEventId(tenantId, providerCursor, entry),
      page_id: resolvedPageId,
      page_order: pageOrder,
      ...entry,
    });
  }
  return normalized;
}

export function batchDropboxEntries(entries, { maxEntries = DROPBOX_BATCH_SIZE, maxBytes = MAX_DROPBOX_BATCH_BYTES } = {}) {
  const batches = [];
  let current = [];
  let bytes = 2;
  for (const entry of entries || []) {
    const entryBytes = new TextEncoder().encode(JSON.stringify(entry)).byteLength + (current.length ? 1 : 0);
    if (entryBytes + 2 > maxBytes) throw new Error('dropbox_invalid_entry');
    if (entry?.is_prefix_delete) {
      if (current.length) batches.push(current);
      batches.push([entry]);
      current = [];
      bytes = 2;
      continue;
    }
    if (current.length && (current.length >= maxEntries || bytes + entryBytes > maxBytes)) {
      batches.push(current);
      current = [];
      bytes = 2;
    }
    current.push(entry);
    bytes += entryBytes;
  }
  if (current.length) batches.push(current);
  return batches;
}

async function writeSync(database, env, currentTenant, eventType, { status = 'processed', error = null, payload = {} } = {}) {
  return database(env, 'external_sync_events', {
    method: 'POST',
    payload: {
      tenant_id: currentTenant.id,
      provider: 'dropbox',
      direction: 'inbound',
      entity_type: 'files',
      entity_id: null,
      event_type: eventType,
      status,
      payload,
      error,
    },
    prefer: 'return=minimal',
  });
}

function metadataForAdvance(state, response, pageEntries, metadataPatch = {}) {
  return {
    ...(state?.metadata || {}),
    has_more: Boolean(response?.has_more),
    root_missing: Boolean(response?.root_missing),
    page_limit: DROPBOX_PAGE_SIZE,
    last_page_entries: Number(pageEntries || 0),
    ...metadataPatch,
  };
}

async function rpc(database, env, name, payload) {
  return asObject(await database(env, `rpc/${name}`, { method: 'POST', payload }));
}

export function createDropboxSync({
  database = supa,
  getTenant = tenant,
  getToken = accessToken,
  providerRequest = dropboxProviderRequest,
  enqueue = enqueueDropboxSync,
  clock = () => Date.now(),
  ownerId = () => crypto.randomUUID(),
} = {}) {
  const runClaimedDropboxSync = async (env, options = {}) => {
    const webhookAt = validWebhookTimestamp(options.webhookAt || (options.fromWebhook ? nowIso(clock) : null), clock);
    const forceFull = Boolean(options.forceFull);
    const requestedProviderCalls = Number(options.maxProviderCalls ?? DROPBOX_MAX_PROVIDER_CALLS);
    const maxProviderCalls = Math.min(
      DROPBOX_MAX_PROVIDER_CALLS,
      Math.max(1, Number.isFinite(requestedProviderCalls) ? Math.trunc(requestedProviderCalls) : DROPBOX_MAX_PROVIDER_CALLS),
    );
    const requestedRuntimeMs = Number(options.runtimeBudgetMs ?? DROPBOX_RUNTIME_BUDGET_MS);
    const runtimeBudgetMs = Math.min(
      DROPBOX_RUNTIME_BUDGET_MS,
      Math.max(1_000, Number.isFinite(requestedRuntimeMs) ? Math.trunc(requestedRuntimeMs) : DROPBOX_RUNTIME_BUDGET_MS),
    );
    const startedAt = clock();
    const currentTenant = await getTenant(env);

    // Complete any token refresh before fencing the connection generation.
    await getToken(env, 'dropbox');
    const owner = ownerId();
    let state = await rpc(database, env, 'northlight_claim_dropbox_sync', {
      p_tenant_id: currentTenant.id,
      p_root_path: rootPath(env),
      p_owner: owner,
      p_lease_seconds: DROPBOX_LEASE_SECONDS,
    });
    if (!state?.claimed) return { status: 'busy', busy: true, retryAfterSeconds: 60 };
    const generation = Number(state.generation);

    try {
      // Re-read after claim so reconnect during the first token read cannot make
      // old credentials authoritative. Every database batch is generation-fenced.
      const token = await getToken(env, 'dropbox');
      let cursor = state.cursor || null;
      let full = forceFull || !cursor || Number(state?.metadata?.page_limit) !== DROPBOX_PAGE_SIZE;
      let providerCalls = 0;
      let processedPages = 0;
      let total = 0;
      let matched = 0;
      let changed = 0;
      let rootMissing = false;
      // A claimed cursor always requires at least one provider read. If the
      // runtime budget is already spent, preserve that work as a continuation.
      let hasMore = true;

      const advance = async (expectedCursor, nextCursor, response, pageEntries = 0, metadataPatch = {}) => {
        const at = nowIso(clock);
        state = await rpc(database, env, 'northlight_advance_dropbox_sync', {
          p_tenant_id: currentTenant.id,
          p_root_path: rootPath(env),
          p_owner: owner,
          p_generation: generation,
          p_expected_cursor: expectedCursor,
          p_cursor: nextCursor,
          p_last_sync_at: at,
          p_last_webhook_at: webhookAt,
          p_metadata: metadataForAdvance(state, response, pageEntries, metadataPatch),
          p_lease_seconds: DROPBOX_LEASE_SECONDS,
        });
        cursor = state?.cursor || null;
      };

      let resetCleanupRequired = Boolean(state?.metadata?.reset_cleanup_required);
      let resetCleanupSeed = String(state?.metadata?.reset_cleanup_seed || '');
      const beginFullReset = async expectedCursor => {
        resetCleanupSeed = crypto.randomUUID();
        await advance(expectedCursor, null, { has_more: true, root_missing: false }, 0, {
          reset_cleanup_required: true,
          reset_cleanup_seed: resetCleanupSeed,
          pending_prefix_page_id: null,
        });
        cursor = null;
        resetCleanupRequired = true;
        full = true;
      };

      if (full && cursor) {
        await beginFullReset(cursor);
      } else if (!resetCleanupRequired && (
        forceFull || Number(state?.metadata?.page_limit) !== DROPBOX_PAGE_SIZE
      )) {
        await beginFullReset(null);
      }

      if (resetCleanupRequired) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resetCleanupSeed)) {
          resetCleanupSeed = crypto.randomUUID();
          await advance(null, null, { has_more: true, root_missing: false }, 0, {
            reset_cleanup_required: true,
            reset_cleanup_seed: resetCleanupSeed,
          });
        }
        const cleanupEntry = normalizeDropboxEntry({
          '.tag': 'deleted',
          path_display: rootPath(env),
          name: rootPath(env).split('/').filter(Boolean).at(-1) || 'Dropbox root',
        }, rootPath(env));
        const cleanup = await rpc(database, env, 'northlight_apply_dropbox_sync_batch', {
          p_tenant_id: currentTenant.id,
          p_owner: owner,
          p_generation: generation,
          p_entries: [{
            event_id: resetCleanupSeed,
            page_id: resetCleanupSeed,
            page_order: 0,
            ...cleanupEntry,
          }],
        });
        matched += Number(cleanup?.matched || 0);
        changed += Number(cleanup?.changed || 0);
        resetCleanupRequired = Boolean(cleanup?.prefix_has_more);
        if (!resetCleanupRequired) {
          await advance(null, null, { has_more: true, root_missing: false }, 0, {
            reset_cleanup_required: false,
            reset_cleanup_seed: resetCleanupSeed,
          });
        }
      }

      while (!resetCleanupRequired && providerCalls < maxProviderCalls && clock() - startedAt < runtimeBudgetMs) {
        const expectedCursor = cursor;
        let page;
        let pageRootMissing = false;
        try {
          providerCalls += 1;
          const remainingMs = Math.max(1, runtimeBudgetMs - (clock() - startedAt));
          page = full
            ? await providerRequest(token, 'files/list_folder', {
                path: rootPath(env),
                recursive: true,
                include_deleted: true,
                limit: DROPBOX_PAGE_SIZE,
              }, undefined, { timeoutMs: remainingMs })
            : await providerRequest(
                token,
                'files/list_folder/continue',
                { cursor: expectedCursor },
                undefined,
                { timeoutMs: remainingMs },
              );
        } catch (error) {
          if (error instanceof DropboxProviderError && error.providerCode === 'path/not_found' && full) {
            pageRootMissing = true;
            page = {
              entries: [{
                '.tag': 'deleted',
                path_display: rootPath(env),
                name: rootPath(env).split('/').filter(Boolean).at(-1) || 'Dropbox root',
              }],
              cursor: null,
              has_more: false,
            };
          } else if (error instanceof DropboxProviderError && ['reset', 'path/not_found'].includes(error.providerCode)) {
            await beginFullReset(expectedCursor);
            hasMore = true;
            break;
          } else {
            throw error;
          }
        }

        if (!Array.isArray(page?.entries) || page.entries.length > DROPBOX_MAX_PAGE_ENTRIES) {
          throw new Error('dropbox_invalid_entry');
        }
        if (typeof page?.has_more !== 'boolean') throw new Error('dropbox_invalid_cursor');
        if (!pageRootMissing && (typeof page?.cursor !== 'string' || !page.cursor)) {
          throw new Error('dropbox_invalid_cursor');
        }
        if (page?.cursor && page.cursor.length > 16_384) throw new Error('dropbox_invalid_cursor');
        if (page?.has_more && !page?.cursor) throw new Error('dropbox_invalid_cursor');
        if (page?.has_more && expectedCursor && page.cursor === expectedCursor) {
          throw new Error('dropbox_invalid_cursor');
        }
        const pageEntries = page.entries;
        const pageIdentity = page?.cursor
          || expectedCursor
          || (pageRootMissing ? `root-missing:${resetCleanupSeed || 'initial'}` : 'initial-full-page');
        const pageId = await deterministicDropboxPageId(currentTenant.id, pageIdentity);
        const pendingPageId = String(state?.metadata?.pending_prefix_page_id || '');
        if (pendingPageId && pendingPageId !== pageId) throw new Error('dropbox_page_changed');
        const normalized = await normalizeDropboxEntries(pageEntries, {
          tenantId: currentTenant.id,
          providerCursor: pageIdentity,
          pageId,
          root: rootPath(env),
        });
        let prefixHasMore = false;
        for (const entries of batchDropboxEntries(normalized)) {
          const outcome = await rpc(database, env, 'northlight_apply_dropbox_sync_batch', {
            p_tenant_id: currentTenant.id,
            p_owner: owner,
            p_generation: generation,
            p_entries: entries,
          });
          matched += Number(outcome?.matched || 0);
          changed += Number(outcome?.changed || 0);
          if (outcome?.prefix_has_more) {
            prefixHasMore = true;
            break;
          }
        }
        if (prefixHasMore) {
          await advance(expectedCursor, expectedCursor, {
            ...page,
            has_more: true,
            root_missing: pageRootMissing,
          }, pageEntries.length, { pending_prefix_page_id: pageId });
          hasMore = true;
          break;
        }

        total += pageEntries.length;
        processedPages += 1;
        rootMissing = pageRootMissing;
        hasMore = Boolean(page?.has_more);
        await advance(expectedCursor, page?.cursor || null, {
          ...page,
          root_missing: pageRootMissing,
        }, pageEntries.length, { pending_prefix_page_id: null });
        full = false;
        if (!hasMore) break;
      }

      let continuationQueued = false;
      if (hasMore) {
        await enqueue(env, { webhookAt });
        continuationQueued = true;
      }
      await rpc(database, env, 'northlight_finish_dropbox_sync', {
        p_tenant_id: currentTenant.id,
        p_root_path: rootPath(env),
        p_owner: owner,
        p_generation: generation,
        p_last_error: null,
      });
      try {
        await writeSync(database, env, currentTenant, webhookAt ? 'webhook_sync' : 'manual_sync', {
          payload: { total, changed, matched, processedPages, continuationQueued, rootMissing },
        });
      } catch {}
      return {
        status: continuationQueued ? 'continued' : 'processed',
        total,
        changed,
        matched,
        processedPages,
        continuationQueued,
        hasMore,
        rootMissing,
      };
    } catch (error) {
      const safeError = safeSyncError(error);
      try {
        await rpc(database, env, 'northlight_finish_dropbox_sync', {
          p_tenant_id: currentTenant.id,
          p_root_path: rootPath(env),
          p_owner: owner,
          p_generation: generation,
          p_last_error: safeError,
        });
      } catch {}
      try {
        await writeSync(database, env, currentTenant, 'sync_failed', {
          status: 'failed',
          error: safeError,
        });
      } catch {}
      throw new Error(safeError);
    }
  };

  return async function runDropboxSync(env, options = {}) {
    try {
      return await runClaimedDropboxSync(env, options);
    } catch (error) {
      const safeError = safeSyncError(error);
      if (error?.message === safeError) throw error;
      throw new Error(safeError);
    }
  };
}

export const syncDropbox = createDropboxSync();

export async function connectedDropboxAccount(env) {
  const current = await integration(env, 'dropbox');
  return { current, accountId: current?.metadata?.account_id || null };
}

export async function verifyDropboxSignature(raw, signature, secret) {
  if (!signature || !secret || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const value = await crypto.subtle.sign('HMAC', key, encoder.encode(raw));
  const expected = [...new Uint8Array(value)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ signature.toLowerCase().charCodeAt(index);
  }
  return difference === 0;
}
