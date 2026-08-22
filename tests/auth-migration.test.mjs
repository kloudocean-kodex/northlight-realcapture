import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { hashPBKDF2 } from '../functions/_lib/password.js';
import { makeSession, requireSession, verifyPBKDF2 } from '../functions/_lib/core.js';
import { onRequestPost as login } from '../functions/api/auth/login.js';
import { onRequestPost as changePassword } from '../functions/api/auth/change-password.js';

const realFetch = globalThis.fetch;
const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = '11111111-1111-4111-8111-111111111111';
const env = {
  SUPABASE_URL: 'https://db.test',
  SUPABASE_PUBLISHABLE_KEY: 'pk',
  NORTHLIGHT_DEMO_KEY: 'pilot',
  SESSION_SECRET: 'auth-migration-session-secret',
  PILOT_LOGIN_PASSWORD: 'Northlight temporary pilot 2026'
};

afterEach(() => { globalThis.fetch = realFetch; });

function routeOf(input) {
  return new URL(String(input)).pathname.split('/').pop();
}

function loginRequest(password = 'Northlight personal password 2026') {
  return new Request('https://portal.test/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ email: 'priya@example.test', password })
  });
}

async function signedRequest(path, session = {}) {
  const token = await makeSession({
    userId,
    role: 'photographer',
    authVersion: 0,
    credentialVersion: 3,
    ...session
  }, env);
  return new Request(`https://portal.test${path}`, {
    method: path.includes('change-password') ? 'POST' : 'GET',
    headers: {
      cookie: `nl_session=${encodeURIComponent(token)}`,
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin'
    },
    body: path.includes('change-password')
      ? JSON.stringify({ currentPassword: env.PILOT_LOGIN_PASSWORD, newPassword: 'My personal Northlight password 2026' })
      : undefined
  });
}

test('per-user PBKDF2 passwords verify correctly and reject another password', async () => {
  const hash = await hashPBKDF2('Northlight personal password 2026');
  assert.match(hash, /^pbkdf2cf\$100000\$3\$/);
  assert.equal(await verifyPBKDF2('Northlight personal password 2026', hash), true);
  assert.equal(await verifyPBKDF2('different password', hash), false);
});

test('login atomically counts before verification, resets only on success, and carries credential gates', async () => {
  const calls = [];
  const hash = await hashPBKDF2('Northlight personal password 2026');
  globalThis.fetch = async (input, options = {}) => {
    const route = routeOf(input);
    calls.push({ route, payload: options.body ? JSON.parse(options.body) : null });
    if (route === 'northlight_begin_login_attempt') {
      return Response.json({ allowed: true, failure_count: 1, blocked_until: null });
    }
    if (route === 'users') {
      return Response.json([{
        id: userId,
        role_code: 'photographer',
        name: 'Priya',
        email: 'priya@example.test',
        password_hash: hash,
        active: true,
        metadata: { auth_version: 2 },
        auth_must_change_password: true,
        credential_version: 7
      }]);
    }
    if (route === 'northlight_reset_login_attempt') return Response.json({ reset: true, existed: true });
    if (route === 'roles') return Response.json([{ name: 'Photographer' }]);
    throw new Error(`unexpected request ${input}`);
  };

  const response = await login({ request: loginRequest(), env });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.session.mustChangePassword, true);
  assert.equal(data.session.credentialVersion, 7);
  assert.match(response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  assert.deepEqual(calls.map(call => call.route), [
    'northlight_begin_login_attempt',
    'users',
    'northlight_reset_login_attempt',
    'roles'
  ]);
  assert.match(calls[0].payload.p_login_key, /^[0-9a-f]{64}$/);
  assert.equal(calls[0].payload.p_threshold, 5);
});

test('blocked and threshold-failing logins return 429 without issuing or resetting a session', async () => {
  let userReads = 0;
  globalThis.fetch = async input => {
    const route = routeOf(input);
    if (route === 'northlight_begin_login_attempt') {
      return Response.json({ allowed: false, failure_count: 5, blocked_until: '2099-01-01T00:00:00.000Z' });
    }
    if (route === 'users') userReads++;
    throw new Error('blocked login must stop before user lookup');
  };
  let response = await login({ request: loginRequest('wrong password'), env });
  assert.equal(response.status, 429);
  assert.equal(userReads, 0);
  assert.equal(response.headers.has('set-cookie'), false);

  const hash = await hashPBKDF2('correct password 2026');
  const calls = [];
  globalThis.fetch = async input => {
    const route = routeOf(input);
    calls.push(route);
    if (route === 'northlight_begin_login_attempt') {
      return Response.json({ allowed: true, failure_count: 5, blocked_until: '2099-01-01T00:00:00.000Z' });
    }
    if (route === 'users') {
      return Response.json([{ id: userId, password_hash: hash, active: true }]);
    }
    throw new Error(`unexpected request ${input}`);
  };
  response = await login({ request: loginRequest('still wrong'), env });
  assert.equal(response.status, 429);
  assert.equal(calls.includes('northlight_reset_login_attempt'), false);
  assert.equal(response.headers.has('set-cookie'), false);
});

