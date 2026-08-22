import { requireSession, error, json, supa, tenant, logSync } from '../../_lib/core.js';
import { xeroRequest, findXeroInvoiceByNumber } from '../../_lib/xero.js';
import { ensureXeroInvoice } from '../../_lib/durable-xero.js';

const encoder = new TextEncoder();
const proposedIdempotencyKey = () => Array.from(
  { length: 4 },
  () => crypto.randomUUID().replace(/-/g, '')
).join('');

async function sha256(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function requestSnapshot(body) {
  const amount = Number(body.amount || 0);
  const contactName = String(body.contactName || 'REALCAPTURE Client').trim();
  const contactEmail = String(body.contactEmail || '').trim().toLowerCase();
  const accountCode = String(body.accountCode || '200').trim().toUpperCase();
  const taxType = String(body.taxType || 'OUTPUT').trim().toUpperCase();
  const dueDate = String(
    body.dueDate || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
  ).trim();
  return { amount, contactName, contactEmail, accountCode, taxType, dueDate };
}

function validateRequest(requestData) {
  if (!Number.isFinite(requestData.amount) || requestData.amount <= 0 || requestData.amount > 100000000) {
    return 'Enter a positive invoice amount below 100,000,000.';
  }
  if (!requestData.contactName || requestData.contactName.length > 255) {
    return 'Enter a contact name under 256 characters.';
  }
  if (requestData.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(requestData.contactEmail)) {
    return 'Enter a valid contact email address.';
  }
  if (!/^[A-Z0-9._-]{1,20}$/.test(requestData.accountCode)) {
    return 'Choose a valid Xero account code.';
  }
  if (!/^[A-Z0-9._-]{1,40}$/.test(requestData.taxType)) {
    return 'Choose a valid Xero tax type.';
  }
  if (!validDate(requestData.dueDate)) return 'Choose a valid invoice due date.';
  return null;
}

function invoicePayload(task, requestData) {
  return {
    Invoices: [{
      Type: 'ACCREC',
      InvoiceNumber: task.task_no,
      Contact: {
        Name: requestData.contactName,
        ...(requestData.contactEmail ? { EmailAddress: requestData.contactEmail } : {})
      },
      Date: new Date().toISOString().slice(0, 10),
      DueDate: requestData.dueDate,
      LineAmountTypes: 'Exclusive',
      Reference: task.task_no,
      Status: 'DRAFT',
      LineItems: [{
        Description: `Property media services · ${task.task_no} · ${task.property_name}`,
        Quantity: 1,
        UnitAmount: requestData.amount,
        AccountCode: requestData.accountCode,
        TaxType: requestData.taxType
      }]
    }]
  };
}

function invoiceRecord(currentTenant, task, intent, remote, requestData, reconciled) {
  return {
    tenant_id: currentTenant.id,
    task_id: task.id,
    provider: 'xero',
    provider_invoice_id: remote.InvoiceID,
    invoice_number: remote.InvoiceNumber || task.task_no,
    contact_name: requestData.contactName,
    contact_email: requestData.contactEmail || null,
    currency: remote.CurrencyCode || 'AUD',
    subtotal: remote.SubTotal ?? requestData.amount,
    tax: remote.TotalTax ?? null,
    total: remote.Total ?? requestData.amount,
    status: String(remote.Status || 'DRAFT').toLowerCase(),
    due_date: remote.DueDateString || requestData.dueDate,
    issued_at: remote.DateString || new Date().toISOString(),
    external_url: `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${encodeURIComponent(remote.InvoiceID)}`,
    idempotency_key: intent.idempotency_key,
    request_hash: intent.request_hash,
    metadata: {
      ...(intent.metadata || {}),
      reference: task.task_no,
      reconciled,
      reconciled_at: new Date().toISOString()
    }
  };
}

export async function onRequestGet({ request, env }) {
  const auth = await requireSession(request, env, ['admin', 'owner']);
  if (auth.error) return auth.error;
  try {
    const currentTenant = await tenant(env);
    const rows = await supa(env, 'invoices', {
      query: `select=id,task_id,invoice_number,contact_name,contact_email,currency,subtotal,tax,total,status,due_date,issued_at,paid_at,external_url,created_at,updated_at&tenant_id=eq.${currentTenant.id}&order=created_at.desc`
    });
    return json({ invoices: rows });
  } catch {
    return error(500, 'Could not load invoices.');
  }
}

export async function onRequestPost({ request, env }) {
  const auth = await requireSession(request, env, ['admin', 'owner']);
  if (auth.error) return auth.error;

  let task = null;
  try {
    const body = await request.json();
    const currentTenant = await tenant(env);
    task = (await supa(env, 'tasks', {
      query: `select=*&id=eq.${encodeURIComponent(body.taskId || '')}&tenant_id=eq.${currentTenant.id}&deleted_at=is.null&limit=1`
    }))?.[0];
    if (!task) return error(404, 'Task not found.');
    if (task.archived_at) return error(409, 'Restore the archived task before creating an invoice.');
    if (task.status !== 'delivered') return error(409, 'Only a delivered task can be invoiced.');

    const requestData = requestSnapshot(body);
    const validationError = validateRequest(requestData);
    if (validationError) return error(400, validationError);
    const requestHash = await sha256(JSON.stringify(requestData));

    let intentRaw;
    try {
      intentRaw = await supa(env, 'rpc/northlight_begin_xero_invoice', {
        method: 'POST',
        payload: {
          p_task_id: task.id,
          p_actor: auth.session.userId,
          p_idempotency_key: proposedIdempotencyKey(),
          p_request_hash: requestHash,
          p_request: requestData
        }
      });
    } catch (exception) {
      const message = String(exception?.message || '');
      if (/task_not_found/i.test(message)) return error(404, 'Task not found.');
      if (/task_archived/i.test(message)) return error(409, 'Restore the archived task before creating an invoice.');
      if (/task_not_delivered/i.test(message)) return error(409, 'Only a delivered task can be invoiced.');
      if (/invoice_parameters_changed/i.test(message)) {
        return error(409, 'A Xero invoice already exists for this task with different billing details. Open that invoice instead.');
      }
      if (/permission_denied/i.test(message)) return error(403, 'You do not have permission to create this invoice.');
      if (/invalid_/i.test(message)) return error(400, 'The invoice details are invalid.');
      throw exception;
    }
    const intent = Array.isArray(intentRaw) ? intentRaw[0] : intentRaw;
    if (!intent?.id) throw new Error('xero_intent_missing');

    const payload = invoicePayload(task, requestData);
    const result = await ensureXeroInvoice({
      intent,
      taskNumber: task.task_no,
      findRemote: invoiceNumber => findXeroInvoiceByNumber(env, invoiceNumber),
      createRemote: async idempotencyKey => {
        const response = await xeroRequest(env, '/api.xro/2.0/Invoices', {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey },
          body: JSON.stringify(payload)
        });
        return response?.Invoices?.[0] || null;
      },
      persistRemote: async (remote, { reconciled }) => {
        const record = invoiceRecord(currentTenant, task, intent, remote, requestData, reconciled);
        const rows = await supa(env, 'invoices', {
          method: 'PATCH',
          query: `id=eq.${encodeURIComponent(intent.id)}&tenant_id=eq.${currentTenant.id}&provider=eq.xero`,
          payload: record
        });
        const saved = rows?.[0] || (await supa(env, 'invoices', {
          query: `select=*&id=eq.${encodeURIComponent(intent.id)}&tenant_id=eq.${currentTenant.id}&limit=1`
        }))?.[0];
        if (!saved?.provider_invoice_id) throw new Error('xero_invoice_persist_failed');
        return saved;
      }
    });

    await logSync(
      env,
      'xero',
      'outbound',
      'invoice',
      result.reconciled ? 'invoice_reconciled' : 'invoice_created',
      {
        entity_id: result.invoice.provider_invoice_id,
        payload: { task_id: task.id, task_no: task.task_no, total: result.invoice.total }
      }
    );
    return json(result, result.reused ? 200 : 201);
  } catch (exception) {
    try {
      await logSync(env, 'xero', 'outbound', 'invoice', 'invoice_create_failed', {
        status: 'failed',
        error: String(exception?.message || 'unknown_error'),
        payload: task ? { task_id: task.id, task_no: task.task_no } : {}
      });
    } catch {}
    const message = String(exception?.message || '');
    if (/xero_(?:401|403|429|5\d\d)|oauth_|not_connected|tenant_missing/i.test(message)) {
      return error(503, 'Xero is temporarily unavailable. The protected invoice intent is saved; retry safely from this task.');
    }
    return error(502, 'Xero could not confirm the draft invoice. The protected invoice intent is saved; retry safely from this task.');
  }
}
