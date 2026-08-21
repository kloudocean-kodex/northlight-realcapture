import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createIntegrationDispatcher, isSystemJob } from '../workers/integration-dispatcher/src/index.js';

const DROPBOX_JOB_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];
const CALENDAR_USER_ID = '44444444-4444-4444-8444-444444444444';

function message(body, id = crypto.randomUUID()) {
  const state = { acked: 0, retried: 0, retryOptions: [] };
  return {
    id,
    attempts: 1,
    body,
    ack() { state.acked += 1; },
    retry(options) { state.retried += 1; state.retryOptions.push(options); },
    state,
  };
}

test('system-job queue schema rejects malformed or over-privileged messages', () => {
  assert.equal(isSystemJob({ version: 1, type: 'task_handoff', jobId: 'h1', taskId: 't1', kind: 'calendar' }), true);
  assert.equal(isSystemJob({ version: 1, type: 'calendar_cleanup', jobId: 'c1', taskId: 't1' }), true);
  assert.equal(isSystemJob({ version: 1, type: 'dropbox_sync', jobId: DROPBOX_JOB_IDS[0], webhookAt: '2026-08-21T12:00:00.000Z' }), true);
  assert.equal(isSystemJob({
    version: 1,
    type: 'calendar_sync',
    jobId: DROPBOX_JOB_IDS[1],
    userId: CALENDAR_USER_ID,
    calendarId: 'primary',
    trigger: 'webhook',
  }), true);
  assert.equal(isSystemJob({ version: 1, type: 'dropbox_sync', jobId: 'not-a-uuid', webhookAt: null }), false);
  assert.equal(isSystemJob({ version: 1, type: 'dropbox_sync', jobId: DROPBOX_JOB_IDS[0], webhookAt: 'not-a-date' }), false);
  assert.equal(isSystemJob({
    version: 1,
    type: 'calendar_sync',
    jobId: DROPBOX_JOB_IDS[1],
    userId: 'not-a-user-uuid',
    calendarId: 'primary',
    trigger: 'webhook',
  }), false);
  assert.equal(isSystemJob({
    version: 1,
    type: 'calendar_sync',
    jobId: DROPBOX_JOB_IDS[1],
    userId: CALENDAR_USER_ID,
    calendarId: 'primary\nforged',
    trigger: 'webhook',
  }), false);
  assert.equal(isSystemJob({
    version: 1,
    type: 'calendar_sync',
    jobId: DROPBOX_JOB_IDS[1],
    userId: CALENDAR_USER_ID,
    calendarId: 'primary',
    trigger: 'arbitrary_fetch',
  }), false);
  assert.equal(isSystemJob({ version: 1, type: 'task_handoff', jobId: 'h1', taskId: 't1', kind: 'arbitrary_fetch' }), false);
  assert.equal(isSystemJob({ version: 2, type: 'task_handoff', jobId: 'h1', taskId: 't1', kind: 'email' }), false);
  assert.equal(isSystemJob(null), false);
});

test('Dropbox queue work retries with bounded delay while completed work is acknowledged', async () => {
  const seen = [];
  const dispatcher = createIntegrationDispatcher({
    runDropbox: async (_env, options) => {
      seen.push(options);
      if (seen.length === 1) throw new Error('provider unavailable');
      if (seen.length === 2) return { busy: true, retryAfterSeconds: 9999 };
      return { status: 'processed' };
    },
  });
  const messages = [
    message({ version: 1, type: 'dropbox_sync', jobId: DROPBOX_JOB_IDS[0], webhookAt: '2026-08-21T12:00:00.000Z' }, 'd1'),
    message({ version: 1, type: 'dropbox_sync', jobId: DROPBOX_JOB_IDS[1], webhookAt: null }, 'd2'),
    message({ version: 1, type: 'dropbox_sync', jobId: DROPBOX_JOB_IDS[2] }, 'd3'),
  ];

  await dispatcher.queue({ messages }, {});

  assert.deepEqual(seen, [
    { webhookAt: '2026-08-21T12:00:00.000Z' },
    { webhookAt: null },
    { webhookAt: null },
  ]);
  assert.deepEqual(messages.map(item => item.state.acked), [0, 0, 1]);
  assert.deepEqual(messages.map(item => item.state.retried), [1, 1, 0]);
  assert.equal(messages[0].state.retryOptions[0].delaySeconds, 30);
  assert.equal(messages[1].state.retryOptions[0].delaySeconds, 300);
});

