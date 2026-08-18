import{requireSession,error,json,integration}from'../../_lib/core.js';
import{syncDropbox}from'../../_lib/dropbox-sync.js';

export async function onRequestPost({request,env}){const a=await requireSession(request,env,['admin','owner']);if(a.error)return a.error;try{const ix=await integration(env,'dropbox');if(!ix||ix.status!=='connected')return error(409,'Dropbox is not connected.');const d=await syncDropbox(env);return json({ok:true,total:d.total||0,changed:d.changed||0,matched:d.matched||0,rootMissing:!!d.rootMissing})}catch(e){return error(502,'Dropbox could not be reconciled.',e.message)}}
