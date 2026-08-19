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

create or replace function public.northlight_release_review_publish(p_task_id uuid, p_actor uuid, p_token text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_claim jsonb;
begin
  select * into v_task from public.tasks where id=p_task_id and deleted_at is null for update;
  if not found then return jsonb_build_object('released',false); end if;
  v_claim := coalesce(v_task.metadata,'{}'::jsonb)->'review_publish_claim';
  if v_claim is null or v_claim->>'token' is distinct from p_token then return jsonb_build_object('released',false); end if;
  if v_claim->>'actor_user_id' is distinct from p_actor::text then return jsonb_build_object('released',false); end if;
  update public.tasks set metadata=coalesce(metadata,'{}'::jsonb)-'review_publish_claim' where id=v_task.id;
  return jsonb_build_object('released',true);
end;
$$;

create or replace function public.northlight_finish_review_publish(p_task_id uuid, p_actor uuid, p_token text, p_published_files integer)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_actor_role text;
  v_claim jsonb;
  v_missing text[];
  v_count integer := greatest(0,coalesce(p_published_files,0));
  v_message text;
begin
  select role_code into v_actor_role from public.users where id=p_actor and active=true;
  if v_actor_role is null then raise exception 'permission_denied'; end if;
  select * into v_task from public.tasks where id=p_task_id and deleted_at is null for update;
  if not found then raise exception 'task_not_found'; end if;
  if v_task.archived_at is not null then raise exception 'task_archived'; end if;
  if not (v_actor_role in ('admin','owner') or (v_actor_role='editor' and v_task.editor_user_id=p_actor)) then raise exception 'permission_denied'; end if;
  if v_task.status<>'editing' then raise exception 'task_state_changed'; end if;
  v_claim := coalesce(v_task.metadata,'{}'::jsonb)->'review_publish_claim';
  if v_claim is null or v_claim->>'token' is distinct from p_token or v_claim->>'actor_user_id' is distinct from p_actor::text then
    raise exception 'review_publish_claim_lost';
  end if;

  select array_agg(s order by s) into v_missing
  from unnest(coalesce(v_task.service_codes,array[]::text[])) s
  where not exists (
    select 1 from public.task_files f
    where f.task_id=v_task.id and f.stage='03_FINAL' and f.file_type='file' and f.is_deleted=false
      and lower(coalesce(f.service_code,''))=lower(s)
  );
  if coalesce(cardinality(v_missing),0)>0 then raise exception 'final_media_missing:%',array_to_string(v_missing,','); end if;

  v_message := v_count::text || case when v_count=1 then ' edited file was published for Agent review.' else ' edited files were published for Agent review.' end;
  update public.tasks
  set status='review',next_action='Agent needs to review the client-facing media.',
      metadata=(coalesce(metadata,'{}'::jsonb)-'review_publish_claim') || jsonb_build_object('last_status_action','submit_review','last_status_by',p_actor,'last_status_at',now())
  where id=v_task.id;
  insert into public.task_events(tenant_id,task_id,type,actor_user_id,detail)
  values(v_task.tenant_id,v_task.id,'status_submit_review',p_actor,jsonb_build_object('message',v_message,'published_files',v_count));
  return jsonb_build_object('status','review','message',v_message,'published_files',v_count);
end;
$$;

-- Generic workflow transition must not bypass the review-publication claim.
create or replace function public.northlight_apply_workflow_transition(
  p_task_id uuid,
  p_actor uuid,
  p_action text,
  p_editor_id uuid default null,
  p_published_files integer default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_actor_role text;
  v_missing text[];
  v_status text;
  v_next text;
  v_message text;
  v_editor uuid;
  v_detail jsonb := '{}'::jsonb;
begin
  select role_code into v_actor_role from public.users where id=p_actor and active=true;
  if v_actor_role is null then raise exception 'permission_denied'; end if;
  select * into v_task from public.tasks where id=p_task_id and deleted_at is null for update;
  if not found then raise exception 'task_not_found'; end if;
  if v_task.archived_at is not null then raise exception 'task_archived'; end if;

  if p_action='confirm' then
    if not (v_actor_role in ('admin','owner') or (v_actor_role='photographer' and v_task.photographer_user_id=p_actor)) then raise exception 'permission_denied'; end if;
    if v_task.status not in ('assigned','reschedule_requested') then raise exception 'task_state_changed'; end if;
    v_status := 'confirmed';
    v_next := 'The shoot is booked. Northlight is waiting for capture.';
    v_message := 'Photographer confirmed the booking.';
  elsif p_action='source_ready' then
    if not (v_actor_role in ('admin','owner') or (v_actor_role='photographer' and v_task.photographer_user_id=p_actor)) then raise exception 'permission_denied'; end if;
    if v_task.status not in ('assigned','confirmed','shoot_complete') then raise exception 'task_state_changed'; end if;
    select array_agg(s order by s) into v_missing
    from unnest(coalesce(v_task.service_codes,array[]::text[])) s
    where not exists (
      select 1 from public.task_files f where f.task_id=v_task.id and f.stage='01_RAW' and f.file_type='file' and f.is_deleted=false and lower(coalesce(f.service_code,''))=lower(s)
    );
    if coalesce(cardinality(v_missing),0)>0 then raise exception 'source_media_missing:%',array_to_string(v_missing,','); end if;
    v_editor := coalesce(v_task.editor_user_id,p_editor_id);
    if v_editor is not null and not exists(select 1 from public.users u where u.id=v_editor and u.active=true and u.role_code='editor') then v_editor := null; end if;
    v_status := 'raw_received';
    v_next := case when v_editor is null then 'Management needs to assign an Editor.' else 'Editor needs to begin post-production.' end;
    v_message := case when v_editor is null then 'Source media is complete; Editor assignment is required.' else 'Source media is complete and an active Editor was routed automatically.' end;
    v_detail := jsonb_build_object('editor_user_id',v_editor);
  elsif p_action='start_editing' then
    if not (v_actor_role in ('admin','owner') or (v_actor_role='editor' and v_task.editor_user_id=p_actor)) then raise exception 'permission_denied'; end if;
    if v_task.status not in ('raw_received','revision') then raise exception 'task_state_changed'; end if;
    v_status := 'editing';
    v_next := 'Editing is in progress.';
    v_message := case when v_task.status='revision' then 'Revision work started.' else 'Post-production started.' end;
  elsif p_action='submit_review' then
    raise exception 'review_publish_guard_required';
  elsif p_action='approve_delivery' then
    if not (v_actor_role in ('admin','owner') or (v_actor_role='agent' and v_task.agent_user_id=p_actor)) then raise exception 'permission_denied'; end if;
    if v_task.status<>'review' then raise exception 'task_state_changed'; end if;
    select array_agg(s order by s) into v_missing
    from unnest(coalesce(v_task.service_codes,array[]::text[])) s
    where not exists (
      select 1 from public.task_files f where f.task_id=v_task.id and f.stage='03_FINAL' and f.file_type='file' and f.is_deleted=false and lower(coalesce(f.service_code,''))=lower(s)
    );
    if coalesce(cardinality(v_missing),0)>0 then raise exception 'final_media_missing:%',array_to_string(v_missing,','); end if;
    v_status := 'delivered';
    v_next := 'No further action is required.';
    v_message := 'Final media was approved and delivered.';
  else
    raise exception 'unknown_workflow_action';
  end if;

  update public.tasks
  set status=v_status,
      editor_user_id=case when p_action='source_ready' then v_editor else editor_user_id end,
      next_action=v_next,
      metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object('last_status_action',p_action,'last_status_by',p_actor,'last_status_at',now())
  where id=v_task.id;
  insert into public.task_events(tenant_id,task_id,type,actor_user_id,detail)
  values(v_task.tenant_id,v_task.id,'status_' || p_action,p_actor,jsonb_build_object('message',v_message) || v_detail);
  return jsonb_build_object('status',v_status,'message',v_message,'editor_user_id',v_editor,'detail',v_detail);
end;
$$;
