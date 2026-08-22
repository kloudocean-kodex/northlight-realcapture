-- Serialize Dropbox cursor consumption across manual syncs and webhooks.
-- The integration refresh generation is captured on claim and rechecked on
-- every advance, so work started before disconnect/reconnect cannot commit.

set lock_timeout = '5s';
set statement_timeout = '5min';

alter table public.dropbox_sync_state
  add column if not exists sync_owner uuid,
  add column if not exists sync_generation bigint not null default 0,
  add column if not exists sync_lease_until timestamptz,
  add column if not exists connection_generation bigint not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.dropbox_sync_state'::pg_catalog.regclass
       and conname = 'dropbox_sync_state_generation_check'
  ) then
    alter table public.dropbox_sync_state
      add constraint dropbox_sync_state_generation_check
      check (sync_generation >= 0 and connection_generation >= 0) not valid;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
     where conrelid = 'public.dropbox_sync_state'::pg_catalog.regclass
       and conname = 'dropbox_sync_state_lease_pair_check'
  ) then
    alter table public.dropbox_sync_state
      add constraint dropbox_sync_state_lease_pair_check
      check ((sync_owner is null) = (sync_lease_until is null)) not valid;
  end if;
end
$$;

alter table public.dropbox_sync_state
  validate constraint dropbox_sync_state_generation_check;
alter table public.dropbox_sync_state
  validate constraint dropbox_sync_state_lease_pair_check;

create index if not exists dropbox_sync_state_lease_idx
  on public.dropbox_sync_state (sync_lease_until)
  where sync_lease_until is not null;

create or replace function public.northlight_claim_dropbox_sync(
  p_tenant_id uuid,
  p_root_path text,
  p_owner uuid,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_integration public.integration_state%rowtype;
  v_state public.dropbox_sync_state%rowtype;
  v_claimed boolean := false;
  v_new_claim boolean;
  v_lease_seconds integer;
  v_account_id text;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  if p_tenant_id is null
     or p_owner is null
     or p_root_path is null
     or pg_catalog.length(p_root_path) not between 2 and 2000
     or pg_catalog.left(p_root_path, 1) <> '/'
     or pg_catalog.right(p_root_path, 1) = '/'
     or pg_catalog.strpos(p_root_path, E'\r') > 0
     or pg_catalog.strpos(p_root_path, E'\n') > 0 then
    raise exception 'invalid_dropbox_sync_claim';
  end if;
  v_lease_seconds := least(
    greatest(coalesce(p_lease_seconds, 120), 15),
    300
  );

  -- Lock the connection before the cursor row. Disconnect/reconnect code must
  -- use this same order when it also clears Dropbox cursor state.
  select * into v_integration
    from public.integration_state connection
   where connection.tenant_id = p_tenant_id
     and connection.provider = 'dropbox'
   for share;
  if not found or v_integration.status <> 'connected' then
    raise exception 'dropbox_not_connected';
  end if;
  v_account_id := nullif(
    pg_catalog.btrim(v_integration.metadata ->> 'account_id'),
    ''
  );
  if v_account_id is null or pg_catalog.length(v_account_id) > 512 then
    raise exception 'dropbox_account_identity_missing';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_tenant_id::text || ':dropbox:' || pg_catalog.lower(p_root_path),
      0
    )
  );

  insert into public.dropbox_sync_state (
    tenant_id, root_path, connection_generation
  ) values (
    p_tenant_id, p_root_path, v_integration.refresh_generation
  )
  on conflict (tenant_id, root_path) do nothing;

  select * into v_state
    from public.dropbox_sync_state state_row
   where state_row.tenant_id = p_tenant_id
     and state_row.root_path = p_root_path
   for update;
  if not found then
    raise exception 'dropbox_sync_state_missing';
  end if;

  -- Routine token refresh also increments refresh_generation. Preserve the
  -- provider cursor when the immutable Dropbox account identity is unchanged;
  -- only first binding or an actual account switch requires a bounded root
  -- cleanup followed by a full listing.
  if v_state.connection_generation <> v_integration.refresh_generation then
    if v_state.account_id is null
       or v_state.account_id is distinct from v_account_id
       or (
         v_state.cursor is null
         and v_state.metadata ->> 'page_limit' is distinct from '200'
         and v_state.metadata ->> 'reset_cleanup_required' is distinct from 'true'
       ) then
      update public.dropbox_sync_state state_row
         set account_id = v_account_id,
             cursor = null,
             last_error = null,
             metadata = pg_catalog.jsonb_build_object(
               'reset_cleanup_required', true,
               'reset_cleanup_seed', extensions.gen_random_uuid()::text
             ),
             sync_owner = null,
             sync_lease_until = null,
             sync_generation = state_row.sync_generation + 1,
             connection_generation = v_integration.refresh_generation
       where state_row.id = v_state.id
      returning * into v_state;
    else
      update public.dropbox_sync_state state_row
         set sync_owner = null,
             sync_lease_until = null,
             sync_generation = state_row.sync_generation + 1,
             connection_generation = v_integration.refresh_generation
       where state_row.id = v_state.id
      returning * into v_state;
    end if;
  elsif v_state.account_id is null then
    update public.dropbox_sync_state state_row
       set account_id = v_account_id,
           cursor = null,
           last_error = null,
           metadata = pg_catalog.jsonb_build_object(
             'reset_cleanup_required', true,
             'reset_cleanup_seed', extensions.gen_random_uuid()::text
           ),
           sync_owner = null,
           sync_lease_until = null,
           sync_generation = state_row.sync_generation + 1
     where state_row.id = v_state.id
    returning * into v_state;
  elsif v_state.account_id is distinct from v_account_id then
    raise exception 'dropbox_account_identity_changed';
  end if;

  v_new_claim := v_state.sync_owner is null
    or v_state.sync_lease_until is null
    or v_state.sync_lease_until <= pg_catalog.now()
    or v_state.sync_owner = p_owner;

  if v_new_claim then
    update public.dropbox_sync_state state_row
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
    'cursor', v_state.cursor,
    'account_id', v_state.account_id,
    'last_sync_at', v_state.last_sync_at,
    'last_webhook_at', v_state.last_webhook_at,
    'metadata', v_state.metadata,
    'lease_until', v_state.sync_lease_until
  );
