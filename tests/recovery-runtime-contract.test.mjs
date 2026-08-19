import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('signed-in bootstrap safely nudges bounded system recovery',async()=>{
  const [runtime,recover,handoffs]=await Promise.all([
    read('assets/certification-runtime.js'),
    read('functions/api/handoffs/recover.js'),
    read('functions/_lib/task-handoffs.js')
  ]);

  assert.match(runtime,/async function recoverPending\(\)/);
  assert.match(runtime,/for\(let i=0;i<3;i\+\+\)/);
  assert.match(runtime,/baseFetch\('\/api\/handoffs\/recover'/);
  assert.match(runtime,/if\(!d\.processed\)break/);
  assert.match(runtime,/url\.includes\('\/api\/bootstrap'\).*queueMicrotask\(recoverPending\)/s);

  assert.match(recover,/requireSession\(request,env\)/);
  assert.match(recover,/\['admin','owner'\]\.includes\(a\.session\.role\).*recoverOneSystemJob\(env\)/s);
  assert.match(recover,/assignmentFilter\(a\.session\)/);
  assert.match(handoffs,/const cleanup=await recoverOneCalendarCleanup\(env,\{taskId\}\);if\(cleanup\)return cleanup;return recoverOneTaskHandoff/);
});
