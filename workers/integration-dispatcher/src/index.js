import {
  dispatchDueSystemJobs,
  runCalendarCleanup,
  runTaskHandoff,
} from '../../../functions/_lib/task-handoffs.js';
import { syncDropbox } from '../../../functions/_lib/dropbox-sync.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function log(level, fields) {
  const payload = { level, service: 'integration-dispatcher', ...fields };
  if (level === 'error') console.error(JSON.stringify(payload));
  else if (level === 'warn') console.warn(JSON.stringify(payload));
  else console.log(JSON.stringify(payload));
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
  if (value.type === 'task_handoff') {
    return typeof value.taskId === 'string' && ['dropbox', 'calendar', 'email', 'calendar_cancel'].includes(value.kind);
  }
  return value.type === 'calendar_cleanup' && typeof value.taskId === 'string';
}

export function createIntegrationDispatcher({
  dispatch = dispatchDueSystemJobs,
  runHandoff = runTaskHandoff,
  runCleanup = runCalendarCleanup,
  runDropbox = syncDropbox,
} = {}) {
  return {
    async fetch() {
      return new Response('Not found', { status: 404 });
    },

    async scheduled(event, env, ctx) {
      const correlationId = crypto.randomUUID();
      ctx.waitUntil((async () => {
        try {
          const result = await dispatch(env, { limit: 50 });
          log('info', { event: 'scheduled_dispatch', correlationId, scheduledTime: event.scheduledTime, ...result });
        } catch (error) {
          log('error', { event: 'scheduled_dispatch_failed', correlationId, error: String(error?.message || error) });
          throw error;
        }
      })());
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
              : await runDropbox(env, { webhookAt: job.webhookAt || null });
          if (job.type === 'dropbox_sync' && result?.busy) {
            const delaySeconds = Math.min(300, Math.max(15, Number(result.retryAfterSeconds || 60)));
            log('info', { event: 'dropbox_sync_busy', correlationId, delaySeconds });
            message.retry({ delaySeconds });
            continue;
          }
          log('info', { event: 'job_processed', correlationId, type: job.type, kind: job.kind || null, jobId: job.jobId, status: result?.status || 'unknown' });
          message.ack();
        } catch (error) {
          if (message.body?.type === 'dropbox_sync') {
            const delaySeconds = Math.min(300, 30 * Math.max(1, Number(message.attempts || 1)));
            log('error', { event: 'dropbox_sync_retry', correlationId, delaySeconds, error: String(error?.message || error) });
            message.retry({ delaySeconds });
            continue;
          }
          // The Postgres outbox remains authoritative and will redispatch after its
          // durable retry time. Ack here to avoid a second, competing retry clock.
          log('error', { event: 'job_deferred_to_outbox', correlationId, error: String(error?.message || error) });
          message.ack();
        }
      }
    },
  };
}

export default createIntegrationDispatcher();
