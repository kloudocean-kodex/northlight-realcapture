import { requireSession, error } from '../../../_lib/core.js';
import { beginOAuthAuthorization } from '../../../_lib/oauth-security.js';
import { buildProviderAuthorizationUrl } from '../../../_lib/oauth-lifecycle.js';

const SHARED_PROVIDERS = new Set(['google', 'dropbox', 'xero']);

export async function onRequestGet({ request, env, params }) {
  const auth = await requireSession(request, env, ['admin', 'owner']);
  if (auth.error) return auth.error;
  const provider = String(params.provider || '');
  if (!SHARED_PROVIDERS.has(provider)) return error(404, 'Unknown integration.');
  try {
    const url = new URL(request.url);
    const authorization = await beginOAuthAuthorization(env, {
      request,
      provider,
      actorUserId: auth.session.userId,
      returnPath: url.searchParams.get('return_to') || '/'
    });
    const location = buildProviderAuthorizationUrl(env, {
      provider,
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
      ? 'This integration connection is not configured safely yet.'
      : 'Could not start integration connection.');
  }
}
