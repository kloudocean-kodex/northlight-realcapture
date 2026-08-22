-- Serialize Google Calendar cursor work and model webhook channel renewal as
-- an overlap, not an overwrite. Callback secrets are stored only as SHA-256
-- hashes; active and draining channels remain recognizable until stopped or
-- expired. All provider calls remain outside the database transaction and are
-- fenced by owner, operation generation, and OAuth connection generation.

set lock_timeout = '5s';
set statement_timeout = '5min';

alter table public.calendar_sync_state
  add column if not exists sync_owner uuid,
  add column if not exists sync_generation bigint not null default 0,
  add column if not exists sync_lease_until timestamptz,
  add column if not exists watch_owner uuid,
  add column if not exists watch_generation bigint not null default 0,
  add column if not exists watch_lease_until timestamptz,
  add column if not exists connection_generation bigint not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.calendar_sync_state'::pg_catalog.regclass
       and conname = 'calendar_sync_state_generations_check'
  ) then
    alter table public.calendar_sync_state
      add constraint calendar_sync_state_generations_check
      check (
        sync_generation >= 0
        and watch_generation >= 0
        and connection_generation >= 0
      ) not valid;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.calendar_sync_state'::pg_catalog.regclass
       and conname = 'calendar_sync_state_sync_lease_pair_check'
  ) then
    alter table public.calendar_sync_state
      add constraint calendar_sync_state_sync_lease_pair_check
      check ((sync_owner is null) = (sync_lease_until is null)) not valid;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.calendar_sync_state'::pg_catalog.regclass
       and conname = 'calendar_sync_state_watch_lease_pair_check'
  ) then
    alter table public.calendar_sync_state
      add constraint calendar_sync_state_watch_lease_pair_check
      check ((watch_owner is null) = (watch_lease_until is null)) not valid;
  end if;
end
$$;

alter table public.calendar_sync_state
  validate constraint calendar_sync_state_generations_check;
alter table public.calendar_sync_state
  validate constraint calendar_sync_state_sync_lease_pair_check;
alter table public.calendar_sync_state
  validate constraint calendar_sync_state_watch_lease_pair_check;

create index if not exists calendar_sync_state_sync_lease_idx
  on public.calendar_sync_state (sync_lease_until)
  where sync_lease_until is not null;
create index if not exists calendar_sync_state_watch_lease_idx
  on public.calendar_sync_state (watch_lease_until)
  where watch_lease_until is not null;

create table if not exists public.calendar_watch_channels (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null,
  provider text not null default 'google' check (provider = 'google'),
  calendar_id text not null,
  channel_id text not null unique
    check (pg_catalog.length(channel_id) between 1 and 256),
  resource_id text
    check (resource_id is null or pg_catalog.length(resource_id) between 1 and 1024),
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  connection_generation bigint not null check (connection_generation >= 0),
  generation bigint not null check (generation >= 1),
  status text not null check (status in ('pending', 'active', 'draining', 'stopped')),
  expires_at timestamptz,
  stop_requested_at timestamptz,
  stopped_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint calendar_watch_channels_scope_fkey
    foreign key (tenant_id, user_id, provider, calendar_id)
    references public.calendar_sync_state(tenant_id, user_id, provider, calendar_id)
    on delete cascade,
  constraint calendar_watch_channels_tenant_user_fkey
    foreign key (tenant_id, user_id)
    references public.users(tenant_id, id)
    on delete cascade,
  constraint calendar_watch_channels_lifecycle_check check (
    (status = 'pending' and resource_id is null and expires_at is null and stopped_at is null)
    or (status in ('active', 'draining') and resource_id is not null and expires_at is not null and stopped_at is null)
    or (status = 'stopped' and stopped_at is not null)
  )
);

create unique index if not exists calendar_watch_channels_scope_generation_uidx
  on public.calendar_watch_channels (
    tenant_id, user_id, provider, calendar_id, generation
  );
create unique index if not exists calendar_watch_channels_one_active_uidx
  on public.calendar_watch_channels (tenant_id, user_id, provider, calendar_id)
  where status = 'active';
create unique index if not exists calendar_watch_channels_one_pending_uidx
  on public.calendar_watch_channels (tenant_id, user_id, provider, calendar_id)
  where status = 'pending';
create index if not exists calendar_watch_channels_lookup_idx
  on public.calendar_watch_channels (tenant_id, channel_id, expires_at)
  where status in ('active', 'draining');
create index if not exists calendar_watch_channels_cleanup_idx
  on public.calendar_watch_channels (expires_at, status);

alter table public.calendar_watch_channels enable row level security;
revoke all on table public.calendar_watch_channels
  from public, anon, authenticated, service_role;
grant all on table public.calendar_watch_channels to service_role;

-- Carry forward a currently valid legacy channel without retaining its raw
-- callback token. Channels lacking complete identity become intentionally
-- unknown and must be renewed by the new flow.
update public.calendar_sync_state state_row
   set connection_generation = connection.refresh_generation,
       watch_generation = case
         when state_row.channel_id is not null then greatest(state_row.watch_generation, 1)
         else state_row.watch_generation
       end
  from public.user_integrations connection
 where connection.tenant_id = state_row.tenant_id
   and connection.user_id = state_row.user_id
   and connection.provider = 'google';

