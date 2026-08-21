import { supa } from './core.js';
import { userGoogleRequest, userIntegration } from './user-integrations.js';

export const NORTHLIGHT_TZ = 'Australia/Melbourne';
const MAX_SCHEDULE_BUFFER_MINUTES = 24 * 60;

function wallFormatter(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  });
}

function wallParts(date, timeZone) {
  const parts = wallFormatter(timeZone).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)])
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second || 0
  };
}

function parseWallTime(value) {
  const text = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::00(?:\.0{1,3})?)?$/.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  if (year < 1900 || month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) return null;
  return {
    text: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    year,
    month,
    day,
    hour,
    minute,
    naiveMs: check.getTime()
  };
}

function sameWallTime(parts, wanted) {
  return parts.year === wanted.year &&
    parts.month === wanted.month &&
    parts.day === wanted.day &&
    parts.hour === wanted.hour &&
    parts.minute === wanted.minute;
}

function offsetAt(instant, timeZone) {
  const date = new Date(instant);
  const parts = wallParts(date, timeZone);
  const shownAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const roundedInstant = Math.floor(date.getTime() / 1000) * 1000;
  return shownAsUtc - roundedInstant;
}

function offsetLabel(offsetMinutes) {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

function requestedOffset(disambiguation) {
  if (Number.isInteger(disambiguation)) return disambiguation;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(String(disambiguation || '').trim());
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

/**
 * Resolve a wall-clock choice without silently normalising daylight-saving gaps
 * or choosing one side of an overlap. Ambiguous times require `earlier`, `later`,
 * an offset such as `+10:00`, or an integer offset in minutes.
 */
export function resolveZonedLocalTime(value, timeZone = NORTHLIGHT_TZ, disambiguation = null) {
  const wanted = parseWallTime(value);
  if (!wanted) return { kind: 'invalid', localTime: String(value || ''), timeZone, choices: [] };

  let offsets;
  try {
    offsets = new Set();
    // Forty-eight hours on both sides always straddles a civil-time offset
    // transition while keeping this request-path validation inexpensive.
    for (const hours of [-48, 0, 48]) {
      offsets.add(offsetAt(wanted.naiveMs + hours * 60 * 60 * 1000, timeZone));
    }
  } catch {
    return { kind: 'invalid_timezone', localTime: wanted.text, timeZone, choices: [] };
  }

  const unique = new Map();
  for (const offsetMs of offsets) {
    const instant = new Date(wanted.naiveMs - offsetMs);
    if (!sameWallTime(wallParts(instant, timeZone), wanted)) continue;
    const offsetMinutes = Math.round(offsetMs / 60000);
    unique.set(instant.getTime(), {
      instant,
      iso: instant.toISOString(),
      offsetMinutes,
      offset: offsetLabel(offsetMinutes)
    });
  }
  const choices = [...unique.values()].sort((a, b) => a.instant - b.instant);
  if (!choices.length) return { kind: 'nonexistent', localTime: wanted.text, timeZone, choices: [] };
  if (choices.length === 1) return { kind: 'valid', localTime: wanted.text, timeZone, ...choices[0], choices };

  let selected = null;
  if (disambiguation === 'earlier') selected = choices[0];
  else if (disambiguation === 'later') selected = choices.at(-1);
  else {
    const offset = requestedOffset(disambiguation);
    if (offset !== null) selected = choices.find(choice => choice.offsetMinutes === offset) || null;
  }
  if (!selected) return { kind: 'ambiguous', localTime: wanted.text, timeZone, choices };
  return {
    kind: 'valid',
    localTime: wanted.text,
    timeZone,
    ambiguous: true,
    disambiguation: selected === choices[0] ? 'earlier' : 'later',
    ...selected,
    choices
  };
}

export function zonedLocalToUtc(value, timeZone = NORTHLIGHT_TZ, disambiguation = null) {
  if (value instanceof Date) return new Date(value);
  const resolved = resolveZonedLocalTime(value, timeZone, disambiguation);
  return resolved.kind === 'valid' ? new Date(resolved.instant) : new Date(Number.NaN);
}

function localParts(date, timeZone = NORTHLIGHT_TZ) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    day: String(values.weekday || '').slice(0, 3).toLowerCase(),
    minutes: Number(values.hour) * 60 + Number(values.minute)
  };
}

