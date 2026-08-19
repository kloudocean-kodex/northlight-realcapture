create table if not exists public.task_handoffs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  kind text not null,
  status text not null default 'pending' check (status in ('pending','processing','done','attention')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (task_id, kind)
);

alter table public.task_handoffs drop constraint if exists task_handoffs_kind_check;
alter table public.task_handoffs add constraint task_handoffs_kind_check check (kind in ('dropbox','calendar','email','calendar_cancel'));
create index if not exists task_handoffs_recovery_idx on public.task_handoffs (status, next_attempt_at, updated_at);
create index if not exists task_handoffs_task_idx on public.task_handoffs (task_id, kind);
alter table public.task_handoffs enable row level security;
drop policy if exists northlight_pilot_access on public.task_handoffs;
create policy northlight_pilot_access on public.task_handoffs for all to anon, authenticated using (public.northlight_pilot_allowed()) with check (public.northlight_pilot_allowed());
create index if not exists tasks_archived_by_user_idx on public.tasks (archived_by_user_id) where archived_by_user_id is not null;
create index if not exists tasks_deleted_by_user_idx on public.tasks (deleted_by_user_id) where deleted_by_user_id is not null;
