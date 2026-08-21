import { requireSession, json, error, tenant, integration, supa } from '../../_lib/core.js';
import { oauthOrigin } from '../../_lib/oauth-security.js';

const yes = value => Boolean(value);

export async function onRequestGet({ request, env }) {
  const auth = await requireSession(request, env, ['admin']);
  if (auth.error) return auth.error;
  try {
    const origin = oauthOrigin(request, env);
    const currentTenant = await tenant(env);
    const [dropbox, google, xero, whatsapp, userCalendars] = await Promise.all([
      integration(env, 'dropbox'),
      integration(env, 'google'),
      integration(env, 'xero'),
      integration(env, 'whatsapp'),
      supa(env, 'user_integrations', {
        query: `select=user_id,status,account_label,last_verified_at&tenant_id=eq.${currentTenant.id}&provider=eq.google`
      })
    ]);
    const workspaceGoogle = yes(
      (env.GOOGLE_WORKSPACE_CLIENT_ID || env.GOOGLE_CLIENT_ID)
      && (env.GOOGLE_WORKSPACE_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET)
    );
    const calendarGoogle = yes(
      (env.GOOGLE_CALENDAR_CLIENT_ID || env.GOOGLE_CLIENT_ID)
      && (env.GOOGLE_CALENDAR_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET)
    );
    const environment = {
      supabase: yes(env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY && env.NORTHLIGHT_DEMO_KEY),
      sessions: yes(env.SESSION_SECRET && env.TOKEN_ENCRYPTION_KEY),
      pilotLogin: yes(env.PILOT_LOGIN_PASSWORD),
      canonicalOrigin: true,
      googleApp: workspaceGoogle && calendarGoogle,
      googleWorkspaceApp: workspaceGoogle,
      googleCalendarApp: calendarGoogle,
      googleClientIdsSeparated: yes(
        env.GOOGLE_WORKSPACE_CLIENT_ID
        && env.GOOGLE_CALENDAR_CLIENT_ID
        && env.GOOGLE_WORKSPACE_CLIENT_ID !== env.GOOGLE_CALENDAR_CLIENT_ID
      ),
      dropboxApp: yes(env.DROPBOX_APP_KEY && env.DROPBOX_APP_SECRET),
      xeroApp: yes(env.XERO_CLIENT_ID && env.XERO_CLIENT_SECRET),
      xeroWebhook: yes(env.XERO_WEBHOOK_KEY),
      emailTarget: yes(env.DEMO_EMAIL_TO),
      dropboxRoot: yes(env.DROPBOX_ROOT)
    };
    const connectedCalendars = userCalendars.filter(row => row.status === 'connected');
    return json({
      ok: environment.supabase && environment.sessions && environment.pilotLogin && environment.canonicalOrigin,
      tenant: {
        name: currentTenant.name,
        brand: currentTenant.brand_name,
        timezone: currentTenant.timezone
      },
      environment,
      integrations: {
        dropbox: { status: dropbox?.status || 'not_connected', account: dropbox?.account_label || null },
        sharedGoogle: { status: google?.status || 'not_connected', account: google?.account_label || null },
        xero: { status: xero?.status || 'not_connected', account: xero?.account_label || null },
        whatsapp: { status: whatsapp?.status || 'disabled' },
        userCalendars: {
          connected: connectedCalendars.length,
          total: userCalendars.length,
          accounts: connectedCalendars.map(row => row.account_label)
        }
      },
      urls: {
        googleShared: `${origin}/oauth/google/callback`,
        googleUser: `${origin}/oauth/google-user/callback`,
        dropbox: `${origin}/oauth/dropbox/callback`,
        xero: `${origin}/oauth/xero/callback`,
        dropboxWebhook: `${origin}/webhooks/dropbox`,
        calendarWebhook: `${origin}/webhooks/google-calendar`,
        xeroWebhook: `${origin}/webhooks/xero`
      }
    });
  } catch {
    return error(500, 'Preflight failed safely. Verify the canonical application origin and server configuration.');
  }
}
