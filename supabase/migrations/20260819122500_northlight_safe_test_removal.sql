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

  if v_task.dropbox_path is not null or v_task.calendar_event_id is not null then
    raise exception 'external_history';
  end if;
  if exists(select 1 from public.task_files where task_id=v_task.id limit 1)
     or exists(select 1 from public.invoices where task_id=v_task.id limit 1) then
    raise exception 'business_history';
  end if;
  if exists(select 1 from public.calendar_cleanup_queue where task_id=v_task.id limit 1)
     or exists(select 1 from public.task_events where task_id=v_task.id and type in ('assignment_email_sent','calendar_event_created','dropbox_workspace_created','calendar_event_cancelled') limit 1)
     or exists(select 1 from public.task_handoffs where task_id=v_task.id and status='done' and kind in ('dropbox','calendar','email') limit 1) then
    raise exception 'external_history';
  end if;
  if exists(select 1 from public.media_upload_sessions where task_id=v_task.id and status='uploading' limit 1) then
    raise exception 'upload_in_progress';
  end if;
  if exists(select 1 from public.task_handoffs where task_id=v_task.id and status='processing' limit 1) then
    raise exception 'handoff_in_progress';
  end if;

  update public.task_handoffs
  set status='cancelled',next_attempt_at=null,last_error='task_removed',updated_at=now()
  where task_id=v_task.id and status in ('pending','attention');

  insert into public.task_events(tenant_id,task_id,type,actor_user_id,detail)
  values(v_task.tenant_id,v_task.id,'task_removed',p_actor,jsonb_build_object('message','Task removed from active Northlight records.','reason',v_reason));

  update public.tasks
  set deleted_at=now(),deleted_by_user_id=p_actor
  where id=v_task.id;

  return jsonb_build_object('removed',true,'task_id',v_task.id);
end;
$$;
