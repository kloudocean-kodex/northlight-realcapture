import {
  json,
  error,
  body,
  makeSession,
  sessionCookie,
  verifyPBKDF2,
  safeEqual,
  supa
} from '../../_lib/core.js';

const encoder = new TextEncoder();
const LOGIN_THRESHOLD = 5;

async function loginKey(email) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(String(email || '').trim().toLowerCase())
  );
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function rpcObject(value) {
  return Array.isArray(value) ? (value[0] || {}) : (value || {});
}

async function beginAttempt(env, key) {
  return rpcObject(await supa(env, 'rpc/northlight_begin_login_attempt', {
    method: 'POST',
    payload: {
      p_login_key: key,
      p_window_seconds: 600,
      p_threshold: LOGIN_THRESHOLD,
      p_block_seconds: 900
    }
  }));
}

async function resetAttempt(env, key) {
  return rpcObject(await supa(env, 'rpc/northlight_reset_login_attempt', {
    method: 'POST',
    payload: { p_login_key: key }
  }));
}

async function credentialMatches(password, user, env) {
  if (!user || user.active === false || password.length > 128) return false;
  const stored = String(user.password_hash || '');
  if (stored.startsWith('pbkdf2$') || stored.startsWith('pbkdf2cf$')) return verifyPBKDF2(password, stored);
  if (stored.startsWith('scrypt$') && env.PILOT_LOGIN_PASSWORD) {
    return safeEqual(password, String(env.PILOT_LOGIN_PASSWORD));
  }
  return false;
}

export async function onRequestPost({ request, env }) {
  try {
    const input = await body(request);
    const email = String(input.email || '').trim().toLowerCase().slice(0, 320);
    const password = String(input.password || '');
    const key = await loginKey(email);
    const throttle = await beginAttempt(env, key);

    if (throttle.allowed !== true) {
      return error(429, 'Too many sign-in attempts. Try again in a few minutes.');
    }

    const users = await supa(env, 'users', {
      query: `select=id,role_code,name,email,password_hash,active,metadata,auth_must_change_password,credential_version&email=eq.${encodeURIComponent(email)}&limit=1`
    });
    const user = users?.[0];
    const valid = await credentialMatches(password, user, env);

    if (!valid) {
      const blocked = Number(throttle.failure_count || 0) >= LOGIN_THRESHOLD
        || (throttle.blocked_until && new Date(throttle.blocked_until) > new Date());
      return error(
        blocked ? 429 : 401,
        blocked
          ? 'Too many sign-in attempts. Try again in a few minutes.'
          : 'Invalid email or password.'
      );
    }

    // Fail closed: a successful sign-in is not issued unless the atomic
    // limiter reset also succeeds.
    await resetAttempt(env, key);
    const roles = await supa(env, 'roles', {
      query: `select=name&code=eq.${encodeURIComponent(user.role_code)}&limit=1`
    });
    const session = {
      userId: user.id,
      role: user.role_code,
      roleLabel: roles?.[0]?.name || user.role_code,
      name: user.name,
      email: user.email,
      authVersion: Number(user.metadata?.auth_version || 0),
      credentialVersion: Number(user.credential_version || 0),
      mustChangePassword: user.auth_must_change_password === true
    };
    return json(
      { session },
      200,
      { 'set-cookie': sessionCookie(await makeSession(session, env)) }
    );
  } catch {
    return error(503, 'Sign-in service is temporarily unavailable. Please try again.');
  }
}
