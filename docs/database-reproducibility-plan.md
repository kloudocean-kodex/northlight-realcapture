# Northlight database reproducibility and security plan

Status: **not yet reproducible from an empty Supabase project**
Evidence captured: 2026-08-21
Production project inspected read-only: `izomvvpdyaxtkyaoqpjj`

No migration in this RC has been applied to production. No branch or paid
resource was created. Production catalog queries and Supabase advisors were
read-only.

## Release-blocking evidence

The repository's earliest saved SQL file is
`20260819102500_northlight_task_handoff_outbox.sql`. It assumes that core
tables, constraints, policies, functions, extensions, grants, and reference
data already exist. Production has 36 applied migration records beginning at
`20260816153506_northlight_pilot_core_schema`; the exact SQL for the first 16
records is absent locally. Several later local files are consolidated and use
versions that do not match the production migration ledger.

This is now conclusive repository-history evidence, not an incomplete search:
the GitHub first-parent trace reaches the initial commit `c8564467`, and no
commit before `20260819102500` contains migration files. The historical
`cloud_bundle`, `v2`, and `v3` archives were also inspected and are
incomplete/corrupt; none is an authoritative recoverable migration source.

Therefore a new "foundation migration" cannot be safely invented from the
current catalog. A catalog snapshot cannot prove the original data transforms,
seed provenance, function history, project configuration, secret indirection,
or the order in which constraints became valid. In particular, the live pilot
authorization helper contains deployment-specific secret-bearing logic. Its
values must never be copied into source, an audit report, a test fixture, or a
generated baseline.

The machine used for this audit does not currently provide the Supabase CLI,
`psql`, Docker, or Podman. Static and JavaScript contract checks can run here,
but SQL execution must remain a release gate on an isolated Supabase-compatible
PostgreSQL 17 environment. Running the saved late chain against production is
not a substitute for a clean replay.

Machine-readable evidence is in `supabase/schema-contract.json`.
`supabase/production-catalog-contract.json` is a sanitized, read-only snapshot
of the current production catalog. Its object definitions are represented by
SHA-256 hashes; function bodies are never emitted. It is authoritative only for
the catalog state observed at capture time. It is **reconstructed current-state
evidence, not the missing historical migration SQL**.

## What the staged corrective migrations establish

1. `20260821142000_northlight_same_tenant_integrity.sql`
   adds composite tenant/entity foreign keys so privileged writes cannot create
   cross-tenant assignments, audit rows, media records, integration rows, or
   release references. Constraints are added `NOT VALID` and then validated;
   any legacy anomaly stops deployment.
2. `20260821142100_northlight_atomic_upload_completion.sql`
   adds a session-backed, provider-receipt upload finalizer. It locks the task
   and upload session, rechecks lifecycle, current role/assignment, service,
   stage, publication lease, ownership, expiry, path, byte count, and provider
   identity, then indexes the file, records one event, and closes the session in
   the same transaction. A partial unique provider-file index closes the final
   cross-task race.
3. `20260821142200_northlight_security_contract_hardening.sql`
   corrects the declined-booking exclusion predicate, adds lease/receipt state
   constraints, closes immutable-release mutation paths, gives RC
   `SECURITY DEFINER` functions an empty search path, replaces ambient function
   execution with explicit grants, makes future public-schema privileges
   deny-by-default, adds missing restrictive policies, and registers a global
   PostgREST request guard for the pilot key plus one-tenant kill switch.
4. `20260821142300_northlight_oauth_authorization_states.sql`
   stores only a SHA-256 state hash and application-encrypted PKCE verifier,
   invalidates the prior pending attempt for the same actor/provider, and
   atomically consumes an unexpired state once. The table has no anon or
   authenticated table access; the guarded server-side anon RPC surface is the
   only application path.
5. `20260821142400_northlight_dropbox_sync_leases.sql`
   serializes cursor ownership, fences account/connection generations, applies
   file plus event batches atomically, and drains recursive deletes in bounded
   200-row replay-safe chunks. Deterministic page ordering prevents an earlier
   replayed provider entry from resurrecting a later deletion.
