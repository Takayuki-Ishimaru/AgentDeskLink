import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { pinnedFetch } from '../src/browser-network.js';
import { Engine } from '../src/core.js';
import { BrowserAdapter } from '../src/browser.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';

test(
  'HTTP proxy receives pinned IP and original Host while policy and redirects remain enforced',
  { timeout: 15000 },
  async () => {
    const seen: { url: string; host: string }[] = [];
    let outside = 0;
    const target = createServer((req, res) => {
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html');
        res.end('<link rel="stylesheet" href="/old.css"><p>Through proxy</p>');
      } else if (req.url === '/old.css') {
        res.writeHead(302, { location: '/styles/main.css' });
        res.end();
      } else if (req.url === '/styles/main.css') {
        res.setHeader('content-type', 'text/css');
        res.end('body { background-image: url("asset.png"); }');
      } else if (req.url === '/styles/asset.png') {
        res.end('image');
      } else {
        res.end('ok');
      }
    });
    await new Promise<void>(r => target.listen(0, '127.0.0.1', r));
    const port = (target.address() as { port: number }).port;
    const proxy = createServer((req, res) => {
      seen.push({ url: req.url ?? '', host: req.headers.host ?? '' });
      const u = new URL(req.url!);
      const forward = request(
        { host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers },
        response => {
          res.writeHead(response.statusCode!, response.headers);
          response.pipe(res);
        },
      );
      forward.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(forward);
    });
    await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const original = `http://local.example:${port}`;
    try {
      const fetched = await pinnedFetch(
        new URL(original + '/direct'),
        '127.0.0.1',
        'GET',
        {},
        new AbortController().signal,
        undefined,
        proxyUrl,
      );
      assert.equal(fetched.body.toString(), 'ok');
      assert.deepEqual(seen[0], { url: `http://127.0.0.1:${port}/direct`, host: `local.example:${port}` });
      for (const bad of ['http://user:password@127.0.0.1', 'http://127.0.0.1/path', 'http://127.0.0.1?'])
        await assert.rejects(
          pinnedFetch(new URL(original), '127.0.0.1', 'GET', {}, new AbortController().signal, undefined, bad),
          { code: 'E_INVALID_ARGUMENT' },
        );
      const origin = `http://127.0.0.1:${port}`;
      const policy = parsePolicy({
        allowedOrigins: [origin],
        allowLoopback: true,
        browserProxyServer: proxyUrl,
        browserTargets: [{ id: 'p', label: 'Proxy', url: origin, classification: 'PUBLIC' }],
      });
      const engine = new Engine(policy, { browser: new BrowserAdapter(policy, url => assertUrlAllowed(url, policy)) });
      try {
        const s = await engine.open((await engine.listTargets()).targets[0]!.target_id);
        const state = await engine.observe(s.session_id);
        assert.ok(state.elements?.some(e => e.name === 'Through proxy'));
        assert.ok(
          seen.some(r => r.url.endsWith('/styles/asset.png')),
          'redirected CSS resolves asset relative to final URL',
        );
        await assert.rejects(engine.openUrl('http://example.invalid'), { code: 'E_POLICY_DENIED' });
        outside = seen.filter(r => r.url.includes('example.invalid')).length;
        assert.equal(outside, 0);
      } finally {
        await engine.shutdown();
      }
    } finally {
      proxy.closeAllConnections();
      target.closeAllConnections();
      await Promise.all([
        new Promise<void>(r => proxy.close(() => r())),
        new Promise<void>(r => target.close(() => r())),
      ]);
    }
  },
);

test('HTTPS CONNECT addresses vetted IP and preserves certificate validation', { timeout: 10000 }, async () => {
  const paths: string[] = [];
  const proxy = createServer();
  proxy.on('connect', (req, socket) => {
    paths.push(req.url!);
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(
      pinnedFetch(
        new URL('https://service.example/path'),
        '93.184.216.34',
        'GET',
        {},
        new AbortController().signal,
        undefined,
        `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
      ),
      { code: 'E_POLICY_DENIED' },
    );
    assert.deepEqual(paths, ['93.184.216.34:443']);
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>(r => proxy.close(() => r()));
  }
});

test('proxy connection abort remains bounded before response headers', { timeout: 10000 }, async () => {
  const sockets = new Set<import('node:net').Socket>();
  const proxy = tcpServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  try {
    const cancel = new AbortController();
    const fetching = pinnedFetch(
      new URL('http://example.test'),
      '93.184.216.34',
      'GET',
      {},
      cancel.signal,
      undefined,
      `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
    );
    setTimeout(() => cancel.abort(), 20);
    await assert.rejects(fetching);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>(r => proxy.close(() => r()));
  }
});
