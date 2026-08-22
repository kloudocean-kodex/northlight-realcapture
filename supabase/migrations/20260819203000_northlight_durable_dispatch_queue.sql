-- Durable dispatch leases for provider hand-offs.
-- The business mutation and task_handoffs insert live in Postgres; Cloudflare Queues
-- is a delivery accelerator, while these rows remain the recoverable source of truth.

alter table public.task_handoffs
  add column if not exists processing_lease_until timestamptz,
  add column if not exists dispatch_owner uuid,
  add column if not exists dispatch_lease_until timestamptz,
  add column if not exists dispatched_at timestamptz,
  add column if not exists dispatch_attempts integer not null default 0,
  add column if not exists completed_at timestamptz,
  add column if not exists provider_receipt jsonb not null default '{}'::jsonb;

alter table public.calendar_cleanup_queue
  add column if not exists processing_lease_until timestamptz,
  add column if not exists dispatch_owner uuid,
  add column if not exists dispatch_lease_until timestamptz,
  add column if not exists dispatched_at timestamptz,
  add column if not exists dispatch_attempts integer not null default 0,
  add column if not exists completed_at timestamptz,
  add column if not exists provider_receipt jsonb not null default '{}'::jsonb;

alter table public.task_handoffs
  drop constraint if exists task_handoffs_dispatch_attempts_check;
alter table public.task_handoffs
  add constraint task_handoffs_dispatch_attempts_check check (dispatch_attempts >= 0);

alter table public.calendar_cleanup_queue
  drop constraint if exists calendar_cleanup_dispatch_attempts_check;
alter table public.calendar_cleanup_queue
  add constraint calendar_cleanup_dispatch_attempts_check check (dispatch_attempts >= 0);

create index if not exists task_handoffs_dispatch_due_idx
  on public.task_handoffs (next_attempt_at, dispatch_lease_until, created_at)
  where status in ('pending', 'attention');

create index if not exists calendar_cleanup_dispatch_due_idx
  on public.calendar_cleanup_queue (next_attempt_at, dispatch_lease_until, created_at)
  where status in ('pending', 'attention');

create or replace function public.northlight_reap_stale_system_jobs()
returns table(job_type text, job_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.northlight_pilot_allowed() then
    raise exception 'permission_denied';
  end if;

  return query
  update public.task_handoffs h
     set status = 'attention',
         processing_lease_until = null,
         next_attempt_at = now(),
         last_error = 'processing_lease_expired',
         updated_at = now()
   where h.status = 'processing'
     and coalesce(
       h.processing_lease_until,
       h.last_attempt_at + interval '10 minutes',
       h.updated_at + interval '10 minutes'
     ) <= now()
  returning 'task_handoff'::text, h.id;

  return query
  update public.calendar_cleanup_queue q
     set status = 'attention',
         processing_lease_until = null,
         next_attempt_at = now(),
         last_error = 'processing_lease_expired',
         updated_at = now()
   where q.status = 'processing'
     and coalesce(
       q.processing_lease_until,
       q.last_attempt_at + interval '10 minutes',
       q.updated_at + interval '10 minutes'
     ) <= now()
  returning 'calendar_cleanup'::text, q.id;
end;
$$;

create or replace function public.northlight_claim_task_handoff_dispatch(
  p_dispatcher uuid,
  p_limit integer default 50,
  p_lease_seconds integer default 90
)
returns table(job_id uuid, task_id uuid, kind text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.northlight_pilot_allowed() then
    raise exception 'permission_denied';
  end if;
  if p_dispatcher is null then raise exception 'dispatcher_required'; end if;

  return query
  with candidates as (
    select h.id
      from public.task_handoffs h
     where h.status in ('pending', 'attention')
       and h.attempts < 12
       and (h.next_attempt_at is null or h.next_attempt_at <= now())
       and (h.dispatch_lease_until is null or h.dispatch_lease_until <= now())
     order by coalesce(h.next_attempt_at, h.created_at), h.created_at
     for update skip locked
     limit least(greatest(coalesce(p_limit, 50), 1), 100)
  ), claimed as (
    update public.task_handoffs h
       set dispatch_owner = p_dispatcher,
           dispatch_lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 90), 30), 600)),
           dispatch_attempts = h.dispatch_attempts + 1,
           updated_at = now()
      from candidates c
     where h.id = c.id
    returning h.id, h.task_id, h.kind
  )
  select c.id, c.task_id, c.kind from claimed c;
