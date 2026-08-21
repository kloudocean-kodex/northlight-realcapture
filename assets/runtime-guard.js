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
  async function handoff(taskId,kind){const r=await nativeFetch(`/api/tasks/${encodeURIComponent(taskId)}/handoff`,{method:'POST',credentials:'include',headers:jsonHeaders,body:JSON.stringify({kind})});let d={};try{d=await r.json()}catch{}if(!r.ok)throw new Error(d.error||`${kind} hand-off failed`);return d}
  function startHandoffs(task,kinds=['dropbox','calendar','email']){if(!task?.id)return;Promise.allSettled(kinds.map(k=>handoff(task.id,k))).then(results=>{const names={dropbox:'Dropbox',calendar:'Calendar',email:'Email'},parts=results.map((r,i)=>{const label=names[kinds[i]]||kinds[i];return r.status==='fulfilled'?(r.value.status==='done'?`${label} ✓`:r.value.status==='not_connected'?`${label} not connected`:`${label} attention`):`${label} attention`}),needs=results.some(r=>r.status==='rejected'||(r.status==='fulfilled'&&!['done','not_connected'].includes(r.value.status)));toast(needs?'Task safe · hand-off attention':'Hand-offs checked',parts.join(' · '))})}
  window.fetch=async function(input,init={}){
    const url=typeof input==='string'?input:(input?.url||'');
    const method=String(init?.method||'GET').toUpperCase();
    const response=await nativeFetch(input,init);
    if(/\/api\/tasks(?:\?|$)/.test(url)&&method==='POST'&&response.ok){try{const d=await response.clone().json();queueMicrotask(()=>startHandoffs(d.task))}catch{}}
    if(/\/api\/tasks\/[^/?]+$/.test(url)&&method==='GET'&&response.ok){try{const d=await response.clone().json();lastTask=d.task||null;queueMicrotask(polish)}catch{}}
    return response;
  };
  async function openReassign(){
    if(!lastTask)return;
    try{const r=await nativeFetch('/api/bootstrap',{credentials:'include'}),d=await r.json();if(!r.ok)throw new Error(d.error||'Could not load photographers');const providers=d.providers||[],users=d.users||[],eligible=providers.filter(p=>p.user_id!==lastTask.photographer_user_id&&(p.areas||[]).includes(lastTask.area)&&(lastTask.service_codes||[]).every(s=>(p.service_codes||[]).includes(s))).map(p=>({p,u:users.find(x=>x.id===p.user_id)})).filter(x=>x.u?.active!==false).sort((a,b)=>String(a.u?.name||'').localeCompare(String(b.u?.name||''),'en',{sensitivity:'base'}));if(!eligible.length)return toast('No replacement available','Update Photographer coverage or reschedule the booking.');const wrap=document.createElement('div');wrap.className='modal-bg top-modal';wrap.id='runtimeReassignModal';const modal=document.createElement('div');modal.className='modal small-modal';modal.innerHTML=`<div class="modal-head"><div><div class="eyebrow">Booking assignment</div><h2>Reassign Photographer</h2></div><button class="btn secondary icon-btn" type="button" id="runtimeCloseReassign" aria-label="Close reassignment">${window.NLIcon?window.NLIcon('close'):'Close'}</button></div><div class="modal-body"><p class="detail-copy">Only Photographers configured for this area and every requested service are listed. Northlight will recheck working hours, other bookings and Google Calendar before changing the assignment.</p><div class="field"><label for="runtimeReplacement">Replacement Photographer</label><select id="runtimeReplacement"></select></div><button class="btn primary block" type="button" id="runtimeSaveReassign">Reassign and notify</button></div>`;wrap.appendChild(modal);document.body.appendChild(wrap);const select=modal.querySelector('#runtimeReplacement');for(const x of eligible){const o=document.createElement('option');o.value=x.p.user_id;o.textContent=x.u.name;select.appendChild(o)}modal.querySelector('#runtimeCloseReassign').onclick=()=>wrap.remove();wrap.onclick=e=>{if(e.target===wrap)wrap.remove()};modal.querySelector('#runtimeSaveReassign').onclick=async()=>{const btn=modal.querySelector('#runtimeSaveReassign');btn.disabled=true;btn.textContent='Checking availability…';try{const rr=await nativeFetch(`/api/tasks/${encodeURIComponent(lastTask.id)}/assign`,{method:'POST',credentials:'include',headers:jsonHeaders,body:JSON.stringify({photographerId:select.value})}),dd=await rr.json();if(!rr.ok)throw new Error(dd.error||'Could not reassign Photographer');wrap.remove();lastTask=dd.task;startHandoffs(dd.task,['calendar','email']);toast('Photographer reassigned','Calendar and assignment notification are being reconciled.');if(window.NorthlightUI?.refreshTask)await window.NorthlightUI.refreshTask(dd.task.id);else location.reload()}catch(e){toast('Could not reassign',e.message);btn.disabled=false;btn.textContent='Reassign and notify'}}}catch(e){toast('Could not open reassignment',e.message)}
  }
  function addReassignControl(){
    const drawer=document.querySelector('.drawer .drawer-content'),role=document.querySelector('.role-pill')?.textContent||'';
    if(!drawer||!lastTask||document.querySelector('#runtimeReassignCard'))return;
    const management=/(Admin|Owner|Principal)/i.test(role),agent=/Agent/i.test(role),statusAllowed=['assigned','declined','confirmed','reschedule_requested'].includes(lastTask.status);
    if(!(management&&statusAllowed||agent&&lastTask.status==='declined'))return;
    const declined=lastTask.status==='declined',card=document.createElement('div');card.id='runtimeReassignCard';card.className='card section-card';card.innerHTML=`<h3>${declined?'Recover this booking':'Assignment'}</h3><p class="detail-copy">${declined?'The Photographer declined. Choose another eligible Photographer without recreating the property task.':'Change the accountable Photographer only when the booking needs operational reassignment.'}</p><button class="btn ${declined?'primary':'secondary'}" type="button" id="runtimeReassignBtn">Reassign Photographer</button>`;
    const next=drawer.querySelector('.next');if(next?.nextSibling)drawer.insertBefore(card,next.nextSibling);else drawer.prepend(card);card.querySelector('#runtimeReassignBtn').onclick=openReassign;
  }
  function polish(){
    document.querySelectorAll('.crafted strong').forEach(el=>{if(el.textContent!=='ProddyG')el.textContent='ProddyG'});
    const art=document.querySelector('.login-art'),credit=document.querySelector('.login-card .crafted'),location=art?.querySelector(':scope > small');
    if(art&&credit&&location&&!art.querySelector('.login-meta')){const meta=document.createElement('div');meta.className='login-meta';art.appendChild(meta);meta.appendChild(location);meta.appendChild(credit)}
    addReassignControl();
  }
  document.addEventListener('northlight:rendered',polish);
  document.addEventListener('DOMContentLoaded',polish);
  polish();
})();
