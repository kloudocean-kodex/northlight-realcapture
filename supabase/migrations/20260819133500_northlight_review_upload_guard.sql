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
    where u.task_id=v_task.id and u.stage in ('02_EDITED','03_FINAL') and u.status in ('uploading','uploaded')
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