function clockMin(value) {
  const [hours, minutes] = String(value || '').split(':').map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : null;
}

function workingRule(profile, start, end) {
  const timeZone = profile.timezone || NORTHLIGHT_TZ;
  const first = localParts(start, timeZone);
  const last = localParts(end, timeZone);
  if ((profile.days_off || []).some(value => (typeof value === 'string' ? value : value?.date) === first.date)) {
    return { code: 'DAY_OFF', reason: 'That photographer is marked unavailable on the selected date.' };
  }
  let hours = profile.working_hours?.[first.day];
  const special = (profile.special_days || []).find(value => value?.date === first.date);
  if (special) hours = special.closed ? null : (special.hours || special.working_hours || hours);
  if (!hours || hours.length < 2) {
    return { code: 'NOT_WORKING_DAY', reason: 'That photographer is not working on the selected day.' };
  }
  const from = clockMin(hours[0]);
  const to = clockMin(hours[1]);
  if (from === null || to === null || first.date !== last.date || first.minutes < from || last.minutes > to) {
    return { code: 'WORKING_HOURS', reason: `That time does not fit the photographer’s ${hours[0]}–${hours[1]} working window.` };
  }
  return null;
}

async function photographer(env, userId) {
  const user = (await supa(env, 'users', {
    query: `select=id,name,email,role_code,active&id=eq.${encodeURIComponent(userId || '')}&limit=1`
  }))?.[0];
  if (!user || user.active === false || user.role_code !== 'photographer') return null;
  const profile = (await supa(env, 'provider_profiles', {
    query: `select=*&user_id=eq.${encodeURIComponent(user.id)}&limit=1`
  }))?.[0];
  return profile ? { user, profile } : null;
}

async function serviceRules(env, codes, requireActive) {
  const unique = [...new Set((Array.isArray(codes) ? codes : []).map(String).filter(Boolean))];
  if (!unique.length) return { error: { code: 'SERVICE_REQUIRED', reason: 'Choose at least one service.' } };
  const rows = await supa(env, 'services', { query: 'select=code,duration_min,buffer_before_min,buffer_after_min,active' });
  const selected = rows.filter(row => unique.includes(row.code));
  if (selected.length !== unique.length || (requireActive && selected.some(row => row.active === false))) {
    return { error: { code: 'SERVICE_NOT_AVAILABLE', reason: 'One or more selected services are not available.' } };
  }
  return {
    codes: unique,
    rows: selected,
    duration: selected.reduce((sum, row) => sum + Number(row.duration_min || 0), 0) || 90,
    before: Math.max(0, ...selected.map(row => Number(row.buffer_before_min || 0))),
    after: Math.max(0, ...selected.map(row => Number(row.buffer_after_min || 0)))
  };
}

function boundedBuffer(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(MAX_SCHEDULE_BUFFER_MINUTES, Math.trunc(number))) : 0;
}

async function northlightConflict(env, userId, min, max, excludeTaskId) {
  const exclude = excludeTaskId ? `&id=neq.${encodeURIComponent(excludeTaskId)}` : '';
  const scanMin = new Date(min.getTime() - MAX_SCHEDULE_BUFFER_MINUTES * 60000);
  const scanMax = new Date(max.getTime() + MAX_SCHEDULE_BUFFER_MINUTES * 60000);
  const rows = await supa(env, 'tasks', {
    query: `select=id,task_no,property_name,scheduled_start,scheduled_end,status,metadata&photographer_user_id=eq.${encodeURIComponent(userId)}${exclude}&deleted_at=is.null&archived_at=is.null&status=not.in.(cancelled,delivered,declined)&scheduled_start=lt.${encodeURIComponent(scanMax.toISOString())}&scheduled_end=gt.${encodeURIComponent(scanMin.toISOString())}&order=scheduled_start.asc&limit=1000`
  });
  return (rows || []).find(row => {
    const protectedStart = new Date(row.scheduled_start).getTime() - boundedBuffer(row.metadata?.buffer_before_min) * 60000;
    const protectedEnd = new Date(row.scheduled_end).getTime() + boundedBuffer(row.metadata?.buffer_after_min) * 60000;
    return protectedStart < max.getTime() && protectedEnd > min.getTime();
  }) || null;
}

