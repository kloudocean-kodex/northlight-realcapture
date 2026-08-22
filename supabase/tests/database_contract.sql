\set ON_ERROR_STOP on
\set ON_ERROR_STOP on

-- Run after the complete migration chain on an isolated Supabase PostgreSQL 17
-- database. This script is read-only and raises on the first failed contract.
begin;
set local statement_timeout = '2min';

do $$
begin
  if pg_catalog.current_setting('server_version_num')::integer < 170000 then
    raise exception 'database_contract: PostgreSQL 17 or newer is required';
  end if;
end
$$;

do $$
declare
  expected text := array_to_string(array[
    'public.tenants', 'public.roles', 'public.users', 'public.services',
    'public.tasks', 'public.task_events', 'public.task_files',
    'public.task_handoffs', 'public.media_upload_sessions',
    'public.media_releases', 'public.media_release_files',
    'public.calendar_cleanup_queue', 'public.integration_state',
    'public.user_integrations', 'public.oauth_authorization_states',
    'public.calendar_watch_channels', 'public.dropbox_sync_state',
    'public.auth_login_attempts', 'public.provider_profiles',
    'public.invoices'
  ]::text[], ',');
  missing text;
begin
  select pg_catalog.string_agg(name, ', ' order by name)
    into missing
  from pg_catalog.unnest(pg_catalog.string_to_array(expected, ',')) name
  where pg_catalog.to_regclass(name) is null;
  if missing is not null then
    raise exception 'database_contract: missing relations: %', missing;
  end if;
end
$$;

do $$
declare
  missing text;
begin
  select pg_catalog.string_agg(
           pg_catalog.format('%I.%I', namespace.nspname, relation.relname),
           ', ' order by namespace.nspname, relation.relname
         )
    into missing
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relkind in ('r', 'p')
    and exists (
      select 1
      from pg_catalog.pg_attribute attribute
      where attribute.attrelid = relation.oid
        and attribute.attname = 'tenant_id'
        and attribute.attnum > 0
        and not attribute.attisdropped
    )
    and not relation.relrowsecurity;
  if missing is not null then
    raise exception 'database_contract: tenant tables without RLS: %', missing;
  end if;
end
$$;

do $$
declare
  missing text;
begin
  select pg_catalog.string_agg(pilot.tablename, ', ' order by pilot.tablename)
    into missing
  from (
    select distinct policy.tablename
    from pg_catalog.pg_policies policy
    where policy.schemaname = 'public'
      and policy.policyname in ('northlight_pilot_access', 'northlight_pilot_backend')
  ) pilot
  where not exists (
    select 1
    from pg_catalog.pg_policies guard
    where guard.schemaname = 'public'
      and guard.tablename = pilot.tablename
      and guard.policyname = 'northlight_single_tenant_only'
      and guard.permissive = 'RESTRICTIVE'
  );
  if missing is not null then
    raise exception 'database_contract: pilot tables missing restrictive one-tenant policy: %', missing;
  end if;
end
$$;

do $$
declare
  unexpected text;
begin
  select pg_catalog.string_agg(table_name, ', ' order by table_name)
    into unexpected
  from pg_catalog.unnest(array[
    'organizations', 'organization_memberships', 'organization_relationships'
  ]::text[]) table_name
  where pg_catalog.has_table_privilege('anon', 'public.' || table_name, 'SELECT')
     or pg_catalog.has_table_privilege('authenticated', 'public.' || table_name, 'SELECT')
     or exists (
       select 1
       from pg_catalog.pg_policies policy
       where policy.schemaname = 'public'
         and policy.tablename = table_name
         and policy.roles && array['anon', 'authenticated']::name[]
         and (
           policy.permissive <> 'RESTRICTIVE'
           or policy.policyname <> 'northlight_single_tenant_only'
         )
     );
  if unexpected is not null then
    raise exception 'database_contract: organization foundation exposed before org authorization: %', unexpected;
  end if;
end
$$;

