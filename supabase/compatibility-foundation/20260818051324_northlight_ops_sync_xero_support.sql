alter table public.provider_profiles
  add column if not exists calendar_id text,
  add column if not exists timezone text default 'Australia/Melbourne',
  add column if not exists service_radius_km integer default 25,
  add column if not exists travel_buffer_min integer default 15,
  add column if not exists location_mode text default 'home_base',
  add column if not exists live_location jsonb not null default '{}'::jsonb;

create table if not exists public.task_comments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  author_user_id uuid references public.users(id),
  body text not null,
  visibility text not null default 'task' check (visibility in ('task','internal','owner')),
  kind text not null default 'comment' check (kind in ('comment','note','issue_update')),
  emailed boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.task_issues (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  created_by_user_id uuid references public.users(id),
  assigned_to_user_id uuid references public.users(id),
  subject text not null,
  description text,
  category text not null default 'general',
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  status text not null default 'open' check (status in ('open','in_progress','waiting','resolved','closed')),
  resolution text,
  due_at timestamptz,
  resolved_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.calendar_sync_state (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  provider text not null default 'google',
  calendar_id text not null default 'primary',
  sync_token text,
  channel_id text,
  resource_id text,
  channel_expires_at timestamptz,
  last_full_sync_at timestamptz,
  last_incremental_sync_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  unique (tenant_id, user_id, provider, calendar_id)
);

create table if not exists public.dropbox_sync_state (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  account_id text,
  root_path text not null default '/Northlight',
  cursor text,
  last_webhook_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  unique (tenant_id, root_path)
);

create table if not exists public.task_files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  provider text not null default 'dropbox',
  provider_file_id text,
  path text not null,
  name text not null,
  file_type text,
  stage text,
  service_code text,
  size_bytes bigint,
  content_hash text,
  revision text,
  is_deleted boolean not null default false,
  modified_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider, path)
);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete set null,
  provider text not null default 'xero',
  provider_invoice_id text,
  invoice_number text,
  contact_name text,
  contact_email text,
  currency text not null default 'AUD',
  subtotal numeric(12,2),
  tax numeric(12,2),
  total numeric(12,2),
  status text not null default 'draft',
  due_date date,
  issued_at timestamptz,
  paid_at timestamptz,
  external_url text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider, provider_invoice_id)
);

create table if not exists public.external_sync_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider text not null,
  direction text not null check (direction in ('inbound','outbound')),
  entity_type text not null,
  entity_id text,
  event_type text not null,
  status text not null default 'processed',
  payload jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists task_comments_task_idx on public.task_comments(task_id, created_at desc);
create index if not exists task_issues_task_idx on public.task_issues(task_id, status, created_at desc);
create index if not exists calendar_sync_user_idx on public.calendar_sync_state(user_id);
create index if not exists task_files_task_idx on public.task_files(task_id, stage, service_code);
create index if not exists invoices_task_idx on public.invoices(task_id);
create index if not exists external_sync_events_provider_idx on public.external_sync_events(tenant_id, provider, created_at desc);

alter table public.task_comments enable row level security;
alter table public.task_issues enable row level security;
alter table public.calendar_sync_state enable row level security;
alter table public.dropbox_sync_state enable row level security;
alter table public.task_files enable row level security;
alter table public.invoices enable row level security;
alter table public.external_sync_events enable row level security;

do $$
declare t text;
begin
  foreach t in array array['task_comments','task_issues','calendar_sync_state','dropbox_sync_state','task_files','invoices','external_sync_events']
  loop
    execute format('drop policy if exists northlight_pilot_access on public.%I', t);
    execute format('create policy northlight_pilot_access on public.%I for all to anon, authenticated using (public.northlight_pilot_allowed()) with check (public.northlight_pilot_allowed())', t);
  end loop;
end $$;
