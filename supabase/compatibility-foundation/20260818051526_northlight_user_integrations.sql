create table if not exists public.user_integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid references public.users(id) on delete cascade,
  provider text not null,
  status text not null default 'not_connected',
  account_label text,
  external_account_id text,
  encrypted_credentials jsonb not null default '{}'::jsonb,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  last_verified_at timestamptz,
  last_sync_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id, provider)
);
create index if not exists user_integrations_user_provider_idx on public.user_integrations(user_id, provider);
alter table public.user_integrations enable row level security;
drop policy if exists northlight_pilot_access on public.user_integrations;
create policy northlight_pilot_access on public.user_integrations for all to anon, authenticated using (public.northlight_pilot_allowed()) with check (public.northlight_pilot_allowed());