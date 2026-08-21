import { requireSession } from '../../_lib/core.js';
import {
  consumeOAuthAuthorization,
  oauthAuthorizationCode,
  oauthFailure,
  oauthOrigin,
  oauthSuccess
} from '../../_lib/oauth-security.js';
import {
  commitSharedOAuth,
  exchangeAuthorizationCode,
  googleAccount
} from '../../_lib/oauth-lifecycle.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireSession(request, env, ['admin', 'owner']);
  if (auth.error) return oauthFailure('google', auth.error.status === 403 ? 403 : 401);
  try {
    const url = new URL(request.url);
    const authorization = await consumeOAuthAuthorization(env, {
      request,
      provider: 'google',
      actorUserId: auth.session.userId,
      state: url.searchParams.get('state')
    });
    const token = await exchangeAuthorizationCode(env, {
      provider: 'google',
      origin: oauthOrigin(request, env),
      code: oauthAuthorizationCode(url),
      codeVerifier: authorization.codeVerifier
    });
    const account = await googleAccount(token.access_token);
    await commitSharedOAuth(env, {
      provider: 'google',
      token,
      account,
      actorUserId: auth.session.userId,
      expectedGeneration: authorization.connectionGeneration
    });
    return oauthSuccess(request, env, 'google', authorization.returnPath);
  } catch {
    return oauthFailure('google');
  }
}
