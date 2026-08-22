import { cookie, safeEqual, seal, supa, tenant, unseal } from './core.js';

const encoder = new TextEncoder();
const OAUTH_STATE_TTL_MS = 8 * 60 * 1000;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PKCE_PROVIDERS = new Set(['google', 'google-user', 'dropbox']);
const PROVIDERS = new Set(['google', 'google-user', 'dropbox', 'xero']);

export const OAUTH_SCOPES = Object.freeze({
  google: Object.freeze([
    'openid',
    'email',
    'https://www.googleapis.com/auth/gmail.compose'
  ]),
  'google-user': Object.freeze([
    'openid',
    'email',
    'https://www.googleapis.com/auth/calendar.events.owned',
    'https://www.googleapis.com/auth/calendar.freebusy'
  ]),
  dropbox: Object.freeze([
    'account_info.read',
    'files.metadata.read',
    'files.content.read',
    'files.content.write'
  ]),
  xero: Object.freeze([
    'accounting.invoices',
    'accounting.contacts',
    'offline_access'
  ])
});

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function randomSecret() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256Base64url(value) {
  return base64url(await crypto.subtle.digest('SHA-256', encoder.encode(String(value))));
}

export async function sha256Hex(value) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(String(value))));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function createPkcePair() {
  const verifier = randomSecret();
  return { verifier, challenge: await sha256Base64url(verifier) };
}

