import{requireSession,error,json,supa}from'../../../_lib/core.js';
import{runTaskHandoff,taskHandoffStatus}from'../../../_lib/task-handoffs.js';

async function task(env,id){return(await supa(env,'tasks',{query:`select=*&id=eq.${encodeURIComponent(id)}&deleted_at=is.null&limit=1`}))?.[0]||null}
function canTrigger(t,s){return['admin','owner'].includes(s.role)||(s.role==='agent'&&t.agent_user_id===s.userId)}

export async function onRequestGet({request,env,params}){const a=await requireSession(request,env);if(a.error)return a.error;try{const t=await task(env,params.id);if(!t||!canTrigger(t,a.session))return error(404,'Task not found.');return json({handoffs:await taskHandoffStatus(env,t.id)})}catch{return error(500,'Could not load task hand-offs.')}}

export async function onRequestPost({request,env,params}){const a=await requireSession(request,env);if(a.error)return a.error;try{const t=await task(env,params.id);if(!t||!canTrigger(t,a.session))return error(404,'Task not found.');if(t.archived_at)return error(409,'Archived tasks are read-only.');const b=await request.json(),kind=String(b.kind||'');if(!['dropbox','calendar','email'].includes(kind))return error(400,'Choose a supported task hand-off.');const result=await runTaskHandoff(env,t.id,kind);return json({ok:true,kind,...result})}catch{return error(502,'This hand-off needs attention. The Northlight task itself is safe.')}}
