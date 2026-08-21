alter table public.invoices
  add column if not exists idempotency_key text,
  add column if not exists request_hash text;

create unique index if not exists invoices_one_xero_per_task_idx
  on public.invoices (tenant_id, task_id)
  where provider = 'xero' and task_id is not null;

create unique index if not exists invoices_xero_idempotency_key_idx
  on public.invoices (idempotency_key)
  where provider = 'xero' and idempotency_key is not null;

create or replace function public.northlight_begin_xero_invoice(
  p_task_id uuid,
  p_actor uuid,
  p_idempotency_key text,
  p_request_hash text,
  p_request jsonb
)
returns public.invoices
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.tasks%rowtype;
  v_actor public.users%rowtype;
  v_invoice public.invoices%rowtype;
  v_amount numeric;
begin
  if not public.northlight_pilot_allowed() then raise exception 'permission_denied'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) < 32 or length(p_idempotency_key) > 128 then raise exception 'invalid_idempotency_key'; end if;
  if p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid_request_hash'; end if;

  select * into v_actor from public.users where id = p_actor and active is true limit 1;
  if not found or v_actor.role_code not in ('admin', 'owner') then raise exception 'permission_denied'; end if;

  select * into v_task from public.tasks where id = p_task_id and deleted_at is null for update;
  if not found then raise exception 'task_not_found'; end if;
  if v_actor.tenant_id is distinct from v_task.tenant_id then raise exception 'permission_denied'; end if;
  if v_task.archived_at is not null then raise exception 'task_archived'; end if;
  if v_task.status <> 'delivered' then raise exception 'task_not_delivered'; end if;

  v_amount := nullif(p_request->>'amount', '')::numeric;
  if v_amount is null or v_amount <= 0 then raise exception 'invalid_amount'; end if;
  if coalesce(p_request->>'dueDate', '') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid_due_date'; end if;

  select * into v_invoice
    from public.invoices
   where tenant_id = v_task.tenant_id and task_id = v_task.id and provider = 'xero'
   for update;

  if found then
    if v_invoice.request_hash is distinct from p_request_hash then raise exception 'invoice_parameters_changed'; end if;
    return v_invoice;
  end if;

  insert into public.invoices(
    tenant_id, task_id, provider, provider_invoice_id, invoice_number,
    contact_name, contact_email, currency, total, status, due_date,
    idempotency_key, request_hash, metadata
  ) values (
    v_task.tenant_id, v_task.id, 'xero', null, v_task.task_no,
    nullif(p_request->>'contactName', ''), nullif(p_request->>'contactEmail', ''), 'AUD', v_amount, 'creating',
    nullif(p_request->>'dueDate', '')::date,
    p_idempotency_key, p_request_hash,
    jsonb_build_object('create_intent_at', now(), 'create_intent_actor', p_actor, 'request', p_request)
  )
  returning * into v_invoice;

  return v_invoice;
exception
  when unique_violation then
    select * into v_invoice
      from public.invoices
     where tenant_id = v_task.tenant_id and task_id = v_task.id and provider = 'xero'
     for update;
    if not found then raise; end if;
    if v_invoice.request_hash is distinct from p_request_hash then raise exception 'invoice_parameters_changed'; end if;
    return v_invoice;
end;
$$;

revoke all on function public.northlight_begin_xero_invoice(uuid, uuid, text, text, jsonb) from public;
grant execute on function public.northlight_begin_xero_invoice(uuid, uuid, text, text, jsonb) to anon, authenticated;

comment on function public.northlight_begin_xero_invoice(uuid, uuid, text, text, jsonb) is
  'Atomically creates or reuses the single Xero creation intent for a delivered task.';
