import{requireSession,error,json,dropboxRequest,integration}from'../../_lib/core.js';
import{loadTask,validateUploadRequest,LARGE_UPLOAD_THRESHOLD}from'../../_lib/media-upload.js';
import{findOrCreateDirectIntent}from'../../_lib/direct-upload.js';

function dropboxUploadLinkError(exception){
  const message=String(exception?.message||'');
  if(/dropbox_not_connected|dropbox_refresh_token_missing|dropbox_40[013]|dropbox_403|oauth_40[013]|oauth_403|invalid_access_token|invalid_token|expired_access_token|unauthorized/i.test(message)){
    return error(409,'Reconnect Dropbox from Integrations before uploading media. This restores durable one-time upload access.',{code:'DROPBOX_RECONNECT_REQUIRED'});
  }
  if(/dropbox_429|rate_limit|ratelimit/i.test(message)){
    return error(429,'Dropbox is temporarily limiting upload preparation. Wait a moment and retry.',{code:'DROPBOX_RATE_LIMITED'});
  }
  if(/^dropbox_\d{3}/i.test(message)||/^oauth_\d{3}/i.test(message)){
    return error(502,'Dropbox could not prepare the secure upload link. Retry once, then reconnect Dropbox if it persists.',{code:'DROPBOX_PROVIDER_UNAVAILABLE'});
  }
  if(/^database_/i.test(message))return error(500,'Northlight could not track this secure upload. Retry after refreshing the task.',{code:'UPLOAD_TRACKING_UNAVAILABLE'});
  return error(500,'Could not prepare secure upload.');
}

async function requireDropboxReady(env){
  const current=await integration(env,'dropbox');
  if(!current||current.status!=='connected')return error(409,'Connect Dropbox from Integrations before uploading media.',{code:'DROPBOX_NOT_CONNECTED'});
  if(!current.metadata?.refresh_token)return error(409,'Reconnect Dropbox from Integrations before uploading media. This restores durable one-time upload access.',{code:'DROPBOX_RECONNECT_REQUIRED'});
  return null;
}

export async function onRequestPost({request,env}){const a=await requireSession(request,env);if(a.error)return a.error;try{const b=await request.json(),t=await loadTask(env,b.taskId),v=validateUploadRequest(t,a.session,{stage:b.stage,serviceCode:b.serviceCode,filename:b.filename,sizeBytes:b.sizeBytes});if(!v.ok)return error(v.status,v.error);if(v.sizeBytes>LARGE_UPLOAD_THRESHOLD)return error(413,'This file needs Northlight large-file upload mode.');const readiness=await requireDropboxReady(env);if(readiness)return readiness;const x=await findOrCreateDirectIntent(env,a.session,t,v,{mimeType:b.mimeType,fingerprint:b.clientFingerprint}),row=x.row;if(!row?.id)return error(500,'Could not track this secure upload.');const commit=x.providerComplete?{path:row.path,mode:'overwrite',autorename:false,mute:false,strict_conflict:false}:{path:row.path,mode:'add',autorename:false,mute:false,strict_conflict:true},d=await dropboxRequest(env,'files/get_temporary_upload_link',{commit_info:commit,duration:3600});return json({url:d.link,path:row.path,stage:v.stage,serviceCode:v.service||null,expiresIn:3600,uploadIntentId:row.id,providerComplete:!!x.providerComplete,indexed:row.status==='done'})}catch(exception){return dropboxUploadLinkError(exception)}}