end;
$$;

create or replace function public.northlight_claim_calendar_cleanup_dispatch(
  p_dispatcher uuid,
  p_limit integer default 50,
  p_lease_seconds integer default 90
)
returns table(job_id uuid, task_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.northlight_pilot_allowed() then
    raise exception 'permission_denied';
  end if;
  if p_dispatcher is null then raise exception 'dispatcher_required'; end if;

  return query
  with candidates as (
    select q.id
      from public.calendar_cleanup_queue q
     where q.status in ('pending', 'attention')
       and q.attempts < 12
       and (q.next_attempt_at is null or q.next_attempt_at <= now())
       and (q.dispatch_lease_until is null or q.dispatch_lease_until <= now())
     order by coalesce(q.next_attempt_at, q.created_at), q.created_at
     for update skip locked
     limit least(greatest(coalesce(p_limit, 50), 1), 100)
  ), claimed as (
    update public.calendar_cleanup_queue q
       set dispatch_owner = p_dispatcher,
           dispatch_lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 90), 30), 600)),
           dispatch_attempts = q.dispatch_attempts + 1,
           updated_at = now()
      from candidates c
     where q.id = c.id
    returning q.id, q.task_id
  )
  select c.id, c.task_id from claimed c;
end;
$$;

create or replace function public.northlight_finish_task_handoff_dispatch(
  p_dispatcher uuid,
  p_ids uuid[],
  p_sent boolean
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if not public.northlight_pilot_allowed() then
    raise exception 'permission_denied';
  end if;
  update public.task_handoffs h
     set dispatch_owner = null,
         dispatch_lease_until = null,
         dispatched_at = case when p_sent then now() else h.dispatched_at end,
         next_attempt_at = case when p_sent then now() + interval '15 minutes' else h.next_attempt_at end,
         updated_at = now()
   where h.id = any(coalesce(p_ids, array[]::uuid[]))
     and h.dispatch_owner = p_dispatcher
     and h.status in ('pending', 'attention');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.northlight_finish_calendar_cleanup_dispatch(
  p_dispatcher uuid,
  p_ids uuid[],
  p_sent boolean
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_count integer;
begin
  if not public.northlight_pilot_allowed() then
    raise exception 'permission_denied';
  end if;
  update public.calendar_cleanup_queue q
     set dispatch_owner = null,
         dispatch_lease_until = null,
         dispatched_at = case when p_sent then now() else q.dispatched_at end,
         next_attempt_at = case when p_sent then now() + interval '15 minutes' else q.next_attempt_at end,
         updated_at = now()
   where q.id = any(coalesce(p_ids, array[]::uuid[]))
     and q.dispatch_owner = p_dispatcher
     and q.status in ('pending', 'attention');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.northlight_reap_stale_system_jobs() from public;
revoke all on function public.northlight_claim_task_handoff_dispatch(uuid, integer, integer) from public;
revoke all on function public.northlight_claim_calendar_cleanup_dispatch(uuid, integer, integer) from public;
revoke all on function public.northlight_finish_task_handoff_dispatch(uuid, uuid[], boolean) from public;
revoke all on function public.northlight_finish_calendar_cleanup_dispatch(uuid, uuid[], boolean) from public;

grant execute on function public.northlight_reap_stale_system_jobs() to anon, authenticated;
grant execute on function public.northlight_claim_task_handoff_dispatch(uuid, integer, integer) to anon, authenticated;
grant execute on function public.northlight_claim_calendar_cleanup_dispatch(uuid, integer, integer) to anon, authenticated;
grant execute on function public.northlight_finish_task_handoff_dispatch(uuid, uuid[], boolean) to anon, authenticated;
grant execute on function public.northlight_finish_calendar_cleanup_dispatch(uuid, uuid[], boolean) to anon, authenticated;

comment on function public.northlight_reap_stale_system_jobs() is
  'Releases expired provider-processing leases so scheduled dispatch can recover browser or Worker termination.';
