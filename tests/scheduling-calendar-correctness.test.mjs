import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  evaluateBooking,
  isAtomicScheduleConflict,
  privacySafeBusyIntervals,
  resolveZonedLocalTime,
  zonedLocalToUtc
} from '../functions/_lib/scheduling.js';
import { calendarChangeReviewable, reviewableCalendarTasks } from '../functions/_lib/calendar-sync.js';
import { rankEditorCandidates } from '../functions/_lib/editor-assignment.js';

const realFetch = globalThis.fetch;
const photographerId = '11111111-1111-4111-8111-111111111111';
const taskId = '22222222-2222-4222-8222-222222222222';
const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const env = {
  SUPABASE_URL: 'https://db.test',
  SUPABASE_PUBLISHABLE_KEY: 'pk',
  NORTHLIGHT_DEMO_KEY: 'pilot',
  TOKEN_ENCRYPTION_KEY: 'test-only'
};
const user = { id: photographerId, role_code: 'photographer', active: true };
const profile = {
  user_id: photographerId,
  areas: ['Inner East'],
  service_codes: ['photos'],
  working_hours: {
    mon: ['08:00', '18:00'], tue: ['08:00', '18:00'], wed: ['08:00', '18:00'],
    thu: ['08:00', '18:00'], fri: ['08:00', '18:00'], sat: ['08:00', '18:00'], sun: ['08:00', '18:00']
  },
  days_off: [],
  special_days: [],
  timezone: 'Australia/Melbourne',
  calendar_id: 'primary'
};
const services = [{ code: 'photos', duration_min: 90, buffer_before_min: 10, buffer_after_min: 20, active: true }];

function firstSunday(year, monthIndex) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  return 1 + ((7 - first.getUTCDay()) % 7);
}

test('Melbourne DST gaps and overlaps are explicit for five consecutive years', () => {
  for (let year = 2026; year <= 2030; year += 1) {
    const spring = `${year}-10-${String(firstSunday(year, 9)).padStart(2, '0')}T02:30`;
    const autumn = `${year}-04-${String(firstSunday(year, 3)).padStart(2, '0')}T02:30`;
    assert.equal(resolveZonedLocalTime(spring).kind, 'nonexistent', spring);

    const overlap = resolveZonedLocalTime(autumn);
    assert.equal(overlap.kind, 'ambiguous', autumn);
    assert.equal(overlap.choices.length, 2);
    const earlier = resolveZonedLocalTime(autumn, 'Australia/Melbourne', 'earlier');
    const later = resolveZonedLocalTime(autumn, 'Australia/Melbourne', 'later');
    assert.equal(earlier.kind, 'valid');
    assert.equal(later.kind, 'valid');
    assert.equal(later.instant - earlier.instant, 60 * 60 * 1000);
    assert.notEqual(earlier.offsetMinutes, later.offsetMinutes);
    assert.ok(Number.isNaN(zonedLocalToUtc(autumn).getTime()), 'an overlap must not silently pick one instant');
  }
});

test('booking evaluation returns actionable DST validation instead of changing the requested wall time', async () => {
  globalThis.fetch = async url => {
    const parsed = new URL(String(url));
    const table = parsed.pathname.split('/').pop();
    const output = table === 'users' ? [user]
      : table === 'provider_profiles' ? [profile]
        : table === 'services' ? services
          : [];
    return Response.json(output);
  };
  const gap = await evaluateBooking(env, {
    photographerId,
    area: 'Inner East',
    serviceCodes: ['photos'],
    startLocal: '2026-10-04T02:30'
  });
  assert.equal(gap.code, 'NONEXISTENT_LOCAL_TIME');
  assert.equal(gap.start, undefined);

  const overlap = await evaluateBooking(env, {
    photographerId,
    area: 'Inner East',
    serviceCodes: ['photos'],
    startLocal: '2027-04-04T02:30'
  });
  assert.equal(overlap.code, 'AMBIGUOUS_LOCAL_TIME');
  assert.deepEqual(overlap.timeChoices.map(choice => choice.disambiguation), ['earlier', 'later']);
  assert.deepEqual(overlap.timeChoices.map(choice => choice.offset), ['UTC+11:00', 'UTC+10:00']);
});

test('booking evaluation blocks photographers who still need personal password setup', async () => {
  globalThis.fetch = async url => {
    const parsed = new URL(String(url));
    if (parsed.origin === 'https://www.googleapis.com') {
      throw new Error('Google Calendar must not be checked for a credential-blocked photographer');
    }
    const table = parsed.pathname.split('/').pop();
    const output = table === 'users' ? [{ ...user, auth_must_change_password: true }]
      : table === 'provider_profiles' ? [profile]
        : table === 'services' ? services
          : [];
    return Response.json(output);
  };

  const result = await evaluateBooking(env, {
    photographerId,
    area: 'Inner East',
    serviceCodes: ['photos'],
    startLocal: '2026-08-24T10:00'
  });

  assert.equal(result.available, false);
  assert.equal(result.connected, false);
  assert.equal(result.code, 'PHOTOGRAPHER_CREDENTIALS_REQUIRED');
  assert.match(result.reason, /personal password setup/i);
});

