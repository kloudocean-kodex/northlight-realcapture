import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSession, providerFailure, seal, unseal } from '../functions/_lib/core.js';
import { onRequestGet as startSharedOAuth } from '../functions/api/oauth/[provider]/start.js';
import { onRequestGet as startCalendarOAuth } from '../functions/api/calendar/connect.js';
import {
  beginOAuthAuthorization,
  consumeOAuthAuthorization,
  createPkcePair,
  oauthOrigin,
  safeReturnPath,
  sha256Hex
} from '../functions/_lib/oauth-security.js';
import {
  buildProviderAuthorizationUrl,
  commitSharedOAuth,
  disconnectSharedOAuth,
  disconnectUserGoogleOAuth,
  exchangeAuthorizationCode,
  verifySharedOAuthConnection,
  xeroAccount
} from '../functions/_lib/oauth-lifecycle.js';

const realFetch = globalThis.fetch;
const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actorId = '11111111-1111-4111-8111-111111111111';
const canonicalOrigin = 'https://portal.example.test';
const env = {
  PUBLIC_ORIGIN: canonicalOrigin,
  SUPABASE_URL: 'https://db.test',
  SUPABASE_PUBLISHABLE_KEY: 'pk',
  NORTHLIGHT_DEMO_KEY: 'pilot',
  TOKEN_ENCRYPTION_KEY: 'test-encryption-secret',
  GOOGLE_WORKSPACE_CLIENT_ID: 'workspace-client',
  GOOGLE_WORKSPACE_CLIENT_SECRET: 'workspace-secret',
  GOOGLE_CALENDAR_CLIENT_ID: 'calendar-client',
  GOOGLE_CALENDAR_CLIENT_SECRET: 'calendar-secret',
  DROPBOX_APP_KEY: 'dropbox-key',
  DROPBOX_APP_SECRET: 'dropbox-secret',
  XERO_CLIENT_ID: 'xero-client',
  XERO_CLIENT_SECRET: 'xero-secret',
  SESSION_SECRET: 'session-secret'
};

afterEach(() => { globalThis.fetch = realFetch; });

function json(data, status = 200) {
  return Response.json(data, { status });
}

test('return targets and canonical OAuth origin fail closed', () => {
  assert.equal(safeReturnPath('/?view=integrations#x'), '/?view=integrations#x');
  for (const unsafe of [
    'https://evil.test/',
    '//evil.test/path',
    '/\\evil',
    '/oauth/google/callback',
    '/api/calendar/connect',
    '/ok\r\nset-cookie:bad=1'
  ]) assert.equal(safeReturnPath(unsafe), '/');

  assert.equal(oauthOrigin(new Request(`${canonicalOrigin}/api/oauth/google/start`), env), canonicalOrigin);
  assert.throws(
    () => oauthOrigin(new Request('https://spoofed-host.test/api/oauth/google/start'), env),
    /oauth_origin_mismatch/
  );
  assert.throws(
    () => oauthOrigin(new Request(`${canonicalOrigin}/api/oauth/google/start`), { ...env, PUBLIC_ORIGIN: '' }),
    /oauth_canonical_origin_missing/
  );
});

test('OAuth state refuses to run without server-side token encryption', async () => {
  await assert.rejects(beginOAuthAuthorization({ ...env, TOKEN_ENCRYPTION_KEY: '' }, {
    request: new Request(`${canonicalOrigin}/api/oauth/google/start`),
    provider: 'google',
    actorUserId: actorId,
    returnPath: '/'
  }), /oauth_token_encryption_not_configured/);
});

