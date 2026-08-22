import { AvailabilityValidationError, normalizeAvailabilityProfile } from '../_lib/availability-profile.js';
import { body, error, json, requireSession, supa, tenant } from '../_lib/core.js';

async function snapshot(env, tenantId, userId) {
  const [profileRows, onboarding] = await Promise.all([
    supa(env, 'provider_profiles', {
      query: `select=user_id,working_hours,days_off,special_days,timezone,availability_version,availability_updated_at&tenant_id=eq.${encodeURIComponent(tenantId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`
    }),
    supa(env, 'rpc/northlight_photographer_onboarding_status', {
      method: 'POST',
      payload: { p_tenant_id: tenantId, p_user_id: userId }
    })
  ]);
  return { profile: profileRows?.[0] || null, onboarding: onboarding || null };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export async function onRequestGet({ request, env }) {
  const auth = await requireSession(request, env, ['photographer']);
  if (auth.error) return auth.error;
  try {
    const currentTenant = await tenant(env);
    return json(await snapshot(env, currentTenant.id, auth.session.userId));
  } catch {
    return error(500, 'Could not load Photographer availability.');
  }
}

export async function onRequestPatch({ request, env }) {
  const auth = await requireSession(request, env, ['photographer']);
  if (auth.error) return auth.error;
  try {
    const input = await body(request);
    const expectedVersion = Number(input.expectedVersion);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      return error(400, 'Reload availability before saving.', { code: 'INVALID_VERSION', field: 'expectedVersion' });
    }
    const availability = normalizeAvailabilityProfile(input);
    const currentTenant = await tenant(env);
    const current = (await supa(env, 'provider_profiles', {
      query: `select=user_id,working_hours,days_off,special_days,timezone,availability_version,availability_updated_at&tenant_id=eq.${encodeURIComponent(currentTenant.id)}&user_id=eq.${encodeURIComponent(auth.session.userId)}&limit=1`
    }))?.[0];
    if (!current) return error(409, 'Photographer setup must be completed before availability can be saved.');
    if (Number(current.availability_version) !== expectedVersion) {
      return error(409, 'Availability changed in another session. Reload before saving again.');
    }
    if (
      sameJson(current.working_hours || {}, availability.workingHours)
      && sameJson(current.days_off || [], availability.daysOff)
      && sameJson(current.special_days || [], availability.specialDays)
      && String(current.timezone || '') === availability.timeZone
    ) {
      const onboarding = await supa(env, 'rpc/northlight_photographer_onboarding_status', {
        method: 'POST',
        payload: { p_tenant_id: currentTenant.id, p_user_id: auth.session.userId }
      });
      return json({ profile: current, onboarding, reused: true });
    }
    const updated = await supa(env, 'rpc/northlight_update_provider_availability', {
      method: 'POST',
      payload: {
        p_tenant_id: currentTenant.id,
        p_actor_user_id: auth.session.userId,
        p_user_id: auth.session.userId,
        p_expected_version: expectedVersion,
        p_working_hours: availability.workingHours,
        p_days_off: availability.daysOff,
        p_special_days: availability.specialDays,
        p_timezone: availability.timeZone
      }
    });
    const onboarding = await supa(env, 'rpc/northlight_photographer_onboarding_status', {
      method: 'POST',
      payload: { p_tenant_id: currentTenant.id, p_user_id: auth.session.userId }
    });
    return json({
      profile: {
        user_id: updated.user_id,
        working_hours: updated.working_hours,
        days_off: updated.days_off,
        special_days: updated.special_days,
        timezone: updated.timezone,
        availability_version: updated.version,
        availability_updated_at: updated.updated_at
      },
      onboarding
    });
  } catch (exception) {
    if (exception instanceof AvailabilityValidationError) {
      return error(400, exception.message, { code: exception.code, field: exception.field });
    }
    const marker = String(exception?.message || '');
    if (marker.includes('availability_version_changed')) {
      return error(409, 'Availability changed in another session. Reload before saving again.');
    }
    if (marker.includes('availability_permission_denied')) return error(403, 'You cannot change this availability.');
    if (marker.includes('availability_profile_not_found') || marker.includes('availability_photographer_not_found')) {
      return error(409, 'Photographer setup must be completed before availability can be saved.');
    }
    if (marker.includes('availability_')) return error(400, 'Choose valid working hours, dates and a supported time zone.');
    return error(500, 'Could not save Photographer availability.');
  }
}
