-- Approved delivery media is represented by an immutable, provider-verified
-- release. A task points at exactly one selected release; old releases remain
-- intact so a failed or superseding publication cannot destroy prior media.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.media_releases (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  provider text not null default 'dropbox' check (provider = 'dropbox'),
  root_path text not null,
  status text not null default 'publishing' check (status in ('publishing','approved')),
  manifest_fingerprint text,
  file_count integer not null default 0 check (file_count >= 0),
  created_by_user_id uuid references public.users(id),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  unique (id, task_id),
  unique (task_id, root_path)
);

create table if not exists public.media_release_files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  release_id uuid not null references public.media_releases(id) on delete restrict,
  provider text not null default 'dropbox' check (provider = 'dropbox'),
  provider_file_id text not null,
  provider_revision text not null,
  content_hash text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  path text not null,
  name text not null,
  service_code text,
  source_provider_file_id text not null,
  source_revision text not null,
  source_content_hash text not null,
  source_size_bytes bigint not null check (source_size_bytes >= 0),
  source_path text not null,
  created_at timestamptz not null default now(),
  unique (release_id, path),
  unique (release_id, provider_file_id),
  unique (release_id, source_provider_file_id)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'media_release_files_release_task_fkey'
      and conrelid = 'public.media_release_files'::regclass
  ) then
    alter table public.media_release_files
      add constraint media_release_files_release_task_fkey
      foreign key (release_id, task_id) references public.media_releases(id, task_id) on delete restrict;
  end if;
end;
$$;

create index if not exists media_releases_tenant_task_idx
  on public.media_releases (tenant_id, task_id, approved_at desc);
create index if not exists media_releases_task_idx
  on public.media_releases (task_id, approved_at desc);
create index if not exists media_releases_created_by_idx
  on public.media_releases (created_by_user_id) where created_by_user_id is not null;
create index if not exists media_release_files_release_idx
  on public.media_release_files (release_id, service_code, name);
create index if not exists media_release_files_task_idx
  on public.media_release_files (tenant_id, task_id, release_id);
create index if not exists media_release_files_task_only_idx
  on public.media_release_files (task_id, release_id);

alter table public.tasks add column if not exists approved_release_id uuid;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tasks_approved_release_id_fkey'
      and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_approved_release_id_fkey
      foreign key (approved_release_id) references public.media_releases(id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'tasks_approved_release_task_fkey'
      and conrelid = 'public.tasks'::regclass
  ) then
    alter table public.tasks
      add constraint tasks_approved_release_task_fkey
      foreign key (approved_release_id, id) references public.media_releases(id, task_id) on delete restrict;
  end if;
end;
$$;
create index if not exists tasks_approved_release_idx on public.tasks (approved_release_id);

alter table public.media_releases enable row level security;
alter table public.media_release_files enable row level security;
drop policy if exists northlight_pilot_access on public.media_releases;
create policy northlight_pilot_access on public.media_releases
  for all to anon, authenticated
  using (public.northlight_pilot_allowed())
  with check (public.northlight_pilot_allowed());
drop policy if exists northlight_pilot_access on public.media_release_files;
create policy northlight_pilot_access on public.media_release_files
  for all to anon, authenticated
  using (public.northlight_pilot_allowed())
  with check (public.northlight_pilot_allowed());

create or replace function public.northlight_protect_media_release()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if tg_table_name = 'media_releases' then
    if tg_op = 'DELETE' or old.status = 'approved' then
      raise exception 'approved_release_immutable';
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    if exists(select 1 from public.media_releases r where r.id = new.release_id and r.status = 'approved') then
      raise exception 'approved_release_immutable';
    end if;
    return new;
  end if;
  if exists(select 1 from public.media_releases r where r.id = old.release_id and r.status = 'approved') then
    raise exception 'approved_release_immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists northlight_protect_media_release_row on public.media_releases;
create trigger northlight_protect_media_release_row
before update or delete on public.media_releases
for each row execute function public.northlight_protect_media_release();

