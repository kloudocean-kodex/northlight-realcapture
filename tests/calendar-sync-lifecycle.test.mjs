import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarRenewalLeadMs,
  calendarWatchNeedsRenewal,
  fullCalendarSync,
  incrementalCalendarSync,
  maintainCalendarWatches,
  startCalendarWatch,
} from '../functions/_lib/calendar-sync.js';
import { sha256Hex } from '../functions/_lib/oauth-security.js';
import { onRequestPost as googleCalendarWebhook } from '../functions/webhooks/google-calendar.js';

const realFetch = globalThis.fetch;
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-08-21T12:00:00.000Z');
const ORIGIN = 'https://northlight.example';
const env = Object.freeze({
  SUPABASE_URL: 'https://db.test',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-test-key',
  NORTHLIGHT_DEMO_KEY: 'pilot-test-key',
  TOKEN_ENCRYPTION_KEY: 'test-token-encryption-key',
  PUBLIC_ORIGIN: ORIGIN,
});

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
});

function integration() {
  return {
    tenant_id: TENANT_ID,
    user_id: USER_ID,
    provider: 'google',
    status: 'connected',
    refresh_generation: 9,
    metadata: {
      access_token: 'test-access-token',
      access_expires_at: Number.MAX_SAFE_INTEGER,
    },
  };
}

function installSyncHarness({
  cursor = null,
  claimed = true,
  provider,
  maxPages,
  advanceHook,
  maintenance = null,
} = {}) {
  const state = {
    cursor,
    calls: [],
    providerCalls: [],
    advances: [],
    finishes: [],
    logs: [],
    maxPages,
  };
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const method = String(options.method || 'GET').toUpperCase();
    if (parsed.origin === 'https://db.test') {
      const route = parsed.pathname.split('/').at(-1);
      const payload = options.body ? JSON.parse(options.body) : null;
      state.calls.push({ route, method, payload, search: parsed.search });
      if (route === 'tenants') return json([{ id: TENANT_ID, slug: 'realcapture', settings: {} }]);
      if (route === 'user_integrations') return json([integration()]);
      if (route === 'tasks') return json([]);
      if (route === 'northlight_claim_calendar_sync') {
        return json(claimed
          ? { claimed: true, generation: 7, connection_generation: 9, sync_token: state.cursor }
          : { claimed: false, generation: 7, connection_generation: 9 });
      }
      if (route === 'northlight_advance_calendar_sync') {
        state.advances.push(structuredClone(payload));
        if (advanceHook) await advanceHook(payload, state);
        if (payload.p_expected_sync_token !== state.cursor) {
          return json({ message: 'calendar_sync_token_changed' }, 409);
        }
        state.cursor = payload.p_sync_token;
        return json({
          generation: 7,
          connection_generation: 9,
          sync_token: state.cursor,
        });
      }
      if (route === 'northlight_finish_calendar_sync') {
        state.finishes.push(payload.p_last_error);
        return json({ finished: true, generation: 7, sync_token: state.cursor });
      }
      if (route === 'northlight_list_calendar_maintenance') return json(maintenance || { items: [], as_of: new Date(NOW).toISOString() });
      if (route === 'external_sync_events') {
        state.logs.push(structuredClone(payload));
        return json([]);
      }
      throw new Error(`unexpected_database_route:${route}`);
    }
    if (parsed.origin === 'https://www.googleapis.com') {
      state.providerCalls.push({ parsed, options });
      return provider
        ? provider({ parsed, options, index: state.providerCalls.length - 1, state })
        : json({ items: [], nextSyncToken: 'next-sync-token' });
    }
    throw new Error(`unexpected_fetch:${parsed.origin}${parsed.pathname}`);
  };
  return state;
}