end
$$;

create or replace function public.northlight_advance_dropbox_sync(
  p_tenant_id uuid,
  p_root_path text,
  p_owner uuid,
  p_generation bigint,
  p_expected_cursor text,
  p_cursor text,
  p_last_sync_at timestamptz,
  p_last_webhook_at timestamptz,
  p_metadata jsonb,
  p_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_integration public.integration_state%rowtype;
  v_state public.dropbox_sync_state%rowtype;
  v_lease_seconds integer;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  if p_tenant_id is null
     or p_owner is null
     or p_generation is null
     or p_generation < 1
     or p_root_path is null
     or pg_catalog.length(p_root_path) not between 2 and 2000
     or pg_catalog.left(p_root_path, 1) <> '/'
     or pg_catalog.right(p_root_path, 1) = '/'
     or (p_expected_cursor is not null and pg_catalog.length(p_expected_cursor) > 16384)
     or (p_cursor is not null and pg_catalog.length(p_cursor) > 16384)
     or p_last_sync_at is null
     or p_last_sync_at > pg_catalog.now() + interval '5 minutes'
     or p_last_sync_at < pg_catalog.now() - interval '24 hours'
     or (p_last_webhook_at is not null
         and (p_last_webhook_at > pg_catalog.now() + interval '5 minutes'
              or p_last_webhook_at < pg_catalog.now() - interval '24 hours'))
     or pg_catalog.jsonb_typeof(p_metadata) is distinct from 'object'
     or pg_catalog.octet_length(p_metadata::text) > 32768 then
    raise exception 'invalid_dropbox_sync_advance';
  end if;
  v_lease_seconds := least(
    greatest(coalesce(p_lease_seconds, 120), 15),
    300
  );

  select * into v_integration
    from public.integration_state connection
   where connection.tenant_id = p_tenant_id
     and connection.provider = 'dropbox'
   for share;
  if not found or v_integration.status <> 'connected' then
    raise exception 'dropbox_connection_changed';
  end if;

  select * into v_state
    from public.dropbox_sync_state state_row
   where state_row.tenant_id = p_tenant_id
     and state_row.root_path = p_root_path
   for update;
  if not found
     or v_state.sync_owner is distinct from p_owner
     or v_state.sync_generation is distinct from p_generation
     or v_state.sync_lease_until is null
     or v_state.sync_lease_until <= pg_catalog.now()
     or v_state.connection_generation is distinct from v_integration.refresh_generation then
    raise exception 'dropbox_sync_claim_lost';
  end if;
  if v_state.cursor is distinct from p_expected_cursor then
    raise exception 'dropbox_cursor_changed';
  end if;

  update public.dropbox_sync_state state_row
     set cursor = p_cursor,
         last_sync_at = p_last_sync_at,
         last_webhook_at = coalesce(
           p_last_webhook_at,
           state_row.last_webhook_at
         ),
         last_error = null,
         metadata = p_metadata,
         sync_lease_until = pg_catalog.now()
           + pg_catalog.make_interval(secs => v_lease_seconds)
   where state_row.id = v_state.id
  returning * into v_state;

  return pg_catalog.jsonb_build_object(
    'generation', v_state.sync_generation,
    'connection_generation', v_state.connection_generation,
    'cursor', v_state.cursor,
    'last_sync_at', v_state.last_sync_at,
    'last_webhook_at', v_state.last_webhook_at,
    'metadata', v_state.metadata,
    'lease_until', v_state.sync_lease_until
  );
end
$$;

create or replace function public.northlight_finish_dropbox_sync(
  p_tenant_id uuid,
  p_root_path text,
  p_owner uuid,
  p_generation bigint,
  p_last_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state public.dropbox_sync_state%rowtype;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  if p_tenant_id is null
     or p_owner is null
     or p_generation is null
     or p_generation < 1
     or p_root_path is null
     or pg_catalog.length(p_root_path) not between 2 and 2000
     or pg_catalog.left(p_root_path, 1) <> '/'
     or pg_catalog.right(p_root_path, 1) = '/'
     or (p_last_error is not null and pg_catalog.length(p_last_error) > 1000) then
    raise exception 'invalid_dropbox_sync_finish';
  end if;

  update public.dropbox_sync_state state_row
     set sync_owner = null,
         sync_lease_until = null,
         last_error = p_last_error
   where state_row.tenant_id = p_tenant_id
     and state_row.root_path = p_root_path
     and state_row.sync_owner = p_owner
     and state_row.sync_generation = p_generation
  returning * into v_state;
  if not found then
    raise exception 'dropbox_sync_claim_lost';
  end if;

  return pg_catalog.jsonb_build_object(
    'finished', true,
    'generation', v_state.sync_generation,
    'connection_generation', v_state.connection_generation,
    'cursor', v_state.cursor,
    'last_error', v_state.last_error
  );
end
$$;

-- Apply one normalized provider page under the live cursor lease. File state
-- and its task event commit together. Each entry carries a caller-derived,
-- deterministic event UUID so retry after an uncertain response is harmless.
create or replace function public.northlight_apply_dropbox_sync_batch(
  p_tenant_id uuid,
  p_owner uuid,
  p_generation bigint,
  p_entries jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_integration public.integration_state%rowtype;
  v_state public.dropbox_sync_state%rowtype;
  v_entry jsonb;
  v_task public.tasks%rowtype;
  v_source public.task_files%rowtype;
  v_target public.task_files%rowtype;
  v_file public.task_files%rowtype;
  v_event public.task_events%rowtype;
  v_event_id uuid;
  v_page_id uuid;
  v_page_order integer;
  v_task_no text;
  v_provider_file_id text;
  v_path text;
  v_name text;
  v_file_type text;
  v_stage text;
  v_service_code text;
  v_content_hash text;
  v_revision text;
  v_size_bytes bigint;
  v_is_deleted boolean;
  v_is_prefix_delete boolean;
  v_modified_at timestamptz;
  v_client_modified_at timestamptz;
  v_metadata jsonb;
  v_changed boolean;
  v_old_path text;
  v_old_task_id uuid;
  v_prefix_pattern text;
  v_event_hex text;
  v_child_event_id uuid;
  v_matched integer := 0;
  v_changed_count integer := 0;
  v_prefix_processed integer := 0;
  v_prefix_has_more boolean := false;
  v_existing_page_order integer;
begin
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;
  if p_tenant_id is null
     or p_owner is null
     or p_generation is null
     or p_generation < 1
     or pg_catalog.jsonb_typeof(p_entries) is distinct from 'array'
     or pg_catalog.jsonb_array_length(p_entries) not between 1 and 200
     or pg_catalog.octet_length(p_entries::text) > 1048576 then
    raise exception 'invalid_dropbox_sync_batch';
  end if;

  select * into v_integration
    from public.integration_state connection
   where connection.tenant_id = p_tenant_id
     and connection.provider = 'dropbox'
   for share;
  if not found or v_integration.status <> 'connected' then
    raise exception 'dropbox_connection_changed';
  end if;

  select * into v_state
    from public.dropbox_sync_state state_row
   where state_row.tenant_id = p_tenant_id
     and state_row.sync_owner = p_owner
     and state_row.sync_generation = p_generation
   for update;
  if not found
     or v_state.sync_lease_until is null
     or v_state.sync_lease_until <= pg_catalog.now()
     or v_state.connection_generation is distinct from v_integration.refresh_generation then
    raise exception 'dropbox_sync_claim_lost';
  end if;
  if exists (
    select 1
      from public.dropbox_sync_state other_state
     where other_state.tenant_id = p_tenant_id
       and other_state.sync_owner = p_owner
       and other_state.sync_generation = p_generation
       and other_state.id <> v_state.id
  ) then
    raise exception 'dropbox_sync_claim_ambiguous';
  end if;

  for v_entry in
    select entry.value
      from pg_catalog.jsonb_array_elements(p_entries) with ordinality entry(value, position)
     order by entry.position
  loop
    if pg_catalog.jsonb_typeof(v_entry) is distinct from 'object' then
      raise exception 'invalid_dropbox_sync_entry';
    end if;

    v_task_no := nullif(pg_catalog.btrim(v_entry ->> 'task_no'), '');
    v_provider_file_id := nullif(pg_catalog.btrim(v_entry ->> 'provider_file_id'), '');
    v_path := nullif(pg_catalog.btrim(v_entry ->> 'path'), '');
    v_name := nullif(pg_catalog.btrim(v_entry ->> 'name'), '');
    v_file_type := nullif(pg_catalog.btrim(v_entry ->> 'file_type'), '');
    v_stage := nullif(pg_catalog.btrim(v_entry ->> 'stage'), '');
    v_service_code := nullif(pg_catalog.lower(pg_catalog.btrim(v_entry ->> 'service_code')), '');
    v_content_hash := nullif(pg_catalog.lower(pg_catalog.btrim(v_entry ->> 'content_hash')), '');
    v_revision := nullif(pg_catalog.btrim(v_entry ->> 'revision'), '');

    begin
      v_event_id := (v_entry ->> 'event_id')::uuid;
      v_page_id := (v_entry ->> 'page_id')::uuid;
      v_page_order := (v_entry ->> 'page_order')::integer;
      v_is_deleted := coalesce((v_entry ->> 'is_deleted')::boolean, false);
      v_is_prefix_delete := coalesce(
        (v_entry ->> 'is_prefix_delete')::boolean,
        false
      );
      v_size_bytes := case
        when v_entry ->> 'size_bytes' is null then null
        else (v_entry ->> 'size_bytes')::bigint
      end;
      v_modified_at := case
        when v_entry ->> 'modified_at' is null then null
        else (v_entry ->> 'modified_at')::timestamptz
      end;
      v_client_modified_at := case
        when v_entry ->> 'client_modified_at' is null then null
        else (v_entry ->> 'client_modified_at')::timestamptz
      end;
    exception
      when invalid_text_representation or datetime_field_overflow
        or invalid_datetime_format or numeric_value_out_of_range then
        raise exception 'invalid_dropbox_sync_entry';
    end;

    if v_event_id is null
       or v_page_id is null
       or v_page_order not between 0 and 999
       or v_path is null
       or pg_catalog.length(v_path) > 2000
       or pg_catalog.left(v_path, 1) <> '/'
       or pg_catalog.strpos(v_path, E'\r') > 0
       or pg_catalog.strpos(v_path, E'\n') > 0
       or not (
         pg_catalog.lower(v_path) = pg_catalog.lower(v_state.root_path)
         or pg_catalog.lower(pg_catalog.left(
              v_path,
              pg_catalog.length(v_state.root_path) + 1
            )) = pg_catalog.lower(v_state.root_path || '/')
       )
       or (v_is_prefix_delete and not v_is_deleted)
       or (not v_is_prefix_delete and (
         v_task_no is null
         or pg_catalog.length(v_task_no) > 80
         or v_task_no !~ '^[A-Za-z0-9_-]+$'
       ))
       or (v_task_no is not null and (
         pg_catalog.length(v_task_no) > 80
         or v_task_no !~ '^[A-Za-z0-9_-]+$'
       ))
       or (pg_catalog.lower(v_path) <> pg_catalog.lower(v_state.root_path)
         and (
           v_task_no is null
           or pg_catalog.upper(pg_catalog.split_part(
                pg_catalog.substr(
                  v_path, pg_catalog.length(v_state.root_path) + 2
                ),
                '/',
                1
              )) !~ (
                '^' || pg_catalog.upper(v_task_no) || '([^A-Z0-9_-]|$)'
              )
         )
       )
       or (not v_is_prefix_delete and (
         v_name is null
         or pg_catalog.length(v_name) > 512
         or v_stage not in ('01_RAW', '02_EDITED', '03_FINAL', '04_REFERENCE')
       ))
       or (v_name is not null and pg_catalog.length(v_name) > 512)
       or (v_stage is not null
           and v_stage not in ('01_RAW', '02_EDITED', '03_FINAL', '04_REFERENCE'))
       or (not v_is_deleted and v_provider_file_id is null)
       or (v_provider_file_id is not null and pg_catalog.length(v_provider_file_id) > 512)
       or (v_file_type is not null and pg_catalog.length(v_file_type) > 80)
       or (v_service_code is not null and pg_catalog.length(v_service_code) > 80)
       or (v_content_hash is not null and v_content_hash !~ '^[0-9a-f]{64}$')
       or (v_revision is not null and pg_catalog.length(v_revision) > 512)
       or v_size_bytes < 0
       or v_modified_at > pg_catalog.now() + interval '5 minutes'
       or v_client_modified_at > pg_catalog.now() + interval '5 minutes' then
      raise exception 'invalid_dropbox_sync_entry';
    end if;

    -- DeletedMetadata represents a subtree invalidation in Dropbox's
    -- recursive cursor cache. Root/folder deletions therefore tombstone every
    -- currently-active exact/descendant file in the same transaction.
    if v_is_prefix_delete then
      if pg_catalog.jsonb_array_length(p_entries) <> 1 then
        raise exception 'dropbox_prefix_delete_must_be_single';
      end if;
      v_task := null;
      if pg_catalog.lower(v_path) <> pg_catalog.lower(v_state.root_path) then
        select * into v_task
          from public.tasks task_row
         where task_row.tenant_id = p_tenant_id
           and pg_catalog.upper(task_row.task_no) = pg_catalog.upper(v_task_no)
         for key share;
        if not found then continue; end if;
      end if;
      v_prefix_pattern := pg_catalog.replace(
        pg_catalog.replace(
          pg_catalog.replace(pg_catalog.lower(v_path), E'\\', E'\\\\'),
          '%', E'\\%'
        ),
        '_', E'\\_'
      ) || '/%';

      for v_file in
        select file_row.*
          from public.task_files file_row
         where file_row.tenant_id = p_tenant_id
           and file_row.provider = 'dropbox'
           and not file_row.is_deleted
           and (v_task.id is null or file_row.task_id = v_task.id)
           and not (
             file_row.metadata ->> 'dropbox_sync_page_id' = v_page_id::text
             and case
               when file_row.metadata ->> 'dropbox_sync_page_order' ~ '^[0-9]{1,3}$'
               then (file_row.metadata ->> 'dropbox_sync_page_order')::integer
               else -1
             end > v_page_order
           )
           and (
             pg_catalog.lower(file_row.path) = pg_catalog.lower(v_path)
             or pg_catalog.lower(file_row.path) like v_prefix_pattern escape E'\\'
           )
         order by file_row.id
         limit 201
         for update
      loop
        if v_prefix_processed >= 200 then
          v_prefix_has_more := true;
          exit;
        end if;
        update public.task_files file_row
           set is_deleted = true,
               metadata = coalesce(file_row.metadata, '{}'::jsonb)
                 || pg_catalog.jsonb_build_object(
                   'dropbox_sync_page_id', v_page_id::text,
                   'dropbox_sync_page_order', v_page_order,
                   'dropbox_deleted_prefix', v_path
                 )
         where file_row.id = v_file.id;
        v_event_hex := pg_catalog.encode(
          extensions.digest(
            pg_catalog.convert_to(
              v_event_id::text || ':' || v_file.id::text,
              'UTF8'
            ),
            'sha256'
          ),
          'hex'
        );
        v_child_event_id := (
          pg_catalog.substr(v_event_hex, 1, 8) || '-' ||
          pg_catalog.substr(v_event_hex, 9, 4) || '-' ||
          pg_catalog.substr(v_event_hex, 13, 4) || '-' ||
          pg_catalog.substr(v_event_hex, 17, 4) || '-' ||
          pg_catalog.substr(v_event_hex, 21, 12)
        )::uuid;
        insert into public.task_events (
          id, tenant_id, task_id, type, actor_user_id, detail
        ) values (
          v_child_event_id,
          p_tenant_id,
          v_file.task_id,
          'dropbox_file_deleted',
          null,
          pg_catalog.jsonb_build_object(
            'message', 'Dropbox removed a folder or subtree containing: ' || v_file.name,
            'path', v_file.path,
            'deleted_prefix', v_path,
            'stage', v_file.stage,
            'service', v_file.service_code,
            'provider_file_id', v_file.provider_file_id,
            'revision', v_file.revision
          )
        )
        on conflict (id) do update
          set id = excluded.id
        where task_events.tenant_id = excluded.tenant_id
          and task_events.task_id = excluded.task_id
          and task_events.type = excluded.type
        returning * into v_event;
        if not found then raise exception 'dropbox_event_id_conflict'; end if;
        v_matched := v_matched + 1;
        v_changed_count := v_changed_count + 1;
        v_prefix_processed := v_prefix_processed + 1;
      end loop;
      continue;
    end if;

    if pg_catalog.upper(pg_catalog.split_part(
            pg_catalog.substr(
              v_path, pg_catalog.length(v_state.root_path) + 2
            ),
            '/',
            1
          )) !~ (
            '^' || pg_catalog.upper(v_task_no) || '([^A-Z0-9_-]|$)'
          )
    then
      raise exception 'invalid_dropbox_sync_entry';
    end if;

    select * into v_task
      from public.tasks task_row
     where task_row.tenant_id = p_tenant_id
       and pg_catalog.upper(task_row.task_no) = pg_catalog.upper(v_task_no)
       and task_row.deleted_at is null
     for key share;
    if not found then
      -- A provider page can legitimately contain unrelated or historical
      -- folders. Such rows are ignored rather than making the page poison.
      continue;
    end if;
    if v_service_code is not null
       and not (v_service_code = any(v_task.service_codes)) then
      raise exception 'dropbox_service_not_in_task';
    end if;
    v_matched := v_matched + 1;

    v_source := null;
    v_target := null;
    if not v_is_deleted and v_provider_file_id is not null then
      select * into v_source
        from public.task_files file_row
       where file_row.tenant_id = p_tenant_id
         and file_row.provider = 'dropbox'
         and file_row.provider_file_id = v_provider_file_id
       order by file_row.is_deleted asc, file_row.modified_at desc nulls last
       limit 1
       for update;
    end if;
    select * into v_target
      from public.task_files file_row
     where file_row.tenant_id = p_tenant_id
       and file_row.provider = 'dropbox'
       and file_row.path = v_path
     for update;

    -- A capped prefix delete can force the provider page to be replayed.
    -- Never let an earlier entry from that same page reactivate or overwrite
    -- a row already touched by a later entry.
    if v_source.id is not null
       and v_source.metadata ->> 'dropbox_sync_page_id' = v_page_id::text then
      v_existing_page_order := case
        when v_source.metadata ->> 'dropbox_sync_page_order' ~ '^[0-9]{1,3}$'
        then (v_source.metadata ->> 'dropbox_sync_page_order')::integer
        else -1
      end;
      if v_existing_page_order > v_page_order then
        continue;
      end if;
    end if;
    if v_target.id is not null
       and v_target.metadata ->> 'dropbox_sync_page_id' = v_page_id::text then
      v_existing_page_order := case
        when v_target.metadata ->> 'dropbox_sync_page_order' ~ '^[0-9]{1,3}$'
        then (v_target.metadata ->> 'dropbox_sync_page_order')::integer
        else -1
      end;
      if v_existing_page_order > v_page_order then
        continue;
      end if;
    end if;

    -- Dropbox deletion entries intentionally omit the prior file metadata.
    -- Never invent a tombstone for an unknown path, and never erase the last
    -- verified provider receipt when marking a known path deleted.
    if v_is_deleted then
      if v_target.id is null then
        continue;
      end if;
      v_provider_file_id := coalesce(
        v_provider_file_id,
        v_target.provider_file_id
      );
      v_file_type := coalesce(v_file_type, v_target.file_type);
      v_size_bytes := coalesce(v_size_bytes, v_target.size_bytes);
      v_content_hash := coalesce(v_content_hash, v_target.content_hash);
      v_revision := coalesce(v_revision, v_target.revision);
      v_modified_at := coalesce(v_modified_at, v_target.modified_at);
    else
      v_modified_at := coalesce(v_modified_at, pg_catalog.now());
    end if;

    v_old_path := case when v_source.id is not null then v_source.path else v_target.path end;
    v_old_task_id := case when v_source.id is not null then v_source.task_id else v_target.task_id end;
    v_changed := v_target.id is null
      or v_target.task_id is distinct from v_task.id
      or v_target.provider_file_id is distinct from v_provider_file_id
      or v_target.name is distinct from v_name
      or v_target.file_type is distinct from v_file_type
      or v_target.stage is distinct from v_stage
      or v_target.service_code is distinct from v_service_code
      or v_target.size_bytes is distinct from v_size_bytes
      or v_target.content_hash is distinct from v_content_hash
      or v_target.revision is distinct from v_revision
      or v_target.is_deleted is distinct from v_is_deleted
      or v_target.modified_at is distinct from v_modified_at
      or (v_source.id is not null and v_source.id is distinct from v_target.id);

    if v_is_deleted then
      v_metadata := coalesce(v_target.metadata, '{}'::jsonb)
        || pg_catalog.jsonb_build_object(
          'dropbox_sync_page_id', v_page_id::text,
          'dropbox_sync_page_order', v_page_order
        );
    else
      v_metadata := pg_catalog.jsonb_build_object(
        'client_modified', v_client_modified_at,
        'dropbox_sync_page_id', v_page_id::text,
        'dropbox_sync_page_order', v_page_order
      );
      if v_source.id is not null then
        v_metadata := coalesce(v_source.metadata, '{}'::jsonb) || v_metadata;
      elsif v_target.id is not null then
        v_metadata := coalesce(v_target.metadata, '{}'::jsonb) || v_metadata;
      end if;
    end if;

    if v_source.id is not null and v_source.id is distinct from v_target.id then
      if v_target.id is not null then
        if not v_target.is_deleted then
          raise exception 'dropbox_path_conflict';
        end if;
        delete from public.task_files file_row where file_row.id = v_target.id;
      end if;
      update public.task_files file_row
         set task_id = v_task.id,
             provider_file_id = v_provider_file_id,
             path = v_path,
             name = v_name,
             file_type = v_file_type,
             stage = v_stage,
             service_code = v_service_code,
             size_bytes = v_size_bytes,
             content_hash = v_content_hash,
             revision = v_revision,
             is_deleted = v_is_deleted,
             modified_at = v_modified_at,
             metadata = v_metadata
       where file_row.id = v_source.id
      returning * into v_file;
    elsif v_target.id is not null then
      update public.task_files file_row
         set task_id = v_task.id,
             provider_file_id = coalesce(v_provider_file_id, file_row.provider_file_id),
             name = v_name,
             file_type = v_file_type,
             stage = v_stage,
             service_code = v_service_code,
             size_bytes = v_size_bytes,
             content_hash = v_content_hash,
             revision = v_revision,
             is_deleted = v_is_deleted,
             modified_at = v_modified_at,
             metadata = v_metadata
       where file_row.id = v_target.id
      returning * into v_file;
    else
      insert into public.task_files (
        tenant_id, task_id, provider, provider_file_id, path, name, file_type,
        stage, service_code, size_bytes, content_hash, revision, is_deleted,
        modified_at, metadata
      ) values (
        p_tenant_id, v_task.id, 'dropbox', v_provider_file_id, v_path, v_name,
        v_file_type, v_stage, v_service_code, v_size_bytes, v_content_hash,
        v_revision, v_is_deleted, v_modified_at, v_metadata
      )
      returning * into v_file;
    end if;

    if v_changed then
      insert into public.task_events (
        id, tenant_id, task_id, type, actor_user_id, detail
      ) values (
        v_event_id,
        p_tenant_id,
        v_task.id,
        case when v_is_deleted
          then 'dropbox_file_deleted'
          else 'dropbox_file_changed'
        end,
        null,
        pg_catalog.jsonb_build_object(
          'message', 'Dropbox ' || case when v_is_deleted then 'removed: ' else 'updated: ' end || v_name,
          'path', v_path,
          'previous_path', v_old_path,
          'previous_task_id', v_old_task_id,
          'stage', v_stage,
          'service', v_service_code,
          'provider_file_id', v_provider_file_id,
          'revision', v_revision
        )
      )
      on conflict (id) do update
        set id = excluded.id
      where task_events.tenant_id = excluded.tenant_id
        and task_events.task_id = excluded.task_id
        and task_events.type = excluded.type
      returning * into v_event;
      if not found then
        raise exception 'dropbox_event_id_conflict';
      end if;
      v_changed_count := v_changed_count + 1;
    end if;
  end loop;

  return pg_catalog.jsonb_build_object(
    'matched', v_matched,
    'changed', v_changed_count,
    'prefix_has_more', v_prefix_has_more
  );
end
$$;

revoke all on function public.northlight_claim_dropbox_sync(uuid, text, uuid, integer)
  from public, authenticated, service_role;
revoke all on function public.northlight_advance_dropbox_sync(
  uuid, text, uuid, bigint, text, text, timestamptz, timestamptz, jsonb, integer
) from public, authenticated, service_role;
revoke all on function public.northlight_finish_dropbox_sync(uuid, text, uuid, bigint, text)
  from public, authenticated, service_role;
revoke all on function public.northlight_apply_dropbox_sync_batch(uuid, uuid, bigint, jsonb)
  from public, authenticated, service_role;

grant execute on function public.northlight_claim_dropbox_sync(uuid, text, uuid, integer)
  to anon;
grant execute on function public.northlight_advance_dropbox_sync(
  uuid, text, uuid, bigint, text, text, timestamptz, timestamptz, jsonb, integer
) to anon;
grant execute on function public.northlight_finish_dropbox_sync(uuid, text, uuid, bigint, text)
  to anon;
grant execute on function public.northlight_apply_dropbox_sync_batch(uuid, uuid, bigint, jsonb)
  to anon;

comment on function public.northlight_claim_dropbox_sync(uuid, text, uuid, integer) is
  'Claims or renews the serialized Dropbox cursor lease and captures the connection generation.';
comment on function public.northlight_advance_dropbox_sync(
  uuid, text, uuid, bigint, text, text, timestamptz, timestamptz, jsonb, integer
) is
  'Advances the Dropbox cursor only for the live owner/generation and expected cursor.';

reset lock_timeout;
reset statement_timeout;
