const { test } = require('node:test');
const assert = require('node:assert/strict');
const download = import('../../dist/src/extension/update-download.js');
const options = fetch => ({ maxBytes: 16, timeoutMs: 1000, signal: new AbortController().signal, fetch });

test('HTTPS downloader rejects credentials and insecure redirects before fetching their targets', async () => {
  const { fetchUpdateBytes } = await download;
  let calls = 0;
  for (const url of [
    'http://example.com/',
    'file:///etc/passwd',
    'https://user:pass@example.com/',
    'https://example.com/#fragment',
  ]) {
    await assert.rejects(
      fetchUpdateBytes(
        url,
        options(async () => {
          calls++;
          return new Response('bad');
        }),
      ),
    );
  }
  assert.equal(calls, 0);
  await assert.rejects(
    fetchUpdateBytes(
      'https://example.com/a',
      options(async () => {
        calls++;
        return new Response(null, { status: 302, headers: { location: 'http://example.com/b' } });
      }),
    ),
  );
  assert.equal(calls, 1);
});

test('redirect loops are bounded and a valid HTTPS redirect downloads the expected bytes', async () => {
  const { fetchUpdateBytes } = await download;
  let calls = 0;
  await assert.rejects(
    fetchUpdateBytes(
      'https://example.com/a',
      options(async () => {
        calls++;
        return new Response(null, { status: 302, headers: { location: '/a' } });
      }),
    ),
  );
  assert.equal(calls, 6);
  const bytes = await fetchUpdateBytes(
    'https://example.com/a',
    options(async url =>
      String(url).endsWith('/a')
        ? new Response(null, { status: 302, headers: { location: 'https://cdn.example/b' } })
        : new Response('expected'),
    ),
  );
  assert.equal(bytes.toString(), 'expected');
});

test('streamed bodies stop at the byte budget and are cancelled without buffering the full body', async () => {
  const { fetchUpdateBytes } = await download;
  let cancelled = false,
    chunks = 0;
  const stream = new ReadableStream({
    pull(controller) {
      chunks++;
      controller.enqueue(new Uint8Array(8));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    fetchUpdateBytes(
      'https://example.com/a',
      options(async () => new Response(stream)),
    ),
  );
  assert.equal(cancelled, true);
  assert.ok(chunks <= 5);
});

test('the deadline covers stalled response bodies, and external cancellation also interrupts them', async () => {
  const { fetchUpdateBytes } = await download;
  for (const external of [false, true]) {
    const abort = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream({
      start() {},
      cancel() {
        cancelled = true;
      },
    });
    const started = Date.now();
    const result = fetchUpdateBytes('https://example.com/a', {
      ...options(async () => new Response(stream)),
      signal: abort.signal,
      timeoutMs: external ? 1000 : 30,
    });
    if (external) setTimeout(() => abort.abort(), 20);
    await assert.rejects(result);
    assert.ok(Date.now() - started < 500);
    assert.equal(cancelled, true);
  }
});

test('pre-aborted checks make no requests and declared oversized/HTTP-error responses are refused', async () => {
  const { fetchUpdateBytes } = await download;
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  await assert.rejects(
    fetchUpdateBytes('https://example.com/a', {
      ...options(async () => {
        calls++;
        return new Response('bad');
      }),
      signal: abort.signal,
    }),
  );
  assert.equal(calls, 0);
  for (const response of [
    new Response('bad', { status: 500 }),
    new Response('bad', { headers: { 'content-length': '9999999' } }),
  ]) {
    await assert.rejects(
      fetchUpdateBytes(
        'https://example.com/a',
        options(async () => response),
      ),
    );
  }
});
