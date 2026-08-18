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
- Keep Agent booking simple. Current REALCAPTURE pilot uses **Standard booking only**; no Priority/Rush choice in ordinary Agent UX or database state.
- Exception-first: normal work stays quiet; `Needs attention` contains actionable exceptions.
- Never expose raw OAuth/provider errors to ordinary users.
- One obvious primary action per screen.
- Use exact brand casing **ProddyG**, linked to `https://proddyg.com` where the crafted-by credit appears.

## Photographer selection and scheduling

- Do not use confusing `perfect match`, `full match` or percentage-score language in ordinary Agent UX.
- A photographer is **eligible** only when active and configured for the selected area and every requested service.
- Among eligible photographers Northlight may show **Recommended** / **Available** using workload/calendar/travel intelligence.
- Ineligible photographers may be shown to Admin as `Needs setup`, but must never be assignable by an Agent.
- Booking and rescheduling must use the same scheduling truth: service duration, buffers, working hours, Northlight bookings and connected Google Calendar.
- If availability cannot be verified, do not show a misleading green `Available` state.
- Photographer decline must be recoverable by validated reassignment without recreating the task.
- External Google Calendar time/deletion changes are proposals/exceptions, not permission to silently mutate the Northlight business booking.
- A connected personal Google Calendar is a Photographer capability, not an Agent/Editor integration.

## Task lifecycle

- Task creation is idempotent. Never create duplicate tasks/provider side effects from repeated clicks/retries.
- Creating the authoritative Northlight task must remain small and reliable. Dropbox, Calendar and Email are separate idempotent hand-offs; one provider failure must not make the UI claim the task itself failed.
- Integration failure must not erase an authoritative Northlight task.
- Completed/cancelled work is normally **archived**, not deleted.
- Archive preserves audit/history and can be restored by Owner/Admin.
- Archived tasks are server-side read-only for ordinary workflow mutations and hidden from non-management daily operations.
- Delete/remove is Admin-only and must be refused when external/media/finance history exists.
- Audit events are append-only business history.

## Roles and operational recovery

- Admin: platform/workspace administration plus full operational recovery.
- Owner: business-wide operational visibility/recovery and finance; no safe-test hard delete/admin credential management.
- Agent: own properties, simple booking, review/delivery, own-task reschedule/cancel, and declined-photographer recovery.
- Photographer: assigned bookings, confirm/decline, source uploads, own availability/Calendar; cannot cancel the business task.
- Editor: assigned post-production queue, edited/final uploads and revisions.
- Admin/Owner can assign/change the accountable Editor when source media/revision work is waiting.
- Deactivation is blocked while the user still owns active work; reassign/close work first.
- Protected requests must revalidate the current active user/role; do not trust a stale role stored only in a cookie.

## Media access and completeness

- Admin / REALCAPTURE Owner: RAW, edited, final, reference and finance.
- Agent: own task metadata + approved client-facing final/reference media; no RAW/working edits/internal finance.
- Photographer: assigned task RAW/reference + appropriate final context; no finance.
- Editor: assigned RAW/reference + working edits/review-ready output; no finance.
- File access must be enforced server-side. Hiding a button is never authorization.
- Do not create permanent public Dropbox task-folder links. Use role-checked temporary links.
- Large media uploads go browser → provider directly; do not proxy large media through Cloudflare Functions.
- A multi-service task cannot advance from source → editing → review → delivery until required media coverage exists for each requested service.
- Dropbox reconciliation must batch database work; never perform several backend requests per media file in a Worker invocation.

## Issues, comments and revision instructions

- Conversation is normal property discussion; Issues are operational exceptions needing follow-up.
- Property participants may see/raise issues; Admin/Owner/property Agent controls resolution/reopen.
- Revision requests must include usable instructions and preserve them in the property conversation before the workflow moves to Revision.

## Notifications

- Assignment notification goes to the assigned Photographer's real email when configured.
- `.local`/pilot addresses fall back to the Admin/Owner-managed tenant Operations Email.
- Normal Agents cannot redirect system notifications to arbitrary recipients during booking.
- Operational comment/issue alerts use the tenant Operations Email.
- Notification/provider retries must remain idempotent.

## Integrations

- OAuth credentials/tokens never enter GitHub or browser JavaScript.
- Shared Google OAuth is for Northlight operational mail; personal Photographer Google OAuth is for Calendar.
- Webhooks are verified and reconciliation is idempotent.
- Calendar external deletion/change must not silently destroy or overwrite Northlight business history.
- Xero remains accounting source of truth; one Northlight task must not create duplicate Xero draft invoices on retry.
- WhatsApp remains optional/disabled for the current REALCAPTURE pilot until a proper approved production configuration exists.

## Tenancy / future SaaS

- `tenant_id` is a permanent core concept even while REALCAPTURE is the only pilot tenant.
- Before multi-customer rollout, tenant isolation must be database-enforced and tested against cross-tenant access.
- Never reuse the pilot magic-key/RLS approach as the final multi-tenant trust model.
