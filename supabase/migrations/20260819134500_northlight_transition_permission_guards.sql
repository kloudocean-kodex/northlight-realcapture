create or replace function public.northlight_cancel_task(p_task_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_actor_role text;
  v_cleanup_id uuid;
begin
  select role_code into v_actor_role from public.users where id=p_actor and active=true;
  if v_actor_role is null then raise exception 'permission_denied'; end if;
  select * into v_task from public.tasks where id=p_task_id and deleted_at is null for update;
  if not found then raise exception 'task_not_found'; end if;
  if v_task.archived_at is not null then raise exception 'task_archived'; end if;
  if not (v_actor_role in ('admin','owner') or (v_actor_role='agent' and v_task.agent_user_id=p_actor)) then raise exception 'permission_denied'; end if;
  if v_task.status in ('delivered','cancelled') then raise exception 'task_closed'; end if;
  if v_task.calendar_event_id is not null and v_task.calendar_owner_user_id is not null then
    insert into public.calendar_cleanup_queue(tenant_id,task_id,calendar_owner_user_id,calendar_event_id,calendar_id,status)
    values(v_task.tenant_id,v_task.id,v_task.calendar_owner_user_id,v_task.calendar_event_id,coalesce(v_task.metadata->>'calendar_id','primary'),'pending')
    on conflict(task_id,calendar_owner_user_id,calendar_event_id) do update set status=case when calendar_cleanup_queue.status='done' then 'done' else 'pending' end,updated_at=now()
    returning id into v_cleanup_id;
  end if;
  update public.task_handoffs set status='cancelled',next_attempt_at=null,last_error='task_cancelled',updated_at=now()
    where task_id=v_task.id and kind in ('dropbox','calendar','email') and status in ('pending','processing','attention');
  update public.tasks set status='cancelled',next_action='No further Northlight action is required.',
    metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('cancelled_by',p_actor,'cancelled_at',now(),'calendar_cleanup_pending',v_cleanup_id is not null)
    where id=v_task.id;
  insert into public.task_events(tenant_id,task_id,type,actor_user_id,detail)
    values(v_task.tenant_id,v_task.id,'task_cancelled',p_actor,jsonb_build_object('message','Task cancelled in Northlight.','calendar_cleanup_id',v_cleanup_id));
  return jsonb_build_object('calendar_cleanup_id',v_cleanup_id);
end;
$$;

create or replace function public.northlight_decline_task(p_task_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_actor_role text;
  v_cleanup_id uuid;
  v_meta jsonb;
begin
  select role_code into v_actor_role from public.users where id=p_actor and active=true;
  if v_actor_role is null then raise exception 'permission_denied'; end if;
  select * into v_task from public.tasks where id=p_task_id and deleted_at is null for update;
  if not found then raise exception 'task_not_found'; end if;
  if v_task.archived_at is not null then raise exception 'task_archived'; end if;
  if not (v_actor_role in ('admin','owner') or (v_actor_role='photographer' and v_task.photographer_user_id=p_actor)) then raise exception 'permission_denied'; end if;
  if v_task.status not in ('assigned','confirmed','reschedule_requested') then raise exception 'task_not_declineable'; end if;
  if v_task.calendar_event_id is not null and v_task.calendar_owner_user_id is not null then
    insert into public.calendar_cleanup_queue(tenant_id,task_id,calendar_owner_user_id,calendar_event_id,calendar_id,status)
    values(v_task.tenant_id,v_task.id,v_task.calendar_owner_user_id,v_task.calendar_event_id,coalesce(v_task.metadata->>'calendar_id','primary'),'pending')
    on conflict(task_id,calendar_owner_user_id,calendar_event_id) do update set status=case when calendar_cleanup_queue.status='done' then 'done' else 'pending' end,updated_at=now()
    returning id into v_cleanup_id;
  end if;
  update public.task_handoffs set status='cancelled',next_attempt_at=null,last_error='photographer_declined',updated_at=now()
    where task_id=v_task.id and kind in ('calendar','email') and status in ('pending','processing','attention');
  v_meta := (coalesce(v_task.metadata,'{}'::jsonb)-'calendar_link'-'calendar_id')||jsonb_build_object('declined_by',p_actor,'declined_at',now(),'declined_calendar_event_id',v_task.calendar_event_id,'calendar_cleanup_pending',v_cleanup_id is not null);
  update public.tasks set status='declined',calendar_event_id=null,next_action='Management needs to assign another Photographer.',metadata=v_meta where id=v_task.id;
  insert into public.task_events(tenant_id,task_id,type,actor_user_id,detail)
    values(v_task.tenant_id,v_task.id,'status_decline',p_actor,jsonb_build_object('message','Photographer declined the booking.','calendar_cleanup_id',v_cleanup_id));
  return jsonb_build_object('calendar_cleanup_id',v_cleanup_id);
end;
$$;

create or replace function public.northlight_reassign_task(p_task_id uuid,p_actor uuid,p_new_photographer uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_actor_role text;
  v_new_role text;
  v_profile public.provider_profiles%rowtype;
  v_cleanup_id uuid;
  v_meta jsonb;
begin
  select role_code into v_actor_role from public.users where id=p_actor and active=true;
  if v_actor_role is null then raise exception 'permission_denied'; end if;
  select * into v_task from public.tasks where id=p_task_id and deleted_at is null for update;
  if not found then raise exception 'task_not_found'; end if;
  if v_task.archived_at is not null then raise exception 'task_archived'; end if;
  if v_actor_role in ('admin','owner') then
    if v_task.status not in ('assigned','declined','confirmed','reschedule_requested') then raise exception 'task_not_reassignable'; end if;
  elsif v_actor_role='agent' and v_task.agent_user_id=p_actor then
    if v_task.status<>'declined' then raise exception 'task_not_reassignable'; end if;
  else
    raise exception 'permission_denied';
  end if;
  if p_new_photographer is null or p_new_photographer=v_task.photographer_user_id then raise exception 'replacement_required'; end if;
  select role_code into v_new_role from public.users where id=p_new_photographer and active=true;
  if v_new_role is distinct from 'photographer' then raise exception 'replacement_not_active_photographer'; end if;
  select * into v_profile from public.provider_profiles where user_id=p_new_photographer limit 1;
  if not found then raise exception 'replacement_not_configured'; end if;
  if not (coalesce(v_profile.areas,array[]::text[]) @> array[v_task.area]) then raise exception 'replacement_area_not_covered'; end if;
  if not (coalesce(v_profile.service_codes,array[]::text[]) @> coalesce(v_task.service_codes,array[]::text[])) then raise exception 'replacement_services_not_covered'; end if;
  if v_task.calendar_event_id is not null and v_task.calendar_owner_user_id is not null then
    insert into public.calendar_cleanup_queue(tenant_id,task_id,calendar_owner_user_id,calendar_event_id,calendar_id,status)
    values(v_task.tenant_id,v_task.id,v_task.calendar_owner_user_id,v_task.calendar_event_id,coalesce(v_task.metadata->>'calendar_id','primary'),'pending')
    on conflict(task_id,calendar_owner_user_id,calendar_event_id) do update set status=case when calendar_cleanup_queue.status='done' then 'done' else 'pending' end,updated_at=now()
    returning id into v_cleanup_id;
  end if;
  insert into public.task_handoffs(tenant_id,task_id,kind,status,attempts,next_attempt_at,last_attempt_at,last_error,payload,updated_at)
  values(v_task.tenant_id,v_task.id,'calendar','pending',0,null,null,null,'{}'::jsonb,now()),(v_task.tenant_id,v_task.id,'email','pending',0,null,null,null,'{}'::jsonb,now())
  on conflict(task_id,kind) do update set status='pending',attempts=0,next_attempt_at=null,last_attempt_at=null,last_error=null,payload='{}'::jsonb,updated_at=now();
  v_meta := (coalesce(v_task.metadata,'{}'::jsonb)-'assignment_email_user_id'-'assignment_email_to'-'assignment_email_at'-'calendar_link'-'calendar_id')||jsonb_build_object('reassigned_at',now(),'reassigned_by',p_actor,'reassigned_from',v_task.photographer_user_id,'calendar_cleanup_pending',v_cleanup_id is not null);
  update public.tasks set photographer_user_id=p_new_photographer,calendar_owner_user_id=p_new_photographer,calendar_event_id=null,status='assigned',next_action='Photographer needs to confirm the booking.',metadata=v_meta where id=v_task.id;
  insert into public.task_events(tenant_id,task_id,type,actor_user_id,detail)
    values(v_task.tenant_id,v_task.id,'photographer_reassigned',p_actor,jsonb_build_object('message','Photographer reassigned.','from',v_task.photographer_user_id,'to',p_new_photographer,'calendar_cleanup_id',v_cleanup_id));
  return jsonb_build_object('calendar_cleanup_id',v_cleanup_id,'from',v_task.photographer_user_id,'to',p_new_photographer);
end;
$$;

create or replace function public.northlight_remove_test_task(p_task_id uuid,p_actor uuid,p_reason text default 'Admin cleanup')
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_task public.tasks%rowtype;
  v_actor_role text;
  v_reason text := left(coalesce(nullif(btrim(p_reason),''),'Admin cleanup'),200);
begin
  select role_code into v_actor_role from public.users where id=p_actor and active=true;
  if v_actor_role is distinct from 'admin' then raise exception 'permission_denied'; end if;
  select * into v_task from public.tasks where id=p_task_id and deleted_at is null for update;
  if not found then raise exception 'task_not_found'; end if;
  if v_task.dropbox_path is not null or v_task.calendar_event_id is not null then raise exception 'external_history'; end if;
  if exists(select 1 from public.task_files where task_id=v_task.id limit 1) or exists(select 1 from public.invoices where task_id=v_task.id limit 1) then raise exception 'business_history'; end if;
  if exists(select 1 from public.calendar_cleanup_queue where task_id=v_task.id limit 1)
     or exists(select 1 from public.task_events where task_id=v_task.id and type in ('assignment_email_sent','calendar_event_created','dropbox_workspace_created','calendar_event_cancelled') limit 1)
     or exists(select 1 from public.task_handoffs where task_id=v_task.id and status='done' and kind in ('dropbox','calendar','email') limit 1) then raise exception 'external_history'; end if;
  if exists(select 1 from public.media_upload_sessions where task_id=v_task.id and status='uploading' limit 1) then raise exception 'upload_in_progress'; end if;
  if exists(select 1 from public.task_handoffs where task_id=v_task.id and status='processing' limit 1) then raise exception 'handoff_in_progress'; end if;
  update public.task_handoffs set status='cancelled',next_attempt_at=null,last_error='task_removed',updated_at=now() where task_id=v_task.id and status in ('pending','attention');
  insert into public.task_events(tenant_id,task_id,type,actor_user_id,detail) values(v_task.tenant_id,v_task.id,'task_removed',p_actor,jsonb_build_object('message','Task removed from active Northlight records.','reason',v_reason));
  update public.tasks set deleted_at=now(),deleted_by_user_id=p_actor where id=v_task.id;
  return jsonb_build_object('removed',true,'task_id',v_task.id);
end;
$$;
