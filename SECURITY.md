# Northlight Security Baseline

## Current controlled pilot

- Cloudflare Pages / Functions is the application boundary.
- Supabase/Postgres is persistent operational state.
- Provider secrets are stored only in Cloudflare environment secrets.
- OAuth tokens are encrypted before persistence.
- Sessions use signed Secure/HttpOnly cookies.
- Role/resource authorization is enforced server-side.
- Dropbox client media access is role checked and temporary.
- Agent delivery media is pinned to an immutable approved manifest; every temporary link rechecks Dropbox ID, revision, hash, size and path.

## Never do

- Never commit `.env`, OAuth tokens, refresh tokens, app secrets or production credentials.
- Never send provider secrets to browser JavaScript.
- Never bypass role/task ownership checks for convenience.
- Never expose another tenant's data.
- Never treat provider failure as permission to create duplicate business records.
- Never expose raw provider stack traces/errors to non-admin users.
- Never hard-delete audited/completed business history when Archive is sufficient.

## Before unrestricted commercial multi-tenant rollout

Required hardening milestone:

1. Rotate all pilot/provider credentials that were shared outside their intended secret stores.
2. Make production repository private and enable secret scanning/push protection where available.
3. Replace pilot database magic-key access with tenant-aware database authorization/RLS.
4. Add session revocation/versioning and managed password reset/MFA.
5. Add login rate limiting / abuse protection and CSRF/origin checks for mutations.
6. Add automated authorization/IDOR tests for every role/resource combination.
7. Add structured error codes, correlation/request IDs and provider operation logs.
8. Add reconciliation/watch-renewal schedules for Calendar/Dropbox/Xero.
9. Add transaction/outbox/queue semantics before high-volume integrations.
10. Establish backup, restore drill, retention and incident-response runbooks.

## Authorization test matrix (minimum)

- Agent A cannot read Agent B's task unless explicitly granted.
- Agent cannot retrieve RAW or working-edited media.
- Photographer cannot access unassigned tasks or finance.
- Editor cannot access unassigned tasks or finance.
- Owner/Admin can read authorised tenant operations/finance.
- Archived tasks are hidden from ordinary operational roles.
- Removed tasks are not retrievable through normal task APIs.
- Disabled/revoked users must eventually invalidate active sessions in the commercial auth model.