6. `20260821142500_northlight_calendar_sync_watch_leases.sql`
   adds cursor and watch leases, hashed active/draining channel overlap,
   generation-fenced disconnect, bounded maintenance discovery, and an atomic
   routine-token-refresh cascade that preserves valid cursors and watches.
7. `20260821142600_northlight_auth_rate_and_credential_migration.sql`
   makes login counting atomic and adds a CAS transition from the live shared
   legacy credential marker to mandatory per-user PBKDF2 credentials. All eight
   active production users still require this coordinated onboarding; the
   legacy bootstrap must not be silently removed before they migrate.
8. `20260821142700_northlight_photographer_availability_onboarding.sql`
   validates and versions self-service availability, derives Calendar/profile/
   credential onboarding readiness, and prevents new assignment to an
   unbookable Photographer without rewriting existing bookings.

The candidate migration filenames and SHA-256 values are frozen in
`supabase/schema-contract.json`. Static database and integration contracts pass,
but the SQL chain has not been executed on PostgreSQL in this workspace.

These files are candidate migrations, not proof of deployment safety. They
must pass the clean-room gates below.

## Atomic upload RPC contract

Function:

```text
northlight_finalize_upload_index(
  p_task_id uuid,
  p_actor uuid,
  p_upload_session_id uuid,
  p_path text,
  p_provider_file_id text,
  p_provider_revision text,
  p_content_hash text,
  p_size_bytes bigint,
  p_name text,
  p_modified_at timestamptz = null,
  p_client_modified_at timestamptz = null
) -> jsonb
```

The session ID is mandatory. Both direct and resumable flows already create a
tracked session; accepting an untracked fallback would preserve the completion
authorization race. Dropbox metadata must be fetched first, and only verified
provider values may be sent to the RPC. The caller must not mark the session
`done` or write `task_files` separately.

Stable database error codes:

| Error | Meaning |
| --- | --- |
| `permission_denied` | Pilot boundary, active user, or tenant boundary failed |
| `upload_identity_required` | Task or actor UUID was absent |
| `upload_session_required` | Completion was not linked to a tracked session |
| `task_not_found` | Task is absent or soft-deleted |
| `task_archived` / `task_closed` | Task lifecycle forbids new media |
| `dropbox_workspace_missing` | Task has no provider root |
| `upload_path_outside_task` | Provider path is outside the locked task root |
| `invalid_media_stage` | Path does not resolve to a supported stage |
| `service_not_in_task` | Path service is not a current task service |
| `upload_permission_denied` | Actor is not the current assignee for that stage |
| `review_publish_locked` | Edited/final publication is actively serialized |
| `review_publish_lock_invalid` | Publication lock metadata is malformed; fail closed |
| `provider_receipt_invalid` | Provider ID/revision/hash/size/name is invalid |
| `upload_session_not_found` | Session does not belong to the locked tenant/task |
| `upload_session_not_owned` | Actor does not own it and lacks admin/owner override |
| `upload_session_not_ready` | Provider upload is not in `uploaded` or `done` state |
| `upload_session_expired` | A non-completed session exceeded its lease |
| `upload_session_receipt_mismatch` | Path/stage/service/size/bytes disagree |
| `upload_session_already_completed` | Retry attempted to change an immutable receipt |
| `provider_file_conflict` | Provider file is active at another task/path |
| `upload_path_owned_by_other_task` | Existing path row belongs to another task |

Success returns `ok`, `reused`, the indexed `file`, the session UUID, and
`session_status: "done"`.

## Audit of the new saved migrations

