import {
  accessToken,
  integration,
  providerFailure,
  seal,
  supa,
  tenant,
  unseal
} from './core.js';
import { userAccessToken, userIntegration } from './user-integrations.js';
import { OAUTH_SCOPES, requireGrantedScopes } from './oauth-security.js';

const REQUEST_TIMEOUT_MS = 15000;
const PKCE_PROVIDERS = new Set(['google', 'google-user', 'dropbox']);
async function providerFetch(provider, stage, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!response.ok) throw providerFailure(provider, response.status, data, stage);
  return { response, data };
}

function googleCredentials(env, provider) {
  const calendar = provider === 'google-user';
  const clientId = calendar
    ? env.GOOGLE_CALENDAR_CLIENT_ID || env.GOOGLE_CLIENT_ID
    : env.GOOGLE_WORKSPACE_CLIENT_ID || env.GOOGLE_CLIENT_ID;
  const clientSecret = calendar
    ? env.GOOGLE_CALENDAR_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET
    : env.GOOGLE_WORKSPACE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error(`${provider}_oauth_not_configured`);
  return { clientId, clientSecret };
}

export function oauthRedirectUri(origin, provider) {
  const path = provider === 'google-user' ? 'google-user' : provider;
  return `${origin}/oauth/${path}/callback`;
}

export function buildProviderAuthorizationUrl(env, {
  provider,
  origin,
  state,
  codeChallenge
}) {
  const redirectUri = oauthRedirectUri(origin, provider);
  let endpoint;
  let parameters;
  if (provider === 'google' || provider === 'google-user') {
    const { clientId } = googleCredentials(env, provider);
    endpoint = 'https://accounts.google.com/o/oauth2/v2/auth';
    parameters = {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: OAUTH_SCOPES[provider].join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    };
  } else if (provider === 'dropbox') {
    if (!env.DROPBOX_APP_KEY || !env.DROPBOX_APP_SECRET) throw new Error('dropbox_oauth_not_configured');
    endpoint = 'https://www.dropbox.com/oauth2/authorize';
    parameters = {
      client_id: env.DROPBOX_APP_KEY,
      redirect_uri: redirectUri,
      response_type: 'code',
      token_access_type: 'offline',
      scope: OAUTH_SCOPES.dropbox.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    };
  } else if (provider === 'xero') {
    if (!env.XERO_CLIENT_ID || !env.XERO_CLIENT_SECRET) throw new Error('xero_oauth_not_configured');
    endpoint = 'https://login.xero.com/identity/connect/authorize';
    parameters = {
      response_type: 'code',
      client_id: env.XERO_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: OAUTH_SCOPES.xero.join(' '),
      state
    };
  } else {
    throw new Error('oauth_provider_invalid');
  }
  if (PKCE_PROVIDERS.has(provider) && !codeChallenge) throw new Error('oauth_pkce_challenge_missing');
  return `${endpoint}?${new URLSearchParams(parameters)}`;
}

