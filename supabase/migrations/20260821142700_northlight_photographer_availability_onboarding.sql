-- Version and validate Photographer-owned availability, and derive one
-- authoritative onboarding/bookability result. New assignments and schedule
-- changes fail closed when the personal Calendar connection is unhealthy.

set lock_timeout = '5s';
set statement_timeout = '5min';

alter table public.provider_profiles
  add column if not exists availability_version bigint not null default 0,
  add column if not exists availability_updated_at timestamptz not null default pg_catalog.now(),
  add column if not exists availability_updated_by uuid;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.provider_profiles'::pg_catalog.regclass
       and conname = 'provider_profiles_availability_version_check'
  ) then
    alter table public.provider_profiles
      add constraint provider_profiles_availability_version_check
      check (availability_version >= 0) not valid;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.provider_profiles'::pg_catalog.regclass
       and conname = 'provider_profiles_availability_json_check'
  ) then
    alter table public.provider_profiles
      add constraint provider_profiles_availability_json_check
      check (
        pg_catalog.jsonb_typeof(working_hours) = 'object'
        and pg_catalog.jsonb_typeof(days_off) = 'array'
        and pg_catalog.jsonb_typeof(special_days) = 'array'
      ) not valid;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.provider_profiles'::pg_catalog.regclass
       and conname = 'provider_profiles_tenant_availability_updater_fkey'
  ) then
    alter table public.provider_profiles
      add constraint provider_profiles_tenant_availability_updater_fkey
      foreign key (tenant_id, availability_updated_by)
      references public.users(tenant_id, id)
      on delete set null (availability_updated_by)
      not valid;
  end if;
end
$$;

alter table public.provider_profiles
  validate constraint provider_profiles_availability_version_check;
alter table public.provider_profiles
  validate constraint provider_profiles_availability_json_check;
alter table public.provider_profiles
  validate constraint provider_profiles_tenant_availability_updater_fkey;

create index if not exists provider_profiles_availability_updated_by_idx
  on public.provider_profiles (availability_updated_by)
  where availability_updated_by is not null;

create or replace function public.northlight_validate_provider_availability_row()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_pair record;
  v_value jsonb;
  v_text text;
  v_date date;
  v_hours jsonb;
  v_from text;
  v_to text;
  v_count integer;
  v_distinct_count integer;
