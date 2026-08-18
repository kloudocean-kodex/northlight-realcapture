import{requireSession,error,json,supa,tenant}from'../../_lib/core.js';
import{userIntegration}from'../../_lib/user-integrations.js';

export async function onRequestGet({request,env}){const a=await requireSession(request,env);if(a.error)return a.error;try{const ix=await userIntegration(env,a.session.userId,'google'),t=await tenant(env),st=(await supa(env,'calendar_sync_state',{query:`select=calendar_id,channel_expires_at,last_full_sync_at,last_incremental_sync_at,last_error&tenant_id=eq.${t.id}&user_id=eq.${a.session.userId}&provider=eq.google&limit=1`}))?.[0]||null;return json({connected:ix?.status==='connected',account:ix?.account_label||null,sync:st})}catch(e){return error(500,'Could not load Calendar status.',e.message)}}