insert into public.calendar_watch_channels (
  tenant_id, user_id, provider, calendar_id, channel_id, resource_id,
  token_hash, connection_generation, generation, status, expires_at
)
select state_row.tenant_id,
       state_row.user_id,
       state_row.provider,
       state_row.calendar_id,
       state_row.channel_id,
       state_row.resource_id,
       pg_catalog.encode(
         extensions.digest(state_row.metadata ->> 'webhook_token', 'sha256'),
         'hex'
       ),
       state_row.connection_generation,
       greatest(state_row.watch_generation, 1),
       'active',
       state_row.channel_expires_at
  from public.calendar_sync_state state_row
 where state_row.provider = 'google'
   and state_row.channel_id is not null
   and state_row.resource_id is not null
   and state_row.channel_expires_at > pg_catalog.now()
   and pg_catalog.length(state_row.metadata ->> 'webhook_token') between 16 and 512
on conflict (channel_id) do nothing;

update public.calendar_sync_state state_row
   set channel_id = case when migrated.channel_id is null then null else state_row.channel_id end,
       resource_id = case when migrated.channel_id is null then null else state_row.resource_id end,
       channel_expires_at = case when migrated.channel_id is null then null else state_row.channel_expires_at end,
       metadata = state_row.metadata - 'webhook_token'
  from (select state_row_inner.id,
               (
                 select channel.channel_id
                   from public.calendar_watch_channels channel
                  where channel.tenant_id = state_row_inner.tenant_id
                    and channel.user_id = state_row_inner.user_id
                    and channel.provider = state_row_inner.provider
                    and channel.calendar_id = state_row_inner.calendar_id
                    and channel.status = 'active'
                  limit 1
               ) as channel_id
          from public.calendar_sync_state state_row_inner) migrated
 where migrated.id = state_row.id;

create or replace function public.northlight_claim_calendar_sync(
  p_tenant_id uuid,
  p_user_id uuid,
  p_calendar_id text,
  p_owner uuid,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user public.users%rowtype;
  v_integration public.user_integrations%rowtype;
  v_state public.calendar_sync_state%rowtype;
  v_lease_seconds integer;
  v_claimed boolean := false;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  if p_tenant_id is null or p_user_id is null or p_owner is null
     or p_calendar_id is null
     or pg_catalog.length(p_calendar_id) not between 1 and 1024
     or pg_catalog.strpos(p_calendar_id, E'\r') > 0
     or pg_catalog.strpos(p_calendar_id, E'\n') > 0 then
    raise exception 'invalid_calendar_sync_claim';
  end if;
  v_lease_seconds := least(
    greatest(coalesce(p_lease_seconds, 120), 15),
    300
  );

  select * into v_integration
    from public.user_integrations connection
   where connection.tenant_id = p_tenant_id
     and connection.user_id = p_user_id
     and connection.provider = 'google'
   for share;
  if not found or v_integration.status <> 'connected' then
    raise exception 'calendar_not_connected';
  end if;
  select * into v_user
    from public.users user_row
   where user_row.tenant_id = p_tenant_id
     and user_row.id = p_user_id
     and user_row.active is true
     and user_row.role_code = 'photographer'
   for key share;
  if not found then raise exception 'calendar_user_ineligible'; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_tenant_id::text || ':calendar-sync:' || p_user_id::text || ':' || p_calendar_id,
      0
    )
  );
  insert into public.calendar_sync_state (
    tenant_id, user_id, provider, calendar_id, connection_generation
  ) values (
    p_tenant_id, p_user_id, 'google', p_calendar_id,
    v_integration.refresh_generation
  )
  on conflict (tenant_id, user_id, provider, calendar_id) do nothing;

  select * into v_state
    from public.calendar_sync_state state_row
   where state_row.tenant_id = p_tenant_id
     and state_row.user_id = p_user_id
     and state_row.provider = 'google'
     and state_row.calendar_id = p_calendar_id
   for update;

  if v_state.connection_generation <> v_integration.refresh_generation then
    update public.calendar_watch_channels channel
       set status = 'stopped', stopped_at = pg_catalog.now(), updated_at = pg_catalog.now()
     where channel.tenant_id = p_tenant_id
       and channel.user_id = p_user_id
       and channel.provider = 'google'
       and channel.calendar_id = p_calendar_id
       and channel.status <> 'stopped';
    update public.calendar_sync_state state_row
       set sync_token = null,
           channel_id = null,
           resource_id = null,
           channel_expires_at = null,
           last_error = null,
           metadata = state_row.metadata - 'webhook_token',
           sync_owner = null,
           sync_lease_until = null,
           watch_owner = null,
           watch_lease_until = null,
           sync_generation = state_row.sync_generation + 1,
           watch_generation = state_row.watch_generation + 1,
           connection_generation = v_integration.refresh_generation
     where state_row.id = v_state.id
    returning * into v_state;
  end if;

  if v_state.sync_owner is null
     or v_state.sync_lease_until is null
     or v_state.sync_lease_until <= pg_catalog.now()
     or v_state.sync_owner = p_owner then
    update public.calendar_sync_state state_row
       set sync_generation = case
             when state_row.sync_owner = p_owner
              and state_row.sync_lease_until > pg_catalog.now()
             then state_row.sync_generation
             else state_row.sync_generation + 1
           end,
           sync_owner = p_owner,
           sync_lease_until = pg_catalog.now()
             + pg_catalog.make_interval(secs => v_lease_seconds)
     where state_row.id = v_state.id
    returning * into v_state;
    v_claimed := true;
  end if;

  if not v_claimed then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'generation', v_state.sync_generation,
      'connection_generation', v_state.connection_generation
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'claimed', true,
    'generation', v_state.sync_generation,
    'connection_generation', v_state.connection_generation,
    'sync_token', v_state.sync_token,
    'last_full_sync_at', v_state.last_full_sync_at,
    'last_incremental_sync_at', v_state.last_incremental_sync_at,
    'lease_until', v_state.sync_lease_until
  );
