/// <reference types="node" />
import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as net from 'node:net';
import * as zlib from 'node:zlib';
import {pinnedFetch, MAX_BODY, MAX_ASSET_BODY, PinnedConnectionPool} from '../src/browser-network.js';
import {AdlError} from '../src/types.js';

// Review suite for the asset cap and the session keepalive pool. Every case is
// a failure-first check: the limit must reject, the pool must refuse reuse, and
// cleanup must leave no socket behind.
const HOST_NAME = 'test.invalid';
const KIB = 1024;
const MiB = 1024 * 1024;

type Track = {
  server: http.Server;
  sockets: Set<net.Socket>;
  port: number;
  connections: () => number;
  requests: () => number;
};

async function listen(server: http.Server): Promise<Track> {
  const sockets = new Set<net.Socket>();
  let connections = 0;
  let requests = 0;
  server.on('connection', (socket) => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('request', () => requests++);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {server, sockets, port: address.port, connections: () => connections, requests: () => requests};
}

function closeAll(tracks: Track[]): void {
  for (const t of tracks) {
    for (const s of t.sockets) s.destroy();
    t.sockets.clear();
    t.server.close();
  }
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AdlError, `expected AdlError, got ${String(error)}`);
    assert.equal((error as AdlError).code, code);
    return true;
  };
}

async function waitClosed(sockets: Set<net.Socket>[], ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (sockets.every((s) => s.size === 0)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail('sockets left open after the request settled');
}

// A body of `size` bytes that still compresses to a few kilobytes.
function filler(size: number): Buffer { return Buffer.alloc(size, 65); }

function serveBody(body: Buffer, headers: http.OutgoingHttpHeaders = {}): http.Server {
  return http.createServer((_req, res) => {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v as string);
    res.end(body);
  });
}

function urlFor(port: number, path = '/asset'): URL { return new URL(`http://${HOST_NAME}:${port}${path}`); }

// ---------- resource type caps ----------

test('script admits 3MiB even when the server claims text/plain', {timeout: 9000}, async () => {
  const track = await listen(serveBody(filler(3 * MiB), {'content-type': 'text/plain'}));
  try {
    const result = await pinnedFetch(urlFor(track.port), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, undefined, {resourceType: 'script'});
    assert.equal(result.status, 200);
    assert.equal(result.body.length, 3 * MiB);
  } finally {
    closeAll([track]);
  }
});

test('stylesheet admits 3MiB', {timeout: 9000}, async () => {
  const track = await listen(serveBody(filler(3 * MiB), {'content-type': 'text/plain'}));
  try {
    const result = await pinnedFetch(urlFor(track.port), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, undefined, {resourceType: 'stylesheet'});
    assert.equal(result.body.length, 3 * MiB);
  } finally {
    closeAll([track]);
  }
});

test('text and unspecified resource types reject over 2MiB', {timeout: 9000}, async () => {
  const track = await listen(serveBody(filler(MAX_BODY + 1), {'content-type': 'application/javascript'}));
  try {
    // The server content-type is never trusted: only the declared type widens.
    await assert.rejects(pinnedFetch(urlFor(track.port), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, undefined, {resourceType: 'text'}), expectCode('E_RESOURCE_LIMIT'));
    await assert.rejects(pinnedFetch(urlFor(track.port), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000)), expectCode('E_RESOURCE_LIMIT'));
    await assert.rejects(pinnedFetch(urlFor(track.port), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, undefined, {}), expectCode('E_RESOURCE_LIMIT'));
    await assert.rejects(pinnedFetch(urlFor(track.port), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, undefined, {resourceType: 'SCRIPT'}), expectCode('E_RESOURCE_LIMIT'));
    await waitClosed([track.sockets]);
  } finally {
    closeAll([track]);
  }
});

test('script rejects raw body over 20MiB', {timeout: 9000}, async () => {
  const track = await listen(serveBody(filler(MAX_ASSET_BODY + 1)));
  try {
    await assert.rejects(pinnedFetch(urlFor(track.port), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, undefined, {resourceType: 'script'}), expectCode('E_RESOURCE_LIMIT'));
    await waitClosed([track.sockets]);
  } finally {
    closeAll([track]);
  }
});

