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

Every push to `northlight-production` should build and deploy automatically. A failed `npm run build` must not replace the last healthy deployment.

## Production environment variables / secrets

Required:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `NORTHLIGHT_DEMO_KEY` (secret)
- `SESSION_SECRET` (secret)
- `TOKEN_ENCRYPTION_KEY` (secret)
- `PILOT_PASSWORD` (secret)

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

## Google OAuth

Create/use a **Web application** OAuth client for the cloud pilot.

Authorised origin:

- `https://northlight-realcapture.pages.dev`

Authorised redirect URIs:

- `https://northlight-realcapture.pages.dev/oauth/google/callback` — shared REALCAPTURE Gmail
- `https://northlight-realcapture.pages.dev/oauth/google-user/callback` — individual Agent/Photographer calendar connection

Keep the OAuth consent application in Testing during the controlled pilot and add each real test Google account as a test user.

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

1. Visit `/api/health` to confirm Pages Functions are running.
2. Sign in as Admin.
3. Visit `/api/preflight`; `ok` should be true and required variables should have no missing entries.
4. Admin → Integrations → connect shared Google Workspace (Gmail).
5. Admin → Integrations → connect Dropbox.
6. Photographer/Agent → Availability → connect personal Google Calendar.
7. Create a real property task and confirm:
   - role-specific calendar conflict check
   - Google event creation on the selected photographer's calendar
   - secure Dropbox service/stage folders
   - real Gmail assignment email
8. Add a file directly in Dropbox and confirm webhook/cursor reconciliation appears in Northlight.
9. Change the shoot time in Google Calendar and confirm incremental sync updates Northlight.
10. When Xero credentials are available, connect Xero and test draft invoice + webhook status reflection.

## Access-control contract

- Admin / REALCAPTURE Owner: full task, RAW, edited, final and finance visibility.
- Agent: own tasks and approved final media only.
- Photographer: assigned tasks, RAW/reference and approved final media.
- Editor: assigned editing tasks, RAW/reference and working edited media.
- Finance/Xero APIs: Admin/Owner only.

Dropbox files are opened through role-checked temporary links. Northlight does not create permanent public task-folder links.

## Security

Never commit provider secrets, refresh tokens, OAuth client secrets, pilot passwords or Northlight database access headers to GitHub. Use Cloudflare Production environment variables/secrets only.
