set lock_timeout = '5s';
set statement_timeout = '5min';

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
  v_salts text[];
  v_salt text;
  v_iterations integer;
  v_segments integer;
  v_valid_hash boolean := false;
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
  if pg_catalog.array_length(v_parts, 1) = 4 and v_parts[1] = 'pbkdf2' then
    begin
      v_iterations := v_parts[2]::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'invalid_credential_migration';
    end;
    v_valid_hash :=
      v_iterations between 210000 and 1000000
      and pg_catalog.length(v_parts[3]) between 22 and 128
      and v_parts[3] ~ '^[A-Za-z0-9_-]+$'
      and pg_catalog.length(v_parts[4]) between 43 and 256
      and v_parts[4] ~ '^[A-Za-z0-9_-]+$';
  end if;

  if pg_catalog.array_length(v_parts, 1) = 5 and v_parts[1] = 'pbkdf2cf' then
    begin
      v_iterations := v_parts[2]::integer;
      v_segments := v_parts[3]::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'invalid_credential_migration';
    end;
    v_salts := pg_catalog.string_to_array(v_parts[4], '.');
    v_valid_hash :=
      v_iterations = 100000
      and v_segments between 2 and 10
      and pg_catalog.array_length(v_salts, 1) = v_segments
      and pg_catalog.length(v_parts[5]) between 43 and 256
      and v_parts[5] ~ '^[A-Za-z0-9_-]+$';
    if v_valid_hash then
      foreach v_salt in array v_salts loop
        if pg_catalog.length(v_salt) not between 22 and 128
           or v_salt !~ '^[A-Za-z0-9_-]+$' then
          v_valid_hash := false;
        end if;
      end loop;
    end if;
  end if;

  if not v_valid_hash then
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
           'password_scheme', v_parts[1],
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

revoke all on function public.northlight_complete_password_migration(uuid, uuid, text, text)
  from public, authenticated, service_role;

grant execute on function public.northlight_complete_password_migration(uuid, uuid, text, text)
  to anon;

comment on function public.northlight_complete_password_migration(uuid, uuid, text, text) is
  'Atomically migrates legacy shared credentials to per-user password verifiers; accepts Cloudflare-safe chained PBKDF2 hashes.';

reset lock_timeout;
reset statement_timeout;