end
$$;

create or replace function public.northlight_advance_calendar_sync(
  p_tenant_id uuid,
  p_user_id uuid,
  p_calendar_id text,
  p_owner uuid,
  p_generation bigint,
  p_expected_sync_token text,
  p_sync_token text,
  p_sync_kind text,
  p_synced_at timestamptz,
  p_last_error text,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_integration public.user_integrations%rowtype;
  v_state public.calendar_sync_state%rowtype;
  v_lease_seconds integer;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  if p_tenant_id is null or p_user_id is null or p_owner is null
     or p_generation is null or p_generation < 1
     or p_calendar_id is null or pg_catalog.length(p_calendar_id) not between 1 and 1024
     or p_sync_kind not in ('full', 'incremental', 'reset')
     or p_synced_at is null
     or p_synced_at > pg_catalog.now() + interval '5 minutes'
     or p_synced_at < pg_catalog.now() - interval '24 hours'
     or (p_expected_sync_token is not null and pg_catalog.length(p_expected_sync_token) > 16384)
     or (p_sync_token is not null and pg_catalog.length(p_sync_token) > 16384)
     or (p_sync_kind <> 'reset' and p_sync_token is null)
     or (p_last_error is not null and pg_catalog.length(p_last_error) > 1000) then
    raise exception 'invalid_calendar_sync_advance';
  end if;
  v_lease_seconds := least(
    greatest(coalesce(p_lease_seconds, 120), 15),
    300
  );

  select * into v_integration
    from public.user_integrations connection
   where connection.tenant_id = p_tenant_id
     and connection.user_id = p_user_id
     and connection.provider = 'google'
   for share;
  if not found or v_integration.status <> 'connected' then
    raise exception 'calendar_connection_changed';
  end if;
  select * into v_state
    from public.calendar_sync_state state_row
   where state_row.tenant_id = p_tenant_id
     and state_row.user_id = p_user_id
     and state_row.provider = 'google'
     and state_row.calendar_id = p_calendar_id
   for update;
  if not found
     or v_state.sync_owner is distinct from p_owner
     or v_state.sync_generation is distinct from p_generation
     or v_state.sync_lease_until is null
     or v_state.sync_lease_until <= pg_catalog.now()
     or v_state.connection_generation is distinct from v_integration.refresh_generation then
    raise exception 'calendar_sync_claim_lost';
  end if;
  if v_state.sync_token is distinct from p_expected_sync_token then
    raise exception 'calendar_sync_token_changed';
  end if;

  update public.calendar_sync_state state_row
     set sync_token = p_sync_token,
         last_full_sync_at = case when p_sync_kind = 'full'
           then p_synced_at else state_row.last_full_sync_at end,
         last_incremental_sync_at = case when p_sync_kind in ('full', 'incremental')
           then p_synced_at else state_row.last_incremental_sync_at end,
         last_error = p_last_error,
         sync_lease_until = pg_catalog.now()
           + pg_catalog.make_interval(secs => v_lease_seconds)
   where state_row.id = v_state.id
  returning * into v_state;

  return pg_catalog.jsonb_build_object(
    'generation', v_state.sync_generation,
    'connection_generation', v_state.connection_generation,
    'sync_token', v_state.sync_token,
    'last_full_sync_at', v_state.last_full_sync_at,
    'last_incremental_sync_at', v_state.last_incremental_sync_at,
    'last_error', v_state.last_error,
    'lease_until', v_state.sync_lease_until
  );
end
$$;

create or replace function public.northlight_finish_calendar_sync(
  p_tenant_id uuid,
  p_user_id uuid,
  p_calendar_id text,
  p_owner uuid,
  p_generation bigint,
  p_last_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_state public.calendar_sync_state%rowtype;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  if p_tenant_id is null or p_user_id is null or p_owner is null
     or p_generation is null or p_generation < 1
     or p_calendar_id is null
     or (p_last_error is not null and pg_catalog.length(p_last_error) > 1000) then
    raise exception 'invalid_calendar_sync_finish';
  end if;
  update public.calendar_sync_state state_row
     set sync_owner = null,
         sync_lease_until = null,
         last_error = p_last_error
   where state_row.tenant_id = p_tenant_id
     and state_row.user_id = p_user_id
     and state_row.provider = 'google'
     and state_row.calendar_id = p_calendar_id
     and state_row.sync_owner = p_owner
     and state_row.sync_generation = p_generation
  returning * into v_state;
  if not found then raise exception 'calendar_sync_claim_lost'; end if;
  return pg_catalog.jsonb_build_object(
    'finished', true,
    'generation', v_state.sync_generation,
    'connection_generation', v_state.connection_generation,
    'sync_token', v_state.sync_token,
    'last_error', v_state.last_error
  );
end
$$;

create or replace function public.northlight_claim_calendar_watch(
  p_tenant_id uuid,
  p_user_id uuid,
  p_calendar_id text,
  p_owner uuid,
  p_channel_id text,
  p_token_hash text,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user public.users%rowtype;
  v_integration public.user_integrations%rowtype;
  v_state public.calendar_sync_state%rowtype;
  v_pending public.calendar_watch_channels%rowtype;
  v_active public.calendar_watch_channels%rowtype;
  v_lease_seconds integer;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  if p_tenant_id is null or p_user_id is null or p_owner is null
     or p_calendar_id is null or pg_catalog.length(p_calendar_id) not between 1 and 1024
     or p_channel_id is null or pg_catalog.length(p_channel_id) not between 1 and 256
     or p_channel_id ~ '[\r\n]'
     or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_calendar_watch_claim';
  end if;
  v_lease_seconds := least(
    greatest(coalesce(p_lease_seconds, 120), 15),
    300
  );

  select * into v_integration
    from public.user_integrations connection
   where connection.tenant_id = p_tenant_id
     and connection.user_id = p_user_id
     and connection.provider = 'google'
   for share;
  if not found or v_integration.status <> 'connected' then
    raise exception 'calendar_not_connected';
  end if;
  select * into v_user
    from public.users user_row
   where user_row.tenant_id = p_tenant_id
     and user_row.id = p_user_id
     and user_row.active is true
     and user_row.role_code = 'photographer'
   for key share;
  if not found then raise exception 'calendar_user_ineligible'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_tenant_id::text || ':calendar-watch:' || p_user_id::text || ':' || p_calendar_id,
      0
    )
  );
  insert into public.calendar_sync_state (
    tenant_id, user_id, provider, calendar_id, connection_generation
  ) values (
    p_tenant_id, p_user_id, 'google', p_calendar_id,
    v_integration.refresh_generation
  )
  on conflict (tenant_id, user_id, provider, calendar_id) do nothing;
  select * into v_state
    from public.calendar_sync_state state_row
   where state_row.tenant_id = p_tenant_id
     and state_row.user_id = p_user_id
     and state_row.provider = 'google'
     and state_row.calendar_id = p_calendar_id
   for update;

  if v_state.connection_generation <> v_integration.refresh_generation then
    update public.calendar_watch_channels channel
       set status = 'stopped', stopped_at = pg_catalog.now(), updated_at = pg_catalog.now()
     where channel.tenant_id = p_tenant_id
       and channel.user_id = p_user_id
       and channel.provider = 'google'
       and channel.calendar_id = p_calendar_id
       and channel.status <> 'stopped';
    update public.calendar_sync_state state_row
       set sync_token = null,
           channel_id = null,
           resource_id = null,
           channel_expires_at = null,
           metadata = state_row.metadata - 'webhook_token',
           sync_owner = null,
           sync_lease_until = null,
           watch_owner = null,
           watch_lease_until = null,
           sync_generation = state_row.sync_generation + 1,
           watch_generation = state_row.watch_generation + 1,
           connection_generation = v_integration.refresh_generation
     where state_row.id = v_state.id
    returning * into v_state;
  end if;

  select * into v_active
    from public.calendar_watch_channels channel
   where channel.tenant_id = p_tenant_id
     and channel.user_id = p_user_id
     and channel.provider = 'google'
     and channel.calendar_id = p_calendar_id
     and channel.status = 'active'
     and channel.expires_at > pg_catalog.now();

  if v_state.watch_owner is not null
     and v_state.watch_owner <> p_owner
     and v_state.watch_lease_until > pg_catalog.now() then
    return pg_catalog.jsonb_build_object(
      'claimed', false,
      'generation', v_state.watch_generation,
      'connection_generation', v_state.connection_generation,
      'current', case when v_active.id is null then null else
        pg_catalog.jsonb_build_object(
          'channel_id', v_active.channel_id,
          'resource_id', v_active.resource_id,
          'expires_at', v_active.expires_at
        ) end
    );
  end if;

  if v_state.watch_owner = p_owner
     and v_state.watch_lease_until > pg_catalog.now() then
    select * into v_pending
      from public.calendar_watch_channels channel
     where channel.tenant_id = p_tenant_id
       and channel.user_id = p_user_id
       and channel.provider = 'google'
       and channel.calendar_id = p_calendar_id
       and channel.generation = v_state.watch_generation
       and channel.status = 'pending'
     for update;
    if not found
       or v_pending.channel_id is distinct from p_channel_id
       or v_pending.token_hash is distinct from p_token_hash then
      raise exception 'calendar_watch_claim_in_progress';
    end if;
    update public.calendar_sync_state state_row
       set watch_lease_until = pg_catalog.now()
         + pg_catalog.make_interval(secs => v_lease_seconds)
     where state_row.id = v_state.id
    returning * into v_state;
  else
    update public.calendar_watch_channels channel
       set status = 'stopped', stopped_at = pg_catalog.now(), updated_at = pg_catalog.now()
     where channel.tenant_id = p_tenant_id
       and channel.user_id = p_user_id
       and channel.provider = 'google'
       and channel.calendar_id = p_calendar_id
       and channel.status = 'pending';
    update public.calendar_sync_state state_row
       set watch_generation = state_row.watch_generation + 1,
           watch_owner = p_owner,
           watch_lease_until = pg_catalog.now()
             + pg_catalog.make_interval(secs => v_lease_seconds)
     where state_row.id = v_state.id
    returning * into v_state;
    insert into public.calendar_watch_channels (
      tenant_id, user_id, provider, calendar_id, channel_id, token_hash,
      connection_generation, generation, status
    ) values (
      p_tenant_id, p_user_id, 'google', p_calendar_id, p_channel_id,
      p_token_hash, v_state.connection_generation, v_state.watch_generation,
      'pending'
    )
    returning * into v_pending;
  end if;

  return pg_catalog.jsonb_build_object(
    'claimed', true,
    'generation', v_state.watch_generation,
    'connection_generation', v_state.connection_generation,
    'channel_id', v_pending.channel_id,
    'lease_until', v_state.watch_lease_until,
    'current', case when v_active.id is null then null else
      pg_catalog.jsonb_build_object(
        'channel_id', v_active.channel_id,
        'resource_id', v_active.resource_id,
        'expires_at', v_active.expires_at
      ) end
  );
exception
  when unique_violation then
    raise exception 'calendar_watch_channel_collision';
end
$$;

create or replace function public.northlight_activate_calendar_watch(
  p_tenant_id uuid,
  p_user_id uuid,
  p_calendar_id text,
  p_owner uuid,
  p_generation bigint,
  p_channel_id text,
  p_resource_id text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_integration public.user_integrations%rowtype;
  v_state public.calendar_sync_state%rowtype;
  v_channel public.calendar_watch_channels%rowtype;
  v_retired jsonb;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  if p_tenant_id is null or p_user_id is null or p_owner is null
     or p_generation is null or p_generation < 1
     or p_calendar_id is null
     or p_channel_id is null or pg_catalog.length(p_channel_id) not between 1 and 256
     or p_resource_id is null or pg_catalog.length(p_resource_id) not between 1 and 1024
     or p_expires_at is null
     or p_expires_at <= pg_catalog.now() + interval '1 minute'
     or p_expires_at > pg_catalog.now() + interval '30 days' then
    raise exception 'invalid_calendar_watch_activation';
  end if;

  select * into v_integration
    from public.user_integrations connection
   where connection.tenant_id = p_tenant_id
     and connection.user_id = p_user_id
     and connection.provider = 'google'
   for share;
  if not found or v_integration.status <> 'connected' then
    raise exception 'calendar_connection_changed';
  end if;
  select * into v_state
    from public.calendar_sync_state state_row
   where state_row.tenant_id = p_tenant_id
     and state_row.user_id = p_user_id
     and state_row.provider = 'google'
     and state_row.calendar_id = p_calendar_id
   for update;
  if not found
     or v_state.watch_owner is distinct from p_owner
     or v_state.watch_generation is distinct from p_generation
     or v_state.watch_lease_until is null
     or v_state.watch_lease_until <= pg_catalog.now()
     or v_state.connection_generation is distinct from v_integration.refresh_generation then
    raise exception 'calendar_watch_claim_lost';
  end if;
  select * into v_channel
    from public.calendar_watch_channels channel
   where channel.tenant_id = p_tenant_id
     and channel.user_id = p_user_id
     and channel.provider = 'google'
     and channel.calendar_id = p_calendar_id
     and channel.channel_id = p_channel_id
     and channel.generation = p_generation
     and channel.status = 'pending'
   for update;
  if not found then raise exception 'calendar_watch_pending_missing'; end if;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'channel_id', channel.channel_id,
               'resource_id', channel.resource_id
             ) order by channel.created_at
           ),
           '[]'::jsonb
         )
    into v_retired
    from public.calendar_watch_channels channel
   where channel.tenant_id = p_tenant_id
     and channel.user_id = p_user_id
     and channel.provider = 'google'
     and channel.calendar_id = p_calendar_id
     and channel.status = 'active';

  update public.calendar_watch_channels channel
     set status = 'draining',
         stop_requested_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where channel.tenant_id = p_tenant_id
     and channel.user_id = p_user_id
     and channel.provider = 'google'
     and channel.calendar_id = p_calendar_id
     and channel.status = 'active';
  update public.calendar_watch_channels channel
     set resource_id = p_resource_id,
         expires_at = p_expires_at,
         status = 'active',
         updated_at = pg_catalog.now()
   where channel.id = v_channel.id
  returning * into v_channel;
  update public.calendar_sync_state state_row
     set channel_id = v_channel.channel_id,
         resource_id = v_channel.resource_id,
         channel_expires_at = v_channel.expires_at,
         watch_owner = null,
         watch_lease_until = null,
         last_error = null,
         metadata = state_row.metadata - 'webhook_token'
   where state_row.id = v_state.id;

  return pg_catalog.jsonb_build_object(
    'active', pg_catalog.jsonb_build_object(
      'channel_id', v_channel.channel_id,
      'resource_id', v_channel.resource_id,
      'generation', v_channel.generation,
      'expires_at', v_channel.expires_at
    ),
    'retired_channels', v_retired
  );
