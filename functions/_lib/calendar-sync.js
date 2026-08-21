import { supa, tenant, logEvent, logSync } from './core.js';
import { userGoogleRequest } from './user-integrations.js';
import { configuredOAuthOrigin, sha256Hex } from './oauth-security.js';

const PRE_SHOOT_CALENDAR_STATUSES = new Set(['assigned', 'confirmed', 'reschedule_requested']);
const CALENDAR_SYNC_LEASE_SECONDS = 120;
const CALENDAR_WATCH_LEASE_SECONDS = 120;
const CALENDAR_MAX_PAGES = 4;
const CALENDAR_MAX_RUNTIME_MS = 20_000;
const CALENDAR_PAGE_SIZE = 2500;
const CALENDAR_WATCH_LIFETIME_MS = 6 * 24 * 60 * 60 * 1000;
const CALENDAR_RENEW_BASE_MS = 18 * 60 * 60 * 1000;
const CALENDAR_RENEW_JITTER_MS = 12 * 60 * 60 * 1000;
const SAFE_CALENDAR_ERRORS = [
  'calendar_connection_changed',
  'calendar_not_connected',
  'calendar_user_ineligible',
  'calendar_sync_budget_exceeded',
  'calendar_sync_claim_lost',
  'calendar_sync_page_limit',
  'calendar_sync_response_invalid',
  'calendar_sync_token_changed',
  'calendar_sync_token_invalidated',
  'calendar_sync_token_missing',
  'calendar_watch_activation_invalid',
  'calendar_watch_channel_collision',
  'calendar_watch_claim_in_progress',
  'calendar_watch_claim_lost',
  'calendar_watch_origin_mismatch',
  'calendar_watch_pending_missing',
  'calendar_watch_provider_failed',
  'oauth_refresh_in_progress'
];

export function calendarChangeReviewable(status) {
  return PRE_SHOOT_CALENDAR_STATUSES.has(String(status || ''));
}

export function reviewableCalendarTasks(rows = []) {
  return (rows || []).filter(task => (
    task?.calendar_event_id
    && !task.deleted_at
    && !task.archived_at
    && calendarChangeReviewable(task.status)
  ));
}

function iso(value) {
  try {
    const date = value ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
  } catch {
    return null;
  }
}

function eventTime(part) {
  return iso(part?.dateTime || part?.date);
}

export function managedCalendarSnapshot(event = {}) {
  const privateProperties = event.extendedProperties?.private || {};
  return {
    summary: String(event.summary || ''),
    description: String(event.description || ''),
    location: String(event.location || ''),
    start: eventTime(event.start),
    end: eventTime(event.end),
    northlightTaskId: String(privateProperties.northlightTaskId || ''),
    northlightTaskNo: String(privateProperties.northlightTaskNo || '')
  };
}

export function taskCalendarSnapshot(task = {}) {
  return {
    summary: `${task.task_no || ''} · ${task.property_name || ''}`,
    description: `Northlight property media task ${task.task_no || ''}\nServices: ${(task.service_codes || []).join(', ')}`,
    location: [task.address, task.suburb].filter(Boolean).join(', '),
    start: iso(task.scheduled_start),
    end: iso(task.scheduled_end || (task.scheduled_start ? new Date(task.scheduled_start).getTime() + 90 * 60000 : null)),
    northlightTaskId: String(task.id || ''),
    northlightTaskNo: String(task.task_no || '')
  };
}