do $$
declare
  expected text[] := array[
    'users_tenant_role_fkey',
    'tasks_tenant_agent_fkey',
    'tasks_tenant_photographer_fkey',
    'tasks_tenant_editor_fkey',
    'tasks_tenant_calendar_owner_fkey',
    'tasks_tenant_archived_by_fkey',
    'tasks_tenant_deleted_by_fkey',
    'provider_profiles_tenant_user_fkey',
    'editor_profiles_tenant_user_fkey',
    'task_events_tenant_task_fkey',
    'task_events_tenant_actor_fkey',
    'revisions_tenant_task_fkey',
    'revisions_tenant_requested_by_fkey',
    'task_comments_tenant_task_fkey',
    'task_comments_tenant_author_fkey',
    'notification_events_tenant_task_fkey',
    'task_issues_tenant_task_fkey',
    'task_issues_tenant_created_by_fkey',
    'task_issues_tenant_assigned_to_fkey',
    'calendar_sync_state_tenant_user_fkey',
    'user_integrations_tenant_user_fkey',
    'task_files_tenant_task_fkey',
    'task_handoffs_tenant_task_fkey',
    'media_upload_sessions_tenant_task_fkey',
    'media_upload_sessions_tenant_user_fkey',
    'calendar_cleanup_queue_tenant_task_fkey',
    'calendar_cleanup_queue_tenant_owner_fkey',
    'invoices_tenant_task_fkey',
    'media_releases_tenant_task_fkey',
    'media_releases_tenant_created_by_fkey',
    'media_release_files_tenant_release_task_fkey',
    'tasks_tenant_approved_release_task_fkey',
    'oauth_authorization_states_tenant_actor_fkey',
    'calendar_watch_channels_scope_fkey',
    'calendar_watch_channels_tenant_user_fkey',
    'provider_profiles_tenant_availability_updater_fkey'
  ];
  missing text;
begin
  select pg_catalog.string_agg(name, ', ' order by name)
    into missing
  from pg_catalog.unnest(expected) name
  where not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conname = name
      and constraint_row.contype = 'f'
      and constraint_row.convalidated
  );
  if missing is not null then
    raise exception 'database_contract: missing or unvalidated same-tenant constraints: %', missing;
  end if;
end
$$;

do $$
declare
  begin_rpc oid := pg_catalog.to_regprocedure(
    'public.northlight_begin_oauth_state(uuid,text,uuid,text,text,text,timestamp with time zone)'
  );
  consume_rpc oid := pg_catalog.to_regprocedure(
    'public.northlight_consume_oauth_state(uuid,text,uuid,text)'
  );
  pending_index record;
begin
  if pg_catalog.has_table_privilege('anon', 'public.oauth_authorization_states', 'SELECT')
     or pg_catalog.has_table_privilege('anon', 'public.oauth_authorization_states', 'INSERT')
     or pg_catalog.has_table_privilege('authenticated', 'public.oauth_authorization_states', 'SELECT')
     or exists (
       select 1
       from pg_catalog.pg_policies policy
       where policy.schemaname = 'public'
         and policy.tablename = 'oauth_authorization_states'
     ) then
    raise exception 'database_contract: OAuth authorization state table is directly exposed';
  end if;

  if begin_rpc is null or consume_rpc is null
     or not pg_catalog.has_function_privilege('anon', begin_rpc, 'EXECUTE')
     or not pg_catalog.has_function_privilege('anon', consume_rpc, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', begin_rpc, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', consume_rpc, 'EXECUTE') then
    raise exception 'database_contract: OAuth authorization state RPC ACL is incorrect';
  end if;

  select index_row.indisunique,
         pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid) as predicate
    into pending_index
  from pg_catalog.pg_index index_row
  join pg_catalog.pg_class index_relation on index_relation.oid = index_row.indexrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = index_relation.relnamespace
  where namespace.nspname = 'public'
    and index_relation.relname = 'oauth_authorization_states_one_pending_idx';
  if not found
     or not pending_index.indisunique
     or pending_index.predicate not ilike '%consumed_at IS NULL%' then
    raise exception 'database_contract: OAuth one-pending-state index is absent or malformed';
  end if;
end
$$;

do $$
declare
  invalid text;
begin
  select pg_catalog.string_agg(
           pg_catalog.format('%I.%I', relation.relname, constraint_row.conname),
           ', ' order by relation.relname, constraint_row.conname
         )
    into invalid
  from pg_catalog.pg_constraint constraint_row
  join pg_catalog.pg_class relation on relation.oid = constraint_row.conrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and constraint_row.conname like 'northlight_%'
    and constraint_row.contype in ('c', 'f', 'x')
    and not constraint_row.convalidated;
  if invalid is not null then
    raise exception 'database_contract: unvalidated Northlight constraints: %', invalid;
  end if;
end
$$;

do $$
declare
  provider_index record;
  schedule_predicate text;
