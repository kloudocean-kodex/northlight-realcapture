import test from 'node:test';
import assert from 'node:assert/strict';
import {createAppHarness,loadContracts,parseHTML,settle} from './ui-dom-harness.mjs';

const NAV={
  admin:['today','tasks','booking','attention','team','availability','editor','services','roles','integrations','settings'],
  owner:['today','tasks','booking','attention','team','availability','integrations'],
  agent:['today','tasks','booking','attention'],
  photographer:['today','tasks','availability'],
  editor:['today','tasks','editor']
};

test('role navigation renders the exact desktop destinations and four-tab-plus-More mobile model',()=>{
  const h=createAppHarness();
  for(const [role,expected] of Object.entries(NAV)){
    h.run(`state.session=${JSON.stringify({role,userId:`${role}-1`,name:`${role} user`,roleLabel:role})};state.bootstrap={users:[],services:[],providers:[]};state.view='today'`);
    const dom=parseHTML(h.run('appFrame()'));
    assert.deepEqual(dom.querySelectorAll('.sidebar [data-view]').map(x=>x.dataset.view),expected,`${role} desktop navigation`);
    const primary=dom.querySelectorAll('.mobile-nav [data-view]').map(x=>x.dataset.view);
    assert.deepEqual(primary,expected.slice(0,4),`${role} mobile primary navigation`);
    assert.equal(dom.querySelectorAll('.mobile-nav [data-mobile-more]').length,expected.length>4?1:0,`${role} More control`);
    assert.equal(dom.querySelectorAll('.mobile-nav [aria-current="page"]').length,1,`${role} current page`);
    assert.ok(dom.querySelectorAll('.mobile-nav button').length<=5,`${role} mobile navigation remains calm`);
  }
});

test('workflow actions and upload stages obey the complete role, ownership and lifecycle matrix',()=>{
  const c=loadContracts(),ids={agent_user_id:'agent-1',photographer_user_id:'photo-1',editor_user_id:'editor-1'};
  const actions=(status,session,rawComplete=false)=>Array.from(c.workflowActions({id:'task-1',status,...ids},session,{rawComplete}),x=>x.action);
  assert.deepEqual(actions('assigned',{role:'photographer',userId:'photo-1'}),['confirm','decline']);
  assert.deepEqual(actions('assigned',{role:'photographer',userId:'other'}),[]);
  assert.deepEqual(actions('confirmed',{role:'photographer',userId:'photo-1'},false),['decline']);
  assert.deepEqual(actions('confirmed',{role:'photographer',userId:'photo-1'},true),['decline','source_ready']);
  assert.deepEqual(actions('raw_received',{role:'editor',userId:'editor-1'}),['start_editing']);
  assert.deepEqual(actions('revision',{role:'editor',userId:'editor-1'}),['start_editing']);
  assert.deepEqual(actions('editing',{role:'editor',userId:'editor-1'}),['submit_review']);
  assert.deepEqual(actions('review',{role:'agent',userId:'agent-1'}),['request_revision','approve_delivery']);
  for(const status of['delivered','cancelled'])assert.deepEqual(actions(status,{role:'admin',userId:'admin-1'},true),[]);
  assert.deepEqual(Array.from(c.workflowActions({status:'assigned',archived_at:'2026-08-21',...ids},{role:'admin',userId:'admin-1'})),[]);
  assert.deepEqual(Array.from(c.uploadStages({status:'confirmed',...ids},{role:'photographer',userId:'photo-1'})),['01_RAW','04_REFERENCE']);
  assert.deepEqual(Array.from(c.uploadStages({status:'editing',...ids},{role:'editor',userId:'editor-1'})),['02_EDITED','03_FINAL','04_REFERENCE']);
  assert.deepEqual(Array.from(c.uploadStages({status:'review',...ids},{role:'agent',userId:'agent-1'})),['04_REFERENCE']);
});

test('Photographer selection starts explicit, disables incomplete matches and never preselects a provider',()=>{
  const h=createAppHarness(),boot={users:[{id:'agent-1',name:'Agent A',role_code:'agent',active:true},{id:'photo-a',name:'Alex Able',role_code:'photographer',active:true},{id:'photo-b',name:'Blair Busy',role_code:'photographer',active:true}],services:[{code:'photos',name:'Photography',duration_min:60,buffer_before_min:10,buffer_after_min:10,active:true}],providers:[{user_id:'photo-b',areas:['West'],service_codes:['photos']},{user_id:'photo-a',areas:['Inner East'],service_codes:['photos']}]};
  h.run(`state.session=${JSON.stringify({role:'agent',userId:'agent-1',name:'Agent A'})};state.bootstrap=${JSON.stringify(boot)};state.wizard=${JSON.stringify({step:3,services:['photos'],agentId:'agent-1',property:'24 Albany',address:'24 Albany Rd VIC 3142',suburb:'Toorak',area:'Inner East',photographerId:null,slotAvailable:false})};drawWizard()`);
  let radios=h.document.querySelectorAll('[role="radio"]');
  assert.equal(radios.length,2);
  assert.equal(radios.filter(x=>x.getAttribute('aria-checked')==='true').length,0);
  assert.equal(radios.find(x=>x.dataset.provider==='photo-b').disabled,true);
  assert.equal(h.document.querySelector('#nextStep').disabled,true);
  radios.find(x=>x.dataset.provider==='photo-a').click();
  radios=h.document.querySelectorAll('[role="radio"]');
  assert.equal(radios.filter(x=>x.getAttribute('aria-checked')==='true').length,1);
  assert.equal(radios.find(x=>x.dataset.provider==='photo-a').getAttribute('aria-checked'),'true');
  assert.equal(h.document.querySelector('#nextStep').disabled,false);
});

