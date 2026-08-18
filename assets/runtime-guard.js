(()=>{
  const nativeFetch=window.fetch.bind(window);
  const jsonHeaders={'content-type':'application/json'};
  let lastTask=null;
  function toast(title,msg=''){
    const t=document.querySelector('#toast');if(!t)return;
    t.innerHTML='';const strong=document.createElement('strong');strong.textContent=title;t.appendChild(strong);
    if(msg){const span=document.createElement('span');span.textContent=msg;t.appendChild(span)}
    t.classList.remove('hidden');clearTimeout(window.__nlGuardToast);window.__nlGuardToast=setTimeout(()=>t.classList.add('hidden'),5000);
  }
  function slotChecking(){const btn=document.querySelector('#nextStep');if(btn)btn.disabled=true;const box=document.querySelector('#slotCheck');if(box)box.textContent='Checking complete booking availability…'}
  function applySlotResult(d){setTimeout(()=>{const btn=document.querySelector('#nextStep'),box=document.querySelector('#slotCheck');if(btn)btn.disabled=d?.available!==true;if(box){box.innerHTML='';const icon=document.createElement('span');icon.textContent=d?.available?'✓':'△';const strong=document.createElement('strong');strong.textContent=d?.available?' Available.':' Not available.';const text=document.createElement('span');text.textContent=` ${d?.reason||'Choose another time.'}`;box.append(icon,strong,text)}},0)}
  async function handoff(taskId,kind){const r=await nativeFetch(`/api/tasks/${encodeURIComponent(taskId)}/handoff`,{method:'POST',credentials:'include',headers:jsonHeaders,body:JSON.stringify({kind})});let d={};try{d=await r.json()}catch{}if(!r.ok)throw new Error(d.error||`${kind} hand-off failed`);return d}
  function startHandoffs(task,kinds=['dropbox','calendar','email']){if(!task?.id)return;Promise.allSettled(kinds.map(k=>handoff(task.id,k))).then(results=>{const names={dropbox:'Dropbox',calendar:'Calendar',email:'Email'},parts=results.map((r,i)=>{const label=names[kinds[i]]||kinds[i];return r.status==='fulfilled'?(r.value.status==='done'?`${label} ✓`:r.value.status==='not_connected'?`${label} not connected`:`${label} attention`):`${label} attention`}),needs=results.some(r=>r.status==='rejected'||(r.status==='fulfilled'&&!['done','not_connected'].includes(r.value.status)));toast(needs?'Task safe · hand-off attention':'Hand-offs checked',parts.join(' · '))})}
  window.fetch=async function(input,init={}){
    const url=typeof input==='string'?input:(input?.url||'');
    const method=String(init?.method||'GET').toUpperCase();
    if(url.includes('/api/calendar/freebusy')&&method==='POST')slotChecking();
    const response=await nativeFetch(input,init);
    if(url.includes('/api/calendar/freebusy')&&method==='POST'){try{const d=await response.clone().json();applySlotResult(d)}catch{applySlotResult({available:false,reason:'Availability could not be verified.'})}}
    if(/\/api\/tasks(?:\?|$)/.test(url)&&method==='POST'&&response.ok){try{const d=await response.clone().json();queueMicrotask(()=>startHandoffs(d.task))}catch{}}
    if(/\/api\/tasks\/[^/?]+$/.test(url)&&method==='GET'&&response.ok){try{const d=await response.clone().json();lastTask=d.task||null;queueMicrotask(polish)}catch{}}
    return response;
  };
  async function addRecipientControl(){
    const title=document.querySelector('.topbar h2'),role=document.querySelector('.role-pill'),grid=document.querySelector('#page .settings-grid');
    if(title?.textContent?.trim()!=='Settings'||!/^Admin\b/i.test(role?.textContent||'')||!grid||document.querySelector('#operationsRecipientCard'))return;
    const card=document.createElement('div');card.id='operationsRecipientCard';card.className='card section-card';card.innerHTML='<span class="service-icon">@</span><h3>Notification recipient</h3><p class="detail-copy">Assignment mail goes to the assigned photographer when a real email is configured. This address is the operational fallback for pilot accounts and task alerts.</p><div class="field"><label for="operationsEmail">Operations email</label><input id="operationsEmail" type="email" autocomplete="email" placeholder="operations@realcapture.com.au"></div><button class="btn primary" id="saveOperationsEmail">Save recipient</button><div class="hint" id="operationsEmailStatus">Loading current recipient…</div>';
    grid.appendChild(card);
    try{const r=await nativeFetch('/api/settings',{credentials:'include'}),d=await r.json();if(!r.ok)throw new Error(d.error||'Could not load recipient');const input=card.querySelector('#operationsEmail'),status=card.querySelector('#operationsEmailStatus');input.value=d.operationsEmail||'';status.textContent=d.source==='workspace'?'Managed in Northlight Settings.':'Currently using the deployment fallback; save here to manage it in Northlight.';card.querySelector('#saveOperationsEmail').onclick=async()=>{const btn=card.querySelector('#saveOperationsEmail');btn.disabled=true;try{const rr=await nativeFetch('/api/settings',{method:'PATCH',credentials:'include',headers:jsonHeaders,body:JSON.stringify({operationsEmail:input.value.trim()})}),dd=await rr.json();if(!rr.ok)throw new Error(dd.error||'Could not save recipient');status.textContent='Saved in Northlight Settings.';toast('Notification recipient updated',dd.operationsEmail||'Deployment fallback restored.')}catch(e){toast('Could not update recipient',e.message)}finally{btn.disabled=false}}}catch(e){card.querySelector('#operationsEmailStatus').textContent=e.message}
  }
  async function openReassign(){
    if(!lastTask)return;
    try{const r=await nativeFetch('/api/bootstrap',{credentials:'include'}),d=await r.json();if(!r.ok)throw new Error(d.error||'Could not load photographers');const providers=d.providers||[],users=d.users||[],eligible=providers.filter(p=>p.user_id!==lastTask.photographer_user_id&&(p.areas||[]).includes(lastTask.area)&&(lastTask.service_codes||[]).every(s=>(p.service_codes||[]).includes(s))).map(p=>({p,u:users.find(x=>x.id===p.user_id)})).filter(x=>x.u?.active!==false);if(!eligible.length)return toast('No replacement available','Update photographer coverage or reschedule the booking.');const wrap=document.createElement('div');wrap.className='modal-bg top-modal';wrap.id='runtimeReassignModal';const modal=document.createElement('div');modal.className='modal small-modal';modal.innerHTML='<div class="modal-head"><div><div class="eyebrow">Booking recovery</div><h2>Reassign photographer</h2></div><button class="btn secondary icon-btn" id="runtimeCloseReassign" aria-label="Close reassignment">×</button></div><div class="modal-body"><p class="detail-copy">Only photographers configured for this area and every requested service are listed. Northlight will recheck working hours, existing bookings and Google Calendar before changing the assignment.</p><div class="field"><label for="runtimeReplacement">Replacement photographer</label><select id="runtimeReplacement"></select></div><button class="btn primary block" id="runtimeSaveReassign">Reassign & notify</button></div>';wrap.appendChild(modal);document.body.appendChild(wrap);const select=modal.querySelector('#runtimeReplacement');for(const x of eligible){const o=document.createElement('option');o.value=x.p.user_id;o.textContent=x.u.name;select.appendChild(o)}modal.querySelector('#runtimeCloseReassign').onclick=()=>wrap.remove();wrap.onclick=e=>{if(e.target===wrap)wrap.remove()};modal.querySelector('#runtimeSaveReassign').onclick=async()=>{const btn=modal.querySelector('#runtimeSaveReassign');btn.disabled=true;btn.textContent='Checking availability…';try{const rr=await nativeFetch(`/api/tasks/${encodeURIComponent(lastTask.id)}/assign`,{method:'POST',credentials:'include',headers:jsonHeaders,body:JSON.stringify({photographerId:select.value})}),dd=await rr.json();if(!rr.ok)throw new Error(dd.error||'Could not reassign photographer');wrap.remove();lastTask=dd.task;startHandoffs(dd.task,['calendar','email']);toast('Photographer reassigned','Northlight is rebuilding the Calendar and assignment notification.');setTimeout(()=>location.reload(),1200)}catch(e){toast('Could not reassign',e.message);btn.disabled=false;btn.textContent='Reassign & notify'}}}catch(e){toast('Could not open reassignment',e.message)}
  }
  function addReassignControl(){
    const drawer=document.querySelector('.drawer .drawer-content'),role=document.querySelector('.role-pill')?.textContent||'';
    if(!drawer||!lastTask||lastTask.status!=='declined'||document.querySelector('#runtimeReassignCard'))return;
    if(!/(Admin|Owner|Principal|Agent)/i.test(role))return;
    const card=document.createElement('div');card.id='runtimeReassignCard';card.className='card section-card';card.innerHTML='<h3>Recover this booking</h3><p class="detail-copy">The photographer declined. Choose another eligible photographer without recreating the property task.</p><button class="btn primary" id="runtimeReassignBtn">Reassign photographer</button>';
    const next=drawer.querySelector('.next');if(next?.nextSibling)drawer.insertBefore(card,next.nextSibling);else drawer.prepend(card);card.querySelector('#runtimeReassignBtn').onclick=openReassign;
  }
  function polish(){
    document.querySelectorAll('.crafted strong').forEach(el=>el.textContent='ProddyG');
    const art=document.querySelector('.login-art'),credit=document.querySelector('.login-card .crafted'),location=art?.querySelector(':scope > small');
    if(art&&credit&&location&&!art.querySelector('.login-meta')){const meta=document.createElement('div');meta.className='login-meta';art.appendChild(meta);meta.appendChild(location);meta.appendChild(credit)}
    addRecipientControl();addReassignControl();
  }
  new MutationObserver(polish).observe(document.documentElement,{childList:true,subtree:true});
  document.addEventListener('DOMContentLoaded',polish);
  polish();
})();