drop trigger if exists northlight_protect_media_release_file_row on public.media_release_files;
create trigger northlight_protect_media_release_file_row
before insert or update or delete on public.media_release_files
for each row execute function public.northlight_protect_media_release();

-- Preserve already-reviewed historical media at cutover. This imports only a
-- complete, provider-verifiable 03_FINAL snapshot; it never guesses that an
-- in-progress Editing folder was approved. Links still validate the imported
-- provider ID/revision/hash/size before disclosure.
do $$
declare
  v_task record;
  v_release_id uuid;
  v_manifest jsonb;
  v_fingerprint text;
begin
  for v_task in
    select t.*
    from public.tasks t
    where t.approved_release_id is null
      and t.deleted_at is null
      and nullif(t.dropbox_path, '') is not null
      and t.status in ('review', 'revision', 'delivered')
      and exists (
        select 1 from public.task_files f
        where f.task_id = t.id and f.stage = '03_FINAL'
          and f.file_type = 'file' and f.is_deleted = false
      )
      and not exists (
        select 1 from public.task_files f
        where f.task_id = t.id and f.stage = '03_FINAL'
          and f.file_type = 'file' and f.is_deleted = false
          and (nullif(f.provider_file_id, '') is null
            or nullif(f.revision, '') is null
            or nullif(f.content_hash, '') is null
            or f.size_bytes is null)
      )
      and not exists (
        select 1 from unnest(coalesce(t.service_codes, array[]::text[])) s
        where not exists (
          select 1 from public.task_files f
          where f.task_id = t.id and f.stage = '03_FINAL'
            and f.file_type = 'file' and f.is_deleted = false
            and lower(coalesce(f.service_code, '')) = lower(s)
        )
      )
    for update
  loop
    v_release_id := gen_random_uuid();
    select jsonb_agg(jsonb_build_object(
      'provider', 'dropbox',
      'provider_file_id', f.provider_file_id,
      'provider_revision', f.revision,
      'content_hash', lower(f.content_hash),
      'size_bytes', f.size_bytes,
      'path', f.path,
      'name', f.name,
      'service_code', f.service_code,
      'source_provider_file_id', f.provider_file_id,
      'source_revision', f.revision,
      'source_content_hash', lower(f.content_hash),
      'source_size_bytes', f.size_bytes,
      'source_path', f.path
    ) order by lower(f.path))
    into v_manifest
    from public.task_files f
    where f.task_id = v_task.id and f.stage = '03_FINAL'
      and f.file_type = 'file' and f.is_deleted = false;

    v_fingerprint := encode(extensions.digest(convert_to(v_manifest::text, 'UTF8'), 'sha256'), 'hex');
    insert into public.media_releases(
      id, tenant_id, task_id, provider, root_path, status,
      manifest_fingerprint, file_count, created_by_user_id
    ) values (
      v_release_id, v_task.tenant_id, v_task.id, 'dropbox',
      rtrim(v_task.dropbox_path, '/') || '/03_FINAL', 'publishing',
      v_fingerprint, jsonb_array_length(v_manifest),
      coalesce(v_task.editor_user_id, v_task.agent_user_id, v_task.photographer_user_id)
    );

    insert into public.media_release_files(
      tenant_id, task_id, release_id, provider, provider_file_id,
      provider_revision, content_hash, size_bytes, path, name, service_code,
      source_provider_file_id, source_revision, source_content_hash,
      source_size_bytes, source_path
    )
    select
      v_task.tenant_id, v_task.id, v_release_id, 'dropbox',
      f.provider_file_id, f.revision, lower(f.content_hash), f.size_bytes,
      f.path, f.name, f.service_code,
      f.provider_file_id, f.revision, lower(f.content_hash), f.size_bytes, f.path
    from public.task_files f
    where f.task_id = v_task.id and f.stage = '03_FINAL'
      and f.file_type = 'file' and f.is_deleted = false;

    update public.media_releases
    set status = 'approved', approved_at = now()
    where id = v_release_id and status = 'publishing';
    update public.tasks
    set approved_release_id = v_release_id,
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'approved_release_manifest', v_fingerprint,
          'approved_release_imported_at', now()
        )
    where id = v_task.id;
    insert into public.task_events(tenant_id, task_id, type, actor_user_id, detail)
    values(v_task.tenant_id, v_task.id, 'approved_release_manifest_imported', null, jsonb_build_object(
      'message', 'Existing approved media was protected by an immutable manifest.',
      'release_id', v_release_id,
      'manifest_fingerprint', v_fingerprint
    ));
  end loop;
