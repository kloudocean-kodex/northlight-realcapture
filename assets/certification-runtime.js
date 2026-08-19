(()=>{
  const baseFetch=window.fetch.bind(window),jsonHeaders={'content-type':'application/json'};
  let wizardArea='',wizardServices=[],sessionRole='',recovering=false;
  function captureWizard(){const area=document.querySelector('#wArea');if(area){wizardArea=area.value||wizardArea;if(!area.dataset.certCapture){area.dataset.certCapture='1';area.addEventListener('change',()=>{wizardArea=area.value})}}const services=[...document.querySelectorAll('[data-service]')];if(services.length)wizardServices=services.filter(x=>x.classList.contains('on')).map(x=>x.dataset.service).filter(Boolean)}
  async function recoverPending(){if(recovering||!['admin','owner','agent'].includes(sessionRole))return;recovering=true;try{for(let i=0;i<3;i++){const r=await baseFetch('/api/handoffs/recover',{method:'POST',credentials:'include',headers:jsonHeaders,body:'{}'});if(!r.ok)break;const d=await r.json();if(!d.processed)break}}catch{}finally{recovering=false}}
  window.fetch=async function(input,init={}){const url=typeof input==='string'?input:(input?.url||''),method=String(init?.method||'GET').toUpperCase();let next=init;if(url.includes('/api/calendar/freebusy')&&method==='POST'){try{const b=JSON.parse(String(init.body||'{}'));if(!b.area&&wizardArea)b.area=wizardArea;if((!Array.isArray(b.services)||!b.services.length)&&wizardServices.length)b.services=wizardServices;next={...init,body:JSON.stringify(b)}}catch{}}
    const r=await baseFetch(input,next);
    if(url.includes('/api/bootstrap')&&method==='GET'&&r.ok){try{const d=await r.clone().json();sessionRole=d.session?.role||'';queueMicrotask(recoverPending)}catch{}}
    return r;
  };
  new MutationObserver(captureWizard).observe(document.documentElement,{childList:true,subtree:true});document.addEventListener('DOMContentLoaded',captureWizard);captureWizard();
})();