test('booking confirmation sends full context, blocks until checked and resolves an ambiguous DST occurrence explicitly',async()=>{
  const h=createAppHarness(),boot={users:[{id:'agent-1',name:'Agent A',role_code:'agent',active:true},{id:'photo-a',name:'Alex Able',role_code:'photographer',active:true}],services:[{code:'photos',name:'Photography',duration_min:60,buffer_before_min:10,buffer_after_min:10,active:true}],providers:[{user_id:'photo-a',areas:['Inner East'],service_codes:['photos']}]};
  h.responses.push({ok:false,status:409,data:{error:'This local time occurs twice.',detail:{timeChoices:[{disambiguation:'earlier',offset:'+1100'},{disambiguation:'later',offset:'+1000'}]}}},{data:{available:true,connected:true,timeDisambiguation:'later'}});
  h.run(`state.session=${JSON.stringify({role:'agent',userId:'agent-1',name:'Agent A'})};state.bootstrap=${JSON.stringify(boot)};state.wizard=${JSON.stringify({step:4,services:['photos'],agentId:'agent-1',property:'24 Albany',address:'24 Albany Road, Toorak VIC 3142',suburb:'Toorak',area:'Inner East',photographerId:'photo-a',date:'2027-04-04',time:'07:30',slotAvailable:false,notes:'Gate code 1248'})};drawWizard()`);
  assert.equal(h.document.querySelector('#nextStep').disabled,true);
  await settle();await settle();
  const first=h.requests.at(-1).body;
  assert.deepEqual({photographerId:first.photographerId,area:first.area,services:first.services,startLocal:first.startLocal,timeDisambiguation:first.timeDisambiguation},{photographerId:'photo-a',area:'Inner East',services:['photos'],startLocal:'2027-04-04T07:30',timeDisambiguation:null});
  const choices=h.document.querySelectorAll('[data-time-choice]');
  assert.deepEqual(choices.map(x=>x.dataset.timeChoice),['earlier','later']);
  assert.equal(h.document.querySelector('#nextStep').disabled,true);
  choices.find(x=>x.dataset.timeChoice==='later').click();
  await settle();await settle();
  assert.equal(h.requests.at(-1).body.timeDisambiguation,'later');
  assert.equal(h.document.querySelector('#nextStep').disabled,false);
  assert.match(h.document.querySelector('.booking-readback').textContent,/24 Albany Road, Toorak VIC 3142/);
  assert.match(h.document.querySelector('.booking-readback').textContent,/Alex Able/);
  assert.match(h.document.querySelector('#slotCheck').textContent,/Available/);
});

test('mobile More is a labelled modal with SVG destinations and a working close control',()=>{
  const h=createAppHarness();h.run(`state.session=${JSON.stringify({role:'admin',userId:'admin-1',name:'Admin User'})};state.bootstrap={users:[],services:[],providers:[]};state.view='today';openMobileNav()`);
  const modal=h.document.querySelector('#mobileMoreBg .modal');
  assert.equal(modal.getAttribute('role'),'dialog');
  assert.equal(modal.getAttribute('aria-modal'),'true');
  assert.equal(modal.getAttribute('aria-labelledby'),'mobileMoreTitle');
  assert.equal(h.document.querySelectorAll('[data-more-view]').length,NAV.admin.length-4);
  assert.ok(h.document.querySelectorAll('[data-more-view] svg').length>=NAV.admin.length-4);
  const close=h.document.querySelector('#closeMobileMore');assert.equal(close.getAttribute('type'),'button');assert.ok(close.querySelector('svg'));close.click();
  assert.equal(h.document.querySelector('#mobileMoreBg'),null);
});

test('task rows retain schedule and Photographer context in the mobile-only summary',()=>{
  const h=createAppHarness(),boot={users:[{id:'photo-a',name:'Alex Able'}],services:[{code:'photos',name:'Photography'}],providers:[]};
  h.run(`state.session=${JSON.stringify({role:'agent',userId:'agent-1',name:'Agent A'})};state.bootstrap=${JSON.stringify(boot)}`);
  const task={id:'t1',task_no:'RC-1042',property_name:'24 Albany',address:'24 Albany Road',suburb:'Toorak',status:'confirmed',scheduled_start:'2027-01-15T00:30:00.000Z',photographer_user_id:'photo-a',service_codes:['photos']};
  const dom=parseHTML(h.run(`taskRow(${JSON.stringify(task)})`));
  const summary=dom.querySelector('.task-mobile-meta');
  assert.ok(summary);assert.match(summary.textContent,/Alex Able/);assert.match(summary.textContent,/15 Jan/);
  assert.equal(dom.querySelector('.task-person').textContent.includes('Alex Able'),true);
});

