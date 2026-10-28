import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as zlib from 'node:zlib';
import {spawn} from 'node:child_process';
import {writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pinnedFetch, MAX_BODY} from '../src/browser-network.js';
import {AdlError} from '../src/types.js';

// Fixture certificate: self-signed, CA:TRUE, SAN = DNS:test.invalid + IP:127.0.0.1.
// Embedded so the suite needs no openssl at run time; trusted via NODE_EXTRA_CA_CERTS
// in the child Node process this file spawns for the TLS cases.
const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBpDCCAUqgAwIBAgIUUL8px4QwvJZmtkkNPPHwxtDV/2MwCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMdGVzdC5pbnZhbGlkMCAXDTI2MTAyODAzMDIxMFoYDzIwODEw
NzMxMDMwMjEwWjAXMRUwEwYDVQQDDAx0ZXN0LmludmFsaWQwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAAQkfaTap3BppwLbdbCBrY0E3d9DNVu2j6SmEMjz2OhFA5kD
QkozM8zCrM+wv15Y0Oz5+Y98SnvgTUX1RGScV5Mio3IwcDAdBgNVHQ4EFgQUOXlu
8wwf+gLXc1nbo58EvAbqHXQwHwYDVR0jBBgwFoAUOXlu8wwf+gLXc1nbo58EvAbq
HXQwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHREEFjAUggx0ZXN0LmludmFsaWSHBH8A
AAEwCgYIKoZIzj0EAwIDSAAwRQIhAI3Smjm5JjNJvXf2KelMhMGmZYDayk2xjlb6
xGtrrQBHAiBhBS6WJUbeWor2FoP6kqsDBfA/FoqnGxhAtjx/QiO/QQ==
-----END CERTIFICATE-----
`;
const KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg1X8pEqUYXloRFPI/
Wq6YtimbJvXJHVGbU2m/rgEHjf6hRANCAAQkfaTap3BppwLbdbCBrY0E3d9DNVu2
j6SmEMjz2OhFA5kDQkozM8zCrM+wv15Y0Oz5+Y98SnvgTUX1RGScV5Mi
-----END PRIVATE KEY-----
`;

const TRUSTED = process.env.ADL_TLS_TRUSTED === '1';
// The trusted child re-runs this file; keep its runtime inside the parent's
// per-test bound by skipping the slow deadline/abort cases there.
const SKIP_SLOW = TRUSTED;
const HOST_NAME = 'test.invalid';

type Track = {server: http.Server | https.Server | net.Server; sockets: Set<net.Socket>; port: number};

async function listen(server: http.Server | https.Server | net.Server): Promise<Track> {
  const sockets = new Set<net.Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {server, sockets, port: address.port};
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

function connectProxy(targetPort: number, opts: {deny?: boolean; stall?: boolean} = {}): {server: net.Server; sockets: Set<net.Socket>; authority: () => string} {
  const sockets = new Set<net.Socket>();
  let lastAuthority = '';
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    let buf = Buffer.alloc(0);
    let handled = false;
    client.on('error', () => client.destroy());
    client.on('data', (d) => {
      if (handled) return;
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      handled = true;
      lastAuthority = buf.subarray(0, idx).toString('latin1').split('\r\n')[0] ?? '';
      if (opts.deny) { client.end('HTTP/1.1 502 Denied\r\nProxy-Agent: adl-test\r\n\r\n'); return; }
      if (opts.stall) return;
      client.write('HTTP/1.1 200 Connection established\r\nProxy-Agent: adl-test\r\n\r\n');
      const upstream = net.connect(targetPort, '127.0.0.1', () => {
        upstream.pipe(client);
        client.pipe(upstream);
      });
      sockets.add(upstream);
      upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
    });
  });
  return {server, sockets, authority: () => lastAuthority};
}

function startTrustedChild(t: TestContext): Promise<void> {
  // NODE_EXTRA_CA_CERTS is the only portable way to add trust without touching
  // production code (which always sets rejectUnauthorized:true).
  const caPath = join(tmpdir(), `adl-test-ca-${process.pid}.pem`);
  writeFileSync(caPath, CERT_PEM);
  const childEnv:NodeJS.ProcessEnv={...process.env,NODE_EXTRA_CA_CERTS:caPath,ADL_TLS_TRUSTED:'1'};
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--test', '--test-timeout=10000', '--test-force-exit', ...process.argv.slice(1)], {
    env: childEnv,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('trusted child timed out'));
    }, 30000);
    child.once('error', (error) => {
      clearTimeout(timer);
      rmSync(caPath, {force: true});
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      rmSync(caPath, {force: true});
      t.diagnostic(`trusted child exit code ${String(code)}`);
      if (code === 0) resolve();
      else reject(new Error(`trusted child failed with code ${String(code)}`));
    });
  });
}