begin
  select index_row.indisunique,
         pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid) as predicate
    into provider_index
  from pg_catalog.pg_index index_row
  join pg_catalog.pg_class index_relation on index_relation.oid = index_row.indexrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = index_relation.relnamespace
  where namespace.nspname = 'public'
    and index_relation.relname = 'task_files_active_provider_file_uidx';
  if not found or not provider_index.indisunique
     or provider_index.predicate not ilike '%provider_file_id IS NOT NULL%'
     or provider_index.predicate not ilike '%is_deleted = false%' then
    raise exception 'database_contract: active provider-file unique index is absent or malformed';
  end if;

  select pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid)
    into schedule_predicate
  from pg_catalog.pg_constraint constraint_row
  join pg_catalog.pg_index index_row on index_row.indexrelid = constraint_row.conindid
  where constraint_row.conrelid = 'public.tasks'::regclass
    and constraint_row.conname = 'northlight_tasks_photographer_no_overlap'
    and constraint_row.contype = 'x';
  if schedule_predicate is null
     or schedule_predicate not ilike '%declined%'
     or schedule_predicate not ilike '%cancelled%'
     or schedule_predicate not ilike '%delivered%' then
    raise exception 'database_contract: scheduling exclusion predicate does not release all closed/declined slots';
  end if;
end
$$;

do $$
declare
  duplicate_count integer;
begin
  select pg_catalog.count(*)::integer
    into duplicate_count
  from pg_catalog.pg_index index_row
  join pg_catalog.pg_class relation on relation.oid = index_row.indrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relname = 'tasks'
    and index_row.indisunique
    and pg_catalog.pg_get_indexdef(index_row.indexrelid) ilike '%(tenant_id, idempotency_key)%'
    and pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid) ilike '%idempotency_key IS NOT NULL%';
  if duplicate_count <> 1 then
    raise exception 'database_contract: expected one canonical task idempotency index, found %', duplicate_count;
  end if;
end
$$;

do $$
declare
  unsafe text;
begin
  select pg_catalog.string_agg(
           namespace.nspname || '.' || routine.proname || '(' ||
             pg_catalog.pg_get_function_identity_arguments(routine.oid) || ')',
           ', ' order by namespace.nspname, routine.proname
         )
    into unsafe
  from pg_catalog.pg_proc routine
  join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
  where namespace.nspname in ('public', 'northlight_private')
    and (namespace.nspname = 'northlight_private' or routine.proname like 'northlight_%')
    and routine.prosecdef
    and (
      not exists (
        select 1
        from pg_catalog.unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting like 'search_path=%'
      )
      or exists (
        select 1
        from pg_catalog.unnest(coalesce(routine.proconfig, array[]::text[])) setting
        where setting like 'search_path=%'
          and (setting ilike '%public%' or setting ilike '%pg_temp%')
      )
      or exists (
        select 1
        from pg_catalog.aclexplode(
          coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
        ) privilege
        where privilege.grantee = 0
          and privilege.privilege_type = 'EXECUTE'
      )
    );
  if unsafe is not null then
    raise exception 'database_contract: unsafe SECURITY DEFINER configuration: %', unsafe;
  end if;
end
$$;

do $$
declare
  rpc oid := pg_catalog.to_regprocedure(
    'public.northlight_finalize_upload_index(uuid,uuid,uuid,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone)'
  );
begin
  if rpc is null then
    raise exception 'database_contract: atomic upload completion RPC is missing';
  end if;
  if not (
    select routine.prosecdef
    from pg_catalog.pg_proc routine
    where routine.oid = rpc
  ) then
    raise exception 'database_contract: atomic upload completion RPC is not SECURITY DEFINER';
  end if;
  if not pg_catalog.has_function_privilege('anon', rpc, 'EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated', rpc, 'EXECUTE') then
    raise exception 'database_contract: atomic upload completion RPC lacks explicit API grants';
  end if;
end
$$;

do $$
declare
  invalid text;
