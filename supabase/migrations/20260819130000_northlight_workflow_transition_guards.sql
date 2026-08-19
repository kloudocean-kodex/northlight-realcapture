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
        select 1 from public.task_files f
        where f.task_id=v_task.id and f.stage='01_RAW' and f.file_type='file' and f.is_deleted=false
          and lower(coalesce(f.service_code,''))=lower(s)
      );
    if coalesce(cardinality(v_missing),0)>0 then raise exception 'source_media_missing:%',array_to_string(v_missing,','); end if;
    v_editor := coalesce(v_task.editor_user_id,p_editor_id);
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
    if not (v_actor_role in ('admin','owner') or (v_actor_role='editor' and v_task.editor_user_id=p_actor)) then raise exception 'permission_denied'; end if;
    if v_task.status<>'editing' then raise exception 'task_state_changed'; end if;
    select array_agg(s order by s) into v_missing
      from unnest(coalesce(v_task.service_codes,array[]::text[])) s
      where not exists (
        select 1 from public.task_files f
        where f.task_id=v_task.id and f.stage='02_EDITED' and f.file_type='file' and f.is_deleted=false
          and lower(coalesce(f.service_code,''))=lower(s)
      );
    if coalesce(cardinality(v_missing),0)>0 then raise exception 'edited_media_missing:%',array_to_string(v_missing,','); end if;
    v_status := 'review';
    v_next := 'Agent needs to review the client-facing media.';
    v_message := coalesce(p_published_files,0)::text || case when coalesce(p_published_files,0)=1 then ' edited file was published for Agent review.' else ' edited files were published for Agent review.' end;
    v_detail := jsonb_build_object('published_files',coalesce(p_published_files,0));

  elsif p_action='approve_delivery' then
    if not (v_actor_role in ('admin','owner') or (v_actor_role='agent' and v_task.agent_user_id=p_actor)) then raise exception 'permission_denied'; end if;
    if v_task.status<>'review' then raise exception 'task_state_changed'; end if;
    select array_agg(s order by s) into v_missing
      from unnest(coalesce(v_task.service_codes,array[]::text[])) s
      where not exists (
        select 1 from public.task_files f
        where f.task_id=v_task.id and f.stage='03_FINAL' and f.file_type='file' and f.is_deleted=false
          and lower(coalesce(f.service_code,''))=lower(s)
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

create or replace function public.northlight_request_revision(p_task_id uuid, p_requested_by uuid, p_note text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_actor_role text;
  v_number integer;
  v_note text := btrim(coalesce(p_note,''));
begin
  if length(v_note)<5 then raise exception 'revision_note_required'; end if;
  if length(v_note)>4000 then raise exception 'revision_note_too_long'; end if;
  select role_code into v_actor_role from public.users where id=p_requested_by and active=true;
  if v_actor_role is null then raise exception 'permission_denied'; end if;
  select * into v_task from public.tasks where id=p_task_id and deleted_at is null for update;
  if not found then raise exception 'task_not_found'; end if;
  if v_task.archived_at is not null then raise exception 'task_archived'; end if;
  if not (v_actor_role in ('admin','owner') or (v_actor_role='agent' and v_task.agent_user_id=p_requested_by)) then raise exception 'permission_denied'; end if;
  if v_task.status<>'review' then raise exception 'task_not_in_review'; end if;
  v_number := coalesce(v_task.revision_count,0)+1;
  insert into public.revisions(tenant_id,task_id,number,requested_by_user_id,note,status)
  values(v_task.tenant_id,v_task.id,v_number,p_requested_by,v_note,'requested');
  insert into public.task_comments(tenant_id,task_id,author_user_id,body,visibility,kind,metadata)
  values(v_task.tenant_id,v_task.id,p_requested_by,'Revision request: ' || v_note,'task','comment',jsonb_build_object('revision_number',v_number,'workflow','revision'));
  update public.tasks
  set status='revision',revision_count=v_number,next_action='Editor needs to complete the requested revision.',
      metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object('last_status_action','request_revision','last_status_by',p_requested_by,'last_status_at',now())
  where id=v_task.id;
  insert into public.task_events(tenant_id,task_id,type,actor_user_id,detail)
  values(v_task.tenant_id,v_task.id,'status_request_revision',p_requested_by,jsonb_build_object('message','A revision was requested.','revision_number',v_number));
  return jsonb_build_object('revision_number',v_number);
end;
$$;

create or replace function public.northlight_apply_reschedule(
  p_task_id uuid,
  p_actor uuid,
  p_expected_photographer uuid,
  p_expected_status text,
  p_expected_start timestamptz,
  p_expected_end timestamptz,
  p_expected_calendar_event_id text,
  p_new_start timestamptz,
  p_new_end timestamptz,
  p_new_status text,
  p_next_action text,
  p_buffer_before integer,
  p_buffer_after integer,
  p_external_review boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_actor_role text;
  v_meta jsonb;
begin
  select role_code into v_actor_role from public.users where id=p_actor and active=true;
  if v_actor_role is null then raise exception 'permission_denied'; end if;
  select * into v_task from public.tasks where id=p_task_id and deleted_at is null for update;
  if not found then raise exception 'task_not_found'; end if;
  if v_task.archived_at is not null then raise exception 'task_archived'; end if;
  if not (v_actor_role in ('admin','owner') or (v_actor_role='agent' and v_task.agent_user_id=p_actor) or (v_actor_role='photographer' and v_task.photographer_user_id=p_actor)) then raise exception 'permission_denied'; end if;
  if p_expected_status not in ('assigned','confirmed','reschedule_requested') or p_new_status not in ('assigned','confirmed','reschedule_requested') then raise exception 'invalid_schedule_state'; end if;
  if v_task.photographer_user_id is distinct from p_expected_photographer
     or v_task.status is distinct from p_expected_status
     or v_task.scheduled_start is distinct from p_expected_start
     or v_task.scheduled_end is distinct from p_expected_end
     or v_task.calendar_event_id is distinct from p_expected_calendar_event_id then
    raise exception 'task_changed';
  end if;
  if p_new_start is null or p_new_end is null or p_new_end<=p_new_start then raise exception 'invalid_schedule'; end if;

  v_meta := coalesce(v_task.metadata,'{}'::jsonb)
    - 'external_calendar_previous_status'
    - 'external_calendar_cancelled'
    - 'external_calendar_changed_at'
    - 'external_calendar_event_id'
    - 'external_calendar_html_link'
    - 'external_calendar_proposed_schedule';
  v_meta := v_meta || jsonb_build_object(
    'last_schedule_change_by',p_actor,
    'last_schedule_change_at',now(),
    'buffer_before_min',greatest(0,coalesce(p_buffer_before,0)),
    'buffer_after_min',greatest(0,coalesce(p_buffer_after,0))
  );

  update public.tasks
  set scheduled_start=p_new_start,scheduled_end=p_new_end,status=p_new_status,next_action=p_next_action,metadata=v_meta
  where id=v_task.id;

  if p_expected_calendar_event_id is null then
    insert into public.task_handoffs(tenant_id,task_id,kind,status,attempts,next_attempt_at,last_attempt_at,last_error,payload,updated_at)
    values(v_task.tenant_id,v_task.id,'calendar','pending',0,null,null,null,'{}'::jsonb,now())
    on conflict(task_id,kind) do update
    set status='pending',attempts=0,next_attempt_at=null,last_attempt_at=null,last_error=null,payload='{}'::jsonb,updated_at=now();
  end if;

  insert into public.task_events(tenant_id,task_id,type,actor_user_id,detail)
  values(v_task.tenant_id,v_task.id,'schedule_changed',p_actor,jsonb_build_object(
    'message',case when p_external_review then 'External Calendar change reviewed and booking rescheduled in Northlight.' else 'Shoot schedule changed in Northlight.' end,
    'from',jsonb_build_object('start',v_task.scheduled_start,'end',v_task.scheduled_end),
    'to',jsonb_build_object('start',p_new_start,'end',p_new_end),
    'restored_status',p_new_status
  ));
  return jsonb_build_object('status',p_new_status,'calendar_needs_rebuild',p_expected_calendar_event_id is null);
end;
$$;
