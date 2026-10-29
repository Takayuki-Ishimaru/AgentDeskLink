import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinnedFetch } from '../src/browser-network.js';
import { AdlError } from '../src/types.js';

// Fixture certificate: self-signed, CA:TRUE, SAN = DNS:test.invalid + IP:127.0.0.1.
// Trusted via NODE_EXTRA_CA_CERTS in the child Node process this file spawns.
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
const HOST_NAME = 'test.invalid';

type Track = { server: http.Server | https.Server | net.Server; sockets: Set<net.Socket>; port: number };

async function listen(server: http.Server | https.Server | net.Server): Promise<Track> {
  const sockets = new Set<net.Socket>();
  server.on('connection', s => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { server, sockets, port: address.port };
}

function closeAll(tracks: Track[]): void {
  for (const t of tracks) {
    for (const s of t.sockets) s.destroy();
    t.sockets.clear();
    t.server.close();
  }
}

async function waitClosed(sockets: Set<net.Socket>[], ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (sockets.every(s => s.size === 0)) return;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.fail('sockets left open after the request settled');
}

function connectProxy(
  targetPort: number,
  opts: { denyStatus?: number } = {},
): { server: net.Server; sockets: Set<net.Socket>; authority: () => string } {
  const sockets = new Set<net.Socket>();
  let lastAuthority = '';
  const server = net.createServer(client => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    let buf = Buffer.alloc(0);
    let handled = false;
    client.on('error', () => client.destroy());
    client.on('data', d => {
      if (handled) return;
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      handled = true;
      lastAuthority = buf.subarray(0, idx).toString('latin1').split('\r\n')[0] ?? '';
      if (opts.denyStatus !== undefined) {
        client.end(`HTTP/1.1 ${opts.denyStatus} Denied\r\nProxy-Agent: adl-test\r\n\r\n`);
        return;
      }
      client.write('HTTP/1.1 200 Connection established\r\nProxy-Agent: adl-test\r\n\r\n');
      const upstream = net.connect(targetPort, '127.0.0.1', () => {
        upstream.pipe(client);
        client.pipe(upstream);
      });
      sockets.add(upstream);
      upstream.on('close', () => {
        sockets.delete(upstream);
        client.destroy();
      });
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
    });
  });
  return { server, sockets, authority: () => lastAuthority };
}

function expectReason(reason: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AdlError, `expected AdlError, got ${String(error)}`);
    assert.equal((error as AdlError).code, 'E_POLICY_DENIED');
    assert.equal((error as AdlError).reason, reason);
    return true;
  };
}

function startTrustedChild(t: TestContext): Promise<void> {
  // NODE_EXTRA_CA_CERTS is the only portable way to add trust without touching
  // production code (which always sets rejectUnauthorized:true).
  const caPath = join(tmpdir(), `adl-hostname-test-ca-${process.pid}.pem`);
  writeFileSync(caPath, CERT_PEM);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_EXTRA_CA_CERTS: caPath, ADL_TLS_TRUSTED: '1' };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(
    process.execPath,
    ['--test', '--test-timeout=10000', '--test-force-exit', ...process.argv.slice(1)],
    {
      env: childEnv,
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('trusted child timed out'));
    }, 30000);
    child.once('error', error => {
      clearTimeout(timer);
      rmSync(caPath, { force: true });
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      rmSync(caPath, { force: true });
      t.diagnostic(`trusted child exit code ${String(code)}`);
      if (code === 0) resolve();
      else reject(new Error(`trusted child failed with code ${String(code)}`));
    });
  });
}

// ---------- always-run (failure happens before certificate trust matters) ----------

test('a closed proxy port reports proxy_unreachable', async () => {
  const listener = net.createServer();
  const track = await listen(listener);
  const deadPort = track.port;
  await new Promise<void>(resolve => track.server.close(() => resolve()));
  await assert.rejects(
    pinnedFetch(
      new URL(`https://${HOST_NAME}:9/`),
      '127.0.0.1',
      'GET',
      {},
      AbortSignal.timeout(4000),
      undefined,
      `http://127.0.0.1:${deadPort}`,
    ),
    expectReason('proxy_unreachable'),
  );
  await assert.rejects(
    pinnedFetch(
      new URL(`https://${HOST_NAME}:9/`),
      '127.0.0.1',
      'GET',
      {},
      AbortSignal.timeout(4000),
      undefined,
      `http://127.0.0.1:${deadPort}`,
      { proxyConnectByHostname: true },
    ),
    expectReason('proxy_unreachable'),
  );
});