begin
  select pg_catalog.string_agg(constraint_name, ', ' order by constraint_name)
    into invalid
  from pg_catalog.unnest(array[
    'task_handoffs_dispatch_lease_pair_check',
    'task_handoffs_provider_receipt_object_check',
    'calendar_cleanup_dispatch_lease_pair_check',
    'calendar_cleanup_provider_receipt_object_check',
    'integration_state_refresh_generation_check',
    'integration_state_refresh_lease_pair_check',
    'user_integrations_refresh_generation_check',
    'user_integrations_refresh_lease_pair_check',
    'media_upload_sessions_uploaded_within_size_check',
    'media_upload_sessions_provider_receipt_object_check',
    'media_releases_approval_state_check',
    'media_release_files_receipt_hashes_check',
    'invoices_xero_creation_intent_check'
  ]::text[]) constraint_name
  where not exists (
    select 1
    from pg_catalog.pg_constraint constraint_row
    where constraint_row.conname = constraint_name
      and constraint_row.convalidated
  );
  if invalid is not null then
    raise exception 'database_contract: missing/unvalidated lifecycle constraints: %', invalid;
  end if;

  if exists (
    select 1
    from pg_catalog.pg_attribute attribute
    where attribute.attrelid = 'public.user_integrations'::regclass
      and attribute.attname = 'user_id'
      and not attribute.attnotnull
  ) then
    raise exception 'database_contract: user_integrations.user_id must be NOT NULL';
  end if;
end
$$;

do $$
declare
  trigger_definition text;
begin
  select pg_catalog.pg_get_triggerdef(trigger_row.oid)
    into trigger_definition
  from pg_catalog.pg_trigger trigger_row
  where trigger_row.tgrelid = 'public.media_releases'::regclass
    and trigger_row.tgname = 'northlight_protect_media_release_row'
    and not trigger_row.tgisinternal;
  if trigger_definition is null
     or trigger_definition not ilike '%INSERT%'
     or trigger_definition not ilike '%UPDATE%'
     or trigger_definition not ilike '%DELETE%' then
    raise exception 'database_contract: immutable release trigger does not cover insert/update/delete';
  end if;
end
$$;

do $$
declare
  guard oid := pg_catalog.to_regprocedure(
    'northlight_private.northlight_data_api_guard()'
  );
  auth_config text;
begin
  if guard is null
     or not pg_catalog.has_function_privilege('authenticator', guard, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', guard, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', guard, 'EXECUTE') then
    raise exception 'database_contract: PostgREST request guard ACL is incorrect';
  end if;

  select pg_catalog.array_to_string(role_row.rolconfig, ',')
    into auth_config
  from pg_catalog.pg_roles role_row
  where role_row.rolname = 'authenticator';
  if auth_config is null
     or auth_config not like '%pgrst.db_pre_request=northlight_private.northlight_data_api_guard%' then
    raise exception 'database_contract: PostgREST pre-request guard is not registered';
  end if;
end
$$;

do $$
declare
  default_function_acl oid;
begin
  select default_acl.oid
    into default_function_acl
  from pg_catalog.pg_default_acl default_acl
  join pg_catalog.pg_roles owner_role on owner_role.oid = default_acl.defaclrole
  where owner_role.rolname = 'postgres'
    and default_acl.defaclnamespace = 'public'::regnamespace
    and default_acl.defaclobjtype = 'f';
  if default_function_acl is null or exists (
    select 1
    from pg_catalog.pg_default_acl default_acl
    cross join lateral pg_catalog.aclexplode(default_acl.defaclacl) privilege
    where default_acl.oid = default_function_acl
      and privilege.grantee = 0
      and privilege.privilege_type = 'EXECUTE'
  ) then
    raise exception 'database_contract: future public functions are not deny-by-default';
  end if;
end
$$;

do $$
declare
  signature text;
  routine oid;
begin
  foreach signature in array array[
    'public.northlight_claim_dropbox_sync(uuid,text,uuid,integer)',
    'public.northlight_advance_dropbox_sync(uuid,text,uuid,bigint,text,text,timestamp with time zone,timestamp with time zone,jsonb,integer)',
    'public.northlight_finish_dropbox_sync(uuid,text,uuid,bigint,text)',
    'public.northlight_apply_dropbox_sync_batch(uuid,uuid,bigint,jsonb)',
    'public.northlight_claim_calendar_sync(uuid,uuid,text,uuid,integer)',
    'public.northlight_advance_calendar_sync(uuid,uuid,text,uuid,bigint,text,text,text,timestamp with time zone,text,integer)',
    'public.northlight_finish_calendar_sync(uuid,uuid,text,uuid,bigint,text)',
    'public.northlight_claim_calendar_watch(uuid,uuid,text,uuid,text,text,integer)',
    'public.northlight_activate_calendar_watch(uuid,uuid,text,uuid,bigint,text,text,timestamp with time zone)',
    'public.northlight_fail_calendar_watch(uuid,uuid,text,uuid,bigint,text,text)',
    'public.northlight_read_calendar_watch_channel(uuid,text,text,text)',
    'public.northlight_stop_calendar_watch_channel(uuid,uuid,text,text)',
    'public.northlight_disconnect_calendar_watch(uuid,uuid,text,bigint)',
    'public.northlight_finish_user_integration_refresh(uuid,uuid,text,uuid,bigint,jsonb)',
    'public.northlight_list_calendar_maintenance(uuid,integer,timestamp with time zone)',
    'public.northlight_begin_login_attempt(text,integer,integer,integer)',
    'public.northlight_reset_login_attempt(text)',
    'public.northlight_complete_password_migration(uuid,uuid,text,text)',
    'public.northlight_update_provider_availability(uuid,uuid,uuid,bigint,jsonb,jsonb,jsonb,text)',
    'public.northlight_photographer_onboarding_status(uuid,uuid)'
  ]::text[]
  loop
    routine := pg_catalog.to_regprocedure(signature);
    if routine is null
       or not pg_catalog.has_function_privilege('anon', routine, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', routine, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', routine, 'EXECUTE') then
      raise exception 'database_contract: guarded Worker RPC ACL is incorrect: %', signature;
    end if;
  end loop;
