\set ON_ERROR_STOP on

-- Minimal Supabase-compatible role/extension/default-privilege surface for a
-- fresh PostgreSQL 17 GitHub Actions service. This contains no tenant data or
-- production credentials.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticator') then create role authenticator nologin; end if;
end
$$;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- Supabase exposes extension functions such as digest() through the effective
-- database search path. Mirror that hosted runtime here so the recovered
-- historical SQL executes unchanged in a vanilla PostgreSQL 17 clean room.
set search_path = public, extensions;

grant usage on schema public to anon, authenticated, service_role, authenticator;
grant usage on schema extensions to anon, authenticated, service_role, authenticator;

grant all privileges on all tables in schema public to anon, authenticated, service_role;
grant all privileges on all sequences in schema public to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;

alter default privileges in schema public grant all privileges on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all privileges on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