test('a held sync lease is retryable and performs no provider or task work', async () => {
  const state = installSyncHarness({ claimed: false });
  const result = await incrementalCalendarSync(env, USER_ID, 'primary', { clock: () => NOW });
  assert.deepEqual(result, { busy: true, retryAfterSeconds: 30, connectionGeneration: 9 });
  assert.equal(state.providerCalls.length, 0);
  assert.equal(state.calls.some(call => call.route === 'tasks'), false);
  assert.equal(state.advances.length, 0);
  assert.equal(state.finishes.length, 0);
});

test('incremental pages preserve query invariants and CAS the old cursor to the final token', async () => {
  const state = installSyncHarness({
    cursor: 'cursor-old',
    provider: ({ parsed, index }) => index === 0
      ? json({ items: [], nextPageToken: 'page-2' })
      : json({ items: [], nextSyncToken: 'cursor-new' }),
  });
  const result = await incrementalCalendarSync(env, USER_ID, 'primary', { clock: () => NOW });
  assert.equal(result.kind, 'incremental');
  assert.equal(result.pages, 2);
  assert.equal(state.providerCalls.length, 2);
  assert.equal(state.providerCalls[0].parsed.searchParams.get('syncToken'), 'cursor-old');
  assert.equal(state.providerCalls[0].parsed.searchParams.get('timeMin'), null);
  assert.equal(state.providerCalls[0].parsed.searchParams.get('showDeleted'), 'true');
  assert.equal(state.providerCalls[0].parsed.searchParams.get('singleEvents'), 'false');
  assert.equal(state.providerCalls[1].parsed.searchParams.get('pageToken'), 'page-2');
  assert.deepEqual(state.advances.map(call => ({
    expected: call.p_expected_sync_token,
    next: call.p_sync_token,
    kind: call.p_sync_kind,
  })), [{ expected: 'cursor-old', next: 'cursor-new', kind: 'incremental' }]);
  assert.deepEqual(state.finishes, [null]);
});

test('Google 410 atomically clears the stale cursor before a bounded full resync', async () => {
  const state = installSyncHarness({
    cursor: 'expired-cursor',
    provider: ({ index, parsed }) => {
      if (index === 0) return json({ error: { errors: [{ reason: 'syncTokenExpired' }] } }, 410);
      assert.equal(parsed.searchParams.get('syncToken'), null);
      assert.ok(parsed.searchParams.get('timeMin'));
      return json({ items: [], nextSyncToken: 'replacement-cursor' });
    },
  });
  const result = await incrementalCalendarSync(env, USER_ID, 'primary', { clock: () => NOW });
  assert.equal(result.kind, 'full');
  assert.deepEqual(state.advances.map(call => ({
    expected: call.p_expected_sync_token,
    next: call.p_sync_token,
    kind: call.p_sync_kind,
    error: call.p_last_error,
  })), [
    { expected: 'expired-cursor', next: null, kind: 'reset', error: 'calendar_sync_token_invalidated' },
    { expected: null, next: 'replacement-cursor', kind: 'full', error: null },
  ]);
  assert.equal(state.cursor, 'replacement-cursor');
  assert.deepEqual(state.finishes, [null]);
});

test('a concurrent cursor winner cannot be overwritten by a stale run', async () => {
  let raced = false;
  const state = installSyncHarness({
    cursor: 'cursor-before-race',
    provider: () => json({ items: [], nextSyncToken: 'stale-result' }),
    advanceHook: (_payload, current) => {
      if (!raced) {
        raced = true;
        current.cursor = 'winner-result';
      }
    },
  });
  await assert.rejects(
    incrementalCalendarSync(env, USER_ID, 'primary', { clock: () => NOW }),
    /calendar_sync_token_changed/,
  );
  assert.equal(state.cursor, 'winner-result');
  assert.equal(state.advances.length, 1);
  assert.deepEqual(state.finishes, ['calendar_sync_token_changed']);
});