end
$$;

create or replace function public.northlight_fail_calendar_watch(
  p_tenant_id uuid,
  p_user_id uuid,
  p_calendar_id text,
  p_owner uuid,
  p_generation bigint,
  p_channel_id text,
  p_last_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_state public.calendar_sync_state%rowtype;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  if p_last_error is null or pg_catalog.length(p_last_error) not between 1 and 1000 then
    raise exception 'invalid_calendar_watch_failure';
  end if;
  select * into v_state
    from public.calendar_sync_state state_row
   where state_row.tenant_id = p_tenant_id
     and state_row.user_id = p_user_id
     and state_row.provider = 'google'
     and state_row.calendar_id = p_calendar_id
   for update;
  if not found
     or v_state.watch_owner is distinct from p_owner
     or v_state.watch_generation is distinct from p_generation then
    raise exception 'calendar_watch_claim_lost';
  end if;
  update public.calendar_watch_channels channel
     set status = 'stopped', stopped_at = pg_catalog.now(), updated_at = pg_catalog.now()
   where channel.tenant_id = p_tenant_id
     and channel.user_id = p_user_id
     and channel.provider = 'google'
     and channel.calendar_id = p_calendar_id
     and channel.channel_id = p_channel_id
     and channel.generation = p_generation
     and channel.status = 'pending';
  update public.calendar_sync_state state_row
     set watch_owner = null, watch_lease_until = null, last_error = p_last_error
   where state_row.id = v_state.id
  returning * into v_state;
  return pg_catalog.jsonb_build_object(
    'failed', true,
    'generation', v_state.watch_generation,
    'last_error', v_state.last_error
  );
end
$$;

create or replace function public.northlight_read_calendar_watch_channel(
  p_tenant_id uuid,
  p_channel_id text,
  p_resource_id text,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_channel public.calendar_watch_channels%rowtype;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  if p_tenant_id is null
     or p_channel_id is null or pg_catalog.length(p_channel_id) not between 1 and 256
     or p_resource_id is null or pg_catalog.length(p_resource_id) not between 1 and 1024
     or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return null;
  end if;
  select channel.* into v_channel
    from public.calendar_watch_channels channel
    join public.users user_row
      on user_row.tenant_id = channel.tenant_id
     and user_row.id = channel.user_id
     and user_row.active is true
    join public.user_integrations connection
      on connection.tenant_id = channel.tenant_id
     and connection.user_id = channel.user_id
     and connection.provider = 'google'
     and connection.status = 'connected'
     and connection.refresh_generation = channel.connection_generation
   where channel.tenant_id = p_tenant_id
     and channel.channel_id = p_channel_id
     and channel.resource_id = p_resource_id
     and channel.token_hash = p_token_hash
     and channel.status in ('active', 'draining')
     and channel.expires_at > pg_catalog.now();
  if not found then return null; end if;
  return pg_catalog.jsonb_build_object(
    'tenant_id', v_channel.tenant_id,
    'user_id', v_channel.user_id,
    'provider', v_channel.provider,
    'calendar_id', v_channel.calendar_id,
    'channel_id', v_channel.channel_id,
    'resource_id', v_channel.resource_id,
    'generation', v_channel.generation,
    'status', v_channel.status,
    'expires_at', v_channel.expires_at
  );
end
$$;

create or replace function public.northlight_stop_calendar_watch_channel(
  p_tenant_id uuid,
  p_user_id uuid,
  p_channel_id text,
  p_resource_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_channel public.calendar_watch_channels%rowtype;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  update public.calendar_watch_channels channel
     set status = 'stopped', stopped_at = pg_catalog.now(), updated_at = pg_catalog.now()
   where channel.tenant_id = p_tenant_id
     and channel.user_id = p_user_id
     and channel.channel_id = p_channel_id
     and channel.resource_id = p_resource_id
     and channel.status = 'draining'
  returning * into v_channel;
  return pg_catalog.jsonb_build_object('stopped', found);
end
$$;

create or replace function public.northlight_disconnect_calendar_watch(
  p_tenant_id uuid,
  p_user_id uuid,
  p_provider text,
  p_connection_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_integration public.user_integrations%rowtype;
  v_channels jsonb;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  if p_tenant_id is null or p_user_id is null or p_provider <> 'google'
     or p_connection_generation is null or p_connection_generation < 1 then
    raise exception 'invalid_calendar_disconnect';
  end if;
  select * into v_integration
    from public.user_integrations connection
   where connection.tenant_id = p_tenant_id
     and connection.user_id = p_user_id
     and connection.provider = 'google'
   for update;
  if not found
     or v_integration.status <> 'disconnecting'
     or v_integration.refresh_generation is distinct from p_connection_generation then
    raise exception 'calendar_disconnect_generation_changed';
  end if;

  perform 1
    from public.calendar_sync_state state_row
   where state_row.tenant_id = p_tenant_id
     and state_row.user_id = p_user_id
     and state_row.provider = 'google'
   order by state_row.calendar_id
   for update;
  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'channel_id', channel.channel_id,
               'resource_id', channel.resource_id
             ) order by channel.created_at
           ),
           '[]'::jsonb
         )
    into v_channels
    from public.calendar_watch_channels channel
   where channel.tenant_id = p_tenant_id
     and channel.user_id = p_user_id
     and channel.provider = 'google'
     and channel.status in ('active', 'draining')
     and channel.resource_id is not null;
  update public.calendar_watch_channels channel
     set status = 'stopped', stopped_at = pg_catalog.now(), updated_at = pg_catalog.now()
   where channel.tenant_id = p_tenant_id
     and channel.user_id = p_user_id
     and channel.provider = 'google'
     and channel.status <> 'stopped';
  update public.calendar_sync_state state_row
     set sync_token = null,
         channel_id = null,
         resource_id = null,
         channel_expires_at = null,
         sync_owner = null,
         sync_lease_until = null,
         watch_owner = null,
         watch_lease_until = null,
         sync_generation = state_row.sync_generation + 1,
         watch_generation = state_row.watch_generation + 1,
         connection_generation = p_connection_generation,
         last_error = null,
         metadata = (state_row.metadata - 'webhook_token')
           || pg_catalog.jsonb_build_object('disconnected_at', pg_catalog.now())
   where state_row.tenant_id = p_tenant_id
     and state_row.user_id = p_user_id
     and state_row.provider = 'google';
  return pg_catalog.jsonb_build_object(
    'disconnected', true,
    'channels', v_channels
  );
end
$$;

-- Routine access-token rotation advances the OAuth generation, but it does
-- not change the Google account or invalidate a Calendar cursor/watch. Move
-- the dependent state to the winning CAS generation in the same transaction.
-- Reconnect and disconnect flows do not call this function, so their direct
-- generation increments still invalidate stale work as intended.
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
set search_path = ''
as $$
declare v_integration public.user_integrations%rowtype;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  if p_tenant_id is null or p_user_id is null or p_owner is null
     or p_provider is null or pg_catalog.length(p_provider) not between 1 and 40
     or p_generation is null or p_generation < 0
     or pg_catalog.jsonb_typeof(p_metadata) is distinct from 'object'
     or pg_catalog.octet_length(p_metadata::text) > 65536 then
    raise exception 'invalid_refresh_metadata';
  end if;

  update public.user_integrations connection
     set metadata = p_metadata,
         status = 'connected',
         last_verified_at = pg_catalog.now(),
         refresh_owner = null,
         refresh_lease_until = null,
         refresh_generation = connection.refresh_generation + 1,
         updated_at = pg_catalog.now()
   where connection.tenant_id = p_tenant_id
     and connection.user_id = p_user_id
     and connection.provider = p_provider
     and connection.status = 'connected'
     and connection.refresh_owner = p_owner
     and connection.refresh_generation = p_generation
  returning * into v_integration;
  if not found then raise exception 'refresh_claim_lost'; end if;

  if p_provider = 'google' then
    update public.calendar_sync_state state_row
       set connection_generation = v_integration.refresh_generation
     where state_row.tenant_id = p_tenant_id
       and state_row.user_id = p_user_id
       and state_row.provider = 'google'
       and state_row.connection_generation = p_generation;
    update public.calendar_watch_channels channel
       set connection_generation = v_integration.refresh_generation,
           updated_at = pg_catalog.now()
     where channel.tenant_id = p_tenant_id
       and channel.user_id = p_user_id
       and channel.provider = 'google'
       and channel.status <> 'stopped'
       and channel.connection_generation = p_generation;
  end if;

  return pg_catalog.to_jsonb(v_integration);
end
$$;

revoke all on function public.northlight_finish_user_integration_refresh(
  uuid, uuid, text, uuid, bigint, jsonb
) from public, authenticated, service_role;
grant execute on function public.northlight_finish_user_integration_refresh(
  uuid, uuid, text, uuid, bigint, jsonb
) to anon;

-- One bounded server-only maintenance read replaces unbounded table scans and
-- per-photographer onboarding RPC fan-out. Earliest/missing expirations are
-- returned first so a fixed worker budget cannot starve the most urgent watch.
create or replace function public.northlight_list_calendar_maintenance(
  p_tenant_id uuid,
  p_limit integer default 100,
  p_now timestamptz default pg_catalog.now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer;
  v_items jsonb;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  if p_tenant_id is null or p_now is null
     or p_now < pg_catalog.now() - interval '5 minutes'
     or p_now > pg_catalog.now() + interval '5 minutes' then
    raise exception 'invalid_calendar_maintenance_read';
  end if;
  v_limit := least(greatest(coalesce(p_limit, 100), 1), 200);

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'user_id', due.user_id,
               'calendar_id', due.calendar_id,
               'watch_expires_at', due.watch_expires_at,
               'sync_due', due.sync_due
             ) order by due.watch_expires_at nulls first, due.user_id
           ),
           '[]'::jsonb
         )
    into v_items
    from (
      select user_row.id as user_id,
             coalesce(nullif(profile.calendar_id, ''), 'primary') as calendar_id,
             state_row.channel_expires_at as watch_expires_at,
             (
               state_row.id is null
               or state_row.sync_token is null
               or state_row.last_error is not null
               or greatest(
                 state_row.last_full_sync_at,
                 state_row.last_incremental_sync_at
               ) is null
               or greatest(
                 state_row.last_full_sync_at,
                 state_row.last_incremental_sync_at
               ) <= p_now - interval '15 minutes'
             ) as sync_due
        from public.users user_row
        join public.provider_profiles profile
          on profile.tenant_id = user_row.tenant_id
         and profile.user_id = user_row.id
        join public.user_integrations connection
          on connection.tenant_id = user_row.tenant_id
         and connection.user_id = user_row.id
         and connection.provider = 'google'
         and connection.status = 'connected'
        left join public.calendar_sync_state state_row
          on state_row.tenant_id = user_row.tenant_id
         and state_row.user_id = user_row.id
         and state_row.provider = 'google'
         and state_row.calendar_id = coalesce(nullif(profile.calendar_id, ''), 'primary')
       where user_row.tenant_id = p_tenant_id
         and user_row.role_code = 'photographer'
         and user_row.active
         and (
           state_row.id is null
           or state_row.channel_expires_at is null
           or state_row.channel_expires_at <= p_now + interval '30 hours'
           or state_row.sync_token is null
           or state_row.last_error is not null
           or greatest(
             state_row.last_full_sync_at,
             state_row.last_incremental_sync_at
           ) is null
           or greatest(
             state_row.last_full_sync_at,
             state_row.last_incremental_sync_at
           ) <= p_now - interval '15 minutes'
         )
       order by state_row.channel_expires_at nulls first, user_row.id
       limit v_limit
    ) due;

  return pg_catalog.jsonb_build_object('items', v_items, 'as_of', p_now);
