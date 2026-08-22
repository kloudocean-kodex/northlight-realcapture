alter table public.integration_state
  add column if not exists refresh_owner uuid,
  add column if not exists refresh_lease_until timestamptz,
  add column if not exists refresh_generation bigint not null default 0;

alter table public.user_integrations
  add column if not exists refresh_owner uuid,
  add column if not exists refresh_lease_until timestamptz,
  add column if not exists refresh_generation bigint not null default 0;

create index if not exists integration_state_refresh_lease_idx
  on public.integration_state (refresh_lease_until)
  where refresh_lease_until is not null;

create index if not exists user_integrations_refresh_lease_idx
  on public.user_integrations (refresh_lease_until)
  where refresh_lease_until is not null;

create or replace function public.northlight_claim_integration_refresh(
  p_tenant_id uuid,
  p_provider text,
  p_owner uuid,
  p_lease_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.integration_state%rowtype;
  v_claimed boolean := false;
begin
  if not public.northlight_pilot_allowed() then raise exception 'permission_denied'; end if;
  if p_owner is null or coalesce(p_provider, '') = '' then raise exception 'invalid_refresh_claim'; end if;

  select * into v_row
    from public.integration_state
   where tenant_id = p_tenant_id and provider = p_provider
   for update;
  if not found or v_row.status <> 'connected' then raise exception 'integration_not_connected'; end if;

  if v_row.refresh_lease_until is null or v_row.refresh_lease_until <= now() or v_row.refresh_owner = p_owner then
    update public.integration_state
       set refresh_owner = p_owner,
           refresh_lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 60), 15), 120))
     where tenant_id = p_tenant_id and provider = p_provider
     returning * into v_row;
    v_claimed := true;
  end if;

  return to_jsonb(v_row) || jsonb_build_object('claimed', v_claimed);
end;
$$;

create or replace function public.northlight_finish_integration_refresh(
  p_tenant_id uuid,
  p_provider text,
  p_owner uuid,
  p_generation bigint,
  p_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row public.integration_state%rowtype;
begin
  if not public.northlight_pilot_allowed() then raise exception 'permission_denied'; end if;
  if jsonb_typeof(p_metadata) is distinct from 'object' then raise exception 'invalid_refresh_metadata'; end if;

  update public.integration_state
     set metadata = p_metadata,
         status = 'connected',
         last_verified_at = now(),
         refresh_owner = null,
         refresh_lease_until = null,
         refresh_generation = refresh_generation + 1
   where tenant_id = p_tenant_id
     and provider = p_provider
     and refresh_owner = p_owner
     and refresh_generation = p_generation
  returning * into v_row;
  if not found then raise exception 'refresh_claim_lost'; end if;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.northlight_release_integration_refresh(
  p_tenant_id uuid,
  p_provider text,
  p_owner uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.northlight_pilot_allowed() then raise exception 'permission_denied'; end if;
  update public.integration_state
     set refresh_owner = null, refresh_lease_until = null
   where tenant_id = p_tenant_id and provider = p_provider and refresh_owner = p_owner;
end;
$$;

create or replace function public.northlight_claim_user_integration_refresh(
  p_tenant_id uuid,
  p_user_id uuid,
  p_provider text,
  p_owner uuid,
  p_lease_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.user_integrations%rowtype;
  v_claimed boolean := false;
begin
  if not public.northlight_pilot_allowed() then raise exception 'permission_denied'; end if;
  if p_owner is null or p_user_id is null or coalesce(p_provider, '') = '' then raise exception 'invalid_refresh_claim'; end if;

  select * into v_row
    from public.user_integrations
   where tenant_id = p_tenant_id and user_id = p_user_id and provider = p_provider
   for update;
  if not found or v_row.status <> 'connected' then raise exception 'integration_not_connected'; end if;

  if v_row.refresh_lease_until is null or v_row.refresh_lease_until <= now() or v_row.refresh_owner = p_owner then
    update public.user_integrations
       set refresh_owner = p_owner,
           refresh_lease_until = now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 60), 15), 120)),
           updated_at = now()
     where tenant_id = p_tenant_id and user_id = p_user_id and provider = p_provider
     returning * into v_row;
    v_claimed := true;
  end if;

  return to_jsonb(v_row) || jsonb_build_object('claimed', v_claimed);
end;
$$;

create or replace function public.northlight_finish_user_integration_refresh(
  p_tenant_id uuid,
  p_user_id uuid,
  p_provider text,
  p_owner uuid,
  p_generation bigint,
  p_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_row public.user_integrations%rowtype;
begin
  if not public.northlight_pilot_allowed() then raise exception 'permission_denied'; end if;
  if jsonb_typeof(p_metadata) is distinct from 'object' then raise exception 'invalid_refresh_metadata'; end if;

  update public.user_integrations
     set metadata = p_metadata,
         status = 'connected',
         last_verified_at = now(),
         refresh_owner = null,
         refresh_lease_until = null,
         refresh_generation = refresh_generation + 1,
         updated_at = now()
   where tenant_id = p_tenant_id
     and user_id = p_user_id
     and provider = p_provider
     and refresh_owner = p_owner
     and refresh_generation = p_generation
  returning * into v_row;
  if not found then raise exception 'refresh_claim_lost'; end if;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.northlight_release_user_integration_refresh(
  p_tenant_id uuid,
  p_user_id uuid,
  p_provider text,
  p_owner uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.northlight_pilot_allowed() then raise exception 'permission_denied'; end if;
  update public.user_integrations
     set refresh_owner = null, refresh_lease_until = null, updated_at = now()
   where tenant_id = p_tenant_id and user_id = p_user_id and provider = p_provider and refresh_owner = p_owner;
end;
$$;

revoke all on function public.northlight_claim_integration_refresh(uuid, text, uuid, integer) from public;
revoke all on function public.northlight_finish_integration_refresh(uuid, text, uuid, bigint, jsonb) from public;
revoke all on function public.northlight_release_integration_refresh(uuid, text, uuid) from public;
revoke all on function public.northlight_claim_user_integration_refresh(uuid, uuid, text, uuid, integer) from public;
revoke all on function public.northlight_finish_user_integration_refresh(uuid, uuid, text, uuid, bigint, jsonb) from public;
revoke all on function public.northlight_release_user_integration_refresh(uuid, uuid, text, uuid) from public;

grant execute on function public.northlight_claim_integration_refresh(uuid, text, uuid, integer) to anon, authenticated;
grant execute on function public.northlight_finish_integration_refresh(uuid, text, uuid, bigint, jsonb) to anon, authenticated;
grant execute on function public.northlight_release_integration_refresh(uuid, text, uuid) to anon, authenticated;
grant execute on function public.northlight_claim_user_integration_refresh(uuid, uuid, text, uuid, integer) to anon, authenticated;
grant execute on function public.northlight_finish_user_integration_refresh(uuid, uuid, text, uuid, bigint, jsonb) to anon, authenticated;
grant execute on function public.northlight_release_user_integration_refresh(uuid, uuid, text, uuid) to anon, authenticated;