end;
$$;

create or replace function public.northlight_claim_review_publish(p_task_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_actor_role text;
  v_missing text[];
  v_files jsonb;
  v_claim jsonb;
  v_token uuid := gen_random_uuid();
  v_now timestamptz := now();
  v_expires timestamptz := now() + interval '10 minutes';
  v_release_root text;
begin
  select role_code into v_actor_role from public.users where id = p_actor and active = true;
  if v_actor_role is null then raise exception 'permission_denied'; end if;

  select * into v_task from public.tasks where id = p_task_id and deleted_at is null for update;
  if not found then raise exception 'task_not_found'; end if;
  if v_task.archived_at is not null then raise exception 'task_archived'; end if;
  if not (v_actor_role in ('admin','owner') or (v_actor_role = 'editor' and v_task.editor_user_id = p_actor)) then
    raise exception 'permission_denied';
  end if;
  if v_task.status <> 'editing' then raise exception 'task_state_changed'; end if;
  if nullif(v_task.dropbox_path, '') is null then raise exception 'dropbox_workspace_missing'; end if;

  v_claim := coalesce(v_task.metadata, '{}'::jsonb)->'review_publish_claim';
  if v_claim is not null
     and nullif(v_claim->>'expires_at', '') is not null
     and (v_claim->>'expires_at')::timestamptz > v_now then
    if v_claim->>'actor_user_id' = p_actor::text
       and nullif(v_claim->>'release_id', '') is not null then
      return jsonb_build_object(
        'token', v_claim->>'token',
        'release_id', v_claim->>'release_id',
        'release_root', v_claim->>'release_root',
        'expires_at', v_claim->>'expires_at',
        'edited_files', coalesce(v_claim->'edited_files', '[]'::jsonb),
        'reused', true
      );
    end if;
    raise exception 'review_publish_busy';
  end if;

  if exists(
    select 1 from public.media_upload_sessions u
    where u.task_id = v_task.id
      and u.stage in ('02_EDITED','03_FINAL')
      and u.status in ('direct_pending','uploading','uploaded')
      and u.expires_at > v_now
  ) then raise exception 'review_media_upload_in_progress'; end if;

  select array_agg(s order by s) into v_missing
  from unnest(coalesce(v_task.service_codes, array[]::text[])) s
  where not exists (
    select 1 from public.task_files f
    where f.task_id = v_task.id
      and f.stage = '02_EDITED'
      and f.file_type = 'file'
      and f.is_deleted = false
      and lower(coalesce(f.service_code, '')) = lower(s)
  );
  if coalesce(cardinality(v_missing), 0) > 0 then
    raise exception 'edited_media_missing:%', array_to_string(v_missing, ',');
  end if;

  if exists(
    select 1 from public.task_files f
    where f.task_id = v_task.id
      and f.stage = '02_EDITED'
      and f.file_type = 'file'
      and f.is_deleted = false
      and (nullif(f.provider_file_id, '') is null
        or nullif(f.revision, '') is null
        or nullif(f.content_hash, '') is null
        or f.size_bytes is null)
  ) then raise exception 'edited_media_unverified'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'path', f.path,
      'name', f.name,
      'service_code', f.service_code,
      'provider_file_id', f.provider_file_id,
      'revision', f.revision,
      'content_hash', f.content_hash,
      'size_bytes', f.size_bytes
    ) order by lower(f.path)), '[]'::jsonb)
  into v_files
  from public.task_files f
  where f.task_id = v_task.id
    and f.stage = '02_EDITED'
    and f.file_type = 'file'
    and f.is_deleted = false;
  if jsonb_array_length(v_files) = 0 then raise exception 'edited_media_missing'; end if;

  v_release_root := rtrim(v_task.dropbox_path, '/') || '/releases/' || v_token::text;
  v_claim := jsonb_build_object(
    'token', v_token::text,
    'release_id', v_token::text,
    'release_root', v_release_root,
    'actor_user_id', p_actor,
    'claimed_at', v_now,
    'expires_at', v_expires,
    'edited_files', v_files
  );
  update public.tasks
  set metadata = (coalesce(metadata, '{}'::jsonb) - 'review_publish_claim') ||
    jsonb_build_object('review_publish_claim', v_claim)
  where id = v_task.id;

  return jsonb_build_object(
    'token', v_token::text,
    'release_id', v_token::text,
    'release_root', v_release_root,
    'expires_at', v_expires,
    'edited_files', v_files,
    'reused', false
  );