function eventInstant(value, timeZone, endOfAllDay = false) {
  if (value?.dateTime) {
    const instant = new Date(value.dateTime);
    return Number.isNaN(instant.getTime()) ? null : instant;
  }
  if (value?.date) {
    const resolved = resolveZonedLocalTime(`${value.date}T00:00`, timeZone, endOfAllDay ? 'later' : 'earlier');
    return resolved.kind === 'valid' ? resolved.instant : null;
  }
  return null;
}

/** Return only anonymous busy intervals; event titles, descriptions and locations never leave this boundary. */
export function privacySafeBusyIntervals(events, {
  excludeEventId = null,
  timeZone = NORTHLIGHT_TZ,
  min = null,
  max = null
} = {}) {
  const lower = min instanceof Date ? min.getTime() : min ? new Date(min).getTime() : Number.NEGATIVE_INFINITY;
  const upper = max instanceof Date ? max.getTime() : max ? new Date(max).getTime() : Number.POSITIVE_INFINITY;
  const busy = [];
  for (const event of events || []) {
    if (!event?.id || event.id === excludeEventId || event.status === 'cancelled') continue;
    if (event.transparency === 'transparent' || event.eventType === 'workingLocation') continue;
    const self = (event.attendees || []).find(attendee => attendee?.self);
    if (self?.responseStatus === 'declined') continue;
    const start = eventInstant(event.start, timeZone);
    const end = eventInstant(event.end, timeZone, true);
    if (!start || !end || end <= start || start.getTime() >= upper || end.getTime() <= lower) continue;
    busy.push({ start: start.toISOString(), end: end.toISOString() });
  }
  return busy.sort((a, b) => a.start.localeCompare(b.start));
}

async function managedEventId(env, taskId, userId) {
  if (!taskId) return null;
  const task = (await supa(env, 'tasks', {
    query: `select=calendar_event_id,calendar_owner_user_id&id=eq.${encodeURIComponent(taskId)}&deleted_at=is.null&limit=1`
  }))?.[0];
  return task?.calendar_owner_user_id === userId ? task.calendar_event_id || null : null;
}

