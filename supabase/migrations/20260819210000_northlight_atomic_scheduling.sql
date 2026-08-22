-- Scheduling truth belongs in PostgreSQL so concurrent API requests cannot both
-- reserve overlapping protected time. btree_gist is a trusted PostgreSQL
-- extension and is created without a pinned version for hosted Supabase.
create extension if not exists btree_gist;

create or replace function public.northlight_schedule_buffer_minutes(p_metadata jsonb, p_key text)
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when coalesce(p_metadata ->> p_key, '') ~ '^[0-9]{1,4}$'
      then least(1440, (p_metadata ->> p_key)::integer)
    else 0
  end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tasks'::regclass
      and conname = 'northlight_tasks_schedule_order_check'
  ) then
    alter table public.tasks
      add constraint northlight_tasks_schedule_order_check
      check (scheduled_start is null or scheduled_end is null or scheduled_end > scheduled_start)
      not valid;
  end if;
end
$$;

alter table public.tasks validate constraint northlight_tasks_schedule_order_check;

-- The API idempotency key must be a database fact, not a read-before-write
-- convention. A partial index preserves legacy rows where the key is null.
create unique index if not exists tasks_tenant_idempotency_key_uq
  on public.tasks (tenant_id, idempotency_key)
  where idempotency_key is not null;

-- Repair any task that an older Calendar webhook already pushed backwards out
-- of post-production. The repair is narrow, keeps the booked timestamps, and
-- records an immutable task event for operators.
do $$
declare
  v_task public.tasks%rowtype;
  v_previous text;
  v_next text;
begin
  for v_task in
    select * from public.tasks
    where status = 'reschedule_requested'
      and metadata ->> 'external_calendar_previous_status' in
        ('shoot_complete', 'raw_received', 'editing', 'review', 'revision')
      and deleted_at is null
    for update
  loop
    v_previous := v_task.metadata ->> 'external_calendar_previous_status';
    v_next := case v_previous
      when 'shoot_complete' then 'Source media needs to be uploaded and handed to editing.'
      when 'raw_received' then case when v_task.editor_user_id is null
        then 'Management needs to assign an Editor.'
        else 'Editor needs to begin post-production.' end
      when 'editing' then 'Editing is in progress.'
      when 'review' then 'Edited media is waiting for approval.'
      when 'revision' then 'Editor needs to complete the requested revision.'
    end;

    update public.tasks
    set status = v_previous,
        next_action = v_next,
        metadata = coalesce(metadata, '{}'::jsonb)
          - 'external_calendar_previous_status'
          - 'external_calendar_cancelled'
          - 'external_calendar_changed_at'
          - 'external_calendar_event_id'
          - 'external_calendar_html_link'
          - 'external_calendar_proposed_schedule'
          - 'external_calendar_etag'
          - 'external_calendar_changed_fields'
          - 'external_calendar_reason'
    where id = v_task.id;

    insert into public.task_events (tenant_id, task_id, type, actor_user_id, detail)
    values (
      v_task.tenant_id,
      v_task.id,
      'calendar_post_shoot_state_repaired',
      null,
      jsonb_build_object(
        'message', 'Post-production state restored after an obsolete Calendar scheduling review.',
        'restored_status', v_previous
      )
    );
  end loop;
end
$$;

create or replace function public.northlight_select_editor(
  p_tenant_id uuid,
  p_service_codes text[]
)
returns uuid
language sql
stable
security invoker
set search_path = public
as $$
  select profile.user_id
  from public.editor_profiles profile
  join public.users editor
    on editor.id = profile.user_id
   and editor.tenant_id = p_tenant_id
   and editor.role_code = 'editor'
   and editor.active = true
  where profile.tenant_id = p_tenant_id
    and coalesce(cardinality(p_service_codes), 0) > 0
    and not exists (
      select 1
      from unnest(coalesce(p_service_codes, array[]::text[])) requested(service_code)
      where not exists (
        select 1
        from unnest(coalesce(profile.skills, array[]::text[])) skill(service_code)
        where lower(skill.service_code) = lower(requested.service_code)
      )
    )
  order by (
    select count(*)
    from public.tasks work
    where work.tenant_id = p_tenant_id
      and work.editor_user_id = profile.user_id
      and work.deleted_at is null
      and work.archived_at is null
      and work.status in ('raw_received', 'editing', 'review', 'revision')
  ), profile.user_id
  limit 1
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tasks'::regclass
      and conname = 'northlight_tasks_photographer_no_overlap'
  ) then
    alter table public.tasks
      add constraint northlight_tasks_photographer_no_overlap
      exclude using gist (
        tenant_id with =,
        photographer_user_id with =,
        tstzrange(
          pg_catalog.timezone(
            'UTC',
            pg_catalog.timezone('UTC', scheduled_start)
              - pg_catalog.make_interval(mins => public.northlight_schedule_buffer_minutes(metadata, 'buffer_before_min'))
          ),
          pg_catalog.timezone(
            'UTC',
            pg_catalog.timezone('UTC', scheduled_end)
              + pg_catalog.make_interval(mins => public.northlight_schedule_buffer_minutes(metadata, 'buffer_after_min'))
          ),
          '[)'
        ) with &&
      )
      where (
        photographer_user_id is not null
        and scheduled_start is not null
        and scheduled_end is not null
        and deleted_at is null
        and archived_at is null
        and status not in ('cancelled', 'delivered')
      );
  end if;