export async function exchangeAuthorizationCode(env, {
  provider,
  origin,
  code,
  codeVerifier
}) {
  if (PKCE_PROVIDERS.has(provider) && !codeVerifier) throw new Error('oauth_pkce_verifier_missing');
  const redirectUri = oauthRedirectUri(origin, provider);
  let url;
  let headers = { 'content-type': 'application/x-www-form-urlencoded' };
  let parameters;
  if (provider === 'google' || provider === 'google-user') {
    const { clientId, clientSecret } = googleCredentials(env, provider);
    url = 'https://oauth2.googleapis.com/token';
    parameters = {
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier
    };
  } else if (provider === 'dropbox') {
    if (!env.DROPBOX_APP_KEY || !env.DROPBOX_APP_SECRET) throw new Error('dropbox_oauth_not_configured');
    url = 'https://api.dropboxapi.com/oauth2/token';
    // Dropbox's PKCE exchange authenticates the authorization request with
    // the one-time verifier and app key; the static app secret is not sent.
    parameters = {
      code,
      grant_type: 'authorization_code',
      client_id: env.DROPBOX_APP_KEY,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier
    };
  } else if (provider === 'xero') {
    if (!env.XERO_CLIENT_ID || !env.XERO_CLIENT_SECRET) throw new Error('xero_oauth_not_configured');
    url = 'https://identity.xero.com/connect/token';
    headers = {
      ...headers,
      authorization: `Basic ${btoa(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`)}`
    };
    parameters = { grant_type: 'authorization_code', code, redirect_uri: redirectUri };
  } else {
    throw new Error('oauth_provider_invalid');
  }
  const { data } = await providerFetch(provider, 'token_exchange', url, {
    method: 'POST',
    headers,
    body: new URLSearchParams(parameters)
  });
  if (!data?.access_token || !data?.refresh_token) throw new Error(`${provider}_offline_credentials_missing`);
  const expiresIn = Number(data.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn < 60 || expiresIn > 86400) {
    throw new Error(`${provider}_token_expiry_invalid`);
  }
  const grantedScopes = requireGrantedScopes(provider, data);
  return { ...data, grantedScopes };
}

export async function googleAccount(accessToken) {
  const { data } = await providerFetch('google', 'profile', 'https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!data?.id || !data?.email || data.verified_email !== true) throw new Error('google_verified_account_missing');
  return { id: String(data.id), email: String(data.email), label: String(data.email) };
}

export async function dropboxAccount(accessToken) {
  const { data } = await providerFetch('dropbox', 'profile', 'https://api.dropboxapi.com/2/users/get_current_account', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: 'null'
  });
  if (!data?.account_id || !data?.email || data.email_verified !== true) throw new Error('dropbox_verified_account_missing');
  return {
    id: String(data.account_id),
    email: String(data.email),
    label: String(data.name?.display_name || data.email)
  };
}

export async function xeroAccount(env, accessToken, expectedTenantId = null) {
  const { data } = await providerFetch('xero', 'connections', 'https://api.xero.com/connections', {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }
  });
  const connections = Array.isArray(data) ? data.filter(item => item?.tenantId && item?.id) : [];
  const configuredTenant = String(env.XERO_TENANT_ID || expectedTenantId || '').trim();
  const selected = configuredTenant
    ? connections.find(item => String(item.tenantId) === configuredTenant)
    : connections.length === 1 ? connections[0] : null;
  if (!selected) throw new Error(configuredTenant
    ? 'xero_configured_tenant_not_authorized'
    : connections.length > 1 ? 'xero_tenant_selection_required' : 'xero_connection_missing');
  return {
    id: String(selected.tenantId),
    connectionId: String(selected.id),
    tenantType: selected.tenantType || null,
    label: String(selected.tenantName || 'Xero organisation')
  };
}

function cleanConnectionMetadata(metadata = {}) {
  const next = { ...metadata };
  delete next.disconnect_started_at;
  delete next.disconnect_started_by;
  delete next.disconnected_at;
  delete next.disconnected_by;
  delete next.provider_revoked;
  return next;
}

function providerIdentityMetadata(provider, account) {
  if (provider === 'google') return { google_sub: account.id, email: account.email };
  if (provider === 'dropbox') return { account_id: account.id, email: account.email };
  return {
    xero_tenant_id: account.id,
    xero_tenant_name: account.label,
    xero_tenant_type: account.tenantType,
    connection_id: account.connectionId
  };
}

async function encryptedTokenMetadata(env, token, metadata) {
  const expiresIn = Number(token.expires_in);
  const now = Date.now();
  const refreshExpiresIn = Number(token.refresh_token_expires_in || 0);
  return {
    ...cleanConnectionMetadata(metadata),
    access_token: await seal(token.access_token, env.TOKEN_ENCRYPTION_KEY),
    refresh_token: await seal(token.refresh_token, env.TOKEN_ENCRYPTION_KEY),
    access_expires_at: Math.max(now + 15000, now + expiresIn * 1000 - 60000),
    refresh_expires_at: refreshExpiresIn > 0 ? now + refreshExpiresIn * 1000 : null,
    granted_scopes: token.grantedScopes,
    token_type: String(token.token_type || 'Bearer')
  };
}

function identityChanged(provider, current, account) {
  if (!current || current.status !== 'connected') return false;
  const metadata = current.metadata || {};
  if (provider === 'google') {
    const old = metadata.google_sub || String(metadata.email || '').toLowerCase();
    const next = metadata.google_sub ? account.id : String(account.email || '').toLowerCase();
    return Boolean(old && next && old !== next);
  }
  if (provider === 'dropbox') return Boolean(metadata.account_id && metadata.account_id !== account.id);
  if (provider === 'xero') return Boolean(metadata.xero_tenant_id && metadata.xero_tenant_id !== account.id);
  return false;
}

function userIdentityChanged(current, account) {
  if (!current || current.status !== 'connected') return false;
  const metadata = current.metadata || {};
  const old = metadata.google_sub || String(metadata.email || '').toLowerCase();
  const next = metadata.google_sub ? account.id : String(account.email || '').toLowerCase();
  return Boolean(old && next && old !== next);
}

export async function commitSharedOAuth(env, {
  provider,
  token,
  account,
  actorUserId,
  expectedGeneration
}) {
  const currentTenant = await tenant(env);
  const current = await integration(env, provider);
  const generation = Number(current?.refresh_generation || 0);
  if (generation !== Number(expectedGeneration) || current?.status === 'disconnecting') {
    throw new Error('oauth_connection_generation_changed');
  }
  if (identityChanged(provider, current, account)) throw new Error('oauth_account_change_requires_disconnect');
  const providerMetadata = providerIdentityMetadata(provider, account);
  const metadata = await encryptedTokenMetadata(env, token, {
    ...(current?.metadata || {}),
    ...providerMetadata,
    oauth_connected_by: actorUserId
  });
  const record = {
    tenant_id: currentTenant.id,
    provider,
    status: 'connected',
    account_label: account.label,
    last_verified_at: new Date().toISOString(),
    metadata,
    refresh_owner: null,
    refresh_lease_until: null,
    refresh_generation: generation + 1
  };
  if (!current) {
    const rows = await supa(env, 'integration_state', { method: 'POST', payload: record });
    if (!rows?.[0]) throw new Error('oauth_connection_commit_failed');
    return rows[0];
  }
  const rows = await supa(env, 'integration_state', {
    method: 'PATCH',
    query: `tenant_id=eq.${encodeURIComponent(currentTenant.id)}&provider=eq.${encodeURIComponent(provider)}&refresh_generation=eq.${generation}&status=neq.disconnecting`,
    payload: record
  });
  if (!rows?.[0]) throw new Error('oauth_connection_generation_changed');
  return rows[0];
}

export async function verifySharedOAuthConnection(env, provider) {
  if (!['google', 'dropbox', 'xero'].includes(provider)) throw new Error('oauth_provider_invalid');
  const token = await accessToken(env, provider);
  const currentTenant = await tenant(env);
  const current = await integration(env, provider);
  if (!current || current.status !== 'connected') throw new Error('oauth_connection_generation_changed');
  const account = provider === 'google'
    ? await googleAccount(token)
    : provider === 'dropbox'
      ? await dropboxAccount(token)
      : await xeroAccount(env, token, current.metadata?.xero_tenant_id);
  if (identityChanged(provider, current, account)) throw new Error('oauth_provider_identity_changed');
  const generation = Number(current.refresh_generation || 0);
  const rows = await supa(env, 'integration_state', {
    method: 'PATCH',
    query: `tenant_id=eq.${encodeURIComponent(currentTenant.id)}&provider=eq.${encodeURIComponent(provider)}&status=eq.connected&refresh_generation=eq.${generation}`,
    payload: {
      account_label: account.label,
      last_verified_at: new Date().toISOString(),
      metadata: {
        ...(current.metadata || {}),
        ...providerIdentityMetadata(provider, account)
      }
    }
  });
  if (!rows?.[0]) throw new Error('oauth_connection_generation_changed');
  return { account, integration: rows[0] };
}

export async function commitUserGoogleOAuth(env, {
  userId,
  token,
  account,
  expectedGeneration
}) {
  const currentTenant = await tenant(env);
  const current = await userIntegration(env, userId, 'google');
  const generation = Number(current?.refresh_generation || 0);
  if (generation !== Number(expectedGeneration) || current?.status === 'disconnecting') {
    throw new Error('oauth_connection_generation_changed');
  }
  if (userIdentityChanged(current, account)) throw new Error('oauth_account_change_requires_disconnect');
  const metadata = await encryptedTokenMetadata(env, token, {
    ...(current?.metadata || {}),
    google_sub: account.id,
    email: account.email,
    oauth_connected_by: userId
  });
  const record = {
    tenant_id: currentTenant.id,
    user_id: userId,
    provider: 'google',
    status: 'connected',
    account_label: account.label,
    last_verified_at: new Date().toISOString(),
    metadata,
    refresh_owner: null,
    refresh_lease_until: null,
    refresh_generation: generation + 1,
    updated_at: new Date().toISOString()
  };
  if (!current) {
    const rows = await supa(env, 'user_integrations', { method: 'POST', payload: record });
    if (!rows?.[0]) throw new Error('oauth_connection_commit_failed');
    return rows[0];
  }
  const rows = await supa(env, 'user_integrations', {
    method: 'PATCH',
    query: `tenant_id=eq.${encodeURIComponent(currentTenant.id)}&user_id=eq.${encodeURIComponent(userId)}&provider=eq.google&refresh_generation=eq.${generation}&status=neq.disconnecting`,
    payload: record
  });
  if (!rows?.[0]) throw new Error('oauth_connection_generation_changed');
  return rows[0];
}

async function markDisconnecting(env, current, actorUserId, userId = null) {
  const currentTenant = await tenant(env);
  const generation = Number(current.refresh_generation || 0);
  const table = userId ? 'user_integrations' : 'integration_state';
  const identity = userId
    ? `&user_id=eq.${encodeURIComponent(userId)}&provider=eq.google`
    : `&provider=eq.${encodeURIComponent(current.provider)}`;
  const rows = await supa(env, table, {
    method: 'PATCH',
    query: `tenant_id=eq.${encodeURIComponent(currentTenant.id)}${identity}&status=eq.connected&refresh_generation=eq.${generation}`,
    payload: {
      status: 'disconnecting',
      metadata: {
        ...(current.metadata || {}),
        disconnect_started_at: new Date().toISOString(),
        disconnect_started_by: actorUserId
      },
      refresh_owner: null,
      refresh_lease_until: null,
      refresh_generation: generation + 1,
      ...(userId ? { updated_at: new Date().toISOString() } : {})
    }
  });
  if (!rows?.[0]) throw new Error('oauth_disconnect_generation_changed');
  return rows[0];
}

async function revokeResponse(provider, url, options, alreadyRevokedCodes = []) {
  try {
    await providerFetch(provider, 'revocation', url, options);
    return;
  } catch (exception) {
    if (alreadyRevokedCodes.includes(exception.providerCode)) return;
    throw exception;
  }
}

async function revokeGoogle(env, row) {
  const token = await unseal(row.metadata?.refresh_token || row.metadata?.access_token, env.TOKEN_ENCRYPTION_KEY);
  if (!token) throw new Error('google_revocation_credential_missing');
  await revokeResponse('google', 'https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token })
  }, ['invalid_token']);
}

async function revokeDropbox(env, row) {
  const refreshToken = await unseal(row.metadata?.refresh_token, env.TOKEN_ENCRYPTION_KEY);
  if (!refreshToken) throw new Error('dropbox_revocation_credential_missing');
  let access;
  try {
    const { data } = await providerFetch('dropbox', 'disconnect_refresh', 'https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: env.DROPBOX_APP_KEY,
        client_secret: env.DROPBOX_APP_SECRET
      })
    });
    access = data.access_token;
  } catch (exception) {
    if (exception.providerCode === 'invalid_grant') return;
    throw exception;
  }
  if (!access) throw new Error('dropbox_disconnect_access_missing');
  await revokeResponse('dropbox', 'https://api.dropboxapi.com/2/auth/token/revoke', {
    method: 'POST',
    headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: 'null'
  }, ['invalid_access_token']);
}

async function revokeXero(env, row) {
  const refreshToken = await unseal(row.metadata?.refresh_token, env.TOKEN_ENCRYPTION_KEY);
  if (!refreshToken) throw new Error('xero_revocation_credential_missing');
  await revokeResponse('xero', 'https://identity.xero.com/connect/revocation', {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${env.XERO_CLIENT_ID}:${env.XERO_CLIENT_SECRET}`)}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ token: refreshToken })
  }, ['invalid_token']);
}

