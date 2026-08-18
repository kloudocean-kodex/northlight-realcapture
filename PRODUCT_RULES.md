# Northlight Product Rules

These are product invariants. Future human/AI changes must preserve them unless an explicit architecture decision replaces them.

## Product principle

Northlight owns **what happens next**. Specialist systems remain authoritative for their specialist data:

- Northlight: booking, assignment, workflow, approvals, operational activity.
- Dropbox: media objects.
- Google Calendar: connected external calendar events.
- Xero: accounting.
- Gmail / future WhatsApp: message delivery.

## UX

- Non-technical users should understand their next action within seconds.
- Keep Agent booking simple. Current REALCAPTURE pilot uses **Standard booking only**; no Priority/Rush choice in ordinary Agent UX.
- Exception-first: normal work stays quiet; `Needs attention` contains actionable exceptions.
- Never expose raw OAuth/provider errors to ordinary users.
- One obvious primary action per screen.

## Photographer selection

- Do not use confusing `perfect match` language.
- A photographer is **eligible** only when configured for the selected area and every requested service.
- Among eligible photographers Northlight may show **Recommended** / **Available** using workload/calendar/travel intelligence.
- Ineligible photographers may be shown to Admin as `Needs setup`, but must never be assignable by an Agent.
- Calendar/working-hour checks happen before final assignment.

## Task lifecycle

- Task creation is idempotent. Never create duplicate tasks/provider side effects from repeated clicks/retries.
- Integration failure must not erase an authoritative Northlight task.
- Completed/cancelled work is normally **archived**, not deleted.
- Archive preserves audit/history and can be restored by Owner/Admin.
- Delete/remove is Admin-only and must be refused when external/media/finance history exists.
- Audit events are append-only business history.

## Media access

- Admin / REALCAPTURE Owner: RAW, edited, final, reference and finance.
- Agent: own task metadata + approved client-facing final media; no RAW/working edits/internal finance.
- Photographer: assigned task RAW/reference + appropriate final context; no finance.
- Editor: assigned RAW/reference + working edits/review-ready output; no finance.
- File access must be enforced server-side. Hiding a button is never authorization.
- Do not create permanent public Dropbox task-folder links. Use role-checked temporary links.
- Large media uploads go browser → provider directly; do not proxy large media through Cloudflare Functions.

## Integrations

- OAuth credentials/tokens never enter GitHub or browser JavaScript.
- Webhooks are verified and reconciliation is idempotent.
- Calendar external deletion/change must not silently destroy Northlight business history.
- Xero remains accounting source of truth.
- WhatsApp remains optional/disabled for the current REALCAPTURE pilot until a proper approved production configuration exists.

## Tenancy / future SaaS

- `tenant_id` is a permanent core concept even while REALCAPTURE is the only pilot tenant.
- Before multi-customer rollout, tenant isolation must be database-enforced and tested against cross-tenant access.
- Never reuse the pilot magic-key/RLS approach as the final multi-tenant trust model.
