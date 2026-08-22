(()=>{
  const ROLE_NAV=Object.freeze({
    admin:['today','tasks','booking','attention','team','availability','editor','services','roles','integrations','settings'],
    owner:['today','tasks','booking','attention','team','availability','integrations'],
    agent:['today','tasks','booking','attention'],
    photographer:['today','tasks','availability'],
    editor:['today','tasks','editor']
  });
  const MOBILE_LIMIT=4;
  const CLOSED=new Set(['delivered','cancelled']);
  const RESCHEDULABLE=new Set(['assigned','confirmed','reschedule_requested']);
  const REASSIGNABLE=new Set(['assigned','declined','confirmed','reschedule_requested']);
  const SOURCE_STATES=new Set(['confirmed','shoot_complete']);
  const MANAGEMENT=new Set(['admin','owner']);

  function navFor(role){return[...(ROLE_NAV[role]||['today','tasks'])]}
  function mobileNavFor(role){const all=navFor(role);return{primary:all.slice(0,MOBILE_LIMIT),more:all.slice(MOBILE_LIMIT)}}
  function isManagement(session){return MANAGEMENT.has(session?.role)}
  function owns(task,session,kind){
    if(isManagement(session))return true;
    const field=`${kind}_user_id`;
    return session?.role===kind&&Boolean(session?.userId)&&task?.[field]===session.userId;
  }
  function isMutable(task){return Boolean(task&&!task.deleted_at&&!task.archived_at&&!CLOSED.has(task.status))}
  function canReschedule(task,session){
    if(!isMutable(task)||!RESCHEDULABLE.has(task.status))return false;
    return isManagement(session)||owns(task,session,'agent')||owns(task,session,'photographer');
  }
  function canCancel(task,session){return isMutable(task)&&(isManagement(session)||owns(task,session,'agent'))}
  function canReassign(task,session){
    if(!isMutable(task)||!REASSIGNABLE.has(task.status))return false;
    return isManagement(session)||(task.status==='declined'&&owns(task,session,'agent'));
  }
  function workflowActions(task,session,{rawComplete=false}={}){
    if(!isMutable(task))return[];
    const out=[];
    if(['assigned','reschedule_requested'].includes(task.status)&&owns(task,session,'photographer')){
      out.push({action:'confirm',label:'Confirm booking',tone:'primary'});
    }
    if(['assigned','confirmed','reschedule_requested'].includes(task.status)&&owns(task,session,'photographer')){
      out.push({action:'decline',label:'Decline booking',tone:'secondary'});
    }
    if(SOURCE_STATES.has(task.status)&&owns(task,session,'photographer')&&rawComplete){
      out.push({action:'source_ready',label:'Hand source media to editing',tone:'primary'});
    }
    if(['raw_received','revision'].includes(task.status)&&owns(task,session,'editor')){
      out.push({action:'start_editing',label:task.status==='revision'?'Start revision':'Start editing',tone:'primary'});
    }
    if(task.status==='editing'&&owns(task,session,'editor')){
      out.push({action:'submit_review',label:'Submit for review',tone:'primary'});
    }
    if(task.status==='review'&&owns(task,session,'agent')){
      out.push({action:'request_revision',label:'Request revision',tone:'secondary'});
      out.push({action:'approve_delivery',label:'Approve final delivery',tone:'primary'});
    }
    return out;
  }
  function uploadStages(task,session){
    if(!isMutable(task))return[];
    if(isManagement(session))return['01_RAW','02_EDITED','03_FINAL','04_REFERENCE'];
    if(owns(task,session,'agent'))return['04_REFERENCE'];
    if(owns(task,session,'photographer'))return['01_RAW','04_REFERENCE'];
    if(owns(task,session,'editor'))return['02_EDITED','03_FINAL','04_REFERENCE'];
    return[];
  }
  function compareProviders(a,b){
    const eligible=Number(Boolean(b.eligible))-Number(Boolean(a.eligible));
    if(eligible)return eligible;
    const missing=Number(a.missing?.length||0)-Number(b.missing?.length||0);
    if(missing)return missing;
    return String(a.user?.name||'').localeCompare(String(b.user?.name||''),'en',{sensitivity:'base'});
  }
  function sortProviders(providers){return[...(providers||[])].sort(compareProviders)}

  window.NorthlightContracts=Object.freeze({
    CLOSED,RESCHEDULABLE,REASSIGNABLE,
    navFor,mobileNavFor,isManagement,owns,isMutable,
    canReschedule,canCancel,canReassign,workflowActions,uploadStages,
    compareProviders,sortProviders
  });
})();
