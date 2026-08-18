(()=>{
  const nativeFetch=window.fetch.bind(window);
  const jsonHeaders={'content-type':'application/json'};
  function toast(title,msg=''){
    const t=document.querySelector('#toast');if(!t)return;
    t.innerHTML='';const strong=document.createElement('strong');strong.textContent=title;t.appendChild(strong);
    if(msg){const span=document.createElement('span');span.textContent=msg;t.appendChild(span)}
    t.classList.remove('hidden');clearTimeout(window.__nlGuardToast);window.__nlGuardToast=setTimeout(()=>t.classList.add('hidden'),5000);
  }
  function slotChecking(){const btn=document.querySelector('#nextStep');if(btn)btn.disabled=true;const box=document.querySelector('#slotCheck');if(box)box.textContent='Checking complete booking availability…'}
  function applySlotResult(d){setTimeout(()=>{const btn=document.querySelector('#nextStep'),box=document.querySelector('#slotCheck');if(btn)btn.disabled=d?.available!==true;if(box){box.innerHTML='';const icon=document.createElement('span');icon.textContent=d?.available?'✓':'△';const strong=document.createElement('strong');strong.textContent=d?.available?' Available.':' Not available.';const text=document.createElement('span');text.textContent=` ${d?.reason||'Choose another time.'}`;box.append(icon,strong,text)}},0)}
  async function handoff(taskId,kind){const r=await nativeFetch(`/api/tasks/${encodeURIComponent(taskId)}/handoff`,{method:'POST',credentials:'include',headers:jsonHeaders,body:JSON.stringify({kind})});let d={};try{d=await r.json()}catch{}if(!r.ok)throw new Error(d.error||`${kind} hand-off failed`);return d}
  function startHandoffs(task){if(!task?.id)return;Promise.allSettled(['dropbox','calendar','email'].map(k=>handoff(task.id,k))).then(results=>{const labels=['Dropbox','Calendar','Email'],parts=results.map((r,i)=>r.status==='fulfilled'?(r.value.status==='done'?`${labels[i]} ✓`:r.value.status==='not_connected'?`${labels[i]} not connected`:`${labels[i]} attention`):`${labels[i]} attention`),needs=results.some(r=>r.status==='rejected'||(r.status==='fulfilled'&&!['done','not_connected'].includes(r.value.status)));toast(needs?'Task created · hand-off attention':'Task created · hand-offs checked',parts.join(' · '))})}
  window.fetch=async function(input,init={}){
    const url=typeof input==='string'?input:(input?.url||'');
    const method=String(init?.method||'GET').toUpperCase();
    if(url.includes('/api/calendar/freebusy')&&method==='POST')slotChecking();
    const response=await nativeFetch(input,init);
    if(url.includes('/api/calendar/freebusy')&&method==='POST'){try{const d=await response.clone().json();applySlotResult(d)}catch{applySlotResult({available:false,reason:'Availability could not be verified.'})}}
    if(/\/api\/tasks(?:\?|$)/.test(url)&&method==='POST'&&response.ok){try{const d=await response.clone().json();queueMicrotask(()=>startHandoffs(d.task))}catch{}}
    return response;
  };
  async function addRecipientControl(){
    const title=document.querySelector('.topbar h2'),role=document.querySelector('.role-pill'),grid=document.querySelector('#page .settings-grid');
    if(title?.textContent?.trim()!=='Settings'||!/^Admin\b/i.test(role?.textContent||'')||!grid||document.querySelector('#operationsRecipientCard'))return;
    const card=document.createElement('div');card.id='operationsRecipientCard';card.className='card section-card';card.innerHTML='<span class="service-icon">@</span><h3>Notification recipient</h3><p class="detail-copy">Assignment mail goes to the assigned photographer when a real email is configured. This address is the operational fallback for pilot accounts and task alerts.</p><div class="field"><label for="operationsEmail">Operations email</label><input id="operationsEmail" type="email" autocomplete="email" placeholder="operations@realcapture.com.au"></div><button class="btn primary" id="saveOperationsEmail">Save recipient</button><div class="hint" id="operationsEmailStatus">Loading current recipient…</div>';
    grid.appendChild(card);
    try{const r=await nativeFetch('/api/settings',{credentials:'include'}),d=await r.json();if(!r.ok)throw new Error(d.error||'Could not load recipient');const input=card.querySelector('#operationsEmail'),status=card.querySelector('#operationsEmailStatus');input.value=d.operationsEmail||'';status.textContent=d.source==='workspace'?'Managed in Northlight Settings.':'Currently using the deployment fallback; save here to manage it in Northlight.';card.querySelector('#saveOperationsEmail').onclick=async()=>{const btn=card.querySelector('#saveOperationsEmail');btn.disabled=true;try{const rr=await nativeFetch('/api/settings',{method:'PATCH',credentials:'include',headers:jsonHeaders,body:JSON.stringify({operationsEmail:input.value.trim()})}),dd=await rr.json();if(!rr.ok)throw new Error(dd.error||'Could not save recipient');status.textContent='Saved in Northlight Settings.';toast('Notification recipient updated',dd.operationsEmail||'Deployment fallback restored.')}catch(e){toast('Could not update recipient',e.message)}finally{btn.disabled=false}}}catch(e){card.querySelector('#operationsEmailStatus').textContent=e.message}
  }
  function polish(){
    document.querySelectorAll('.crafted strong').forEach(el=>el.textContent='ProddyG');
    const art=document.querySelector('.login-art'),credit=document.querySelector('.login-card .crafted'),location=art?.querySelector(':scope > small');
    if(art&&credit&&location&&!art.querySelector('.login-meta')){const meta=document.createElement('div');meta.className='login-meta';art.appendChild(meta);meta.appendChild(location);meta.appendChild(credit)}
    addRecipientControl();
  }
  new MutationObserver(polish).observe(document.documentElement,{childList:true,subtree:true});
  document.addEventListener('DOMContentLoaded',polish);
  polish();
})();
