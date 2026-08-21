import {
  calendarChannelForNotification,
  enqueueCalendarSync
} from '../_lib/calendar-sync.js';

const RESOURCE_STATES = new Set(['sync', 'exists', 'not_exists']);

function header(request, name, maxLength) {
  const value = String(request.headers.get(name) || '');
  if (!value || value.length > maxLength || /[\r\n]/.test(value)) return null;
  return value;
}

export async function onRequestPost({ request, env }) {
  const channelId = header(request, 'x-goog-channel-id', 256);
  const resourceId = header(request, 'x-goog-resource-id', 1024);
  const resourceState = header(request, 'x-goog-resource-state', 64);
  const token = header(request, 'x-goog-channel-token', 512);
  if (!channelId || !resourceId || !resourceState || !token || token.length < 16) {
    return new Response('invalid notification', { status: 400 });
  }
  if (!RESOURCE_STATES.has(resourceState)) {
    return new Response('unsupported notification', { status: 400 });
  }

  let channel;
  try {
    channel = await calendarChannelForNotification(env, { channelId, resourceId, token });
  } catch {
    return new Response('verification unavailable', { status: 503, headers: { 'retry-after': '30' } });
  }
  if (!channel) {
    // Google can deliver the initial sync notification before the watch-create
    // response is available to activate its pre-registered channel. It has no
    // mutation payload, and startCalendarWatch explicitly syncs after activate.
    if (resourceState === 'sync') return new Response(null, { status: 204 });
    return new Response('unknown notification', { status: 404 });
  }

  try {
    await enqueueCalendarSync(env, {
      userId: channel.user_id,
      calendarId: channel.calendar_id || 'primary',
      trigger: 'webhook'
    });
  } catch {
    return new Response('queue unavailable', { status: 503, headers: { 'retry-after': '30' } });
  }
  return new Response(null, { status: 204 });
}
