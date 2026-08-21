import { requireSession, error, json, supa, tenant } from '../_lib/core.js';
import { evaluateBooking, schedulingStatus, isAtomicScheduleConflict } from '../_lib/scheduling.js';
import { queueTaskHandoffs } from '../_lib/task-handoffs.js';
const BOOKING_DEFAULTS={priority:'standard'};

function visibleTask(task, session) {
  if (['admin', 'owner'].includes(session.role)) return task;
  const { dropbox_path, ...rest } = task;
  const metadata = { ...(rest.metadata || {}) };
  delete metadata.dropbox_link;
  delete metadata.dropbox_path;
  delete metadata.xero_invoice_id;
  delete metadata.invoice_total;
  delete metadata.assignment_email_to;
  return { ...rest, metadata };
}

function filterTasks(rows, session) {
  const alive = rows.filter(task => !task.deleted_at);
  let output = [];
  if (['admin', 'owner'].includes(session.role)) output = alive;
  else {
    const current = alive.filter(task => !task.archived_at);
    if (session.role === 'agent') output = current.filter(task => task.agent_user_id === session.userId);
    else if (session.role === 'photographer') output = current.filter(task => task.photographer_user_id === session.userId);
    else if (session.role === 'editor') output = current.filter(task => task.editor_user_id === session.userId);
  }
  return output.map(task => visibleTask(task, session));
}

async function taskById(env, id) {
  return (await supa(env, 'tasks', {
    query: `select=*&id=eq.${encodeURIComponent(id)}&deleted_at=is.null&limit=1`
  }))?.[0] || null;
}

function availabilityError(result) {
  const detail = {};
  if (result.missingServices?.length) detail.missingServices = result.missingServices;
  if (result.timeChoices?.length) {
    detail.timeChoices = result.timeChoices;
    detail.timeZone = result.timeZone;
    detail.localTime = result.localTime;
  }
  return error(schedulingStatus(result.code), result.reason, Object.keys(detail).length ? detail : undefined);
}

function handoffSummary(task, { calendarConnected = null } = {}) {
  return {
    dropbox: task.dropbox_path ? 'done' : 'pending',
    calendar: task.calendar_event_id ? 'done' : calendarConnected === false ? 'not_connected' : 'pending',
    email: task.metadata?.assignment_email_user_id === task.photographer_user_id ? 'done' : 'pending'
  };
}

export async function onRequestGet({ request, env }) {
  const auth = await requireSession(request, env);
  if (auth.error) return auth.error;
  try {
    const url = new URL(request.url);
    const scope = url.searchParams.get('scope') || 'active';
    const rows = await supa(env, 'tasks', { query: 'select=*&deleted_at=is.null&order=created_at.desc' });
    let filtered = filterTasks(rows, auth.session);
    if (['admin', 'owner'].includes(auth.session.role)) {
      if (scope === 'active') filtered = filtered.filter(task => !task.archived_at);
      else if (scope === 'archived') filtered = filtered.filter(task => Boolean(task.archived_at));
    }
    return json({ tasks: filtered, scope });
  } catch {
    return error(500, 'Could not load tasks.');
  }
}