test('script rejects gzip bomb expanding over 20MiB', {timeout: 9000}, async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(MAX_ASSET_BODY + 64 * KIB, 66), {level: 1});
  assert.ok(bomb.length < MiB, `bomb must stay small, got ${bomb.length}`);
  const track = await listen(serveBody(bomb, {'content-encoding': 'gzip', 'content-type': 'text/javascript'}));
  try {
    await assert.rejects(pinnedFetch(urlFor(track.port), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, undefined, {resourceType: 'script'}), expectCode('E_RESOURCE_LIMIT'));
    await waitClosed([track.sockets]);
  } finally {
    closeAll([track]);
  }
});

test('text gzip bomb over 2MiB is refused and the socket closes', {timeout: 9000}, async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(MAX_BODY + 64 * KIB, 66), {level: 1});
  const track = await listen(serveBody(bomb, {'content-encoding': 'gzip'}));
  try {
    await assert.rejects(pinnedFetch(urlFor(track.port), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, undefined, {resourceType: 'text'}), expectCode('E_RESOURCE_LIMIT'));
    await waitClosed([track.sockets]);
  } finally {
    closeAll([track]);
  }
});

test('stylesheet admits 3MiB expanded from a small gzip stream', {timeout: 9000}, async () => {
  const packed = zlib.gzipSync(filler(3 * MiB), {level: 1});
  const track = await listen(serveBody(packed, {'content-encoding': 'gzip'}));
  try {
    const result = await pinnedFetch(urlFor(track.port), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, undefined, {resourceType: 'stylesheet'});
    assert.equal(result.body.length, 3 * MiB);
  } finally {
    closeAll([track]);
  }
});

// ---------- cancellation and timeout cleanup ----------

test('abort during a pooled response settles and closes that socket', {timeout: 9000}, async () => {
  const track = await listen(http.createServer((_req, res) => {
    res.writeHead(200, {'content-type': 'text/plain'});
    res.write('partial');
  }));
  const pool = new PinnedConnectionPool();
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pinnedFetch(urlFor(track.port, '/slow'), '127.0.0.1', 'GET', {}, controller.signal, undefined, undefined, {pool}), (error: unknown) => error instanceof AdlError || (error as Error).name === 'AbortError');
    await waitClosed([track.sockets]);
  } finally {
    pool.destroy();
    closeAll([track]);
  }
});

test('a stalled pooled response hits the deadline without leaving sockets', {timeout: 9000}, async () => {
  const track = await listen(http.createServer(() => { /* never respond */ }));
  const pool = new PinnedConnectionPool();
  try {
    await assert.rejects(pinnedFetch(urlFor(track.port, '/stall'), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, undefined, {pool}), expectCode('E_TIMEOUT'));
    await waitClosed([track.sockets]);
  } finally {
    pool.destroy();
    closeAll([track]);
  }
});

// ---------- keepalive pool ----------

test('two sequential pool requests reuse one socket', {timeout: 9000}, async () => {
  const track = await listen(serveBody(Buffer.from('ok')));
  const pool = new PinnedConnectionPool();
  try {
    const a = await pinnedFetch(urlFor(track.port, '/a'), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, undefined, {pool});
    const b = await pinnedFetch(urlFor(track.port, '/b'), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, undefined, {pool});
    assert.equal(a.body.toString(), 'ok');
    assert.equal(b.body.toString(), 'ok');
    assert.equal(track.requests(), 2);
    assert.equal(track.connections(), 1, 'the second request must reuse the pooled socket');
    assert.equal(pool.size, 1);
  } finally {
    pool.destroy();
    closeAll([track]);
  }
});

test('without a pool each request opens its own socket', {timeout: 9000}, async () => {
  const track = await listen(serveBody(Buffer.from('ok')));
  try {
    await pinnedFetch(urlFor(track.port, '/a'), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000));
    await pinnedFetch(urlFor(track.port, '/b'), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000));
    assert.equal(track.requests(), 2);
    assert.equal(track.connections(), 2, 'the default path stays one-shot');
  } finally {
    closeAll([track]);
  }
});