end
$$;

revoke all on function public.northlight_list_calendar_maintenance(
  uuid, integer, timestamptz
) from public, authenticated, service_role;
grant execute on function public.northlight_list_calendar_maintenance(
  uuid, integer, timestamptz
) to anon;

revoke all on function public.northlight_claim_calendar_sync(uuid, uuid, text, uuid, integer)
  from public, authenticated, service_role;
revoke all on function public.northlight_advance_calendar_sync(
  uuid, uuid, text, uuid, bigint, text, text, text, timestamptz, text, integer
) from public, authenticated, service_role;
revoke all on function public.northlight_finish_calendar_sync(uuid, uuid, text, uuid, bigint, text)
  from public, authenticated, service_role;
revoke all on function public.northlight_claim_calendar_watch(uuid, uuid, text, uuid, text, text, integer)
  from public, authenticated, service_role;
revoke all on function public.northlight_activate_calendar_watch(
  uuid, uuid, text, uuid, bigint, text, text, timestamptz
) from public, authenticated, service_role;
revoke all on function public.northlight_fail_calendar_watch(
  uuid, uuid, text, uuid, bigint, text, text
) from public, authenticated, service_role;
revoke all on function public.northlight_read_calendar_watch_channel(uuid, text, text, text)
  from public, authenticated, service_role;
