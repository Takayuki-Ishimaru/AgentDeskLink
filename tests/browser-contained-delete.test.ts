import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import { AdlError, safeError } from '../src/types.js';

// Standard mode has nobody to ask, so a control consequential only through "Delete" or "Remove" is dispatched with the network
// closed until the next action: only what the page was already requesting before the click goes on. What the control does in the
// page stays in the session; a request it sets in motion is stopped and reported.

const PAGE = `<!doctype html><title>Todo</title>
<ul id="list"><li id="milk">Buy milk <button id="d1" onclick="fired('d1');document.getElementById('milk').remove();localStorage.setItem('gone','1')">Delete Buy milk</button></li></ul>
<button onclick="fired('d2');document.body.append(Object.assign(new Image(),{src:'/avatar.png?v=2'}))">Remove from view</button>
<button onclick="fired('d14');new Image().src='/items/1/img-delete'">Delete by image</button>
<button onclick="fired('d15');new Image().src='/items/1/pixel';fetch('/items/1/both')">Delete by both</button>
<button onclick="fired('d16');setTimeout(()=>fetch('/items/1/later'),800)">Delete later</button>
<button onclick="fired('d17');setTimeout(()=>{location.href='/items/1/left'},800)">Delete and leave later</button>
<button onclick="fired('d18');fetch('/after')">Load more</button>
<button onclick="fired('d3');fetch('/items/1',{method:'DELETE'})">Delete on server</button>
<button onclick="fired('d4');fetch('/items/1/remove')">Delete by read</button>
<button onclick="fired('d5');setTimeout(()=>fetch('/items/1/late'),300)">Delete soon</button>
<button onclick="fired('d6');location.href='/items/1/gone'">Delete and leave</button>
<button onclick="fired('d7');navigator.sendBeacon('/beacon','x')">Delete quietly</button>
<button onclick="fired('d13');import('/items/1/chunk.js').catch(()=>{})">Delete lazily</button>
<button onclick="fired('d8')">Delete and send</button>
<button onclick="fired('d9')">削除</button>
<form method="post" action="/save"><button onclick="fired('d10')">Delete in form</button></form>
<div role="dialog" aria-label="Delete this item?"><button onclick="fired('d11')">OK</button></div>
<a href="/items/1">Delete link</a>
<button onclick="fired('d12')">Go</button>
<script>window.fires=[];window.fired=name=>window.fires.push(name)</script>`;

// Traffic the page was making before anything was clicked.
const BUSY = `<img src="/avatar.png?v=1" alt=""><script>setInterval(()=>fetch('/poll?t='+Date.now()),50)</script>`;