end
$$;

create or replace function public.northlight_create_booking(
  p_tenant_id uuid,
  p_actor uuid,
  p_task_no text,
  p_idempotency_key text,
  p_property_name text,
  p_address text,
  p_suburb text,
  p_area text,
  p_agent_user_id uuid,
  p_photographer_user_id uuid,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_service_codes text[],
  p_notes text,
  p_metadata jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_actor public.users%rowtype;
  v_agent public.users%rowtype;
  v_photographer public.users%rowtype;
  v_task public.tasks%rowtype;
  v_created boolean := false;
begin
  select * into v_actor
  from public.users
  where id = p_actor and tenant_id = p_tenant_id and active = true;
  if not found or v_actor.role_code not in ('admin', 'owner', 'agent') then
    raise exception 'permission_denied';
  end if;

  select * into v_agent
  from public.users
  where id = p_agent_user_id and tenant_id = p_tenant_id and active = true and role_code = 'agent';
  if not found or (v_actor.role_code = 'agent' and v_agent.id <> v_actor.id) then
    raise exception 'invalid_agent';
  end if;

  select * into v_photographer
  from public.users
  where id = p_photographer_user_id and tenant_id = p_tenant_id and active = true and role_code = 'photographer';
  if not found then raise exception 'invalid_photographer'; end if;

  if nullif(trim(p_task_no), '') is null
    or nullif(trim(p_idempotency_key), '') is null
    or nullif(trim(p_property_name), '') is null
    or nullif(trim(p_address), '') is null
    or nullif(trim(p_suburb), '') is null
    or nullif(trim(p_area), '') is null
    or coalesce(cardinality(p_service_codes), 0) = 0
    or p_scheduled_start is null
    or p_scheduled_end is null
    or p_scheduled_end <= p_scheduled_start then
    raise exception 'invalid_booking';
  end if;

  select * into v_task
  from public.tasks
  where tenant_id = p_tenant_id
    and idempotency_key = left(trim(p_idempotency_key), 120)
    and deleted_at is null
  for update;

  if found then
    if v_actor.role_code = 'agent' and v_task.agent_user_id <> v_actor.id then
      raise exception 'permission_denied';
    end if;
  else
    begin
      insert into public.tasks (
        tenant_id,
        task_no,
        idempotency_key,
        property_name,
        address,
        suburb,
        area,
        priority,
        status,
        agent_user_id,
        photographer_user_id,
        calendar_owner_user_id,
        scheduled_start,
        scheduled_end,
        service_codes,
        notes,
        next_action,
        metadata
      ) values (
        p_tenant_id,
        trim(p_task_no),
        left(trim(p_idempotency_key), 120),
        trim(p_property_name),
        trim(p_address),
        trim(p_suburb),
        trim(p_area),
        'standard',
        'assigned',
        p_agent_user_id,
        p_photographer_user_id,
        p_photographer_user_id,
        p_scheduled_start,
        p_scheduled_end,
        p_service_codes,
        nullif(trim(coalesce(p_notes, '')), ''),
        'Photographer needs to confirm the booking.',
        coalesce(p_metadata, '{}'::jsonb)
      )
      returning * into v_task;
      v_created := true;
    exception when unique_violation then
      select * into v_task
      from public.tasks
      where tenant_id = p_tenant_id
        and idempotency_key = left(trim(p_idempotency_key), 120)
        and deleted_at is null
      for update;
      if not found then raise; end if;
      if v_actor.role_code = 'agent' and v_task.agent_user_id <> v_actor.id then
        raise exception 'permission_denied';
      end if;
    end;
  end if;

  insert into public.task_handoffs (
    tenant_id, task_id, kind, status, attempts, next_attempt_at,
    last_attempt_at, last_error, payload, updated_at
  )
  select v_task.tenant_id, v_task.id, kind, 'pending', 0, null, null, null, '{}'::jsonb, now()
  from unnest(array['dropbox', 'calendar', 'email']::text[]) kind
  on conflict (task_id, kind) do nothing;

  if v_created then
    insert into public.task_events (tenant_id, task_id, type, actor_user_id, detail)
    values (
      v_task.tenant_id,
      v_task.id,
      'task_created',
      p_actor,
      jsonb_build_object('message', 'Task created and Photographer assigned.')
    );
  end if;

  return jsonb_build_object('task', to_jsonb(v_task), 'reused', not v_created);
end
$$;

-- Preserve the exact local wall time and UTC offset on every reschedule while
-- retaining the existing compare-and-set workflow contract.
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
  v_timezone text;
  v_local_start text;
  v_offset_minutes integer;
begin
  select role_code into v_actor_role
  from public.users
  where id = p_actor and active = true;
  if v_actor_role is null then raise exception 'permission_denied'; end if;

  select * into v_task
  from public.tasks
  where id = p_task_id and deleted_at is null
  for update;
  if not found then raise exception 'task_not_found'; end if;
  if v_task.archived_at is not null then raise exception 'task_archived'; end if;
  if not (
    v_actor_role in ('admin', 'owner')
    or (v_actor_role = 'agent' and v_task.agent_user_id = p_actor)
    or (v_actor_role = 'photographer' and v_task.photographer_user_id = p_actor)
  ) then raise exception 'permission_denied'; end if;
  if p_expected_status not in ('assigned', 'confirmed', 'reschedule_requested')
    or p_new_status not in ('assigned', 'confirmed', 'reschedule_requested') then
    raise exception 'invalid_schedule_state';
  end if;
  if v_task.photographer_user_id is distinct from p_expected_photographer
    or v_task.status is distinct from p_expected_status
    or v_task.scheduled_start is distinct from p_expected_start
    or v_task.scheduled_end is distinct from p_expected_end
    or v_task.calendar_event_id is distinct from p_expected_calendar_event_id then
    raise exception 'task_changed';
  end if;
  if p_new_start is null or p_new_end is null or p_new_end <= p_new_start then
    raise exception 'invalid_schedule';
  end if;

  select name into v_timezone
  from pg_timezone_names
  where name = coalesce(v_task.metadata ->> 'timezone', 'Australia/Melbourne')
  limit 1;
  v_timezone := coalesce(v_timezone, 'Australia/Melbourne');
  v_local_start := to_char(p_new_start at time zone v_timezone, 'YYYY-MM-DD"T"HH24:MI');
  v_offset_minutes := extract(epoch from (
    (p_new_start at time zone v_timezone) - (p_new_start at time zone 'UTC')
  ))::integer / 60;

  v_meta := coalesce(v_task.metadata, '{}'::jsonb)
    - 'external_calendar_previous_status'
    - 'external_calendar_cancelled'
    - 'external_calendar_changed_at'
    - 'external_calendar_event_id'
    - 'external_calendar_html_link'
    - 'external_calendar_proposed_schedule'
    - 'external_calendar_etag'
    - 'external_calendar_changed_fields'
    - 'external_calendar_reason';
  v_meta := v_meta || jsonb_build_object(
    'last_schedule_change_by', p_actor,
    'last_schedule_change_at', now(),
    'timezone', v_timezone,
    'local_scheduled_start', v_local_start,
    'utc_offset_minutes', v_offset_minutes,
    'time_disambiguation', null,
    'buffer_before_min', greatest(0, coalesce(p_buffer_before, 0)),
    'buffer_after_min', greatest(0, coalesce(p_buffer_after, 0))
  );

  update public.tasks
  set scheduled_start = p_new_start,
      scheduled_end = p_new_end,
      status = p_new_status,
      next_action = p_next_action,
      metadata = v_meta
  where id = v_task.id;

  insert into public.task_handoffs (
    tenant_id, task_id, kind, status, attempts, next_attempt_at,
    last_attempt_at, last_error, payload, updated_at
  ) values (
    v_task.tenant_id, v_task.id, 'calendar', 'pending', 0,
    null, null, null, '{}'::jsonb, now()
  )
  on conflict (task_id, kind) do update
  set status = 'pending', attempts = 0, next_attempt_at = null,
      last_attempt_at = null, last_error = null, payload = '{}'::jsonb,
      updated_at = now();

  insert into public.task_events (tenant_id, task_id, type, actor_user_id, detail)
  values (
    v_task.tenant_id,
    v_task.id,
    'schedule_changed',
    p_actor,
    jsonb_build_object(
      'message', case when p_external_review
        then 'External Calendar change reviewed and booking rescheduled in Northlight.'
        else 'Shoot schedule changed in Northlight.' end,
      'from', jsonb_build_object('start', v_task.scheduled_start, 'end', v_task.scheduled_end),
      'to', jsonb_build_object(
        'start', p_new_start,
        'end', p_new_end,
        'local_start', v_local_start,
        'timezone', v_timezone,
        'utc_offset_minutes', v_offset_minutes
      ),
      'restored_status', p_new_status
    )
  );
  return jsonb_build_object(
    'status', p_new_status,
    'calendar_needs_sync', true,
    'local_start', v_local_start,
    'timezone', v_timezone,
    'utc_offset_minutes', v_offset_minutes
  );
end
$$;