test('page limits fail closed without advancing a partial cursor', async () => {
  const secret = 'ya29.private-token-which-must-never-be-logged';
  const state = installSyncHarness({
    provider: ({ index }) => json({
      items: [],
      nextPageToken: `page-${index + 2}-${secret}`,
      nextSyncToken: `partial-${index + 1}`,
    }),
  });
  await assert.rejects(
    fullCalendarSync(env, USER_ID, 'primary', { clock: () => NOW, maxPages: 2 }),
    /calendar_sync_page_limit/,
  );
  assert.equal(state.providerCalls.length, 2);
  assert.equal(state.advances.length, 0);
  assert.deepEqual(state.finishes, ['calendar_sync_page_limit']);
  assert.equal(JSON.stringify(state.logs).includes(secret), false);
  assert.equal(state.logs.at(-1).error, 'calendar_sync_page_limit');
});

function installWatchHarness({ claim = true, activationFails = false, retired = true, queueFails = false } = {}) {
  const state = {
    calls: [],
    providerCalls: [],
    queue: [],
    watchBody: null,
  };
  const watchEnv = {
    ...env,
    TASK_HANDOFF_QUEUE: {
      async send(message, options) {
        if (queueFails) throw new Error('queue unavailable with private detail');
        state.queue.push({ message: structuredClone(message), options: structuredClone(options) });
      },
    },
  };
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const method = String(options.method || 'GET').toUpperCase();
    if (parsed.origin === 'https://db.test') {
      const route = parsed.pathname.split('/').at(-1);
      const payload = options.body ? JSON.parse(options.body) : null;
      state.calls.push({ route, method, payload });
      if (route === 'tenants') return json([{ id: TENANT_ID, slug: 'realcapture', settings: {} }]);
      if (route === 'user_integrations') return json([integration()]);
      if (route === 'northlight_claim_calendar_watch') return json(claim
        ? { claimed: true, generation: 4, connection_generation: 9, current: retired ? { channel_id: 'old-channel', resource_id: 'old-resource' } : null }
        : { claimed: false, generation: 3, connection_generation: 9, current: null });
      if (route === 'northlight_activate_calendar_watch') {
        if (activationFails) return json({ message: 'calendar_watch_claim_lost' }, 409);
        return json({
          active: { channel_id: payload.p_channel_id, resource_id: payload.p_resource_id, generation: 4, expires_at: payload.p_expires_at },
          retired_channels: retired ? [{ channel_id: 'old-channel', resource_id: 'old-resource' }] : [],
        });
      }
      if (route === 'northlight_stop_calendar_watch_channel') return json({ stopped: true });
      if (route === 'northlight_fail_calendar_watch') return json({ failed: true });
      if (route === 'external_sync_events') return json([]);
      throw new Error(`unexpected_database_route:${route}`);
    }
    if (parsed.origin === 'https://www.googleapis.com') {
      const body = options.body ? JSON.parse(options.body) : null;
      state.providerCalls.push({ parsed, options, body });
      if (parsed.pathname.endsWith('/events/watch')) {
        state.watchBody = body;
        return json({
          id: body.id,
          resourceId: 'new-resource',
          expiration: String(NOW + 6 * 86400000),
          token: body.token,
          untrustedProviderField: 'must-not-escape',
        });
      }
      if (parsed.pathname.endsWith('/channels/stop')) return json({});
      throw new Error(`unexpected_google_route:${parsed.pathname}`);
    }
    throw new Error(`unexpected_fetch:${parsed.origin}${parsed.pathname}`);
  };
  return { state, watchEnv };
}

