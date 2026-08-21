import test from 'node:test';
import assert from 'node:assert/strict';
import { seal } from '../functions/_lib/core.js';
import { refreshWithLease } from '../functions/_lib/oauth-refresh.js';
import { userAccessToken } from '../functions/_lib/user-integrations.js';
import {
  calendarEventHasDeleteSensitiveChanges,
  calendarEventOwnedByTask,
  managedCalendarEventNeedsReview,
  managedCalendarSnapshot,
  managedCalendarSnapshotsEqual,
  reconcileManagedCalendarEvent
} from '../functions/_lib/calendar-sync.js';
import { runCalendarCleanup, runTaskHandoff } from '../functions/_lib/task-handoffs.js';

const realFetch = globalThis.fetch;
const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const photographerId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const env = {
  SUPABASE_URL: 'https://db.test',
  SUPABASE_PUBLISHABLE_KEY: 'pk',
  NORTHLIGHT_DEMO_KEY: 'pilot',
  TOKEN_ENCRYPTION_KEY: 'test-secret',
  GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_CLIENT_SECRET: 'google-secret'
};

function json(data, status = 200) {
  return Response.json(data, { status });
}

test('concurrent per-user Google refreshes share one rotating-token exchange', async () => {
  let owner = null;
  let refreshCalls = 0;
  let finishCalls = 0;
  const record = {
    tenant_id: tenantId,
    user_id: photographerId,
    provider: 'google',
    status: 'connected',
    refresh_generation: 7,
    metadata: {
      access_token: await seal('expired-access', env.TOKEN_ENCRYPTION_KEY),
      access_expires_at: Date.now() - 1000,
      refresh_token: await seal('refresh-original', env.TOKEN_ENCRYPTION_KEY)
    }
  };

  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.origin === 'https://db.test') {
      const name = parsed.pathname.split('/').pop();
      const payload = options.body ? JSON.parse(options.body) : {};
      if (name === 'tenants') return json([{ id: tenantId, slug: 'realcapture' }]);
      if (name === 'user_integrations') return json([record]);
      if (name === 'northlight_claim_user_integration_refresh') {
        if (!owner) {
          owner = payload.p_owner;
          return json({ ...record, refresh_owner: owner, claimed: true });
        }
        return json({ ...record, refresh_owner: owner, claimed: false });
      }
      if (name === 'northlight_finish_user_integration_refresh') {
        assert.equal(payload.p_owner, owner);
        assert.equal(payload.p_generation, 7);
        record.metadata = payload.p_metadata;
        record.refresh_generation = 8;
        record.refresh_owner = null;
        owner = null;
        finishCalls += 1;
        return json(record);
      }
      if (name === 'northlight_release_user_integration_refresh') {
        owner = null;
        return json(null);
      }
    }
    if (parsed.origin === 'https://oauth2.googleapis.com') {
      refreshCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('refresh_token'), 'refresh-original');
      return json({ access_token: 'fresh-access', expires_in: 3600, token_type: 'Bearer' });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const tokens = await Promise.all([
    userAccessToken(env, photographerId, 'google'),
    userAccessToken(env, photographerId, 'google')
  ]);
  assert.deepEqual(tokens, ['fresh-access', 'fresh-access']);
  assert.equal(refreshCalls, 1);
  assert.equal(finishCalls, 1);
  assert.equal(record.refresh_generation, 8);
});

