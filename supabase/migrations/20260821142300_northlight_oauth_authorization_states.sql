-- Durable, single-use OAuth authorization state. Raw state and raw PKCE
-- verifier values are never stored: the Worker sends a SHA-256 state hash and
-- an application-encrypted verifier. The table has no Data API policy or API
-- table grant; guarded SECURITY DEFINER RPCs are its only application surface.

create table if not exists public.oauth_authorization_states (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider text not null
    check (provider in ('google', 'google-user', 'dropbox', 'xero')),
  actor_user_id uuid not null,
  state_hash text not null unique
    check (state_hash ~ '^[0-9a-f]{64}$'),
  return_path text not null
    check (
      pg_catalog.length(return_path) between 1 and 512
      and pg_catalog.left(return_path, 1) = '/'
      and pg_catalog.left(return_path, 2) <> '//'
      and pg_catalog.strpos(return_path, E'\\') = 0
      and pg_catalog.strpos(return_path, E'\r') = 0
      and pg_catalog.strpos(return_path, E'\n') = 0
    ),
  pkce_verifier_ciphertext text not null
    check (
      pg_catalog.length(pkce_verifier_ciphertext) between 32 and 4096
      and pkce_verifier_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
    ),
  connection_generation bigint not null
    check (connection_generation >= 0),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default pg_catalog.now(),
  constraint oauth_authorization_states_lifecycle_check check (
    expires_at > created_at
    and (consumed_at is null or consumed_at >= created_at)
  ),
  constraint oauth_authorization_states_tenant_actor_fkey
    foreign key (tenant_id, actor_user_id)
    references public.users(tenant_id, id)
    on delete cascade
);

create unique index if not exists oauth_authorization_states_one_pending_idx
  on public.oauth_authorization_states (
    tenant_id,
    provider,
    (case when provider = 'google-user'
      then actor_user_id
      else '00000000-0000-0000-0000-000000000000'::uuid
    end)
  )
  where consumed_at is null;

create index if not exists oauth_authorization_states_expiry_idx
  on public.oauth_authorization_states (expires_at)
  where consumed_at is null;

create index if not exists oauth_authorization_states_actor_history_idx
  on public.oauth_authorization_states (tenant_id, actor_user_id, created_at desc);

alter table public.oauth_authorization_states enable row level security;
revoke all on table public.oauth_authorization_states
  from public, anon, authenticated, service_role;
grant all on table public.oauth_authorization_states to service_role;

create or replace function public.northlight_begin_oauth_state(
  p_tenant_id uuid,
  p_provider text,
  p_actor_user_id uuid,
  p_state_hash text,
  p_return_path text,
  p_pkce_verifier_ciphertext text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.users%rowtype;
  v_state public.oauth_authorization_states%rowtype;
  v_connection_status text;
  v_connection_generation bigint := 0;
  v_lock_scope text;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;

  if p_tenant_id is null
     or p_actor_user_id is null
     or p_provider is null
     or p_provider not in ('google', 'google-user', 'dropbox', 'xero')
     or p_state_hash is null
     or p_state_hash !~ '^[0-9a-f]{64}$'
     or p_return_path is null
     or pg_catalog.length(p_return_path) not between 1 and 512
     or pg_catalog.left(p_return_path, 1) <> '/'
     or pg_catalog.left(p_return_path, 2) = '//'
     or pg_catalog.strpos(p_return_path, E'\\') > 0
     or pg_catalog.strpos(p_return_path, E'\r') > 0
     or pg_catalog.strpos(p_return_path, E'\n') > 0
     or p_pkce_verifier_ciphertext is null
     or pg_catalog.length(p_pkce_verifier_ciphertext) not between 32 and 4096
     or p_pkce_verifier_ciphertext !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
     or p_expires_at is null
     or p_expires_at <= pg_catalog.now() + interval '30 seconds'
     or p_expires_at > pg_catalog.now() + interval '15 minutes' then
    raise exception 'invalid_oauth_state_request';
  end if;

  select * into v_actor
    from public.users actor
   where actor.id = p_actor_user_id
     and actor.tenant_id = p_tenant_id
     and actor.active is true
   for update;
  if not found
     or (p_provider = 'google-user' and v_actor.role_code <> 'photographer')
     or (p_provider <> 'google-user' and v_actor.role_code not in ('admin', 'owner')) then
    raise exception 'permission_denied';
  end if;

  v_lock_scope := p_tenant_id::text || ':' || p_provider || ':' ||
    case when p_provider = 'google-user' then p_actor_user_id::text else 'shared' end;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_lock_scope, 0)
  );

  if p_provider = 'google-user' then
    select connection.status, connection.refresh_generation
      into v_connection_status, v_connection_generation
    from public.user_integrations connection
    where connection.tenant_id = p_tenant_id
      and connection.user_id = p_actor_user_id
      and connection.provider = 'google'
    for share;
  else
    select connection.status, connection.refresh_generation
      into v_connection_status, v_connection_generation
    from public.integration_state connection
    where connection.tenant_id = p_tenant_id
      and connection.provider = p_provider
    for share;
  end if;
  v_connection_generation := coalesce(v_connection_generation, 0);
  if v_connection_status = 'disconnecting' then
    raise exception 'integration_disconnecting';
  end if;

  -- Opportunistic per-actor expiry cleanup keeps bounded history without a
  -- global delete/lock sweep on an interactive request.
  delete from public.oauth_authorization_states state_row
   where state_row.tenant_id = p_tenant_id
     and state_row.actor_user_id = p_actor_user_id
     and state_row.expires_at <= pg_catalog.now();

  -- Shared provider reconnects have one pending state across all admins;
  -- photographer Google Calendar reconnects are scoped to that photographer.
  delete from public.oauth_authorization_states state_row
   where state_row.tenant_id = p_tenant_id
     and state_row.provider = p_provider
     and state_row.consumed_at is null
     and (p_provider <> 'google-user' or state_row.actor_user_id = p_actor_user_id);

  insert into public.oauth_authorization_states (
    tenant_id,
    provider,
    actor_user_id,
    state_hash,
    return_path,
    pkce_verifier_ciphertext,
    connection_generation,
    expires_at
  ) values (
    p_tenant_id,
    p_provider,
    p_actor_user_id,
    p_state_hash,
    p_return_path,
    p_pkce_verifier_ciphertext,
    v_connection_generation,
    p_expires_at
  )
  returning * into v_state;

  return pg_catalog.jsonb_build_object(
    'id', v_state.id,
    'expires_at', v_state.expires_at
  );