async function fixture(mode: 'standard' | 'ask', extra: Record<string, unknown> = {}, start = '/') {
  const requests: string[] = [];
  const app = createServer((request, response) => {
    const url = request.url ?? '/';
    const page = url === '/' ? PAGE : url === '/busy' ? PAGE + BUSY : undefined;
    if (!page) requests.push(`${request.method} ${url}`);
    if (page) response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(page ?? '');
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    operationMode: mode,
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 5000,
    browserTargets: [{ id: 'p', label: 'Fixture', url: origin + start, classification: 'PUBLIC' }],
    ...extra,
  });
  const adapter = new BrowserAdapter(policy, url => assertUrlAllowed(url, policy));
  const open = adapter.open.bind(adapter);
  let instance: { pageValue: { evaluate<T>(fn: () => T): Promise<T> } } | undefined;
  adapter.open = async (...args) => {
    const session = await open(...args);
    instance = session as unknown as typeof instance;
    return session;
  };
  const engine = new Engine(policy, { browser: adapter });
  const id = (await engine.open((await engine.listTargets()).targets[0]!.target_id)).session_id;
  const observe = () => engine.observe(id, { token_budget: 8000 });
  return {
    engine,
    id,
    requests,
    observe,
    fires: () =>
      instance!.pageValue.evaluate(() => (window as unknown as { fires: string[] }).fires) as Promise<string[]>,
    click: async (name: string) => {
      const state = await observe();
      const element = state.elements!.find(e => e.name === name);
      assert.ok(element, name);
      return (await engine.act(id, { action: 'click', element_id: element.id }, state.revision)) as {
        warnings?: { code: string }[];
      };
    },
    close: async () => {
      await engine.shutdown();
      app.closeAllConnections();
      await new Promise<void>(resolve => app.close(() => resolve()));
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const contained = (result: { warnings?: { code: string }[] }) =>
  assert.ok(
    result.warnings?.some(w => w.code === 'contained_action'),
    'contained_action',
  );

async function assertStopped(f: Fixture, name: string) {
  await assert.rejects(f.click(name), (error: unknown) => {
    assert.ok(error instanceof AdlError, String(error));
    assert.equal(error.code, 'E_APPROVAL_REQUIRED');
    assert.equal(error.reason, 'requires_ask_mode');
    assert.equal(error.mayHaveExecuted, false);
    assert.equal((safeError(error) as { page_script_ran?: boolean }).page_script_ran, true, 'its handler has run');
    return true;
  });
}

test('standard: a local Delete runs, says it was contained, and the session goes on', { timeout: 60000 }, async () => {
  const f = await fixture('standard');
  try {
    contained(await f.click('Delete Buy milk'));
    const state = await f.observe();
    assert.ok(!state.elements!.some(e => e.name === 'Delete Buy milk'), 'the item is gone');
    assert.deepEqual(f.requests, [], 'nothing left the page');
    contained(await f.click('削除'));
    assert.deepEqual((await f.fires()).slice(-1), ['d9']);
    const ordinary = await f.click('Go');
    assert.ok(!ordinary.warnings?.some(w => w.code === 'contained_action'), 'the network is open again');
  } finally {
    await f.close();
  }
});

const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('standard: a new image is not sent, and does not stop the action', { timeout: 60000 }, async () => {
  const f = await fixture('standard');
  try {
    contained(await f.click('Remove from view'));
    contained(await f.click('Delete by image'));
    await settle(200);
    assert.deepEqual(f.requests, [], 'neither the redraw nor an effect carried by an image left');
  } finally {
    await f.close();
  }
});

test('standard: what the page was already requesting goes on, and stops nothing', { timeout: 60000 }, async () => {
  const f = await fixture('standard', {}, '/busy');
  const polls = () => f.requests.filter(r => r.startsWith('GET /poll')).length;
  try {
    for (let i = 0; i < 40 && polls() < 2; i++) await settle(50);
    assert.ok(polls() >= 2, 'the page polls');
    contained(await f.click('Delete Buy milk'));
    const during = polls();
    await settle(300);
    assert.ok(polls() > during, 'the poll is not cut while the network is closed');
    contained(await f.click('Remove from view'));
    for (let i = 0; i < 20 && !f.requests.includes('GET /avatar.png?v=2'); i++) await settle(50);
    assert.ok(f.requests.includes('GET /avatar.png?v=2'), 'an image like one already loaded may load');
    await assertStopped(f, 'Delete by read');
    assert.ok(!f.requests.includes('GET /items/1/remove'), 'a new request still does not');
  } finally {
    await f.close();
  }
});

test('standard: nothing a stopped control asked for reaches the server', { timeout: 60000 }, async () => {
  const f = await fixture('standard');
  try {
    await assertStopped(f, 'Delete by both');
    await settle(200);
    assert.deepEqual(f.requests, []);
  } finally {
    await f.close();
  }
});

for (const [name, sign] of [
  ['Delete later', 'GET /items/1/later'],
  ['Delete and leave later', 'GET /items/1/left'],
] as const)
  test(`standard: "${name}" is stopped after the action returned, and reported`, { timeout: 60000 }, async () => {
    const f = await fixture('standard');
    try {
      contained(await f.click(name));
      await settle(1000);
      assert.ok(!f.requests.includes(sign), `${sign} never reached the server`);
      const state = await f.observe();
      assert.equal(new URL(state.url!).pathname, '/', 'the page stays');
      assert.ok(
        state.warnings?.some(w => w.code === 'requires_ask_mode'),
        'the next observation says so',
      );
    } finally {
      await f.close();
    }
  });

test('standard: the next action opens the network again', { timeout: 60000 }, async () => {
  const f = await fixture('standard');
  try {
    contained(await f.click('Delete Buy milk'));
    await f.click('Load more');
    for (let i = 0; i < 20 && !f.requests.includes('GET /after'); i++) await settle(50);
    assert.ok(f.requests.includes('GET /after'));
  } finally {
    await f.close();
  }
});

test('standard: an affirmative in a Delete dialog is contained the same way', { timeout: 60000 }, async () => {
  const f = await fixture('standard');
  try {
    contained(await f.click('OK'));
    assert.deepEqual(await f.fires(), ['d11']);
  } finally {
    await f.close();
  }
});

for (const [name, sign] of [
  ['Delete on server', 'DELETE /items/1'],
  ['Delete by read', 'GET /items/1/remove'],
  ['Delete soon', 'GET /items/1/late'],
  ['Delete and leave', 'GET /items/1/gone'],
  ['Delete quietly', 'POST /beacon'],
  ['Delete lazily', 'GET /items/1/chunk.js'],
] as const)
  test(`standard: "${name}" is stopped before its request leaves`, { timeout: 60000 }, async () => {
    const f = await fixture('standard');
    try {
      await assertStopped(f, name);
      await new Promise(resolve => setTimeout(resolve, 400));
      assert.ok(!f.requests.includes(sign), `${sign} never reached the server`);
      const state = await f.observe();
      assert.equal(new URL(state.url!).pathname, '/', 'the page stays');
      await f.click('Go');
    } finally {
      await f.close();
    }
  });

for (const [name, reason] of [
  ['Delete and send', 'requires_ask_mode'],
  ['Delete in form', 'requires_ask_mode'],
  ['Delete link', 'requires_ask_mode'],
] as const)
  test(`standard: "${name}" stays gated before dispatch`, { timeout: 60000 }, async () => {
    const f = await fixture('standard');
    try {
      await assert.rejects(
        f.click(name),
        (error: unknown) =>
          error instanceof AdlError && error.code === 'E_APPROVAL_REQUIRED' && error.reason === reason,
      );
      assert.deepEqual(await f.fires(), [], 'nothing was dispatched');
      assert.deepEqual(f.requests, []);
    } finally {
      await f.close();
    }
  });

test('standard: the deny list keeps Delete gated before dispatch', { timeout: 60000 }, async () => {
  const f = await fixture('standard', { consequentialDenyLabels: ['Delete'] });
  try {
    await assert.rejects(
      f.click('Delete Buy milk'),
      (error: unknown) => error instanceof AdlError && error.reason === 'requires_ask_mode',
    );
    assert.deepEqual(await f.fires(), []);
  } finally {
    await f.close();
  }
});

test('standard: the allow list needs no containment', { timeout: 60000 }, async () => {
  const f = await fixture('standard', { consequentialAllowLabels: ['Delete'] });
  try {
    const done = await f.click('Delete Buy milk');
    assert.ok(!done.warnings?.some(w => w.code === 'contained_action'));
    await f.click('Delete by read');
    for (let i = 0; i < 20 && !f.requests.includes('GET /items/1/remove'); i++)
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(f.requests.includes('GET /items/1/remove'), 'the workspace trusts this label');
  } finally {
    await f.close();
  }
});

// A fake VS Code approval broker (see approval-retry.test.ts): requests stay pending.
async function broker() {
  const saved = [process.env.ADL_APPROVAL_URL, process.env.ADL_APPROVAL_TOKEN, process.env.ADL_APPROVAL_EPOCH];
  const requests = new Map<string, { binding: string; expires_at: number }>();
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    let id = req.url!.split('/').pop()!;
    if (req.method === 'POST') {
      const body = JSON.parse(Buffer.concat(parts).toString());
      requests.set(body.request_id, body);
      id = body.request_id;
    }
    const request = requests.get(id);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        v: 1,
        request_id: id,
        binding: request?.binding,
        status: 'pending',
        expires_at: request?.expires_at,
      }),
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.ADL_APPROVAL_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.ADL_APPROVAL_TOKEN = randomBytes(32).toString('base64url');
  process.env.ADL_APPROVAL_EPOCH = randomUUID();
  return async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [key, value] of [
      ['ADL_APPROVAL_URL', saved[0]],
      ['ADL_APPROVAL_TOKEN', saved[1]],
      ['ADL_APPROVAL_EPOCH', saved[2]],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test('ask: Delete still asks a human before anything runs', { timeout: 60000 }, async () => {
  const stop = await broker();
  const f = await fixture('ask');
  try {
    await assert.rejects(
      f.click('Delete Buy milk'),
      (error: unknown) => error instanceof AdlError && error.code === 'E_APPROVAL_REQUIRED' && !!error.requestId,
    );
    assert.deepEqual(await f.fires(), []);
  } finally {
    await f.close();
    await stop();
  }
});
