import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { accessToken, providerFailure, seal } from '../functions/_lib/core.js';

test('provider failures retain routing status and allowlisted code without provider bodies', () => {
  const payload = {
    error: 'invalid_grant',
    error_description: 'refresh token secret-refresh-value belonged to person@example.com',
    access_token: 'secret-access-value',
    nested: { tenant: 'private-tenant' }
  };
  const message = providerFailure('xero', 401, payload, 'refresh').message;
  assert.equal(message, 'xero_401_refresh_invalid_grant');
  assert.doesNotMatch(message, /secret|example\.com|private-tenant|description|access_token/i);

  const unknown = providerFailure('google', 500, { error: '<script>steal()</script>', raw: 'token' }).message;
  assert.equal(unknown, 'google_500');

  const hostileMarkers = providerFailure('google\r\nsecret', 'token', payload, 'refresh\r\nprivate');
  assert.equal(hostileMarkers.message, 'google_secret_0_refresh_private_invalid_grant');
  assert.equal(hostileMarkers.status, 0);
  assert.equal(hostileMarkers.providerCode, 'invalid_grant');
  assert.equal(JSON.stringify(hostileMarkers), '{}', 'safe routing metadata is not serialized into logs');
});

test('Xero request failures use the shared redaction boundary before sync logging', async () => {
  const source = await readFile(new URL('../functions/_lib/xero.js', import.meta.url), 'utf8');
  assert.match(source, /providerFailure\('xero',r\.status,d\)/);
  assert.doesNotMatch(source, /JSON\.stringify\(d\)/);
  assert.doesNotMatch(source, /d=\{raw:txt\}/);
});

test('shared Gmail failures never copy recipients or message content into sync logs', async () => {
  const source = await readFile(new URL('../functions/_lib/core.js', import.meta.url), 'utf8');
  const issueEmail = source.slice(source.indexOf('export async function issueEmail'));
  assert.doesNotMatch(issueEmail, /payload:\{to,subject\}/);
  assert.match(issueEmail, /event_type|email_failed|email/);
});

test('a non-JSON OAuth refresh body cannot enter the thrown error', async () => {
  const env = {
    SUPABASE_URL: 'https://db.test',
    SUPABASE_PUBLISHABLE_KEY: 'pk',
    NORTHLIGHT_DEMO_KEY: 'pilot',
    TOKEN_ENCRYPTION_KEY: 'encryption-secret',
    GOOGLE_WORKSPACE_CLIENT_ID: 'workspace-client',
    GOOGLE_WORKSPACE_CLIENT_SECRET: 'workspace-secret'
  };
  const refreshToken = await seal('private-refresh-token', env.TOKEN_ENCRYPTION_KEY);
  const row = {
    tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    provider: 'google',
    status: 'connected',
    refresh_generation: 4,
    metadata: { refresh_token: refreshToken, access_expires_at: 0 }
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const route = url.pathname.split('/').pop();
    if (url.origin === 'https://db.test') {
      if (route === 'tenants') return Response.json([{ id: row.tenant_id, slug: 'realcapture' }]);
      if (route === 'integration_state') return Response.json([row]);
      if (route === 'northlight_claim_integration_refresh') return Response.json({ claimed: true, ...row });
      if (route === 'northlight_release_integration_refresh') return Response.json({ released: true });
    }
    if (url.origin === 'https://oauth2.googleapis.com') {
      return new Response('private@example.test private-refresh-token', { status: 400 });
    }
    throw new Error(`unexpected fetch ${url} ${options.method || 'GET'}`);
  };
  try {
    await assert.rejects(accessToken(env, 'google'), exception => {
      assert.equal(exception.message, 'oauth_400_refresh');
      assert.doesNotMatch(`${exception.message} ${JSON.stringify(exception)}`, /private|example\.test|refresh-token/);
      return true;
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