test('watch renewal pre-registers only a token hash, activates before syncing, and retires by id plus resourceId', async () => {
  const { state, watchEnv } = installWatchHarness();
  const result = await startCalendarWatch(watchEnv, USER_ID, 'primary', ORIGIN, {
    clock: () => NOW,
    syncMode: 'enqueue',
  });
  const claim = state.calls.find(call => call.route === 'northlight_claim_calendar_watch');
  const activation = state.calls.find(call => call.route === 'northlight_activate_calendar_watch');
  const stopped = state.calls.find(call => call.route === 'northlight_stop_calendar_watch_channel');
  assert.match(claim.payload.p_token_hash, /^[0-9a-f]{64}$/);
  assert.equal(claim.payload.p_token_hash, await sha256Hex(state.watchBody.token));
  assert.equal(JSON.stringify(state.calls).includes(state.watchBody.token), false, 'plaintext callback token must never enter a DB payload');
  assert.equal(state.watchBody.address, `${ORIGIN}/webhooks/google-calendar`);
  assert.equal(activation.payload.p_channel_id, state.watchBody.id);
  assert.deepEqual({ id: stopped.payload.p_channel_id, resourceId: stopped.payload.p_resource_id }, {
    id: 'old-channel', resourceId: 'old-resource',
  });
  assert.equal(state.providerCalls[1].body.id, 'old-channel');
  assert.equal(state.providerCalls[1].body.resourceId, 'old-resource');
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].message.type, 'calendar_sync');
  assert.equal(state.calls.findIndex(call => call.route === 'northlight_activate_calendar_watch')
    < state.calls.findIndex(call => call.route === 'northlight_stop_calendar_watch_channel'), true);
  assert.equal('token' in result, false);
  assert.equal('untrustedProviderField' in result, false);
  assert.equal(result.id, state.watchBody.id);
});

test('lost watch activation stops the orphan provider channel and records a fenced failure', async () => {
  const { state, watchEnv } = installWatchHarness({ activationFails: true, retired: false });
  await assert.rejects(
    startCalendarWatch(watchEnv, USER_ID, 'primary', ORIGIN, { clock: () => NOW, syncMode: 'enqueue' }),
    /calendar_watch_claim_lost/,
  );
  const stop = state.providerCalls.find(call => call.parsed.pathname.endsWith('/channels/stop'));
  assert.ok(stop);
  assert.equal(stop.body.id, state.watchBody.id);
  assert.equal(stop.body.resourceId, 'new-resource');
  assert.ok(state.calls.some(call => call.route === 'northlight_fail_calendar_watch'));
  assert.equal(state.queue.length, 0);
});

test('watch origin is canonical and a concurrent watch claim does not call Google', async () => {
  const first = installWatchHarness({ retired: false });
  await assert.rejects(
    startCalendarWatch(first.watchEnv, USER_ID, 'primary', 'https://attacker.example', { clock: () => NOW }),
    /calendar_watch_origin_mismatch/,
  );
  assert.equal(first.state.calls.length, 0);
  assert.equal(first.state.providerCalls.length, 0);

  const second = installWatchHarness({ claim: false, retired: false });
  const result = await startCalendarWatch(second.watchEnv, USER_ID, 'primary', ORIGIN, { clock: () => NOW });
  assert.equal(result.busy, true);
  assert.equal(second.state.providerCalls.length, 0);
});

function webhookRequest({ channel = 'channel-1', resource = 'resource-1', token = 'webhook-secret-at-least-16', state = 'exists' } = {}) {
  return new Request(`${ORIGIN}/webhooks/google-calendar`, {
    method: 'POST',
    headers: {
      'x-goog-channel-id': channel,
      'x-goog-resource-id': resource,
      'x-goog-channel-token': token,
      'x-goog-resource-state': state,
    },
  });
}

function installWebhookHarness({ channel = null, databaseFails = false, queueFails = false } = {}) {
  const calls = [];
  const queued = [];
  const webhookEnv = {
    ...env,
    TASK_HANDOFF_QUEUE: {
      async send(message) {
        if (queueFails) throw new Error('queue failed');
        queued.push(structuredClone(message));
      },
    },
  };
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const route = parsed.pathname.split('/').at(-1);
    const payload = options.body ? JSON.parse(options.body) : null;
    calls.push({ route, payload });
    if (route === 'tenants') return json([{ id: TENANT_ID, slug: 'realcapture', settings: {} }]);
    if (route === 'northlight_read_calendar_watch_channel') {
      if (databaseFails) return json({ message: 'database unavailable' }, 503);
      return json(channel);
    }
    throw new Error(`unexpected_route:${route}`);
  };
  return { calls, queued, webhookEnv };
}