async function finalizeDisconnect(env, row, actorUserId, userId = null) {
  const currentTenant = await tenant(env);
  const table = userId ? 'user_integrations' : 'integration_state';
  const identity = userId
    ? `&user_id=eq.${encodeURIComponent(userId)}&provider=eq.google`
    : `&provider=eq.${encodeURIComponent(row.provider)}`;
  const disconnectedAt = new Date().toISOString();
  const rows = await supa(env, table, {
    method: 'PATCH',
    query: `tenant_id=eq.${encodeURIComponent(currentTenant.id)}${identity}&status=eq.disconnecting&refresh_generation=eq.${Number(row.refresh_generation || 0)}`,
    payload: {
      status: 'not_connected',
      account_label: null,
      last_verified_at: disconnectedAt,
      metadata: {
        disconnected_at: disconnectedAt,
        disconnected_by: actorUserId,
        provider_revoked: true
      },
      refresh_owner: null,
      refresh_lease_until: null,
      ...(userId ? { updated_at: disconnectedAt } : {})
    }
  });
  if (!rows?.[0]) throw new Error('oauth_disconnect_generation_changed');
  return rows[0];
}

export async function disconnectSharedOAuth(env, provider, actorUserId) {
  if (!['google', 'dropbox', 'xero'].includes(provider)) throw new Error('oauth_provider_invalid');
  let current = await integration(env, provider);
  if (!current || current.status === 'not_connected') return { alreadyDisconnected: true };
  if (current.status !== 'disconnecting') {
    if (current.status !== 'connected') throw new Error('oauth_disconnect_state_invalid');
    // Finish any in-flight Dropbox token rotation before fencing the row.
    if (provider === 'dropbox') {
      await accessToken(env, provider);
      current = await integration(env, provider);
    }
    current = await markDisconnecting(env, current, actorUserId);
  }
  if (provider === 'google') await revokeGoogle(env, current);
  else if (provider === 'dropbox') await revokeDropbox(env, current);
  else await revokeXero(env, current);
  await finalizeDisconnect(env, current, actorUserId);
  return { alreadyDisconnected: false };
}

