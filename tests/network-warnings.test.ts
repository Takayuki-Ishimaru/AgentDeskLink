import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { isActionNetworkBlock, isWriteBlock, networkMethod, networkResourceType } from '../src/network-warnings.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import type { Adapter, AdapterSession, NetworkWarning } from '../src/types.js';
import type { Page } from 'playwright';

async function listen(server: Server) {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function shut(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
}
type ActResult = {
  ok: boolean;
  revision: number;
  network_blocked?: boolean;
  subresources_blocked?: number;
  write_blocked?: boolean;
  warnings?: NetworkWarning[];
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** pages: other documents of the app by path (served as they are); the main page wraps buttons(cdn) after a status paragraph. */
async function fixture(
  buttons: (cdn: string) => string,
  operationMode: 'standard' | 'ask' = 'standard',
  pages: (cdn: string) => Record<string, string> = () => ({}),
) {
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
    const other = pages(cdnOrigin)[(req.url ?? '/').split('?')[0]!];
    res.end(other ?? `<!doctype html><body><p id="s">ready</p>${buttons(cdnOrigin)}</body>`);
  });
  const origin = await listen(app);
  const policy = parsePolicy({
    operationMode,
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 4000,
    browserTargets: [{ id: 'app', label: 'App', url: origin, classification: 'PUBLIC' }],
  });
  const adapter = new BrowserAdapter(policy, (url, purpose) => assertUrlAllowed(url, policy, undefined, purpose));
  const open = adapter.open.bind(adapter);
  let instance: AdapterSession | undefined;
  adapter.open = async (...args) => (instance = await open(...args));
  const engine = new Engine(policy, { browser: adapter });
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
    /** The adapter's own session: the raw snapshot with its block sequence number. */
    raw: () => instance!,
    page: () => (instance as unknown as { pageValue: Page }).pageValue,
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
      assert.equal(result.write_blocked, undefined, 'blocked subresources are not blocked writes');
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
      assert.equal(result.write_blocked, true, 'a blocked POST means the page state was not saved');
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
    assert.equal(result.write_blocked, undefined, 'a blocked GET is not a failed write');
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
      assert.equal(result.write_blocked, true, JSON.stringify(result));
      assert.equal(result.subresources_blocked, 1, JSON.stringify(result));
      assert.equal(result.warnings![0]!.method, 'PUT', 'action-class warnings are listed first');
    } finally {
      await f.close();
    }
  },
);

test(
  'subresource noise from many origins cannot hide a later action block, and the next observation does not repeat it',
  { timeout: 60000 },
  async () => {
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
      await f.page().waitForLoadState('load');
      // The twelve stylesheet blocks belong to the document: the first observation reports them (bounded), once.
      const first = await f.engine.observe(f.session.session_id);
      const noiseWarnings = first.warnings as NetworkWarning[];
      assert.ok(noiseWarnings.length > 0 && noiseWarnings.length <= 8, JSON.stringify(noiseWarnings));
      assert.ok(noiseWarnings.every(w => w.resource_type === 'stylesheet'));
      const result = await f.click('Search API');
      assert.equal(result.network_blocked, true, JSON.stringify(result));
      assert.equal(result.write_blocked, true, JSON.stringify(result));
      assert.equal(result.warnings!.length, 1, 'only the block this action caused');
      assert.equal(result.warnings![0]!.method, 'POST');
      const observed = await f.engine.observe(f.session.session_id);
      assert.equal(
        observed.warnings,
        undefined,
        'the action result carried its block, the first observation the stylesheets',
      );
    } finally {
      await f.close();
      for (const n of noise) await shut(n.server);
    }
  },
);