test('Calendar sync queue work is consumed, lease-busy work is delayed, and provider failures retry', async () => {
  const seen = [];
  const dispatcher = createIntegrationDispatcher({
    runCalendar: async (_env, userId, calendarId) => {
      seen.push({ userId, calendarId });
      if (seen.length === 1) throw new Error('google_503_backend_error_private_detail');
      if (seen.length === 2) return { busy: true, retryAfterSeconds: 9999 };
      return { kind: 'incremental' };
    },
  });
  const messages = [
    message({
      version: 1,
      type: 'calendar_sync',
      jobId: DROPBOX_JOB_IDS[0],
      userId: CALENDAR_USER_ID,
      calendarId: 'primary',
      trigger: 'webhook',
    }, 'c1'),
    message({
      version: 1,
      type: 'calendar_sync',
      jobId: DROPBOX_JOB_IDS[1],
      userId: CALENDAR_USER_ID,
      calendarId: 'work@example.com',
      trigger: 'watch_activation',
    }, 'c2'),
    message({
      version: 1,
      type: 'calendar_sync',
      jobId: DROPBOX_JOB_IDS[2],
      userId: CALENDAR_USER_ID,
      calendarId: 'primary',
      trigger: 'maintenance',
    }, 'c3'),
  ];

  await dispatcher.queue({ messages }, {});

  assert.deepEqual(seen, [
    { userId: CALENDAR_USER_ID, calendarId: 'primary' },
    { userId: CALENDAR_USER_ID, calendarId: 'work@example.com' },
    { userId: CALENDAR_USER_ID, calendarId: 'primary' },
  ]);
  assert.deepEqual(messages.map(item => item.state.acked), [0, 0, 1]);
  assert.deepEqual(messages.map(item => item.state.retried), [1, 1, 0]);
  assert.equal(messages[0].state.retryOptions[0].delaySeconds, 30);
  assert.equal(messages[1].state.retryOptions[0].delaySeconds, 300);
});

test('consumer handles every outbox message independently and leaves retry timing to the durable outbox', async () => {
  const seen = [];
  const dispatcher = createIntegrationDispatcher({
    runHandoff: async (_env, taskId, kind) => {
      seen.push(`${taskId}:${kind}`);
      if (kind === 'email') throw new Error('provider unavailable');
      return { status: 'done' };
    },
    runCleanup: async (_env, jobId) => {
      seen.push(`cleanup:${jobId}`);
      return { status: 'done' };
    },
  });
  const messages = [
    message({ version: 1, type: 'task_handoff', jobId: 'h1', taskId: 't1', kind: 'calendar' }, 'm1'),
    message({ version: 1, type: 'task_handoff', jobId: 'h2', taskId: 't2', kind: 'email' }, 'm2'),
    message({ version: 1, type: 'calendar_cleanup', jobId: 'c1', taskId: 't3' }, 'm3'),
    message({ version: 1, type: 'unknown', jobId: 'bad', taskId: 't4' }, 'm4'),
  ];

  await dispatcher.queue({ messages }, {});

  assert.deepEqual(seen, ['t1:calendar', 't2:email', 'cleanup:c1']);
  for (const item of messages) {
    assert.equal(item.state.acked, 1);
    assert.equal(item.state.retried, 0);
  }
});

test('cron awaits durable outbox dispatch and bounded Calendar watch maintenance with canonical origin', async () => {
  let dispatched = 0;
  let maintained = 0;
  const dispatcher = createIntegrationDispatcher({
    dispatch: async (_env, options) => {
      assert.equal(options.limit, 50);
      dispatched += 1;
      return { claimed: 3, enqueued: 3 };
    },
    maintainWatches: async (_env, origin, options) => {
      assert.equal(origin, 'https://portal.example');
      assert.deepEqual(options, { limit: 10, runtimeMs: 20_000 });
      maintained += 1;
      return { checked: 2, renewed: 1, synced: 0, failed: 0 };
    },
    resolveOrigin: currentEnv => {
      assert.equal(currentEnv.PUBLIC_ORIGIN, 'https://portal.example');
      return currentEnv.PUBLIC_ORIGIN;
    },
  });
  const ctx = { waitUntil() { throw new Error('scheduled handler must await its bounded work directly'); } };

  await dispatcher.scheduled(
    { scheduledTime: 123, cron: '*/1 * * * *' },
    { PUBLIC_ORIGIN: 'https://portal.example' },
    ctx,
  );
  assert.equal(dispatched, 1);
  assert.equal(maintained, 1);
});