export function safeReturnPath(value, fallback = '/') {
  const candidate = String(value || '').trim();
  if (!candidate) return fallback;
  if (candidate.length > 512
    || !candidate.startsWith('/')
    || candidate.startsWith('//')
    || candidate.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(candidate)) return fallback;
  try {
    const base = new URL('https://northlight.invalid/');
    const parsed = new URL(candidate, base);
    if (parsed.origin !== base.origin
      || parsed.username
      || parsed.password
      || parsed.pathname === '/oauth'
      || parsed.pathname.startsWith('/oauth/')
      || parsed.pathname === '/api'
      || parsed.pathname.startsWith('/api/')) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

function acceptableOrigin(origin) {
  const url = new URL(origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('oauth_insecure_origin');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('oauth_origin_invalid');
  }
  return url.origin;
}

export function configuredOAuthOrigin(env) {
  const configuredValues = [env.PUBLIC_ORIGIN, env.APP_ORIGIN]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .map(value => acceptableOrigin(value.endsWith('/') ? value : `${value}/`));
  if (!configuredValues.length) throw new Error('oauth_canonical_origin_missing');
  if (new Set(configuredValues).size !== 1) throw new Error('oauth_canonical_origins_conflict');
  return configuredValues[0];
}

export function oauthOrigin(request, env) {
  const requestOrigin = acceptableOrigin(new URL(request.url).origin);
  const expected = configuredOAuthOrigin(env);
  if (expected !== requestOrigin) throw new Error('oauth_origin_mismatch');
  return expected;
}

export function oauthCookieName(provider) {
  if (!PROVIDERS.has(provider)) throw new Error('oauth_provider_invalid');
  return `nl_oauth_${provider.replace('-', '_')}`;
}

export function oauthCookie(provider, value, maxAge = Math.floor(OAUTH_STATE_TTL_MS / 1000)) {
  return `${oauthCookieName(provider)}=${encodeURIComponent(value)}; Path=/oauth/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearOAuthCookie(provider) {
  return oauthCookie(provider, '', 0);
}

export async function beginOAuthAuthorization(env, {
  request,
  provider,
  actorUserId,
  returnPath = '/'
}) {
  if (!PROVIDERS.has(provider) || !actorUserId) throw new Error('oauth_begin_invalid');
  if (!env.TOKEN_ENCRYPTION_KEY) throw new Error('oauth_token_encryption_not_configured');
  const origin = oauthOrigin(request, env);
  const state = randomSecret();
  const stateHash = await sha256Hex(state);
  // Xero's current confidential web-client registration does not use PKCE,
  // but every durable state row still receives an encrypted high-entropy
  // verifier-shaped secret so the database surface never needs a nullable
  // secret special case.
  const pkce = await createPkcePair();
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS).toISOString();
  const currentTenant = await tenant(env);
  const result = await supa(env, 'rpc/northlight_begin_oauth_state', {
    method: 'POST',
    payload: {
      p_tenant_id: currentTenant.id,
      p_provider: provider,
      p_actor_user_id: actorUserId,
      p_state_hash: stateHash,
      p_return_path: safeReturnPath(returnPath),
      p_pkce_verifier_ciphertext: await seal(pkce.verifier, env.TOKEN_ENCRYPTION_KEY),
      p_expires_at: expiresAt
    }
  });
  if (!result?.id || !result?.expires_at) throw new Error('oauth_state_not_persisted');
  return {
    origin,
    state,
    codeChallenge: PKCE_PROVIDERS.has(provider) ? pkce.challenge : null,
    cookie: oauthCookie(provider, stateHash)
  };
}

export async function consumeOAuthAuthorization(env, {
  request,
  provider,
  actorUserId,
  state
}) {
  if (!PROVIDERS.has(provider) || !actorUserId || !STATE_PATTERN.test(String(state || ''))) {
    throw new Error('oauth_state_invalid');
  }
  if (!env.TOKEN_ENCRYPTION_KEY) throw new Error('oauth_token_encryption_not_configured');
  oauthOrigin(request, env);
  const stateHash = await sha256Hex(state);
  const browserHash = cookie(request, oauthCookieName(provider));
  if (!await safeEqual(browserHash, stateHash)) throw new Error('oauth_state_browser_mismatch');
  const currentTenant = await tenant(env);
  const result = await supa(env, 'rpc/northlight_consume_oauth_state', {
    method: 'POST',
    payload: {
      p_tenant_id: currentTenant.id,
      p_provider: provider,
      p_actor_user_id: actorUserId,
      p_state_hash: stateHash
    }
  });
  if (!result?.id || !result?.expires_at || result.connection_generation === undefined) {
    throw new Error('oauth_state_spent_or_expired');
  }
  const verifier = result.pkce_verifier_ciphertext
    ? await unseal(result.pkce_verifier_ciphertext, env.TOKEN_ENCRYPTION_KEY)
    : null;
  if (PKCE_PROVIDERS.has(provider) && !verifier) throw new Error('oauth_pkce_verifier_missing');
  return {
    returnPath: safeReturnPath(result.return_path),
    connectionGeneration: Number(result.connection_generation),
    codeVerifier: verifier
  };
}

export function oauthAuthorizationCode(url) {
  const providerError = String(url.searchParams.get('error') || '');
  if (providerError) throw new Error(providerError === 'access_denied'
    ? 'oauth_authorization_denied'
    : 'oauth_provider_authorization_failed');
  const code = String(url.searchParams.get('code') || '');
  if (!code || code.length > 4096 || /[\u0000-\u001f\u007f]/.test(code)) {
    throw new Error('oauth_authorization_code_invalid');
  }
  return code;
}

export function oauthSuccess(request, env, provider, returnPath, connectedAs = provider) {
  const origin = oauthOrigin(request, env);
  const destination = new URL(safeReturnPath(returnPath), origin);
  destination.searchParams.set('connected', connectedAs);
  return new Response(null, {
    status: 303,
    headers: {
      location: destination.toString(),
      'set-cookie': clearOAuthCookie(provider),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    }
  });
}

export function oauthFailure(provider, status = 400) {
  const label = provider === 'google-user' ? 'Google Calendar' : ({ google: 'Google Workspace', dropbox: 'Dropbox', xero: 'Xero' }[provider] || 'Integration');
  return new Response(`${label} connection failed safely. Return to Northlight and start a new connection.`, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'set-cookie': clearOAuthCookie(provider),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    }
  });
}

export function parseGrantedScopes(provider, token) {
  const direct = token?.scope;
  let values = Array.isArray(direct) ? direct : String(direct || '').split(/[\s,]+/);
  if (!values.some(Boolean) && provider === 'xero') {
    try {
      const payload = String(token?.access_token || '').split('.')[1];
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=');
      const claims = JSON.parse(atob(normalized));
      values = Array.isArray(claims.scope) ? claims.scope : String(claims.scope || '').split(/[\s,]+/);
    } catch {
      values = [];
    }
  }
  return new Set(values.filter(Boolean));
}

export function requireGrantedScopes(provider, token) {
  const granted = parseGrantedScopes(provider, token);
  const satisfies = scope => granted.has(scope)
    || (scope === 'email' && granted.has('https://www.googleapis.com/auth/userinfo.email'));
  const missing = (OAUTH_SCOPES[provider] || []).filter(scope => !satisfies(scope));
  if (missing.length) throw new Error('oauth_required_scope_missing');
  return [...granted].sort();
}
