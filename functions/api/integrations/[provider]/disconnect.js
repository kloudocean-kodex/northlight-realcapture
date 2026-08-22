import { requireSession, error, json } from '../../../_lib/core.js';
import { disconnectSharedOAuth } from '../../../_lib/oauth-lifecycle.js';

const PROVIDERS = new Set(['google', 'dropbox', 'xero']);

export async function onRequestPost({ request, env, params }) {
  const auth = await requireSession(request, env, ['admin', 'owner']);
  if (auth.error) return auth.error;
  const provider = String(params.provider || '');
  if (!PROVIDERS.has(provider)) return error(404, 'Unknown integration.');
  try {
    const result = await disconnectSharedOAuth(env, provider, auth.session.userId);
    return json({
      ok: true,
      alreadyDisconnected: result.alreadyDisconnected,
      message: result.alreadyDisconnected
        ? 'The integration was already disconnected.'
        : 'Provider access was revoked and encrypted credentials were removed.'
    });
  } catch (exception) {
    const message = String(exception?.message || '');
    if (/generation_changed/.test(message)) {
      return error(409, 'The integration changed during disconnect. Reload its status before trying again.');
    }
    if (exception?.provider || /revocation|disconnect_refresh/.test(message)) {
      return error(502, 'The provider could not confirm revocation. Northlight locked this connection; retry disconnect to finish safely.');
    }
    return error(500, 'Could not disconnect this integration safely.');
  }
}