test('OAuth start routes enforce live roles and reject a spoofed request host before state creation', async () => {
  const users = new Map([
    ['owner-user', { id: 'owner-user', role_code: 'owner', active: true, metadata: { auth_version: 0 } }],
    ['photographer-user', { id: 'photographer-user', role_code: 'photographer', active: true, metadata: { auth_version: 0 } }]
  ]);
  let stateCreations = 0;
  let persisted = null;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://db.test') throw new Error(`unexpected fetch ${url}`);
    const route = url.pathname.split('/').pop();
    if (route === 'users') {
      const id = /id=eq\.([^&]+)/.exec(decodeURIComponent(url.search))?.[1];
      return json(users.has(id) ? [users.get(id)] : []);
    }
    if (route === 'tenants') return json([{ id: tenantId, slug: 'realcapture' }]);
    if (route === 'northlight_begin_oauth_state') {
      stateCreations += 1;
      persisted = JSON.parse(options.body);
      return json({ id: 'state-row', expires_at: persisted.p_expires_at });
    }
    throw new Error(`unexpected database route ${route}`);
  };
  const ownerSession = await makeSession({ userId: 'owner-user', authVersion: 0 }, env);
  const photographerSession = await makeSession({ userId: 'photographer-user', authVersion: 0 }, env);

  const started = await startSharedOAuth({
    request: new Request(`${canonicalOrigin}/api/oauth/google/start?return_to=%2F%3Fview%3Dintegrations`, {
      headers: { cookie: `nl_session=${encodeURIComponent(ownerSession)}` }
    }),
    env,
    params: { provider: 'google' }
  });
  assert.equal(started.status, 302);
  const providerUrl = new URL(started.headers.get('location'));
  assert.equal(providerUrl.origin, 'https://accounts.google.com');
  assert.match(providerUrl.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
  assert.match(providerUrl.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(persisted.p_return_path, '/?view=integrations');
  assert.match(started.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);

  const wrongSharedRole = await startSharedOAuth({
    request: new Request(`${canonicalOrigin}/api/oauth/google/start`, {
      headers: { cookie: `nl_session=${encodeURIComponent(photographerSession)}` }
    }),
    env,
    params: { provider: 'google' }
  });
  assert.equal(wrongSharedRole.status, 403);

  const wrongCalendarRole = await startCalendarOAuth({
    request: new Request(`${canonicalOrigin}/api/calendar/connect`, {
      headers: { cookie: `nl_session=${encodeURIComponent(ownerSession)}` }
    }),
    env
  });
  assert.equal(wrongCalendarRole.status, 403);

  const beforeSpoof = stateCreations;
  const spoofed = await startSharedOAuth({
    request: new Request('https://spoofed-host.test/api/oauth/google/start', {
      headers: { cookie: `nl_session=${encodeURIComponent(ownerSession)}` }
    }),
    env,
    params: { provider: 'google' }
  });
  assert.equal(spoofed.status, 409);
  assert.equal(spoofed.headers.has('location'), false);
  assert.equal(stateCreations, beforeSpoof, 'host spoofing must fail before durable OAuth state is created');
});

test('PKCE uses an RFC 7636 verifier and S256 challenge', async () => {
  const pair = await createPkcePair();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.match(pair.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(pair.challenge, pair.verifier);
});

test('OAuth state is hashed, browser-bound, expiring and consumed exactly once', async () => {
  let pending = null;
  let consumed = false;
  let consumeCalls = 0;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const route = url.pathname.split('/').pop();
    if (url.origin !== 'https://db.test') throw new Error(`unexpected fetch ${url}`);
    if (route === 'tenants') return json([{ id: tenantId, slug: 'realcapture' }]);
    const payload = JSON.parse(options.body || '{}');
    if (route === 'northlight_begin_oauth_state') {
      pending = payload;
      return json({ id: '22222222-2222-4222-8222-222222222222', expires_at: payload.p_expires_at });
    }
    if (route === 'northlight_consume_oauth_state') {
      consumeCalls += 1;
      if (consumed || payload.p_state_hash !== pending.p_state_hash) return json(null);
      consumed = true;
      return json({
        id: '22222222-2222-4222-8222-222222222222',
        return_path: pending.p_return_path,
        pkce_verifier_ciphertext: pending.p_pkce_verifier_ciphertext,
        connection_generation: 7,
        expires_at: pending.p_expires_at
      });
    }
    throw new Error(`unexpected database route ${route}`);
  };

  const startRequest = new Request(`${canonicalOrigin}/api/oauth/google/start?return_to=https://evil.test`);
  const authorization = await beginOAuthAuthorization(env, {
    request: startRequest,
    provider: 'google',
    actorUserId: actorId,
    returnPath: 'https://evil.test/steal'
  });
  assert.match(authorization.state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(pending.p_state_hash, await sha256Hex(authorization.state));
  assert.match(pending.p_state_hash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(pending).includes(authorization.state), false, 'raw state is never persisted');
  assert.equal(pending.p_return_path, '/');
  assert.ok(new Date(pending.p_expires_at).getTime() > Date.now());
  const verifier = await unseal(pending.p_pkce_verifier_ciphertext, env.TOKEN_ENCRYPTION_KEY);
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(JSON.stringify(pending).includes(verifier), false, 'raw PKCE verifier is never persisted');

  const cookiePair = authorization.cookie.split(';', 1)[0];
  const callbackRequest = new Request(`${canonicalOrigin}/oauth/google/callback`, {
    headers: { cookie: cookiePair }
  });
  const winner = await consumeOAuthAuthorization(env, {
    request: callbackRequest,
    provider: 'google',
    actorUserId: actorId,
    state: authorization.state
  });
  assert.equal(winner.connectionGeneration, 7);
  assert.equal(winner.codeVerifier, verifier);
  assert.equal(winner.returnPath, '/');

  await assert.rejects(
    consumeOAuthAuthorization(env, {
      request: callbackRequest,
      provider: 'google',
      actorUserId: actorId,
      state: authorization.state
    }),
    /oauth_state_spent_or_expired/
  );
  assert.equal(consumeCalls, 2);

  const callsBeforeMismatch = consumeCalls;
  await assert.rejects(
    consumeOAuthAuthorization(env, {
      request: new Request(`${canonicalOrigin}/oauth/google/callback`, {
        headers: { cookie: 'nl_oauth_google=wrong-browser-state' }
      }),
      provider: 'google',
      actorUserId: actorId,
      state: authorization.state
    }),
    /oauth_state_browser_mismatch/
  );
  assert.equal(consumeCalls, callsBeforeMismatch, 'a request without the initiating browser cookie cannot burn state');
});

test('authorization URLs request only the capabilities Northlight actually uses', () => {
  const challenge = 'a'.repeat(43);
  const google = new URL(buildProviderAuthorizationUrl(env, {
    provider: 'google', origin: canonicalOrigin, state: 's', codeChallenge: challenge
  }));
  assert.equal(google.searchParams.get('client_id'), 'workspace-client');
  assert.equal(google.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(google.searchParams.has('include_granted_scopes'), false);
  assert.deepEqual(new Set(google.searchParams.get('scope').split(' ')), new Set([
    'openid', 'email', 'https://www.googleapis.com/auth/gmail.compose'
  ]));

  const calendar = new URL(buildProviderAuthorizationUrl(env, {
    provider: 'google-user', origin: canonicalOrigin, state: 's', codeChallenge: challenge
  }));
  const calendarScopes = new Set(calendar.searchParams.get('scope').split(' '));
  assert.equal(calendar.searchParams.get('client_id'), 'calendar-client');
  assert.equal(calendarScopes.has('https://www.googleapis.com/auth/calendar'), false);
  assert.deepEqual(calendarScopes, new Set([
    'openid',
    'email',
    'https://www.googleapis.com/auth/calendar.events.owned',
    'https://www.googleapis.com/auth/calendar.freebusy'
  ]));

  const dropbox = new URL(buildProviderAuthorizationUrl(env, {
    provider: 'dropbox', origin: canonicalOrigin, state: 's', codeChallenge: challenge
  }));
  assert.deepEqual(new Set(dropbox.searchParams.get('scope').split(' ')), new Set([
    'account_info.read', 'files.metadata.read', 'files.content.read', 'files.content.write'
  ]));

  const xero = new URL(buildProviderAuthorizationUrl(env, {
    provider: 'xero', origin: canonicalOrigin, state: 's', codeChallenge: null
  }));
  assert.deepEqual(new Set(xero.searchParams.get('scope').split(' ')), new Set([
    'accounting.invoices', 'accounting.contacts', 'offline_access'
  ]));
  assert.equal(xero.searchParams.get('scope').includes('accounting.transactions'), false);
  assert.equal(xero.searchParams.get('scope').includes('email'), false);
});

test('authorization-code exchange is PKCE-bound and refuses partial Google grants', async () => {
  let tokenForm;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://oauth2.googleapis.com');
    tokenForm = new URLSearchParams(options.body);
    return json({
      access_token: 'fresh-access',
      refresh_token: 'fresh-refresh',
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.compose'
    });
  };
  const token = await exchangeAuthorizationCode(env, {
    provider: 'google',
    origin: canonicalOrigin,
    code: 'authorization-code',
    codeVerifier: 'v'.repeat(43)
  });
  assert.equal(token.access_token, 'fresh-access');
  assert.equal(tokenForm.get('code_verifier'), 'v'.repeat(43));
  assert.equal(tokenForm.get('client_id'), 'workspace-client');
  assert.equal(tokenForm.get('client_secret'), 'workspace-secret');

  globalThis.fetch = async () => json({
    access_token: 'calendar-access',
    refresh_token: 'calendar-refresh',
    expires_in: 3600,
    scope: 'openid email https://www.googleapis.com/auth/calendar.events.owned'
  });
  await assert.rejects(exchangeAuthorizationCode(env, {
    provider: 'google-user',
    origin: canonicalOrigin,
    code: 'authorization-code',
    codeVerifier: 'v'.repeat(43)
  }), /oauth_required_scope_missing/);
});

test('provider failures preserve status markers but cannot carry response secrets into errors', async () => {
  const malicious = {
    error: 'ACCESS_TOKEN_super_secret_123456789',
    error_description: 'refresh_token=should-never-appear',
    email: 'private@example.test',
    tenantId: 'private-tenant'
  };
  const direct = providerFailure('google', 410, malicious, 'refresh');
  assert.equal(direct.message, 'google_410_refresh');
  assert.equal(JSON.stringify(direct).includes('secret'), false);

  globalThis.fetch = async () => json(malicious, 400);
  let thrown;
  try {
    await exchangeAuthorizationCode(env, {
      provider: 'google',
      origin: canonicalOrigin,
      code: 'authorization-code',
      codeVerifier: 'v'.repeat(43)
    });
  } catch (exception) {
    thrown = exception;
  }
  assert.equal(thrown.message, 'google_400_token_exchange');
  assert.equal(thrown.providerCode, null);
  const serialized = `${thrown.message} ${JSON.stringify(thrown)}`;
  for (const forbidden of ['super_secret', 'refresh_token', 'private@example', 'private-tenant']) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('OAuth callback commit is generation-checked and stores only encrypted credentials', async () => {
  let row = {
    tenant_id: tenantId,
    provider: 'google',
    status: 'connected',
    account_label: 'ops@example.test',
    refresh_generation: 9,
    metadata: { google_sub: 'google-account-1', email: 'ops@example.test', operational_marker: 'keep' }
  };
  let patchQuery = null;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const route = url.pathname.split('/').pop();
    if (url.origin !== 'https://db.test') throw new Error(`unexpected fetch ${url}`);
    if (route === 'tenants') return json([{ id: tenantId, slug: 'realcapture' }]);
    if (route === 'integration_state' && (options.method || 'GET') === 'GET') return json([row]);
    if (route === 'integration_state' && options.method === 'PATCH') {
      patchQuery = url.search;
      const payload = JSON.parse(options.body);
      row = { ...row, ...payload };
      return json([row]);
    }
    throw new Error(`unexpected database route ${route}`);
  };
  const committed = await commitSharedOAuth(env, {
    provider: 'google',
    token: {
      access_token: 'raw-access-secret',
      refresh_token: 'raw-refresh-secret',
      expires_in: 3600,
      token_type: 'Bearer',
      grantedScopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.compose']
    },
    account: { id: 'google-account-1', email: 'ops@example.test', label: 'ops@example.test' },
    actorUserId: actorId,
    expectedGeneration: 9
  });
  assert.match(patchQuery, /refresh_generation=eq\.9/);
  assert.match(patchQuery, /status=neq\.disconnecting/);
  assert.equal(committed.refresh_generation, 10);
  assert.equal(committed.metadata.operational_marker, 'keep');
  assert.notEqual(committed.metadata.access_token, 'raw-access-secret');
  assert.notEqual(committed.metadata.refresh_token, 'raw-refresh-secret');
  assert.equal(await unseal(committed.metadata.access_token, env.TOKEN_ENCRYPTION_KEY), 'raw-access-secret');
  assert.equal(await unseal(committed.metadata.refresh_token, env.TOKEN_ENCRYPTION_KEY), 'raw-refresh-secret');

  await assert.rejects(commitSharedOAuth(env, {
    provider: 'google',
    token: {
      access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600, grantedScopes: []
    },
    account: { id: 'google-account-1', email: 'ops@example.test', label: 'ops@example.test' },
    actorUserId: actorId,
    expectedGeneration: 9
  }), /oauth_connection_generation_changed/);
});

test('integration verification cannot resurrect a connection fenced by concurrent disconnect', async () => {
  const accessCiphertext = await seal('workspace-access-secret', env.TOKEN_ENCRYPTION_KEY);
  const row = {
    tenant_id: tenantId,
    provider: 'google',
    status: 'connected',
    account_label: 'ops@example.test',
    refresh_generation: 12,
    metadata: {
      access_token: accessCiphertext,
      access_expires_at: Date.now() + 3600000,
      google_sub: 'google-account-1',
      email: 'ops@example.test'
    }
  };
  let verificationQuery = null;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const route = url.pathname.split('/').pop();
    if (url.origin === 'https://db.test') {
      if (route === 'tenants') return json([{ id: tenantId, slug: 'realcapture' }]);
      if (route === 'integration_state' && (options.method || 'GET') === 'GET') return json([row]);
      if (route === 'integration_state' && options.method === 'PATCH') {
        verificationQuery = decodeURIComponent(url.search);
        return json([]);
      }
    }
    if (url.origin === 'https://www.googleapis.com') {
      return json({ id: 'google-account-1', email: 'ops@example.test', verified_email: true });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  await assert.rejects(verifySharedOAuthConnection(env, 'google'), /oauth_connection_generation_changed/);
  assert.match(verificationQuery, /status=eq\.connected/);
  assert.match(verificationQuery, /refresh_generation=eq\.12/);
});

test('Xero reconnect and verification select only the already-bound organisation', async () => {
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    assert.equal(url.href, 'https://api.xero.com/connections');
    assert.equal(options.headers.authorization, 'Bearer xero-access');
    return json([
      { id: 'connection-a', tenantId: 'tenant-a', tenantName: 'Organisation A' },
      { id: 'connection-b', tenantId: 'tenant-b', tenantName: 'Organisation B' }
    ]);
  };
  const account = await xeroAccount({ ...env, XERO_TENANT_ID: '' }, 'xero-access', 'tenant-b');
  assert.deepEqual(account, {
    id: 'tenant-b',
    connectionId: 'connection-b',
    tenantType: null,
    label: 'Organisation B'
  });
  await assert.rejects(xeroAccount({ ...env, XERO_TENANT_ID: '' }, 'xero-access'), /xero_tenant_selection_required/);
});

test('disconnect fences the generation before provider revocation and erases credentials only after confirmation', async () => {
  const refreshCiphertext = await seal('google-refresh-secret', env.TOKEN_ENCRYPTION_KEY);
  let row = {
    tenant_id: tenantId,
    provider: 'google',
    status: 'connected',
    account_label: 'ops@example.test',
    refresh_generation: 4,
    metadata: { refresh_token: refreshCiphertext, google_sub: 'google-account-1' }
  };
  const order = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const route = url.pathname.split('/').pop();
    if (url.origin === 'https://db.test') {
      if (route === 'tenants') return json([{ id: tenantId, slug: 'realcapture' }]);
      if (route === 'integration_state' && (options.method || 'GET') === 'GET') return json([row]);
      if (route === 'integration_state' && options.method === 'PATCH') {
        const payload = JSON.parse(options.body);
        order.push(`database:${payload.status}`);
        row = { ...row, ...payload };
        return json([row]);
      }
    }
    if (url.origin === 'https://oauth2.googleapis.com' && route === 'revoke') {
      order.push('provider:revoke');
      assert.equal(new URLSearchParams(options.body).get('token'), 'google-refresh-secret');
      assert.equal(row.status, 'disconnecting');
      assert.equal(row.refresh_generation, 5);
      return json({});
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const result = await disconnectSharedOAuth(env, 'google', actorId);
  assert.equal(result.alreadyDisconnected, false);
  assert.deepEqual(order, ['database:disconnecting', 'provider:revoke', 'database:not_connected']);
  assert.equal(row.status, 'not_connected');
  assert.equal(row.account_label, null);
  assert.equal(row.metadata.refresh_token, undefined);
  assert.equal(row.metadata.provider_revoked, true);
  assert.equal(row.refresh_generation, 5);
});

test('a failed provider revocation leaves the credential fenced for a safe retry', async () => {
  const refreshCiphertext = await seal('google-refresh-secret', env.TOKEN_ENCRYPTION_KEY);
  let row = {
    tenant_id: tenantId,
    provider: 'google',
    status: 'connected',
    refresh_generation: 2,
    metadata: { refresh_token: refreshCiphertext }
  };
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const route = url.pathname.split('/').pop();
    if (url.origin === 'https://db.test') {
      if (route === 'tenants') return json([{ id: tenantId, slug: 'realcapture' }]);
      if (route === 'integration_state' && (options.method || 'GET') === 'GET') return json([row]);
      if (route === 'integration_state' && options.method === 'PATCH') {
        const payload = JSON.parse(options.body);
        row = { ...row, ...payload };
        return json([row]);
      }
    }
    if (url.origin === 'https://oauth2.googleapis.com') {
      return json({ error: 'server_error', error_description: 'refresh_token=private' }, 503);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  await assert.rejects(disconnectSharedOAuth(env, 'google', actorId), /google_503_revocation/);
  assert.equal(row.status, 'disconnecting');
  assert.equal(row.refresh_generation, 3);
  assert.ok(row.metadata.refresh_token, 'credential remains encrypted for a revocation retry');
});

test('personal Calendar disconnect atomically invalidates channels before provider cleanup', async () => {
  const accessCiphertext = await seal('calendar-access-secret', env.TOKEN_ENCRYPTION_KEY);
  const refreshCiphertext = await seal('calendar-refresh-secret', env.TOKEN_ENCRYPTION_KEY);
  let row = {
    tenant_id: tenantId,
    user_id: actorId,
    provider: 'google',
    status: 'connected',
    refresh_generation: 8,
    metadata: {
      access_token: accessCiphertext,
      access_expires_at: Date.now() + 3600000,
      refresh_token: refreshCiphertext
    }
  };
  const order = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const route = url.pathname.split('/').pop();
    if (url.origin === 'https://db.test') {
      if (route === 'tenants') return json([{ id: tenantId, slug: 'realcapture' }]);
      if (route === 'user_integrations' && (options.method || 'GET') === 'GET') return json([row]);
      if (route === 'user_integrations' && options.method === 'PATCH') {
        const payload = JSON.parse(options.body);
        order.push(`database:${payload.status}`);
        row = { ...row, ...payload };
        return json([row]);
      }
      if (route === 'northlight_disconnect_calendar_watch') {
        const payload = JSON.parse(options.body);
        order.push('database:invalidate-channels');
        assert.equal(row.status, 'disconnecting');
        assert.equal(payload.p_connection_generation, 9);
        return json({
          disconnected: true,
          channels: [{ channel_id: 'channel-1', resource_id: 'resource-1' }]
        });
      }
    }
    if (url.origin === 'https://www.googleapis.com' && route === 'stop') {
      order.push('provider:stop-channel');
      assert.deepEqual(JSON.parse(options.body), { id: 'channel-1', resourceId: 'resource-1' });
      assert.equal(options.headers.authorization, 'Bearer calendar-access-secret');
      return json({});
    }
    if (url.origin === 'https://oauth2.googleapis.com' && route === 'revoke') {
      order.push('provider:revoke');
      assert.equal(new URLSearchParams(options.body).get('token'), 'calendar-refresh-secret');
      return json({});
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const result = await disconnectUserGoogleOAuth(env, actorId);
  assert.equal(result.alreadyDisconnected, false);
  assert.deepEqual(order, [
    'database:disconnecting',
    'database:invalidate-channels',
    'provider:stop-channel',
    'provider:revoke',
    'database:not_connected'
  ]);
  assert.equal(row.status, 'not_connected');
  assert.equal(row.metadata.refresh_token, undefined);
});