exception
  when unique_violation then
    raise exception 'oauth_state_collision';
end
$$;

create or replace function public.northlight_consume_oauth_state(
  p_tenant_id uuid,
  p_provider text,
  p_actor_user_id uuid,
  p_state_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.users%rowtype;
  v_state public.oauth_authorization_states%rowtype;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;

  if p_tenant_id is null
     or p_actor_user_id is null
     or p_provider is null
     or p_provider not in ('google', 'google-user', 'dropbox', 'xero')
     or p_state_hash is null
     or p_state_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'oauth_state_invalid';
  end if;

  select * into v_actor
    from public.users actor
   where actor.id = p_actor_user_id
     and actor.tenant_id = p_tenant_id
     and actor.active is true
   for update;
  if not found
     or (p_provider = 'google-user' and v_actor.role_code <> 'photographer')
     or (p_provider <> 'google-user' and v_actor.role_code not in ('admin', 'owner')) then
    raise exception 'permission_denied';
  end if;

  update public.oauth_authorization_states state_row
     set consumed_at = pg_catalog.now()
   where state_row.tenant_id = p_tenant_id
     and state_row.provider = p_provider
     and state_row.actor_user_id = p_actor_user_id
     and state_row.state_hash = p_state_hash
     and state_row.consumed_at is null
     and state_row.expires_at > pg_catalog.now()
  returning * into v_state;
  if not found then
    -- Deliberately indistinguishable: absent, expired, replaced, and replayed
    -- states must not become a database oracle.
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'id', v_state.id,
    'return_path', v_state.return_path,
    'pkce_verifier_ciphertext', v_state.pkce_verifier_ciphertext,
    'connection_generation', v_state.connection_generation,
    'expires_at', v_state.expires_at
  );
end
$$;

revoke all on function public.northlight_begin_oauth_state(
  uuid, text, uuid, text, text, text, timestamptz
) from public, authenticated, service_role;
revoke all on function public.northlight_consume_oauth_state(
  uuid, text, uuid, text
) from public, authenticated, service_role;

grant execute on function public.northlight_begin_oauth_state(
  uuid, text, uuid, text, text, text, timestamptz
) to anon;
grant execute on function public.northlight_consume_oauth_state(
  uuid, text, uuid, text
) to anon;

comment on table public.oauth_authorization_states is
  'Server-only, hashed and encrypted OAuth authorization state. No direct Data API access.';
comment on function public.northlight_consume_oauth_state(uuid, text, uuid, text) is
  'Atomically consumes one unexpired OAuth state and returns its encrypted PKCE verifier exactly once.';