| Migration | Positive controls | Finding and staged correction |
| --- | --- | --- |
| Immutable review releases | Task row lock, provider manifest, release history, delivery trigger | New tables missed the earlier restrictive one-tenant policy; file updates could move into an approved release; publication completion did not independently enforce an unexpired claim. The security hardening migration corrects all three and makes promotion validate the manifest row count. |
| Durable dispatcher | `FOR UPDATE SKIP LOCKED`, bounded batches/leases, owner compare, partial due indexes | Definer functions used `public, pg_temp`; lease pairs and JSON receipts lacked constraints. Empty search paths and validated checks are staged. At-least-once redelivery remains intentional until the processor commits `done`. |
| Atomic scheduling | Database exclusion constraint, row locks, compare-and-set reschedule, idempotent booking insert | The protected range incorrectly included `declined`, and the saved file attempted to create a second equivalent idempotency index already present in production. Declined is corrected later; the source migration must retain only the canonical existing index before certification. |
| Xero intent | One intent per task, request hash, row lock, delivered-task/admin checks, unique-race recovery | Definer search path and creation-intent row shape were under-constrained. Empty search path and a validated Xero creation-intent check are staged. Malformed numeric/date request errors should remain mapped to a safe API response. |
| OAuth leases | Row lock, owner UUID, bounded lease, generation compare, lost-claim rejection | Definer search paths and owner/lease pairing were incomplete. Empty search paths, nonnegative generations, non-null per-user ownership, and pair constraints are staged. Random owner UUIDs remain mandatory for every claim. |

## Required clean-room recovery

1. Recover the exact SQL for every production migration version from the
   original repository, CI artifact, Supabase CLI history, or immutable backup.
   Preserve the version and name shown in `schema-contract.json`.
2. Replace deployment-specific authorization literals with a secret-free
   design. The preferred end state is managed identity plus organization-aware
   RLS; the pilot request header may remain only as a temporary server-side
   defense and must come from runtime secrets.
3. Add `supabase/config.toml` and a separate, non-secret `seed.sql`. Reference
   roles/services may be seeded deterministically; users, password verifiers,
   OAuth tokens, provider IDs, customer data, and live settings must not be.
4. Reconcile consolidated local files with the exact production ledger. Never
   mark a different SQL body as an already-applied production version.
5. Pin a release manifest of SHA-256 hashes after all SQL is final and reviewed.

If the missing historical SQL is irrecoverable, the only honest fallback is a
new, explicitly named reconstructed foundation on an isolated project:

1. generate a schema-only dump from a sanitized clone, never from copied
   customer rows;
2. remove owners, deployment literals, secrets, and unstable platform-managed
   objects;
3. separate deterministic reference seeds from schema;
4. replay the reconstruction into a second empty project;
5. run `supabase/tests/catalog_fingerprint.sql` and compare every category hash
   with `supabase/production-catalog-contract.json`;
6. document all intentional differences and start a new migration lineage.

That reconstruction must never reuse the missing production versions or claim
to be byte-identical historical SQL.

## Mandatory certification gates

On a disposable, isolated Supabase PostgreSQL 17 environment:

1. Start from an empty project and run the exact recovered migration chain with
   `ON_ERROR_STOP`; no manual dashboard DDL is allowed.
2. Run `supabase/tests/database_contract.sql` as a privileged test operator.
3. Execute negative authorization fixtures as anon/authenticated identities:
   missing/wrong pilot key, inactive user, wrong assignee, wrong tenant, wrong
   organization, archived/deleted/delivered task, wrong service/stage/path,
   expired/lost upload and OAuth leases, concurrent booking overlap, duplicate
   provider receipt, and release mutation after approval.
4. Race at least two independent database sessions for booking, dispatch claim,
   OAuth refresh, Xero intent, review publication, and upload completion. Assert
   exactly one winner or safe idempotent reuse as specified.
5. Compare a normalized schema fingerprint with the approved manifest:
   tables/columns/defaults, constraints and validation state, indexes and
   predicates, triggers, function definitions/config/owners/ACLs, RLS flags and
   policies, role/default privileges, extensions, and PostgREST pre-request
   configuration.
6. Re-run Supabase security and performance advisors after applying the full RC.
7. Restore an encrypted backup into a second isolated project, run the same
   contract, and prove rollback from a pre-release snapshot.
8. Only then rehearse on a no-production-data branch, record exact migration
   output/advisors, and schedule production with backup, lock monitoring, and a
   tested rollback decision point.

Relevant current Supabase guidance:

- [Securing the Data API](https://supabase.com/docs/guides/api/securing-your-api)
- [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Database functions and SECURITY DEFINER](https://supabase.com/docs/guides/database/functions)
- [Local development and migrations](https://supabase.com/docs/guides/local-development/overview)

Until every gate is evidenced, the honest database verdict is **release
candidate, not reproducible production baseline**.
