# Northlight Multi-Organization Architecture Contract

Status: **rollout contract / not yet enabled for a second customer**.

The current REALCAPTURE production deployment remains a controlled, single-tenant pilot. This document defines the next authorization layer required for Pankaj's real operating model without changing the product promise:

> **One property. One clear workflow.**

Northlight must become organization-aware without becoming a CRM, ERP, marketing suite or generic enterprise portal.

## 1. Business model Northlight must support

### REALCAPTURE / media provider

Pankaj owns the media-provider operation and has Photographers, Editors and potentially other tightly scoped operational staff. He needs full provider visibility and authority across the client organizations that REALCAPTURE services.

For the current pilot, Pankaj maps to the existing `Admin` role because that is the only existing role with genuinely complete workspace authority. This is a compatibility mapping, not the final multi-organization authorization model.

### Client real-estate organization

A client company has an Owner / Principal and many Agents.

- Client Owner / Principal sees their own company, team and all of that company's property tasks.
- Agent books properties and, by default, sees only tasks for which the Agent is the authoritative participant.
- Client users never see another client company's tasks, people, files, accounting or integration state.

### Provider delivery team

- Photographer sees assigned work only and manages their own availability / personal Google Calendar.
- Editor sees assigned post-production work only.
- Provider Owner/Admin sees all provider-serviced work and the client context required to operate it.

## 2. Isolation layers

Northlight deliberately separates two concepts.

### Tenant / workspace

The hard security, commercial, branding and deployment boundary.

The current tenant is the REALCAPTURE service network. A future independently operated white-label media business should receive its own tenant/workspace rather than being mixed into REALCAPTURE's data boundary.

A second tenant must **not** be added to the current pilot database until tenant-aware application queries and database RLS are complete. Until then, production has an interim fail-closed database guard: if the tenant count is no longer exactly one, pilot data access through the current exposed roles is denied.

### Organization

A business entity inside a tenant.

Initial organization types:

- `provider` — the media-service business such as REALCAPTURE;
- `client` — a real-estate company receiving the service.

A REALCAPTURE tenant can contain one provider organization and many connected client organizations.

## 3. Future authoritative data model

The following model is required before multi-company rollout. It is intentionally documented before data is created so we do not fabricate companies or guess memberships.

### `organizations`

- `id`
- `tenant_id`
- `type` (`provider` | `client`)
- `slug`
- `name`
- `brand_name`
- `active`
- `settings`
- timestamps

### `organization_memberships`

- `organization_id`
- `user_id`
- `membership_role`
- `active`
- timestamps

Keep membership roles small. Initial roles are enough:

- `provider_owner`
- `photographer`
- `editor`
- `client_owner`
- `agent`

Do not add dozens of micro-roles or arbitrary per-user permission switches. Add a new role only when a real workflow cannot be represented safely by an existing one.

### `organization_relationships`

- `tenant_id`
- `provider_org_id`
- `client_org_id`
- relationship type, initially `media_service`
- `active`
- relationship settings
- timestamps

A provider can service many clients. A client can see provider-facing information only through its active service relationship.

### `tasks`

Before multi-organization rollout, every property task needs trusted organization context:

- `provider_org_id`
- `client_org_id`
- `booked_by_user_id`
- existing Agent / Photographer / Editor participant fields remain

Organization identifiers are derived by the server from authenticated membership and an active provider-client relationship. A browser-supplied organization ID is never sufficient authorization.

The current `users.role_code` is a pilot compatibility persona. Once organization memberships are enabled, it must not remain the sole authorization source for cross-company access.

## 4. Authority model

### Pankaj / tenant administrator + provider owner

Can:

- see every provider-serviced property task in the REALCAPTURE tenant;
- see and manage the provider team;
- see connected client organizations and the client-team context needed to operate their work;
- manage provider services, availability, assignment/recovery, integrations and provider finance;
- manage client relationships and onboarding;
- see audit history across the tenant.

Must not:

- silently impersonate another user;
- bypass audit history for privileged actions;
- receive authority in an unrelated future tenant merely because the same email/name exists there.

If platform-level support across unrelated tenants is ever introduced, it must be a separate auditable control-plane capability with an explicit reason/time boundary, not a hidden application role.

### Provider Owner/Admin

Can:

- see all tasks serviced by their provider organization;
- manage provider Photographers and Editors;
- manage provider availability, services and integrations;
- manage provider accounting where enabled;
- see connected client organizations through active relationships.

Cannot see unrelated tenants or unrelated providers.

### Client Owner / Principal

Can:

- see all property tasks belonging to their own client organization;
- see/manage their own Agents;
- create and manage bookings for their company;
- recover/reassign company-side ownership when an Agent leaves, with audit history;
- review delivery and client-facing invoice/payment status where enabled.

Cannot see:

- another client company;
- provider-internal operational finance;
- unrelated RAW/working media;
- provider secrets or integration credentials.

### Client Agent

Default access:

- create **Standard** property bookings for their client organization;
- see their own tasks;
- select from eligible Photographers exposed by Northlight;
- reschedule/cancel their own pre-shoot task within lifecycle rules;
- recover their own task after Photographer decline;
- comment, raise issues, upload references, review/revise and approve client-facing final delivery.

Cannot see another client organization, provider RAW/working edits, finance administration, integration secrets or broad team administration.

If a real client later requires shared Agent-team visibility, implement it as an explicit organization policy such as `agent_task_visibility = own | team`, default `own`, with tests. Do not broaden every Agent by default.

### Photographer

Can:

- see assigned tasks only;
- confirm/decline;
- perform allowed pre-shoot rescheduling;
- manage own Northlight availability and personal Google Calendar;
- upload RAW/reference media;
- participate in task comments/issues.