begin
  if pg_catalog.jsonb_typeof(new.working_hours) is distinct from 'object'
     or pg_catalog.jsonb_typeof(new.days_off) is distinct from 'array'
     or pg_catalog.jsonb_typeof(new.special_days) is distinct from 'array'
     or pg_catalog.jsonb_object_length(new.working_hours) > 7
     or pg_catalog.jsonb_array_length(new.days_off) > 366
     or pg_catalog.jsonb_array_length(new.special_days) > 366 then
    raise exception 'availability_shape_invalid';
  end if;

  if new.timezone is null
     or pg_catalog.length(new.timezone) not between 1 and 128
     or not exists (
       select 1 from pg_catalog.pg_timezone_names timezone_row
        where timezone_row.name = new.timezone
     ) then
    raise exception 'availability_timezone_invalid';
  end if;

  for v_pair in
    select entry.key, entry.value
      from pg_catalog.jsonb_each(new.working_hours) entry
  loop
    if v_pair.key not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')
       or pg_catalog.jsonb_typeof(v_pair.value) is distinct from 'array'
       or pg_catalog.jsonb_array_length(v_pair.value) <> 2
       or pg_catalog.jsonb_typeof(v_pair.value -> 0) is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_pair.value -> 1) is distinct from 'string' then
      raise exception 'availability_working_hours_invalid';
    end if;
    v_from := v_pair.value ->> 0;
    v_to := v_pair.value ->> 1;
    if v_from !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or v_to !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       or v_from >= v_to then
      raise exception 'availability_working_hours_invalid';
    end if;
  end loop;

  select pg_catalog.count(*), pg_catalog.count(distinct value)
    into v_count, v_distinct_count
    from pg_catalog.jsonb_array_elements_text(new.days_off) day_row(value);
  if v_count <> v_distinct_count then
    raise exception 'availability_day_duplicate';
  end if;
  for v_value in select value from pg_catalog.jsonb_array_elements(new.days_off)
  loop
    if pg_catalog.jsonb_typeof(v_value) is distinct from 'string' then
      raise exception 'availability_day_invalid';
    end if;
    v_text := v_value #>> '{}';
    if v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'availability_day_invalid';
    end if;
    begin
      v_date := v_text::date;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'availability_day_invalid';
    end;
    if pg_catalog.to_char(v_date, 'YYYY-MM-DD') <> v_text then
      raise exception 'availability_day_invalid';
    end if;
  end loop;

  select pg_catalog.count(*), pg_catalog.count(distinct value ->> 'date')
    into v_count, v_distinct_count
    from pg_catalog.jsonb_array_elements(new.special_days) special_row(value);
  if v_count <> v_distinct_count then
    raise exception 'availability_special_day_duplicate';
  end if;
  for v_value in select value from pg_catalog.jsonb_array_elements(new.special_days)
  loop
    if pg_catalog.jsonb_typeof(v_value) is distinct from 'object'
       or exists (
         select 1 from pg_catalog.jsonb_object_keys(v_value) field_name
          where field_name not in ('date', 'closed', 'hours')
       )
       or pg_catalog.jsonb_typeof(v_value -> 'date') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_value -> 'closed') is distinct from 'boolean' then
      raise exception 'availability_special_day_invalid';
    end if;
    v_text := v_value ->> 'date';
    if v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'availability_special_day_invalid';
    end if;
    begin
      v_date := v_text::date;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'availability_special_day_invalid';
    end;
    if pg_catalog.to_char(v_date, 'YYYY-MM-DD') <> v_text then
      raise exception 'availability_special_day_invalid';
    end if;

    if (v_value ->> 'closed')::boolean then
      if v_value ? 'hours' then
        raise exception 'availability_special_day_invalid';
      end if;
    else
      v_hours := v_value -> 'hours';
      if pg_catalog.jsonb_typeof(v_hours) is distinct from 'array'
         or pg_catalog.jsonb_array_length(v_hours) <> 2
         or pg_catalog.jsonb_typeof(v_hours -> 0) is distinct from 'string'
         or pg_catalog.jsonb_typeof(v_hours -> 1) is distinct from 'string' then
        raise exception 'availability_special_day_invalid';
      end if;
      v_from := v_hours ->> 0;
      v_to := v_hours ->> 1;
      if v_from !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or v_to !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or v_from >= v_to then
        raise exception 'availability_special_day_invalid';
      end if;
    end if;
  end loop;

  if exists (
    select 1
      from pg_catalog.jsonb_array_elements_text(new.days_off) day_row(value)
      join pg_catalog.jsonb_array_elements(new.special_days) special_row(value)
        on special_row.value ->> 'date' = day_row.value
  ) then
    raise exception 'availability_date_rule_conflict';
  end if;

  if tg_op = 'INSERT' then
    new.availability_version := coalesce(new.availability_version, 0);
    new.availability_updated_at := coalesce(
      new.availability_updated_at,
      pg_catalog.clock_timestamp()
    );
  elsif new.working_hours is distinct from old.working_hours
     or new.days_off is distinct from old.days_off
     or new.special_days is distinct from old.special_days
     or new.timezone is distinct from old.timezone then
    if new.availability_version = old.availability_version then
      new.availability_version := old.availability_version + 1;
    elsif new.availability_version <> old.availability_version + 1 then
      raise exception 'availability_version_invalid';
    end if;
    if new.availability_updated_at is not distinct from old.availability_updated_at then
      new.availability_updated_at := pg_catalog.clock_timestamp();
    end if;
  elsif new.availability_version is distinct from old.availability_version then
    raise exception 'availability_version_invalid';
  end if;
  return new;
end
$$;

drop trigger if exists northlight_validate_provider_availability
  on public.provider_profiles;
create trigger northlight_validate_provider_availability
before insert or update
on public.provider_profiles
for each row execute function public.northlight_validate_provider_availability_row();

revoke all on function public.northlight_validate_provider_availability_row()
  from public, anon, authenticated;

