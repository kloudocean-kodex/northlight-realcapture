create table if not exists public.pilot_state (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.pilot_state enable row level security;
drop policy if exists northlight_pilot_access on public.pilot_state;
create policy northlight_pilot_access on public.pilot_state for all to anon, authenticated using (public.northlight_pilot_allowed()) with check (public.northlight_pilot_allowed());