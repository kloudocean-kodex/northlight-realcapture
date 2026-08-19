# Northlight · REALCAPTURE

Cloudflare Pages + Pages Functions production-pilot for Australian property-media operations.

## Production deployment
Cloudflare Pages is connected to this repository.

Use:
- Production branch: `northlight-production`
- Framework preset: None
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: repository root

Every production-branch push is automatically built and deployed by Cloudflare. The build syntax-checks all frontend and Pages Function JavaScript before producing `dist`; a failed build must not replace the previous good deployment.

Pages Functions remain in the repository-root `functions/` directory, as required by Cloudflare Pages. `_routes.json` limits Functions execution to `/api/*`, `/oauth/*`, and `/webhooks/*`.

## Security
Never commit provider tokens, client secrets, refresh tokens, OAuth credentials, webhook keys, application passwords, or Northlight's database access header. Configure them in Cloudflare Pages > Settings > Variables and Secrets. `.env.example` contains variable names only.

Supabase Row Level Security remains enabled. OAuth/refresh tokens stored in the database are encrypted using `TOKEN_ENCRYPTION_KEY` before persistence. Browser sessions are signed and HttpOnly/Secure. Static security headers are defined in `_headers`.

## Required Cloudflare variables
See `.env.example`.

Core pilot variables:
- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `NORTHLIGHT_DEMO_KEY`
- `SESSION_SECRET`
- `TOKEN_ENCRYPTION_KEY`
- `PILOT_LOGIN_PASSWORD`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GMAIL_FROM`
- `DEMO_EMAIL_TO`
- `DROPBOX_APP_KEY`
- `DROPBOX_APP_SECRET`
- `DROPBOX_ROOT`

Optional until Xero is connected:
- `XERO_CLIENT_ID`
- `XERO_CLIENT_SECRET`
- `XERO_WEBHOOK_KEY`

WhatsApp is intentionally disabled for the current REALCAPTURE pilot.

## OAuth redirect URLs
Production origin: `https://northlight-realcapture.pages.dev`

Google shared Workspace/Gmail:
- `https://northlight-realcapture.pages.dev/oauth/google/callback`

Google user-owned Photographer Calendar:
- `https://northlight-realcapture.pages.dev/oauth/google-user/callback`

Dropbox:
- `https://northlight-realcapture.pages.dev/oauth/dropbox/callback`

Xero:
- `https://northlight-realcapture.pages.dev/oauth/xero/callback`

## Webhooks
Dropbox:
- `https://northlight-realcapture.pages.dev/webhooks/dropbox`

Google Calendar watch notifications:
- `https://northlight-realcapture.pages.dev/webhooks/google-calendar`

Xero:
- `https://northlight-realcapture.pages.dev/webhooks/xero`

## Operational architecture
- Northlight/Supabase: users, roles, tasks, schedule state, issues, comments, audit, sync state, invoice visibility
- Dropbox: RAW / edited / final media and service folders
- Google Calendar: each connected Photographer owns their external schedule; Northlight creates/reschedules/cancels events and ingests external changes
- Gmail: operational email notifications
- Xero: accounting system of record; Northlight reflects invoice/payment state

External changes are logged rather than silently overwriting operational history. Google Calendar deletions become review exceptions rather than automatically cancelling the Northlight task.

## Health checks
Public infrastructure health:
- `/api/health`

Admin-only deployment/integration preflight:
- `/api/admin/preflight`

Owner/Admin operations stream:
- `/api/operations/activity`

## Local development
Wrangler is optional because GitHub pushes deploy automatically through Cloudflare. It is useful for developer testing and logs.

```bash
npm install
npm run build
npm run dev
```

## Commercial hardening after the controlled pilot
Before broad customer rollout, complete individual-password migration and remove the shared pilot password, add managed password recovery/MFA, make the repository private, configure production OAuth consent/verification as required, add scheduled reconciliation/watch renewal, tenant onboarding, rate limits, monitoring/alerts, backups and formal data-retention/privacy controls.
