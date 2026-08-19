import test from'node:test';
import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';

const workflow=await readFile(new URL('../.github/workflows/northlight-ci.yml',import.meta.url),'utf8');
const server=await readFile(new URL('../scripts/ci-browser-server.mjs',import.meta.url),'utf8');

test('browser certification tests exact PR code locally and deployed production for release certification',()=>{
  assert.match(workflow,/HEAD_REF: \$\{\{ github\.head_ref \}\}/);
  assert.match(workflow,/PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow,/northlight-certification-\*\)/);
  assert.match(workflow,/target='https:\/\/northlight-realcapture\.pages\.dev'\s+expected="\$PR_BASE_SHA"/s);
  assert.match(workflow,/node scripts\/ci-browser-server\.mjs/);
  assert.match(workflow,/target='http:\/\/127\.0\.0\.1:4173'\s+expected="\$CURRENT_SHA"/s);
  assert.doesNotMatch(workflow,/\$\{alias\}\.northlight-realcapture\.pages\.dev/);
  assert.match(workflow,/timeout --signal=KILL 30s "\$chrome"/);
  assert.match(workflow,/grep -Fq 'id="loginForm"'/);
});

test('local PR browser server serves built assets without granting an authenticated API',()=>{
  assert.match(server,/startsWith\('\/api\/'\)/);
  assert.match(server,/writeHead\(401/);
  assert.match(server,/Authentication required/);
  assert.match(server,/resolve\(join\(root,rel\)\)/);
});
