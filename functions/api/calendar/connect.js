import { requireSession, error } from '../../_lib/core.js';
import { beginOAuthAuthorization } from '../../_lib/oauth-security.js';
import { buildProviderAuthorizationUrl } from '../../_lib/oauth-lifecycle.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireSession(request, env, ['photographer']);
  if (auth.error) return auth.error;
  try {
    const url = new URL(request.url);
    const authorization = await beginOAuthAuthorization(env, {
      request,
      provider: 'google-user',
      actorUserId: auth.session.userId,
      returnPath: url.searchParams.get('return_to') || '/'
    });
    const location = buildProviderAuthorizationUrl(env, {
      provider: 'google-user',
      origin: authorization.origin,
      state: authorization.state,
      codeChallenge: authorization.codeChallenge
    });
    return new Response(null, {
      status: 302,
      headers: {
        location,
        'set-cookie': authorization.cookie,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff'
      }
    });
  } catch (exception) {
    const configuration = /not_configured|oauth_(?:canonical|origin|insecure)/.test(String(exception?.message || ''));
    return error(configuration ? 409 : 500, configuration
      ? 'Google Calendar connection is not configured safely yet.'
      : 'Could not start Google Calendar connection.');
  }
}
