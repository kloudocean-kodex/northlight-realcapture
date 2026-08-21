import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverDurableDraft } from '../functions/_lib/durable-email.js';

test('durable Gmail delivery checkpoints draft intent and provider receipt', async () => {
  let stored = {}, created = 0, sent = 0;
  const result = await deliverDurableDraft({
    state: stored,
    deliveryKey: 'assignment-1',
    messageId: '<assignment-1@example.test>',
    createDraft: async () => { created += 1; return { id: 'draft-1' }; },
    getDraft: async () => ({ id: 'draft-1' }),
    sendDraft: async id => { assert.equal(id, 'draft-1'); sent += 1; return { id: 'message-1' }; },
    persist: async next => { stored = { ...next }; return stored; },
    now: () => '2026-08-19T00:00:00.000Z',
  });

  assert.equal(created, 1);
  assert.equal(sent, 1);
  assert.equal(result.providerMessageId, 'message-1');
  assert.equal(stored.gmail_draft_id, 'draft-1');
  assert.equal(stored.gmail_message_id, 'message-1');
  assert.equal(stored.gmail_send_started_at, '2026-08-19T00:00:00.000Z');
});

test('ambiguous post-send failure is reconciled from a consumed draft without sending twice', async () => {
  let stored = {}, sent = 0, failReceiptOnce = true;
  const adapters = {
    deliveryKey: 'assignment-2',
    messageId: '<assignment-2@example.test>',
    createDraft: async () => ({ id: 'draft-2' }),
    getDraft: async () => null,
    sendDraft: async () => { sent += 1; return { id: 'message-2' }; },
    persist: async next => {
      if (next.gmail_message_id === 'message-2' && failReceiptOnce) {
        failReceiptOnce = false;
        throw new Error('database unavailable after provider accepted send');
      }
      stored = { ...next };
      return stored;
    },
    now: () => '2026-08-19T01:00:00.000Z',
  };

  await assert.rejects(deliverDurableDraft({ ...adapters, state: stored }), /database unavailable/);
  assert.equal(sent, 1);
  assert.equal(stored.gmail_draft_id, 'draft-2');
  assert.equal(stored.gmail_send_started_at, '2026-08-19T01:00:00.000Z');
  assert.equal(stored.gmail_message_id, null);

  const recovered = await deliverDurableDraft({ ...adapters, state: stored });
  assert.equal(sent, 1, 'the recipient must not receive a duplicate');
  assert.equal(recovered.inferred, true);
  assert.equal(recovered.providerMessageId, 'consumed-draft:draft-2');
  assert.equal(stored.gmail_message_id, 'consumed-draft:draft-2');
});

test('a draft removed before send intent is safely recreated', async () => {
  let stored = { gmail_draft_id: 'removed-draft', gmail_send_started_at: null }, created = 0, sent = 0;
  const result = await deliverDurableDraft({
    state: stored,
    deliveryKey: 'assignment-3',
    messageId: '<assignment-3@example.test>',
    createDraft: async () => { created += 1; return { id: 'replacement-draft' }; },
    getDraft: async () => null,
    sendDraft: async id => { assert.equal(id, 'replacement-draft'); sent += 1; return { id: 'message-3' }; },
    persist: async next => { stored = { ...next }; return stored; },
  });

  assert.equal(created, 1);
  assert.equal(sent, 1);
  assert.equal(result.providerMessageId, 'message-3');
});

test('an existing provider receipt is idempotent', async () => {
  let providerCalls = 0;
  const result = await deliverDurableDraft({
    state: { gmail_draft_id: 'draft-4', gmail_message_id: 'message-4' },
    deliveryKey: 'assignment-4',
    messageId: '<assignment-4@example.test>',
    createDraft: async () => { providerCalls += 1; },
    getDraft: async () => { providerCalls += 1; },
    sendDraft: async () => { providerCalls += 1; },
    persist: async next => next,
  });

  assert.equal(providerCalls, 0);
  assert.equal(result.providerMessageId, 'message-4');
});