test('Photographer availability replaces every loading placeholder with the same connected-calendar truth',async()=>{
  const h=createAppHarness(),boot={users:[{id:'photo-1',name:'Priya Photographer',role_code:'photographer',active:true}],services:[{code:'photos',name:'Photography'}],providers:[{user_id:'photo-1',areas:['Inner East'],service_codes:['photos'],timezone:'Australia/Melbourne'}]};
  h.run(`state.session=${JSON.stringify({role:'photographer',userId:'photo-1',name:'Priya Photographer'})};state.bootstrap=${JSON.stringify(boot)};state.view='availability';document.querySelector('#root').innerHTML=appFrame();document.querySelector('#page').innerHTML=availabilityView()`);
  assert.match(h.document.querySelector('.calendar-chip').textContent,/loading/i);
  h.responses.push({data:{connected:true,account:'priya@example.test',sync:{}}});
  await h.run('hydrateCalendars()');
  assert.match(h.document.querySelector('.calendar-chip').textContent,/Calendar protected/);
  assert.doesNotMatch(h.document.querySelector('.calendar-chip').textContent,/loading/i);
  assert.match(h.document.querySelector('#myCalStatus').textContent,/Connected and protecting bookings/);
  assert.match(h.document.querySelector('#myCalStatus').textContent,/priya@example\.test/);
});

test('Photographer availability exposes one accessible weekly schedule and privacy-minimal date overrides',()=>{
  const h=createAppHarness(),profile={user_id:'photo-1',areas:['Inner East'],service_codes:['photos'],working_hours:{mon:['08:00','17:00'],fri:['09:00','15:00']},days_off:['2026-12-25'],special_days:[{date:'2026-12-24',closed:false,hours:['08:00','12:00']}],timezone:'Australia/Melbourne',availability_version:7},boot={users:[{id:'photo-1',name:'Priya Photographer',role_code:'photographer',active:true}],services:[{code:'photos',name:'Photography'}],providers:[profile]};
  h.run(`state.session=${JSON.stringify({role:'photographer',userId:'photo-1',name:'Priya Photographer',mustChangePassword:false})};state.bootstrap=${JSON.stringify(boot)};state.view='availability';document.querySelector('#root').innerHTML=appFrame();document.querySelector('#page').innerHTML=availabilityView()`);
  const form=h.document.querySelector('#availabilityForm');
  assert.ok(form);assert.equal(form.getAttribute('data-version'),'7');
  assert.equal(form.querySelectorAll('[data-availability-day]').length,7);
  assert.equal(form.querySelectorAll('[data-working-toggle][checked]').length,2);
  assert.equal(form.querySelectorAll('[data-exception="day-off"]').length,1);
  assert.equal(form.querySelectorAll('[data-exception="special-hours"]').length,1);
  assert.ok(form.querySelector('#saveAvailability'));
  assert.match(h.document.querySelector('.privacy-note').textContent,/Event titles, guests and descriptions are not shown/);
  const payload=h.run('availabilityPayload()');
  assert.deepEqual(JSON.parse(JSON.stringify(payload)),{expectedVersion:7,workingHours:{mon:['08:00','17:00'],fri:['09:00','15:00']},daysOff:['2026-12-25'],specialDays:[{date:'2026-12-24',hours:['08:00','12:00']}],timeZone:'Australia/Melbourne'});
});

test('integration cards state both supported data directions and expose safe lifecycle actions',()=>{
  const h=createAppHarness(),boot={users:[],services:[],providers:[],integrations:[{provider:'dropbox',status:'connected',account_label:'Media'},{provider:'google',status:'connected',account_label:'Operations'},{provider:'xero',status:'connected',account_label:'Finance'}]};
  h.run(`state.session=${JSON.stringify({role:'admin',userId:'admin-1',name:'Avery Admin'})};state.bootstrap=${JSON.stringify(boot)}`);
  const dom=parseHTML(h.run('integrationsView()'));
  assert.equal(dom.querySelectorAll('.integration-flow').length,3);
  assert.match(dom.querySelector('.provider-dropbox .integration-flow').textContent,/Northlight → Dropbox/);
  assert.match(dom.querySelector('.provider-dropbox .integration-flow').textContent,/Dropbox → Northlight/);
  assert.match(dom.querySelector('.provider-google .integration-flow').textContent,/Verify draft and send state/);
  assert.match(dom.querySelector('.provider-xero .integration-flow').textContent,/payment status/);
  assert.equal(dom.querySelectorAll('[data-disconnect]').length,3);
  assert.equal(dom.querySelector('.provider-whatsapp .integration-flow'),null);
  assert.ok(dom.querySelector('.provider-whatsapp button[disabled]'));
});