test('refresh lease releases before provider acceptance but stays held after ambiguous persistence failure', async () => {
  let releases = 0;
  await assert.rejects(refreshWithLease({
    current: { metadata: { access_token: 'expired', access_expires_at: 0 } },
    decode: async value => value,
    claim: async () => ({ claimed: true, refresh_generation: 0, metadata: {} }),
    read: async () => null,
    refreshProvider: async () => { throw new Error('provider_rejected_refresh'); },
    finish: async () => {},
    release: async () => { releases += 1; },
    wait: async () => {}
  }), /provider_rejected_refresh/);
  assert.equal(releases, 1);

  releases = 0;
  let finishes = 0;
  await assert.rejects(refreshWithLease({
    current: { metadata: { access_token: 'expired', access_expires_at: 0 } },
    decode: async value => value,
    claim: async () => ({ claimed: true, refresh_generation: 0, metadata: {} }),
    read: async () => null,
    refreshProvider: async () => ({ access_token: 'provider-accepted' }),
    finish: async () => { finishes += 1; throw new Error('database_unavailable_after_rotation'); },
    release: async () => { releases += 1; },
    wait: async () => {}
  }), /database_unavailable_after_rotation/);
  assert.equal(finishes, 3);
  assert.equal(releases, 0, 'a rotated credential must not be raced by another refresh');
});

function managedEvent({
  etag = '"v1"',
  start = '2026-08-24T00:00:00.000Z',
  end = '2026-08-24T01:30:00.000Z',
  summary = 'RC-100 · 10 Test Street',
  description = 'Northlight property media task RC-100\nServices: photos',
  location = '10 Test Street, Richmond',
  updated = '2026-08-20T00:00:00.000Z',
  ...extra
} = {}) {
  return {
    id: 'managed-event',
    etag,
    updated,
    summary,
    description,
    location,
    start: { dateTime: start, timeZone: 'Australia/Melbourne' },
    end: { dateTime: end, timeZone: 'Australia/Melbourne' },
    extendedProperties: { private: { northlightTaskId: taskId, northlightTaskNo: 'RC-100' } },
    ...extra
  };
}

function baseTask(event = managedEvent()) {
  return {
    id: taskId,
    tenant_id: tenantId,
    task_no: 'RC-100',
    property_name: '10 Test Street',
    address: '10 Test Street',
    suburb: 'Richmond',
    service_codes: ['photos'],
    photographer_user_id: photographerId,
    calendar_owner_user_id: photographerId,
    calendar_event_id: event.id,
    scheduled_start: '2026-08-24T00:00:00.000Z',
    scheduled_end: '2026-08-24T01:30:00.000Z',
    status: 'assigned',
    metadata: {
      calendar_id: 'primary',
      calendar_etag: event.etag,
      calendar_etag_event_id: event.id,
      calendar_managed_snapshot: managedCalendarSnapshot(event)
    }
  };
}

test('Calendar version comparison distinguishes provider metadata from managed-field edits', () => {
  const original = managedEvent();
  const task = baseTask(original);
  const reminderOnly = managedEvent({ etag: '"v2"', reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] } });
  const moved = managedEvent({ etag: '"v3"', start: '2026-08-24T02:00:00.000Z', end: '2026-08-24T03:30:00.000Z' });
  const foreign = managedEvent({ extendedProperties: { private: { northlightTaskId: 'someone-else' } } });

  assert.equal(calendarEventOwnedByTask(original, task), true);
  assert.equal(managedCalendarSnapshotsEqual(managedCalendarSnapshot(original), task.metadata.calendar_managed_snapshot), true);
  assert.equal(managedCalendarEventNeedsReview(task, reminderOnly), false);
  assert.equal(calendarEventHasDeleteSensitiveChanges(reminderOnly), true);
  assert.equal(managedCalendarEventNeedsReview(task, moved), true);
  assert.equal(managedCalendarEventNeedsReview(task, foreign), true);
});