end
$$;

do $$
declare
  dropbox_definition text := pg_catalog.pg_get_functiondef(
    'public.northlight_apply_dropbox_sync_batch(uuid,uuid,bigint,jsonb)'::pg_catalog.regprocedure
  );
  refresh_definition text := pg_catalog.pg_get_functiondef(
    'public.northlight_finish_user_integration_refresh(uuid,uuid,text,uuid,bigint,jsonb)'::pg_catalog.regprocedure
  );
  maintenance_definition text := pg_catalog.pg_get_functiondef(
    'public.northlight_list_calendar_maintenance(uuid,integer,timestamp with time zone)'::pg_catalog.regprocedure
  );
begin
  if pg_catalog.strpos(dropbox_definition, 'limit 201') = 0
     or pg_catalog.strpos(dropbox_definition, 'dropbox_sync_page_order') = 0
     or pg_catalog.strpos(dropbox_definition, 'prefix_has_more') = 0 then
    raise exception 'database_contract: Dropbox recursive delete is not bounded/replay-fenced';
  end if;
  if pg_catalog.strpos(refresh_definition, 'calendar_sync_state') = 0
     or pg_catalog.strpos(refresh_definition, 'calendar_watch_channels') = 0
     or pg_catalog.strpos(refresh_definition, 'connection_generation = p_generation') = 0 then
    raise exception 'database_contract: routine Google refresh does not preserve Calendar generation invariants';
  end if;
  if pg_catalog.strpos(maintenance_definition, 'interval ''30 hours''') = 0
     or pg_catalog.strpos(maintenance_definition, 'sync_due') = 0
     or pg_catalog.strpos(maintenance_definition, 'limit v_limit') = 0 then
    raise exception 'database_contract: Calendar maintenance listing is not bounded or complete';
  end if;
end
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'oauth_authorization_states',
    'calendar_watch_channels',
    'auth_login_attempts'
  ]::text[]
  loop
    if pg_catalog.has_table_privilege('anon', 'public.' || table_name, 'SELECT')
       or pg_catalog.has_table_privilege('anon', 'public.' || table_name, 'INSERT')
       or pg_catalog.has_table_privilege('anon', 'public.' || table_name, 'UPDATE')
       or pg_catalog.has_table_privilege('anon', 'public.' || table_name, 'DELETE')
       or pg_catalog.has_table_privilege('authenticated', 'public.' || table_name, 'SELECT')
       or exists (
         select 1 from pg_catalog.pg_policies policy
          where policy.schemaname = 'public' and policy.tablename = table_name
       ) then
      raise exception 'database_contract: server-only table is exposed: %', table_name;
    end if;
  end loop;
end
$$;

do $$
declare
  missing text;
