import test from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedText, RequestBodyTooLargeError } from '../functions/_lib/http-body.js';
import { onRequestPost as dropboxWebhook } from '../functions/webhooks/dropbox.js';
import { onRequestPost as xeroWebhook } from '../functions/webhooks/xero.js';

test('bounded request reader preserves a valid streamed UTF-8 payload', async () => {
  const payload = JSON.stringify({ message: 'München → Melbourne' });
  const request = new Request('https://northlight.test/webhook', { method: 'POST', body: payload });
  assert.equal(await readBoundedText(request, 1024), payload);
});

test('bounded request reader rejects advertised and streamed overflow', async () => {
  const advertised = new Request('https://northlight.test/webhook', {
    method: 'POST',
    headers: { 'content-length': '1000' },
    body: 'small',
  });
  await assert.rejects(() => readBoundedText(advertised, 10), RequestBodyTooLargeError);

  const streamed = new Request('https://northlight.test/webhook', { method: 'POST', body: '12345678901' });
  await assert.rejects(() => readBoundedText(streamed, 10), RequestBodyTooLargeError);
});

test('provider webhooks reject oversized bodies before signature or provider work', async () => {
  const dropbox = await dropboxWebhook({
    request: new Request('https://northlight.test/webhooks/dropbox', {
      method: 'POST',
      headers: { 'content-length': String(256 * 1024 + 1) },
      body: '{}',
    }),
    env: {},
  });
  assert.equal(dropbox.status, 413);

  const xero = await xeroWebhook({
    request: new Request('https://northlight.test/webhooks/xero', {
      method: 'POST',
      headers: { 'content-length': String(1024 * 1024 + 1) },
      body: '{}',
    }),
    env: {},
  });
  assert.equal(xero.status, 413);
});