create or replace function public.northlight_update_provider_availability(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_user_id uuid,
  p_expected_version bigint,
  p_working_hours jsonb,
  p_days_off jsonb,
  p_special_days jsonb,
  p_timezone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.users%rowtype;
  v_user public.users%rowtype;
  v_profile public.provider_profiles%rowtype;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  if p_tenant_id is null or p_actor_user_id is null or p_user_id is null
     or p_expected_version is null or p_expected_version < 0 then
    raise exception 'availability_request_invalid';
  end if;

  select * into v_actor
    from public.users actor
   where actor.tenant_id = p_tenant_id
     and actor.id = p_actor_user_id
     and actor.active is true
   for key share;
  if not found
     or not (
       (v_actor.id = p_user_id and v_actor.role_code = 'photographer')
       or v_actor.role_code in ('admin', 'owner')
     ) then
    raise exception 'availability_permission_denied';
  end if;

  select * into v_user
    from public.users user_row
   where user_row.tenant_id = p_tenant_id
     and user_row.id = p_user_id
     and user_row.active is true
     and user_row.role_code = 'photographer'
   for update;
  if not found then raise exception 'availability_photographer_not_found'; end if;
  select * into v_profile
    from public.provider_profiles profile
   where profile.tenant_id = p_tenant_id
     and profile.user_id = p_user_id
   for update;
  if not found then raise exception 'availability_profile_not_found'; end if;
  if v_profile.availability_version is distinct from p_expected_version then
    raise exception 'availability_version_changed';
  end if;

  update public.provider_profiles profile
     set working_hours = p_working_hours,
         days_off = p_days_off,
         special_days = p_special_days,
         timezone = p_timezone,
         availability_version = p_expected_version + 1,
         availability_updated_at = pg_catalog.clock_timestamp(),
         availability_updated_by = p_actor_user_id
   where profile.tenant_id = p_tenant_id
     and profile.user_id = p_user_id
     and profile.availability_version = p_expected_version
  returning * into v_profile;
  if not found then raise exception 'availability_version_changed'; end if;

  return pg_catalog.jsonb_build_object(
    'user_id', v_profile.user_id,
    'version', v_profile.availability_version,
    'working_hours', v_profile.working_hours,
    'days_off', v_profile.days_off,
    'special_days', v_profile.special_days,
    'timezone', v_profile.timezone,
    'updated_at', v_profile.availability_updated_at,
    'updated_by', v_profile.availability_updated_by
  );
end
$$;

create or replace function northlight_private.photographer_bookability(
  p_tenant_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user public.users%rowtype;
  v_profile public.provider_profiles%rowtype;
  v_integration public.user_integrations%rowtype;
  v_state public.calendar_sync_state%rowtype;
  v_credential_ready boolean := false;
  v_profile_ready boolean := false;
  v_calendar_connected boolean := false;
  v_calendar_sync_healthy boolean := false;
  v_calendar_watch_healthy boolean := false;
  v_blockers text[] := array[]::text[];
begin
  select * into v_user
    from public.users user_row
   where user_row.tenant_id = p_tenant_id
     and user_row.id = p_user_id
     and user_row.active is true
     and user_row.role_code = 'photographer';
  if not found then
    return pg_catalog.jsonb_build_object(
      'bookable', false,
      'credential_ready', false,
      'profile_ready', false,
      'calendar_connected', false,
      'calendar_sync_healthy', false,
      'calendar_watch_healthy', false,
      'blockers', pg_catalog.to_jsonb(array['photographer_ineligible']::text[])
    );
  end if;

  v_credential_ready := not v_user.auth_must_change_password;
  select * into v_profile
    from public.provider_profiles profile
   where profile.tenant_id = p_tenant_id and profile.user_id = p_user_id;
  if found then
    v_profile_ready := pg_catalog.cardinality(v_profile.areas) > 0
      and pg_catalog.cardinality(v_profile.service_codes) > 0
      and pg_catalog.jsonb_object_length(v_profile.working_hours) > 0
      and v_profile.timezone is not null;
  end if;

  select * into v_integration
    from public.user_integrations connection
   where connection.tenant_id = p_tenant_id
     and connection.user_id = p_user_id
     and connection.provider = 'google';
  v_calendar_connected := found and v_integration.status = 'connected';
  if v_calendar_connected then
    select * into v_state
      from public.calendar_sync_state state_row
     where state_row.tenant_id = p_tenant_id
       and state_row.user_id = p_user_id
       and state_row.provider = 'google'
     order by coalesce(
       state_row.last_incremental_sync_at,
       state_row.last_full_sync_at,
       '-infinity'::timestamptz
     ) desc
     limit 1;
    if found then
      v_calendar_sync_healthy := v_state.connection_generation = v_integration.refresh_generation
        and v_state.last_error is null
        and greatest(v_state.last_incremental_sync_at, v_state.last_full_sync_at)
          >= pg_catalog.now() - interval '24 hours';
      select exists (
        select 1 from public.calendar_watch_channels channel
         where channel.tenant_id = p_tenant_id
           and channel.user_id = p_user_id
           and channel.provider = 'google'
           and channel.calendar_id = v_state.calendar_id
           and channel.connection_generation = v_integration.refresh_generation
           and channel.status = 'active'
           and channel.expires_at > pg_catalog.now() + interval '15 minutes'
      ) into v_calendar_watch_healthy;
    end if;
  end if;

  if not v_credential_ready then
    v_blockers := pg_catalog.array_append(v_blockers, 'personal_password_required');
  end if;
  if not v_profile_ready then
    v_blockers := pg_catalog.array_append(v_blockers, 'availability_profile_incomplete');
  end if;
  if not v_calendar_connected then
    v_blockers := pg_catalog.array_append(v_blockers, 'calendar_not_connected');
  elsif not v_calendar_sync_healthy then
    v_blockers := pg_catalog.array_append(v_blockers, 'calendar_sync_unhealthy');
  elsif not v_calendar_watch_healthy then
    v_blockers := pg_catalog.array_append(v_blockers, 'calendar_watch_unhealthy');
  end if;

  return pg_catalog.jsonb_build_object(
    'bookable', v_credential_ready and v_profile_ready
      and v_calendar_connected and v_calendar_sync_healthy
      and v_calendar_watch_healthy,
    'credential_ready', v_credential_ready,
    'must_change_password', v_user.auth_must_change_password,
    'profile_ready', v_profile_ready,
    'availability_version', case when v_profile.user_id is null
      then null else v_profile.availability_version end,
    'availability_updated_at', case when v_profile.user_id is null
      then null else v_profile.availability_updated_at end,
    'calendar_connected', v_calendar_connected,
    'calendar_sync_healthy', v_calendar_sync_healthy,
    'calendar_watch_healthy', v_calendar_watch_healthy,
    'calendar_id', case when v_state.id is null then null else v_state.calendar_id end,
    'last_calendar_sync_at', case when v_state.id is null then null else
      greatest(v_state.last_incremental_sync_at, v_state.last_full_sync_at) end,
    'watch_expires_at', case when v_state.id is null then null else
      v_state.channel_expires_at end,
    'blockers', pg_catalog.to_jsonb(v_blockers)
  );
end
$$;

revoke all on function northlight_private.photographer_bookability(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.northlight_photographer_onboarding_status(
  p_tenant_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  if p_tenant_id is null or p_user_id is null then
    raise exception 'onboarding_status_request_invalid';
  end if;
  return northlight_private.photographer_bookability(p_tenant_id, p_user_id);
end
$$;

create or replace function public.northlight_require_bookable_photographer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare v_status jsonb;
begin
  if new.photographer_user_id is null
     or new.scheduled_start is null
     or new.scheduled_end is null
     or new.status in ('cancelled', 'declined', 'delivered') then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.photographer_user_id is not distinct from old.photographer_user_id
     and new.scheduled_start is not distinct from old.scheduled_start
     and new.scheduled_end is not distinct from old.scheduled_end then
    return new;
  end if;
  v_status := northlight_private.photographer_bookability(
    new.tenant_id,
    new.photographer_user_id
  );
  if (v_status ->> 'bookable')::boolean is not true then
    raise exception 'photographer_not_bookable';
  end if;
  return new;
end
$$;

drop trigger if exists northlight_require_bookable_photographer on public.tasks;
create trigger northlight_require_bookable_photographer
before insert or update
on public.tasks
for each row execute function public.northlight_require_bookable_photographer();

revoke all on function public.northlight_require_bookable_photographer()
  from public, anon, authenticated;
revoke all on function public.northlight_update_provider_availability(
  uuid, uuid, uuid, bigint, jsonb, jsonb, jsonb, text
) from public, authenticated, service_role;
revoke all on function public.northlight_photographer_onboarding_status(uuid, uuid)
  from public, authenticated, service_role;

grant execute on function public.northlight_update_provider_availability(
  uuid, uuid, uuid, bigint, jsonb, jsonb, jsonb, text
) to anon;
grant execute on function public.northlight_photographer_onboarding_status(uuid, uuid)
  to anon;

comment on function public.northlight_update_provider_availability(
  uuid, uuid, uuid, bigint, jsonb, jsonb, jsonb, text
) is
  'CAS-updates canonical Photographer hours, days off, special days, and IANA timezone.';
comment on function public.northlight_photographer_onboarding_status(uuid, uuid) is
  'Derives credential, profile, Calendar cursor/watch health, blockers, and bookability.';

reset lock_timeout;
reset statement_timeout;
