import { integration, requireSession } from '../../_lib/core.js';
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
  xeroAccount
} from '../../_lib/oauth-lifecycle.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireSession(request, env, ['admin', 'owner']);
  if (auth.error) return oauthFailure('xero', auth.error.status === 403 ? 403 : 401);
  try {
    const url = new URL(request.url);
    const authorization = await consumeOAuthAuthorization(env, {
      request,
      provider: 'xero',
      actorUserId: auth.session.userId,
      state: url.searchParams.get('state')
    });
    const token = await exchangeAuthorizationCode(env, {
      provider: 'xero',
      origin: oauthOrigin(request, env),
      code: oauthAuthorizationCode(url),
      codeVerifier: authorization.codeVerifier
    });
    const current = await integration(env, 'xero');
    const expectedTenantId = current?.status === 'connected'
      && Number(current.refresh_generation || 0) === authorization.connectionGeneration
      ? current.metadata?.xero_tenant_id
      : null;
    const account = await xeroAccount(env, token.access_token, expectedTenantId);
    await commitSharedOAuth(env, {
      provider: 'xero',
      token,
      account,
      actorUserId: auth.session.userId,
      expectedGeneration: authorization.connectionGeneration
    });
    return oauthSuccess(request, env, 'xero', authorization.returnPath);
  } catch {
    return oauthFailure('xero');
  }
}
