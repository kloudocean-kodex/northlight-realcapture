import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('personal Google Calendar remains Photographer-only across API, UI and docs',async()=>{
  const [team,connect,runtime,index,readme,deployment]=await Promise.all([
    read('functions/api/team/[id].js'),
    read('functions/api/calendar/connect.js'),
    read('assets/contract-runtime.js'),
    read('index.html'),
    read('README.md'),
    read('DEPLOYMENT.md')
  ]);

  assert.match(team,/if\(u\.role_code==='photographer'\)calendar=/);
  assert.doesNotMatch(team,/\['photographer','agent'\]\.includes\(u\.role_code\).*calendar=/s);
  assert.match(connect,/requireSession\(request,env,\['photographer'\]\)/);

  assert.match(runtime,/role==='photographer'/);
  assert.match(runtime,/title\.includes\('Google Calendar'\)\)card\.remove\(\)/);
  assert.match(index,/\/assets\/contract-runtime\.js/);

  assert.match(readme,/each connected Photographer owns their external schedule/);
  assert.doesNotMatch(readme,/photographer\/agent/i);
  assert.match(deployment,/individual Photographer calendar connection/);
  assert.match(deployment,/Photographer → Availability → connect personal Google Calendar/);
  assert.doesNotMatch(deployment,/Agent\/Photographer|Photographer\/Agent/);
});
