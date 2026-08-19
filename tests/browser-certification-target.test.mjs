import test from'node:test';
import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';

const workflow=await readFile(new URL('../.github/workflows/northlight-ci.yml',import.meta.url),'utf8');
const server=await readFile(new URL('../scripts/ci-browser-server.mjs',import.meta.url),'utf8');
const checker=await readFile(new URL('../scripts/ci-browser-check.mjs',import.meta.url),'utf8');

test('browser certification tests exact PR code locally and deployed production for release certification',()=>{
  assert.match(workflow,/HEAD_REF: \$\{\{ github\.head_ref \}\}/);
  assert.match(workflow,/PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow,/northlight-certification-\*\)/);
  assert.match(workflow,/target='https:\/\/northlight-realcapture\.pages\.dev'\s+expected="\$PR_BASE_SHA"/s);
  assert.match(workflow,/node scripts\/ci-browser-server\.mjs/);
  assert.match(workflow,/target='http:\/\/127\.0\.0\.1:4173'\s+expected="\$CURRENT_SHA"/s);
  assert.doesNotMatch(workflow,/\$\{alias\}\.northlight-realcapture\.pages\.dev/);
  assert.match(workflow,/CHROME_BIN="\$chrome" timeout --signal=TERM --kill-after=5s 40s node scripts\/ci-browser-check\.mjs "\$target"/);
  assert.doesNotMatch(workflow,/--dump-dom/);
});

test('DevTools browser check uses Chromium pipe transport and proves sustained main-thread responsiveness',()=>{
  assert.match(checker,/--remote-debugging-pipe/);
  assert.doesNotMatch(checker,/remote-debugging-port=/);
  assert.match(checker,/stdio:\['ignore','ignore','pipe','pipe','pipe'\]/);
  assert.match(checker,/pipeClient\(browser\.stdio\[3\],browser\.stdio\[4\]\)/);
  assert.match(checker,/Buffer\.from\(\[0\]\)/);
  assert.match(checker,/command\('Target\.attachToTarget'/);
  assert.match(checker,/command\('Page\.navigate'/);
  assert.match(checker,/command\('Runtime\.evaluate'/g);
  assert.match(checker,/loginForm:!!document\.getElementById\('loginForm'\)/);
  assert.match(checker,/await sleep\(1000\)/);
  assert.match(checker,/Real-browser main thread responsive twice/);
});

test('local PR browser server serves built assets without granting an authenticated API',()=>{
  assert.match(server,/resolve\(process\.cwd\(\),'dist'\)/);
  assert.match(server,/startsWith\('\/api\/'\)/);
  assert.match(server,/writeHead\(401/);
  assert.match(server,/Authentication required/);
  assert.match(server,/resolve\(join\(root,rel\)\)/);
});
