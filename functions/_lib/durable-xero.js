function remoteInvoice(remote, taskNumber) {
  if (!remote?.InvoiceID) throw new Error('xero_invoice_missing');
  if (String(remote.InvoiceNumber || '') !== String(taskNumber || '')) {
    throw new Error('xero_invoice_number_mismatch');
  }
  return remote;
}

export async function ensureXeroInvoice({
  intent,
  taskNumber,
  findRemote,
  createRemote,
  persistRemote
}) {
  if (!intent?.id) throw new Error('xero_intent_missing');
  if (!taskNumber) throw new Error('xero_task_number_missing');

  if (intent.provider_invoice_id) {
    return { invoice: intent, reused: true, reconciled: false };
  }

  let remote = await findRemote(taskNumber);
  const reconciled = Boolean(remote);
  if (!remote) remote = await createRemote(intent.idempotency_key);
  remoteInvoice(remote, taskNumber);

  const invoice = await persistRemote(remote, { reconciled });
  if (!invoice?.provider_invoice_id) throw new Error('xero_invoice_persist_failed');
  return { invoice, reused: reconciled, reconciled };
}
