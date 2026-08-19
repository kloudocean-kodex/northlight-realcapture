import test from'node:test';
import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';

const workflow=await readFile(new URL('../.github/workflows/northlight-ci.yml',import.meta.url),'utf8');
const server=await readFile(new URL('../scripts/ci-browser-server.mjs',import.meta.url),'utf8');

test('real Chrome always executes the exact built dist artifact under a hard timeout',()=>{
  assert.match(workflow,/Verify rendered login from exact built UI in real Chrome/);
  assert.match(workflow,/node scripts\/ci-browser-server\.mjs/);
  assert.match(workflow,/http:\/\/127\.0\.0\.1:4173\/build-info\.json/);
  assert.match(workflow,/timeout --signal=KILL 30s "\$chrome"[^\n]*--dump-dom 'http:\/\/127\.0\.0\.1:4173\/'/);
  assert.match(workflow,/grep -Fq 'id="loginForm"'/);
  assert.match(workflow,/grep -Fq 'ProddyG'/);
  assert.doesNotMatch(workflow,/remote-debugging-(?:port|pipe)/);
});

test('release certification proves Cloudflare serves the same static UI bytes that Chrome tested',()=>{
  assert.match(workflow,/Verify deployed static UI matches browser-tested artifact/);
  assert.match(workflow,/startsWith\(github\.head_ref, 'northlight-certification-'\)/);
  assert.match(workflow,/printf '%s\\n' 'dist\/index\.html'/);
  assert.match(workflow,/find dist\/assets -type f -print \| sort/);
  assert.match(workflow,/cmp -s "\$file" "\$remote"/);
  assert.match(workflow,/Cloudflare static UI matches the exact browser-tested artifact/);
});

test('live signed-out smoke includes auth session and protected operational APIs',()=>{
  assert.match(workflow,/for path in \/api\/auth\/session \/api\/bootstrap \/api\/preflight/);
  assert.match(workflow,/expected 401/);
});

test('local browser server serves dist without granting authenticated APIs',()=>{
  assert.match(server,/resolve\(process\.cwd\(\),'dist'\)/);
  assert.match(server,/startsWith\('\/api\/'\)/);
  assert.match(server,/writeHead\(401/);
  assert.match(server,/Authentication required/);
  assert.match(server,/resolve\(join\(root,rel\)\)/);
});
