-- NORTHLIGHT · REALCAPTURE
-- Interim safety boundary before multi-organization / multi-tenant rollout.
--
-- The current production pilot is intentionally one tenant. The application
-- still contains pilot-era queries that assume that invariant. Until the
-- organization-aware authorization layer and tenant/org RLS are deployed,
-- accidentally introducing a second tenant must fail closed rather than risk
-- mixed-company visibility.
--
-- This migration creates no tenants, organizations, memberships, users, tasks
-- or demo data. Remove/replace this guard only in the same controlled release
-- that introduces complete tenant + organization authorization and negative
-- cross-tenant tests.

create schema if not exists northlight_private;
revoke all on schema northlight_private from public;
grant usage on schema northlight_private to anon, authenticated;

create or replace function northlight_private.single_tenant_guard()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select count(*) from public.tenants) = 1
$$;

revoke all on function northlight_private.single_tenant_guard() from public;
grant execute on function northlight_private.single_tenant_guard() to anon, authenticated;

comment on function northlight_private.single_tenant_guard() is
  'Interim fail-closed REALCAPTURE pilot guard. True only while exactly one Northlight tenant exists.';

do $$
declare
  r record;
begin
  for r in
    select distinct tablename
    from pg_policies
    where schemaname = 'public'
      and policyname in ('northlight_pilot_access', 'northlight_pilot_backend')
    order by tablename
  loop
    execute format(
      'drop policy if exists northlight_single_tenant_only on public.%I',
      r.tablename
    );
    execute format(
      'create policy northlight_single_tenant_only on public.%I as restrictive for all to anon, authenticated using ((select northlight_private.single_tenant_guard())) with check ((select northlight_private.single_tenant_guard()))',
      r.tablename
    );
  end loop;
end
$$;