end;
$$;

drop function if exists public.northlight_finish_review_publish(uuid, uuid, text, integer);
create function public.northlight_finish_review_publish(
  p_task_id uuid,
  p_actor uuid,
  p_token text,
  p_release_id uuid,
  p_release_root text,
  p_manifest jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_actor_role text;
  v_claim jsonb;
  v_expected jsonb;
  v_expected_count integer;
  v_manifest_count integer;
  v_fingerprint text;
  v_previous_release uuid;
  v_message text;
begin
  select role_code into v_actor_role from public.users where id = p_actor and active = true;
  if v_actor_role is null then raise exception 'permission_denied'; end if;

  select * into v_task from public.tasks where id = p_task_id and deleted_at is null for update;
  if not found then raise exception 'task_not_found'; end if;
  if v_task.archived_at is not null then raise exception 'task_archived'; end if;
  if not (v_actor_role in ('admin','owner') or (v_actor_role = 'editor' and v_task.editor_user_id = p_actor)) then
    raise exception 'permission_denied';
  end if;
  if v_task.status <> 'editing' then raise exception 'task_state_changed'; end if;

  v_claim := coalesce(v_task.metadata, '{}'::jsonb)->'review_publish_claim';
  if v_claim is null
     or v_claim->>'token' is distinct from p_token
     or v_claim->>'actor_user_id' is distinct from p_actor::text
     or v_claim->>'release_id' is distinct from p_release_id::text
     or v_claim->>'release_root' is distinct from p_release_root then
    raise exception 'review_publish_claim_lost';
  end if;

  v_expected := coalesce(v_claim->'edited_files', '[]'::jsonb);
  v_expected_count := jsonb_array_length(v_expected);
  if p_manifest is null or jsonb_typeof(p_manifest) <> 'array' then
    raise exception 'review_publish_manifest_invalid';
  end if;
  v_manifest_count := jsonb_array_length(p_manifest);
  if v_expected_count = 0 or v_manifest_count <> v_expected_count then
    raise exception 'review_publish_snapshot_changed';
  end if;

  if exists(
    select 1 from jsonb_array_elements(p_manifest) m
    where coalesce(m->>'provider', '') <> 'dropbox'
      or nullif(m->>'provider_file_id', '') is null
      or nullif(m->>'provider_revision', '') is null
      or nullif(m->>'content_hash', '') is null
      or coalesce(m->>'size_bytes', '') !~ '^[0-9]+$'
      or nullif(m->>'path', '') is null
      or nullif(m->>'name', '') is null
      or nullif(m->>'source_provider_file_id', '') is null
      or nullif(m->>'source_revision', '') is null
      or nullif(m->>'source_content_hash', '') is null
      or coalesce(m->>'source_size_bytes', '') !~ '^[0-9]+$'
      or nullif(m->>'source_path', '') is null
      or left(lower(m->>'path'), length(lower(p_release_root || '/'))) <> lower(p_release_root || '/')
  ) then raise exception 'review_publish_manifest_invalid'; end if;

  if exists(
    select 1 from (
      select m->>'provider_file_id' as value from jsonb_array_elements(p_manifest) m group by 1 having count(*) > 1
      union all
      select lower(m->>'path') from jsonb_array_elements(p_manifest) m group by 1 having count(*) > 1
      union all
      select m->>'source_provider_file_id' from jsonb_array_elements(p_manifest) m group by 1 having count(*) > 1
    ) duplicates
  ) then raise exception 'review_publish_manifest_invalid'; end if;

  if exists(
    select 1 from jsonb_array_elements(v_expected) e
    where not exists (
      select 1 from jsonb_array_elements(p_manifest) m
      where m->>'source_provider_file_id' = e->>'provider_file_id'
        and m->>'source_revision' = e->>'revision'
        and lower(m->>'source_content_hash') = lower(e->>'content_hash')
        and (m->>'source_size_bytes')::bigint = (e->>'size_bytes')::bigint
        and lower(m->>'source_path') = lower(e->>'path')
        and lower(coalesce(m->>'service_code', '')) = lower(coalesce(e->>'service_code', ''))
        and lower(m->>'content_hash') = lower(e->>'content_hash')
        and (m->>'size_bytes')::bigint = (e->>'size_bytes')::bigint
        and lower(m->>'path') = lower(regexp_replace(
          e->>'path', '/02_EDITED/', '/releases/' || p_release_id::text || '/', 'i'
        ))
    )
  ) then raise exception 'review_publish_snapshot_changed'; end if;

  if exists(
    select 1 from unnest(coalesce(v_task.service_codes, array[]::text[])) s
    where not exists (
      select 1 from jsonb_array_elements(p_manifest) m
      where lower(coalesce(m->>'service_code', '')) = lower(s)
    )
  ) then raise exception 'final_media_missing'; end if;

  v_fingerprint := encode(extensions.digest(convert_to(p_manifest::text, 'UTF8'), 'sha256'), 'hex');
  v_previous_release := v_task.approved_release_id;

  insert into public.media_releases(
    id, tenant_id, task_id, provider, root_path, status,
    manifest_fingerprint, file_count, created_by_user_id
  ) values (
    p_release_id, v_task.tenant_id, v_task.id, 'dropbox', p_release_root, 'publishing',
    v_fingerprint, v_manifest_count, p_actor
  );

  insert into public.media_release_files(
    tenant_id, task_id, release_id, provider, provider_file_id,
    provider_revision, content_hash, size_bytes, path, name, service_code,
    source_provider_file_id, source_revision, source_content_hash,
    source_size_bytes, source_path
  )
  select
    v_task.tenant_id,
    v_task.id,
    p_release_id,
    'dropbox',
    m->>'provider_file_id',
    m->>'provider_revision',
    lower(m->>'content_hash'),
    (m->>'size_bytes')::bigint,
    m->>'path',
    m->>'name',
    nullif(lower(coalesce(m->>'service_code', '')), ''),
    m->>'source_provider_file_id',
    m->>'source_revision',
    lower(m->>'source_content_hash'),
    (m->>'source_size_bytes')::bigint,
    m->>'source_path'
  from jsonb_array_elements(p_manifest) m;

  update public.media_releases
  set status = 'approved', approved_at = now()
  where id = p_release_id and status = 'publishing';

  v_message := v_manifest_count::text || case when v_manifest_count = 1
    then ' edited file was published for Agent review.'
    else ' edited files were published for Agent review.' end;
  update public.tasks
  set status = 'review',
      approved_release_id = p_release_id,
      next_action = 'Agent needs to review the client-facing media.',
      metadata = (coalesce(metadata, '{}'::jsonb) - 'review_publish_claim') || jsonb_build_object(
        'last_status_action', 'submit_review',
        'last_status_by', p_actor,
        'last_status_at', now(),
        'approved_release_manifest', v_fingerprint
      )
  where id = v_task.id;

  insert into public.task_events(tenant_id, task_id, type, actor_user_id, detail)
  values(v_task.tenant_id, v_task.id, 'status_submit_review', p_actor, jsonb_build_object(
    'message', v_message,
    'published_files', v_manifest_count,
    'release_id', p_release_id,
    'previous_release_id', v_previous_release,
    'manifest_fingerprint', v_fingerprint
  ));

  return jsonb_build_object(
    'status', 'review',
    'message', v_message,
    'published_files', v_manifest_count,
    'release_id', p_release_id,
    'previous_release_id', v_previous_release,
    'manifest_fingerprint', v_fingerprint
  );
end;
$$;

create or replace function public.northlight_approve_delivery(p_task_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_actor_role text;
  v_message text := 'Final media was approved and delivered.';
begin
  select role_code into v_actor_role from public.users where id = p_actor and active = true;
  if v_actor_role is null then raise exception 'permission_denied'; end if;
  select * into v_task from public.tasks where id = p_task_id and deleted_at is null for update;
  if not found then raise exception 'task_not_found'; end if;
  if v_task.archived_at is not null then raise exception 'task_archived'; end if;
  if not (v_actor_role in ('admin','owner') or (v_actor_role = 'agent' and v_task.agent_user_id = p_actor)) then
    raise exception 'permission_denied';
  end if;
  if v_task.status <> 'review' then raise exception 'task_state_changed'; end if;
  if v_task.approved_release_id is null or not exists(
    select 1 from public.media_releases r
    where r.id = v_task.approved_release_id and r.task_id = v_task.id and r.status = 'approved'
  ) then raise exception 'final_media_missing'; end if;
  if exists(
    select 1 from unnest(coalesce(v_task.service_codes, array[]::text[])) s
    where not exists (
      select 1 from public.media_release_files f
      where f.release_id = v_task.approved_release_id
        and f.task_id = v_task.id
        and lower(coalesce(f.service_code, '')) = lower(s)
    )
  ) then raise exception 'final_media_missing'; end if;

  update public.tasks
  set status = 'delivered',
      next_action = 'No further action is required.',
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'last_status_action', 'approve_delivery',
        'last_status_by', p_actor,
        'last_status_at', now()
      )
  where id = v_task.id;
  insert into public.task_events(tenant_id, task_id, type, actor_user_id, detail)
  values(v_task.tenant_id, v_task.id, 'status_approve_delivery', p_actor, jsonb_build_object(
    'message', v_message,
    'release_id', v_task.approved_release_id
  ));
  return jsonb_build_object('status', 'delivered', 'message', v_message, 'release_id', v_task.approved_release_id);
end;
$$;

create or replace function public.northlight_require_approved_delivery_release()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.status = 'delivered' and old.status is distinct from 'delivered' then
    if new.approved_release_id is null or not exists(
      select 1 from public.media_releases r
      where r.id = new.approved_release_id and r.task_id = new.id and r.status = 'approved'
    ) then raise exception 'final_media_missing'; end if;
    if exists(
      select 1 from unnest(coalesce(new.service_codes, array[]::text[])) s
      where not exists (
        select 1 from public.media_release_files f
        where f.release_id = new.approved_release_id
          and f.task_id = new.id
          and lower(coalesce(f.service_code, '')) = lower(s)
      )
    ) then raise exception 'final_media_missing'; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists northlight_require_approved_delivery_release on public.tasks;
create trigger northlight_require_approved_delivery_release
before update of status on public.tasks
for each row execute function public.northlight_require_approved_delivery_release();

grant execute on function public.northlight_claim_review_publish(uuid, uuid) to anon, authenticated;
grant execute on function public.northlight_release_review_publish(uuid, uuid, text) to anon, authenticated;
grant execute on function public.northlight_finish_review_publish(uuid, uuid, text, uuid, text, jsonb) to anon, authenticated;
grant execute on function public.northlight_approve_delivery(uuid, uuid) to anon, authenticated;
