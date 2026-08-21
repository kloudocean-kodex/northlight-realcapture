-- Make login throttling atomic and give the live legacy shared-password users
-- an explicit, enforceable migration state. The legacy verifier remains only
-- as a bootstrap path until each account completes a personal PBKDF2 change.

set lock_timeout = '5s';
set statement_timeout = '5min';

alter table public.auth_login_attempts enable row level security;
revoke all on table public.auth_login_attempts
  from public, anon, authenticated, service_role;
grant all on table public.auth_login_attempts to service_role;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.auth_login_attempts'::pg_catalog.regclass
       and conname = 'auth_login_attempts_key_check'
  ) then
    alter table public.auth_login_attempts
      add constraint auth_login_attempts_key_check
      check (login_key ~ '^[0-9a-f]{64}$') not valid;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.auth_login_attempts'::pg_catalog.regclass
       and conname = 'auth_login_attempts_count_check'
  ) then
    alter table public.auth_login_attempts
      add constraint auth_login_attempts_count_check
      check (failure_count >= 0) not valid;
  end if;
end
$$;

alter table public.auth_login_attempts
  validate constraint auth_login_attempts_key_check;
alter table public.auth_login_attempts
  validate constraint auth_login_attempts_count_check;

create index if not exists auth_login_attempts_cleanup_idx
  on public.auth_login_attempts (updated_at);

create or replace function public.northlight_begin_login_attempt(
  p_login_key text,
  p_window_seconds integer default 600,
  p_threshold integer default 5,
  p_block_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.auth_login_attempts%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_window_seconds integer;
  v_threshold integer;
  v_block_seconds integer;
  v_count integer;
  v_first timestamptz;
  v_blocked_until timestamptz;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  if p_login_key is null or p_login_key !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_login_key';
  end if;
  v_window_seconds := least(greatest(coalesce(p_window_seconds, 600), 60), 3600);
  v_threshold := least(greatest(coalesce(p_threshold, 5), 3), 20);
  v_block_seconds := least(greatest(coalesce(p_block_seconds, 900), 60), 86400);

  -- The advisory lock closes the absent-row race; the row lock protects all
  -- subsequent attempts for this hash. No email address enters the database.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('northlight-login:' || p_login_key, 0)
  );
  select * into v_attempt
    from public.auth_login_attempts attempt_row
   where attempt_row.login_key = p_login_key
   for update;

  if found and v_attempt.blocked_until > v_now then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'failure_count', v_attempt.failure_count,
      'blocked_until', v_attempt.blocked_until
    );
  end if;

  if not found
     or v_attempt.first_failed_at is null
     or v_attempt.first_failed_at
        <= v_now - pg_catalog.make_interval(secs => v_window_seconds) then
    v_count := 1;
    v_first := v_now;
  else
    v_count := v_attempt.failure_count + 1;
    v_first := v_attempt.first_failed_at;
  end if;
  v_blocked_until := case when v_count >= v_threshold
    then v_now + pg_catalog.make_interval(secs => v_block_seconds)
    else null
  end;

  insert into public.auth_login_attempts (
    login_key, failure_count, first_failed_at, last_failed_at,
    blocked_until, updated_at
  ) values (
    p_login_key, v_count, v_first, v_now, v_blocked_until, v_now
  )
  on conflict (login_key) do update
    set failure_count = excluded.failure_count,
        first_failed_at = excluded.first_failed_at,
        last_failed_at = excluded.last_failed_at,
        blocked_until = excluded.blocked_until,
        updated_at = excluded.updated_at
  returning * into v_attempt;

  -- The threshold attempt may still verify a correct password. Its caller
  -- must reset immediately on success; a failed threshold attempt is a 429.
  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'failure_count', v_attempt.failure_count,
    'blocked_until', v_attempt.blocked_until
  );
end
$$;

create or replace function public.northlight_reset_login_attempt(
  p_login_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_deleted boolean;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  if p_login_key is null or p_login_key !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_login_key';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('northlight-login:' || p_login_key, 0)
  );
  delete from public.auth_login_attempts attempt_row
   where attempt_row.login_key = p_login_key;
  v_deleted := found;
  return pg_catalog.jsonb_build_object('reset', true, 'existed', v_deleted);
end
$$;

