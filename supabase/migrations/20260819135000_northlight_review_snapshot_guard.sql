create or replace function public.northlight_finish_review_publish(p_task_id uuid,p_actor uuid,p_token text,p_published_files integer)
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
  v_final_count integer;
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
  if v_claim is null or v_claim->>'token' is distinct from p_token or v_claim->>'actor_user_id' is distinct from p_actor::text then raise exception 'review_publish_claim_lost'; end if;
  v_expected := coalesce(v_claim->'edited_files','[]'::jsonb);
  v_expected_count := jsonb_array_length(v_expected);
  if v_expected_count=0 or v_count<>v_expected_count then raise exception 'review_publish_snapshot_changed'; end if;

  select count(*) into v_final_count
  from public.task_files f
  where f.task_id=v_task.id and f.stage='03_FINAL' and f.file_type='file' and f.is_deleted=false;
  if v_final_count<>v_expected_count then raise exception 'review_publish_snapshot_changed'; end if;

  if exists(
    select 1
    from jsonb_array_elements(v_expected) e
    where not exists(
      select 1 from public.task_files f
      where f.task_id=v_task.id and f.stage='03_FINAL' and f.file_type='file' and f.is_deleted=false
        and lower(f.path)=lower(replace(e->>'path','/02_EDITED/','/03_FINAL/'))
        and lower(coalesce(f.service_code,''))=lower(coalesce(e->>'service_code',''))
        and ((e->>'content_hash') is null or coalesce(f.content_hash,'')=e->>'content_hash')
    )
  ) then raise exception 'review_publish_snapshot_changed'; end if;

  if exists(
    select 1 from unnest(coalesce(v_task.service_codes,array[]::text[])) s
    where not exists(
      select 1 from public.task_files f
      where f.task_id=v_task.id and f.stage='03_FINAL' and f.file_type='file' and f.is_deleted=false
        and lower(coalesce(f.service_code,''))=lower(s)
    )
  ) then raise exception 'final_media_missing'; end if;

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
