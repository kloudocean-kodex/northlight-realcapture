create table if not exists public.media_upload_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  user_id uuid not null references public.users(id),
  stage text not null check (stage in ('01_RAW','02_EDITED','03_FINAL','04_REFERENCE')),
  service_code text,
  path text not null,
  filename text not null,
  size_bytes bigint not null check (size_bytes > 0),
  mime_type text,
  dropbox_session_id text not null,
  uploaded_bytes bigint not null default 0 check (uploaded_bytes >= 0),
  status text not null default 'uploading' check (status in ('uploading','done','failed')),
  expires_at timestamptz not null,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists media_upload_sessions_tenant_idx on public.media_upload_sessions (tenant_id);
create index if not exists media_upload_sessions_task_idx on public.media_upload_sessions (task_id, status, created_at desc);
create index if not exists media_upload_sessions_user_idx on public.media_upload_sessions (user_id, status, created_at desc);
alter table public.media_upload_sessions enable row level security;
drop policy if exists northlight_pilot_access on public.media_upload_sessions;
create policy northlight_pilot_access on public.media_upload_sessions for all to anon, authenticated using (public.northlight_pilot_allowed()) with check (public.northlight_pilot_allowed());

create or replace function public.northlight_request_revision(p_task_id uuid, p_requested_by uuid, p_note text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_number integer;
  v_note text := btrim(coalesce(p_note,''));
begin
  if length(v_note) < 5 then
    raise exception 'revision_note_required';
  end if;
  if length(v_note) > 4000 then
    raise exception 'revision_note_too_long';
  end if;

  select * into v_task
  from public.tasks
  where id = p_task_id and deleted_at is null
  for update;

  if not found then raise exception 'task_not_found'; end if;
  if v_task.archived_at is not null then raise exception 'task_archived'; end if;
  if v_task.status <> 'review' then raise exception 'task_not_in_review'; end if;

  v_number := coalesce(v_task.revision_count,0) + 1;

  insert into public.revisions(tenant_id,task_id,number,requested_by_user_id,note,status)
  values(v_task.tenant_id,v_task.id,v_number,p_requested_by,v_note,'requested');

  insert into public.task_comments(tenant_id,task_id,author_user_id,body,visibility,kind,metadata)
  values(v_task.tenant_id,v_task.id,p_requested_by,'Revision request: ' || v_note,'task','comment',jsonb_build_object('revision_number',v_number,'workflow','revision'));

  update public.tasks
  set status='revision',
      revision_count=v_number,
      next_action='Editor needs to complete the requested revision.',
      metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object('last_status_action','request_revision','last_status_by',p_requested_by,'last_status_at',now())
  where id=v_task.id;

  insert into public.task_events(tenant_id,task_id,type,actor_user_id,detail)
  values(v_task.tenant_id,v_task.id,'status_request_revision',p_requested_by,jsonb_build_object('message','A revision was requested.','revision_number',v_number));

  return jsonb_build_object('revision_number',v_number);
end;
$$;
