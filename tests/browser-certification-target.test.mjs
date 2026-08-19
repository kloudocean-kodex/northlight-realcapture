import test from'node:test';
import assert from'node:assert/strict';
import{readFile}from'node:fs/promises';

const workflow=await readFile(new URL('../.github/workflows/northlight-ci.yml',import.meta.url),'utf8');

test('browser certification uses preview for feature PRs and production for disposable certification PRs',()=>{
  assert.match(workflow,/HEAD_REF: \$\{\{ github\.head_ref \}\}/);
  assert.match(workflow,/PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow,/northlight-certification-\*\)/);
  assert.match(workflow,/target='https:\/\/northlight-realcapture\.pages\.dev'\s+expected="\$PR_BASE_SHA"/s);
  assert.match(workflow,/target="https:\/\/\$\{alias\}\.northlight-realcapture\.pages\.dev"\s+expected="\$HEAD_SHA"/s);
  assert.match(workflow,/timeout --signal=KILL 30s "\$chrome"/);
  assert.match(workflow,/grep -Fq 'id="loginForm"'/);
});