test('webhook accepts verified active and draining overlap channels only after durable enqueue', async () => {
  for (const status of ['active', 'draining']) {
    const harness = installWebhookHarness({
      channel: { user_id: USER_ID, calendar_id: 'primary', status },
    });
    const token = `valid-${status}-webhook-token`;
    const response = await googleCalendarWebhook({ request: webhookRequest({ token }), env: harness.webhookEnv });
    assert.equal(response.status, 204);
    assert.equal(harness.queued.length, 1);
    assert.equal(harness.queued[0].type, 'calendar_sync');
    const lookup = harness.calls.find(call => call.route === 'northlight_read_calendar_watch_channel');
    assert.equal(lookup.payload.p_token_hash, await sha256Hex(token));
    assert.equal(JSON.stringify(harness.calls).includes(token), false);
  }
});

test('pre-activation sync is harmless, unknown mutations are rejected, and retryable failures are not acknowledged', async () => {
  let harness = installWebhookHarness({ channel: null });
  let response = await googleCalendarWebhook({ request: webhookRequest({ state: 'sync' }), env: harness.webhookEnv });
  assert.equal(response.status, 204);
  assert.equal(harness.queued.length, 0);

  harness = installWebhookHarness({ channel: null });
  response = await googleCalendarWebhook({ request: webhookRequest({ state: 'exists' }), env: harness.webhookEnv });
  assert.equal(response.status, 404);
  assert.equal(harness.queued.length, 0);

  harness = installWebhookHarness({ databaseFails: true });
  response = await googleCalendarWebhook({ request: webhookRequest(), env: harness.webhookEnv });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '30');

  harness = installWebhookHarness({ channel: { user_id: USER_ID, calendar_id: 'primary', status: 'active' }, queueFails: true });
  response = await googleCalendarWebhook({ request: webhookRequest(), env: harness.webhookEnv });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '30');
});

test('renewal jitter spans the stable 18–30 hour window and boundary checks are exact', () => {
  const leads = Array.from({ length: 256 }, (_, index) => calendarRenewalLeadMs(`user-${index}`, 'primary'));
  const min = 18 * 60 * 60 * 1000;
  const max = 30 * 60 * 60 * 1000;
  assert.ok(leads.every(value => value >= min && value < max));
  assert.ok(Math.max(...leads) - Math.min(...leads) > 8 * 60 * 60 * 1000, 'jitter should not collapse into a narrow spike');
  assert.equal(calendarRenewalLeadMs(USER_ID, 'primary'), calendarRenewalLeadMs(USER_ID, 'primary'));
  const lead = calendarRenewalLeadMs(USER_ID, 'primary');
  assert.equal(calendarWatchNeedsRenewal(new Date(NOW + lead + 1).toISOString(), USER_ID, 'primary', NOW), false);
  assert.equal(calendarWatchNeedsRenewal(new Date(NOW + lead).toISOString(), USER_ID, 'primary', NOW), true);
});

test('scheduled maintenance consumes only the bounded RPC surface and repairs sync under a lease', async () => {
  const state = installSyncHarness({
    maintenance: {
      items: [{
        user_id: USER_ID,
        calendar_id: 'primary',
        watch_expires_at: new Date(NOW + 4 * 86400000).toISOString(),
        sync_due: true,
      }],
      as_of: new Date(NOW).toISOString(),
    },
    provider: () => json({ items: [], nextSyncToken: 'maintenance-cursor' }),
  });
  const result = await maintainCalendarWatches(env, ORIGIN, { clock: () => NOW, limit: 5 });
  assert.deepEqual(result, { checked: 1, renewed: 0, synced: 1, busy: 0, failed: 0 });
  assert.equal(state.cursor, 'maintenance-cursor');
  assert.ok(state.calls.some(call => call.route === 'northlight_list_calendar_maintenance'));
  assert.equal(state.calls.some(call => ['provider_profiles', 'users'].includes(call.route)), false);
});

test.after(() => { globalThis.fetch = realFetch; });
