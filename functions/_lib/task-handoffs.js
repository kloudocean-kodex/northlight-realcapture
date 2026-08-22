import{supa,tenant,accessToken,gmailCreateDraft,gmailGetDraft,gmailSendDraft,logEvent,logSync}from'./core.js';
import{userGoogleRequest,userIntegration}from'./user-integrations.js';
import{deliverDurableDraft}from'./durable-email.js';
import{calendarEventHasDeleteSensitiveChanges,calendarEventOwnedByTask,calendarMetadataForEvent,managedCalendarChangedFields,managedCalendarEventNeedsReview,managedCalendarSnapshot,managedCalendarSnapshotsEqual,reconcileManagedCalendarEvent}from'./calendar-sync.js';

const TZ='Australia/Melbourne',INITIAL_KINDS=['dropbox','calendar','email'],KINDS=[...INITIAL_KINDS,'calendar_cancel'],PRE_SHOOT=new Set(['assigned','confirmed','reschedule_requested']),PROCESSING_LEASE_MS=10*60*1000;
async function task(env,id){return(await supa(env,'tasks',{query:`select=*&id=eq.${encodeURIComponent(id)}&deleted_at=is.null&limit=1`}))?.[0]||null}
async function hasEvent(env,taskId,type){return!!(await supa(env,'task_events',{query:`select=id&task_id=eq.${encodeURIComponent(taskId)}&type=eq.${encodeURIComponent(type)}&limit=1`}))?.[0]}
async function patchHandoff(env,row,patch,{status=row.status,attempts=row.attempts}={}){const rows=await supa(env,'task_handoffs',{method:'PATCH',query:`id=eq.${encodeURIComponent(row.id)}&status=eq.${encodeURIComponent(status)}&attempts=eq.${Number(attempts||0)}`,payload:{...patch,updated_at:new Date().toISOString()}});return rows?.[0]||null}
async function mark(env,taskId,kind,patch){await supa(env,'task_handoffs',{method:'PATCH',query:`task_id=eq.${encodeURIComponent(taskId)}&kind=eq.${encodeURIComponent(kind)}`,payload:{...patch,updated_at:new Date().toISOString()},prefer:'return=minimal'})}
async function attemptRow(env,taskId,kind){return(await supa(env,'task_handoffs',{query:`select=*&task_id=eq.${encodeURIComponent(taskId)}&kind=eq.${encodeURIComponent(kind)}&limit=1`}))?.[0]||null}
function handoffSatisfied(t,kind,row){if(kind==='dropbox')return!!t.dropbox_path;if(kind==='calendar')return!!t.calendar_event_id&&t.metadata?.calendar_etag_event_id===t.calendar_event_id&&!!t.metadata?.calendar_etag;if(kind==='email')return t.metadata?.assignment_email_user_id===t.photographer_user_id;if(kind==='calendar_cancel')return row?.status==='done';return false}
function handoffObsolete(t,kind){if(kind==='calendar_cancel')return false;if(t.archived_at||['cancelled','delivered'].includes(t.status))return true;if(['calendar','email'].includes(kind)&&!PRE_SHOOT.has(t.status))return true;return false}
function sameProviderLifecycle(a,b){return!!a&&a.photographer_user_id===b.photographer_user_id&&PRE_SHOOT.has(a.status)&&!a.archived_at&&!a.deleted_at}
function sameAssignment(a,b){return sameProviderLifecycle(a,b)&&String(a.scheduled_start||'')===String(b.scheduled_start||'')&&String(a.scheduled_end||'')===String(b.scheduled_end||'')}

function processingLeaseActive(row){if(row?.status!=='processing')return false;const explicit=row.processing_lease_until?new Date(row.processing_lease_until).getTime():0,legacy=row.last_attempt_at?new Date(row.last_attempt_at).getTime()+PROCESSING_LEASE_MS:0;return Math.max(explicit,legacy)>Date.now()}
function taskHandoffMessage(row){return{version:1,type:'task_handoff',jobId:row.id,taskId:row.task_id,kind:row.kind}}
function calendarCleanupMessage(row){return{version:1,type:'calendar_cleanup',jobId:row.id,taskId:row.task_id}}
async function sendQueueMessages(env,messages){if(!messages.length||!env.TASK_HANDOFF_QUEUE)return false;if(typeof env.TASK_HANDOFF_QUEUE.sendBatch==='function')await env.TASK_HANDOFF_QUEUE.sendBatch(messages.map(body=>({body,contentType:'json'})));else await Promise.all(messages.map(body=>env.TASK_HANDOFF_QUEUE.send(body,{contentType:'json'})));return true}
async function enqueuePersistedRows(env,rows,type){const messages=(rows||[]).filter(Boolean).map(type==='calendar_cleanup'?calendarCleanupMessage:taskHandoffMessage);if(!messages.length)return false;try{return await sendQueueMessages(env,messages)}catch(e){console.error(JSON.stringify({level:'error',service:'pages-functions',event:'system_job_enqueue_failed',type,error:String(e?.message||e)}));return false}}