test('privacy-safe event filtering excludes the managed event and never returns personal details', () => {
  const events = [
    { id: 'managed', summary: 'Customer address and private notes', start: { dateTime: '2026-08-23T23:00:00Z' }, end: { dateTime: '2026-08-24T00:30:00Z' } },
    { id: 'busy', summary: 'Private medical appointment', location: 'Secret', start: { dateTime: '2026-08-23T23:30:00Z' }, end: { dateTime: '2026-08-23T23:45:00Z' } },
    { id: 'free', transparency: 'transparent', start: { dateTime: '2026-08-23T23:10:00Z' }, end: { dateTime: '2026-08-23T23:20:00Z' } },
    { id: 'declined', attendees: [{ self: true, responseStatus: 'declined' }], start: { dateTime: '2026-08-23T23:10:00Z' }, end: { dateTime: '2026-08-23T23:20:00Z' } },
    { id: 'where', eventType: 'workingLocation', start: { date: '2026-08-24' }, end: { date: '2026-08-25' } },
    { id: 'deleted', status: 'cancelled', start: { dateTime: '2026-08-23T23:10:00Z' }, end: { dateTime: '2026-08-23T23:20:00Z' } }
  ];
  const busy = privacySafeBusyIntervals(events, {
    excludeEventId: 'managed',
    min: new Date('2026-08-23T22:50:00Z'),
    max: new Date('2026-08-24T00:50:00Z')
  });
  assert.deepEqual(busy, [{ start: '2026-08-23T23:30:00.000Z', end: '2026-08-23T23:45:00.000Z' }]);
  assert.equal(JSON.stringify(busy).includes('medical'), false);
  assert.equal(JSON.stringify(busy).includes('Secret'), false);
});

function installCalendarScenario(externalEvents = []) {
  const requestedGoogleUrls = [];
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.origin === 'https://db.test') {
      const table = parsed.pathname.split('/').pop();
      let output = [];
      if (table === 'users') output = [user];
      else if (table === 'provider_profiles') output = [profile];
      else if (table === 'services') output = services;
      else if (table === 'tenants') output = [{ id: tenantId, slug: 'realcapture', settings: {} }];
      else if (table === 'user_integrations') output = [{
        tenant_id: tenantId,
        user_id: photographerId,
        provider: 'google',
        status: 'connected',
        metadata: { access_token: 'token', access_expires_at: Date.now() + 3600000 }
      }];
      else if (table === 'tasks' && parsed.searchParams.get('select')?.includes('calendar_event_id')) {
        output = [{ calendar_event_id: 'managed-event', calendar_owner_user_id: photographerId }];
      }
      return Response.json(output);
    }
    if (parsed.origin === 'https://www.googleapis.com' && parsed.pathname.endsWith('/events')) {
      requestedGoogleUrls.push(parsed);
      return Response.json({
        items: [
          {
            id: 'managed-event',
            summary: 'Northlight customer name and address',
            start: { dateTime: '2026-08-23T23:00:00Z' },
            end: { dateTime: '2026-08-24T00:30:00Z' }
          },
          ...externalEvents
        ]
      });
    }
    throw new Error(`unexpected fetch ${url} ${options.method || 'GET'}`);
  };
  return requestedGoogleUrls;
}

async function evaluateReschedule() {
  return evaluateBooking(env, {
    photographerId,
    area: 'Inner East',
    serviceCodes: ['photos'],
    start: new Date('2026-08-23T23:00:00Z'),
    durationMinutes: 90,
    excludeTaskId: taskId,
    requireActiveServices: false
  });
}

test('same-time or overlapping reschedule ignores only its own managed Google event', async () => {
  const urls = installCalendarScenario();
  const result = await evaluateReschedule();
  assert.equal(result.available, true);
  assert.equal(result.code, 'AVAILABLE');
  assert.equal(urls.length, 1);
  assert.equal(urls[0].searchParams.get('fields').includes('summary'), false);
  assert.equal(urls[0].searchParams.get('fields').includes('description'), false);
  assert.equal(urls[0].searchParams.get('fields').includes('location'), false);
});

test('reschedule still fails closed for a different external Google busy event', async () => {
  installCalendarScenario([{
    id: 'external-busy',
    summary: 'Never expose this title',
    start: { dateTime: '2026-08-23T23:35:00Z' },
    end: { dateTime: '2026-08-23T23:50:00Z' }
  }]);
  const result = await evaluateReschedule();
  assert.equal(result.available, false);
  assert.equal(result.code, 'GOOGLE_BUSY');
  assert.deepEqual(result.busy, [{ start: '2026-08-23T23:35:00.000Z', end: '2026-08-23T23:50:00.000Z' }]);
  assert.equal(JSON.stringify(result).includes('Never expose'), false);
});

