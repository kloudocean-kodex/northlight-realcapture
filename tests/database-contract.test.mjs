import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const migrationsUrl = new URL('../supabase/migrations/', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');

const migrationNames = async () => (await readdir(migrationsUrl))
  .filter(name => name.endsWith('.sql'))
  .sort();

const named = name => read(`supabase/migrations/${name}`);

test('schema manifest is explicit about the unrecovered production foundation', async () => {
  const contract = JSON.parse(await read('supabase/schema-contract.json'));
  const local = await migrationNames();

  assert.equal(contract.formatVersion, 1);
  assert.equal(contract.target.postgresMajor, 17);
  assert.equal(contract.target.productionInspectionWasReadOnly, true);
  assert.equal(contract.reproducibility.fromEmptyDatabase, false);
  assert.equal(contract.reproducibility.releaseBlocking, true);
  assert.equal(contract.productionLedger.length, 36);
  assert.equal(contract.productionLedger[0].version, '20260816153506');
  assert.equal(contract.productionLedger.at(-1).version, '20260819110844');
  assert.ok(contract.productionLedger.every(row => row.localExactSql === false));
  assert.deepEqual(contract.localCandidateMigrations, local);
  assert.deepEqual(Object.keys(contract.localCandidateMigrationSha256), local);
  for (const name of local) {
    const digest = createHash('sha256').update(await named(name)).digest('hex');
    assert.equal(contract.localCandidateMigrationSha256[name], digest, `stale migration hash: ${name}`);
  }
  assert.ok(contract.requiredEvidence.includes('empty_postgres_17_replay'));
  assert.ok(contract.requiredEvidence.includes('backup_restore_rehearsal'));
});

test('migration filenames are ordered, unique and use one 14-digit version each', async () => {
  const names = await migrationNames();
  const versions = names.map(name => {
    const match = name.match(/^(\d{14})_[a-z0-9_]+\.sql$/);
    assert.ok(match, `invalid migration filename: ${name}`);
    return match[1];
  });

  assert.deepEqual(names, [...names].sort());
  assert.equal(new Set(versions).size, versions.length);
});

test('saved database artifacts contain no credential-shaped literals', async () => {
  const paths = [
    ...(await migrationNames()).map(name => `supabase/migrations/${name}`),
    'supabase/schema-contract.json',
    'supabase/production-catalog-contract.json',
    'supabase/tests/database_contract.sql',
    'docs/database-reproducibility-plan.md'
  ];
  const combined = (await Promise.all(paths.map(read))).join('\n');

  assert.doesNotMatch(combined, /sb_(?:secret|publishable)_[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(combined, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(combined, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/);
  assert.doesNotMatch(combined, /(?:access|refresh|client)[_-]?token\s*[:=]\s*['"][A-Za-z0-9._-]{20,}['"]/i);
});

test('same-tenant integrity migration validates every critical relationship', async () => {
  const sql = await named('20260821142000_northlight_same_tenant_integrity.sql');
  const constraints = [
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
    'tasks_tenant_approved_release_task_fkey'
  ];

  for (const constraint of constraints) assert.match(sql, new RegExp(`'${constraint}'`));
  assert.match(sql, /foreign key %s references public\.%I %s %s not valid/i);
  assert.match(sql, /validate constraint %I/i);
  assert.doesNotMatch(sql, /add constraint if not exists/i);
});

test('upload completion is one strict session-backed transaction', async () => {
  const sql = await named('20260821142100_northlight_atomic_upload_completion.sql');
  const errors = [
    'permission_denied',
    'upload_identity_required',
    'upload_session_required',
    'task_not_found',
    'task_archived',
    'task_closed',
    'dropbox_workspace_missing',
    'upload_path_outside_task',
    'invalid_media_stage',
    'service_not_in_task',
    'upload_permission_denied',
    'review_publish_locked',
    'review_publish_lock_invalid',
    'provider_receipt_invalid',
    'upload_session_not_found',
    'upload_session_not_owned',
    'upload_session_not_ready',
    'upload_session_expired',
    'upload_session_receipt_mismatch',
    'upload_session_already_completed',
    'provider_file_conflict',
    'upload_path_owned_by_other_task'
  ];

  assert.match(sql, /create or replace function public\.northlight_finalize_upload_index/i);
  assert.match(sql, /security definer\s+set search_path = ''/i);
  assert.match(sql, /not public\.northlight_pilot_allowed\(\)[\s\S]*not northlight_private\.single_tenant_guard\(\)/i);
  assert.match(sql, /from public\.tasks[\s\S]*for update;/i);
  assert.match(sql, /from public\.media_upload_sessions[\s\S]*for update;/i);
  assert.match(sql, /if p_upload_session_id is null then[\s\S]*upload_session_required/i);
  assert.match(sql, /create unique index if not exists task_files_active_provider_file_uidx/i);
  assert.match(sql, /on conflict \(tenant_id, provider, path\) do update/i);
  assert.match(sql, /update public\.media_upload_sessions[\s\S]*provider_receipt = v_receipt/i);
  assert.match(sql, /insert into public\.task_events/i);
  assert.match(sql, /revoke all on function public\.northlight_finalize_upload_index[\s\S]*from public/i);
  assert.match(sql, /grant execute on function public\.northlight_finalize_upload_index[\s\S]*to anon, authenticated/i);
  assert.doesNotMatch(sql, /pg_catalog\.(?:coalesce|nullif|case|greatest|least)/i);
  for (const error of errors) assert.match(sql, new RegExp(`'${error}'`));
});

test('review releases are immutable on both the old and new side of a file update', async () => {
  const release = await named('20260819200000_northlight_immutable_review_releases.sql');
  const hardening = await named('20260821142200_northlight_security_contract_hardening.sql');

  assert.match(release, /manifest_fingerprint/i);
  assert.match(release, /for update/i);
  assert.match(release, /approved_release_id = p_release_id/i);
  assert.match(hardening, /before insert or update or delete on public\.media_releases/i);
  assert.match(hardening, /if tg_op = 'UPDATE' then\s+raise exception 'release_file_immutable'/i);
  assert.match(hardening, /v_claim_expires <= pg_catalog\.now\(\)/i);
  assert.match(hardening, /new\.file_count <> \([\s\S]*count\(\*\)[\s\S]*media_release_files/i);
  assert.match(hardening, /media_release_files_receipt_hashes_check/i);
});

test('durable dispatcher has bounded skip-locked claims and fenced finishes', async () => {
  const sql = await named('20260819203000_northlight_durable_dispatch_queue.sql');
  const hardening = await named('20260821142200_northlight_security_contract_hardening.sql');

  assert.equal((sql.match(/for update skip locked/gi) || []).length, 2);
  assert.match(sql, /least\(greatest\(coalesce\(p_limit, 50\), 1\), 100\)/i);
  assert.match(sql, /h\.dispatch_owner = p_dispatcher/i);
  assert.match(sql, /q\.dispatch_owner = p_dispatcher/i);
  assert.equal((sql.match(/not public\.northlight_pilot_allowed\(\)/gi) || []).length, 5);
  assert.equal((sql.match(/revoke all on function/gi) || []).length, 5);
  assert.equal((sql.match(/grant execute on function/gi) || []).length, 5);
  assert.match(hardening, /task_handoffs_dispatch_lease_pair_check/i);
  assert.match(hardening, /calendar_cleanup_dispatch_lease_pair_check/i);
});

test('OAuth refresh uses row locks, owner plus generation fencing and constrained leases', async () => {
  const sql = await named('20260819220000_northlight_oauth_refresh_leases.sql');
  const hardening = await named('20260821142200_northlight_security_contract_hardening.sql');

  assert.equal((sql.match(/security definer/gi) || []).length, 6);
  assert.equal((sql.match(/not public\.northlight_pilot_allowed\(\)/gi) || []).length, 6);
  assert.equal((sql.match(/for update;/gi) || []).length, 2);
  assert.match(sql, /refresh_owner = p_owner[\s\S]*refresh_generation = p_generation/i);
  assert.match(sql, /raise exception 'refresh_claim_lost'/i);
  assert.equal((sql.match(/revoke all on function/gi) || []).length, 6);
  assert.equal((sql.match(/grant execute on function/gi) || []).length, 6);
  assert.match(hardening, /integration_state_refresh_lease_pair_check/i);
  assert.match(hardening, /user_integrations_refresh_lease_pair_check/i);
  assert.match(hardening, /alter column user_id set not null/i);
});

test('OAuth authorization state is encrypted, server-only and consumed exactly once', async () => {
  const sql = await named('20260821142300_northlight_oauth_authorization_states.sql');

  assert.match(sql, /create table if not exists public\.oauth_authorization_states/i);
  assert.match(sql, /state_hash text not null unique[\s\S]*\^\[0-9a-f\]\{64\}\$/i);
  assert.match(sql, /pkce_verifier_ciphertext text not null/i);
  assert.doesNotMatch(sql, /\bpkce_verifier\s+text/i);
  assert.match(sql, /create unique index if not exists oauth_authorization_states_one_pending_idx[\s\S]*where consumed_at is null/i);
  assert.match(sql, /alter table public\.oauth_authorization_states enable row level security/i);
  assert.match(sql, /revoke all on table public\.oauth_authorization_states[\s\S]*from public, anon, authenticated, service_role/i);
  assert.doesNotMatch(sql, /create policy[\s\S]*oauth_authorization_states/i);
  assert.match(sql, /create or replace function public\.northlight_begin_oauth_state/i);
  assert.match(sql, /create or replace function public\.northlight_consume_oauth_state/i);
  assert.equal((sql.match(/security definer\s+set search_path = ''/gi) || []).length, 2);
  assert.equal((sql.match(/not public\.northlight_pilot_allowed\(\)[\s\S]*?not northlight_private\.single_tenant_guard\(\)/gi) || []).length, 2);
  assert.match(sql, /delete from public\.oauth_authorization_states[\s\S]*state_row\.consumed_at is null/i);
  assert.match(sql, /set consumed_at = pg_catalog\.now\(\)[\s\S]*consumed_at is null[\s\S]*expires_at > pg_catalog\.now\(\)/i);
  assert.match(sql, /if not found then[\s\S]*return null/i);
  assert.match(sql, /grant execute on function public\.northlight_begin_oauth_state[\s\S]*to anon/i);
  assert.match(sql, /grant execute on function public\.northlight_consume_oauth_state[\s\S]*to anon/i);
  assert.doesNotMatch(sql, /pg_catalog\.(?:position|coalesce|nullif|case|greatest|least)/i);
});

test('Dropbox cursor work is leased, generation fenced and batch-applied atomically', async () => {
  const sql = await named('20260821142400_northlight_dropbox_sync_leases.sql');

  assert.match(sql, /add column if not exists sync_owner uuid/i);
  assert.match(sql, /add column if not exists connection_generation bigint not null default 0/i);
  assert.match(sql, /dropbox_sync_state_lease_pair_check/i);
  assert.match(sql, /create or replace function public\.northlight_claim_dropbox_sync/i);
  assert.match(sql, /create or replace function public\.northlight_advance_dropbox_sync/i);
  assert.match(sql, /create or replace function public\.northlight_finish_dropbox_sync/i);
  assert.match(sql, /create or replace function public\.northlight_apply_dropbox_sync_batch/i);
  assert.doesNotMatch(sql, /northlight_read_dropbox_index_batch/i);
  assert.equal((sql.match(/security definer\s+set search_path = ''/gi) || []).length, 4);
  assert.match(sql, /v_state\.cursor is distinct from p_expected_cursor[\s\S]*dropbox_cursor_changed/i);
  assert.match(sql, /v_state\.connection_generation is distinct from v_integration\.refresh_generation/i);
  assert.match(sql, /jsonb_array_length\(p_entries\) not between 1 and 200/i);
  assert.match(sql, /'reset_cleanup_required', true[\s\S]*'reset_cleanup_seed', extensions\.gen_random_uuid\(\)::text/i);
  assert.match(sql, /v_state\.account_id is distinct from v_account_id[\s\S]*v_state\.cursor is null[\s\S]*'page_limit' is distinct from '200'/i);
  assert.match(sql, /if v_is_deleted then[\s\S]*if v_target\.id is null then[\s\S]*continue/i);
  assert.match(sql, /if v_is_prefix_delete then[\s\S]*dropbox_prefix_delete_must_be_single[\s\S]*not file_row\.is_deleted[\s\S]*like v_prefix_pattern escape/i);
  assert.match(sql, /order by file_row\.id[\s\S]*limit 201[\s\S]*v_prefix_processed >= 200[\s\S]*v_prefix_has_more := true/i);
  assert.match(sql, /extensions\.digest\([\s\S]*v_event_id::text \|\| ':' \|\| v_file\.id::text/i);
  assert.match(sql, /set is_deleted = true[\s\S]*'deleted_prefix', v_path/i);
  assert.match(sql, /dropbox_sync_page_id[\s\S]*v_existing_page_order > v_page_order[\s\S]*continue/i);
  assert.match(sql, /if v_is_deleted then\s+v_metadata := coalesce\(v_target\.metadata, '\{\}'::jsonb\)/i);
  assert.match(sql, /'prefix_has_more', v_prefix_has_more/i);
  assert.match(sql, /if v_source\.id is not null and v_source\.id is distinct from v_target\.id/i);
  assert.match(sql, /insert into public\.task_events[\s\S]*on conflict \(id\) do update/i);
  assert.equal((sql.match(/grant execute on function public\.northlight_/gi) || []).length, 4);
});

test('Calendar cursor and watch state use leases, hashed overlap and disconnect fencing', async () => {
  const sql = await named('20260821142500_northlight_calendar_sync_watch_leases.sql');

  assert.match(sql, /create table if not exists public\.calendar_watch_channels/i);
  assert.match(sql, /token_hash text not null check \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  assert.match(sql, /status text not null check \(status in \('pending', 'active', 'draining', 'stopped'\)\)/i);
  assert.match(sql, /calendar_watch_channels_one_active_uidx[\s\S]*where status = 'active'/i);
  assert.match(sql, /revoke all on table public\.calendar_watch_channels[\s\S]*from public, anon, authenticated, service_role/i);
  assert.match(sql, /extensions\.digest\(state_row\.metadata ->> 'webhook_token', 'sha256'\)/i);
  assert.match(sql, /metadata = state_row\.metadata - 'webhook_token'/i);
  for (const name of [
    'northlight_claim_calendar_sync',
    'northlight_advance_calendar_sync',
    'northlight_finish_calendar_sync',
    'northlight_claim_calendar_watch',
    'northlight_activate_calendar_watch',
    'northlight_fail_calendar_watch',
    'northlight_read_calendar_watch_channel',
    'northlight_stop_calendar_watch_channel',
    'northlight_disconnect_calendar_watch',
    'northlight_finish_user_integration_refresh',
    'northlight_list_calendar_maintenance'
  ]) assert.match(sql, new RegExp(`create or replace function public\\.${name}`, 'i'));
  assert.equal((sql.match(/security definer\s+set search_path = ''/gi) || []).length, 11);
  assert.match(sql, /channel\.status in \('active', 'draining'\)[\s\S]*channel\.expires_at > pg_catalog\.now\(\)/i);
  assert.match(sql, /v_integration\.status <> 'disconnecting'[\s\S]*calendar_disconnect_generation_changed/i);
  assert.match(sql, /set sync_token = null[\s\S]*status = 'stopped'/i);
  assert.match(sql, /refresh_generation = connection\.refresh_generation \+ 1[\s\S]*state_row\.connection_generation = p_generation[\s\S]*channel\.status <> 'stopped'[\s\S]*channel\.connection_generation = p_generation/i);
  assert.match(sql, /northlight_list_calendar_maintenance[\s\S]*'sync_due'[\s\S]*interval '30 hours'[\s\S]*limit v_limit/i);
  assert.equal((sql.match(/grant execute on function public\.northlight_/gi) || []).length, 11);
});

test('login throttling is serialized before verification and legacy credentials are migration-gated', async () => {
  const sql = await named('20260821142600_northlight_auth_rate_and_credential_migration.sql');

  assert.match(sql, /alter table public\.auth_login_attempts enable row level security/i);
  assert.match(sql, /revoke all on table public\.auth_login_attempts[\s\S]*from public, anon, authenticated, service_role/i);
  assert.match(sql, /create or replace function public\.northlight_begin_login_attempt/i);
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*northlight-login:/i);
  assert.match(sql, /for update;[\s\S]*failure_count = excluded\.failure_count/i);
  assert.match(sql, /'allowed', true[\s\S]*'blocked_until'/i);
  assert.match(sql, /auth_must_change_password boolean not null default true/i);
  assert.match(sql, /password_hash !~ '\^scrypt\\\$' or auth_must_change_password/i);
  assert.match(sql, /create or replace function public\.northlight_complete_password_migration/i);
  assert.match(sql, /v_user\.password_hash is distinct from p_expected_password_hash/i);
  assert.match(sql, /auth_must_change_password = false[\s\S]*credential_version = user_row\.credential_version \+ 1/i);
  assert.equal((sql.match(/security definer\s+set search_path = ''/gi) || []).length, 3);
});

test('Photographer availability is canonical, versioned, self-scoped and gates bookability', async () => {
  const sql = await named('20260821142700_northlight_photographer_availability_onboarding.sql');

  assert.match(sql, /availability_version bigint not null default 0/i);
  assert.match(sql, /create or replace function public\.northlight_validate_provider_availability_row/i);
  assert.match(sql, /pg_timezone_names[\s\S]*availability_timezone_invalid/i);
  assert.match(sql, /'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'/i);
  assert.match(sql, /availability_date_rule_conflict/i);
  assert.match(sql, /create or replace function public\.northlight_update_provider_availability/i);
  assert.match(sql, /v_actor\.id = p_user_id and v_actor\.role_code = 'photographer'/i);
  assert.match(sql, /v_actor\.role_code in \('admin', 'owner'\)/i);
  assert.match(sql, /v_profile\.availability_version is distinct from p_expected_version/i);
  assert.match(sql, /availability_version = p_expected_version \+ 1/i);
  assert.match(sql, /create or replace function public\.northlight_photographer_onboarding_status/i);
  assert.match(sql, /calendar_sync_unhealthy[\s\S]*calendar_watch_unhealthy/i);
  assert.match(sql, /create trigger northlight_require_bookable_photographer/i);
  assert.match(sql, /raise exception 'photographer_not_bookable'/i);
});

test('new security-definer migrations use parser-valid empty search paths and explicit ACLs', async () => {
  const names = (await migrationNames()).filter(name => name >= '20260821142300');
  const sql = (await Promise.all(names.map(named))).join('\n');

  assert.doesNotMatch(sql, /pg_catalog\.(?:coalesce|nullif|case|greatest|least|substring)/i);
  assert.equal(
    (sql.match(/^security definer/gim) || []).length,
    (sql.match(/^security definer\s+set search_path = ''/gim) || []).length
  );
  assert.doesNotMatch(sql, /grant execute[\s\S]{0,160}\bto\s+(?:public|authenticated|service_role)\b/i);
});

test('Xero creation intent is task-serialized and parameters are immutable', async () => {
  const sql = await named('20260819213000_northlight_xero_invoice_idempotency.sql');
  const hardening = await named('20260821142200_northlight_security_contract_hardening.sql');

  assert.match(sql, /create unique index if not exists invoices_one_xero_per_task_idx/i);
  assert.match(sql, /where id = p_task_id and deleted_at is null for update/i);
  assert.match(sql, /v_actor\.tenant_id is distinct from v_task\.tenant_id/i);
  assert.match(sql, /v_task\.status <> 'delivered'/i);
  assert.match(sql, /v_invoice\.request_hash is distinct from p_request_hash/i);
  assert.match(sql, /exception\s+when unique_violation/i);
  assert.match(hardening, /invoices_xero_creation_intent_check/i);
});

test('scheduling keeps one canonical idempotency index and releases declined slots', async () => {
  const sql = await named('20260819210000_northlight_atomic_scheduling.sql');
  const hardening = await named('20260821142200_northlight_security_contract_hardening.sql');

  assert.match(sql, /northlight_tasks_photographer_no_overlap/i);
  assert.match(sql, /create or replace function public\.northlight_create_booking/i);
  assert.match(sql, /from public\.tasks[\s\S]*for update/i);
  assert.match(sql, /exception when unique_violation/i);
  assert.doesNotMatch(sql, /northlight_tasks_tenant_idempotency_key_uidx/i);
  assert.match(hardening, /status not in \('cancelled', 'declined', 'delivered'\)/i);
});

test('security hardening closes Data API, default privilege and definer gaps', async () => {
  const sql = await named('20260821142200_northlight_security_contract_hardening.sql');
  const alteredDefiners = [
    'northlight_reap_stale_system_jobs',
    'northlight_claim_task_handoff_dispatch',
    'northlight_claim_calendar_cleanup_dispatch',
    'northlight_finish_task_handoff_dispatch',
    'northlight_finish_calendar_cleanup_dispatch',
    'northlight_begin_xero_invoice',
    'northlight_claim_integration_refresh',
    'northlight_finish_integration_refresh',
    'northlight_release_integration_refresh',
    'northlight_claim_user_integration_refresh',
    'northlight_finish_user_integration_refresh',
    'northlight_release_user_integration_refresh'
  ];

  for (const name of alteredDefiners) {
    assert.match(sql, new RegExp(`alter function public\\.${name}\\([\\s\\S]*?set search_path = ''`, 'i'));
  }
  assert.match(sql, /alter default privileges for role postgres in schema public[\s\S]*revoke all on tables/i);
  assert.match(sql, /revoke execute on functions from public, anon, authenticated/i);
  assert.match(sql, /create policy northlight_single_tenant_only[\s\S]*media_releases/i);
  assert.match(sql, /create or replace function northlight_private\.northlight_data_api_guard\(\)/i);
  assert.match(sql, /security definer\s+set search_path = ''/i);
  assert.match(sql, /not public\.northlight_pilot_allowed\(\)[\s\S]*not northlight_private\.single_tenant_guard\(\)/i);
  assert.match(sql, /alter role authenticator[\s\S]*pgrst\.db_pre_request/i);
  assert.match(sql, /notify pgrst, 'reload config'/i);
});

test('SQL contract is executable, read-only and covers catalog plus live tenant data', async () => {
  const sql = await read('supabase/tests/database_contract.sql');

  assert.match(sql, /^\\set ON_ERROR_STOP on/m);
  assert.match(sql, /begin;[\s\S]*rollback;/i);
  assert.doesNotMatch(sql, /\b(?:insert|update|delete|alter|create|drop|truncate)\s+(?:table|into|public\.)/i);
  assert.match(sql, /tenant tables without RLS/i);
  assert.match(sql, /unsafe SECURITY DEFINER configuration/i);
  assert.match(sql, /PostgREST pre-request guard is not registered/i);
  assert.match(sql, /cross-tenant rows detected/i);
});