begin
  select pg_catalog.string_agg(name, ', ' order by name)
    into missing
  from pg_catalog.unnest(array[
    'dropbox_sync_state_generation_check',
    'dropbox_sync_state_lease_pair_check',
    'calendar_sync_state_generations_check',
    'calendar_sync_state_sync_lease_pair_check',
    'calendar_sync_state_watch_lease_pair_check',
    'calendar_watch_channels_lifecycle_check',
    'auth_login_attempts_key_check',
    'auth_login_attempts_count_check',
    'users_credential_version_check',
    'users_legacy_credential_requires_change_check',
    'provider_profiles_availability_version_check',
    'provider_profiles_availability_json_check'
  ]::text[]) name
  where not exists (
    select 1 from pg_catalog.pg_constraint constraint_row
     where constraint_row.conname = name and constraint_row.convalidated
  );
  if missing is not null then
    raise exception 'database_contract: missing/unvalidated concurrency or onboarding constraints: %', missing;
  end if;

  if not exists (
    select 1 from pg_catalog.pg_attribute attribute
     where attribute.attrelid = 'public.users'::pg_catalog.regclass
       and attribute.attname = 'auth_must_change_password'
       and attribute.attnotnull
  ) or not exists (
    select 1 from pg_catalog.pg_attribute attribute
     where attribute.attrelid = 'public.provider_profiles'::pg_catalog.regclass
       and attribute.attname = 'availability_version'
       and attribute.attnotnull
  ) then
    raise exception 'database_contract: credential or availability version columns are not mandatory';
  end if;
end
$$;

do $$
declare violations bigint;
begin
  select pg_catalog.count(*) into violations
    from public.users user_row
   where user_row.password_hash ~ '^scrypt\$'
     and not user_row.auth_must_change_password;
  if violations <> 0 then
    raise exception 'database_contract: legacy credential escaped mandatory migration: %', violations;
  end if;

  select pg_catalog.count(*) into violations
    from public.provider_profiles profile
   where pg_catalog.jsonb_typeof(profile.working_hours) <> 'object'
      or pg_catalog.jsonb_typeof(profile.days_off) <> 'array'
      or pg_catalog.jsonb_typeof(profile.special_days) <> 'array'
      or not exists (
        select 1 from pg_catalog.pg_timezone_names timezone_row
         where timezone_row.name = profile.timezone
      );
  if violations <> 0 then
    raise exception 'database_contract: invalid saved Photographer availability rows: %', violations;
  end if;
end
$$;

-- The Photographer availability functions must use PostgreSQL-17-supported
-- JSONB object-key semantics. jsonb_object_length(jsonb) does not exist.
do $$
declare
  validator_def text;
  bookability_def text;
begin
  validator_def := pg_catalog.pg_get_functiondef(
    'public.northlight_validate_provider_availability_row()'::pg_catalog.regprocedure
  );
  bookability_def := pg_catalog.pg_get_functiondef(
    'northlight_private.photographer_bookability(uuid,uuid)'::pg_catalog.regprocedure
  );
  if validator_def ilike '%jsonb_object_length%'
     or bookability_def ilike '%jsonb_object_length%'
     or validator_def not ilike '%jsonb_object_keys%'
     or bookability_def not ilike '%jsonb_object_keys%' then
    raise exception 'database_contract: Photographer availability JSONB object-key implementation is not PostgreSQL-17 compatible';
  end if;
end
$$;

-- Validated composite foreign keys make these states impossible, but retain a
-- direct data assertion so a future migration cannot silently drop the edges.
do $$
declare
  violations bigint;
begin
  select pg_catalog.sum(count_value)
    into violations
  from (
    select pg_catalog.count(*) count_value
    from public.tasks task_row
    join public.users actor on actor.id in (
      task_row.agent_user_id,
      task_row.photographer_user_id,
      task_row.editor_user_id,
      task_row.calendar_owner_user_id
    )
    where actor.tenant_id <> task_row.tenant_id
    union all
    select pg_catalog.count(*)
    from public.task_files file_row
    join public.tasks task_row on task_row.id = file_row.task_id
    where task_row.tenant_id <> file_row.tenant_id
    union all
    select pg_catalog.count(*)
    from public.media_upload_sessions upload_row
    join public.tasks task_row on task_row.id = upload_row.task_id
    join public.users actor on actor.id = upload_row.user_id
    where task_row.tenant_id <> upload_row.tenant_id
       or actor.tenant_id <> upload_row.tenant_id
    union all
    select pg_catalog.count(*)
    from public.media_release_files file_row
    join public.media_releases release_row on release_row.id = file_row.release_id
    where release_row.tenant_id <> file_row.tenant_id
       or release_row.task_id <> file_row.task_id
    union all
    select pg_catalog.count(*)
    from public.invoices invoice_row
    join public.tasks task_row on task_row.id = invoice_row.task_id
    where task_row.tenant_id <> invoice_row.tenant_id
  ) counts;
  if violations <> 0 then
    raise exception 'database_contract: cross-tenant rows detected: %', violations;
  end if;
end
$$;

rollback;