test('a 403 answer to CONNECT reports proxy_connect_refused in both modes', async () => {
  const proxy = connectProxy(9, { denyStatus: 403 });
  const track = await listen(proxy.server);
  try {
    const url = new URL(`https://${HOST_NAME}:9/`);
    const proxyServer = `http://127.0.0.1:${track.port}`;
    await assert.rejects(
      pinnedFetch(url, '127.0.0.1', 'GET', {}, AbortSignal.timeout(4000), undefined, proxyServer),
      expectReason('proxy_connect_refused'),
    );
    await assert.rejects(
      pinnedFetch(url, '127.0.0.1', 'GET', {}, AbortSignal.timeout(4000), undefined, proxyServer, {
        proxyConnectByHostname: true,
      }),
      expectReason('proxy_connect_refused'),
    );
    await waitClosed([track.sockets]);
  } finally {
    closeAll([track]);
  }
});

test('default mode keeps sending the vetted IP authority', async () => {
  const proxy = connectProxy(9, { denyStatus: 403 });
  const track = await listen(proxy.server);
  try {
    await assert.rejects(
      pinnedFetch(
        new URL(`https://${HOST_NAME}:443/`),
        '203.0.113.7',
        'GET',
        {},
        AbortSignal.timeout(4000),
        undefined,
        `http://127.0.0.1:${track.port}`,
      ),
      expectReason('proxy_connect_refused'),
    );
    assert.equal(proxy.authority(), 'CONNECT 203.0.113.7:443 HTTP/1.1');
    await waitClosed([track.sockets]);
  } finally {
    closeAll([track]);
  }
});

test('trusted child (TLS suite) passes', { skip: TRUSTED }, async t => {
  await startTrustedChild(t);
});

// ---------- TLS: only in the child with NODE_EXTRA_CA_CERTS ----------

test('hostname mode sends CONNECT <hostname>:<port> and completes verified TLS', { skip: !TRUSTED }, async () => {
  const target = https.createServer({ key: KEY_PEM, cert: CERT_PEM }, (req, res) => {
    res.setHeader('content-type', 'text/plain');
    res.end(`sni=${String((req.socket as { servername?: string }).servername)}`);
  });
  const targetTrack = await listen(target);
  const proxy = connectProxy(targetTrack.port);
  const proxyTrack = await listen(proxy.server);
  try {
    const result = await pinnedFetch(
      new URL(`https://${HOST_NAME}:${targetTrack.port}/secure`),
      '127.0.0.1',
      'GET',
      {},
      AbortSignal.timeout(4000),
      undefined,
      `http://127.0.0.1:${proxyTrack.port}`,
      { proxyConnectByHostname: true },
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), `sni=${HOST_NAME}`);
    assert.equal(proxy.authority(), `CONNECT ${HOST_NAME}:${targetTrack.port} HTTP/1.1`);
    await waitClosed([targetTrack.sockets, proxyTrack.sockets]);
  } finally {
    closeAll([targetTrack, proxyTrack]);
  }
});

test('hostname mode with default port sends CONNECT <hostname>:443', { skip: !TRUSTED }, async () => {
  const proxy = connectProxy(9, { denyStatus: 403 });
  const track = await listen(proxy.server);
  try {
    await assert.rejects(
      pinnedFetch(
        new URL(`https://${HOST_NAME}/`),
        '203.0.113.7',
        'GET',
        {},
        AbortSignal.timeout(4000),
        undefined,
        `http://127.0.0.1:${track.port}`,
        { proxyConnectByHostname: true },
      ),
      expectReason('proxy_connect_refused'),
    );
    assert.equal(proxy.authority(), `CONNECT ${HOST_NAME}:443 HTTP/1.1`);
    await waitClosed([track.sockets]);
  } finally {
    closeAll([track]);
  }
});

test('hostname mode still denies a certificate that does not match the hostname', { skip: !TRUSTED }, async () => {
  const target = https.createServer({ key: KEY_PEM, cert: CERT_PEM }, (_req, res) => res.end('unreachable'));
  const targetTrack = await listen(target);
  const proxy = connectProxy(targetTrack.port);
  const proxyTrack = await listen(proxy.server);
  try {
    await assert.rejects(
      pinnedFetch(
        new URL(`https://other.invalid:${targetTrack.port}/`),
        '127.0.0.1',
        'GET',
        {},
        AbortSignal.timeout(4000),
        undefined,
        `http://127.0.0.1:${proxyTrack.port}`,
        { proxyConnectByHostname: true },
      ),
      (error: unknown) => {
        assert.ok(error instanceof AdlError);
        assert.equal((error as AdlError).code, 'E_POLICY_DENIED');
        // TLS identity failures keep the bare policy-denied error, not a proxy reason.
        assert.ok(!((error as AdlError).reason ?? '').startsWith('proxy_'));
        return true;
      },
    );
    assert.equal(proxy.authority(), `CONNECT other.invalid:${targetTrack.port} HTTP/1.1`);
  } finally {
    closeAll([targetTrack, proxyTrack]);
  }
});
