import{requireSession,json}from'../../_lib/core.js';
export async function onRequestGet({request,env}){const a=await requireSession(request,env);return a.error||json({session:a.session})}