export async function queueTaskHandoff(env,t,kind,{payload={}}={}){if(!KINDS.includes(kind))throw new Error('unsupported_handoff');const tn=await tenant(env),now=new Date().toISOString(),rows=await supa(env,'task_handoffs',{method:'POST',query:'on_conflict=task_id,kind',payload:{tenant_id:tn.id,task_id:t.id,kind,status:'pending',attempts:0,next_attempt_at:null,last_attempt_at:null,last_error:null,payload,processing_lease_until:null,completed_at:null,updated_at:now},prefer:'resolution=merge-duplicates,return=representation'});const row=rows?.[0]||await attemptRow(env,t.id,kind);await enqueuePersistedRows(env,row?[row]:[],'task_handoff');return row}
export async function queueTaskHandoffs(env,t){const tn=await tenant(env),now=new Date().toISOString(),records=INITIAL_KINDS.map(kind=>({tenant_id:tn.id,task_id:t.id,kind,status:'pending',attempts:0,next_attempt_at:null,last_attempt_at:null,last_error:null,payload:{},updated_at:now}));await supa(env,'task_handoffs',{method:'POST',query:'on_conflict=task_id,kind',payload:records,prefer:'resolution=ignore-duplicates,return=minimal'});const rows=await supa(env,'task_handoffs',{query:`select=*&task_id=eq.${encodeURIComponent(t.id)}&kind=in.(${INITIAL_KINDS.join(',')})&order=kind.asc`});await enqueuePersistedRows(env,rows,'task_handoff');return rows}

