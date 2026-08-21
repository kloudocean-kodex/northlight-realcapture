import { requireSession, error, json } from '../../../_lib/core.js';
import { verifySharedOAuthConnection } from '../../../_lib/oauth-lifecycle.js';

const PROVIDERS = new Set(['google', 'dropbox', 'xero']);

export async function onRequestPost({ request, env, params }) {
  const auth = await requireSession(request, env, ['admin', 'owner']);
  if (auth.error) return auth.error;
  const provider = String(params.provider || '');
  if (!PROVIDERS.has(provider)) return error(404, 'Unknown integration.');
  try {
    const { account } = await verifySharedOAuthConnection(env, provider);
    const label = provider === 'google' ? `Connected as ${account.label}`
      : provider === 'dropbox' ? `Connected to ${account.label}`
        : `Connected to ${account.label}`;
    return json({ message: label });
  } catch (exception) {
    if (/generation_changed/.test(String(exception?.message || ''))) {
      return error(409, 'The integration changed during verification. Reload its status and try again.');
    }
    return error(502, 'Integration verification failed safely.');
  }
}
