import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { isActionNetworkBlock, networkMethod, networkResourceType } from '../src/network-warnings.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import type { Adapter, NetworkWarning } from '../src/types.js';

async function listen(server: Server) {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function shut(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
}
type ActResult = { ok: boolean; network_blocked?: boolean; subresources_blocked?: number; warnings?: NetworkWarning[] };

async function fixture(buttons: (cdn: string) => string, operationMode: 'standard' | 'ask' = 'standard') {
  const cdn = createServer((req, res) => {
    res.setHeader(
      'content-type',
      req.url?.endsWith('.css') ? 'text/css' : req.url?.endsWith('.js') ? 'application/javascript' : 'text/plain',
    );
    res.end('');
  });
  const cdnOrigin = await listen(cdn);
  let posts = 0;
  const app = createServer((req, res) => {
    if (req.method === 'POST') {
      posts++;
      res.end('unexpected');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><body><p id="s">ready</p>${buttons(cdnOrigin)}</body>`);
  });
  const origin = await listen(app);
  const policy = parsePolicy({
    operationMode,
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 4000,
    browserTargets: [{ id: 'app', label: 'App', url: origin, classification: 'PUBLIC' }],
  });
  const engine = new Engine(policy, {
    browser: new BrowserAdapter(policy, (url, purpose) => assertUrlAllowed(url, policy, undefined, purpose)),
  });
  const session = await engine.open((await engine.listTargets()).targets[0]!.target_id);
  const click = async (name: string) => {
    const observed = await engine.observe(session.session_id);
    return (await engine.act(
      session.session_id,
      { action: 'click', element_id: observed.elements!.find(e => e.name === name)!.id },
      observed.revision,
    )) as ActResult;
  };
  return {
    engine,
    session,
    origin,
    cdnOrigin,
    click,
    posts: () => posts,
    close: async () => {
      await engine.shutdown();
      await shut(app);
      await shut(cdn);
    },
  };
}

test(
  'blocked stylesheets, images and scripts from a non-granted origin are subresources, not a failed action',
  { timeout: 40000 },
  async () => {
    const f = await fixture(
      cdn =>
        `<button onclick="const l=document.createElement('link');l.rel='stylesheet';l.href='${cdn}/late.css';document.head.append(l);const i=document.createElement('img');i.src='${cdn}/late.png';document.body.append(i);const s=document.createElement('script');s.src='${cdn}/late.js';document.body.append(s);document.getElementById('s').textContent='done';">Load extras</button>`,
    );
    try {
      const result = await f.click('Load extras');
      assert.equal(result.ok, true);
      assert.equal(result.network_blocked, undefined, JSON.stringify(result));
      assert.equal(result.subresources_blocked, 3, JSON.stringify(result));
      const types = new Set(result.warnings!.map(w => w.resource_type));
      for (const type of ['stylesheet', 'image', 'script'])
        assert.ok(types.has(type), type + ' ' + JSON.stringify(result.warnings));
      for (const w of result.warnings!) {
        assert.equal(w.code, 'origin_not_allowed');
        assert.equal(w.method, 'GET');
        assert.equal(w.origin, f.cdnOrigin);
        assert.deepEqual(Object.keys(w).sort(), ['code', 'count', 'method', 'origin', 'resource_type']);
      }
      assert.equal(f.posts(), 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'a fetch POST in standard mode is the action blocking itself and reports method and resource type',
  { timeout: 40000 },
  async () => {
    const f = await fixture(
      () => `<button onclick="fetch('/api',{method:'POST',body:'a=b'}).catch(()=>{})">Search API</button>`,
    );
    try {
      const result = await f.click('Search API');
      assert.equal(result.network_blocked, true, JSON.stringify(result));
      assert.equal(result.subresources_blocked, undefined);
      const warning = result.warnings!.find(w => w.code === 'method_requires_approval')!;
      assert.ok(warning, JSON.stringify(result.warnings));
      assert.equal(warning.method, 'POST');
      assert.equal(warning.resource_type, 'fetch');
      assert.equal(warning.origin, undefined, 'same-origin blocks carry no origin, as before');
      assert.equal(f.posts(), 0);
    } finally {
      await f.close();
    }
  },
);

test('a fetch GET to a non-granted origin counts as the action being blocked', { timeout: 40000 }, async () => {
  const f = await fixture(cdn => `<button onclick="fetch('${cdn}/data').catch(()=>{})">Fetch elsewhere</button>`);
  try {
    const result = await f.click('Fetch elsewhere');
    assert.equal(result.network_blocked, true, JSON.stringify(result));
    const warning = result.warnings!.find(w => w.code === 'origin_not_allowed')!;
    assert.equal(warning.resource_type, 'fetch');
    assert.equal(warning.method, 'GET');
    assert.equal(warning.origin, f.cdnOrigin);
  } finally {
    await f.close();
  }
});

test(
  'an action with both kinds of blocks reports the action block and counts the subresource separately',
  { timeout: 40000 },
  async () => {
    const f = await fixture(
      cdn =>
        `<button onclick="const l=document.createElement('link');l.rel='stylesheet';l.href='${cdn}/mixed.css';document.head.append(l);fetch('/api',{method:'PUT',body:'x'}).catch(()=>{})">Both</button>`,
    );
    try {
      const result = await f.click('Both');
      assert.equal(result.network_blocked, true, JSON.stringify(result));
      assert.equal(result.subresources_blocked, 1, JSON.stringify(result));
      assert.equal(result.warnings![0]!.method, 'PUT', 'action-class warnings are listed first');
    } finally {
      await f.close();
    }
  },
);

test('subresource noise from many origins cannot hide a later action block', { timeout: 60000 }, async () => {
  const noise = await Promise.all(
    Array.from({ length: 12 }, async () => {
      const server = createServer((_req, res) => {
        res.setHeader('content-type', 'text/css');
        res.end('');
      });
      return { server, origin: await listen(server) };
    }),
  );
  const links = noise.map((n, i) => `<link rel="stylesheet" href="${n.origin}/n${i}.css">`).join('');
  const f = await fixture(
    () => `${links}<button onclick="fetch('/api',{method:'POST',body:'a=b'}).catch(()=>{})">Search API</button>`,
  );
  try {
    const result = await f.click('Search API');
    assert.equal(result.network_blocked, true, JSON.stringify(result));
    assert.equal(result.warnings![0]!.method, 'POST', 'the action block is listed before any subresource block');
    const observed = await f.engine.observe(f.session.session_id);
    assert.ok((observed.warnings as NetworkWarning[]).length <= 8);
    assert.equal((observed.warnings as NetworkWarning[])[0]!.resource_type, 'fetch');
  } finally {
    await f.close();
    for (const n of noise) await shut(n.server);
  }
});

test(
  'a blocked sub-frame document is background traffic and does not set network_blocked',
  { timeout: 40000 },
  async () => {
    const f = await fixture(
      cdn =>
        `<button onclick="const f=document.createElement('iframe');f.src='${cdn}/frame.html';document.body.append(f);">Embed</button>`,
    );
    try {
      const result = await f.click('Embed');
      assert.equal(result.network_blocked, undefined, JSON.stringify(result));
      assert.ok(
        result.warnings!.some(w => w.resource_type === 'subframe' && w.code === 'origin_not_allowed'),
        JSON.stringify(result.warnings),
      );
    } finally {
      await f.close();
    }
  },
);

test('classification helpers are bounded enums and keep unclassified warnings conservative', () => {
  assert.equal(isActionNetworkBlock({ resource_type: 'stylesheet', method: 'GET' }), false);
  assert.equal(isActionNetworkBlock({ resource_type: 'image', method: 'GET' }), false);
  assert.equal(isActionNetworkBlock({ resource_type: 'font', method: 'GET' }), false);
  assert.equal(isActionNetworkBlock({ resource_type: 'media', method: 'HEAD' }), false);
  assert.equal(isActionNetworkBlock({ resource_type: 'subframe', method: 'GET' }), false);
  assert.equal(isActionNetworkBlock({ resource_type: 'other', method: 'GET' }), false);
  assert.equal(isActionNetworkBlock({ resource_type: 'document', method: 'GET' }), true);
  assert.equal(isActionNetworkBlock({ resource_type: 'xhr', method: 'GET' }), true);
  assert.equal(isActionNetworkBlock({ resource_type: 'fetch', method: 'GET' }), true);
  assert.equal(isActionNetworkBlock({ resource_type: 'websocket', method: 'GET' }), true);
  assert.equal(isActionNetworkBlock({ resource_type: 'image', method: 'POST' }), true);
  assert.equal(isActionNetworkBlock({ resource_type: 'other', method: 'other' }), true);
  assert.equal(isActionNetworkBlock({}), true);
  assert.equal(networkMethod('post'), 'POST');
  assert.equal(networkMethod('PROPFIND'), 'other');
  const request = (type: string, child: boolean) => ({
    resourceType: () => type,
    isNavigationRequest: () => type === 'document',
    frame: () => ({ parentFrame: () => (child ? {} : null) }),
  });
  assert.equal(networkResourceType(request('document', false)), 'document');
  assert.equal(networkResourceType(request('document', true)), 'subframe');
  assert.equal(networkResourceType(request('beacon-of-doom', false)), 'other');
  assert.equal(networkResourceType(request('stylesheet', true)), 'stylesheet');
});

test('adapters that report unclassified warnings still flag network_blocked', { timeout: 10000 }, async () => {
  let blocks = 0;
  const adapter: Adapter = {
    open: async () => ({
      snapshot: async () => ({
        elements: [{ id: 'e', role: 'button', name: 'Go', enabled: true }],
        fingerprint: 'f' + blocks,
        truncated: false,
        ...(blocks ? { warnings: [{ code: 'request_denied', count: blocks }] } : {}),
      }),
      act: async () => {
        blocks++;
      },
      close: async () => {},
    }),
    close: async () => {},
  };
  const policy = parsePolicy({
    allowAllOperations: true,
    allowLoopback: true,
    browserTargets: [{ id: 't', label: 'T', url: 'http://127.0.0.1:8123/', classification: 'PUBLIC' }],
  });
  const engine = new Engine(policy, { browser: adapter });
  try {
    const session = await engine.open((await engine.listTargets()).targets[0]!.target_id);
    const result = (await engine.act(
      session.session_id,
      { action: 'click', element_id: 'e1' },
      session.revision,
    )) as ActResult;
    assert.equal(result.network_blocked, true);
    assert.equal(result.subresources_blocked, undefined);
  } finally {
    await engine.shutdown();
  }
});
