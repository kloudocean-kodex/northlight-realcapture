# Northlight · REALCAPTURE Cloud Deployment

Production branch: `northlight-production`

Public pilot URL: `https://northlight-realcapture.pages.dev`

## Cloudflare Pages

- Framework preset: None
- Production branch: `northlight-production`
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: `/`
- Pages Functions directory: `/functions` (auto-detected)

Every push to `northlight-production` should build and deploy automatically. `npm run build` is the production certification gate: it syntax-checks the application and executes the Northlight certification tests. A failed build/test must not replace the last healthy deployment.

## Release identity and live verification

A GitHub commit is **not** considered live merely because it was merged to `northlight-production`.

After every production promotion:

1. Resolve the current `northlight-production` GitHub head SHA.
2. Read `https://northlight-realcapture.pages.dev/api/health`.
3. Require `ok: true`.
4. Require `deployment.commitSha` to equal that GitHub head SHA (or a deliberately approved later production SHA).
5. Only then describe the release as live.

The build also writes non-secret `build-info.json` for release diagnostics. Never place secrets or integration tokens in build identity metadata.

## Production environment variables / secrets

Required:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `NORTHLIGHT_DEMO_KEY` (secret)
- `SESSION_SECRET` (secret)
- `TOKEN_ENCRYPTION_KEY` (secret)
- `PILOT_LOGIN_PASSWORD` (secret; controlled-pilot compatibility only, not the long-term individual-user auth model)

Google Workspace:

- `GOOGLE_CLIENT_ID` (secret/config)
- `GOOGLE_CLIENT_SECRET` (secret)
- `GMAIL_FROM`
- `DEMO_EMAIL_TO`

Dropbox:

- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET` (secret)
- `DROPBOX_ROOT=/Northlight`

Xero (optional until REALCAPTURE connects Xero):

- `XERO_CLIENT_ID`
- `XERO_CLIENT_SECRET` (secret)
- `XERO_WEBHOOK_KEY` (secret)

WhatsApp is intentionally disabled for this pilot.

## Scheduling invariant

Preview, Create, Reschedule and Reassign must consume Northlight's shared scheduling evaluator. For the proposed Photographer/time it evaluates:

- active Photographer account and role
- configured area
- every selected service
- selected-service duration
- selected-service buffers
- Photographer working hours
- days off and special days
- active Northlight booking conflicts
- connected Google Calendar busy periods

Do not create a second independent availability truth in frontend code or a new API route.

## Durable external hand-offs

The Northlight task is authoritative. Dropbox, Google Calendar and Gmail hand-offs are separate external operations and are tracked in the Supabase `task_handoffs` outbox.

- A task remains safe if an external provider fails.
- Pending/attention hand-offs are retryable on later eligible workspace activity.
- Calendar cleanup obligations are retained when a task is cancelled or reassigned.
- Provider secrets/tokens are never stored in the hand-off outbox.

## Google OAuth

Create/use a **Web application** OAuth client for the cloud pilot.

Authorised origin:

- `https://northlight-realcapture.pages.dev`

Authorised redirect URIs:

- `https://northlight-realcapture.pages.dev/oauth/google/callback` — shared REALCAPTURE Gmail
- `https://northlight-realcapture.pages.dev/oauth/google-user/callback` — individual Agent/Photographer calendar connection

Keep the OAuth consent application in Testing only during the controlled pilot and add each real test Google account as a test user. Before unattended daily production use, move through the appropriate Google production/verification process so the pilot does not depend on recurring test-mode reauthorization.

## Dropbox developer app

Use the existing App Folder application.

OAuth redirect URI:

- `https://northlight-realcapture.pages.dev/oauth/dropbox/callback`

Webhook URI:

- `https://northlight-realcapture.pages.dev/webhooks/dropbox`

Northlight requests offline OAuth access so short-lived Dropbox access tokens can refresh automatically.

## Google Calendar webhook

Northlight creates Calendar watch channels programmatically. Provider notification endpoint:

- `https://northlight-realcapture.pages.dev/webhooks/google-calendar`

No manual Google webhook registration is required beyond a public HTTPS Northlight deployment.

## Xero

OAuth redirect URI:

- `https://northlight-realcapture.pages.dev/oauth/xero/callback`

Webhook URI:

- `https://northlight-realcapture.pages.dev/webhooks/xero`

Invoice and pricing endpoints are restricted to Northlight Admin/Owner signed sessions.

## Post-deployment sequence

1. Verify production GitHub head against `/api/health` deployment identity.
2. Sign in as Admin.
3. Visit `/api/preflight`; `ok` should be true and required variables should have no missing entries. Confirm its deployment identity matches `/api/health`.
4. Admin → Integrations → verify shared Google Workspace (Gmail).
5. Admin → Integrations → verify Dropbox.
6. Photographer → Availability → verify personal Google Calendar connection.
7. Create a realistic Melbourne property task and confirm:
   - role-specific eligibility
   - Preview/Create scheduling parity
   - Google event creation on the selected Photographer's calendar
   - secure Dropbox service/stage folders
   - real Gmail assignment email or intentional operations fallback
8. Add a file directly in Dropbox and confirm webhook/cursor reconciliation appears in Northlight.
9. Change the shoot time in Google Calendar and confirm incremental sync requires/handles Northlight review correctly.
10. Complete Photographer → Editor → Agent review/revision/delivery flow using every selected service.
11. Confirm archived tasks are read-only and retained for audit.
12. When Xero credentials are available, connect Xero and test draft invoice + webhook status reflection.

## Access-control contract

- Admin / REALCAPTURE Owner: full task, RAW, edited, final and finance visibility.
- Agent: own tasks, simple Standard booking, Reference upload and approved final media; no RAW/working edits/internal finance.
- Photographer: assigned tasks, confirm/decline/reschedule within policy, RAW/Reference upload and approved final media; cannot cancel the business task.
- Editor: assigned editing queue, RAW access and Edited/Final/Reference upload; no finance.
- Finance/Xero APIs: Admin/Owner only.
- Credential/team-account administration: Admin only.

Dropbox files are opened through role-checked temporary links. Northlight does not create permanent public task-folder links.

## Security

Never commit provider secrets, refresh tokens, OAuth client secrets, pilot passwords, Supabase backend trust values or session secrets to GitHub. Use Cloudflare Production environment variables/secrets and protected integration state only.

The old local pilot ZIP is not an authority for cloud credentials and any credentials once present there must remain treated as burned/rotated.
