import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflowUrl = new URL('../.github/workflows/northlight-ci.yml', import.meta.url);

test('pre-merge certification proves the candidate locally without demanding undeployed production byte parity', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const marker = '- name: Verify deployed production static UI matches browser-tested artifact';
  assert.match(workflow, /Verify Cloudflare production release attestation/);
  assert.match(workflow, /PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /Verify rendered login from exact built UI in real Chrome/);
  assert.ok(workflow.includes(marker), 'production-only byte-parity gate must exist');

  const parityStep = workflow.slice(workflow.indexOf(marker));
  const conditionLine = parityStep.split('\n').find(line => line.trim().startsWith('if:'))?.trim();
  assert.equal(
    conditionLine,
    "if: github.event_name == 'push' && github.ref_name == 'northlight-production'",
    'candidate-vs-live byte parity is valid only after a real production push',
  );
  assert.doesNotMatch(
    conditionLine,
    /pull_request|northlight-certification-/,
    'a certification PR must not be compared byte-for-byte with the deliberately frozen live production site',
  );
  assert.match(parityStep, /Cache-Control: no-cache/);
  assert.match(parityStep, /\?deployment=\$CURRENT_SHA&attempt=\$attempt/);
  assert.match(parityStep, /for attempt in \$\(seq 1 6\)/);
});
