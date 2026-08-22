-- Security and lifecycle corrections found while independently auditing the
-- saved RC migration chain. This file is staged only: it must be replayed on a
-- disposable Supabase database and pass the database contract before release.

set lock_timeout = '5s';
set statement_timeout = '5min';

-- A declined booking releases the declining Photographer immediately. Keeping
-- it inside the protected range would make a free slot remain unavailable
-- until Management completed reassignment.
alter table public.tasks
  drop constraint if exists northlight_tasks_photographer_no_overlap;

alter table public.tasks
  add constraint northlight_tasks_photographer_no_overlap
  exclude using gist (
    tenant_id with =,
    photographer_user_id with =,
    tstzrange(
      pg_catalog.timezone(
        'UTC',
        pg_catalog.timezone('UTC', scheduled_start)
          - pg_catalog.make_interval(
            mins => public.northlight_schedule_buffer_minutes(metadata, 'buffer_before_min')
          )
      ),
      pg_catalog.timezone(
        'UTC',
        pg_catalog.timezone('UTC', scheduled_end)
          + pg_catalog.make_interval(
            mins => public.northlight_schedule_buffer_minutes(metadata, 'buffer_after_min')
          )
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
    and status not in ('cancelled', 'declined', 'delivered')
  );

-- Lease and provider-receipt state must never be half-populated. Constraints
-- are added NOT VALID then validated so legacy anomalies stop the release
-- rather than being grandfathered into the security boundary.
do $$
declare
  specification record;
  is_valid boolean;
begin
  for specification in
    select *
    from (values
      ('task_handoffs', 'task_handoffs_dispatch_lease_pair_check',
        '((dispatch_owner is null) = (dispatch_lease_until is null))'),
      ('task_handoffs', 'task_handoffs_provider_receipt_object_check',
        '(pg_catalog.jsonb_typeof(provider_receipt) = ''object'')'),
      ('calendar_cleanup_queue', 'calendar_cleanup_dispatch_lease_pair_check',
        '((dispatch_owner is null) = (dispatch_lease_until is null))'),
      ('calendar_cleanup_queue', 'calendar_cleanup_provider_receipt_object_check',
        '(pg_catalog.jsonb_typeof(provider_receipt) = ''object'')'),
      ('integration_state', 'integration_state_refresh_generation_check',
        '(refresh_generation >= 0)'),
      ('integration_state', 'integration_state_refresh_lease_pair_check',
        '((refresh_owner is null) = (refresh_lease_until is null))'),
      ('user_integrations', 'user_integrations_refresh_generation_check',
        '(refresh_generation >= 0)'),
      ('user_integrations', 'user_integrations_refresh_lease_pair_check',
        '((refresh_owner is null) = (refresh_lease_until is null))'),
      ('media_releases', 'media_releases_approval_state_check',
        '((status = ''publishing'' and approved_at is null) or (status = ''approved'' and approved_at is not null and file_count > 0 and manifest_fingerprint is not null and manifest_fingerprint ~ ''^[0-9a-f]{64}$''))'),
      ('media_release_files', 'media_release_files_receipt_hashes_check',
        '(content_hash ~ ''^[0-9a-fA-F]{64}$'' and source_content_hash ~ ''^[0-9a-fA-F]{64}$'')'),
      ('invoices', 'invoices_xero_creation_intent_check',
        '(provider <> ''xero'' or status <> ''creating'' or (task_id is not null and coalesce(total > 0, false) and idempotency_key is not null and pg_catalog.length(idempotency_key) between 32 and 128 and request_hash is not null and request_hash ~ ''^[0-9a-f]{64}$'' and pg_catalog.jsonb_typeof(metadata -> ''request'') is not distinct from ''object''))')
    ) as constraints_to_add(table_name, constraint_name, expression)
  loop
    if not exists (
      select 1
      from pg_catalog.pg_constraint constraint_row
      where constraint_row.conrelid = pg_catalog.to_regclass('public.' || specification.table_name)
        and constraint_row.conname = specification.constraint_name
    ) then
      execute pg_catalog.format(
        'alter table public.%I add constraint %I check %s not valid',
        specification.table_name,
        specification.constraint_name,
        specification.expression
      );
    end if;

    select constraint_row.convalidated
      into is_valid
      from pg_catalog.pg_constraint constraint_row
     where constraint_row.conrelid = pg_catalog.to_regclass('public.' || specification.table_name)
       and constraint_row.conname = specification.constraint_name;

    if is_valid is distinct from true then
      execute pg_catalog.format(
        'alter table public.%I validate constraint %I',
        specification.table_name,
        specification.constraint_name
      );
    end if;
  end loop;
end
$$;

-- This table models a user-scoped connection. Tenant-wide provider state is
-- stored separately in integration_state, so a null user is never meaningful.
alter table public.user_integrations
  alter column user_id set not null;

-- Close the release immutability gap: a file cannot be moved into an approved
-- release, approved rows cannot be modified, and promotion requires the exact
-- current, unexpired publication claim plus a complete manifest row set.
create or replace function public.northlight_protect_media_release()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_release public.media_releases%rowtype;
  v_task public.tasks%rowtype;
  v_claim jsonb;
  v_claim_expires timestamptz;
begin
  if tg_table_name = 'media_releases' then
    if tg_op = 'DELETE' then
      raise exception 'release_immutable';
    end if;

    if tg_op = 'INSERT' then
      select * into v_task
        from public.tasks task_row
       where task_row.id = new.task_id
         and task_row.tenant_id = new.tenant_id
         and task_row.deleted_at is null
         and task_row.archived_at is null
       for key share;
      if not found or v_task.status <> 'editing' then
        raise exception 'review_publish_claim_lost';
      end if;

      v_claim := coalesce(v_task.metadata, '{}'::jsonb) -> 'review_publish_claim';
      if pg_catalog.jsonb_typeof(v_claim) is distinct from 'object'
         or v_claim ->> 'release_id' is distinct from new.id::text
         or v_claim ->> 'release_root' is distinct from new.root_path
         or v_claim ->> 'actor_user_id' is distinct from new.created_by_user_id::text
         or new.status <> 'publishing'
         or new.approved_at is not null
         or new.file_count <= 0
         or new.manifest_fingerprint is null
         or new.manifest_fingerprint !~ '^[0-9a-f]{64}$' then
        raise exception 'review_publish_claim_lost';
      end if;

      begin
        v_claim_expires := (v_claim ->> 'expires_at')::timestamptz;
      exception
        when invalid_datetime_format or datetime_field_overflow then
          raise exception 'review_publish_claim_invalid';
      end;
      if v_claim_expires is null or v_claim_expires <= pg_catalog.now() then
        raise exception 'review_publish_claim_expired';
      end if;
      return new;
    end if;

    if old.status = 'approved' then
      raise exception 'approved_release_immutable';
    end if;
    if old.status <> 'publishing'
       or new.status <> 'approved'
       or new.approved_at is null
       or new.id is distinct from old.id
       or new.tenant_id is distinct from old.tenant_id
       or new.task_id is distinct from old.task_id
       or new.provider is distinct from old.provider
       or new.root_path is distinct from old.root_path
       or new.manifest_fingerprint is distinct from old.manifest_fingerprint
       or new.file_count is distinct from old.file_count
       or new.created_by_user_id is distinct from old.created_by_user_id
       or new.created_at is distinct from old.created_at
       or new.file_count <> (
         select pg_catalog.count(*)::integer
         from public.media_release_files release_file
         where release_file.release_id = old.id
       ) then
      raise exception 'release_promotion_invalid';
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' then
    select * into v_release
      from public.media_releases release_row
     where release_row.id = new.release_id
       and release_row.tenant_id = new.tenant_id
       and release_row.task_id = new.task_id
     for key share;
    if not found
       or v_release.status <> 'publishing'
       or pg_catalog.lower(pg_catalog.left(
            new.path,
            pg_catalog.length(v_release.root_path) + 1
          )) <> pg_catalog.lower(v_release.root_path || '/') then
      raise exception 'release_file_not_publishable';
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE' then
    raise exception 'release_file_immutable';
  end if;

  if exists (
    select 1
    from public.media_releases release_row
    where release_row.id = old.release_id
      and release_row.status = 'approved'
  ) then
    raise exception 'approved_release_immutable';
  end if;
  return old;
end
$$;

drop trigger if exists northlight_protect_media_release_row on public.media_releases;
create trigger northlight_protect_media_release_row
before insert or update or delete on public.media_releases
for each row execute function public.northlight_protect_media_release();

revoke all on function public.northlight_protect_media_release() from public, anon, authenticated;

-- Every SECURITY DEFINER function added by this RC resolves only catalog or
-- explicitly schema-qualified objects. This removes caller-controlled public
-- and temporary schemas from name resolution.
alter function public.northlight_reap_stale_system_jobs() set search_path = '';
alter function public.northlight_claim_task_handoff_dispatch(uuid, integer, integer) set search_path = '';
alter function public.northlight_claim_calendar_cleanup_dispatch(uuid, integer, integer) set search_path = '';
alter function public.northlight_finish_task_handoff_dispatch(uuid, uuid[], boolean) set search_path = '';
alter function public.northlight_finish_calendar_cleanup_dispatch(uuid, uuid[], boolean) set search_path = '';
alter function public.northlight_begin_xero_invoice(uuid, uuid, text, text, jsonb) set search_path = '';
alter function public.northlight_claim_integration_refresh(uuid, text, uuid, integer) set search_path = '';
alter function public.northlight_finish_integration_refresh(uuid, text, uuid, bigint, jsonb) set search_path = '';
alter function public.northlight_release_integration_refresh(uuid, text, uuid) set search_path = '';
alter function public.northlight_claim_user_integration_refresh(uuid, uuid, text, uuid, integer) set search_path = '';
alter function public.northlight_finish_user_integration_refresh(uuid, uuid, text, uuid, bigint, jsonb) set search_path = '';
alter function public.northlight_release_user_integration_refresh(uuid, uuid, text, uuid) set search_path = '';

-- Functions created before the deny-by-default setting inherited PostgreSQL's
-- PUBLIC execute privilege. Replace that ambient access with an explicit API
-- allow-list; trigger functions are never callable RPCs.
revoke all on function public.northlight_claim_review_publish(uuid, uuid) from public;
revoke all on function public.northlight_release_review_publish(uuid, uuid, text) from public;
revoke all on function public.northlight_finish_review_publish(uuid, uuid, text, uuid, text, jsonb) from public;
revoke all on function public.northlight_approve_delivery(uuid, uuid) from public;
revoke all on function public.northlight_schedule_buffer_minutes(jsonb, text) from public;
revoke all on function public.northlight_select_editor(uuid, text[]) from public;
revoke all on function public.northlight_create_booking(
  uuid, uuid, text, text, text, text, text, text, uuid, uuid,
  timestamptz, timestamptz, text[], text, jsonb
) from public;
revoke all on function public.northlight_apply_reschedule(
  uuid, uuid, uuid, text, timestamptz, timestamptz, text,
  timestamptz, timestamptz, text, text, integer, integer, boolean
) from public;
revoke all on function public.northlight_require_approved_delivery_release()
  from public, anon, authenticated;

grant execute on function public.northlight_claim_review_publish(uuid, uuid)
  to anon, authenticated;
grant execute on function public.northlight_release_review_publish(uuid, uuid, text)
  to anon, authenticated;
grant execute on function public.northlight_finish_review_publish(uuid, uuid, text, uuid, text, jsonb)
  to anon, authenticated;
grant execute on function public.northlight_approve_delivery(uuid, uuid)
  to anon, authenticated;
grant execute on function public.northlight_schedule_buffer_minutes(jsonb, text)
  to anon, authenticated;
grant execute on function public.northlight_select_editor(uuid, text[])
  to anon, authenticated;
grant execute on function public.northlight_create_booking(
  uuid, uuid, text, text, text, text, text, text, uuid, uuid,
  timestamptz, timestamptz, text[], text, jsonb
) to anon, authenticated;
grant execute on function public.northlight_apply_reschedule(
  uuid, uuid, uuid, text, timestamptz, timestamptz, text,
  timestamptz, timestamptz, text, text, integer, integer, boolean
) to anon, authenticated;

-- New exposed-schema defaults are deny-by-default. Each later table/function
-- must be deliberately granted in the migration that creates it.
alter default privileges for role postgres in schema public
  revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

revoke all on table public.media_releases, public.media_release_files
  from public, anon, authenticated, service_role;
grant select, insert, update, delete
  on table public.media_releases, public.media_release_files
  to anon, authenticated;
grant all
  on table public.media_releases, public.media_release_files
  to service_role;

-- Tables created after the original single-tenant migration need the same
-- restrictive fail-closed policy, not only the permissive pilot-key policy.
drop policy if exists northlight_single_tenant_only on public.media_releases;
create policy northlight_single_tenant_only
  on public.media_releases as restrictive for all to anon, authenticated
  using ((select northlight_private.single_tenant_guard()))
  with check ((select northlight_private.single_tenant_guard()));

drop policy if exists northlight_single_tenant_only on public.media_release_files;
create policy northlight_single_tenant_only
  on public.media_release_files as restrictive for all to anon, authenticated
  using ((select northlight_private.single_tenant_guard()))
  with check ((select northlight_private.single_tenant_guard()));

-- PostgREST runs this once for every Data API request. It makes the hidden
-- backend pilot key and the one-tenant kill switch global prerequisites for
-- anon/authenticated traffic, including SECURITY DEFINER RPCs that bypass RLS.
create or replace function northlight_private.northlight_data_api_guard()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims jsonb := '{}'::jsonb;
  v_role text;
begin
  begin
    v_claims := coalesce(
      nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb,
      '{}'::jsonb
    );
  exception
    when invalid_text_representation then
      raise exception using errcode = '42501', message = 'permission_denied';
  end;

  v_role := coalesce(v_claims ->> 'role', '');
  if v_role not in ('anon', 'authenticated', 'service_role') then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;
  if v_role in ('anon', 'authenticated')
     and (
       not public.northlight_pilot_allowed()
       or not northlight_private.single_tenant_guard()
     ) then
    raise exception using errcode = '42501', message = 'permission_denied';
  end if;
end
$$;

revoke all on schema northlight_private from public;
grant usage on schema northlight_private to authenticator, anon, authenticated;
revoke all on function northlight_private.northlight_data_api_guard()
  from public, anon, authenticated, service_role;
grant execute on function northlight_private.northlight_data_api_guard()
  to authenticator;

alter role authenticator
  set pgrst.db_pre_request = 'northlight_private.northlight_data_api_guard';
notify pgrst, 'reload config';

reset lock_timeout;
reset statement_timeout;
