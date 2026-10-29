import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import { pinnedFetch, MAX_BODY } from '../src/browser-network.js';

test('pinned fetch returns redirects, decodes compressed bodies and enforces both limits', async () => {
  const app = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/next' });
      res.end();
      return;
    }
    if (req.url === '/gzip' || req.url === '/br' || req.url === '/deflate') {
      const type = req.url.slice(1),
        data = Buffer.from('public response');
      const encoded = type === 'gzip' ? gzipSync(data) : type === 'br' ? brotliCompressSync(data) : deflateSync(data);
      res.writeHead(200, { 'content-encoding': type });
      res.end(encoded);
      return;
    }
    if (req.url === '/expanded') {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.alloc(MAX_BODY + 1)));
      return;
    }
    if (req.url === '/compressed') {
      res.writeHead(200);
      res.end(Buffer.alloc(MAX_BODY + 1));
      return;
    }
    if (req.url === '/bad') {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end('not gzip');
      return;
    }
    res.end('ok');
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const fetch = (path: string, signal = new AbortController().signal) =>
    pinnedFetch(new URL(base + path), '127.0.0.1', 'GET', {}, signal);
  try {
    const redirect = await fetch('/redirect');
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.location, '/next');
    for (const type of ['gzip', 'br', 'deflate'])
      assert.equal((await fetch('/' + type)).body.toString(), 'public response');
    for (const path of ['/expanded', '/compressed']) await assert.rejects(fetch(path), { code: 'E_RESOURCE_LIMIT' });
    await assert.rejects(fetch('/bad'), { code: 'E_POLICY_DENIED' });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(fetch('/next', controller.signal));
  } finally {
    app.closeAllConnections();
    await new Promise<void>(resolve => app.close(() => resolve()));
  }
});

test(
  'read-only browser follows only vetted same-origin redirects and loads compressed pages',
  { timeout: 20000 },
  async () => {
    const { BrowserAdapter } = await import('../src/browser.js');
    const { parsePolicy, assertUrlAllowed } = await import('../src/policy.js');
    const { Engine } = await import('../src/core.js');
    let outsideHits = 0,
      relativeHits = 0;
    const outside = createServer((_req, res) => {
      outsideHits++;
      res.end('outside');
    });
    await new Promise<void>(resolve => outside.listen(0, '127.0.0.1', resolve));
    const outsideOrigin = `http://127.0.0.1:${(outside.address() as { port: number }).port}`;
    const app = createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(302, { location: '/middle' });
        res.end();
        return;
      }
      if (req.url === '/middle') {
        res.writeHead(302, { location: '/folder/page' });
        res.end();
        return;
      }
      if (req.url === '/folder/page') {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        res.end(
          gzipSync(
            Buffer.from('<p>Loaded safely</p><img src="asset"><img src="/external"><a id="go" href="/second">Next</a>'),
          ),
        );
        return;
      }
      if (req.url === '/second') {
        res.writeHead(302, { location: '/folder/final' });
        res.end();
        return;
      }
      if (req.url === '/folder/final') {
        res.end('<p>Final page</p>');
        return;
      }
      if (req.url === '/folder/asset') {
        relativeHits++;
        res.end('asset');
        return;
      }
      if (req.url === '/external') {
        res.writeHead(302, { location: `${outsideOrigin}/private?token=DO_NOT_EXPOSE` });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    const policy = parsePolicy({
      allowedOrigins: [origin],
      allowLoopback: true,
      browserTargets: [
        {
          id: 'fixture',
          label: 'Fixture',
          url: origin,
          classification: 'PUBLIC',
          controls: [{ selector: '#go', actions: ['click'] }],
        },
      ],
    });
    const engine = new Engine(policy, { browser: new BrowserAdapter(policy, url => assertUrlAllowed(url, policy)) });
    try {
      const session = await engine.open((await engine.listTargets()).targets[0]!.target_id);
      const observed = await engine.observe(session.session_id, { token_budget: 8000 });
      assert.ok(observed.elements?.some(e => e.name === 'Loaded safely'));
      assert.equal(observed.url, `${origin}/folder/page`);
      assert.equal(relativeHits, 1);
      assert.equal(outsideHits, 0);
      assert.ok(observed.warnings?.some(w => w.code === 'redirect_origin_not_allowed' && w.count >= 1));
      assert.ok(!JSON.stringify(observed).includes('DO_NOT_EXPOSE'));
      const link = observed.elements!.find(e => e.name === 'Next')!;
      await engine.act(session.session_id, { action: 'click', element_id: link.id }, observed.revision);
      const final = await engine.observe(session.session_id, { token_budget: 8000 });
      assert.equal(final.url, `${origin}/folder/final`);
      assert.ok(final.elements?.some(e => e.name === 'Final page'));
    } finally {
      await engine.shutdown();
      app.closeAllConnections();
      outside.closeAllConnections();
      await Promise.all([
        new Promise<void>(r => app.close(() => r())),
        new Promise<void>(r => outside.close(() => r())),
      ]);
    }
  },
);

test('self-redirects remain bounded and cannot starve cancellation or cleanup', { timeout: 10000 }, async () => {
  const { BrowserAdapter } = await import('../src/browser.js');
  const { parsePolicy, assertUrlAllowed } = await import('../src/policy.js');
  const { Engine } = await import('../src/core.js');
  let requests = 0;
  const app = createServer((_, res) => {
    requests++;
    res.writeHead(302, { location: '/loop' });
    res.end();
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 1000,
    browserTargets: [{ id: 'loop', label: 'Loop', url: origin + '/loop', classification: 'PUBLIC' }],
  });
  const engine = new Engine(policy, { browser: new BrowserAdapter(policy, url => assertUrlAllowed(url, policy)) });
  try {
    await assert.rejects(engine.open((await engine.listTargets()).targets[0]!.target_id), error =>
      ['E_POLICY_DENIED', 'E_TIMEOUT'].includes((error as { code: string }).code),
    );
    assert.ok(requests > 0 && requests <= 11);
    assert.deepEqual(engine.listSessions().sessions, []);
  } finally {
    await engine.shutdown();
    app.closeAllConnections();
    await new Promise<void>(resolve => app.close(() => resolve()));
  }
});
