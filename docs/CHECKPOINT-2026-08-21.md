# Northlight remediation checkpoint — 2026-08-21

## Safety and release state

- Working branch: `remediation/ultimate-production-20260819`
- Starting local baseline: `1160cc20044b26a0017df1eb281198b416b9735d`
- Unchanged live production release: `1c9696a463c2d12acf5b5ffe839bd8aa9d75f80f`
- Production deployment, production DDL, provider credentials, and live data were not changed.
- Operations notification recipient remains `pradeeppatilfg@gmail.com`; the former address is absent from the branch.

## Frozen verification

- `npm test`: 182 passed, 0 failed.
- `npm run build`: 83 JavaScript files syntax-checked.
- `git diff --check`: clean; Windows line-ending notices only.
- Focused Calendar/OAuth/database suite: 55 passed.
- Focused Dropbox/database/dispatcher/review suite: 52 passed.
- Focused authentication/availability/hardening suite: 24 passed.

These are local/static and mocked-provider results. They are not a substitute for PostgreSQL replay or credentialed provider UAT.

## Implemented in this checkpoint

1. Atomic login throttling, per-user PBKDF2 migration, credential-version session invalidation, and a required first-login personal-password screen.
2. Photographer-owned weekly availability, days off, special hours, time zone, Calendar health, and fail-closed booking readiness.
3. Calendar-aware scheduling with service/area/working-hours/buffer/conflict checks and atomic booking/reschedule/reassign transitions.
4. OAuth state, PKCE, least-privilege scopes, canonical return origins, refresh leases, reconnect/disconnect fencing, token encryption, and privacy-safe errors.
5. Durable Google Calendar sync/watch lifecycle: bounded work, cursor CAS, 410 recovery, hashed watch tokens, active/draining overlap, renewal maintenance, and retry-safe webhook enqueue.
6. Durable Dropbox sync: bounded pagination/runtime, leases, account/generation fencing, cursor CAS, queue retry/DLQ, recursive folder tombstones, root/account cleanup, and replay ordering.
7. Durable Gmail/Xero intent and reconciliation paths to avoid duplicate external work after ambiguous failures.
8. Database corrective migrations `20260821142000` through `20260821142700`, frozen schema/catalog manifests, and executable/static database contracts.
9. Role-aware navigation, accessible controls, SVG icon system, Photographer control centre, explicit two-way integration flow cards, responsive polish, and recipient visibility.

## Known open release gates

1. Wire `calendar_sync` queue consumption and scheduled `maintainCalendarWatches` into `workers/integration-dispatcher/src/index.js`; Dropbox ownership is now released.
2. Reconstruct or obtain a trustworthy historical PostgreSQL foundation. A from-empty PostgreSQL 17 replay cannot currently be proven because the original foundation migrations are missing from git.
3. Run every migration and database contract on clean PostgreSQL 17, then execute negative RLS and multi-session race tests.
4. Coordinate the eight live legacy `scrypt` accounts through the forced password migration; do not remove the bootstrap credential before all accounts migrate.
5. Perform real staging UAT with separate Google Workspace and Photographer Calendar OAuth clients, Google webhook delivery, Dropbox webhook/large-folder cases, Gmail delivery reconciliation, and Xero organisation/invoice/payment flows.
6. Complete the rendered browser matrix for every role and route, including exact mobile widths, forced-password flow, keyboard/screen-reader behavior, empty/error/loading states, and properly named screenshots in one evidence folder.
7. Capture real Core Web Vitals/performance traces; the required Chrome DevTools measurement was unavailable in the current tool surface.
8. Rehearse backup/restore and rollback, run post-release-candidate database advisors, verify secrets/brand assets/legal usage, and certify the exact immutable artifact before promotion.

## Browser checkpoint note

The forced-password source contract and endpoint behavior are tested green. The first fixture attempt did not activate its query-driven forced-session flag, so a rendered screenshot for that screen remains pending; this is recorded as an evidence-harness issue, not treated as proof of a product pass or product failure.

## Resume order

1. Confirm `git status --short --branch` and rerun `npm test`.
2. Finish the shared Calendar dispatcher wiring and focused queue/scheduled tests.
3. Resolve the PostgreSQL foundation/replay gate before any migration is applied.
4. Run clean-database and staging provider UAT.
5. Complete browser/a11y/performance evidence and named screenshots.
6. Prepare rollback manifest and exact-SHA release certification.
7. Merge/deploy only after every mandatory gate is green or explicitly accepted by the user as a documented risk.
