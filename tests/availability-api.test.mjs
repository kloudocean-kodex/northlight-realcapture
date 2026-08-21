import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSession } from '../functions/_lib/core.js';
import { onRequestGet, onRequestPatch } from '../functions/api/availability.js';

const realFetch = globalThis.fetch;
const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = '11111111-1111-4111-8111-111111111111';
const env = {
  SUPABASE_URL: 'https://db.test',
  SUPABASE_PUBLISHABLE_KEY: 'pk',
  NORTHLIGHT_DEMO_KEY: 'pilot',
  SESSION_SECRET: 'availability-session-secret'
};

afterEach(() => { globalThis.fetch = realFetch; });

async function request(method = 'GET', payload) {
  const token = await makeSession({ userId, role: 'photographer', authVersion: 0 }, env);
  return new Request('https://portal.test/api/availability', {
    method,
    headers: {
      cookie: `nl_session=${encodeURIComponent(token)}`,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin'
    },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
}

function install({ updateFailure = null } = {}) {
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const route = url.pathname.split('/').pop();
    const payload = options.body ? JSON.parse(options.body) : null;
    calls.push({ route, method: options.method || 'GET', payload });
    if (route === 'users') return Response.json([{ id: userId, role_code: 'photographer', name: 'Priya', email: 'priya@example.test', active: true, metadata: { auth_version: 0 } }]);
    if (route === 'tenants') return Response.json([{ id: tenantId, slug: 'realcapture' }]);
    if (route === 'provider_profiles') return Response.json([{ user_id: userId, working_hours: { mon: ['08:00', '17:00'] }, days_off: [], special_days: [], timezone: 'Australia/Melbourne', availability_version: 3 }]);
    if (route === 'northlight_photographer_onboarding_status') return Response.json({ bookable: true, blockers: [] });
    if (route === 'northlight_update_provider_availability') {
      if (updateFailure) return Response.json({ message: updateFailure }, { status: 400 });
      return Response.json({ user_id: userId, version: 4, working_hours: payload.p_working_hours, days_off: payload.p_days_off, special_days: payload.p_special_days, timezone: payload.p_timezone, updated_at: '2026-08-21T00:00:00.000Z' });
    }
    throw new Error(`unexpected request ${url}`);
  };
  return calls;
}

test('Photographer reads only their own canonical availability and onboarding readiness', async () => {
  install();
  const response = await onRequestGet({ request: await request(), env });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.profile.user_id, userId);
  assert.equal(data.profile.availability_version, 3);
  assert.equal(data.onboarding.bookable, true);
});

test('save normalizes input and binds actor, target, tenant and expected version server-side', async () => {
  const calls = install();
  const response = await onRequestPatch({ request: await request('PATCH', {
    expectedVersion: 3,
    workingHours: { fri: ['09:00', '15:00'], mon: ['08:00', '17:00'] },
    daysOff: ['2026-12-25'],
    specialDays: [{ date: '2026-12-24', hours: ['08:00', '12:00'] }],
    timeZone: 'Australia/Melbourne',
    userId: 'attacker-controlled-id'
  }), env });
  assert.equal(response.status, 200);
  const update = calls.find(call => call.route === 'northlight_update_provider_availability');
  assert.equal(update.payload.p_tenant_id, tenantId);
  assert.equal(update.payload.p_actor_user_id, userId);
  assert.equal(update.payload.p_user_id, userId);
  assert.equal(update.payload.p_expected_version, 3);
  assert.deepEqual(update.payload.p_working_hours, { mon: ['08:00', '17:00'], fri: ['09:00', '15:00'] });
});

test('invalid time, all-closed weeks and stale versions fail without a successful update', async () => {
  let calls = install();
  let response = await onRequestPatch({ request: await request('PATCH', { expectedVersion: 3, workingHours: { mon: ['17:00', '08:00'] }, daysOff: [], specialDays: [], timeZone: 'Australia/Melbourne' }), env });
  assert.equal(response.status, 400);
  assert.equal(calls.some(call => call.route === 'northlight_update_provider_availability'), false);

  calls = install({ updateFailure: 'availability_version_changed' });
  response = await onRequestPatch({ request: await request('PATCH', { expectedVersion: 3, workingHours: { mon: ['08:00', '17:00'] }, daysOff: [], specialDays: [], timeZone: 'Australia/Melbourne' }), env });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /changed/i);
});
