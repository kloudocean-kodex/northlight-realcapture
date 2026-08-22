const defaultWait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function usableAccessToken(record, decode, now = Date.now()) {
  const metadata = record?.metadata || {};
  if (!metadata.access_token || Number(metadata.access_expires_at || 0) <= now + 15000) return null;
  return decode(metadata.access_token);
}

export async function refreshWithLease({
  current,
  decode,
  claim,
  read,
  refreshProvider,
  finish,
  release,
  wait = defaultWait,
  waitAttempts = 10,
  waitMilliseconds = 250,
  now = () => Date.now()
}) {
  const currentToken = await usableAccessToken(current, decode, now());
  if (currentToken) return currentToken;

  const lease = await claim();
  if (lease?.claimed) {
    let providerResult;
    try {
      providerResult = await refreshProvider(lease);
      if (!providerResult?.access_token) throw new Error('oauth_refresh_access_token_missing');
    } catch (exception) {
      try { await release(lease); } catch {}
      throw exception;
    }

    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await finish(lease, providerResult);
        return providerResult.access_token;
      } catch (exception) {
        lastError = exception;
        if (attempt < 2) await wait(100 * (attempt + 1));
      }
    }
    // Do not release after the provider rotated a credential but persistence failed.
    // The short database lease prevents another request racing with the ambiguous refresh.
    throw lastError || new Error('oauth_refresh_persist_failed');
  }

  for (let attempt = 0; attempt < waitAttempts; attempt += 1) {
    await wait(waitMilliseconds);
    const latest = await read();
    const token = await usableAccessToken(latest, decode, now());
    if (token) return token;
  }
  throw new Error('oauth_refresh_in_progress');
}
