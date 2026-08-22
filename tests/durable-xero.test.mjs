import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureXeroInvoice } from '../functions/_lib/durable-xero.js';

const intent = {
  id: 'intent-1',
  idempotency_key: 'a'.repeat(128),
  provider_invoice_id: null
};

test('creates and persists one remote invoice when reconciliation finds none', async () => {
  const calls = [];
  const result = await ensureXeroInvoice({
    intent,
    taskNumber: 'NL-100',
    findRemote: async number => (calls.push(['find', number]), null),
    createRemote: async key => (calls.push(['create', key]), { InvoiceID: 'x-1', InvoiceNumber: 'NL-100' }),
    persistRemote: async (remote, state) => {
      calls.push(['persist', remote.InvoiceID, state.reconciled]);
      return { ...intent, provider_invoice_id: remote.InvoiceID };
    }
  });

  assert.deepEqual(calls, [
    ['find', 'NL-100'],
    ['create', intent.idempotency_key],
    ['persist', 'x-1', false]
  ]);
  assert.equal(result.reused, false);
  assert.equal(result.reconciled, false);
});

test('reconciles an ambiguous earlier create without posting a duplicate', async () => {
  let createCalls = 0;
  const result = await ensureXeroInvoice({
    intent,
    taskNumber: 'NL-101',
    findRemote: async () => ({ InvoiceID: 'x-existing', InvoiceNumber: 'NL-101' }),
    createRemote: async () => {
      createCalls += 1;
      return null;
    },
    persistRemote: async remote => ({ ...intent, provider_invoice_id: remote.InvoiceID })
  });

  assert.equal(createCalls, 0);
  assert.equal(result.invoice.provider_invoice_id, 'x-existing');
  assert.equal(result.reused, true);
  assert.equal(result.reconciled, true);
});

test('returns an already persisted provider receipt without any Xero call', async () => {
  const completed = { ...intent, provider_invoice_id: 'x-done' };
  let remoteCalls = 0;
  const result = await ensureXeroInvoice({
    intent: completed,
    taskNumber: 'NL-102',
    findRemote: async () => (++remoteCalls, null),
    createRemote: async () => (++remoteCalls, null),
    persistRemote: async () => (++remoteCalls, null)
  });

  assert.equal(remoteCalls, 0);
  assert.equal(result.invoice, completed);
  assert.equal(result.reused, true);
});

test('fails closed when Xero returns a mismatched deterministic invoice number', async () => {
  await assert.rejects(
    ensureXeroInvoice({
      intent,
      taskNumber: 'NL-103',
      findRemote: async () => null,
      createRemote: async () => ({ InvoiceID: 'x-wrong', InvoiceNumber: 'NL-OTHER' }),
      persistRemote: async () => {
        throw new Error('must_not_persist');
      }
    }),
    /xero_invoice_number_mismatch/
  );
});

test('an ambiguous local persistence failure is safely reconcilable on retry', async () => {
  const remote = { InvoiceID: 'x-ambiguous', InvoiceNumber: 'NL-104' };
  await assert.rejects(
    ensureXeroInvoice({
      intent,
      taskNumber: 'NL-104',
      findRemote: async () => null,
      createRemote: async () => remote,
      persistRemote: async () => {
        throw new Error('database_temporarily_unavailable');
      }
    }),
    /database_temporarily_unavailable/
  );

  let createCalls = 0;
  const retry = await ensureXeroInvoice({
    intent,
    taskNumber: 'NL-104',
    findRemote: async () => remote,
    createRemote: async () => (++createCalls, remote),
    persistRemote: async found => ({ ...intent, provider_invoice_id: found.InvoiceID })
  });
  assert.equal(createCalls, 0);
  assert.equal(retry.invoice.provider_invoice_id, 'x-ambiguous');
  assert.equal(retry.reconciled, true);
});