async function dropboxApi(token,endpoint,payload={}){const r=await fetch(`https://api.dropboxapi.com/2/${endpoint}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(payload)}),txt=await r.text();if(!r.ok)throw new Error(`dropbox_${r.status}`);try{return txt?JSON.parse(txt):{}}catch{return{}}}
function calendarEventId(t){const generation=new Date(t.metadata?.last_schedule_change_at||t.scheduled_start||0).getTime(),suffix=Number.isFinite(generation)&&generation>0?generation.toString(16):'0';return`nl${String(t.id).replace(/-/g,'').toLowerCase()}${suffix}`}
function eventBody(t,timezone){return{summary:`${t.task_no} · ${t.property_name}`,description:`Northlight property media task ${t.task_no}\nServices: ${(t.service_codes||[]).join(', ')}`,location:[t.address,t.suburb].filter(Boolean).join(', '),start:{dateTime:new Date(t.scheduled_start).toISOString(),timeZone:timezone},end:{dateTime:new Date(t.scheduled_end||new Date(t.scheduled_start).getTime()+90*60000).toISOString(),timeZone:timezone},extendedProperties:{private:{northlightTaskId:t.id,northlightTaskNo:t.task_no}}}}
function googleStatus(error,status){return error?.status===status||String(error?.message||'').includes(`google_${status}:`)}
function calendarEventPath(calendarId,eventId){return`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`}
function savedCalendarEtag(t,eventId){return t.metadata?.calendar_etag_event_id===eventId?t.metadata?.calendar_etag||null:null}
async function readCalendarEvent(env,userId,calendarId,eventId){try{return await userGoogleRequest(env,userId,calendarEventPath(calendarId,eventId))}catch(e){if(googleStatus(e,404)||googleStatus(e,410))return null;throw e}}
async function patchCalendarVersion(env,userId,calendarId,eventId,body,etag){return userGoogleRequest(env,userId,`${calendarEventPath(calendarId,eventId)}?sendUpdates=none`,{method:'PATCH',headers:{'if-match':etag},body:JSON.stringify(body)})}
async function versionedCalendarEvent(env,userId,calendarId,event){if(event?.etag)return event;const current=event?.id?await readCalendarEvent(env,userId,calendarId,event.id):null;if(!current?.etag)throw new Error('calendar_event_etag_missing');return current}
async function conditionalCalendarPatch(env,t,userId,calendarId,eventId,body,{initialEvent=null}={}){
  const desired=managedCalendarSnapshot({...body,id:eventId}),storedEtag=savedCalendarEtag(t,eventId);
  let current=initialEvent,etag=storedEtag;
  if(!etag){
    current=current||await readCalendarEvent(env,userId,calendarId,eventId);
    if(!current)return{missing:true};
    if(current.status==='cancelled'||!calendarEventOwnedByTask(current,t)||managedCalendarEventNeedsReview(t,current))return{conflict:true,event:current};
    if(managedCalendarSnapshotsEqual(managedCalendarSnapshot(current),desired))return{event:current,reused:true};
    etag=current.etag;
    if(!etag)return{conflict:true,event:current};
  }
  try{return{event:await patchCalendarVersion(env,userId,calendarId,eventId,body,etag)}}catch(e){
    if(googleStatus(e,404)||googleStatus(e,410))return{missing:true};
    if(!googleStatus(e,412))throw e;
    current=await readCalendarEvent(env,userId,calendarId,eventId);
    if(!current)return{missing:true};
    if(current.status==='cancelled'||!calendarEventOwnedByTask(current,t)||managedCalendarEventNeedsReview(t,current))return{conflict:true,event:current};
    if(managedCalendarSnapshotsEqual(managedCalendarSnapshot(current),desired))return{event:current,reused:true};
    if(!current.etag)return{conflict:true,event:current};
    try{return{event:await patchCalendarVersion(env,userId,calendarId,eventId,body,current.etag)}}catch(retryError){
      if(googleStatus(retryError,404)||googleStatus(retryError,410))return{missing:true};
      if(!googleStatus(retryError,412))throw retryError;
      return{conflict:true,event:await readCalendarEvent(env,userId,calendarId,eventId)};
    }
  }
}
async function createOrRecoverCalendarEvent(env,t,userId,calendarId,eventId,body){
  try{return{event:await userGoogleRequest(env,userId,`/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`,{method:'POST',body:JSON.stringify({...body,id:eventId})}),created:true}}catch(e){
    if(!googleStatus(e,409))throw e;
    const current=await readCalendarEvent(env,userId,calendarId,eventId),desired=managedCalendarSnapshot({...body,id:eventId});
    if(!current||!calendarEventOwnedByTask(current,t))return{conflict:true,event:current};
    if(managedCalendarSnapshotsEqual(managedCalendarSnapshot(current),desired))return{event:current,reused:true};
    return conditionalCalendarPatch(env,t,userId,calendarId,eventId,body,{initialEvent:current});
  }
}
async function recordOutboundCalendarConflict(env,t,event,reason){
  if(event)await reconcileManagedCalendarEvent(env,t,event,{forceReview:true,reason});
  else if(t.calendar_event_id)await reconcileManagedCalendarEvent(env,t,{id:t.calendar_event_id,status:'cancelled',etag:savedCalendarEtag(t,t.calendar_event_id)},{forceReview:true,reason});
  try{await logSync(env,'google','outbound','calendar','event_conflict_preserved',{entity_id:t.id,status:'failed',error:reason,payload:{event_id:event?.id||t.calendar_event_id||null,etag:event?.etag||null}})}catch{}
  return{status:'attention',reason:'calendar_external_change_review_required'};
}
async function conditionalCalendarDelete(env,t,userId,calendarId,eventId){
  const etag=savedCalendarEtag(t,eventId),path=`${calendarEventPath(calendarId,eventId)}?sendUpdates=none`;
  const remove=version=>userGoogleRequest(env,userId,path,{method:'DELETE',headers:{'if-match':version}});
  if(etag){
    try{await remove(etag);return{deleted:true}}catch(e){
      if(googleStatus(e,404)||googleStatus(e,410))return{deleted:true,reused:true};
      if(!googleStatus(e,412))throw e;
      return{conflict:true,event:await readCalendarEvent(env,userId,calendarId,eventId)};
    }
  }
  const current=await readCalendarEvent(env,userId,calendarId,eventId);
  if(!current||current.status==='cancelled')return{deleted:true,reused:true};
  if(!current.etag||!calendarEventOwnedByTask(current,t)||managedCalendarEventNeedsReview(t,current)||calendarEventHasDeleteSensitiveChanges(current))return{conflict:true,event:current};
  try{await remove(current.etag);return{deleted:true}}catch(e){
    if(googleStatus(e,404)||googleStatus(e,410))return{deleted:true,reused:true};
    if(!googleStatus(e,412))throw e;
    return{conflict:true,event:await readCalendarEvent(env,userId,calendarId,eventId)};
  }
}
async function recordCalendarCleanupConflict(env,t,event,eventId,owner,reason='calendar_delete_precondition_failed'){
  const current=await task(env,t.id)||t,observedEtag=event?.etag||null,prior=current.metadata?.calendar_cleanup_external_change||{},duplicate=prior.event_id===eventId&&prior.etag===observedEtag,metadata={...(current.metadata||{}),calendar_cleanup_pending:true,calendar_cleanup_external_change:{event_id:eventId,etag:observedEtag,owner_user_id:owner,changed_fields:event?managedCalendarChangedFields(current,event):[],observed_at:new Date().toISOString(),reason}};
  await supa(env,'tasks',{method:'PATCH',query:`id=eq.${encodeURIComponent(current.id)}`,payload:{metadata},prefer:'return=minimal'});
  if(!duplicate)await logEvent(env,{task_id:current.id,type:'calendar_cleanup_external_change_requires_review',message:'Google Calendar changed before Northlight could remove the old managed event. The provider copy was preserved for review.',detail:{event_id:eventId,calendar_owner_user_id:owner,etag:observedEtag,changed_fields:metadata.calendar_cleanup_external_change.changed_fields}});
  try{await logSync(env,'google','outbound','calendar','cleanup_conflict_preserved',{entity_id:current.id,status:'failed',error:reason,payload:{event_id:eventId,etag:observedEtag}})}catch{}
  return{status:'attention',reason:'calendar_external_change_review_required'};
}
async function ensureDropbox(env,t){if(t.dropbox_path)return{status:'done',reused:true};const token=await accessToken(env,'dropbox'),root=env.DROPBOX_ROOT||'/Northlight',safe=String(`${t.task_no} - ${t.property_name}`).replace(/[\\<>:"|?*]/g,'-').replace(/\s+/g,' ').trim().slice(0,120),base=`${root}/${safe}`,paths=[root,base,...['01_RAW','02_EDITED','03_FINAL','04_REFERENCE'].map(x=>`${base}/${x}`)];for(const code of t.service_codes||[]){const s=String(code).toUpperCase().replace(/[^A-Z0-9_-]/g,'_');for(const stage of ['01_RAW','02_EDITED','03_FINAL'])paths.push(`${base}/${stage}/${s}`)}for(const path of [...new Set(paths)]){try{await dropboxApi(token,'files/create_folder_v2',{path,autorename:false})}catch(e){if(!String(e.message).includes('dropbox_409'))throw e}}await dropboxApi(token,'files/get_metadata',{path:base,include_deleted:false});await supa(env,'tasks',{method:'PATCH',query:`id=eq.${encodeURIComponent(t.id)}&dropbox_path=is.null`,payload:{dropbox_path:base},prefer:'return=minimal'});if(!await hasEvent(env,t.id,'dropbox_workspace_created'))await logEvent(env,{task_id:t.id,type:'dropbox_workspace_created',message:'Secure Dropbox workspace created.',detail:{path:base}});return{status:'done',path:base}}
async function ensureCalendar(env,t){
  let cur=await task(env,t.id);
  if(!sameAssignment(cur,t))return{status:'cancelled',reason:'assignment_changed'};
  const cleanup=(await supa(env,'calendar_cleanup_queue',{query:`select=id,status&task_id=eq.${encodeURIComponent(t.id)}&status=in.(pending,processing,attention)&limit=1`}))?.[0];
  if(cleanup)return{status:'attention',reason:'calendar_cleanup_pending'};
  const ix=await userIntegration(env,t.photographer_user_id,'google');
  if(!ix||ix.status!=='connected')return{status:'not_connected'};
  const profile=(await supa(env,'provider_profiles',{query:`select=calendar_id,timezone&user_id=eq.${encodeURIComponent(t.photographer_user_id)}&limit=1`}))?.[0]||{},calendarId=t.metadata?.calendar_id||profile.calendar_id||'primary',timezone=profile.timezone||TZ,body=eventBody(t,timezone),originalEventId=t.calendar_event_id||null,eventId=originalEventId||calendarEventId(t);
  let result=originalEventId
    ?await conditionalCalendarPatch(env,t,t.photographer_user_id,calendarId,eventId,body)
    :await createOrRecoverCalendarEvent(env,t,t.photographer_user_id,calendarId,eventId,body);
  if(result.missing)return recordOutboundCalendarConflict(env,t,null,'calendar_event_missing_before_update');
  if(result.conflict)return recordOutboundCalendarConflict(env,t,result.event,'calendar_etag_precondition_failed');
  const providerEvent=await versionedCalendarEvent(env,t.photographer_user_id,calendarId,result.event),managedEventId=providerEvent.id||eventId;
  cur=await task(env,t.id);
  if(!sameAssignment(cur,t)){
    if(!sameProviderLifecycle(cur,t))await queueCalendarCleanup(env,cur||t,{calendarOwnerUserId:t.photographer_user_id,calendarEventId:managedEventId,calendarId});
    return{status:'cancelled',reason:'assignment_or_schedule_changed_after_calendar'};
  }
  const expectedEvent=originalEventId?`calendar_event_id=eq.${encodeURIComponent(originalEventId)}`:'calendar_event_id=is.null',updated=await supa(env,'tasks',{method:'PATCH',query:`id=eq.${encodeURIComponent(t.id)}&photographer_user_id=eq.${encodeURIComponent(t.photographer_user_id)}&${expectedEvent}&status=in.(assigned,confirmed,reschedule_requested)&scheduled_start=eq.${encodeURIComponent(t.scheduled_start)}&scheduled_end=eq.${encodeURIComponent(t.scheduled_end)}`,payload:{calendar_event_id:managedEventId,calendar_owner_user_id:t.photographer_user_id,metadata:calendarMetadataForEvent(cur.metadata||{},providerEvent,calendarId)}});
  if(!updated?.length){const latest=await task(env,t.id);if(!sameProviderLifecycle(latest,t))await queueCalendarCleanup(env,latest||t,{calendarOwnerUserId:t.photographer_user_id,calendarEventId:managedEventId,calendarId});return{status:'cancelled',reason:'calendar_attach_race'}}
  if((result.created||!originalEventId)&&!await hasEvent(env,t.id,'calendar_event_created'))await logEvent(env,{task_id:t.id,type:'calendar_event_created',message:'Shoot event created on the Photographer’s connected calendar.',detail:{event_id:managedEventId,calendar_id:calendarId,photographer_user_id:t.photographer_user_id,etag:providerEvent.etag}});
  try{await logSync(env,'google','outbound','calendar',originalEventId?'event_synced':'event_created',{entity_id:t.id,payload:{eventId:managedEventId,etag:providerEvent.etag,start:t.scheduled_start,end:t.scheduled_end}})}catch{}
  return{status:'done',id:managedEventId,etag:providerEvent.etag,reused:!!originalEventId||!!result.reused};
}
async function ensureLegacyCalendarCancel(env,t,payload={}){const owner=payload.calendarOwnerUserId||t.calendar_owner_user_id,eventId=payload.calendarEventId||t.calendar_event_id,calendarId=payload.calendarId||t.metadata?.calendar_id||'primary';if(!owner||!eventId)return{status:'done',reused:true};const ix=await userIntegration(env,owner,'google');if(!ix||ix.status!=='connected')return{status:'not_connected'};const result=await conditionalCalendarDelete(env,t,owner,calendarId,eventId);if(result.conflict)return recordCalendarCleanupConflict(env,t,result.event,eventId,owner);await logEvent(env,{task_id:t.id,type:'calendar_event_cancelled',message:'Previous shoot event removed from Google Calendar.',detail:{event_id:eventId,calendar_owner_user_id:owner}});return{status:'done',reused:!!result.reused}}
async function ensureEmail(env,t,row){
  if(t.metadata?.assignment_email_user_id===t.photographer_user_id)return{status:'done',reused:true,id:t.metadata?.assignment_email_message_id||null};
  let cur=await task(env,t.id);
  if(!sameAssignment(cur,t))return{status:'cancelled',reason:'assignment_changed'};
  const ph=(await supa(env,'users',{query:`select=id,name,email&id=eq.${encodeURIComponent(t.photographer_user_id)}&limit=1`}))?.[0],tn=await tenant(env),candidate=String(ph?.email||'').trim(),fallback=String(tn.settings?.operations_email||env.DEMO_EMAIL_TO||'').trim(),to=candidate&&!candidate.endsWith('.local')?candidate:fallback;
  if(!to)return{status:'attention',reason:'notification_recipient_missing'};
  cur=await task(env,t.id);
  if(!sameAssignment(cur,t))return{status:'cancelled',reason:'assignment_changed_before_email'};
  const subject=`${t.task_no} · New property media booking`,text=`Northlight · REALCAPTURE\n\nNew property media task\n\nProperty: ${t.property_name}\nAddress: ${t.address}, ${t.suburb}\nWhen: ${new Date(t.scheduled_start).toLocaleString('en-AU',{timeZone:TZ})}\nServices: ${(t.service_codes||[]).join(', ')}\nTask: ${t.task_no}\n\nOpen Northlight to view, confirm or raise an issue.`,deliveryKey=`assignment-${String(t.id).replace(/-/g,'')}-${String(t.photographer_user_id).replace(/-/g,'')}-${new Date(t.scheduled_start).getTime()}`,messageId=`<${deliveryKey}@northlight-realcapture.pages.dev>`;
  let claim=row;
  const delivery=await deliverDurableDraft({
    state:claim.payload||{},
    deliveryKey,
    messageId,
    createDraft:()=>gmailCreateDraft(env,to,subject,text,{messageId}),
    getDraft:draftId=>gmailGetDraft(env,draftId),
    sendDraft:draftId=>gmailSendDraft(env,draftId),
    persist:async next=>{const saved=await patchHandoff(env,claim,{payload:next},{status:'processing',attempts:claim.attempts});if(!saved)throw new Error('email_delivery_checkpoint_not_persisted');claim=saved;return saved.payload||next},
  }),messageProviderId=delivery.providerMessageId,inferred=delivery.inferred;
  cur=await task(env,t.id);
  if(!sameAssignment(cur,t)){try{await logSync(env,'google','outbound','email','stale_assignment_email',{entity_id:t.id,status:'processed',payload:{photographer_user_id:t.photographer_user_id,email_delivery_key:deliveryKey}})}catch{}return{status:'cancelled',reason:'assignment_changed_after_email'}}
  const updated=await supa(env,'tasks',{method:'PATCH',query:`id=eq.${encodeURIComponent(t.id)}&photographer_user_id=eq.${encodeURIComponent(t.photographer_user_id)}&status=in.(assigned,confirmed,reschedule_requested)&scheduled_start=eq.${encodeURIComponent(t.scheduled_start)}&scheduled_end=eq.${encodeURIComponent(t.scheduled_end)}`,payload:{metadata:{...(cur.metadata||{}),assignment_email_user_id:t.photographer_user_id,assignment_email_to:to,assignment_email_at:new Date().toISOString(),assignment_email_message_id:messageProviderId,assignment_email_delivery_key:deliveryKey,assignment_email_inferred_from_consumed_draft:inferred}}});
  if(!updated?.length)return{status:'cancelled',reason:'email_attach_race'};
  if(!await hasEvent(env,t.id,'assignment_email_sent'))await logEvent(env,{task_id:t.id,type:'assignment_email_sent',message:'Assignment email sent.',detail:{to,photographer_user_id:t.photographer_user_id,provider_message_id:messageProviderId,delivery_key:deliveryKey,inferred}});
  return{status:'done',to,id:messageProviderId,reused:inferred};
}

export async function runTaskHandoff(env,taskId,kind){
  if(!KINDS.includes(kind))throw new Error('unsupported_handoff');
  const t=await task(env,taskId);
  if(!t){
    await mark(env,taskId,kind,{status:'cancelled',next_attempt_at:null,last_error:'task_removed',processing_lease_until:null,dispatch_owner:null,dispatch_lease_until:null,completed_at:new Date().toISOString()});
    return{status:'cancelled'};
  }
  let row=await attemptRow(env,t.id,kind);
  if(!row){await queueTaskHandoff(env,t,kind);row=await attemptRow(env,t.id,kind)}
  if(row?.status==='done'&&handoffSatisfied(t,kind,row))return{status:'done',reused:true};
  if(row?.status==='cancelled')return{status:'cancelled',reused:true};
  if(handoffObsolete(t,kind)){
    await mark(env,t.id,kind,{status:'cancelled',next_attempt_at:null,last_error:'task_state_changed',processing_lease_until:null,dispatch_owner:null,dispatch_lease_until:null,completed_at:new Date().toISOString()});
    return{status:'cancelled'};
  }
  if(processingLeaseActive(row))return{status:'processing',reused:true};
  const attempts=Number(row?.attempts||0)+1,startedAt=new Date().toISOString(),claim=await patchHandoff(env,row,{status:'processing',attempts,last_attempt_at:startedAt,processing_lease_until:new Date(Date.now()+PROCESSING_LEASE_MS).toISOString(),last_error:null},{status:row.status,attempts:row.attempts});
  if(!claim)return{status:'processing',reused:true};
  try{
    let result;
    if(kind==='dropbox')result=await ensureDropbox(env,t);
    else if(kind==='calendar')result=await ensureCalendar(env,t);
    else if(kind==='calendar_cancel')result=await ensureLegacyCalendarCancel(env,t,claim.payload||{});
    else result=await ensureEmail(env,t,claim);
    const terminal=result.status==='done'||result.status==='cancelled',finalStatus=result.status==='cancelled'?'cancelled':result.status==='done'?'done':'attention',finishedAt=new Date().toISOString(),receipt=terminal?{kind,status:result.status,provider_id:result.id||null,path:result.path||null,recipient:result.to||null,finished_at:finishedAt}:{...(claim.provider_receipt||{})};
    await patchHandoff(env,claim,{status:finalStatus,next_attempt_at:terminal?null:new Date(Date.now()+15*60*1000).toISOString(),last_error:terminal?null:(result.reason||result.status),processing_lease_until:null,dispatch_owner:null,dispatch_lease_until:null,completed_at:terminal?finishedAt:null,provider_receipt:receipt},{status:'processing',attempts:claim.attempts});
    return result;
  }catch(e){
    await patchHandoff(env,claim,{status:'attention',next_attempt_at:new Date(Date.now()+Math.min(60,5*Math.max(1,attempts))*60*1000).toISOString(),last_error:String(e.message||'handoff_failed').slice(0,500),processing_lease_until:null,dispatch_owner:null,dispatch_lease_until:null},{status:'processing',attempts:claim.attempts});
    try{await logSync(env,kind.startsWith('calendar')||kind==='email'?'google':kind,'outbound','task','handoff_failed',{entity_id:t.id,status:'failed',error:e.message})}catch{}
    throw e;
  }
}
export async function recoverOneTaskHandoff(env,{taskId=null}={}){const now=new Date().toISOString(),taskFilter=taskId?`&task_id=eq.${encodeURIComponent(taskId)}`:'',rows=await supa(env,'task_handoffs',{query:`select=*&status=in.(pending,attention)&attempts=lt.8&or=(next_attempt_at.is.null,next_attempt_at.lte.${encodeURIComponent(now)})${taskFilter}&order=created_at.asc&limit=1`}),row=rows?.[0];if(!row)return null;try{return{row,result:await runTaskHandoff(env,row.task_id,row.kind)}}catch{return{row,error:'handoff_failed'}}}

async function cleanupRow(env,id){return(await supa(env,'calendar_cleanup_queue',{query:`select=*&id=eq.${encodeURIComponent(id)}&limit=1`}))?.[0]||null}
async function patchCleanup(env,row,patch,{status=row.status,attempts=row.attempts}={}){const rows=await supa(env,'calendar_cleanup_queue',{method:'PATCH',query:`id=eq.${encodeURIComponent(row.id)}&status=eq.${encodeURIComponent(status)}&attempts=eq.${Number(attempts||0)}`,payload:{...patch,updated_at:new Date().toISOString()}});return rows?.[0]||null}
async function updateCleanupFlag(env,taskId){const t=await task(env,taskId);if(!t)return;const rows=await supa(env,'calendar_cleanup_queue',{query:`select=id&task_id=eq.${encodeURIComponent(taskId)}&status=in.(pending,processing,attention)&limit=1`}),metadata={...(t.metadata||{}),calendar_cleanup_pending:!!rows?.length};if(!rows?.length)metadata.calendar_cleanup_completed_at=new Date().toISOString();await supa(env,'tasks',{method:'PATCH',query:`id=eq.${encodeURIComponent(taskId)}`,payload:{metadata},prefer:'return=minimal'})}
export async function queueCalendarCleanup(env,t,{calendarOwnerUserId,calendarEventId,calendarId='primary'}={}){
  if(!calendarOwnerUserId||!calendarEventId)return null;
  const existing=(await supa(env,'calendar_cleanup_queue',{query:`select=*&task_id=eq.${encodeURIComponent(t.id)}&calendar_owner_user_id=eq.${encodeURIComponent(calendarOwnerUserId)}&calendar_event_id=eq.${encodeURIComponent(calendarEventId)}&limit=1`}))?.[0];
  if(existing){await enqueuePersistedRows(env,[existing],'calendar_cleanup');return existing}
  const tn=await tenant(env),rows=await supa(env,'calendar_cleanup_queue',{method:'POST',payload:{tenant_id:tn.id,task_id:t.id,calendar_owner_user_id:calendarOwnerUserId,calendar_event_id:calendarEventId,calendar_id:calendarId||'primary',status:'pending',attempts:0,next_attempt_at:null,last_attempt_at:null,last_error:null}}),row=rows?.[0]||null;
  if(row){
    const cur=await task(env,t.id);
    if(cur)await supa(env,'tasks',{method:'PATCH',query:`id=eq.${encodeURIComponent(t.id)}`,payload:{metadata:{...(cur.metadata||{}),calendar_cleanup_pending:true}},prefer:'return=minimal'});
    await enqueuePersistedRows(env,[row],'calendar_cleanup');
  }
  return row;
}
export async function runCalendarCleanup(env,id){
  const row=await cleanupRow(env,id);
  if(!row)return{status:'cancelled'};
  if(row.status==='done'||row.status==='cancelled')return{status:row.status,reused:true};
  if(processingLeaseActive(row))return{status:'processing',reused:true};
  const attempts=Number(row.attempts||0)+1,claim=await patchCleanup(env,row,{status:'processing',attempts,last_attempt_at:new Date().toISOString(),processing_lease_until:new Date(Date.now()+PROCESSING_LEASE_MS).toISOString(),last_error:null},{status:row.status,attempts:row.attempts});
  if(!claim)return{status:'processing',reused:true};
  try{
    const ix=await userIntegration(env,claim.calendar_owner_user_id,'google');
    if(!ix||ix.status!=='connected'){
      await patchCleanup(env,claim,{status:'attention',next_attempt_at:new Date(Date.now()+15*60*1000).toISOString(),last_error:'google_not_connected',processing_lease_until:null,dispatch_owner:null,dispatch_lease_until:null},{status:'processing',attempts:claim.attempts});
      await updateCleanupFlag(env,claim.task_id);
      return{status:'not_connected'};
    }
    const removal=await conditionalCalendarDelete(env,await task(env,claim.task_id)||{id:claim.task_id,metadata:{}},claim.calendar_owner_user_id,claim.calendar_id||'primary',claim.calendar_event_id);
    if(removal.conflict){
      const observedAt=new Date().toISOString();
      await patchCleanup(env,claim,{status:'attention',next_attempt_at:new Date(Date.now()+24*60*60*1000).toISOString(),last_error:'calendar_external_change_review_required',processing_lease_until:null,dispatch_owner:null,dispatch_lease_until:null,provider_receipt:{provider:'google_calendar',event_id:claim.calendar_event_id,etag:removal.event?.etag||null,conflict_observed_at:observedAt}},{status:'processing',attempts:claim.attempts});
      await recordCalendarCleanupConflict(env,await task(env,claim.task_id)||{id:claim.task_id,metadata:{}},removal.event,claim.calendar_event_id,claim.calendar_owner_user_id);
      await updateCleanupFlag(env,claim.task_id);
      return{status:'attention',reason:'calendar_external_change_review_required'};
    }
    const finishedAt=new Date().toISOString();
    await patchCleanup(env,claim,{status:'done',next_attempt_at:null,last_error:null,processing_lease_until:null,dispatch_owner:null,dispatch_lease_until:null,completed_at:finishedAt,provider_receipt:{provider:'google_calendar',event_id:claim.calendar_event_id,finished_at:finishedAt}},{status:'processing',attempts:claim.attempts});
    await logEvent(env,{task_id:claim.task_id,type:'calendar_event_cancelled',message:'Previous shoot event removed from Google Calendar.',detail:{event_id:claim.calendar_event_id,calendar_owner_user_id:claim.calendar_owner_user_id}});
    await updateCleanupFlag(env,claim.task_id);
    return{status:'done',id:claim.calendar_event_id};
  }catch(e){
    await patchCleanup(env,claim,{status:'attention',next_attempt_at:new Date(Date.now()+Math.min(60,5*Math.max(1,attempts))*60*1000).toISOString(),last_error:String(e.message||'calendar_cleanup_failed').slice(0,500),processing_lease_until:null,dispatch_owner:null,dispatch_lease_until:null},{status:'processing',attempts:claim.attempts});
    try{await logSync(env,'google','outbound','calendar','cleanup_failed',{entity_id:claim.task_id,status:'failed',error:e.message,payload:{calendar_event_id:claim.calendar_event_id}})}catch{}
    await updateCleanupFlag(env,claim.task_id);
    throw e;
  }
}
export async function recoverOneCalendarCleanup(env,{taskId=null}={}){const now=new Date().toISOString(),taskFilter=taskId?`&task_id=eq.${encodeURIComponent(taskId)}`:'',rows=await supa(env,'calendar_cleanup_queue',{query:`select=*&status=in.(pending,attention)&attempts=lt.8&or=(next_attempt_at.is.null,next_attempt_at.lte.${encodeURIComponent(now)})${taskFilter}&order=created_at.asc&limit=1`}),row=rows?.[0];if(!row)return null;try{return{row,result:await runCalendarCleanup(env,row.id)}}catch{return{row,error:'calendar_cleanup_failed'}}}
export async function recoverOneSystemJob(env,{taskId=null}={}){try{await supa(env,'rpc/northlight_reap_stale_system_jobs',{method:'POST',payload:{}})}catch{}const cleanup=await recoverOneCalendarCleanup(env,{taskId});if(cleanup)return cleanup;return recoverOneTaskHandoff(env,{taskId})}

async function finishDispatch(env,dispatcher,handoffIds,cleanupIds,sent){const work=[];if(handoffIds.length)work.push(supa(env,'rpc/northlight_finish_task_handoff_dispatch',{method:'POST',payload:{p_dispatcher:dispatcher,p_ids:handoffIds,p_sent:sent}}));if(cleanupIds.length)work.push(supa(env,'rpc/northlight_finish_calendar_cleanup_dispatch',{method:'POST',payload:{p_dispatcher:dispatcher,p_ids:cleanupIds,p_sent:sent}}));await Promise.all(work)}
export async function dispatchDueSystemJobs(env,{limit=50}={}){
  const bounded=Math.min(Math.max(Number(limit)||50,1),100),perType=Math.max(1,Math.floor(bounded/2)),dispatcher=crypto.randomUUID();
  await supa(env,'rpc/northlight_reap_stale_system_jobs',{method:'POST',payload:{}});
  const [handoffs,cleanups]=await Promise.all([
    supa(env,'rpc/northlight_claim_task_handoff_dispatch',{method:'POST',payload:{p_dispatcher:dispatcher,p_limit:perType,p_lease_seconds:90}}),
    supa(env,'rpc/northlight_claim_calendar_cleanup_dispatch',{method:'POST',payload:{p_dispatcher:dispatcher,p_limit:perType,p_lease_seconds:90}}),
  ]),handoffIds=(handoffs||[]).map(x=>x.job_id),cleanupIds=(cleanups||[]).map(x=>x.job_id),messages=[...(handoffs||[]).map(x=>taskHandoffMessage({id:x.job_id,task_id:x.task_id,kind:x.kind})),...(cleanups||[]).map(x=>calendarCleanupMessage({id:x.job_id,task_id:x.task_id}))];
  if(!messages.length)return{claimed:0,enqueued:0};
  try{
    const sent=await sendQueueMessages(env,messages);
    await finishDispatch(env,dispatcher,handoffIds,cleanupIds,sent);
    return{claimed:messages.length,enqueued:sent?messages.length:0};
  }catch(e){
    await Promise.allSettled([finishDispatch(env,dispatcher,handoffIds,cleanupIds,false)]);
    throw e;
  }
}
export async function taskHandoffStatus(env,taskId){const rows=await supa(env,'task_handoffs',{query:`select=kind,status,attempts,next_attempt_at,last_attempt_at,processing_lease_until,dispatched_at,completed_at&task_id=eq.${encodeURIComponent(taskId)}&order=kind.asc`});return Object.fromEntries((rows||[]).map(x=>[x.kind,x]))}
