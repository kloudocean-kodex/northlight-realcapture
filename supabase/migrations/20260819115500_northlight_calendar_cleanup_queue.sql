alter table public.task_handoffs drop constraint if exists task_handoffs_status_check;
alter table public.task_handoffs add constraint task_handoffs_status_check check (status in ('pending','processing','done','attention','cancelled'));

create table if not exists public.calendar_cleanup_queue (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  calendar_owner_user_id uuid not null references public.users(id),
  calendar_event_id text not null,
  calendar_id text not null default 'primary',
  status text not null default 'pending' check (status in ('pending','processing','done','attention','cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task_id, calendar_owner_user_id, calendar_event_id)
);

create index if not exists calendar_cleanup_queue_tenant_idx on public.calendar_cleanup_queue (tenant_id);
create index if not exists calendar_cleanup_queue_task_idx on public.calendar_cleanup_queue (task_id, status, created_at desc);
create index if not exists calendar_cleanup_queue_recovery_idx on public.calendar_cleanup_queue (status, next_attempt_at, updated_at);
create index if not exists calendar_cleanup_queue_owner_idx on public.calendar_cleanup_queue (calendar_owner_user_id);
alter table public.calendar_cleanup_queue enable row level security;
drop policy if exists northlight_pilot_access on public.calendar_cleanup_queue;
create policy northlight_pilot_access on public.calendar_cleanup_queue for all to anon, authenticated using (public.northlight_pilot_allowed()) with check (public.northlight_pilot_allowed());
