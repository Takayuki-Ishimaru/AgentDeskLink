import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTlsFixture } from './tls-fixture.js';
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
import { AdlError, safeError } from '../src/types.js';
import { safeTransportError } from '../src/browser-network.js';

test('safeTransportError classifies failures into bounded transport/TLS reasons without leaking details', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
  assert.equal(safeTransportError(refused).reason, 'transport_failure');
  const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  assert.equal(safeTransportError(reset).reason, 'transport_failure');
  const unknown = new Error('weird failure with secret text');
  assert.equal(safeTransportError(unknown).reason, 'transport_failure');
  const cert = Object.assign(new Error('unable to verify the first certificate'), {
    code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  });
  assert.equal(safeTransportError(cert).reason, 'tls_handshake_failed');
  const ssl = Object.assign(new Error('ssl failure'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' });
  assert.equal(safeTransportError(ssl).reason, 'tls_handshake_failed');
  for (const error of [refused, unknown, cert])
    assert.ok(!JSON.stringify(safeError(safeTransportError(error))).includes('127.0.0.1'));
  const policy = new AdlError('E_POLICY_DENIED', 'proxy_unreachable');
  assert.equal(safeTransportError(policy), policy);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(safeTransportError(refused, aborted.signal).code, 'E_CANCELLED');
});

test('direct connection and TLS failures surface as specific transport reasons, guard denials unchanged', async () => {
  const taken = createServer((_req, res) => res.end('x'));
  await new Promise<void>(resolve => taken.listen(0, '127.0.0.1', resolve));
  const port = (taken.address() as { port: number }).port;
  taken.closeAllConnections();
  await new Promise<void>(resolve => taken.close(() => resolve()));
  const refused = await pinnedFetch(
    new URL(`http://127.0.0.1:${port}/secret-path`),
    '127.0.0.1',
    'GET',
    {},
    new AbortController().signal,
  ).then(
    () => undefined,
    (error: unknown) => error as AdlError,
  );
  assert.ok(refused instanceof AdlError);
  assert.equal(refused.code, 'E_POLICY_DENIED');
  assert.equal(refused.reason, 'transport_failure');
  const wire = JSON.stringify(safeError(refused));
  assert.ok(!wire.includes(String(port)) && !wire.includes('secret-path') && !wire.includes('ECONNREFUSED'));
  const tls = await pinnedFetch(
    new URL(`https://127.0.0.1:${port}/`),
    '127.0.0.1',
    'GET',
    {},
    new AbortController().signal,
  ).then(
    () => undefined,
    (error: unknown) => error as AdlError,
  );
  assert.ok(tls instanceof AdlError);
  assert.equal(tls.code, 'E_POLICY_DENIED');
  assert.ok(['tls_handshake_failed', 'transport_failure'].includes(tls.reason ?? ''));
  const app = createServer((_req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip' });
    res.end('not gzip');
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  try {
    const guard = await pinnedFetch(new URL(base + '/'), '127.0.0.1', 'GET', {}, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error as AdlError,
    );
    assert.ok(guard instanceof AdlError);
    assert.equal(guard.code, 'E_POLICY_DENIED');
    assert.equal(guard.reason, undefined);
  } finally {
    app.closeAllConnections();
    await new Promise<void>(resolve => app.close(() => resolve()));
  }
});


test(
  'browser open reports TLS certificate and connection failures without endpoint details',
  { timeout: 20000 },
  async () => {
    const { createServer: createHttpsServer } = await import('node:https');
    const { BrowserAdapter } = await import('../src/browser.js');
    const { parsePolicy, assertUrlAllowed } = await import('../src/policy.js');
    const { Engine } = await import('../src/core.js');
    const tlsServer = createHttpsServer(generateTlsFixture(), (_req, res) => res.end('ok'));
    await new Promise<void>(resolve => tlsServer.listen(0, '127.0.0.1', resolve));
    const port = (tlsServer.address() as { port: number }).port;
    const closed = createServer();
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
    const closedPort = (closed.address() as { port: number }).port;
    await new Promise<void>(resolve => closed.close(() => resolve()));
    try {
      for (const [origin, reason] of [
        [`https://127.0.0.1:${port}`, 'tls_handshake_failed'],
        [`http://127.0.0.1:${closedPort}`, 'transport_failure'],
      ]) {
        const policy = parsePolicy({
          allowedOrigins: [origin],
          allowLoopback: true,
          browserTargets: [
            { id: 'fixture', label: 'Fixture', url: `${origin}/secret-path?token=secret`, classification: 'PUBLIC' },
          ],
        });
        const engine = new Engine(policy, {
          browser: new BrowserAdapter(policy, url => assertUrlAllowed(url, policy)),
        });
        try {
          const target = (await engine.listTargets()).targets[0]!;
          await assert.rejects(engine.open(target.target_id), (error: unknown) => {
            assert.ok(error instanceof AdlError);
            assert.equal(error.reason, reason);
            const result = JSON.stringify(safeError(error));
            for (const secret of ['secret-path', 'token=secret', String(port), String(closedPort), 'SELF_SIGNED_CERT'])
              assert.ok(!result.includes(secret));
            return true;
          });
        } finally {
          await engine.shutdown();
        }
      }
    } finally {
      tlsServer.closeAllConnections();
      await new Promise<void>(resolve => tlsServer.close(() => resolve()));
    }
  },
);

test('truncated response is a transport failure and malformed compression stays a policy failure', async () => {
  const app = createServer((req, res) => {
    if (req.url === '/truncated') {
      res.writeHead(200, { 'content-length': '100' });
      res.write('partial');
      setTimeout(() => res.destroy(), 10);
    } else {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end('bad gzip');
    }
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  try {
    await assert.rejects(
      pinnedFetch(new URL(origin + '/truncated'), '127.0.0.1', 'GET', {}, new AbortController().signal),
      { reason: 'transport_failure' },
    );
    await assert.rejects(
      pinnedFetch(new URL(origin + '/bad'), '127.0.0.1', 'GET', {}, new AbortController().signal),
      (e: unknown) => e instanceof AdlError && e.code === 'E_POLICY_DENIED' && e.reason === undefined,
    );
    assert.equal(
      safeTransportError(Object.assign(new Error('private'), { code: 'ERR_HTTP2_PROTOCOL_ERROR' })).reason,
      'transport_failure',
    );
  } finally {
    app.closeAllConnections();
    await new Promise<void>(resolve => app.close(() => resolve()));
  }
});
