alter table public.media_upload_sessions drop constraint if exists media_upload_sessions_status_check;
alter table public.media_upload_sessions add constraint media_upload_sessions_status_check
  check (status in ('direct_pending','uploading','uploaded','done','failed'));

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
begin
  select role_code into v_actor_role from public.users where id=p_actor and active=true;
  if v_actor_role is null then raise exception 'permission_denied'; end if;
  select * into v_task from public.tasks where id=p_task_id and deleted_at is null for update;
  if not found then raise exception 'task_not_found'; end if;
  if v_task.archived_at is not null then raise exception 'task_archived'; end if;
  if not (v_actor_role in ('admin','owner') or (v_actor_role='editor' and v_task.editor_user_id=p_actor)) then raise exception 'permission_denied'; end if;
  if v_task.status<>'editing' then raise exception 'task_state_changed'; end if;

  v_claim := coalesce(v_task.metadata,'{}'::jsonb)->'review_publish_claim';
  if v_claim is not null and nullif(v_claim->>'expires_at','') is not null and (v_claim->>'expires_at')::timestamptz > v_now then
    raise exception 'review_publish_busy';
  end if;
  if exists(
    select 1 from public.media_upload_sessions u
    where u.task_id=v_task.id and u.stage in ('02_EDITED','03_FINAL') and u.status in ('direct_pending','uploading','uploaded')
      and u.expires_at>v_now
  ) then raise exception 'review_media_upload_in_progress'; end if;

  select array_agg(s order by s) into v_missing
  from unnest(coalesce(v_task.service_codes,array[]::text[])) s
  where not exists (
    select 1 from public.task_files f
    where f.task_id=v_task.id and f.stage='02_EDITED' and f.file_type='file' and f.is_deleted=false
      and lower(coalesce(f.service_code,''))=lower(s)
  );
  if coalesce(cardinality(v_missing),0)>0 then raise exception 'edited_media_missing:%',array_to_string(v_missing,','); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'path',f.path,'name',f.name,'service_code',f.service_code,'revision',f.revision,'content_hash',f.content_hash
    ) order by f.path),'[]'::jsonb)
  into v_files
  from public.task_files f
  where f.task_id=v_task.id and f.stage='02_EDITED' and f.file_type='file' and f.is_deleted=false;
  if jsonb_array_length(v_files)=0 then raise exception 'edited_media_missing'; end if;

  update public.tasks
  set metadata=(coalesce(metadata,'{}'::jsonb)-'review_publish_claim') || jsonb_build_object('review_publish_claim',jsonb_build_object(
    'token',v_token::text,'actor_user_id',p_actor,'claimed_at',v_now,'expires_at',v_expires,'edited_files',v_files
  ))
  where id=v_task.id;
  return jsonb_build_object('token',v_token::text,'expires_at',v_expires,'edited_files',v_files);
end;
$$;

create or replace function public.northlight_remove_test_task(p_task_id uuid, p_actor uuid, p_reason text default 'Admin cleanup')
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_reason text := left(coalesce(nullif(btrim(p_reason),''),'Admin cleanup'),200);
begin
  select * into v_task from public.tasks where id=p_task_id and deleted_at is null for update;
  if not found then raise exception 'task_not_found'; end if;
  if v_task.dropbox_path is not null or v_task.calendar_event_id is not null then raise exception 'external_history'; end if;
  if exists(select 1 from public.task_files where task_id=v_task.id limit 1)
     or exists(select 1 from public.invoices where task_id=v_task.id limit 1) then raise exception 'business_history'; end if;
  if exists(select 1 from public.calendar_cleanup_queue where task_id=v_task.id limit 1)
     or exists(select 1 from public.task_events where task_id=v_task.id and type in ('assignment_email_sent','calendar_event_created','dropbox_workspace_created','calendar_event_cancelled') limit 1)
     or exists(select 1 from public.task_handoffs where task_id=v_task.id and status='done' and kind in ('dropbox','calendar','email') limit 1) then raise exception 'external_history'; end if;
  if exists(select 1 from public.media_upload_sessions where task_id=v_task.id and status in ('direct_pending','uploading','uploaded') limit 1) then raise exception 'upload_in_progress'; end if;
  if exists(select 1 from public.task_handoffs where task_id=v_task.id and status='processing' limit 1) then raise exception 'handoff_in_progress'; end if;
  update public.task_handoffs set status='cancelled',next_attempt_at=null,last_error='task_removed',updated_at=now()
  where task_id=v_task.id and status in ('pending','attention');
  insert into public.task_events(tenant_id,task_id,type,actor_user_id,detail)
  values(v_task.tenant_id,v_task.id,'task_removed',p_actor,jsonb_build_object('message','Task removed from active Northlight records.','reason',v_reason));
  update public.tasks set deleted_at=now(),deleted_by_user_id=p_actor where id=v_task.id;
  return jsonb_build_object('removed',true,'task_id',v_task.id);
end;
$$;