// ---------- always-run (no TLS trust needed) ----------

test('http direct keeps original Host and reaches the pinned IP', async () => {
  const target = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.end(`host=${req.headers.host} url=${req.url}`);
  });
  const track = await listen(target);
  try {
    const result = await pinnedFetch(new URL(`http://${HOST_NAME}:${track.port}/p`), '127.0.0.1', 'GET', {host: 'evil.example'}, AbortSignal.timeout(4000));
    assert.equal(result.status, 200);
    assert.match(result.body.toString(), new RegExp(`host=${HOST_NAME}:${track.port}`));
    assert.match(result.body.toString(), /url=\/p/);
    await waitClosed([track.sockets]);
  } finally {
    closeAll([track]);
  }
});

test('http via proxy uses absolute URI with the vetted IP and preserves Host', async () => {
  const targetPort = 8099; // never connected; the proxy answers, proving the URI/Host
  let seenUrl = '';
  let seenHost = '';
  const proxy = http.createServer((req, res) => {
    seenUrl = req.url ?? '';
    seenHost = String(req.headers.host);
    res.statusCode = 200;
    res.end('proxied');
  });
  const track = await listen(proxy);
  try {
    const result = await pinnedFetch(new URL(`http://${HOST_NAME}:${targetPort}/path?q=1`), '127.0.0.1', 'GET', {}, AbortSignal.timeout(4000), undefined, `http://127.0.0.1:${track.port}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), 'proxied');
    assert.equal(seenUrl, `http://127.0.0.1:${targetPort}/path?q=1`);
    assert.equal(seenHost, `${HOST_NAME}:${targetPort}`);
    await waitClosed([track.sockets]);
  } finally {
    closeAll([track]);
  }
});

test('invalid proxy origins and credentials are rejected', async () => {
  const url = new URL(`http://${HOST_NAME}:8099/`);
  for (const bad of ['http://user:pass@127.0.0.1:8080/', 'socks5://127.0.0.1:8080/', 'http://127.0.0.1:8080/extra', 'http://127.0.0.1:8080/?x=1', 'not a url']) {
    await assert.rejects(pinnedFetch(url, '127.0.0.1', 'GET', {}, AbortSignal.timeout(2000), undefined, bad), expectCode('E_INVALID_ARGUMENT'), bad);
  }
});

test('redirects are returned, never followed', async () => {
  let hits = 0;
  const target = http.createServer((_req, res) => {
    hits++;
    res.statusCode = 302;
    res.setHeader('location', `http://${HOST_NAME}:9/second`);
    res.end('nope');
  });
  const track = await listen(target);
  try {
    const result = await pinnedFetch(new URL(`http://${HOST_NAME}:${track.port}/first`), '127.0.0.1', 'GET', {}, AbortSignal.timeout(4000));
    assert.equal(result.status, 302);
    assert.equal(result.headers.location, `http://${HOST_NAME}:9/second`);
    assert.equal(hits, 1);
    await waitClosed([track.sockets]);
  } finally {
    closeAll([track]);
  }
});

test('compressed body over 2MiB is refused', async () => {
  const target = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/octet-stream');
    res.end(Buffer.alloc(MAX_BODY + 1, 65));
  });
  const track = await listen(target);
  try {
    await assert.rejects(pinnedFetch(new URL(`http://${HOST_NAME}:${track.port}/big`), '127.0.0.1', 'GET', {}, AbortSignal.timeout(4000)), expectCode('E_RESOURCE_LIMIT'));
    await waitClosed([track.sockets]);
  } finally {
    closeAll([track]);
  }
});

test('gzip decompressed size over 2MiB is refused', async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(MAX_BODY + 4096, 66));
  assert.ok(bomb.length < MAX_BODY / 4);
  const target = http.createServer((_req, res) => {
    res.setHeader('content-encoding', 'gzip');
    res.setHeader('content-type', 'text/plain');
    res.end(bomb);
  });
  const track = await listen(target);
  try {
    await assert.rejects(pinnedFetch(new URL(`http://${HOST_NAME}:${track.port}/bomb`), '127.0.0.1', 'GET', {}, AbortSignal.timeout(4000)), expectCode('E_RESOURCE_LIMIT'));
    await waitClosed([track.sockets]);
  } finally {
    closeAll([track]);
  }
});