function installHandoffScenario({ task: initialTask, patchEvent, getEvent, deleteEvent, cleanup = null }) {
  let taskState = structuredClone(initialTask);
  let handoff = { id: 'handoff-1', tenant_id: tenantId, task_id: taskId, kind: 'calendar', status: 'pending', attempts: 0, payload: {} };
  let cleanupState = cleanup ? structuredClone(cleanup) : null;
  const calls = { patch: [], get: [], delete: [], events: [] };

  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const method = String(options.method || 'GET').toUpperCase();
    if (parsed.origin === 'https://db.test') {
      const name = parsed.pathname.split('/').pop();
      const payload = options.body ? JSON.parse(options.body) : null;
      if (name === 'tenants') return json([{ id: tenantId, slug: 'realcapture', settings: {} }]);
      if (name === 'tasks') {
        if (method === 'PATCH') {
          taskState = { ...taskState, ...(payload || {}) };
          return json([taskState]);
        }
        return json([taskState]);
      }
      if (name === 'task_handoffs') {
        if (method === 'PATCH') {
          handoff = { ...handoff, ...(payload || {}) };
          return json([handoff]);
        }
        return json([handoff]);
      }
      if (name === 'calendar_cleanup_queue') {
        if (method === 'PATCH') {
          cleanupState = { ...cleanupState, ...(payload || {}) };
          return json([cleanupState]);
        }
        return json(cleanupState ? [cleanupState] : []);
      }
      if (name === 'provider_profiles') return json([{ user_id: photographerId, calendar_id: 'primary', timezone: 'Australia/Melbourne' }]);
      if (name === 'user_integrations') return json([{
        tenant_id: tenantId,
        user_id: photographerId,
        provider: 'google',
        status: 'connected',
        metadata: { access_token: 'valid-access', access_expires_at: Date.now() + 3600000 }
      }]);
      if (name === 'task_events') {
        if (method === 'POST') calls.events.push(payload);
        return json([]);
      }
      if (name === 'external_sync_events') return json([]);
      throw new Error(`unexpected database route ${name}`);
    }
    if (parsed.origin === 'https://www.googleapis.com') {
      if (method === 'PATCH') {
        calls.patch.push({ url: parsed, options });
        return patchEvent({ parsed, options, task: taskState, calls });
      }
      if (method === 'DELETE') {
        calls.delete.push({ url: parsed, options });
        return deleteEvent ? deleteEvent({ parsed, options, task: taskState, calls }) : new Response(null, { status: 204 });
      }
      calls.get.push({ url: parsed, options });
      return json(getEvent({ parsed, options, task: taskState, calls }));
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  return {
    calls,
    task: () => taskState,
    handoff: () => handoff,
    cleanup: () => cleanupState
  };
}

test('successful outbound Calendar update sends If-Match and persists the returned ETag', async () => {
  const oldEvent = managedEvent({ start: '2026-08-23T23:00:00.000Z', end: '2026-08-24T00:30:00.000Z' });
  const task = baseTask(oldEvent);
  task.scheduled_start = '2026-08-24T00:00:00.000Z';
  task.scheduled_end = '2026-08-24T01:30:00.000Z';
  const scenario = installHandoffScenario({
    task,
    patchEvent: ({ options }) => {
      const body = JSON.parse(options.body);
      return json({ ...body, id: oldEvent.id, etag: '"v2"', updated: '2026-08-21T00:00:00.000Z', htmlLink: 'https://calendar.test/event' });
    },
    getEvent: () => { throw new Error('GET should not be needed when the stored ETag succeeds'); }
  });

  const result = await runTaskHandoff(env, taskId, 'calendar');
  assert.equal(result.status, 'done');
  assert.equal(scenario.calls.patch.length, 1);
  assert.equal(scenario.calls.patch[0].options.headers['if-match'], '"v1"');
  assert.equal(scenario.task().metadata.calendar_etag, '"v2"');
  assert.equal(scenario.task().metadata.calendar_etag_event_id, oldEvent.id);
  assert.equal(scenario.handoff().status, 'done');
});

test('outbound 412 fetches the provider copy and preserves an external time change for review', async () => {
  const oldEvent = managedEvent({ start: '2026-08-23T23:00:00.000Z', end: '2026-08-24T00:30:00.000Z' });
  const task = baseTask(oldEvent);
  task.scheduled_start = '2026-08-24T00:00:00.000Z';
  task.scheduled_end = '2026-08-24T01:30:00.000Z';
  const external = managedEvent({ etag: '"external"', start: '2026-08-24T02:00:00.000Z', end: '2026-08-24T03:30:00.000Z', updated: '2026-08-21T00:01:00.000Z' });
  const scenario = installHandoffScenario({
    task,
    patchEvent: () => json({ error: { code: 412, message: 'Precondition Failed' } }, 412),
    getEvent: () => external
  });

  const result = await runTaskHandoff(env, taskId, 'calendar');
  assert.equal(result.status, 'attention');
  assert.equal(scenario.calls.patch.length, 1, 'Northlight must not retry over changed managed fields');
  assert.equal(scenario.calls.get.length, 1);
  assert.equal(scenario.task().scheduled_start, '2026-08-24T00:00:00.000Z', 'the booked time remains Northlight truth');
  assert.equal(scenario.task().status, 'reschedule_requested');
  assert.equal(scenario.task().metadata.external_calendar_etag, '"external"');
  assert.deepEqual(scenario.task().metadata.external_calendar_proposed_schedule, {
    start: '2026-08-24T02:00:00.000Z',
    end: '2026-08-24T03:30:00.000Z',
    event_id: 'managed-event'
  });
  assert.equal(scenario.handoff().status, 'attention');
});

test('inbound managed-field edits become a pre-shoot review without storing private Calendar text', async () => {
  const original = managedEvent();
  const task = baseTask(original);
  const external = managedEvent({ etag: '"external-copy"', summary: 'Private text entered in Calendar' });
  const scenario = installHandoffScenario({
    task,
    patchEvent: () => { throw new Error('provider PATCH is not expected'); },
    getEvent: () => external
  });

  const result = await reconcileManagedCalendarEvent(env, task, external);
  assert.equal(result.changed, true);
  assert.equal(result.reviewed, true);
  assert.equal(scenario.task().status, 'reschedule_requested');
  assert.deepEqual(scenario.task().metadata.external_calendar_changed_fields, ['summary']);
  assert.equal(JSON.stringify(scenario.task().metadata).includes('Private text entered in Calendar'), false);

  const postShoot = { ...scenario.task(), status: 'editing' };
  const ignored = await reconcileManagedCalendarEvent(env, postShoot, external);
  assert.deepEqual(ignored, { changed: false, reviewed: false });
});

test('delete 412 leaves the changed Calendar event intact and puts cleanup in review', async () => {
  const original = managedEvent();
  const task = baseTask(original);
  task.status = 'cancelled';
  const external = managedEvent({ etag: '"changed-before-delete"', summary: 'User kept this event for a reason', updated: '2026-08-21T00:02:00.000Z' });
  const cleanup = {
    id: 'cleanup-1',
    tenant_id: tenantId,
    task_id: taskId,
    calendar_owner_user_id: photographerId,
    calendar_event_id: original.id,
    calendar_id: 'primary',
    status: 'pending',
    attempts: 0
  };
  const scenario = installHandoffScenario({
    task,
    cleanup,
    patchEvent: () => { throw new Error('PATCH is not expected'); },
    getEvent: () => external,
    deleteEvent: () => json({ error: { code: 412, message: 'Precondition Failed' } }, 412)
  });

  const result = await runCalendarCleanup(env, cleanup.id);
  assert.equal(result.status, 'attention');
  assert.equal(scenario.calls.delete.length, 1);
  assert.equal(scenario.calls.get.length, 1);
  assert.equal(scenario.cleanup().status, 'attention');
  assert.equal(scenario.cleanup().last_error, 'calendar_external_change_review_required');
  assert.equal(scenario.task().status, 'cancelled');
  assert.equal(scenario.task().metadata.calendar_cleanup_external_change.etag, '"changed-before-delete"');
  assert.ok(scenario.calls.events.some(event => event.type === 'calendar_cleanup_external_change_requires_review'));
});

test.after(() => { globalThis.fetch = realFetch; });