revoke all on function public.northlight_stop_calendar_watch_channel(uuid, uuid, text, text)
  from public, authenticated, service_role;
revoke all on function public.northlight_disconnect_calendar_watch(uuid, uuid, text, bigint)
  from public, authenticated, service_role;

grant execute on function public.northlight_claim_calendar_sync(uuid, uuid, text, uuid, integer) to anon;
grant execute on function public.northlight_advance_calendar_sync(
  uuid, uuid, text, uuid, bigint, text, text, text, timestamptz, text, integer
) to anon;
grant execute on function public.northlight_finish_calendar_sync(uuid, uuid, text, uuid, bigint, text) to anon;
grant execute on function public.northlight_claim_calendar_watch(uuid, uuid, text, uuid, text, text, integer) to anon;
grant execute on function public.northlight_activate_calendar_watch(
  uuid, uuid, text, uuid, bigint, text, text, timestamptz
) to anon;
grant execute on function public.northlight_fail_calendar_watch(
  uuid, uuid, text, uuid, bigint, text, text
) to anon;
grant execute on function public.northlight_read_calendar_watch_channel(uuid, text, text, text) to anon;
grant execute on function public.northlight_stop_calendar_watch_channel(uuid, uuid, text, text) to anon;
grant execute on function public.northlight_disconnect_calendar_watch(uuid, uuid, text, bigint) to anon;

comment on table public.calendar_watch_channels is
  'Server-only hashed Google Calendar watch registry with renewal overlap history.';
comment on function public.northlight_read_calendar_watch_channel(uuid, text, text, text) is
  'Authenticates an unexpired active or draining webhook channel by SHA-256 token hash.';

reset lock_timeout;
reset statement_timeout;
