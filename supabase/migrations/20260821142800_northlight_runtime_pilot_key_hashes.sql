set lock_timeout = '5s';
set statement_timeout = '2min';

create schema if not exists northlight_private;
revoke all on schema northlight_private from public;

create table if not exists northlight_private.pilot_key_hashes (
  key_hash text primary key,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint pilot_key_hashes_sha256_check
    check (key_hash ~ '^[0-9a-f]{64}$')
);

revoke all on table northlight_private.pilot_key_hashes
  from public, anon, authenticated, authenticator, service_role;

-- Migrate the currently active key values inside PostgreSQL without ever
-- returning or persisting the plaintext values. The historical helper is
-- expected to be the two-key pilot function retained in Supabase migration
-- history. A structural mismatch fails closed and aborts deployment.
do $$
declare
  v_definition text;
  v_values text[];
  v_value text;
begin
  select pg_catalog.pg_get_functiondef(
           'public.northlight_pilot_allowed()'::pg_catalog.regprocedure
         )
    into v_definition;

  v_values := pg_catalog.regexp_match(
    v_definition,
    $re$in[[:space:]]*\([[:space:]]*'([^']+)'[[:space:]]*,[[:space:]]*'([^']+)'[[:space:]]*\)$re$,
    'i'
  );

  if v_values is null or pg_catalog.array_length(v_values, 1) <> 2 then
    raise exception using
      errcode = 'P0001',
      message = 'pilot_key_migration_source_unexpected';
  end if;

  foreach v_value in array v_values loop
    if v_value is null or pg_catalog.length(v_value) < 16 then
      raise exception using
        errcode = 'P0001',
        message = 'pilot_key_migration_source_unexpected';
    end if;

    insert into northlight_private.pilot_key_hashes(key_hash)
    values (
      pg_catalog.encode(
        extensions.digest(pg_catalog.convert_to(v_value, 'UTF8'), 'sha256'),
        'hex'
      )
    )
    on conflict (key_hash) do update
      set active = true;
  end loop;
end
$$;

create or replace function public.northlight_pilot_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    exists (
      select 1
      from northlight_private.pilot_key_hashes key_row
      where key_row.active
        and key_row.key_hash = pg_catalog.encode(
          extensions.digest(
            pg_catalog.convert_to(
              coalesce(
                pg_catalog.current_setting('request.headers', true)::jsonb
                  ->> 'x-northlight-demo-key',
                ''
              ),
              'UTF8'
            ),
            'sha256'
          ),
          'hex'
        )
    ),
    false
  )
$$;

revoke all on function public.northlight_pilot_allowed() from public;
grant execute on function public.northlight_pilot_allowed() to anon;

reset lock_timeout;
reset statement_timeout;