async function listPrivacySafeBusy(env, userId, calendarId, profile, min, max, excludeEventId) {
  const events = [];
  let pageToken = null;
  do {
    const query = new URLSearchParams({
      timeMin: min.toISOString(),
      timeMax: max.toISOString(),
      timeZone: profile.timezone || NORTHLIGHT_TZ,
      singleEvents: 'true',
      showDeleted: 'false',
      maxResults: '2500',
      maxAttendees: '50',
      fields: 'items(id,status,transparency,eventType,start,end,attendees(self,responseStatus)),nextPageToken'
    });
    if (pageToken) query.set('pageToken', pageToken);
    const data = await userGoogleRequest(
      env,
      userId,
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${query.toString()}`
    );
    events.push(...(data.items || []));
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return privacySafeBusyIntervals(events, {
    excludeEventId,
    timeZone: profile.timezone || NORTHLIGHT_TZ,
    min,
    max
  });
}

async function calendarBusy(env, userId, profile, min, max, excludeTaskId) {
  const connection = await userIntegration(env, userId, 'google');
  const calendarId = profile.calendar_id || 'primary';
  if (!connection || connection.status !== 'connected') return { connected: false, calendarId, busy: [] };
  try {
    if (excludeTaskId) {
      const excludeEventId = await managedEventId(env, excludeTaskId, userId);
      const busy = await listPrivacySafeBusy(env, userId, calendarId, profile, min, max, excludeEventId);
      return { connected: true, calendarId, busy };
    }
    const data = await userGoogleRequest(env, userId, '/calendar/v3/freeBusy', {
      method: 'POST',
      body: JSON.stringify({
        timeMin: min.toISOString(),
        timeMax: max.toISOString(),
        timeZone: profile.timezone || NORTHLIGHT_TZ,
        items: [{ id: calendarId }]
      })
    });
    return { connected: true, calendarId, busy: data.calendars?.[calendarId]?.busy || [] };
  } catch {
    return { connected: true, calendarId, busy: [], error: true };
  }
}

export function schedulingStatus(code) {
  if (['PHOTOGRAPHER_NOT_ELIGIBLE', 'AREA_NOT_COVERED', 'SERVICE_NOT_CONFIGURED'].includes(code)) return 422;
  if (['SERVICE_REQUIRED', 'SERVICE_NOT_AVAILABLE', 'INVALID_TIME', 'NONEXISTENT_LOCAL_TIME', 'AMBIGUOUS_LOCAL_TIME'].includes(code)) return 400;
  if (code === 'GOOGLE_UNAVAILABLE') return 502;
  return 409;
}

export function isAtomicScheduleConflict(error) {
  return /(?:23P01|northlight_tasks_photographer_no_overlap|conflicting key value violates exclusion constraint)/i.test(String(error?.message || error || ''));
}

function invalidLocalTimeResult(resolution) {
  if (resolution.kind === 'nonexistent') {
    return {
      available: false,
      connected: false,
      code: 'NONEXISTENT_LOCAL_TIME',
      reason: `${resolution.localTime} does not exist in ${resolution.timeZone} because the clock moves forward. Choose another time.`,
      localTime: resolution.localTime,
      timeZone: resolution.timeZone,
      timeChoices: []
    };
  }
  if (resolution.kind === 'ambiguous') {
    return {
      available: false,
      connected: false,
      code: 'AMBIGUOUS_LOCAL_TIME',
      reason: `${resolution.localTime} occurs twice in ${resolution.timeZone} because the clock moves back. Choose the earlier or later occurrence.`,
      localTime: resolution.localTime,
      timeZone: resolution.timeZone,
      timeChoices: resolution.choices.map((choice, index) => ({
        disambiguation: index === 0 ? 'earlier' : 'later',
        offset: choice.offset,
        offsetMinutes: choice.offsetMinutes,
        start: choice.iso
      }))
    };
  }
  return {
    available: false,
    connected: false,
    code: 'INVALID_TIME',
    reason: 'A valid shoot time is required.',
    localTime: resolution.localTime,
    timeZone: resolution.timeZone,
    timeChoices: []
  };
}

export async function evaluateBooking(env, {
  photographerId,
  area,
  serviceCodes,
  startLocal,
  start,
  timeDisambiguation = null,
  durationMinutes,
  excludeTaskId = null,
  requireActiveServices = true
} = {}) {
  const photographerData = await photographer(env, photographerId);
  if (!photographerData) {
    return { available: false, connected: false, code: 'PHOTOGRAPHER_NOT_ELIGIBLE', reason: 'Choose an active Photographer who is configured for booking.' };
  }
  const services = await serviceRules(env, serviceCodes, requireActiveServices);
  if (services.error) return { available: false, connected: false, ...services.error };
  if (area && !(photographerData.profile.areas || []).includes(area)) {
    return { available: false, connected: false, code: 'AREA_NOT_COVERED', reason: 'That Photographer is not configured for this property area.' };
  }
  const missing = services.codes.filter(code => !(photographerData.profile.service_codes || []).includes(code));
  if (missing.length) {
    return {
      available: false,
      connected: false,
      code: 'SERVICE_NOT_CONFIGURED',
      reason: 'That Photographer is not configured for every requested service in this area.',
      missingServices: missing
    };
  }

  const timeZone = photographerData.profile.timezone || NORTHLIGHT_TZ;
  let resolution = null;
  let scheduledStart;
  if (start instanceof Date) scheduledStart = new Date(start);
  else {
    resolution = resolveZonedLocalTime(startLocal || start, timeZone, timeDisambiguation);
    if (resolution.kind !== 'valid') return invalidLocalTimeResult(resolution);
    scheduledStart = new Date(resolution.instant);
  }
  if (Number.isNaN(scheduledStart.getTime())) {
    return { available: false, connected: false, code: 'INVALID_TIME', reason: 'A valid shoot time is required.' };
  }

  const duration = Number(durationMinutes) > 0 ? Number(durationMinutes) : services.duration;
  const scheduledEnd = new Date(scheduledStart.getTime() + duration * 60000);
  const working = workingRule(photographerData.profile, scheduledStart, scheduledEnd);
  const timeDetail = resolution ? {
    localTime: resolution.localTime,
    timeZone,
    utcOffsetMinutes: resolution.offsetMinutes,
    timeDisambiguation: resolution.disambiguation || null
  } : { timeZone };
  if (working) return { available: false, connected: false, ...working, ...timeDetail, start: scheduledStart, end: scheduledEnd, durationMinutes: duration };

  const min = new Date(scheduledStart.getTime() - services.before * 60000);
  const max = new Date(scheduledEnd.getTime() + services.after * 60000);
  const conflict = await northlightConflict(env, photographerData.user.id, min, max, excludeTaskId);
  if (conflict) {
    return {
      available: false,
      connected: false,
      code: 'NORTHLIGHT_CONFLICT',
      reason: `Northlight already has ${conflict.task_no} in this Photographer’s protected time window.`,
      conflict,
      ...timeDetail,
      start: scheduledStart,
      end: scheduledEnd,
      durationMinutes: duration,
      bufferBeforeMinutes: services.before,
      bufferAfterMinutes: services.after
    };
  }

  const calendar = await calendarBusy(env, photographerData.user.id, photographerData.profile, min, max, excludeTaskId);
  if (!calendar.connected) {
    return {
      available: false,
      connected: false,
      code: 'GOOGLE_REQUIRED',
      reason: 'This Photographer must connect Google Calendar before Northlight can offer a bookable time.',
      ...timeDetail,
      start: scheduledStart,
      end: scheduledEnd,
      durationMinutes: duration,
      bufferBeforeMinutes: services.before,
      bufferAfterMinutes: services.after,
      calendarId: calendar.calendarId
    };
  }
  if (calendar.error) {
    return {
      available: false,
      connected: true,
      code: 'GOOGLE_UNAVAILABLE',
      reason: 'The connected Google Calendar could not be verified. Try again before booking.',
      ...timeDetail,
      start: scheduledStart,
      end: scheduledEnd,
      durationMinutes: duration,
      bufferBeforeMinutes: services.before,
      bufferAfterMinutes: services.after,
      calendarId: calendar.calendarId
    };
  }
  if (calendar.busy.length) {
    return {
      available: false,
      connected: true,
      code: 'GOOGLE_BUSY',
      reason: 'Busy in Google Calendar during the shoot or its required buffer.',
      busy: calendar.busy,
      ...timeDetail,
      start: scheduledStart,
      end: scheduledEnd,
      durationMinutes: duration,
      bufferBeforeMinutes: services.before,
      bufferAfterMinutes: services.after,
      calendarId: calendar.calendarId
    };
  }
  return {
    available: true,
    connected: true,
    code: 'AVAILABLE',
    reason: 'Available — eligibility, working hours, Northlight bookings and Google Calendar are clear.',
    busy: [],
    ...timeDetail,
    start: scheduledStart,
    end: scheduledEnd,
    durationMinutes: duration,
    bufferBeforeMinutes: services.before,
    bufferAfterMinutes: services.after,
    calendarId: calendar.calendarId,
    photographer: photographerData.user,
    profile: photographerData.profile,
    serviceRows: services.rows
  };
}