async function disconnectCalendarChannels(env, row, userId, access) {
  const currentTenant = await tenant(env);
  const result = await supa(env, 'rpc/northlight_disconnect_calendar_watch', {
    method: 'POST',
    payload: {
      p_tenant_id: currentTenant.id,
      p_user_id: userId,
      p_provider: 'google',
      p_connection_generation: Number(row.refresh_generation || 0)
    }
  });
  if (result?.disconnected !== true || !Array.isArray(result.channels)) {
    throw new Error('calendar_disconnect_state_failed');
  }
  for (const channel of result.channels) {
    if (channel?.channel_id && channel?.resource_id && access) {
      try {
        await providerFetch('google', 'channel_stop', 'https://www.googleapis.com/calendar/v3/channels/stop', {
          method: 'POST',
          headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
          body: JSON.stringify({ id: channel.channel_id, resourceId: channel.resource_id })
        });
      } catch (exception) {
        if (![404, 410].includes(exception.providerStatus)) {
          // The database has already invalidated the raw-secret-bearing
          // channel. Provider revocation below is the final security boundary.
        }
      }
    }
  }
}

export async function disconnectUserGoogleOAuth(env, userId) {
  let current = await userIntegration(env, userId, 'google');
  if (!current || current.status === 'not_connected') return { alreadyDisconnected: true };
  let access = null;
  if (current.status !== 'disconnecting') {
    if (current.status !== 'connected') throw new Error('oauth_disconnect_state_invalid');
    try {
      access = await userAccessToken(env, userId, 'google');
      current = await userIntegration(env, userId, 'google');
    } catch {
      access = await unseal(current.metadata?.access_token, env.TOKEN_ENCRYPTION_KEY);
    }
    current = await markDisconnecting(env, current, userId, userId);
  } else {
    access = await unseal(current.metadata?.access_token, env.TOKEN_ENCRYPTION_KEY);
  }
  await disconnectCalendarChannels(env, current, userId, access);
  await revokeGoogle(env, current);
  await finalizeDisconnect(env, current, userId, userId);
  return { alreadyDisconnected: false };
}
