import { requireSession, supa, tenant } from '../../_lib/core.js';
import { startCalendarWatch } from '../../_lib/calendar-sync.js';
import {
  consumeOAuthAuthorization,
  oauthAuthorizationCode,
  oauthFailure,
  oauthOrigin,
  oauthSuccess
} from '../../_lib/oauth-security.js';
import {
  commitUserGoogleOAuth,
  exchangeAuthorizationCode,
  googleAccount
} from '../../_lib/oauth-lifecycle.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireSession(request, env, ['photographer']);
  if (auth.error) return oauthFailure('google-user', auth.error.status === 403 ? 403 : 401);
  try {
    const url = new URL(request.url);
    const authorization = await consumeOAuthAuthorization(env, {
      request,
      provider: 'google-user',
      actorUserId: auth.session.userId,
      state: url.searchParams.get('state')
    });
    const canonicalOrigin = oauthOrigin(request, env);
    const token = await exchangeAuthorizationCode(env, {
      provider: 'google-user',
      origin: canonicalOrigin,
      code: oauthAuthorizationCode(url),
      codeVerifier: authorization.codeVerifier
    });
    const account = await googleAccount(token.access_token);
    await commitUserGoogleOAuth(env, {
      userId: auth.session.userId,
      token,
      account,
      expectedGeneration: authorization.connectionGeneration
    });
    const currentTenant = await tenant(env);
    await supa(env, 'provider_profiles', {
      method: 'PATCH',
      query: `tenant_id=eq.${encodeURIComponent(currentTenant.id)}&user_id=eq.${encodeURIComponent(auth.session.userId)}`,
      payload: { calendar_id: 'primary' },
      prefer: 'return=minimal'
    });
    try { await startCalendarWatch(env, auth.session.userId, 'primary', canonicalOrigin); } catch {}
    return oauthSuccess(request, env, 'google-user', authorization.returnPath, 'user-google');
  } catch {
    return oauthFailure('google-user');
  }
}
