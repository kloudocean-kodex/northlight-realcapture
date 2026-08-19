(()=>{
  function enforcePersonCalendarContract(){
    for(const drawer of document.querySelectorAll('.person-drawer')){
      const eyebrow=drawer.querySelector('.eyebrow')?.textContent||'';
      const role=eyebrow.split('·')[0].trim().toLowerCase();
      if(!role||role==='photographer')continue;
      for(const card of drawer.querySelectorAll('.section-card')){
        const title=(card.querySelector('h3')?.textContent||'').replace(/\s+/g,' ').trim();
        if(title.includes('Google Calendar'))card.remove();
      }
    }
  }
  function clarifyTeamCalendarCopy(){
    if(document.querySelector('.topbar h2')?.textContent?.trim()!=='Team')return;
    const copy=document.querySelector('#page .hero p');
    if(copy&&copy.textContent.includes('connected calendars'))copy.textContent='Understand workload, coverage and Photographer calendar connections without exposing controls people do not need.';
  }
  function honestPhotographerChoice(){
    const modal=[...document.querySelectorAll('.modal')].find(x=>x.querySelector('.modal-head h2')?.textContent?.trim()==='Photographer');
    if(!modal)return;
    for(const badge of modal.querySelectorAll('.photo-option:not([disabled]) .badge')){
      const label=badge.textContent.trim();
      if(label==='Recommended'||label==='Available')badge.remove();
    }
    const wrap=modal.querySelector('.photo-options');
    if(wrap){
      const current=[...wrap.querySelectorAll('.photo-option')],desired=[...current].sort((a,b)=>{
        const setup=Number(a.disabled)-Number(b.disabled);if(setup)return setup;
        const an=a.querySelector('h3')?.textContent?.trim()||'',bn=b.querySelector('h3')?.textContent?.trim()||'';
        return an.localeCompare(bn,'en',{sensitivity:'base'});
      });
      if(desired.some((node,index)=>node!==current[index]))for(const node of desired)wrap.appendChild(node);
    }
  }
  function removeStaleEditorLoad(){
    for(const drawer of document.querySelectorAll('.person-drawer')){
      const role=(drawer.querySelector('.eyebrow')?.textContent||'').split('·')[0].trim().toLowerCase();if(role!=='editor')continue;
      for(const card of drawer.querySelectorAll('.section-card')){
        if(card.querySelector('h3')?.textContent?.trim()!=='Editor profile')continue;
        for(const copy of card.querySelectorAll('.detail-copy'))if(/^Current load\b/i.test(copy.textContent.trim()))copy.remove();
      }
    }
  }
  function polishMobileNav(){
    const activeView=document.querySelector('.sidebar .nav button.active[data-view]')?.dataset.view||'';
    for(const btn of document.querySelectorAll('.mobile-nav button[data-view]')){
      const active=!!activeView&&btn.dataset.view===activeView;
      if(btn.classList.contains('active')!==active)btn.classList.toggle('active',active);
      if(active){if(btn.getAttribute('aria-current')!=='page')btn.setAttribute('aria-current','page')}else if(btn.hasAttribute('aria-current'))btn.removeAttribute('aria-current');
    }
  }
  function clarifyIntegrationActions(){
    if(document.querySelector('.topbar h2')?.textContent?.trim()!=='Integrations')return;
    for(const card of document.querySelectorAll('.integration')){
      const title=card.querySelector('h3')?.textContent?.trim()||'',status=card.querySelector('.status')?.textContent?.trim()||'',connected=status==='Connected',primary=card.querySelector('.integration-actions .btn.primary');
      if(!primary)continue;
      let desired='';
      if(title==='Google Workspace')desired=connected?'Reconnect Google Workspace':'Connect Google Workspace';
      if(title==='Xero')desired=connected?'Reconnect Xero':'Connect Xero';
      if(desired&&primary.textContent.trim()!==desired)primary.textContent=desired;
    }
  }
  function hardenTemporaryPassword(){
    const input=document.querySelector('#tmPassword');if(!input)return;
    if(input.minLength!==12)input.minLength=12;
    if(input.autocomplete!=='new-password')input.autocomplete='new-password';
    if(!input.placeholder)input.placeholder='12+ characters';
    const field=input.closest('.field');if(!field||field.querySelector('#tmPasswordHint'))return;
    const hint=document.createElement('small');hint.id='tmPasswordHint';hint.className='field-help';hint.textContent='Use 12 or more characters. The team member can replace it with a personal password after sign-in.';field.appendChild(hint);input.setAttribute('aria-describedby','tmPasswordHint');
  }
  function svgCloseControls(){
    if(!window.NLIcon)return;
    for(const btn of document.querySelectorAll('.icon-btn')){
      if(btn.querySelector('svg'))continue;
      if(btn.textContent.trim()==='×')btn.innerHTML=window.NLIcon('close');
    }
  }
  function enforce(){enforcePersonCalendarContract();clarifyTeamCalendarCopy();honestPhotographerChoice();removeStaleEditorLoad();polishMobileNav();clarifyIntegrationActions();hardenTemporaryPassword();svgCloseControls()}
  new MutationObserver(enforce).observe(document.documentElement,{childList:true,subtree:true});
  document.addEventListener('DOMContentLoaded',enforce);
  enforce();
})();
