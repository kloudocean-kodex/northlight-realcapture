-- Northlight stores tenant_id on every business row.  The original pilot
-- schema used independent tenant and entity foreign keys, which could permit
-- a privileged/server-side write to associate a tenant-A row with a tenant-B
-- task or user.  These composite constraints make that state unrepresentable.
--
-- Constraints are added NOT VALID first so the catalog lock is brief, then
-- validated explicitly.  Validation is intentionally fail-closed: a release
-- must stop if legacy cross-tenant data exists instead of silently accepting it.

create unique index if not exists users_tenant_id_id_uidx
  on public.users (tenant_id, id);

create unique index if not exists tasks_tenant_id_id_uidx
  on public.tasks (tenant_id, id);

create unique index if not exists media_releases_tenant_task_id_uidx
  on public.media_releases (tenant_id, task_id, id);

do $$
declare
  relation record;
  constraint_is_valid boolean;
begin
  for relation in
    select *
    from (values
      -- Application identity and task assignments.
      ('users', 'users_tenant_role_fkey', '(tenant_id, role_code)', 'roles', '(tenant_id, code)', ''),
      ('tasks', 'tasks_tenant_agent_fkey', '(tenant_id, agent_user_id)', 'users', '(tenant_id, id)', ''),
      ('tasks', 'tasks_tenant_photographer_fkey', '(tenant_id, photographer_user_id)', 'users', '(tenant_id, id)', ''),
      ('tasks', 'tasks_tenant_editor_fkey', '(tenant_id, editor_user_id)', 'users', '(tenant_id, id)', ''),
      ('tasks', 'tasks_tenant_calendar_owner_fkey', '(tenant_id, calendar_owner_user_id)', 'users', '(tenant_id, id)', ''),
      ('tasks', 'tasks_tenant_archived_by_fkey', '(tenant_id, archived_by_user_id)', 'users', '(tenant_id, id)', ''),
      ('tasks', 'tasks_tenant_deleted_by_fkey', '(tenant_id, deleted_by_user_id)', 'users', '(tenant_id, id)', ''),
      ('provider_profiles', 'provider_profiles_tenant_user_fkey', '(tenant_id, user_id)', 'users', '(tenant_id, id)', 'on delete cascade'),
      ('editor_profiles', 'editor_profiles_tenant_user_fkey', '(tenant_id, user_id)', 'users', '(tenant_id, id)', 'on delete cascade'),

      -- Task-owned workflow and audit records.
      ('task_events', 'task_events_tenant_task_fkey', '(tenant_id, task_id)', 'tasks', '(tenant_id, id)', 'on delete cascade'),
      ('task_events', 'task_events_tenant_actor_fkey', '(tenant_id, actor_user_id)', 'users', '(tenant_id, id)', ''),
      ('revisions', 'revisions_tenant_task_fkey', '(tenant_id, task_id)', 'tasks', '(tenant_id, id)', 'on delete cascade'),
      ('revisions', 'revisions_tenant_requested_by_fkey', '(tenant_id, requested_by_user_id)', 'users', '(tenant_id, id)', ''),
      ('task_comments', 'task_comments_tenant_task_fkey', '(tenant_id, task_id)', 'tasks', '(tenant_id, id)', 'on delete cascade'),
      ('task_comments', 'task_comments_tenant_author_fkey', '(tenant_id, author_user_id)', 'users', '(tenant_id, id)', ''),
      ('notification_events', 'notification_events_tenant_task_fkey', '(tenant_id, task_id)', 'tasks', '(tenant_id, id)', 'on delete cascade'),
      ('task_issues', 'task_issues_tenant_task_fkey', '(tenant_id, task_id)', 'tasks', '(tenant_id, id)', 'on delete cascade'),
      ('task_issues', 'task_issues_tenant_created_by_fkey', '(tenant_id, created_by_user_id)', 'users', '(tenant_id, id)', ''),
      ('task_issues', 'task_issues_tenant_assigned_to_fkey', '(tenant_id, assigned_to_user_id)', 'users', '(tenant_id, id)', ''),

      -- Integration, media, finance, and durable-work records.
      ('calendar_sync_state', 'calendar_sync_state_tenant_user_fkey', '(tenant_id, user_id)', 'users', '(tenant_id, id)', 'on delete cascade'),
      ('user_integrations', 'user_integrations_tenant_user_fkey', '(tenant_id, user_id)', 'users', '(tenant_id, id)', 'on delete cascade'),
      ('task_files', 'task_files_tenant_task_fkey', '(tenant_id, task_id)', 'tasks', '(tenant_id, id)', 'on delete cascade'),
      ('task_handoffs', 'task_handoffs_tenant_task_fkey', '(tenant_id, task_id)', 'tasks', '(tenant_id, id)', 'on delete cascade'),
      ('media_upload_sessions', 'media_upload_sessions_tenant_task_fkey', '(tenant_id, task_id)', 'tasks', '(tenant_id, id)', 'on delete cascade'),
      ('media_upload_sessions', 'media_upload_sessions_tenant_user_fkey', '(tenant_id, user_id)', 'users', '(tenant_id, id)', ''),
      ('calendar_cleanup_queue', 'calendar_cleanup_queue_tenant_task_fkey', '(tenant_id, task_id)', 'tasks', '(tenant_id, id)', 'on delete cascade'),
      ('calendar_cleanup_queue', 'calendar_cleanup_queue_tenant_owner_fkey', '(tenant_id, calendar_owner_user_id)', 'users', '(tenant_id, id)', ''),
      -- Physical deletion of a task with an invoice now fails closed. Northlight
      -- uses archive/soft-delete and already refuses test cleanup with finance history.
      ('invoices', 'invoices_tenant_task_fkey', '(tenant_id, task_id)', 'tasks', '(tenant_id, id)', ''),

      -- Immutable release ownership. The three-column edges prove that both the
      -- tenant and the task match, not merely the globally unique release UUID.
      ('media_releases', 'media_releases_tenant_task_fkey', '(tenant_id, task_id)', 'tasks', '(tenant_id, id)', 'on delete cascade'),
      ('media_releases', 'media_releases_tenant_created_by_fkey', '(tenant_id, created_by_user_id)', 'users', '(tenant_id, id)', ''),
      ('media_release_files', 'media_release_files_tenant_release_task_fkey', '(tenant_id, task_id, release_id)', 'media_releases', '(tenant_id, task_id, id)', 'on delete restrict'),
      ('tasks', 'tasks_tenant_approved_release_task_fkey', '(tenant_id, id, approved_release_id)', 'media_releases', '(tenant_id, task_id, id)', 'on delete restrict')
    ) as relationships(
      child_table,
      constraint_name,
      child_columns,
      parent_table,
      parent_columns,
      delete_action
    )
  loop
    if not exists (
      select 1
      from pg_catalog.pg_constraint c
      where c.conrelid = pg_catalog.to_regclass('public.' || relation.child_table)
        and c.conname = relation.constraint_name
    ) then
      execute pg_catalog.format(
        'alter table public.%I add constraint %I foreign key %s references public.%I %s %s not valid',
        relation.child_table,
        relation.constraint_name,
        relation.child_columns,
        relation.parent_table,
        relation.parent_columns,
        relation.delete_action
      );
    end if;

    select c.convalidated
      into constraint_is_valid
      from pg_catalog.pg_constraint c
     where c.conrelid = pg_catalog.to_regclass('public.' || relation.child_table)
       and c.conname = relation.constraint_name;

    if constraint_is_valid is distinct from true then
      execute pg_catalog.format(
        'alter table public.%I validate constraint %I',
        relation.child_table,
        relation.constraint_name
      );
    end if;
  end loop;
end
$$;

comment on index public.tasks_tenant_id_id_uidx is
  'Referenced by composite same-tenant foreign keys so privileged writes cannot cross tenant boundaries.';
