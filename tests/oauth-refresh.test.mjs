import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshWithLease } from '../functions/_lib/oauth-refresh.js';

const expired = {
  metadata: { access_token: 'old-token', access_expires_at: 1 },
  refresh_generation: 4
};

test('a still-valid access token bypasses the database lease and provider', async () => {
  let claims = 0;
  const token = await refreshWithLease({
    current: { metadata: { access_token: 'sealed-valid', access_expires_at: 200000 } },
    decode: async value => `decoded:${value}`,
    now: () => 100000,
    claim: async () => (++claims, null),
    read: async () => null,
    refreshProvider: async () => null,
    finish: async () => null,
    release: async () => null
  });

  assert.equal(token, 'decoded:sealed-valid');
  assert.equal(claims, 0);
});

test('the lease owner refreshes once and persists before returning the token', async () => {
  const calls = [];
  const token = await refreshWithLease({
    current: expired,
    decode: async value => value,
    now: () => 100000,
    claim: async () => ({ ...expired, claimed: true }),
    read: async () => expired,
    refreshProvider: async lease => {
      calls.push(['provider', lease.refresh_generation]);
      return { access_token: 'provider-token', refresh_token: 'rotated' };
    },
    finish: async (lease, result) => calls.push(['finish', lease.refresh_generation, result.access_token]),
    release: async () => calls.push(['release']),
    wait: async () => {}
  });

  assert.equal(token, 'provider-token');
  assert.deepEqual(calls, [['provider', 4], ['finish', 4, 'provider-token']]);
});

test('a concurrent non-owner waits for the persisted token instead of refreshing again', async () => {
  let reads = 0;
  let providerCalls = 0;
  const token = await refreshWithLease({
    current: expired,
    decode: async value => `decoded:${value}`,
    now: () => 100000,
    claim: async () => ({ ...expired, claimed: false }),
    read: async () => {
      reads += 1;
      return reads < 2
        ? expired
        : { metadata: { access_token: 'winner-token', access_expires_at: 200000 } };
    },
    refreshProvider: async () => (++providerCalls, null),
    finish: async () => null,
    release: async () => null,
    wait: async () => {},
    waitAttempts: 3
  });

  assert.equal(token, 'decoded:winner-token');
  assert.equal(providerCalls, 0);
  assert.equal(reads, 2);
});

test('a provider failure releases the unused lease so another worker can recover', async () => {
  let releases = 0;
  await assert.rejects(
    refreshWithLease({
      current: expired,
      decode: async value => value,
      now: () => 100000,
      claim: async () => ({ ...expired, claimed: true }),
      read: async () => expired,
      refreshProvider: async () => { throw new Error('provider_unavailable'); },
      finish: async () => null,
      release: async () => { releases += 1; },
      wait: async () => {}
    }),
    /provider_unavailable/
  );
  assert.equal(releases, 1);
});

test('an ambiguous post-provider persistence failure retries and leaves the lease to expire', async () => {
  let finishes = 0;
  let releases = 0;
  await assert.rejects(
    refreshWithLease({
      current: expired,
      decode: async value => value,
      now: () => 100000,
      claim: async () => ({ ...expired, claimed: true }),
      read: async () => expired,
      refreshProvider: async () => ({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' }),
      finish: async () => {
        finishes += 1;
        throw new Error('database_temporarily_unavailable');
      },
      release: async () => { releases += 1; },
      wait: async () => {}
    }),
    /database_temporarily_unavailable/
  );

  assert.equal(finishes, 3);
  assert.equal(releases, 0);
});

test('an active lease fails with an explicit retryable state after the bounded wait', async () => {
  let waits = 0;
  await assert.rejects(
    refreshWithLease({
      current: expired,
      decode: async value => value,
      now: () => 100000,
      claim: async () => ({ ...expired, claimed: false }),
      read: async () => expired,
      refreshProvider: async () => null,
      finish: async () => null,
      release: async () => null,
      wait: async () => { waits += 1; },
      waitAttempts: 3
    }),
    /oauth_refresh_in_progress/
  );
  assert.equal(waits, 3);
});
