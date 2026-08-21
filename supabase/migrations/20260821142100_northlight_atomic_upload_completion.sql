-- Final upload indexing is a database transaction, not a stale application
-- snapshot. The provider call happens first; this RPC then locks current task
-- and upload-session state, re-authorizes the actor, records the verified file,
-- and closes the tracked session atomically.

alter table public.media_upload_sessions
  add column if not exists provider_receipt jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.media_upload_sessions'::regclass
      and conname = 'media_upload_sessions_uploaded_within_size_check'
  ) then
    alter table public.media_upload_sessions
      add constraint media_upload_sessions_uploaded_within_size_check
      check (uploaded_bytes between 0 and size_bytes)
      not valid;
  end if;
end
$$;

alter table public.media_upload_sessions
  validate constraint media_upload_sessions_uploaded_within_size_check;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.media_upload_sessions'::regclass
      and conname = 'media_upload_sessions_provider_receipt_object_check'
  ) then
    alter table public.media_upload_sessions
      add constraint media_upload_sessions_provider_receipt_object_check
      check (pg_catalog.jsonb_typeof(provider_receipt) = 'object')
      not valid;
  end if;
end
$$;

alter table public.media_upload_sessions
  validate constraint media_upload_sessions_provider_receipt_object_check;

create index if not exists media_upload_sessions_direct_path_idx
  on public.media_upload_sessions (task_id, user_id, path, created_at desc)
  where dropbox_session_id = 'direct'
    and status in ('direct_pending', 'uploaded', 'done');

create unique index if not exists task_files_active_provider_file_uidx
  on public.task_files (tenant_id, provider, provider_file_id)
  where provider_file_id is not null and is_deleted = false;

