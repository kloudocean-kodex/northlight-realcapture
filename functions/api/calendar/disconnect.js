import { requireSession, error, json } from '../../_lib/core.js';
import { disconnectUserGoogleOAuth } from '../../_lib/oauth-lifecycle.js';

export async function onRequestPost({ request, env }) {
  const auth = await requireSession(request, env, ['photographer']);
  if (auth.error) return auth.error;
  try {
    const result = await disconnectUserGoogleOAuth(env, auth.session.userId);
    return json({
      ok: true,
      alreadyDisconnected: result.alreadyDisconnected,
      message: result.alreadyDisconnected
        ? 'Google Calendar was already disconnected.'
        : 'Google access was revoked and Northlight removed its encrypted Calendar credentials.'
    });
  } catch (exception) {
    const message = String(exception?.message || '');
    if (/generation_changed/.test(message)) {
      return error(409, 'Calendar changed during disconnect. Reload its status before trying again.');
    }
    if (exception?.provider || /revocation|disconnect_refresh/.test(message)) {
      return error(502, 'Google could not confirm revocation. Northlight locked this connection; retry disconnect to finish safely.');
    }
    return error(500, 'Could not disconnect Google Calendar safely.');
  }
}