test('abort during the response settles and closes the socket', {skip: SKIP_SLOW}, async () => {
  const target = http.createServer((_req, res) => {
    res.writeHead(200, {'content-type': 'text/plain'});
    res.write('partial');
  });
  const track = await listen(target);
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pinnedFetch(new URL(`http://${HOST_NAME}:${track.port}/slow`), '127.0.0.1', 'GET', {}, controller.signal), (error: unknown) => error instanceof AdlError || (error as Error).name === 'AbortError');
    await waitClosed([track.sockets]);
  } finally {
    closeAll([track]);
  }
});

test('a stalled response hits the deadline without leaving sockets', {skip: SKIP_SLOW}, async () => {
  const target = http.createServer(() => { /* never respond */ });
  const track = await listen(target);
  try {
    await assert.rejects(pinnedFetch(new URL(`http://${HOST_NAME}:${track.port}/stall`), '127.0.0.1', 'GET', {}, AbortSignal.timeout(8000)), expectCode('E_TIMEOUT'));
    await waitClosed([track.sockets]);
  } finally {
    closeAll([track]);
  }
});

test('trusted child (TLS suite) passes', {skip: TRUSTED}, async (t) => {
  await startTrustedChild(t);
});

// ---------- TLS: only in the child with NODE_EXTRA_CA_CERTS ----------

test('https CONNECT tunnel round trip with trusted certificate', {skip: !TRUSTED}, async () => {
  const target = https.createServer({key: KEY_PEM, cert: CERT_PEM}, (req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.end(`sni=${String((req.socket as {servername?: string}).servername)}`);
  });
  const targetTrack = await listen(target);
  const proxy = connectProxy(targetTrack.port);
  const proxyTrack = await listen(proxy.server);
  try {
    const result = await pinnedFetch(new URL(`https://${HOST_NAME}:${targetTrack.port}/secure`), '127.0.0.1', 'GET', {}, AbortSignal.timeout(4000), undefined, `http://127.0.0.1:${proxyTrack.port}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), `sni=${HOST_NAME}`);
    assert.equal(proxy.authority(), `CONNECT 127.0.0.1:${targetTrack.port} HTTP/1.1`);
    await waitClosed([targetTrack.sockets, proxyTrack.sockets]);
  } finally {
    closeAll([targetTrack, proxyTrack]);
  }
});

test('certificate hostname mismatch is denied', {skip: !TRUSTED}, async () => {
  const target = https.createServer({key: KEY_PEM, cert: CERT_PEM}, (_req, res) => res.end('unreachable'));
  const targetTrack = await listen(target);
  const proxy = connectProxy(targetTrack.port);
  const proxyTrack = await listen(proxy.server);
  try {
    await assert.rejects(pinnedFetch(new URL(`https://other.invalid:${targetTrack.port}/`), '127.0.0.1', 'GET', {}, AbortSignal.timeout(4000), undefined, `http://127.0.0.1:${proxyTrack.port}`), expectCode('E_POLICY_DENIED'));
  } finally {
    closeAll([targetTrack, proxyTrack]);
  }
});

test('CONNECT denial is E_POLICY_DENIED', {skip: !TRUSTED}, async () => {
  const target = https.createServer({key: KEY_PEM, cert: CERT_PEM}, (_req, res) => res.end('x'));
  const targetTrack = await listen(target);
  const proxy = connectProxy(targetTrack.port, {deny: true});
  const proxyTrack = await listen(proxy.server);
  try {
    await assert.rejects(pinnedFetch(new URL(`https://${HOST_NAME}:${targetTrack.port}/`), '127.0.0.1', 'GET', {}, AbortSignal.timeout(4000), undefined, `http://127.0.0.1:${proxyTrack.port}`), expectCode('E_POLICY_DENIED'));
  } finally {
    closeAll([targetTrack, proxyTrack]);
  }
});

test('abort during CONNECT settles and closes the socket', {skip: !TRUSTED}, async () => {
  const target = https.createServer({key: KEY_PEM, cert: CERT_PEM}, (_req, res) => res.end('x'));
  const targetTrack = await listen(target);
  const proxy = connectProxy(targetTrack.port, {stall: true});
  const proxyTrack = await listen(proxy.server);
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(pinnedFetch(new URL(`https://${HOST_NAME}:${targetTrack.port}/`), '127.0.0.1', 'GET', {}, controller.signal, undefined, `http://127.0.0.1:${proxyTrack.port}`), (error: unknown) => error instanceof AdlError || (error as Error).name === 'AbortError');
    await waitClosed([proxyTrack.sockets]);
  } finally {
    closeAll([targetTrack, proxyTrack]);
  }
});