create or replace function public.northlight_finalize_upload_index(
  p_task_id uuid,
  p_actor uuid,
  p_upload_session_id uuid,
  p_path text,
  p_provider_file_id text,
  p_provider_revision text,
  p_content_hash text,
  p_size_bytes bigint,
  p_name text,
  p_modified_at timestamptz default null,
  p_client_modified_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.tasks%rowtype;
  v_actor public.users%rowtype;
  v_session public.media_upload_sessions%rowtype;
  v_file public.task_files%rowtype;
  v_base text;
  v_relative text;
  v_stage text;
  v_service text;
  v_claim jsonb;
  v_receipt jsonb;
  v_uploaded_via text := 'northlight_reconciled';
  v_reused boolean := false;
begin
  -- This remains the single-tenant pilot boundary. A future multi-tenant
  -- release must replace both guards and add organization-aware authorization
  -- in the same controlled migration.
  if not public.northlight_pilot_allowed()
     or not northlight_private.single_tenant_guard() then
    raise exception 'permission_denied';
  end if;

  if p_task_id is null or p_actor is null then
    raise exception 'upload_identity_required';
  end if;
  if p_upload_session_id is null then
    raise exception 'upload_session_required';
  end if;

  select * into v_task
    from public.tasks
   where id = p_task_id
   for update;
  if not found or v_task.deleted_at is not null then
    raise exception 'task_not_found';
  end if;
  if v_task.archived_at is not null then
    raise exception 'task_archived';
  end if;
  if v_task.status in ('cancelled', 'delivered') then
    raise exception 'task_closed';
  end if;

  select * into v_actor
    from public.users
   where id = p_actor
     and tenant_id = v_task.tenant_id
     and active is true;
  if not found then
    raise exception 'permission_denied';
  end if;

  v_base := pg_catalog.rtrim(coalesce(v_task.dropbox_path, ''), '/');
  if v_base = '' then
    raise exception 'dropbox_workspace_missing';
  end if;
  if p_path is null
     or pg_catalog.length(p_path) > 2048
     or pg_catalog.lower(pg_catalog.left(p_path, pg_catalog.length(v_base) + 1))
          <> pg_catalog.lower(v_base || '/') then
    raise exception 'upload_path_outside_task';
  end if;

  v_relative := pg_catalog.substr(p_path, pg_catalog.length(v_base) + 2);
  v_stage := pg_catalog.split_part(v_relative, '/', 1);
  v_service := case when v_stage = '04_REFERENCE' then null
    else pg_catalog.lower(nullif(pg_catalog.split_part(v_relative, '/', 2), '')) end;

  if v_stage not in ('01_RAW', '02_EDITED', '03_FINAL', '04_REFERENCE') then
    raise exception 'invalid_media_stage';
  end if;
  if v_stage <> '04_REFERENCE'
     and (v_service is null or not exists (
       select 1
       from pg_catalog.unnest(coalesce(v_task.service_codes, array[]::text[])) service_code
       where pg_catalog.lower(service_code) = v_service
     )) then
    raise exception 'service_not_in_task';
  end if;

  if not (
    v_actor.role_code in ('admin', 'owner')
    or (v_actor.role_code = 'agent'
      and v_task.agent_user_id = v_actor.id
      and v_stage = '04_REFERENCE')
    or (v_actor.role_code = 'photographer'
      and v_task.photographer_user_id = v_actor.id
      and v_stage in ('01_RAW', '04_REFERENCE'))
    or (v_actor.role_code = 'editor'
      and v_task.editor_user_id = v_actor.id
      and v_stage in ('02_EDITED', '03_FINAL', '04_REFERENCE'))
  ) then
    raise exception 'upload_permission_denied';
  end if;

  if v_stage in ('02_EDITED', '03_FINAL') then
    v_claim := coalesce(v_task.metadata, '{}'::jsonb) -> 'review_publish_claim';
    if v_claim is not null then
      if pg_catalog.jsonb_typeof(v_claim) <> 'object'
         or nullif(v_claim ->> 'expires_at', '') is null then
        raise exception 'review_publish_lock_invalid';
      end if;
      begin
        if (v_claim ->> 'expires_at')::timestamptz > pg_catalog.now() then
          raise exception 'review_publish_locked';
        end if;
      exception
        when invalid_datetime_format or datetime_field_overflow then
          raise exception 'review_publish_lock_invalid';
      end;
    end if;
  end if;

  if p_provider_file_id is null
     or pg_catalog.length(pg_catalog.btrim(p_provider_file_id)) not between 1 and 500
     or p_provider_revision is null
     or pg_catalog.length(pg_catalog.btrim(p_provider_revision)) not between 1 and 500
     or p_content_hash is null
     or p_content_hash !~ '^[0-9A-Fa-f]{64}$'
     or p_size_bytes is null
     or p_size_bytes <= 0
     or p_size_bytes > 107374182400
     or p_name is null
     or pg_catalog.length(pg_catalog.btrim(p_name)) not between 1 and 255
     or p_name <> pg_catalog.regexp_replace(p_path, '^.*/', '') then
    raise exception 'provider_receipt_invalid';
  end if;

  select * into v_session
    from public.media_upload_sessions
   where id = p_upload_session_id
     and tenant_id = v_task.tenant_id
     and task_id = v_task.id
   for update;
  if not found then
    raise exception 'upload_session_not_found';
  end if;
  if v_actor.role_code not in ('admin', 'owner') and v_session.user_id <> v_actor.id then
    raise exception 'upload_session_not_owned';
  end if;
  if v_session.status not in ('uploaded', 'done') then
    raise exception 'upload_session_not_ready';
  end if;
  if v_session.status <> 'done' and v_session.expires_at <= pg_catalog.now() then
    raise exception 'upload_session_expired';
  end if;
  if pg_catalog.lower(v_session.path) <> pg_catalog.lower(p_path)
     or v_session.stage <> v_stage
     or pg_catalog.lower(coalesce(v_session.service_code, ''))
          <> pg_catalog.lower(coalesce(v_service, ''))
     or v_session.size_bytes <> p_size_bytes
     or v_session.uploaded_bytes <> v_session.size_bytes then
    raise exception 'upload_session_receipt_mismatch';
  end if;
  if v_session.status = 'done'
     and v_session.provider_receipt <> '{}'::jsonb
     and (
       v_session.provider_receipt ->> 'provider_file_id' is distinct from p_provider_file_id
       or v_session.provider_receipt ->> 'revision' is distinct from p_provider_revision
       or pg_catalog.lower(v_session.provider_receipt ->> 'content_hash')
            is distinct from pg_catalog.lower(p_content_hash)
       or (v_session.provider_receipt ->> 'size_bytes')::bigint is distinct from p_size_bytes
       or pg_catalog.lower(v_session.provider_receipt ->> 'path')
            is distinct from pg_catalog.lower(p_path)
     ) then
    raise exception 'upload_session_already_completed';
  end if;
  v_uploaded_via := case when v_session.dropbox_session_id = 'direct'
    then 'northlight_direct' else 'northlight_resumable' end;
  v_reused := v_session.status = 'done';

  -- A Dropbox provider file ID may not silently move between tasks or appear
  -- twice under different active paths. Provider rename reconciliation belongs
  -- to the Dropbox sync lane, not upload completion.
  if exists (
    select 1
    from public.task_files existing
    where existing.tenant_id = v_task.tenant_id
      and existing.provider = 'dropbox'
      and existing.provider_file_id = p_provider_file_id
      and existing.is_deleted is false
      and (
        existing.task_id <> v_task.id
        or pg_catalog.lower(existing.path) <> pg_catalog.lower(p_path)
      )
  ) then
    raise exception 'provider_file_conflict';
  end if;

  v_receipt := pg_catalog.jsonb_build_object(
    'provider', 'dropbox',
    'provider_file_id', p_provider_file_id,
    'revision', p_provider_revision,
    'content_hash', pg_catalog.lower(p_content_hash),
    'size_bytes', p_size_bytes,
    'path', p_path,
    'confirmed_at', pg_catalog.now()
  );
  if v_reused and v_session.provider_receipt <> '{}'::jsonb then
    v_receipt := v_session.provider_receipt;
  end if;

  insert into public.task_files (
    tenant_id, task_id, provider, provider_file_id, path, name,
    file_type, stage, service_code, size_bytes, content_hash, revision,
    is_deleted, modified_at, metadata, updated_at
  ) values (
    v_task.tenant_id,
    v_task.id,
    'dropbox',
    p_provider_file_id,
    p_path,
    pg_catalog.btrim(p_name),
    'file',
    v_stage,
    v_service,
    p_size_bytes,
    pg_catalog.lower(p_content_hash),
    p_provider_revision,
    false,
    coalesce(p_modified_at, pg_catalog.now()),
    pg_catalog.jsonb_build_object(
      'client_modified', p_client_modified_at,
      'uploaded_via', v_uploaded_via,
      'upload_session_id', p_upload_session_id,
      'completion_actor_user_id', v_actor.id,
      'provider_confirmed_at', pg_catalog.now()
    ),
    pg_catalog.now()
  )
  on conflict (tenant_id, provider, path) do update
    set provider_file_id = excluded.provider_file_id,
        name = excluded.name,
        file_type = excluded.file_type,
        stage = excluded.stage,
        service_code = excluded.service_code,
        size_bytes = excluded.size_bytes,
        content_hash = excluded.content_hash,
        revision = excluded.revision,
        is_deleted = false,
        modified_at = excluded.modified_at,
        metadata = coalesce(task_files.metadata, '{}'::jsonb) || excluded.metadata,
        updated_at = pg_catalog.now()
    where task_files.task_id = excluded.task_id
  returning * into v_file;

  if not found then
    raise exception 'upload_path_owned_by_other_task';
  end if;

  update public.media_upload_sessions
     set status = 'done',
         uploaded_bytes = size_bytes,
         provider_receipt = v_receipt,
         last_error = null,
         updated_at = pg_catalog.now()
   where id = v_session.id;

  if not exists (
    select 1
    from public.task_events event
    where event.task_id = v_task.id
      and event.type = 'dropbox_file_uploaded'
      and pg_catalog.lower(coalesce(event.detail ->> 'path', ''))
            = pg_catalog.lower(p_path)
  ) then
    insert into public.task_events (
      tenant_id, task_id, type, actor_user_id, detail
    ) values (
      v_task.tenant_id,
      v_task.id,
      'dropbox_file_uploaded',
      v_actor.id,
      pg_catalog.jsonb_build_object(
        'message', 'Uploaded to Dropbox: ' || pg_catalog.btrim(p_name),
        'path', p_path,
        'stage', v_stage,
        'service', v_service,
        'tracked', true,
        'uploaded_via', v_uploaded_via,
        'provider_file_id', p_provider_file_id,
        'revision', p_provider_revision
      )
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'reused', v_reused,
    'file', pg_catalog.to_jsonb(v_file),
    'upload_session_id', p_upload_session_id,
    'session_status', 'done'
  );
end
$$;

revoke all on function public.northlight_finalize_upload_index(
  uuid, uuid, uuid, text, text, text, text, bigint, text, timestamptz, timestamptz
) from public;

grant execute on function public.northlight_finalize_upload_index(
  uuid, uuid, uuid, text, text, text, text, bigint, text, timestamptz, timestamptz
) to anon, authenticated;

comment on function public.northlight_finalize_upload_index(
  uuid, uuid, uuid, text, text, text, text, bigint, text, timestamptz, timestamptz
) is
  'Atomic upload completion: reauthorizes current task/session state, indexes one provider-verified Dropbox file, records one event, and closes the tracked session.';