Cannot cancel the business task, browse unrelated jobs, administer client companies or see finance.

### Editor

Can:

- see assigned editing/revision work only;
- access assigned RAW/reference media;
- upload Edited/Final/Reference media;
- work revisions and task comments/issues.

Cannot browse unrelated client companies, provider administration or finance.

## 5. Relationship-aware visibility rule

**Default is deny.** A role label alone is not enough.

A task is visible only when a justified relationship is true:

- tenant administrator has authority over the task's tenant;
- provider owner/admin belongs to `task.provider_org_id`;
- client owner belongs to `task.client_org_id`;
- Agent is the authoritative Agent/booking participant, or an explicitly enabled client-org team policy permits visibility;
- Photographer is assigned to the task;
- Editor is assigned to the task.

Team directories use the same rule:

- Pankaj/provider authority sees provider team plus connected client organizations;
- client Owner sees their own client team plus only provider-facing people necessary for their company's work;
- Agent/Photographer/Editor do not receive broad cross-company directories.

Search, exports, reports, notifications and file-link generation must apply the same scope as the underlying record. A hidden UI control is never authorization.

## 6. Lifecycle and edge cases

### Agent leaves a client company

- deactivate membership;
- preserve historical audit attribution;
- client Owner can transfer open task ownership where business rules allow;
- no historical task is silently rewritten to pretend another Agent created it.

### Photographer/Editor leaves provider

- deactivate membership/profile for new assignment;
- historical task/file/audit records remain intact;
- active work is explicitly reassigned/recovered.

### Client relationship ends

- deactivate provider-client relationship;
- block new bookings;
- retain historical tasks and audit according to retention policy;
- revoke ongoing client access according to contract/offboarding policy rather than deleting operational history.

### Provider reconnects a client

Reactivation is explicit and audited. Do not infer an active commercial relationship merely because old tasks exist.

### Client company changes name/brand

Organization identity remains stable; display metadata changes without rewriting historical task ownership.

### Duplicate/similar company names

Authorization uses immutable organization IDs, never display names, domains or free-text company names.

### User has multiple legitimate responsibilities

Do not solve this with a blanket super-role. Effective authority is the union of active, justified memberships inside the same tenant, with sensitive actions still server-authorized and audited.

### Branch/office managers or booking coordinators

Do not pre-build roles speculatively. If a large client proves this need, add the smallest organization-scoped capability and negative tests; never widen all client Owners/Agents as a shortcut.

## 7. Integration ownership

### Google Calendar

Personal Google Calendar remains **Photographer-only**. Tokens belong to the Photographer user integration and are never shared with a client organization.

### Gmail / shared operational email

Provider/workspace transport. Recipient routing is server-derived from the task and operational fallback rules. An Agent cannot redirect an assignment notification to an arbitrary recipient.

### Dropbox

Provider media system of record. Future folder/index metadata must carry trusted tenant/provider/client/task context. Temporary media links remain role- and task-checked.

### Xero

Provider organization accounting connection. Invoice records are linked to the relevant client/task; client Owner may see justified client-facing status, but provider accounting configuration, credentials and unrelated invoices remain private.

### WhatsApp

Optional; remains disabled in the current pilot until a proper approved production configuration and business requirement exist.

OAuth/provider secrets stay server-side and encrypted. One organization can never choose, inspect or reuse another organization's credentials.

## 8. UI/UX contract

The data model must not leak complexity into normal work.

### Pankaj/provider owner

Provider operations first. Add a quiet client-organization scope/filter only where cross-client navigation is useful. No giant enterprise permission matrix on the home screen.

### Client Owner

Their company, team, all company property tasks, exceptions and what needs attention.

### Agent

Own tasks, booking, comments/issues and review/delivery actions.

### Photographer

Assigned work + availability + personal Calendar.

### Editor

Assigned post-production queue.

If a user has only one legitimate organization, do not show a pointless organization switcher.

The visual direction remains premium, quiet, editorial, Australian, minimal and operational. SVG iconography, responsive focus behavior and accessibility remain part of the acceptance contract; multi-organization capability is not permission to clutter the interface.

## 9. Audit requirements

Audit events for multi-organization actions must include enough immutable context to answer:

- which tenant;
- provider organization;
- client organization;
- task;
- acting user;
- effective membership/authority;
- action;
- timestamp;
- before/after or reason where applicable.

Relationship changes, membership changes, privileged reassignment, integration changes and support elevation are auditable events.

## 10. Rollout gates before a second tenant or real client-company isolation claim

All gates must be green:

1. Organization / membership / relationship schema deployed.
2. Existing REALCAPTURE people are mapped from confirmed business facts; no invented memberships.
3. Every task has trusted provider/client organization context.
4. Session/auth context resolves tenant + justified memberships server-side.
5. Every API read/write is tenant/org scoped; guessed IDs cannot escape scope.
6. Database RLS independently enforces tenant/org isolation.
7. Per-organization integration ownership is enforced.
8. File access, search, exports, reporting, notifications and finance obey the same scope.
9. Cross-tenant and cross-organization **negative tests** cover every role and sensitive resource.
10. Audit logging covers onboarding, membership, relationship and privileged operations.
11. Desktop + real-mobile role journeys pass.
12. One real end-to-end property flow passes across provider + client roles.
13. The interim single-tenant fail-closed guard is removed only in the same controlled release that introduces the complete replacement authorization layer.

Until all of these are green, Northlight may be a strong REALCAPTURE production pilot, but it must **not** claim safe multi-company SaaS isolation.