alter table public.users
  add column if not exists auth_must_change_password boolean not null default true,
  add column if not exists credential_version bigint not null default 0,
  add column if not exists credential_updated_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.users'::pg_catalog.regclass
       and conname = 'users_credential_version_check'
  ) then
    alter table public.users
      add constraint users_credential_version_check
      check (credential_version >= 0) not valid;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.users'::pg_catalog.regclass
       and conname = 'users_legacy_credential_requires_change_check'
  ) then
    alter table public.users
      add constraint users_legacy_credential_requires_change_check
      check (password_hash !~ '^scrypt\$' or auth_must_change_password) not valid;
  end if;
end
$$;

alter table public.users validate constraint users_credential_version_check;
alter table public.users
  validate constraint users_legacy_credential_requires_change_check;

create index if not exists users_password_migration_queue_idx
  on public.users (tenant_id, active, created_at)
  where auth_must_change_password;

create or replace function public.northlight_complete_password_migration(
  p_tenant_id uuid,
  p_user_id uuid,
  p_expected_password_hash text,
  p_new_password_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user public.users%rowtype;
  v_parts text[];
  v_iterations integer;
  v_auth_version bigint := 0;
  v_changed_at timestamptz := pg_catalog.clock_timestamp();
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  if p_tenant_id is null or p_user_id is null
     or p_expected_password_hash is null
     or pg_catalog.length(p_expected_password_hash) not between 8 and 4096
     or p_new_password_hash is null
     or pg_catalog.length(p_new_password_hash) not between 80 and 4096
     or p_new_password_hash is not distinct from p_expected_password_hash then
    raise exception 'invalid_credential_migration';
  end if;
  v_parts := pg_catalog.string_to_array(p_new_password_hash, '$');
  begin
    v_iterations := v_parts[2]::integer;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'invalid_credential_migration';
  end;
  if pg_catalog.array_length(v_parts, 1) <> 4
     or v_parts[1] <> 'pbkdf2'
     or v_iterations not between 210000 and 1000000
     or v_parts[3] !~ '^[A-Za-z0-9_-]{22,128}$'
     or v_parts[4] !~ '^[A-Za-z0-9_-]{43,256}$' then
    raise exception 'invalid_credential_migration';
  end if;

  select * into v_user
    from public.users user_row
   where user_row.tenant_id = p_tenant_id
     and user_row.id = p_user_id
     and user_row.active is true
   for update;
  if not found then raise exception 'credential_user_not_found'; end if;
  if v_user.password_hash is distinct from p_expected_password_hash then
    raise exception 'credential_version_changed';
  end if;
  if v_user.metadata ->> 'auth_version' ~ '^[0-9]{1,18}$' then
    begin
      v_auth_version := (v_user.metadata ->> 'auth_version')::bigint;
    exception when numeric_value_out_of_range then
      v_auth_version := 0;
    end;
  end if;
  v_auth_version := v_auth_version + 1;

  update public.users user_row
     set password_hash = p_new_password_hash,
         auth_must_change_password = false,
         credential_version = user_row.credential_version + 1,
         credential_updated_at = v_changed_at,
         metadata = user_row.metadata || pg_catalog.jsonb_build_object(
           'auth_version', v_auth_version,
           'password_scheme', 'pbkdf2',
           'password_changed_at', v_changed_at
         )
   where user_row.id = v_user.id
  returning * into v_user;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'user_id', v_user.id,
    'must_change_password', v_user.auth_must_change_password,
    'credential_version', v_user.credential_version,
    'auth_version', v_auth_version,
    'changed_at', v_user.credential_updated_at
  );
end
$$;

revoke all on function public.northlight_begin_login_attempt(text, integer, integer, integer)
  from public, authenticated, service_role;
revoke all on function public.northlight_reset_login_attempt(text)
  from public, authenticated, service_role;
revoke all on function public.northlight_complete_password_migration(uuid, uuid, text, text)
  from public, authenticated, service_role;

grant execute on function public.northlight_begin_login_attempt(text, integer, integer, integer)
  to anon;
grant execute on function public.northlight_reset_login_attempt(text)
  to anon;
grant execute on function public.northlight_complete_password_migration(uuid, uuid, text, text)
  to anon;

comment on function public.northlight_begin_login_attempt(text, integer, integer, integer) is
  'Atomically serializes a hashed login key and records the attempt before credential verification.';
comment on column public.users.auth_must_change_password is
  'True for legacy or temporary credentials until a personal PBKDF2 credential is committed.';

reset lock_timeout;
reset statement_timeout;
