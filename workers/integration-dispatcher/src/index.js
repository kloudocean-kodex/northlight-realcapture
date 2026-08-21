import {
  dispatchDueSystemJobs,
  runCalendarCleanup,
  runTaskHandoff,
} from '../../../functions/_lib/task-handoffs.js';
import { syncDropbox } from '../../../functions/_lib/dropbox-sync.js';
import {
  incrementalCalendarSync,
  maintainCalendarWatches,
  safeCalendarError,
} from '../../../functions/_lib/calendar-sync.js';
import { configuredOAuthOrigin } from '../../../functions/_lib/oauth-security.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CALENDAR_TRIGGERS = new Set(['webhook', 'watch_activation', 'maintenance']);
const CALENDAR_MAINTENANCE_LIMIT = 10;
const CALENDAR_MAINTENANCE_RUNTIME_MS = 20_000;

function log(level, fields) {
  const payload = { level, service: 'integration-dispatcher', ...fields };
  if (level === 'error') console.error(JSON.stringify(payload));
  else if (level === 'warn') console.warn(JSON.stringify(payload));
  else console.log(JSON.stringify(payload));
}

function validCalendarId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 1024
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isSystemJob(value) {
  if (!value || value.version !== 1 || typeof value.jobId !== 'string') return false;
  if (value.type === 'dropbox_sync') {
    return UUID.test(value.jobId) && (
      value.webhookAt === null || value.webhookAt === undefined || (
      typeof value.webhookAt === 'string'
      && value.webhookAt.length <= 40
      && Number.isFinite(Date.parse(value.webhookAt))
      )
    );
  }
  if (value.type === 'calendar_sync') {
    return UUID.test(value.jobId)
      && UUID.test(String(value.userId || ''))
      && validCalendarId(value.calendarId)
      && CALENDAR_TRIGGERS.has(value.trigger);
  }
  if (value.type === 'task_handoff') {
    return typeof value.taskId === 'string' && ['dropbox', 'calendar', 'email', 'calendar_cancel'].includes(value.kind);
  }
  return value.type === 'calendar_cleanup' && typeof value.taskId === 'string';
}

function boundedRetryDelay(result, attempts, fallback = 30) {
  const requested = Number(result?.retryAfterSeconds);
  const seconds = Number.isFinite(requested) && requested > 0
    ? requested
    : fallback * Math.max(1, Number(attempts || 1));
  return Math.min(300, Math.max(15, seconds));
}

export function createIntegrationDispatcher({
  dispatch = dispatchDueSystemJobs,
  runHandoff = runTaskHandoff,
  runCleanup = runCalendarCleanup,
  runDropbox = syncDropbox,
  runCalendar = incrementalCalendarSync,
  maintainWatches = maintainCalendarWatches,
  resolveOrigin = configuredOAuthOrigin,
} = {}) {
  return {
    async fetch() {
      return new Response('Not found', { status: 404 });
    },

    async scheduled(event, env) {
      const correlationId = crypto.randomUUID();
      let origin;
      try {
        origin = resolveOrigin(env);
      } catch {
        log('error', { event: 'scheduled_origin_invalid', correlationId });
        throw new Error('scheduled_origin_invalid');
      }

      const [dispatchResult, maintenanceResult] = await Promise.allSettled([
        dispatch(env, { limit: 50 }),
        maintainWatches(env, origin, {
          limit: CALENDAR_MAINTENANCE_LIMIT,
          runtimeMs: CALENDAR_MAINTENANCE_RUNTIME_MS,
        }),
      ]);

      if (dispatchResult.status === 'rejected') {
        log('error', { event: 'scheduled_dispatch_failed', correlationId });
      }
      if (maintenanceResult.status === 'rejected') {
        log('error', {
          event: 'calendar_watch_maintenance_failed',
          correlationId,
          error: safeCalendarError(maintenanceResult.reason),
        });
      }
      if (dispatchResult.status === 'rejected' || maintenanceResult.status === 'rejected') {
        throw new Error('scheduled_maintenance_failed');
      }

      log('info', {
        event: 'scheduled_dispatch',
        correlationId,
        scheduledTime: event.scheduledTime,
        cron: event.cron || null,
        dispatch: dispatchResult.value,
        calendarMaintenance: maintenanceResult.value,
      });
    },

    async queue(batch, env) {
      for (const message of batch.messages) {
        const correlationId = message.id || crypto.randomUUID();
        if (!isSystemJob(message.body)) {
          log('warn', { event: 'invalid_message', correlationId });
          message.ack();
          continue;
        }

        try {
          const job = message.body;
          const result = job.type === 'task_handoff'
            ? await runHandoff(env, job.taskId, job.kind)
            : job.type === 'calendar_cleanup'
              ? await runCleanup(env, job.jobId)
              : job.type === 'calendar_sync'
                ? await runCalendar(env, job.userId, job.calendarId)
                : await runDropbox(env, { webhookAt: job.webhookAt || null });

          if ((job.type === 'dropbox_sync' || job.type === 'calendar_sync') && result?.busy) {
            const delaySeconds = boundedRetryDelay(result, message.attempts, 60);
            log('info', { event: `${job.type}_busy`, correlationId, delaySeconds });
            message.retry({ delaySeconds });
            continue;
          }

          log('info', {
            event: 'job_processed',
            correlationId,
            type: job.type,
            kind: job.kind || null,
            jobId: job.jobId,
            status: result?.status || result?.kind || 'unknown',
          });
          message.ack();
        } catch (error) {
          if (message.body?.type === 'dropbox_sync' || message.body?.type === 'calendar_sync') {
            const delaySeconds = boundedRetryDelay(null, message.attempts, 30);
            log('error', {
              event: `${message.body.type}_retry`,
              correlationId,
              delaySeconds,
              error: message.body.type === 'calendar_sync'
                ? safeCalendarError(error)
                : 'dropbox_sync_failed',
            });
            message.retry({ delaySeconds });
            continue;
          }
          // The Postgres outbox remains authoritative and will redispatch after its
          // durable retry time. Ack here to avoid a second, competing retry clock.
          log('error', { event: 'job_deferred_to_outbox', correlationId });
          message.ack();
        }
      }
    },
  };
}

export default createIntegrationDispatcher();