export async function onRequestPost({ request, env }) {
  const auth = await requireSession(request, env, ['admin', 'owner', 'agent']);
  if (auth.error) return auth.error;
  try {
    const body = await request.json();
    const currentTenant = await tenant(env);
    const property = String(body.property || '').trim();
    const address = String(body.address || '').trim();
    const suburb = String(body.suburb || '').trim();
    const area = String(body.area || '').trim();
    const services = [...new Set((Array.isArray(body.services) ? body.services : []).map(String).filter(Boolean))];
    const idempotencyKey = String(body.idempotencyKey || '').trim().slice(0, 120);

    if (!property) return error(400, 'Property name is required.');
    if (!address) return error(400, 'Property address is required.');
    if (!/\b\d{4}\b/.test(address)) return error(400, 'Include the 4-digit Australian postcode in the property address.');
    if (!suburb) return error(400, 'Property suburb is required.');
    if (!area) return error(400, 'Property area is required.');
    if (!services.length) return error(400, 'Choose at least one service.');
    if (!body.photographerId) return error(422, 'Choose an eligible Photographer for this job.');
    if (!idempotencyKey) return error(400, 'Booking request key is missing. Please reopen the booking form.');

    const availability = await evaluateBooking(env, {
      photographerId: body.photographerId,
      area,
      serviceCodes: services,
      startLocal: body.scheduledStart,
      timeDisambiguation: body.timeDisambiguation || null,
      requireActiveServices: true
    });
    if (!availability.available) return availabilityError(availability);

    let agentId = auth.session.role === 'agent' ? auth.session.userId : null;
    if (['admin', 'owner'].includes(auth.session.role)) {
      const candidate = String(body.agentId || '').trim();
      if (candidate) {
        const agent = (await supa(env, 'users', {
          query: `select=id,tenant_id,role_code,active&id=eq.${encodeURIComponent(candidate)}&limit=1`
        }))?.[0];
        if (!agent || agent.active === false || agent.role_code !== 'agent' || agent.tenant_id !== currentTenant.id) {
          return error(422, 'Choose a valid Agent for this property.');
        }
        agentId = agent.id;
      } else {
        agentId = (await supa(env, 'users', {
          query: `select=id&tenant_id=eq.${currentTenant.id}&role_code=eq.agent&active=eq.true&order=created_at.asc&limit=1`
        }))?.[0]?.id || null;
      }
    }
    if (!agentId) return error(422, 'An active Agent is required before this property can be booked.');

    const taskNumber = `NL-${String(Date.now()).slice(-6)}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
    const metadata = {
      source: 'cloud',
      requestedPriority: BOOKING_DEFAULTS.priority,
      booking_created_at: new Date().toISOString(),
      created_by: auth.session.userId,
      timezone: availability.timeZone || availability.profile.timezone || 'Australia/Melbourne',
      local_scheduled_start: availability.localTime || null,
      utc_offset_minutes: Number.isFinite(availability.utcOffsetMinutes) ? availability.utcOffsetMinutes : null,
      time_disambiguation: availability.timeDisambiguation || null,
      buffer_before_min: availability.bufferBeforeMinutes,
      buffer_after_min: availability.bufferAfterMinutes,
      calendar_checked: availability.connected
    };

    let result;
    try {
      result = await supa(env, 'rpc/northlight_create_booking', {
        method: 'POST',
        payload: {
          p_tenant_id: currentTenant.id,
          p_actor: auth.session.userId,
          p_task_no: taskNumber,
          p_idempotency_key: idempotencyKey,
          p_property_name: property,
          p_address: address,
          p_suburb: suburb,
          p_area: area,
          p_agent_user_id: agentId,
          p_photographer_user_id: body.photographerId,
          p_scheduled_start: availability.start.toISOString(),
          p_scheduled_end: availability.end.toISOString(),
          p_service_codes: services,
          p_notes: String(body.notes || '').trim(),
          p_metadata: metadata
        }
      });
    } catch (exception) {
      const message = String(exception?.message || '');
      if (isAtomicScheduleConflict(exception)) {
        return error(409, 'That Photographer was booked by another request while this booking was being saved. Choose another time.');
      }
      if (/invalid_agent/i.test(message)) return error(422, 'Choose a valid Agent for this property.');
      if (/invalid_photographer/i.test(message)) return error(422, 'Choose an active Photographer for this property.');
      if (/invalid_booking/i.test(message)) return error(400, 'The booking details are incomplete or invalid.');
      if (/permission_denied/i.test(message)) return error(403, 'You do not have permission to create this booking.');
      if (/(?:23505|duplicate key value)/i.test(message)) {
        return error(409, 'Northlight could not reserve a unique booking number. Retry this booking once.');
      }
      throw exception;
    }

    const task = result?.task;
    if (!task?.id) throw new Error('task_insert_failed');
    await queueTaskHandoffs(env, task);
    const fresh = await taskById(env, task.id) || task;
    const reused = Boolean(result.reused);
    return json({
      task: visibleTask(fresh, auth.session),
      handoffs: handoffSummary(fresh, { calendarConnected: availability.connected }),
      reused
    }, reused ? 200 : 201);
  } catch {
    return error(500, 'Could not create task.');
  }
}