test('concurrent pooled requests survive an abort of one of them', {timeout: 9000}, async () => {
  const track = await listen(http.createServer((req, res) => {
    if (String(req.url).startsWith('/slow')) {
      res.writeHead(200, {'content-type': 'text/plain'});
      res.write('x');
      return;
    }
    res.end('fast');
  }));
  const pool = new PinnedConnectionPool();
  try {
    const controller = new AbortController();
    const slow = assert.rejects(pinnedFetch(urlFor(track.port, '/slow'), '127.0.0.1', 'GET', {}, controller.signal, undefined, undefined, {pool}), (error: unknown) => error instanceof AdlError || (error as Error).name === 'AbortError');
    const fast = pinnedFetch(urlFor(track.port, '/fast'), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, undefined, {pool});
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    const result = await fast;
    assert.equal(result.body.toString(), 'fast');
    await slow;
    assert.equal(pool.size, 1);
  } finally {
    pool.destroy();
    closeAll([track]);
  }
});

test('a different origin, port or IP never reuses a pooled socket', {timeout: 9000}, async () => {
  const track = await listen(serveBody(Buffer.from('ok')));
  const pool = new PinnedConnectionPool();
  try {
    await pinnedFetch(urlFor(track.port, '/a'), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, undefined, {pool});
    await pinnedFetch(new URL(`http://other.invalid:${track.port}/b`), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, undefined, {pool});
    await pinnedFetch(urlFor(track.port, '/c'), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, undefined, {pool});
    assert.equal(track.requests(), 3);
    assert.equal(track.connections(), 2, 'only the identical origin/IP pair may reuse');
    assert.equal(pool.size, 2);
  } finally {
    pool.destroy();
    closeAll([track]);
  }
});

test('close destroys pooled sockets and refuses further use', {timeout: 9000}, async () => {
  const track = await listen(serveBody(Buffer.from('ok')));
  const pool = new PinnedConnectionPool();
  try {
    await pinnedFetch(urlFor(track.port, '/a'), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, undefined, {pool});
    assert.equal(track.connections(), 1);
    pool.close();
    assert.equal(pool.size, 0);
    await waitClosed([track.sockets]);
    const before = track.connections();
    await assert.rejects(pinnedFetch(urlFor(track.port, '/b'), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, undefined, {pool}), expectCode('E_POLICY_DENIED'));
    assert.equal(track.connections(), before, 'a closed pool must not dispatch');
    pool.destroy();
  } finally {
    closeAll([track]);
  }
});

test('the pool map stays bounded and eviction destroys the evicted agent', {timeout: 9000}, async () => {
  const track = await listen(serveBody(Buffer.from('ok')));
  const pool = new PinnedConnectionPool();
  try {
    for (let i = 0; i < 40; i++) {
      await pinnedFetch(new URL(`http://host-${String(i).padStart(3, '0')}.invalid:${track.port}/`), '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, undefined, {pool});
    }
    assert.ok(pool.size <= 32, `pool grew to ${pool.size}`);
    assert.equal(pool.size, 32);
  } finally {
    pool.destroy();
    closeAll([track]);
  }
});

test('a pool is ignored for proxied requests, which stay one-shot', {timeout: 9000}, async () => {
  let seenUrl = '';
  const proxy = http.createServer((req, res) => {
    seenUrl = req.url ?? '';
    res.end('proxied');
  });
  const track = await listen(proxy);
  const pool = new PinnedConnectionPool();
  try {
    const target = new URL(`http://${HOST_NAME}:8099/path`);
    const a = await pinnedFetch(target, '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, `http://127.0.0.1:${track.port}`, {pool});
    const b = await pinnedFetch(target, '127.0.0.1', 'GET', {}, AbortSignal.timeout(6000), undefined, `http://127.0.0.1:${track.port}`, {pool});
    assert.equal(a.body.toString(), 'proxied');
    assert.equal(b.body.toString(), 'proxied');
    assert.equal(seenUrl, `http://127.0.0.1:8099/path`);
    assert.equal(pool.size, 0, 'no agent may be pooled for a proxied request');
    assert.equal(track.connections(), 2, 'the proxy path stays one-shot');
  } finally {
    pool.destroy();
    closeAll([track]);
  }
});
