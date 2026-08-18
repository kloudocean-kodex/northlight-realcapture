# Northlight · REALCAPTURE

Cloudflare Pages + Pages Functions production-pilot for property-media operations.

## Deployment
Cloudflare Pages is connected to this GitHub repository. Set the production branch to `northlight-production`, build command empty, output directory `/`.

Static UI is served from `index.html`. Server-side routes live under `functions/` and only `/api/*`, `/oauth/*`, and `/webhooks/*` invoke Pages Functions via `_routes.json`.

## Security
Never commit provider tokens or OAuth secrets. Configure all real secrets in Cloudflare Pages > Settings > Environment variables / Secrets. `.env.example` contains names only.

## Local development
Wrangler is optional for deployment because GitHub auto-deploys through Cloudflare. Use it only for local Pages Functions development/logging:

```bash
npm install
npm run dev
```

## Current pilot integrations
- Supabase: structured workflow state and role data
- Google: Gmail + Calendar, with webhook/incremental-sync support
- Dropbox: OAuth-ready task folders, direct temporary upload links, webhook sync
- Xero: OAuth-ready invoicing integration
- WhatsApp: intentionally disabled for the REALCAPTURE pilot
