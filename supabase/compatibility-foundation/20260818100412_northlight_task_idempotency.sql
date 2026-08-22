alter table public.tasks add column if not exists idempotency_key text;
create unique index if not exists tasks_tenant_idempotency_key_uq on public.tasks(tenant_id,idempotency_key) where idempotency_key is not null;
create index if not exists tasks_photographer_status_idx on public.tasks(photographer_user_id,status,scheduled_start);
create index if not exists tasks_agent_status_idx on public.tasks(agent_user_id,status,scheduled_start);