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
  function enforce(){enforcePersonCalendarContract();clarifyTeamCalendarCopy()}
  new MutationObserver(enforce).observe(document.documentElement,{childList:true,subtree:true});
  document.addEventListener('DOMContentLoaded',enforce);
  enforce();
})();