test(
  'a write that starts after the action ended is reported by the next observation only, once, as a new revision',
  { timeout: 40000 },
  async () => {
    const f = await fixture(
      () =>
        `<button onclick="setTimeout(()=>fetch('/api',{method:'POST',body:'a=b'}).catch(()=>{window.refused=true}),300)">Save later</button>`,
    );
    try {
      const result = await f.click('Save later');
      assert.equal(result.warnings, undefined, 'nothing was blocked inside the action');
      assert.equal(result.network_blocked, undefined);
      assert.equal(result.write_blocked, undefined);
      await until(
        () => f.page().evaluate(() => (window as unknown as { refused?: boolean }).refused === true),
        'the page to see the refusal',
      );
      const observed = await f.engine.observe(f.session.session_id);
      const late = (observed.warnings as NetworkWarning[]).filter(w => w.code === 'method_requires_approval');
      assert.deepEqual(late, [{ code: 'method_requires_approval', count: 1, resource_type: 'fetch', method: 'POST' }]);
      assert.equal(observed.revision, result.revision + 1, 'a late block is visible as a change');
      const again = await f.engine.observe(f.session.session_id);
      assert.equal(again.warnings, undefined, 'reported once');
      assert.equal(again.revision, observed.revision, 'reporting does not change the revision');
      assert.equal(f.posts(), 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'a navigation discards what the old document blocked: the new page reports only its own',
  { timeout: 40000 },
  async () => {
    const f = await fixture(
      cdn => `<link rel="stylesheet" href="${cdn}/old.css">`,
      'standard',
      cdn => ({ '/b': `<!doctype html><body><p>Page B</p><img src="${cdn}/new.png"></body>` }),
    );
    try {
      await f.page().waitForLoadState('load');
      // Nobody observed page A, so its blocked stylesheet is still unreported when the navigation starts.
      const navigated = (await f.engine.act(
        f.session.session_id,
        { action: 'navigate', url: `${f.origin}/b` },
        f.session.revision,
      )) as ActResult;
      await f.page().waitForLoadState('load');
      const observed = await f.engine.observe(f.session.session_id);
      assert.ok(observed.elements!.some(e => e.name === 'Page B'));
      const reported = [...(navigated.warnings ?? []), ...((observed.warnings as NetworkWarning[] | undefined) ?? [])];
      assert.ok(
        !reported.some(w => w.resource_type === 'stylesheet'),
        `page A's block is gone: ${JSON.stringify(reported)}`,
      );
      assert.deepEqual(
        reported.filter(w => w.resource_type === 'image').map(w => [w.code, w.count]),
        [['origin_not_allowed', 1]],
        'page B reports its own block exactly once, in the navigation or the observation',
      );
      assert.equal((await f.engine.observe(f.session.session_id)).warnings, undefined);
    } finally {
      await f.close();
    }
  },
);

test('adl_execute steps carry only the blocks of their own action', { timeout: 40000 }, async () => {
  const f = await fixture(
    () =>
      `<button onclick="fetch('/api',{method:'POST',body:'a=b'}).catch(()=>{})">Search API</button><button onclick="document.getElementById('s').textContent='plain done'">Plain</button>`,
  );
  try {
    const id = f.session.session_id;
    const observed = await f.engine.observe(id);
    const ids = ['Search API', 'Plain'].map(name => observed.elements!.find(e => e.name === name)!.id);
    const started = f.engine.execute(
      ids.map(element_id => ({ session_id: id, action: 'click' as const, element_id })),
      { [id]: observed.revision },
    );
    let task = f.engine.task(started.task_id);
    for (; task.status === 'queued' || task.status === 'running'; task = f.engine.task(started.task_id))
      await sleep(25);
    assert.equal(task.status, 'completed', JSON.stringify(task));
    const [first, second] = task.results as unknown as ActResult[];
    assert.equal(first!.warnings!.length, 1, JSON.stringify(first));
    assert.equal(first!.warnings![0]!.code, 'method_requires_approval');
    assert.equal(first!.write_blocked, true);
    assert.equal(second!.warnings, undefined, JSON.stringify(second));
    assert.equal(second!.network_blocked, undefined);
    assert.equal(second!.write_blocked, undefined);
    assert.equal(f.posts(), 0);
  } finally {
    await f.close();
  }
});

test('observation pages after the first do not repeat the warnings', { timeout: 60000 }, async () => {
  const noise = await Promise.all(
    Array.from({ length: 3 }, async () => {
      const server = createServer((_req, res) => {
        res.setHeader('content-type', 'text/css');
        res.end('');
      });
      return { server, origin: await listen(server) };
    }),
  );
  const links = noise.map((n, i) => `<link rel="stylesheet" href="${n.origin}/n${i}.css">`).join('');
  const items = Array.from(
    { length: 40 },
    (_, i) => `<button>Item number ${i} with a reasonably long accessible name</button>`,
  ).join('');
  const f = await fixture(() => `${links}${items}`);
  try {
    await f.page().waitForLoadState('load');
    const id = f.session.session_id;
    const first = await f.engine.observe(id, { token_budget: 256 });
    assert.ok(first.next_cursor, 'the page is long enough to be paged');
    assert.equal((first.warnings as NetworkWarning[]).length, 3, JSON.stringify(first.warnings));
    let pages = 1;
    for (let cursor: string | undefined = first.next_cursor; cursor; pages++) {
      const next = await f.engine.observe(id, { token_budget: 256, cursor });
      assert.equal(next.warnings, undefined, `page ${pages + 1} repeats nothing`);
      cursor = next.next_cursor;
    }
    assert.ok(pages > 1);
    assert.equal((await f.engine.observe(id)).warnings, undefined, 'a later observation of the same revision neither');
  } finally {
    await f.close();
    for (const n of noise) await shut(n.server);
  }
});

test(
  'every block advances the adapter sequence; delivering warnings leaves the fingerprint and revision alone',
  { timeout: 40000 },
  async () => {
    const f = await fixture(
      cdn =>
        `<link rel="stylesheet" href="${cdn}/seq.css"><button onclick="fetch('/api',{method:'POST',body:'a'}).catch(()=>{});fetch('/api',{method:'PUT',body:'b'}).catch(()=>{})">Two writes</button>`,
    );
    try {
      await f.page().waitForLoadState('load');
      const id = f.session.session_id;
      const loaded = await f.raw().snapshot();
      assert.ok(loaded.warningSeq! >= 1, 'the stylesheet block was counted');
      // Delivering the warnings (the engine acknowledges them) is not a change of the page.
      const first = await f.engine.observe(id);
      assert.equal((first.warnings as NetworkWarning[]).length, 1);
      const delivered = await f.raw().snapshot();
      const second = await f.engine.observe(id);
      assert.equal(second.warnings, undefined);
      assert.equal(second.revision, first.revision);
      const unchanged = await f.raw().snapshot();
      assert.equal(unchanged.fingerprint, delivered.fingerprint);
      assert.equal(unchanged.warningSeq, delivered.warningSeq);
      assert.equal(delivered.warningSeq, loaded.warningSeq);
      const result = await f.click('Two writes');
      assert.equal(result.warnings!.length, 2);
      const after = await f.raw().snapshot();
      assert.equal(after.warningSeq! - delivered.warningSeq!, 2, 'one step per block');
      assert.notEqual(after.fingerprint, delivered.fingerprint, 'a new block is a new revision');
    } finally {
      await f.close();
    }
  },
);

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

test('isWriteBlock flags every method except GET/HEAD, whatever the resource type', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'other'])
    assert.equal(isWriteBlock({ method }), true, method);
  for (const method of ['GET', 'HEAD']) assert.equal(isWriteBlock({ method }), false, method);
  assert.equal(isWriteBlock({}), false);
  assert.equal(isWriteBlock({ method: undefined }), false);
  const warning: NetworkWarning = {
    code: 'method_requires_approval',
    count: 1,
    method: 'POST',
    resource_type: 'image',
  };
  assert.equal(isWriteBlock(warning), true);
  assert.equal(isWriteBlock({ ...warning, resource_type: 'fetch' }), true);
  assert.equal(isWriteBlock({ code: 'origin_not_allowed', count: 1, resource_type: 'fetch', method: 'GET' }), false);
  assert.equal(isWriteBlock({ code: 'origin_not_allowed', count: 1, resource_type: 'fetch' }), false);
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