test('cron attempts both maintenance surfaces and fails the invocation if either one fails', async () => {
  let maintained = 0;
  const dispatcher = createIntegrationDispatcher({
    dispatch: async () => { throw new Error('database unavailable'); },
    maintainWatches: async () => {
      maintained += 1;
      return { checked: 0 };
    },
    resolveOrigin: () => 'https://portal.example',
  });

  await assert.rejects(
    dispatcher.scheduled({ scheduledTime: 123, cron: '*/1 * * * *' }, {}),
    /scheduled_maintenance_failed/,
  );
  assert.equal(maintained, 1);
});

test('database dispatch uses expiring leases and skip-locked claims for both job tables', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260819203000_northlight_durable_dispatch_queue.sql', import.meta.url), 'utf8');
  assert.match(sql, /processing_lease_until timestamptz/);
  assert.match(sql, /dispatch_lease_until timestamptz/);
  assert.match(sql, /for update skip locked/gi);
  assert.match(sql, /northlight_reap_stale_system_jobs/);
  assert.match(sql, /northlight_claim_task_handoff_dispatch/);
  assert.match(sql, /northlight_claim_calendar_cleanup_dispatch/);
  assert.match(sql, /next_attempt_at = case when p_sent then now\(\) \+ interval '15 minutes'/);
});

test('Cloudflare Pages stays dashboard-managed while preview and production dispatcher resources remain isolated', async () => {
  await assert.rejects(
    readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
    error => error?.code === 'ENOENT',
    'A root Pages Wrangler file must not be deployment-active before dashboard configuration is downloaded and reconciled',
  );

  const production = JSON.parse(await readFile(new URL('../workers/integration-dispatcher/wrangler.jsonc', import.meta.url), 'utf8'));
  const preview = JSON.parse(await readFile(new URL('../workers/integration-dispatcher/wrangler.preview.jsonc', import.meta.url), 'utf8'));

  assert.equal(production.name, 'northlight-integration-dispatcher');
  assert.equal(preview.name, 'northlight-integration-dispatcher-preview');
  assert.equal(production.main, 'src/index.js');
  assert.equal(preview.main, 'src/index.js');
  assert.equal(production.compatibility_date, '2026-08-21');
  assert.equal(preview.compatibility_date, '2026-08-21');
  assert.deepEqual(production.compatibility_flags, ['nodejs_compat']);
  assert.deepEqual(preview.compatibility_flags, ['nodejs_compat']);

  const verify = (worker, queue, deadLetterQueue) => {
    assert.equal(worker.queues.producers[0].binding, 'TASK_HANDOFF_QUEUE');
    assert.equal(worker.queues.producers[0].queue, queue);
    const consumer = worker.queues.consumers[0];
    assert.deepEqual({
      queue: consumer.queue,
      maxBatchSize: consumer.max_batch_size,
      maxBatchTimeout: consumer.max_batch_timeout,
      maxRetries: consumer.max_retries,
      retryDelay: consumer.retry_delay,
      deadLetterQueue: consumer.dead_letter_queue,
      maxConcurrency: consumer.max_concurrency,
    }, {
      queue,
      maxBatchSize: 10,
      maxBatchTimeout: 5,
      maxRetries: 5,
      retryDelay: 60,
      deadLetterQueue,
      maxConcurrency: 5,
    });
    assert.deepEqual(worker.triggers.crons, ['*/1 * * * *']);
    assert.equal(worker.observability.enabled, true);
    assert.equal(worker.observability.traces.enabled, true);
  };

  verify(production, 'northlight-task-handoffs', 'northlight-task-handoffs-dlq');
  verify(preview, 'northlight-task-handoffs-preview', 'northlight-task-handoffs-preview-dlq');
  assert.notEqual(production.queues.producers[0].queue, preview.queues.producers[0].queue);
  assert.notEqual(production.queues.consumers[0].dead_letter_queue, preview.queues.consumers[0].dead_letter_queue);
});
