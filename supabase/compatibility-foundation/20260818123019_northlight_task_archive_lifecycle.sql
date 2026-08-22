alter table public.tasks
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by_user_id uuid references public.users(id),
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by_user_id uuid references public.users(id);

create index if not exists tasks_active_archive_idx on public.tasks(tenant_id, archived_at, deleted_at, created_at desc);