test('session validation enforces credential version and blocks every normal API until migration', async () => {
  globalThis.fetch = async input => {
    if (routeOf(input) !== 'users') throw new Error(`unexpected request ${input}`);
    return Response.json([{
      id: userId,
      role_code: 'photographer',
      name: 'Priya',
      email: 'priya@example.test',
      active: true,
      metadata: { auth_version: 0 },
      auth_must_change_password: true,
      credential_version: 3
    }]);
  };
  const request = await signedRequest('/api/availability');
  const blocked = await requireSession(request, env);
  assert.equal(blocked.error.status, 428);
  assert.deepEqual(await blocked.error.json(), {
    error: 'password_change_required',
    detail: { code: 'PASSWORD_CHANGE_REQUIRED' }
  });
  const allowed = await requireSession(request, env, [], { allowPasswordMigration: true });
  assert.equal(allowed.session.mustChangePassword, true);

  const stale = await requireSession(await signedRequest('/api/availability', { credentialVersion: 2 }), env, [], { allowPasswordMigration: true });
  assert.equal(stale.error.status, 401);
});

test('password migration verifies the legacy bootstrap credential and commits through one CAS RPC', async () => {
  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const route = routeOf(input);
    const payload = options.body ? JSON.parse(options.body) : null;
    calls.push({ route, payload });
    if (route === 'users') {
      return Response.json([{
        id: userId,
        tenant_id: tenantId,
        role_code: 'photographer',
        name: 'Priya',
        email: 'priya@example.test',
        password_hash: 'scrypt$legacy-placeholder',
        active: true,
        metadata: { auth_version: 0 },
        auth_must_change_password: true,
        credential_version: 3
      }]);
    }
    if (route === 'tenants') return Response.json([{ id: tenantId, slug: 'realcapture' }]);
    if (route === 'northlight_complete_password_migration') {
      return Response.json({ ok: true, must_change_password: false, credential_version: 4, auth_version: 1 });
    }
    if (route === 'task_events') return Response.json(null);
    throw new Error(`unexpected request ${input}`);
  };

  const response = await changePassword({ request: await signedRequest('/api/auth/change-password'), env });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  const migration = calls.find(call => call.route === 'northlight_complete_password_migration');
  assert.equal(migration.payload.p_tenant_id, tenantId);
  assert.equal(migration.payload.p_user_id, userId);
  assert.equal(migration.payload.p_expected_password_hash, 'scrypt$legacy-placeholder');
  assert.match(migration.payload.p_new_password_hash, /^pbkdf2cf\$100000\$3\$/);
  assert.equal(calls.filter(call => call.route === 'northlight_complete_password_migration').length, 1);
});

test('forced credential setup is non-dismissible, skips bootstrap, and puts Calendar next for Photographers', async () => {
  const app = await readFile(new URL('../assets/app-v2.js', import.meta.url), 'utf8');
  const core = await readFile(new URL('../functions/_lib/core.js', import.meta.url), 'utf8');
  const sessionEndpoint = await readFile(new URL('../functions/api/auth/session.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../assets/design-system.css', import.meta.url), 'utf8');
  assert.match(app, /state\.session\.mustChangePassword===true/);
  assert.match(app, /id="requiredPasswordForm"/);
  assert.match(app, /This required step cannot be skipped/);
  assert.match(app, /Next: connect Google Calendar/);
  assert.match(app, /state\.session\.mustChangePassword!==true\)\{await bootstrap/);
  assert.match(core, /auth_must_change_password,credential_version/);
  assert.match(core, /PASSWORD_CHANGE_REQUIRED/);
  assert.match(core, /credentialVersion/);
  assert.match(sessionEndpoint, /allowPasswordMigration:true/);
  assert.match(css, /Required credential migration is a dedicated, non-dismissible first step/);
});

test('database migration owns atomic limiter and credential transition contracts', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260821142600_northlight_auth_rate_and_credential_migration.sql', import.meta.url), 'utf8');
  const cloudflareKdf = await readFile(new URL('../supabase/migrations/20260822150627_northlight_cloudflare_password_kdf.sql', import.meta.url), 'utf8');
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /northlight_begin_login_attempt/);
  assert.match(sql, /northlight_reset_login_attempt/);
  assert.match(sql, /auth_must_change_password boolean not null default true/);
  assert.match(sql, /credential_version bigint not null default 0/);
  assert.match(sql, /northlight_complete_password_migration/);
  assert.match(cloudflareKdf, /pbkdf2cf/);
  assert.match(sql, /password_hash is distinct from p_expected_password_hash/);
  assert.match(cloudflareKdf, /auth_must_change_password = false/);
});

test('every migrated role keeps an optional password-change control after onboarding', async () => {
  const ux = await readFile(new URL('../assets/ux-runtime.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../assets/runtime.css', import.meta.url), 'utf8');
  const adminUsers = await readFile(new URL('../functions/api/admin/users.js', import.meta.url), 'utf8');
  const app = await readFile(new URL('../assets/app-v2.js', import.meta.url), 'utf8');
  assert.match(adminUsers, /auth_must_change_password:false/);
  assert.match(adminUsers, /password_scheme:'pbkdf2cf'/);
  assert.match(adminUsers, /Starter password must be at least 12 characters/);
  assert.doesNotMatch(adminUsers, /Temporary password must be at least 12 characters/);
  assert.match(app, /Starter password/);
  assert.match(app, /signs the team member straight in/);
  assert.match(ux, /btn\.id='changePasswordBtn'/);
  assert.match(ux, /aria-label','Change password'/);
  assert.match(ux, /\/api\/auth\/change-password/);
  assert.match(ux, /Passwords do not match/);
  assert.match(css, /@media\(max-width:560px\)/);
});
