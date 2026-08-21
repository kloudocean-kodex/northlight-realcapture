# Northlight · REALCAPTURE Cloud Deployment

Production branch: `northlight-production`

Public pilot URL: `https://northlight-realcapture.pages.dev`

## Release safety invariant

`northlight-production` is the only Cloudflare Pages production branch. Preview, hardening, certification and remediation branches must never be treated as production releases and must never publish jobs into production infrastructure.

Do not promote a remediation commit merely because its static assets build. Production promotion requires the database, Pages Functions, provider integrations, dispatcher, browser certification and release attestation gates to be green together.

## Cloudflare Pages

- Framework preset: None
- Production branch: `northlight-production`
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: `/`
- Pages Functions directory: `/functions` (auto-detected)

Every push to `northlight-production` should build and deploy automatically. A failed `npm run build` or failed Functions publication must not replace the last healthy deployment.

### Pages configuration source of truth

The existing Pages project is currently **dashboard-managed**. There must be no deployment-enabled root `wrangler.json`, `wrangler.jsonc` or `wrangler.toml` checked into the repository until the real dashboard configuration has been downloaded and reconciled.

Cloudflare's required migration procedure for an existing dashboard-managed Pages project is:

1. Authenticate Wrangler against the correct Cloudflare account.
2. Run `npx wrangler pages download config northlight-realcapture` from a clean working copy.
3. Review the generated configuration against the dashboard's **Production** and **Preview** variables, secrets, compatibility settings and bindings.
4. Confirm that no secret value will be committed to Git.
5. Confirm explicit Production/Preview overrides for every non-inheritable binding.
6. Only then consider committing a Pages Wrangler file and deliberately migrating the dashboard project to repository configuration as source of truth.

Do **not** hand-author `pages_build_output_dir` into a partial root Wrangler file. Doing so opts Pages into that file as deployment configuration and can replace dashboard configuration for the affected environment.

### Current Preview recovery

A preview deployment previously opted the Pages project into a partial Wrangler configuration containing `TASK_HANDOFF_QUEUE -> northlight-task-handoffs`. The named Queue did not exist, and the Preview deployment configuration retained that binding. This is why later verification branches can report `No Wrangler configuration file found` yet still fail Function publication with `Queue 'northlight-task-handoffs' not found`.

Before further Preview UAT, reconcile the Preview Functions settings in the Cloudflare dashboard and remove that stale production-named Queue binding. Do not create `northlight-task-handoffs` merely to make Preview deployments green.

## Queue and dispatcher isolation

Northlight persists system jobs in the Supabase outbox before attempting Cloudflare Queue publication. The Queue is an accelerator/dispatch transport; the database outbox remains the durable recovery source.

Environment resources are intentionally separate:

| Environment | Pages producer binding | Queue | Consumer Worker | DLQ |
| --- | --- | --- | --- | --- |
| Preview / staging | `TASK_HANDOFF_QUEUE` | `northlight-task-handoffs-preview` | `northlight-integration-dispatcher-preview` | `northlight-task-handoffs-preview-dlq` |
| Production | `TASK_HANDOFF_QUEUE` | `northlight-task-handoffs` | `northlight-integration-dispatcher` | `northlight-task-handoffs-dlq` |

The dedicated Worker configurations live under `workers/integration-dispatcher/`. `npm run check:dispatcher` dry-runs both production and preview Worker contracts.

Rules:

- Never bind a Preview Pages deployment to `northlight-task-handoffs`.
- Never deploy the preview dispatcher with production/pilot database credentials.
- Never point the production dispatcher at a preview Queue or preview database.
- Create the Queue and DLQ resources before adding their Pages/Worker bindings.
- Pages Functions are producers only; Queue consumption belongs to the dedicated dispatcher Worker.
- Keep Worker observability/tracing on the dedicated Worker configuration, not in Pages configuration.

## Production environment variables / secrets

Required:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `NORTHLIGHT_DEMO_KEY` (secret)
- `SESSION_SECRET` (secret)
- `TOKEN_ENCRYPTION_KEY` (secret)
- `PILOT_LOGIN_PASSWORD` (secret during gradual account migration)

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

Preview/staging must use its own explicitly reviewed values and must not silently inherit production provider credentials or production/pilot database access.

## Google OAuth

Create/use a **Web application** OAuth client for the cloud pilot.

Authorised origin:

- `https://northlight-realcapture.pages.dev`

Authorised redirect URIs:

- `https://northlight-realcapture.pages.dev/oauth/google/callback` — shared REALCAPTURE Gmail
- `https://northlight-realcapture.pages.dev/oauth/google-user/callback` — individual Photographer calendar connection

Keep the OAuth consent application in Testing during the controlled pilot and add each real test Google account as a test user. Before a sustained production pilot, publish/verify the OAuth consent application as appropriate so Calendar/Gmail refresh access is not dependent on Testing-mode token lifetime.

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

## Staging infrastructure gate

Before provider UAT or dispatcher deployment, create an isolated staging backend. A Preview Pages deployment or preview dispatcher must not be allowed to mutate the production/pilot Supabase project merely because the UI is non-production.

Minimum staging gate:

1. Isolated Supabase development/staging database with the full candidate migration history replayed from zero.
2. Preview-only Cloudflare Queue and DLQ.
3. `northlight-integration-dispatcher-preview` deployed with staging-only secrets.
4. Preview Pages Functions configured with staging-only variables/secrets and `northlight-task-handoffs-preview` producer binding.
5. Provider test credentials/callbacks scoped for staging where the provider supports it.
6. End-to-end Queue → consumer → retry → DLQ → database outbox recovery proof.

## Post-deployment sequence

1. Visit `/api/health` to confirm Pages Functions are running and the deployment SHA matches the intended `northlight-production` commit.
2. Sign in as Admin.
3. Visit `/api/preflight`; `ok` should be true and required variables should have no missing entries.
4. Admin → Integrations → connect shared Google Workspace (Gmail).
5. Admin → Integrations → connect Dropbox.
6. Photographer → Availability → connect personal Google Calendar.
7. Create a real property task and confirm:
   - role-specific calendar conflict check
   - Google event creation on the selected Photographer's calendar
   - secure Dropbox service/stage folders
   - real Gmail assignment email
8. Add a file directly in Dropbox and confirm webhook/cursor reconciliation appears in Northlight.
9. Change the shoot time in the Photographer's Google Calendar and confirm incremental sync updates Northlight.
10. Confirm Queue consumption, retries, dead-letter behavior and database outbox recovery under controlled failure injection.
11. When Xero credentials are available, connect Xero and test draft invoice + webhook status reflection.
12. Re-run signed-out security smoke, role-by-role browser UAT, accessibility checks and deployed-artifact SHA/byte attestation.

## Access-control contract

- Admin / REALCAPTURE Owner: full task, RAW, edited, final and finance visibility.
- Agent: own tasks and approved final media only.
- Photographer: assigned tasks, RAW/reference and approved final media; personal Google Calendar connection.
- Editor: assigned editing tasks, RAW/reference and working edited media.
- Finance/Xero APIs: Admin/Owner only.

Dropbox files are opened through role-checked temporary links. Northlight does not create permanent public task-folder links.

## Security

Never commit provider secrets, refresh tokens, OAuth client secrets, pilot passwords, Cloudflare API tokens or Northlight database access headers to GitHub. Use scoped environment secrets in the appropriate platform/environment only.

Before production promotion, review and rotate any credential that has been copied through ad-hoc deployment material, remove stale recipient/config values, and verify the final environment inventory against the release manifest.
