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

  insert into public.task_handoffs(tenant_id,task_id,kind,status,attempts,next_attempt_at,last_attempt_at,last_error,payload,updated_at)
  values(v_task.tenant_id,v_task.id,'calendar','pending',0,null,null,null,'{}'::jsonb,now())
  on conflict(task_id,kind) do update
  set status='pending',attempts=0,next_attempt_at=null,last_attempt_at=null,last_error=null,payload='{}'::jsonb,updated_at=now();

  insert into public.task_events(tenant_id,task_id,type,actor_user_id,detail)
  values(v_task.tenant_id,v_task.id,'schedule_changed',p_actor,jsonb_build_object(
    'message',case when p_external_review then 'External Calendar change reviewed and booking rescheduled in Northlight.' else 'Shoot schedule changed in Northlight.' end,
    'from',jsonb_build_object('start',v_task.scheduled_start,'end',v_task.scheduled_end),
    'to',jsonb_build_object('start',p_new_start,'end',p_new_end),
    'restored_status',p_new_status
  ));
  return jsonb_build_object('status',p_new_status,'calendar_needs_sync',true);
end;
$$;
