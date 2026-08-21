import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createAppHarness,parseHTML} from './ui-dom-harness.mjs';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('personal Google Calendar remains Photographer-only across API, rendered UI and docs',async()=>{
  const [team,connect,index,readme,deployment]=await Promise.all([
    read('functions/api/team/[id].js'),
    read('functions/api/calendar/connect.js'),
    read('index.html'),
    read('README.md'),
    read('DEPLOYMENT.md')
  ]);

  assert.match(team,/if\(u\.role_code==='photographer'\)calendar=/);
  assert.doesNotMatch(team,/\['photographer','agent'\]\.includes\(u\.role_code\).*calendar=/s);
  assert.match(connect,/requireSession\(request,\s*env,\s*\['photographer'\]\)/);

  const h=createAppHarness(),boot={users:[{id:'photo-1',name:'Pat Photographer',role_code:'photographer'}],services:[],providers:[{user_id:'photo-1',areas:['Inner East'],service_codes:[],timezone:'Australia/Melbourne'}]};
  h.run(`state.bootstrap=${JSON.stringify(boot)};state.session=${JSON.stringify({role:'photographer',userId:'photo-1',name:'Pat Photographer'})}`);
  let page=parseHTML(h.run('availabilityView()'));
  assert.ok(page.querySelector('#connectMyCalendar'));
  assert.match(page.body.textContent,/Choose when Northlight may offer you work/);

  h.run(`state.session=${JSON.stringify({role:'owner',userId:'owner-1',name:'Owner User'})}`);
  page=parseHTML(h.run('availabilityView()'));
  assert.equal(page.querySelector('#connectMyCalendar'),null);
  assert.equal(h.contracts.navFor('agent').includes('availability'),false);
  assert.equal(h.contracts.navFor('editor').includes('availability'),false);
  assert.ok(parseHTML(index).querySelectorAll('script').some(x=>x.getAttribute('src')==='/assets/contract-runtime.js'));

  assert.match(readme,/each connected Photographer owns their external schedule/);
  assert.doesNotMatch(readme,/photographer\/agent/i);
  assert.match(deployment,/individual Photographer calendar connection/);
  assert.match(deployment,/Photographer → Availability → connect personal Google Calendar/);
  assert.doesNotMatch(deployment,/Agent\/Photographer|Photographer\/Agent/);
});
