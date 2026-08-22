import {
  requireSession,
  error,
  json,
  supa,
  tenant,
  verifyPBKDF2,
  safeEqual,
  clearSessionCookie,
  logEvent
} from '../../_lib/core.js';
import { hashPBKDF2 } from '../../_lib/password.js';

function migrationFailure(failure) {
  const message = String(failure?.message || '');
  if (message.includes('credential_version_changed')) {
    return error(409, 'Your account changed while the password was being updated. Sign in again and retry.');
  }
  if (message.includes('credential_user_not_found')) return error(401, 'authentication_required');
  if (message.includes('invalid_credential_migration')) {
    return error(400, 'The new password could not be accepted. Choose another personal password.');
  }
  return null;
}

export async function onRequestPost({ request, env }) {
  const auth = await requireSession(request, env, [], { allowPasswordMigration: true });
  if (auth.error) return auth.error;

  try {
    const input = await request.json();
    const currentPassword = String(input.currentPassword || '');
    const newPassword = String(input.newPassword || '');
    if (!currentPassword) return error(400, 'Current password is required.');
    if (newPassword.length < 12) return error(400, 'New password must be at least 12 characters.');
    if (newPassword.length > 128) return error(400, 'New password is too long.');
    if (newPassword === currentPassword) {
      return error(400, 'Choose a new password that is different from your current password.');
    }
    if (env.PILOT_LOGIN_PASSWORD && await safeEqual(newPassword, String(env.PILOT_LOGIN_PASSWORD))) {
      return error(400, 'Choose a personal password different from the pilot password.');
    }

    const user = (await supa(env, 'users', {
      query: `select=id,tenant_id,password_hash,metadata,active,auth_must_change_password,credential_version&id=eq.${encodeURIComponent(auth.session.userId)}&limit=1`
    }))?.[0];
    if (!user || user.active === false) return error(401, 'authentication_required');

    const stored = String(user.password_hash || '');
    let valid = false;
    if (stored.startsWith('pbkdf2$') || stored.startsWith('pbkdf2cf$')) valid = await verifyPBKDF2(currentPassword, stored);
    else if (stored.startsWith('scrypt$') && env.PILOT_LOGIN_PASSWORD) {
      valid = await safeEqual(currentPassword, String(env.PILOT_LOGIN_PASSWORD));
    }
    if (!valid) return error(401, 'Current password is incorrect.');

    const workspace = await tenant(env);
    if (String(user.tenant_id) !== String(workspace.id)) return error(401, 'authentication_required');
    const hash = await hashPBKDF2(newPassword);
    let result;
    try {
      result = await supa(env, 'rpc/northlight_complete_password_migration', {
        method: 'POST',
        payload: {
          p_tenant_id: workspace.id,
          p_user_id: user.id,
          p_expected_password_hash: stored,
          p_new_password_hash: hash
        }
      });
    } catch (failure) {
      const response = migrationFailure(failure);
      if (response) return response;
      throw failure;
    }

    const migrated = Array.isArray(result) ? result[0] : result;
    if (!migrated?.ok || migrated.must_change_password === true) {
      return error(409, 'Your password was not changed. Sign in again and retry.');
    }
    try {
      await logEvent(env, {
        type: 'password_changed',
        actor_user_id: user.id,
        message: 'Account password changed; older sessions invalidated.'
      });
    } catch {}
    return json(
      { ok: true, message: 'Password updated. Sign in again with your new password.' },
      200,
      { 'set-cookie': clearSessionCookie() }
    );
  } catch {
    return error(500, 'Could not update password. Please try again.');
  }
}