test('a declined booking immediately releases the declining Photographer slot', async () => {
  let conflictQuery = '';
  globalThis.fetch = async url => {
    const parsed = new URL(String(url));
    const table = parsed.pathname.split('/').pop();
    let output = [];
    if (table === 'users') output = [user];
    else if (table === 'provider_profiles') output = [profile];
    else if (table === 'services') output = services;
    else if (table === 'tasks') {
      conflictQuery = decodeURIComponent(parsed.search);
      output = conflictQuery.includes('status=not.in.(cancelled,delivered,declined)') ? [] : [{
        id: 'declined-task',
        status: 'declined',
        scheduled_start: '2026-08-23T23:00:00.000Z',
        scheduled_end: '2026-08-24T00:30:00.000Z'
      }];
    } else if (table === 'tenants') output = [{ id: tenantId, slug: 'realcapture', settings: {} }];
    else if (table === 'user_integrations') output = [{
      tenant_id: tenantId,
      user_id: photographerId,
      provider: 'google',
      status: 'connected',
      metadata: { access_token: 'token', access_expires_at: Date.now() + 3600000 }
    }];
    if (parsed.origin === 'https://www.googleapis.com') {
      return Response.json({ calendars: { primary: { busy: [] } } });
    }
    return Response.json(output);
  };

  const result = await evaluateBooking(env, {
    photographerId,
    area: 'Inner East',
    serviceCodes: ['photos'],
    start: new Date('2026-08-23T23:00:00.000Z'),
    durationMinutes: 90,
    requireActiveServices: false
  });
  assert.equal(result.available, true);
  assert.match(conflictQuery, /status=not\.in\.\(cancelled,delivered,declined\)/);
});

test('Calendar inbound review is limited to pre-shoot states', () => {
  for (const status of ['assigned', 'confirmed', 'reschedule_requested']) assert.equal(calendarChangeReviewable(status), true);
  for (const status of ['shoot_complete', 'raw_received', 'editing', 'review', 'revision', 'delivered', 'declined', 'cancelled']) {
    assert.equal(calendarChangeReviewable(status), false, status);
  }
  const rows = ['assigned', 'confirmed', 'reschedule_requested', 'raw_received', 'editing', 'review', 'revision']
    .map(status => ({ status, calendar_event_id: `event-${status}` }));
  assert.deepEqual(reviewableCalendarTasks(rows).map(task => task.status), ['assigned', 'confirmed', 'reschedule_requested']);
});

test('Editor routing uses live unfinished work, full skill coverage, and deterministic ties', () => {
  const users = [
    { id: 'editor-a', role_code: 'editor', active: true },
    { id: 'editor-b', role_code: 'editor', active: true },
    { id: 'editor-c', role_code: 'editor', active: true }
  ];
  const profiles = [
    { user_id: 'editor-a', skills: ['photos', 'drone'], current_load: 999 },
    { user_id: 'editor-b', skills: ['photos', 'drone'], current_load: 0 },
    { user_id: 'editor-c', skills: ['photos'], current_load: 0 }
  ];
  const tasks = [
    { editor_user_id: 'editor-b', status: 'editing' },
    { editor_user_id: 'editor-b', status: 'review' },
    { editor_user_id: 'editor-a', status: 'delivered' },
    { editor_user_id: 'editor-a', status: 'editing', archived_at: '2026-01-01T00:00:00Z' }
  ];
  const ranked = rankEditorCandidates({ profiles, users, tasks, services: ['photos', 'drone'] });
  assert.deepEqual(ranked.map(editor => [editor.userId, editor.workload]), [['editor-a', 0], ['editor-b', 2]]);
  assert.equal(ranked.some(editor => editor.userId === 'editor-c'), false, 'partial skill coverage must not auto-assign');
  const tied = rankEditorCandidates({ profiles, users, tasks: [], services: ['photos', 'drone'] });
  assert.deepEqual(tied.map(editor => editor.userId), ['editor-a', 'editor-b']);
});

test('atomic scheduling migration and API preserve the transactional boundary', async () => {
  assert.equal(isAtomicScheduleConflict(new Error('SQLSTATE 23P01 northlight_tasks_photographer_no_overlap')), true);
  assert.equal(isAtomicScheduleConflict(new Error('unrelated')), false);
  const migration = await readFile(new URL('../supabase/migrations/20260819210000_northlight_atomic_scheduling.sql', import.meta.url), 'utf8');
  const tasksApi = await readFile(new URL('../functions/api/tasks.js', import.meta.url), 'utf8');
  assert.match(migration, /exclude using gist[\s\S]*tstzrange[\s\S]*with &&/i);
  assert.match(migration, /create unique index[\s\S]*\(tenant_id, idempotency_key\)/i);
  assert.match(migration, /calendar_post_shoot_state_repaired/i);
  assert.match(migration, /northlight_select_editor[\s\S]*work\.status in \('raw_received', 'editing', 'review', 'revision'\)/i);
  assert.match(migration, /create or replace function public\.northlight_create_booking/i);
  assert.match(migration, /insert into public\.task_handoffs[\s\S]*array\['dropbox', 'calendar', 'email'\]/i);
  assert.match(migration, /insert into public\.task_events/i);
  assert.match(tasksApi, /rpc\/northlight_create_booking/);
  assert.doesNotMatch(tasksApi, /supa\(env,\s*['"]tasks['"],\s*\{\s*method:\s*['"]POST['"]/);
});

test.after(() => { globalThis.fetch = realFetch; });
