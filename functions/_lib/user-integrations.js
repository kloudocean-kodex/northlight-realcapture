import { providerFailure, seal, unseal, supa, tenant } from './core.js';
import { refreshWithLease, usableAccessToken } from './oauth-refresh.js';

async function formToken(url, params, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(params)
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) throw providerFailure('oauth', response.status, data, 'refresh');
  return data;
}

async function userOAuthMetadata(env, { access_token, refresh_token, expires_in, metadata = {} }) {
  if (!access_token) throw new Error('oauth_access_token_missing');
  const next = {
    ...metadata,
    access_token: await seal(access_token, env.TOKEN_ENCRYPTION_KEY),
    access_expires_at: Date.now() + Number(expires_in || 3600) * 1000 - 60000
  };
  if (refresh_token) next.refresh_token = await seal(refresh_token, env.TOKEN_ENCRYPTION_KEY);
  return next;
}

export async function userIntegration(env, userId, provider) {
  const currentTenant = await tenant(env);
  const rows = await supa(env, 'user_integrations', {
    query: `select=*&tenant_id=eq.${currentTenant.id}&user_id=eq.${encodeURIComponent(userId)}&provider=eq.${encodeURIComponent(provider)}&limit=1`
  });
  return rows?.[0] || null;
}

async function refreshUserGoogle(env, lease) {
  const refreshToken = await unseal(lease.metadata?.refresh_token, env.TOKEN_ENCRYPTION_KEY);
  if (!refreshToken) throw new Error('google_refresh_token_missing');
  const data = await formToken('https://oauth2.googleapis.com/token', {
    client_id: env.GOOGLE_CALENDAR_CLIENT_ID || env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CALENDAR_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });
  return { ...data, refresh_token: refreshToken };
}

export async function userAccessToken(env, userId, provider) {
  const current = await userIntegration(env, userId, provider);
  if (!current || current.status !== 'connected') throw new Error(`${provider}_not_connected`);
  const usable = await usableAccessToken(current, value => unseal(value, env.TOKEN_ENCRYPTION_KEY));
  if (usable) return usable;
  if (provider !== 'google') throw new Error(`${provider}_refresh_not_supported`);

  const currentTenant = await tenant(env);
  const owner = crypto.randomUUID();
  return refreshWithLease({
    current,
    decode: value => unseal(value, env.TOKEN_ENCRYPTION_KEY),
    claim: () => supa(env, 'rpc/northlight_claim_user_integration_refresh', {
      method: 'POST',
      payload: {
        p_tenant_id: currentTenant.id,
        p_user_id: userId,
        p_provider: provider,
        p_owner: owner,
        p_lease_seconds: 60
      }
    }),
    read: () => userIntegration(env, userId, provider),
    refreshProvider: lease => refreshUserGoogle(env, lease),
    finish: async (lease, token) => {
      const metadata = await userOAuthMetadata(env, {
        ...token,
        metadata: { ...(lease.metadata || {}) }
      });
      return supa(env, 'rpc/northlight_finish_user_integration_refresh', {
        method: 'POST',
        payload: {
          p_tenant_id: currentTenant.id,
          p_user_id: userId,
          p_provider: provider,
          p_owner: owner,
          p_generation: Number(lease.refresh_generation || 0),
          p_metadata: metadata
        }
      });
    },
    release: () => supa(env, 'rpc/northlight_release_user_integration_refresh', {
      method: 'POST',
      payload: {
        p_tenant_id: currentTenant.id,
        p_user_id: userId,
        p_provider: provider,
        p_owner: owner
      }
    })
  });
}

export async function userGoogleRequest(env, userId, path, options = {}) {
  const token = await userAccessToken(env, userId, 'google');
  const response = await fetch(`https://www.googleapis.com${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) throw providerFailure('google', response.status, data);
  return data;
}
