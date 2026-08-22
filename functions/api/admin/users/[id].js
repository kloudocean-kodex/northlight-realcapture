import { requireSession, error, json, supa, logEvent } from '../../../_lib/core.js';

const AREAS = ['Inner East', 'Inner South', 'Bayside', 'CBD & Inner City', 'North', 'West'];
const emailOk = value => /^\S+@\S+\.\S+$/.test(value);
const cleanList = value => [...new Set((Array.isArray(value) ? value : [])
  .map(item => String(item).trim())
  .filter(Boolean))];

async function user(env, id) {
  return (await supa(env, 'users', {
    query: `select=id,tenant_id,role_code,name,email,phone,active,metadata&id=eq.${encodeURIComponent(id)}&limit=1`
  }))?.[0] || null;
}

async function activeAssignment(env, id) {
  return (await supa(env, 'tasks', {
    query: `select=id,task_no,property_name&deleted_at=is.null&archived_at=is.null&status=not.in.(delivered,cancelled)&or=(agent_user_id.eq.${encodeURIComponent(id)},photographer_user_id.eq.${encodeURIComponent(id)},editor_user_id.eq.${encodeURIComponent(id)})&limit=1`
  }))?.[0] || null;
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireSession(request, env, ['admin']);
  if (auth.error) return auth.error;

  try {
    const current = await user(env, params.id);
    if (!current) return error(404, 'Team member not found.');

    const input = await request.json();
    const name = String(input.name ?? current.name).trim();
    const email = String(input.email ?? current.email).trim().toLowerCase();
    const phone = String(input.phone ?? current.phone ?? '').trim();
    const active = input.active === undefined ? current.active : Boolean(input.active);

    if (!name) return error(400, 'Name is required.');
    if (!emailOk(email)) return error(400, 'Enter a valid email address.');
    if (current.id === auth.session.userId && !active) {
      return error(400, 'You cannot deactivate your own Admin account.');
    }

    if (current.active !== false && !active) {
      const assigned = await activeAssignment(env, current.id);
      if (assigned) return error(409, `Reassign or close ${assigned.task_no} before deactivating this account.`);
    }

    const duplicate = (await supa(env, 'users', {
      query: `select=id&tenant_id=eq.${encodeURIComponent(current.tenant_id)}&email=eq.${encodeURIComponent(email)}&id=neq.${encodeURIComponent(current.id)}&limit=1`
    }))?.[0];
    if (duplicate) return error(409, 'That email is already used by another Northlight user.');

    await supa(env, 'users', {
      method: 'PATCH',
      query: `id=eq.${encodeURIComponent(current.id)}`,
      payload: { name, email, phone: phone || null, active },
      prefer: 'return=minimal'
    });

    const services = await supa(env, 'services', { query: 'select=code&active=eq.true' });
    const serviceSet = new Set(services.map(service => service.code));

    if (current.role_code === 'photographer') {
      const areas = cleanList(input.areas).filter(area => AREAS.includes(area));
      const codes = cleanList(input.serviceCodes).filter(code => serviceSet.has(code));
      const profile = (await supa(env, 'provider_profiles', {
        query: `select=*&user_id=eq.${encodeURIComponent(current.id)}&limit=1`
      }))?.[0];
      if (!profile) return error(409, 'Photographer profile is missing.');

      const patch = {};
      if (input.areas !== undefined) patch.areas = areas;
      if (input.serviceCodes !== undefined) patch.service_codes = codes;
      if (input.homeBase !== undefined) patch.home_base = String(input.homeBase || '').trim() || null;
      if (input.serviceRadiusKm !== undefined) patch.service_radius_km = Math.max(1, Math.min(250, Number(input.serviceRadiusKm) || 25));
      if (input.travelBufferMin !== undefined) patch.travel_buffer_min = Math.max(0, Math.min(180, Number(input.travelBufferMin) || 0));
      if (input.workingHours && typeof input.workingHours === 'object' && !Array.isArray(input.workingHours)) {
        patch.working_hours = input.workingHours;
      }

      if (Object.keys(patch).length) {
        await supa(env, 'provider_profiles', {
          method: 'PATCH',
          query: `user_id=eq.${encodeURIComponent(current.id)}`,
          payload: patch,
          prefer: 'return=minimal'
        });
      }
    } else if (current.role_code === 'editor' && input.skills !== undefined) {
      const skills = cleanList(input.skills).filter(skill => serviceSet.has(skill));
      await supa(env, 'editor_profiles', {
        method: 'PATCH',
        query: `user_id=eq.${encodeURIComponent(current.id)}`,
        payload: { skills },
        prefer: 'return=minimal'
      });
    }

    try {
      await logEvent(env, {
        type: 'team_member_updated',
        actor_user_id: auth.session.userId,
        message: `Team member updated: ${name}.`,
        detail: { user_id: current.id, role: current.role_code, active }
      });
    } catch {}

    return json({ ok: true, user: await user(env, current.id) });
  } catch (exception) {
    if (String(exception.message).includes('database_409')) {
      return error(409, 'That email is already used by another Northlight user.');
    }
    return error(500, 'Could not update team member.');
  }
}