export function managedCalendarSnapshotsEqual(left, right) {
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function calendarEventOwnedByTask(event, task) {
  return String(event?.extendedProperties?.private?.northlightTaskId || '') === String(task?.id || '');
}

function providerEventPredatesLocalChange(task, event) {
  const localChanged = new Date(task?.metadata?.last_schedule_change_at || 0).getTime();
  const providerChanged = new Date(event?.updated || 0).getTime();
  return Number.isFinite(localChanged)
    && localChanged > 0
    && Number.isFinite(providerChanged)
    && providerChanged > 0
    && providerChanged <= localChanged;
}

export function managedCalendarEventNeedsReview(task, event) {
  if (!event || event.status === 'cancelled' || !calendarEventOwnedByTask(event, task)) return true;
  const current = managedCalendarSnapshot(event);
  const baseline = task?.metadata?.calendar_managed_snapshot;
  if (baseline) return !managedCalendarSnapshotsEqual(current, baseline);
  if (managedCalendarSnapshotsEqual(current, taskCalendarSnapshot(task))) return false;
  // Legacy managed events may predate the first ETag checkpoint. A provider
  // version older than the local reschedule is the expected pre-update state.
  return !providerEventPredatesLocalChange(task, event);
}

export function managedCalendarChangedFields(task, event) {
  const baseline = task?.metadata?.calendar_managed_snapshot || taskCalendarSnapshot(task);
  const current = managedCalendarSnapshot(event);
  return Object.keys(current).filter(key => current[key] !== baseline?.[key]);
}

export function calendarEventHasDeleteSensitiveChanges(event = {}) {
  const reminders = event.reminders || {};
  return Boolean(
    (event.attendees || []).length
    || (event.attachments || []).length
    || (event.recurrence || []).length
    || event.conferenceData
    || event.colorId
    || event.visibility
    || event.transparency
    || event.source
    || event.anyoneCanAddSelf
    || event.guestsCanInviteOthers === false
    || event.guestsCanModify
    || event.guestsCanSeeOtherGuests === false
    || reminders.useDefault === false
    || (reminders.overrides || []).length
  );
}

export function calendarMetadataForEvent(metadata = {}, event = {}, calendarId = 'primary') {
  return {
    ...metadata,
    calendar_id: calendarId || 'primary',
    calendar_link: event.htmlLink || metadata.calendar_link || null,
    calendar_etag: event.etag || null,
    calendar_etag_event_id: event.id || null,
    calendar_managed_snapshot: managedCalendarSnapshot(event),
    calendar_managed_updated_at: event.updated || new Date().toISOString()
  };
}

function priorStatus(task) {
  return task.metadata?.external_calendar_previous_status || task.status || 'assigned';
}

function taskVersionFilter(task, eventId) {
  let query = `id=eq.${encodeURIComponent(task.id)}&calendar_event_id=eq.${encodeURIComponent(eventId)}&status=in.(assigned,confirmed,reschedule_requested)`;
  if (task.scheduled_start) query += `&scheduled_start=eq.${encodeURIComponent(task.scheduled_start)}`;
  if (task.scheduled_end) query += `&scheduled_end=eq.${encodeURIComponent(task.scheduled_end)}`;
  return query;
}

async function taskMap(env, userId) {
  const rows = await supa(env, 'tasks', {
    query: `select=*&calendar_owner_user_id=eq.${encodeURIComponent(userId)}&calendar_event_id=not.is.null&deleted_at=is.null&archived_at=is.null&status=in.(assigned,confirmed,reschedule_requested)&limit=1000`
  });
  return new Map(reviewableCalendarTasks(rows).map(task => [task.calendar_event_id, task]));
}

export async function reconcileManagedCalendarEvent(env, task, event, { forceReview = false, reason = 'inbound_sync' } = {}) {
  if (!event?.id || !task || !calendarChangeReviewable(task.status)) return { changed: false, reviewed: false };
  const oldStart = iso(task.scheduled_start);
  const oldEnd = iso(task.scheduled_end);
  const newStart = eventTime(event.start);
  const newEnd = eventTime(event.end);
  const now = new Date().toISOString();
  const previous = priorStatus(task);
  const duplicateVersion = event.etag
    && task.metadata?.external_calendar_etag === event.etag
    && task.status === 'reschedule_requested';
  if (duplicateVersion) return { changed: false, reviewed: true };

  if (event.status === 'cancelled') {
    const metadata = {
      ...(task.metadata || {}),
      external_calendar_previous_status: previous,
      external_calendar_cancelled: true,
      external_calendar_changed_at: now,
      external_calendar_event_id: event.id,
      external_calendar_etag: event.etag || null,
      external_calendar_changed_fields: managedCalendarChangedFields(task, event),
      external_calendar_reason: reason
    };
    const updated = await supa(env, 'tasks', {
      method: 'PATCH',
      query: taskVersionFilter(task, event.id),
      payload: {
        status: 'reschedule_requested',
        calendar_event_id: null,
        next_action: 'The connected Google Calendar event was cancelled externally. Review, reschedule or cancel this Northlight booking.',
        metadata
      }
    });
    if (!updated?.length) return { changed: false, reviewed: false };
    await logEvent(env, {
      task_id: task.id,
      type: 'calendar_cancelled_externally',
      message: 'Google Calendar event was cancelled externally. Northlight kept the business booking intact for review.',
      detail: { event_id: event.id, previous_status: previous, etag: event.etag || null, reason }
    });
    return { changed: true, reviewed: true, task: updated[0] };
  }

  const timeChanged = (newStart && newStart !== oldStart) || (newEnd && newEnd !== oldEnd);
  const managedChanged = managedCalendarEventNeedsReview(task, event);
  if (timeChanged || managedChanged || forceReview) {
    const proposed = { start: newStart, end: newEnd, event_id: event.id };
    const metadata = {
      ...(task.metadata || {}),
      external_calendar_previous_status: previous,
      external_calendar_changed_at: now,
      external_calendar_html_link: event.htmlLink || task.metadata?.calendar_link || null,
      external_calendar_proposed_schedule: proposed,
      external_calendar_etag: event.etag || null,
      external_calendar_changed_fields: managedCalendarChangedFields(task, event),
      external_calendar_reason: reason
    };
    const nextAction = timeChanged
      ? 'Google Calendar proposes a different shoot time. Review it in Northlight before changing the booking.'
      : 'Google Calendar contains external changes to this managed event. Review them before Northlight updates the event.';
    const updated = await supa(env, 'tasks', {
      method: 'PATCH',
      query: taskVersionFilter(task, event.id),
      payload: { status: 'reschedule_requested', next_action: nextAction, metadata }
    });
    if (!updated?.length) return { changed: false, reviewed: false };
    await logEvent(env, {
      task_id: task.id,
      type: timeChanged ? 'calendar_time_change_requested_externally' : 'calendar_managed_fields_changed_externally',
      message: timeChanged
        ? 'Google Calendar time changed externally. Northlight preserved its booked time and requires review.'
        : 'Google Calendar managed fields changed externally. Northlight preserved both versions and requires review.',
      detail: {
        current: { start: oldStart, end: oldEnd },
        proposed,
        event_id: event.id,
        previous_status: previous,
        etag: event.etag || null,
        reason
      }
    });
    return { changed: true, reviewed: true, task: updated[0] };
  }

  const metadata = calendarMetadataForEvent(task.metadata || {}, event, task.metadata?.calendar_id || 'primary');
  if (event.etag === task.metadata?.calendar_etag
    && managedCalendarSnapshotsEqual(metadata.calendar_managed_snapshot, task.metadata?.calendar_managed_snapshot)) {
    return { changed: false, reviewed: false, task };
  }
  const updated = await supa(env, 'tasks', {
    method: 'PATCH',
    query: taskVersionFilter(task, event.id),
    payload: { metadata }
  });
  return { changed: Boolean(updated?.length), reviewed: false, task: updated?.[0] || task };
}

const asObject = value => Array.isArray(value) ? value[0] : value;

async function rpc(env, name, payload) {
  return asObject(await supa(env, `rpc/${name}`, { method: 'POST', payload }));
}

export function safeCalendarError(error) {
  const message = String(error?.message || '');
  const provider = message.match(/^(?:google|oauth)_[0-9]{1,3}(?:_[a-z0-9_]{1,96})?$/i)?.[0];
  if (provider) return provider.toLowerCase().slice(0, 160);
  return SAFE_CALENDAR_ERRORS.find(code => message.includes(code)) || 'calendar_sync_failed';
}

function isGoogleGone(error) {
  return error?.status === 410 || error?.providerStatus === 410 || /^google_410(?:_|$)/.test(String(error?.message || ''));
}

function deadlineExceeded(clock, deadline) {
  return clock() >= deadline;
}

async function listCalendarPages(env, userId, calendarId, params, map, {
  clock,
  deadline,
  maxPages = CALENDAR_MAX_PAGES
}) {
  let pageToken = null;
  let nextSyncToken = null;
  let count = 0;
  let matched = 0;
  let changed = 0;
  let pages = 0;
  do {
    if (deadlineExceeded(clock, deadline)) throw new Error('calendar_sync_budget_exceeded');
    if (pages >= maxPages) throw new Error('calendar_sync_page_limit');
    const query = new URLSearchParams({ ...params, maxResults: String(CALENDAR_PAGE_SIZE) });
    if (pageToken) query.set('pageToken', pageToken);
    const data = await userGoogleRequest(
      env,
      userId,
      `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${query}`,
      { signal: AbortSignal.timeout(Math.max(1000, Math.min(15000, deadline - clock()))) }
    );
    pages += 1;
    if (!data || typeof data !== 'object' || !Array.isArray(data.items || [])) {
      throw new Error('calendar_sync_response_invalid');
    }
    for (const event of data.items || []) {
      if (deadlineExceeded(clock, deadline)) throw new Error('calendar_sync_budget_exceeded');
      count += 1;
      const task = map.get(event?.id);
      if (!task) continue;
      matched += 1;
      const result = await reconcileManagedCalendarEvent(env, task, event);
      if (result.changed) changed += 1;
      if (event.status === 'cancelled') map.delete(event.id);
      else if (result.task) map.set(event.id, result.task);
    }
    pageToken = data.nextPageToken || null;
    if (pageToken && (typeof pageToken !== 'string' || pageToken.length > 4096)) {
      throw new Error('calendar_sync_response_invalid');
    }
    if (data.nextSyncToken !== undefined && data.nextSyncToken !== null) {
      if (typeof data.nextSyncToken !== 'string' || !data.nextSyncToken || data.nextSyncToken.length > 16384) {
        throw new Error('calendar_sync_response_invalid');
      }
      nextSyncToken = data.nextSyncToken;
    }
  } while (pageToken);
  if (!nextSyncToken) throw new Error('calendar_sync_token_missing');
  return { count, matched, changed, pages, nextSyncToken };
}

async function advanceCalendarSync(env, tenantId, userId, calendarId, owner, generation, {
  expectedSyncToken,
  syncToken,
  kind,
  syncedAt,
  lastError = null
}) {
  return rpc(env, 'northlight_advance_calendar_sync', {
    p_tenant_id: tenantId,
    p_user_id: userId,
    p_calendar_id: calendarId,
    p_owner: owner,
    p_generation: Number(generation),
    p_expected_sync_token: expectedSyncToken || null,
    p_sync_token: syncToken || null,
    p_sync_kind: kind,
    p_synced_at: syncedAt,
    p_last_error: lastError,
    p_lease_seconds: CALENDAR_SYNC_LEASE_SECONDS
  });
}

async function finishCalendarSync(env, tenantId, userId, calendarId, owner, generation, lastError = null) {
  return rpc(env, 'northlight_finish_calendar_sync', {
    p_tenant_id: tenantId,
    p_user_id: userId,
    p_calendar_id: calendarId,
    p_owner: owner,
    p_generation: Number(generation),
    p_last_error: lastError
  });
}

async function runCalendarSync(env, userId, calendarId = 'primary', {
  forceFull = false,
  clock = Date.now,
  runtimeMs = CALENDAR_MAX_RUNTIME_MS,
  maxPages = CALENDAR_MAX_PAGES
} = {}) {
  const selectedCalendar = String(calendarId || 'primary');
  const currentTenant = await tenant(env);
  const owner = crypto.randomUUID();
  const claim = await rpc(env, 'northlight_claim_calendar_sync', {
    p_tenant_id: currentTenant.id,
    p_user_id: userId,
    p_calendar_id: selectedCalendar,
    p_owner: owner,
    p_lease_seconds: CALENDAR_SYNC_LEASE_SECONDS
  });
  if (!claim?.claimed) {
    return { busy: true, retryAfterSeconds: 30, connectionGeneration: Number(claim?.connection_generation || 0) };
  }

  const generation = Number(claim.generation);
  const deadline = clock() + Math.max(1000, Math.min(Number(runtimeMs) || CALENDAR_MAX_RUNTIME_MS, CALENDAR_MAX_RUNTIME_MS));
  let expectedSyncToken = claim.sync_token || null;
  let syncKind = expectedSyncToken && !forceFull ? 'incremental' : 'full';
  try {
    if (forceFull && expectedSyncToken) {
      await advanceCalendarSync(env, currentTenant.id, userId, selectedCalendar, owner, generation, {
        expectedSyncToken,
        syncToken: null,
        kind: 'reset',
        syncedAt: new Date(clock()).toISOString(),
        lastError: 'calendar_sync_token_invalidated'
      });
      expectedSyncToken = null;
    }

    const map = await taskMap(env, userId);
    let result;
    try {
      const params = expectedSyncToken
        ? { showDeleted: 'true', singleEvents: 'false', syncToken: expectedSyncToken }
        : {
          showDeleted: 'true',
          singleEvents: 'false',
          timeMin: new Date(clock() - 90 * 86400000).toISOString()
        };
      result = await listCalendarPages(env, userId, selectedCalendar, params, map, { clock, deadline, maxPages });
    } catch (error) {
      if (!expectedSyncToken || !isGoogleGone(error)) throw error;
      await advanceCalendarSync(env, currentTenant.id, userId, selectedCalendar, owner, generation, {
        expectedSyncToken,
        syncToken: null,
        kind: 'reset',
        syncedAt: new Date(clock()).toISOString(),
        lastError: 'calendar_sync_token_invalidated'
      });
      expectedSyncToken = null;
      syncKind = 'full';
      result = await listCalendarPages(env, userId, selectedCalendar, {
        showDeleted: 'true',
        singleEvents: 'false',
        timeMin: new Date(clock() - 90 * 86400000).toISOString()
      }, map, { clock, deadline, maxPages });
    }

    const syncedAt = new Date(clock()).toISOString();
    await advanceCalendarSync(env, currentTenant.id, userId, selectedCalendar, owner, generation, {
      expectedSyncToken,
      syncToken: result.nextSyncToken,
      kind: syncKind,
      syncedAt,
      lastError: null
    });
    await finishCalendarSync(env, currentTenant.id, userId, selectedCalendar, owner, generation, null);
    try {
      await logSync(env, 'google', 'inbound', 'calendar', `${syncKind}_sync`, {
        payload: { count: result.count, matched: result.matched, changed: result.changed, pages: result.pages }
      });
    } catch {}
    return {
      ...result,
      busy: false,
      kind: syncKind,
      connectionGeneration: Number(claim.connection_generation || 0)
    };
  } catch (error) {
    const safeError = safeCalendarError(error);
    try {
      await finishCalendarSync(env, currentTenant.id, userId, selectedCalendar, owner, generation, safeError);
    } catch {}
    try {
      await logSync(env, 'google', 'inbound', 'calendar', 'sync_failed', {
        status: 'failed',
        error: safeError,
        payload: {}
      });
    } catch {}
    throw error;
  }
}

export async function fullCalendarSync(env, userId, calendarId = 'primary', options = {}) {
  return runCalendarSync(env, userId, calendarId, { ...options, forceFull: true });
}

export async function incrementalCalendarSync(env, userId, calendarId = 'primary', options = {}) {
  return runCalendarSync(env, userId, calendarId, { ...options, forceFull: false });
}

function randomWatchToken() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function watchExpiration(data, clock) {
  const value = Number(data?.expiration);
  if (!Number.isFinite(value) || value <= clock() + 60000 || value > clock() + 30 * 86400000) {
    throw new Error('calendar_watch_activation_invalid');
  }
  return new Date(value).toISOString();
}

function watchTimeout(clock, deadline, cap = 15000) {
  const remaining = deadline - clock();
  if (remaining < 1000) throw new Error('calendar_sync_budget_exceeded');
  return Math.max(1000, Math.min(cap, remaining));
}

async function stopProviderChannel(env, userId, channel, { clock = Date.now, deadline = clock() + 15000 } = {}) {
  if (!channel?.channel_id || !channel?.resource_id) return { stopped: false };
  try {
    await userGoogleRequest(env, userId, '/calendar/v3/channels/stop', {
      method: 'POST',
      body: JSON.stringify({ id: channel.channel_id, resourceId: channel.resource_id }),
      signal: AbortSignal.timeout(watchTimeout(clock, deadline))
    });
  } catch (error) {
    if (![404, 410].includes(error?.status || error?.providerStatus)) throw error;
  }
  return { stopped: true };
}

async function stopRetiredChannel(env, tenantId, userId, channel, timing) {
  await stopProviderChannel(env, userId, channel, timing);
  return rpc(env, 'northlight_stop_calendar_watch_channel', {
    p_tenant_id: tenantId,
    p_user_id: userId,
    p_channel_id: channel.channel_id,
    p_resource_id: channel.resource_id
  });
}

export async function enqueueCalendarSync(env, {
  userId,
  calendarId = 'primary',
  trigger = 'webhook'
}) {
  if (!env.TASK_HANDOFF_QUEUE || typeof env.TASK_HANDOFF_QUEUE.send !== 'function') {
    throw new Error('calendar_sync_queue_unavailable');
  }
  const job = {
    version: 1,
    type: 'calendar_sync',
    jobId: crypto.randomUUID(),
    userId,
    calendarId: calendarId || 'primary',
    trigger: ['webhook', 'watch_activation', 'maintenance'].includes(trigger) ? trigger : 'webhook'
  };
  await env.TASK_HANDOFF_QUEUE.send(job, { contentType: 'json' });
  return job;
}

export async function startCalendarWatch(env, userId, calendarId, origin, {
  clock = Date.now,
  syncMode = 'inline',
  runtimeMs = CALENDAR_MAX_RUNTIME_MS
} = {}) {
  const selectedCalendar = String(calendarId || 'primary');
  const canonicalOrigin = configuredOAuthOrigin(env);
  if (String(origin || '').replace(/\/$/, '') !== canonicalOrigin) {
    throw new Error('calendar_watch_origin_mismatch');
  }
  const deadline = clock() + Math.max(1000, Math.min(Number(runtimeMs) || CALENDAR_MAX_RUNTIME_MS, CALENDAR_MAX_RUNTIME_MS));
  const currentTenant = await tenant(env);
  const owner = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  const webhookToken = randomWatchToken();
  const tokenHash = await sha256Hex(webhookToken);
  const claim = await rpc(env, 'northlight_claim_calendar_watch', {
    p_tenant_id: currentTenant.id,
    p_user_id: userId,
    p_calendar_id: selectedCalendar,
    p_owner: owner,
    p_channel_id: channelId,
    p_token_hash: tokenHash,
    p_lease_seconds: CALENDAR_WATCH_LEASE_SECONDS
  });
  if (!claim?.claimed) {
    return { busy: true, current: claim?.current || null, connectionGeneration: Number(claim?.connection_generation || 0) };
  }

  let providerChannel = null;
  let activated = false;
  try {
    const requestedExpiration = clock() + CALENDAR_WATCH_LIFETIME_MS;
    const data = await userGoogleRequest(
      env,
      userId,
      `/calendar/v3/calendars/${encodeURIComponent(selectedCalendar)}/events/watch`,
      {
        method: 'POST',
        body: JSON.stringify({
          id: channelId,
          type: 'web_hook',
        address: `${canonicalOrigin}/webhooks/google-calendar`,
          token: webhookToken,
          expiration: String(requestedExpiration)
        }),
        signal: AbortSignal.timeout(watchTimeout(clock, deadline))
      }
    );
    if (data?.id !== channelId
      || !data?.resourceId
      || String(data.resourceId).length > 1024
      || /[\u0000-\u001f\u007f]/.test(String(data.resourceId))) {
      throw new Error('calendar_watch_activation_invalid');
    }
    const expiresAt = watchExpiration(data, clock);
    providerChannel = { channel_id: channelId, resource_id: String(data.resourceId) };
    const activation = await rpc(env, 'northlight_activate_calendar_watch', {
      p_tenant_id: currentTenant.id,
      p_user_id: userId,
      p_calendar_id: selectedCalendar,
      p_owner: owner,
      p_generation: Number(claim.generation),
      p_channel_id: channelId,
      p_resource_id: providerChannel.resource_id,
      p_expires_at: expiresAt
    });
    activated = true;
    if (activation?.active?.channel_id !== channelId
      || activation?.active?.resource_id !== providerChannel.resource_id) {
      throw new Error('calendar_watch_activation_invalid');
    }
    let retiredPending = 0;
    const retiredChannels = Array.isArray(activation?.retired_channels) ? activation.retired_channels : [];
    for (const retired of retiredChannels) {
      try {
        await stopRetiredChannel(env, currentTenant.id, userId, retired, { clock, deadline });
      } catch {
        retiredPending += 1;
      }
    }
    let sync;
    if (syncMode === 'enqueue') {
      try {
        sync = await enqueueCalendarSync(env, { userId, calendarId: selectedCalendar, trigger: 'watch_activation' });
      } catch {
        sync = await incrementalCalendarSync(env, userId, selectedCalendar, {
          clock,
          runtimeMs: Math.max(1000, deadline - clock())
        });
      }
    } else {
      try {
        sync = await incrementalCalendarSync(env, userId, selectedCalendar, {
          clock,
          runtimeMs: Math.max(1000, deadline - clock())
        });
      } catch (syncError) {
        try {
          sync = await enqueueCalendarSync(env, { userId, calendarId: selectedCalendar, trigger: 'watch_activation' });
        } catch {
          throw syncError;
        }
      }
    }
    try {
      await logSync(env, 'google', 'outbound', 'calendar', 'watch_started', {
        payload: { renewed: Boolean(claim.current), retiredPending, expiresAt }
      });
    } catch {}
    return {
      id: channelId,
      resourceId: providerChannel.resource_id,
      busy: false,
      expiration: String(new Date(expiresAt).getTime()),
      expiresAt,
      sync,
      retiredPending,
      connectionGeneration: Number(claim.connection_generation || 0)
    };
  } catch (error) {
    if (providerChannel && !activated) {
      try { await stopProviderChannel(env, userId, providerChannel, { clock, deadline }); } catch {}
    }
    if (!activated) {
      try {
        await rpc(env, 'northlight_fail_calendar_watch', {
          p_tenant_id: currentTenant.id,
          p_user_id: userId,
          p_calendar_id: selectedCalendar,
          p_owner: owner,
          p_generation: Number(claim.generation),
          p_channel_id: channelId,
          p_last_error: safeCalendarError(error)
        });
      } catch {}
    }
    if (activated) {
      try {
        await logSync(env, 'google', 'outbound', 'calendar', 'watch_sync_failed', {
          status: 'failed', error: safeCalendarError(error), payload: {}
        });
      } catch {}
    }
    throw error;
  }
}

export async function calendarChannelForNotification(env, {
  channelId,
  resourceId,
  token
}) {
  if (!channelId || channelId.length > 256
    || !resourceId || resourceId.length > 1024
    || !token || token.length < 16 || token.length > 512) return null;
  const currentTenant = await tenant(env);
  return rpc(env, 'northlight_read_calendar_watch_channel', {
    p_tenant_id: currentTenant.id,
    p_channel_id: channelId,
    p_resource_id: resourceId,
    p_token_hash: await sha256Hex(token)
  });
}

export function calendarRenewalLeadMs(userId, calendarId = 'primary') {
  const input = `${userId}:${calendarId}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return CALENDAR_RENEW_BASE_MS
    + Math.floor((hash / 0x100000000) * CALENDAR_RENEW_JITTER_MS);
}

export function calendarWatchNeedsRenewal(expiresAt, userId, calendarId = 'primary', now = Date.now()) {
  const expires = Date.parse(expiresAt || '');
  return !Number.isFinite(expires) || expires <= now + calendarRenewalLeadMs(userId, calendarId);
}

export async function maintainCalendarWatches(env, origin, {
  clock = Date.now,
  limit = 10,
  runtimeMs = CALENDAR_MAX_RUNTIME_MS
} = {}) {
  const deadline = clock() + Math.max(1000, Math.min(Number(runtimeMs) || CALENDAR_MAX_RUNTIME_MS, CALENDAR_MAX_RUNTIME_MS));
  const currentTenant = await tenant(env);
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 10, 50));
  const listed = await supa(env, 'rpc/northlight_list_calendar_maintenance', {
    method: 'POST',
    payload: {
      p_tenant_id: currentTenant.id,
      p_limit: Math.min(200, Math.max(boundedLimit, boundedLimit * 4)),
      p_now: new Date(clock()).toISOString()
    }
  });
  const candidates = Array.isArray(listed?.items) ? listed.items.slice(0, 200) : [];
  let checked = 0;
  let renewed = 0;
  let synced = 0;
  let busy = 0;
  let failed = 0;
  for (const profile of candidates) {
    if (deadlineExceeded(clock, deadline) || renewed + synced + failed + busy >= boundedLimit) break;
    const calendarId = profile.calendar_id || 'primary';
    checked += 1;
    try {
      const result = calendarWatchNeedsRenewal(profile.watch_expires_at, profile.user_id, calendarId, clock())
        ? await startCalendarWatch(env, profile.user_id, calendarId, origin, {
          clock,
          syncMode: 'enqueue',
          runtimeMs: Math.max(1000, deadline - clock())
        })
        : profile.sync_due
          ? await incrementalCalendarSync(env, profile.user_id, calendarId, {
            clock,
            runtimeMs: Math.max(1000, deadline - clock())
          })
          : null;
      if (!result) continue;
      if (result.busy) busy += 1;
      else if (result.id) renewed += 1;
      else synced += 1;
    } catch {
      failed += 1;
    }
  }
  return { checked, renewed, synced, busy, failed };
}
