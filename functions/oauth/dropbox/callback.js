import { requireSession, supa, tenant } from '../../_lib/core.js';
import { syncDropbox } from '../../_lib/dropbox-sync.js';
import {
  consumeOAuthAuthorization,
  oauthAuthorizationCode,
  oauthFailure,
  oauthOrigin,
  oauthSuccess
} from '../../_lib/oauth-security.js';
import {
  commitSharedOAuth,
  dropboxAccount,
  exchangeAuthorizationCode
} from '../../_lib/oauth-lifecycle.js';

export async function onRequestGet({ request, env }) {
  const auth = await requireSession(request, env, ['admin', 'owner']);
  if (auth.error) return oauthFailure('dropbox', auth.error.status === 403 ? 403 : 401);
  try {
    const url = new URL(request.url);
    const authorization = await consumeOAuthAuthorization(env, {
      request,
      provider: 'dropbox',
      actorUserId: auth.session.userId,
      state: url.searchParams.get('state')
    });
    const token = await exchangeAuthorizationCode(env, {
      provider: 'dropbox',
      origin: oauthOrigin(request, env),
      code: oauthAuthorizationCode(url),
      codeVerifier: authorization.codeVerifier
    });
    const account = await dropboxAccount(token.access_token);
    await commitSharedOAuth(env, {
      provider: 'dropbox',
      token,
      account,
      actorUserId: auth.session.userId,
      expectedGeneration: authorization.connectionGeneration
    });
    const currentTenant = await tenant(env);
    await supa(env, 'dropbox_sync_state', {
      method: 'POST',
      query: 'on_conflict=tenant_id,root_path',
      payload: {
        tenant_id: currentTenant.id,
        account_id: account.id,
        root_path: env.DROPBOX_ROOT || '/Northlight',
        cursor: null,
        last_sync_at: null,
        last_error: null,
        metadata: {}
      },
      prefer: 'resolution=merge-duplicates,return=minimal'
    });
    try { await syncDropbox(env); } catch {}
    return oauthSuccess(request, env, 'dropbox', authorization.returnPath);
  } catch {
    return oauthFailure('dropbox');
  }
}
