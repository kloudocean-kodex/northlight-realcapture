import { requireSession, error, json, integration } from '../../../_lib/core.js';
import { verifySharedOAuthConnection } from '../../../_lib/oauth-lifecycle.js';

const PROVIDERS = new Set(['google', 'dropbox', 'xero']);
const LABELS = { google: 'Google Workspace', dropbox: 'Dropbox', xero: 'Xero' };

function needsDurableReconnect(provider, row) {
  return row?.status === 'connected'
    && ['google', 'dropbox', 'xero'].includes(provider)
    && !row.metadata?.refresh_token;
}

function verificationError(provider, exception) {
  const label = LABELS[provider] || 'Integration';
  const message = String(exception?.message || '');
  if (/generation_changed/.test(message)) {
    return error(409, 'The integration changed during verification. Reload its status and try again.', { code: 'INTEGRATION_CHANGED' });
  }
  if (new RegExp(`${provider}_(not_connected|refresh_token_missing)`, 'i').test(message)
    || /required_scope_missing|oauth_40[013]|invalid_access_token|invalid_token|expired_access_token|unauthorized/i.test(message)) {
    return error(409, `${label} needs to be reconnected to restore one-time setup.`, { code: 'INTEGRATION_RECONNECT_REQUIRED' });
  }
  if (new RegExp(`${provider}_429|rate_limit|ratelimit`, 'i').test(message)) {
    return error(429, `${label} is temporarily rate-limiting verification. Wait a moment and retry.`, { code: 'INTEGRATION_RATE_LIMITED' });
  }
  return error(502, `${label} verification failed safely. Reconnect it if this persists.`, { code: 'INTEGRATION_VERIFY_FAILED' });
}

export async function onRequestPost({ request, env, params }) {
  const auth = await requireSession(request, env, ['admin', 'owner']);
  if (auth.error) return auth.error;
  const provider = String(params.provider || '');
  if (!PROVIDERS.has(provider)) return error(404, 'Unknown integration.');
  try {
    const current = await integration(env, provider);
    if (!current || current.status !== 'connected') return error(409, `${LABELS[provider]} is not connected yet.`, { code: 'INTEGRATION_NOT_CONNECTED' });
    if (needsDurableReconnect(provider, current)) return error(409, `${LABELS[provider]} needs to be reconnected to restore one-time setup.`, { code: 'INTEGRATION_RECONNECT_REQUIRED' });
    const { account } = await verifySharedOAuthConnection(env, provider);
    const label = provider === 'google' ? `Connected as ${account.label}`
      : provider === 'dropbox' ? `Connected to ${account.label}`
        : `Connected to ${account.label}`;
    return json({ message: label });
  } catch (exception) {
    return verificationError(provider, exception);
  }
}
