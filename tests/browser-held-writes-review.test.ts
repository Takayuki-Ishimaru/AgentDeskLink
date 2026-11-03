import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { Page } from 'playwright';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import { isWriteBlock } from '../src/network-warnings.js';
import {
  AdlError,
  HeldWritesError,
  type Action,
  type ActionAuthorization,
  type AdapterActResult,
  type AdapterSession,
  type NetworkWarning,
  type Target,
} from '../src/types.js';
import { stubBroker } from './approval-broker-stub.js';

// Regression tests from the independent review of the held-write / warnings / settle changes (4e7b2e1..6f7fe79): each states the
// invariant a finding broke (F1-F8) and runs against real Chromium. Adapter-level tests drive BrowserSession directly (as
// tests/browser-held-writes-adapter.test.ts), engine-level tests go through the Engine with the broker stub (as
// tests/browser-held-writes.test.ts). The tests that never failed are the boundaries the review confirmed: they stay as guards.

for (const key of ['ADL_APPROVAL_URL', 'ADL_APPROVAL_TOKEN', 'ADL_APPROVAL_EPOCH']) delete process.env[key];

type Recorded = { method: string; url: string; contentType: string; contentLength: string; body: string };

const PAGE = (api: string) => `<!doctype html><title>Probe</title>
<p id="status" role="status">idle</p><p id="tick">0</p>
<button onclick="saveJson()">Save JSON</button>
<button onclick="preflight()">Preflight</button>
<button onclick="preflightLocal()">Preflight local</button>
<button onclick="saveBlob()">Save blob</button>
<button onclick="saveStream()">Save stream</button>
<button onclick="saveSync()">Save sync</button>
<button onclick="saveSyncLater()">Save sync later</button>
<button onclick="busy()">Busy</button>
<button onclick="savePair()">Save pair</button>
<button onclick="saveOverride()">Save override</button>
<button onclick="postBare()">Post bare</button>
<button onclick="postTyped()">Post typed</button>
<button onclick="download()">Download</button>
<button onclick="push()">Push</button>
<button onclick="frameWrite()">Frame write</button>
<button onclick="keepAndLeave()">Keep and leave</button>
<button onclick="save307()">Save 307</button>
<iframe id="child" srcdoc="<script>addEventListener('message',()=>fetch('/api/frame',{method:'POST',body:'f'}).catch(()=>{}))</script>"></iframe>
<script>
function download(){location.href='/dl'}
function push(){history.pushState({},'','/pushed');status('pushed')}
function frameWrite(){status('frame writing');document.getElementById('child').contentWindow.postMessage('go','*')}
function keepAndLeave(){fetch('/api/keep',{method:'POST',body:'k',keepalive:true}).catch(()=>{});setTimeout(()=>{location.href='/other'},50)}
function save307(){status('saving 307');fetch('/api/r307',{method:'POST',body:'r'}).then(...done('307 saved','307 failed'))}
</script>
<script>
const status=t=>{document.getElementById('status').textContent=t};
const done=(ok,bad)=>[()=>status(ok),()=>status(bad)];
function saveJson(){status('saving');fetch('/api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Buy milk'})}).then(...done('saved','could not save'))}
function preflight(){status('preflighting');fetch('${api}/api/pre',{method:'POST',headers:{'content-type':'application/json','x-adl-probe':'1'},body:'{"a":1}'}).then(...done('pre saved','pre failed'))}
function preflightLocal(){status('preflighting');fetch('/api/pre',{method:'DELETE',headers:{'x-adl-probe':'1'}}).then(...done('pre saved','pre failed'))}
function saveBlob(){status('saving blob');fetch('/api/blob',{method:'POST',body:new Blob(['{"filter":"all"}'],{type:'application/json'})}).then(...done('blob saved','blob failed'))}
function saveStream(){status('saving stream');const s=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"x":1}'));c.close()}});fetch('/api/stream',{method:'POST',body:s,duplex:'half',headers:{'content-type':'application/json'}}).then(...done('stream saved','stream failed'))}
function saveSync(){status('sync start');const x=new XMLHttpRequest();x.open('POST','/api/sync',false);try{x.send('s');status('sync done '+x.status)}catch(e){status('sync threw')}}
function saveSyncLater(){status('sync later');const end=Date.now()+600;const t=setInterval(()=>{document.getElementById('tick').textContent=String(Date.now());if(Date.now()>end)clearInterval(t)},10);setTimeout(()=>{try{const x=new XMLHttpRequest();x.open('POST','/api/synclater',false);x.send('s');status('sync later done '+x.status)}catch(e){status('sync later threw')}},120)}
function busy(){const end=Date.now()+350;const t=setInterval(()=>{document.getElementById('tick').textContent=String(Date.now());if(Date.now()>end)clearInterval(t)},10)}
function savePair(){status('saving pair');const c=new AbortController();window.cancelA=()=>c.abort();Promise.all([fetch('/api/a',{method:'POST',body:'a',signal:c.signal}),fetch('/api/b',{method:'POST',body:'b'})]).then(...done('pair saved','pair failed'))}
function postBare(){status('posting bare');fetch('/api/bare',{method:'POST'}).then(...done('bare saved','bare failed'))}
function postTyped(){status('posting typed');fetch('/api/typed',{method:'POST',headers:{'content-type':'application/json'}}).then(...done('typed saved','typed failed'))}
function saveOverride(){status('saving override');fetch('/api/override',{method:'POST',headers:{'x-http-method-override':'DELETE','content-type':'application/json'},body:'{}'}).then(...done('override saved','override failed'))}
</script>`;

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** Serves the page for GET / and records every other request, OPTIONS included (nothing is answered 204 before being recorded). */
function recorder(requests: Recorded[], html?: () => string) {
  return createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/dl') {
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', 'attachment; filename="x.bin"');
      res.end('binary');
      return;
    }
    if (req.method === 'GET' && !url.startsWith('/api/')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(url === '/other' ? '<!doctype html><title>Other</title><button>Elsewhere</button>' : html?.());
      return;
    }
    if (url === '/api/r307') {
      requests.push({
        method: req.method ?? '',
        url,
        contentType: '',
        contentLength: '',
        body: Buffer.concat(parts).toString('utf8'),
      });
      res.statusCode = 307;
      res.setHeader('location', '/api/elsewhere');
      res.end();
      return;
    }
    requests.push({
      method: req.method ?? '',
      url,
      contentType: String(req.headers['content-type'] ?? ''),
      contentLength: String(req.headers['content-length'] ?? ''),
      body: Buffer.concat(parts).toString('utf8'),
    });
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    res.setHeader('access-control-allow-methods', '*');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
}

type Options = {
  mode?: 'standard' | 'ask' | 'read_only';
  holding?: boolean;
  grantApi?: boolean;
  actionTimeoutMs?: number;
};

async function adapterFixture(options: Options = {}) {
  const requests: Recorded[] = [];
  const apiRequests: Recorded[] = [];
  const api = recorder(apiRequests);
  const apiOrigin = await listen(api);
  const app = recorder(requests, () => PAGE(apiOrigin));
  const origin = await listen(app);
  const policy = parsePolicy({
    operationMode: options.mode ?? 'ask',
    allowedOrigins: options.grantApi ? [origin, apiOrigin] : [origin],
    allowLoopback: true,
    actionTimeoutMs: options.actionTimeoutMs ?? 5000,
    browserTargets: [{ id: 'p', label: 'Fixture', url: origin + '/', classification: 'PUBLIC' }],
  });
  const adapter = new BrowserAdapter(policy, (url, purpose) => assertUrlAllowed(url, policy, undefined, purpose));
  const target: Target = {
    target_id: 't',
    application_id: 'p',
    label: 'Fixture',
    surface: 'browser',
    policy_class: 'PUBLIC',
    capabilities: [],
  };
  const session: AdapterSession = await adapter.open(target, 'strict_isolated', new AbortController().signal);
  if (options.holding !== false) session.setWriteHolding!(true);
  const pageOf = () => (session as unknown as { pageValue: Page }).pageValue;
  const status = () => pageOf().evaluate(() => document.getElementById('status')?.textContent ?? '');
  const act = async (action: Action, auth: Partial<ActionAuthorization> = {}): Promise<void | AdapterActResult> => {
    const signal = new AbortController().signal;
    const prepared = action.element_id ? await session.prepareAction!(action, signal) : undefined;
    return session.act(action, signal, undefined, {
      holdWrites: true,
      ...(prepared ? { normalOperations: true, approvalProof: prepared.proof, approved: false } : {}),
      ...auth,
    });
  };
  const click = async (name: string) => {
    const snapshot = await session.snapshot();
    const element = snapshot.elements.find(e => e.name === name);
    assert.ok(element, name);
    return act({ action: 'click', element_id: element.id });
  };
  return {
    session,
    origin,
    apiOrigin,
    requests,
    apiRequests,
    status,
    click,
    page: pageOf,
    close: async () => {
      await adapter.close();
      for (const server of [app, api]) {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    },
  };
}
type AdapterFixture = Awaited<ReturnType<typeof adapterFixture>>;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}
const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    value => ({ value }) as { value: T; error?: undefined },
    (error: unknown) => ({ error }) as { value?: undefined; error: unknown },
  );
const blocksOf = (result: void | AdapterActResult): NetworkWarning[] => (result ? (result.blocks ?? []) : []);
async function heldByAdapter(f: AdapterFixture, name: string): Promise<HeldWritesError> {
  const result = await outcome(f.click(name));
  assert.ok(result.error instanceof HeldWritesError, `${name} should hold its write, got ${JSON.stringify(result)}`);
  return result.error;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Probe 1: CORS preflight. A cross-origin JSON POST with a custom header makes Chromium send an OPTIONS preflight first. Invariant
// (A.9): no non-GET/HEAD request leaves the browser without approval; the route must see the OPTIONS and block it (or at least vet it).
// If the api server records an OPTIONS while the POST is still held (nothing approved), the preflight bypassed the route entirely:
// no DNS pinning, no guard, no block code, and the agent never learns of it.
// ---------------------------------------------------------------------------------------------------------------------------------
test(
  'boundary: ask, granted origin: the CORS preflight OPTIONS does not leave the browser while the POST is held',
  { timeout: 60000 },
  async () => {
    const f = await adapterFixture({ grantApi: true });
    try {
      const error = await heldByAdapter(f, 'Preflight');
      assert.equal(error.hold.requests[0]!.method, 'POST');
      await sleep(300);
      const options = f.apiRequests.filter(r => r.method === 'OPTIONS');
      assert.deepEqual(options, [], `an OPTIONS preflight reached the api server unvetted: ${JSON.stringify(options)}`);
      await f.session.abortHeldWrites!(error.hold.id, 'denied');
    } finally {
      await f.close();
    }
  },
);

test('boundary: standard, ungranted origin: no OPTIONS preflight leaves the browser', { timeout: 60000 }, async () => {
  const f = await adapterFixture({ mode: 'standard', holding: false, grantApi: false });
  try {
    const result = await f.click('Preflight');
    await until(async () => (await f.status()) === 'pre failed', 'the page to see the refusal');
    await sleep(300);
    const options = f.apiRequests.filter(r => r.method === 'OPTIONS');
    assert.deepEqual(options, [], `an OPTIONS preflight reached the ungranted api server: ${JSON.stringify(options)}`);
    assert.deepEqual(f.apiRequests, []);
    assert.ok(blocksOf(result).length > 0, 'the block is reported');
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Probe 2: body fidelity. What the human sees (details, body_length, body_sha256) and what is released must be the bytes Chromium
// would have sent. A Blob body or a streaming body may not be exposed by postDataBuffer(): then the request would be described as
// "(no body)" and released without its body (or with a stale content-length), which is neither what the page sent nor what a server
// expects.
// ---------------------------------------------------------------------------------------------------------------------------------
test('boundary: a Blob body is described and released with its exact bytes', { timeout: 60000 }, async () => {
  const f = await adapterFixture();
  try {
    const error = await heldByAdapter(f, 'Save blob');
    const [request] = error.hold.requests;
    assert.equal(request!.body_length, 16, `described body: ${JSON.stringify(request)}`);
    assert.ok(request!.details.includes('"filter": "all"'), request!.details.join('\n'));
    await f.session.releaseHeldWrites!(error.hold.id, Date.now() + 30000);
    await until(() => f.requests.length > 0, 'the released request');
    assert.equal(f.requests[0]!.body, '{"filter":"all"}');
    await until(async () => (await f.status()) === 'blob saved', 'the page to see the answer');
  } finally {
    await f.close();
  }
});

// F2: Chromium exposes no bytes for a streamed (ReadableStream) upload. Such a request must never be described as bodiless and released
// empty: a request that describes a body in its headers but has none here is refused as not approvable, and nothing is sent.
test(
  'F2: a streamed body is refused as not approvable, never described as "(no body)" nor released empty',
  { timeout: 60000 },
  async () => {
    const f = await adapterFixture();
    try {
      const result = await outcome(f.click('Save stream'));
      assert.ok(!(result.error instanceof HeldWritesError), 'a streamed body must not be held');
      assert.ok(!result.error, String(result.error));
      await until(async () => (await f.status()) === 'stream failed', 'the page to see the refusal');
      const blocks = blocksOf(result.value);
      assert.ok(
        blocks.some(w => w.code === 'request_not_approvable' && w.method === 'POST' && w.resource_type === 'fetch'),
        JSON.stringify(blocks),
      );
      assert.ok(blocks.some(isWriteBlock));
      await sleep(300);
      assert.deepEqual(f.requests, [], 'a refused request sends nothing');
    } finally {
      await f.close();
    }
  },
);

test(
  'F2: a write with a content-type but no readable body is refused; a bare write without either is still held as "(no body)"',
  { timeout: 60000 },
  async () => {
    const f = await adapterFixture();
    try {
      const typed = await outcome(f.click('Post typed'));
      assert.ok(
        !(typed.error instanceof HeldWritesError),
        'a typed request without bytes is not described as bodiless',
      );
      assert.ok(!typed.error, String(typed.error));
      assert.ok(
        blocksOf(typed.value).some(w => w.code === 'request_not_approvable' && w.method === 'POST'),
        JSON.stringify(blocksOf(typed.value)),
      );
      await sleep(300);
      assert.equal(f.requests.length, 0, 'nothing was sent for the typed request');
      const bare = await heldByAdapter(f, 'Post bare');
      assert.equal(bare.hold.requests[0]!.body_length, 0);
      assert.ok(bare.hold.requests[0]!.details.includes('(no body)'), bare.hold.requests[0]!.details.join('\n'));
      await f.session.releaseHeldWrites!(bare.hold.id, Date.now() + 30000);
      await until(() => f.requests.length > 0, 'the released request');
      assert.equal(f.requests[0]!.body, '');
    } finally {
      await f.close();
    }
  },
);

// Optional: a header a server may read as the real method is shown to the human next to the request.
test('a method-override header is part of what the human sees', { timeout: 60000 }, async () => {
  const f = await adapterFixture();
  try {
    const error = await heldByAdapter(f, 'Save override');
    const lines = error.hold.requests[0]!.details;
    assert.ok(
      lines.includes('Method override header x-http-method-override: "DELETE"'),
      `the override is shown: ${lines.join(' | ')}`,
    );
    await f.session.abortHeldWrites!(error.hold.id, 'denied');
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// F1: a synchronous XHR write. The page's main thread blocks inside the request while the route holds it, so the click never returns.
// A request the page waits for synchronously cannot be shown to a human: it is aborted after a short grace as not approvable, the
// handler goes on, and the action completes with write_blocked and the session alive (not as a timeout that destroys the session).
test(
  'F1: a synchronous XHR POST during the window is blocked as not approvable and the action completes',
  { timeout: 60000 },
  async () => {
    const f = await adapterFixture({ actionTimeoutMs: 4000 });
    try {
      const started = Date.now();
      const result = await outcome(f.click('Save sync'));
      const elapsed = Date.now() - started;
      if (result.error) {
        const error = result.error as AdlError;
        assert.fail(
          `the action failed with ${error.code}/${error.reason ?? ''} mayHaveExecuted=${String(error.mayHaveExecuted)} after ${elapsed} ms`,
        );
      }
      assert.ok(elapsed < 3000, `the grace is short: ${elapsed} ms`);
      const blocks = blocksOf(result.value);
      assert.ok(
        blocks.some(w => w.code === 'request_not_approvable' && w.method === 'POST' && w.resource_type === 'xhr'),
        JSON.stringify(blocks),
      );
      assert.ok(blocks.some(isWriteBlock), 'write_blocked');
      await until(async () => (await f.status()) === 'sync threw', 'the page to continue after the refusal');
      const snapshot = await f.session.snapshot();
      assert.ok(snapshot.elements.length > 0, 'the session survives');
      assert.deepEqual(f.requests, [], 'nothing was sent');
      // The window is over: an ordinary asynchronous write after it is held again as usual.
      const error = await heldByAdapter(f, 'Save JSON');
      await f.session.abortHeldWrites!(error.hold.id, 'denied');
    } finally {
      await f.close();
    }
  },
);

test(
  'F1: a synchronous XHR the page sends after the dispatch returned (while the action settles) is blocked as well',
  { timeout: 60000 },
  async () => {
    const f = await adapterFixture({ actionTimeoutMs: 4000 });
    try {
      const started = Date.now();
      const result = await outcome(f.click('Save sync later'));
      if (result.error) {
        const error = result.error as AdlError;
        assert.fail(
          `the action failed with ${error.code}/${error.reason ?? ''} mayHaveExecuted=${String(error.mayHaveExecuted)} after ${Date.now() - started} ms`,
        );
      }
      const blocks = blocksOf(result.value);
      assert.ok(
        blocks.some(w => w.code === 'request_not_approvable' && w.method === 'POST' && w.resource_type === 'xhr'),
        JSON.stringify(blocks),
      );
      await until(async () => (await f.status()) === 'sync later threw', 'the page to continue after the refusal');
      assert.equal((await f.session.snapshot()).elements.length > 0, true, 'the session survives');
      assert.equal(f.requests.length, 0, 'nothing was sent');
    } finally {
      await f.close();
    }
  },
);

// ---------------------------------------------------------------------------------------------------------------------------------
// F5: attribution of an aborted hold. The denial of set A arrives while a later action B's window is open; its block
// (approval_denied POST fetch) is recorded into B's window, so B's result says write_blocked (a write B never sent) and the
// observation never reports it.
// ---------------------------------------------------------------------------------------------------------------------------------
test(
  'F5: the denial of an earlier hold is not reported as a write blocked by the running action',
  { timeout: 60000 },
  async () => {
    const f = await adapterFixture();
    try {
      const error = await heldByAdapter(f, 'Save JSON');
      // Busy mutates the DOM every 10 ms for 350 ms, so its window stays open until SETTLE_MAX_MS; the denial arrives 40 ms after its dispatch.
      const snapshot = await f.session.snapshot();
      const element = snapshot.elements.find(e => e.name === 'Busy')!;
      const signal = new AbortController().signal;
      const prepared = await f.session.prepareAction!({ action: 'click', element_id: element.id }, signal);
      let dispatched!: () => void;
      const dispatchedAt = new Promise<void>(resolve => {
        dispatched = resolve;
      });
      const busy = f.session.act({ action: 'click', element_id: element.id }, signal, () => dispatched(), {
        holdWrites: true,
        normalOperations: true,
        approvalProof: prepared.proof,
        approved: false,
      });
      await dispatchedAt;
      await sleep(40);
      await f.session.abortHeldWrites!(error.hold.id, 'denied');
      const result = await busy;
      await until(async () => (await f.status()) === 'could not save', 'the page to see the denial');
      const blocks = blocksOf(result);
      assert.deepEqual(
        blocks.filter(isWriteBlock),
        [],
        `the Busy action (which sent nothing) carries a write block: ${JSON.stringify(blocks)}`,
      );
      const warnings = (await f.session.snapshot()).warnings ?? [];
      assert.ok(
        warnings.some(w => w.code === 'approval_denied'),
        `the observation should report the denial once: ${JSON.stringify(warnings)}`,
      );
    } finally {
      await f.close();
    }
  },
);

// ---------------------------------------------------------------------------------------------------------------------------------
// F3: partial release of an approved set. The human approves a set of two requests; the page abandons one before the release
// (its own timeout). "Every request the page still waits for goes out together, or none does": the design (A.3) fails the whole set
// closed when it cannot be sent completely, so a release must not send a subset of what was approved.
// ---------------------------------------------------------------------------------------------------------------------------------
test('F3: a set the page partly abandoned ends whole and is never released partially', { timeout: 60000 }, async () => {
  const f = await adapterFixture();
  try {
    const error = await heldByAdapter(f, 'Save pair');
    assert.equal(error.hold.requests.length, 2);
    await f.page().evaluate(() => (window as unknown as { cancelA: () => void }).cancelA());
    await until(() => !f.session.heldWritesAlive!(error.hold.id), 'the set to end (the engine withdraws the approval)');
    await assert.rejects(f.session.releaseHeldWrites!(error.hold.id, Date.now() + 30000), (e: unknown) => {
      return e instanceof AdlError && e.code === 'E_STALE_STATE';
    });
    await sleep(800);
    assert.deepEqual(f.requests, [], 'neither request of the approved set was sent');
    await until(async () => (await f.status()) === 'pair failed', 'the page to see the refusal of the rest');
    assert.equal(f.session.heldWriteOutcome!(error.hold.id), undefined, 'nothing was released');
  } finally {
    await f.close();
  }
});

test(
  'F3: a set whose request was abandoned before the hand-over is never handed over, and the rest is blocked',
  { timeout: 60000 },
  async () => {
    const f = await adapterFixture();
    try {
      // Pair sends two writes, the page then aborts the first one while the action's window is still open (a busy page keeps it open).
      await f.page().evaluate(() => {
        const w = window as unknown as { savePair: () => void; cancelA: () => void };
        const original = w.savePair;
        w.savePair = () => {
          original();
          setTimeout(() => w.cancelA(), 30);
        };
      });
      const result = await outcome(f.click('Save pair'));
      assert.ok(!(result.error instanceof HeldWritesError), 'the incomplete set is not handed to a human');
      assert.ok(!result.error, String(result.error));
      await sleep(500);
      assert.deepEqual(f.requests, []);
      assert.equal(f.session.heldWritesAlive!('unknown'), false);
    } finally {
      await f.close();
    }
  },
);

// ---------------------------------------------------------------------------------------------------------------------------------
// Probe 6: a same-origin DELETE with a custom header also preflights (OPTIONS to the same origin). Same invariant as probe 1.
// ---------------------------------------------------------------------------------------------------------------------------------
test('boundary: ask, same origin: a preflighted DELETE leaves no OPTIONS while held', { timeout: 60000 }, async () => {
  const f = await adapterFixture();
  try {
    const result = await outcome(f.click('Preflight local'));
    await sleep(300);
    const options = f.requests.filter(r => r.method === 'OPTIONS');
    assert.deepEqual(options, [], `an OPTIONS preflight reached the server unvetted: ${JSON.stringify(options)}`);
    if (result.error instanceof HeldWritesError) await f.session.abortHeldWrites!(result.error.hold.id, 'denied');
  } finally {
    await f.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Guard (probe 9): a stale navigationPending. A main-frame navigation that becomes a download ends with requestfinished (no framenavigated,
// no requestfailed), so navigationPending stays set. The next same-document navigation (pushState by an SPA router) then looks like a
// document replacement: every held write is aborted silently (DOCUMENT_REPLACED records no block) and the unreported blocks of the
// still-current document are discarded.
// ---------------------------------------------------------------------------------------------------------------------------------
test(
  'boundary: a pushState after a download navigation does not silently abort a held write',
  { timeout: 60000 },
  async () => {
    const f = await adapterFixture();
    try {
      const dl = await outcome(f.click('Download'));
      assert.ok(!dl.error, `the download click failed: ${String(dl.error)}`);
      await sleep(300);
      const error = await heldByAdapter(f, 'Save JSON');
      assert.equal(f.session.heldWritesAlive!(error.hold.id), true);
      const push = await outcome(f.click('Push'));
      assert.ok(!push.error, String(push.error));
      await until(async () => (await f.status()) === 'pushed', 'the pushState');
      await sleep(300);
      const warnings = (await f.session.snapshot()).warnings ?? [];
      assert.equal(
        f.session.heldWritesAlive!(error.hold.id),
        true,
        `the hold died on a same-document navigation; page status: ${await f.status()}; warnings: ${JSON.stringify(warnings)}`,
      );
      await f.session.abortHeldWrites!(error.hold.id, 'denied');
    } finally {
      await f.close();
    }
  },
);

// ---------------------------------------------------------------------------------------------------------------------------------
// Guards (probes 10-12): boundaries that must hold (positive checks): a sub-frame write is never held nor sent; a keepalive write followed by a
// navigation never leaves; a released request answered with 307 is not replayed to the new location.
// ---------------------------------------------------------------------------------------------------------------------------------
test('boundary: a sub-frame write inside the window is blocked, never held or sent', { timeout: 60000 }, async () => {
  const f = await adapterFixture();
  try {
    const result = await outcome(f.click('Frame write'));
    assert.ok(!(result.error instanceof HeldWritesError), 'a sub-frame write must not be held');
    assert.ok(!result.error, String(result.error));
    await sleep(500);
    assert.deepEqual(f.requests, []);
    const blocks = [...blocksOf(result.value), ...((await f.session.snapshot()).warnings ?? [])];
    assert.ok(
      blocks.some(w => w.method === 'POST'),
      `the block is reported: ${JSON.stringify(blocks)}`,
    );
  } finally {
    await f.close();
  }
});

test('F4: a keepalive write followed by a navigation never leaves', { timeout: 60000 }, async () => {
  const f = await adapterFixture();
  try {
    const started = Date.now();
    const events: string[] = [];
    const at = () => `+${Date.now() - started} ms`;
    const page = f.page();
    page.on('request', r =>
      events.push(`request ${r.method()} ${new URL(r.url()).pathname} nav=${String(r.isNavigationRequest())} ${at()}`),
    );
    page.on('requestfailed', r =>
      events.push(`requestfailed ${new URL(r.url()).pathname} ${r.failure()?.errorText} ${at()}`),
    );
    page.on('requestfinished', r => events.push(`requestfinished ${new URL(r.url()).pathname} ${at()}`));
    page.on('framenavigated', fr =>
      events.push(`framenavigated ${new URL(fr.url()).pathname} main=${String(fr === page.mainFrame())} ${at()}`),
    );
    const result = await outcome(f.click('Keep and leave'));
    await sleep(800);
    const state = `page is now at ${new URL(page.url()).pathname}; events: ${events.join(' | ')}`;
    if (result.error instanceof HeldWritesError) {
      const alive = f.session.heldWritesAlive!(result.error.hold.id);
      await f.session.releaseHeldWrites!(result.error.hold.id, Date.now() + 30000).catch(() => undefined);
      await sleep(800);
      assert.fail(
        `the keepalive write of the replaced document was held (alive after the action: ${String(alive)}); released, the server received ${JSON.stringify(f.requests)}; ${state}`,
      );
    }
    assert.ok(!result.error, `${String(result.error)}; ${state}`);
    assert.deepEqual(f.requests, [], state);
  } finally {
    await f.close();
  }
});

test(
  'boundary: a released write answered with 307 is not replayed to the redirect target',
  { timeout: 60000 },
  async () => {
    const f = await adapterFixture();
    try {
      const error = await heldByAdapter(f, 'Save 307');
      await f.session.releaseHeldWrites!(error.hold.id, Date.now() + 30000);
      await until(() => f.requests.length > 0, 'the released request');
      await sleep(500);
      assert.deepEqual(
        f.requests.map(r => `${r.method} ${r.url}`),
        ['POST /api/r307'],
      );
      await until(async () => (await f.status()) === '307 failed', 'the page to see the refusal');
    } finally {
      await f.close();
    }
  },
);

// ---------------------------------------------------------------------------------------------------------------------------------
// Engine-level fixture
// ---------------------------------------------------------------------------------------------------------------------------------
type EngineOptions = {
  sessionTtlMs?: number;
  guard?: (url: string, purpose: string) => void;
};
async function engineFixture(options: EngineOptions = {}) {
  const requests: Recorded[] = [];
  const apiRequests: Recorded[] = [];
  const api = recorder(apiRequests);
  const apiOrigin = await listen(api);
  const app = recorder(requests, () => PAGE(apiOrigin));
  const origin = await listen(app);
  const policy = parsePolicy({
    operationMode: 'ask',
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 10000,
    ...(options.sessionTtlMs ? { sessionTtlMs: options.sessionTtlMs } : {}),
    browserTargets: [{ id: 'p', label: 'Fixture', url: origin + '/', classification: 'PUBLIC' }],
  });
  const adapter = new BrowserAdapter(policy, (url, purpose) => {
    options.guard?.(url, purpose ?? 'navigation');
    return assertUrlAllowed(url, policy, undefined, purpose);
  });
  const engine = new Engine(policy, { browser: adapter });
  const opened = await engine.open((await engine.listTargets()).targets[0]!.target_id);
  const id = opened.session_id;
  const observe = () => engine.observe(id, { token_budget: 8000 });
  const click = async (name: string) => {
    const observed = await observe();
    const element = observed.elements!.find(x => x.name === name);
    assert.ok(element, `${name} in ${observed.elements!.map(x => x.name).join(' | ')}`);
    return engine.act(id, { action: 'click', element_id: element.id }, observed.revision);
  };
  return {
    engine,
    id,
    origin,
    requests,
    observe,
    click,
    rows: async (requestId?: string, waitMs = 0) => (await engine.approvals(requestId, waitMs)).requests,
    close: async () => {
      try {
        await engine.shutdown();
      } finally {
        for (const server of [app, api]) {
          server.closeAllConnections();
          await new Promise<void>(resolve => server.close(() => resolve()));
        }
      }
    },
  };
}
type Broker = Awaited<ReturnType<typeof stubBroker>>;
async function withEngine(
  options: EngineOptions,
  body: (f: Awaited<ReturnType<typeof engineFixture>>, broker: Broker) => Promise<void>,
) {
  const broker = await stubBroker();
  try {
    const f = await engineFixture(options);
    try {
      await body(f, broker);
    } finally {
      await f.close();
    }
  } finally {
    await broker.close();
  }
}
function heldId(error: unknown, what: string): string {
  assert.ok(error instanceof AdlError, `${what} should have been held, got ${String(error)}`);
  assert.equal(error.reason, 'request_requires_approval', what);
  return error.requestId!;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// F6: sent:true means "released and answered" (ERROR_REASON_MESSAGES.request_requires_approval). When the released request is
// refused at dispatch (guard, DNS, expiry re-check) nothing leaves, but the engine has already recorded sent:true.
// ---------------------------------------------------------------------------------------------------------------------------------
test('F6: a released request refused at dispatch is not reported as sent', { timeout: 60000 }, () =>
  withEngine(
    {
      guard: (url, purpose) => {
        if (purpose === 'resource' && url.endsWith('/api/tasks'))
          throw new AdlError('E_POLICY_DENIED', 'origin_not_allowed');
      },
    },
    async (f, broker) => {
      const requestId = heldId(await outcome(f.click('Save JSON')).then(r => r.error), 'Save JSON');
      broker.byId(requestId)!.status = 'approved';
      const [row] = await f.rows(requestId, 30000);
      await sleep(500);
      assert.deepEqual(f.requests, [], 'the guard refused it: nothing left');
      assert.notEqual(
        row!.sent,
        true,
        `reported as sent although the request was refused at dispatch: ${JSON.stringify(row)}`,
      );
    },
  ),
);

// ---------------------------------------------------------------------------------------------------------------------------------
// F8: "A second identical adl_act while pending -> the same request_id, nothing dispatched" (A.7). The short circuit compares
// requestKeyFor(), which includes every action field but include_diff/timeout_ms: the same click with an expected_target (a field that
// changes nothing about what is dispatched) is dispatched again, so the page's handler runs a second time while the first write is
// still held.
// ---------------------------------------------------------------------------------------------------------------------------------
test(
  'F8: the same click with expected_target while its write is held is not dispatched again',
  { timeout: 60000 },
  () =>
    withEngine({}, async (f, broker) => {
      const observed = await f.observe();
      const element = observed.elements!.find(x => x.name === 'Save JSON')!;
      const first = await outcome(f.engine.act(f.id, { action: 'click', element_id: element.id }, observed.revision));
      const requestId = heldId(first.error, 'Save JSON');
      const page = (f.engine as unknown as { sessions: Map<string, { adapter: { pageValue: Page } }> }).sessions.get(
        f.id,
      )!.adapter.pageValue;
      const handlerRuns = () => page.evaluate(() => (window as unknown as { runs?: number }).runs ?? 0);
      await page.evaluate(() => {
        const w = window as unknown as { runs: number; saveJson: () => void };
        w.runs = 1;
        const original = w.saveJson;
        w.saveJson = () => {
          w.runs++;
          original();
        };
      });
      const again = await f.observe();
      const second = await outcome(
        f.engine.act(
          f.id,
          { action: 'click', element_id: element.id, expected_target: { role: 'button', name: 'Save JSON' } },
          again.revision,
        ),
      );
      const runs = await handlerRuns();
      assert.equal(runs, 1, `the handler ran ${runs} times; second act: ${JSON.stringify(second)}`);
      assert.equal((second.error as AdlError | undefined)?.requestId, requestId, 'the same request');
      assert.equal(broker.state.posts, 1);
    }),
);

// ---------------------------------------------------------------------------------------------------------------------------------
// F7: the session must outlive the approval (A.6.4 raises s.expires to expires_at + 30 s). Any later access through get()
// resets s.expires to now + sessionTtlMs, so with a short TTL the reaper destroys the session, and with it the hold, while the
// human is still looking at the dialog.
// ---------------------------------------------------------------------------------------------------------------------------------
test(
  'F7: an observation after the hold does not let the session (and the hold) expire before the approval',
  { timeout: 60000 },
  () =>
    withEngine({ sessionTtlMs: 2000 }, async (f, broker) => {
      const requestId = heldId(await outcome(f.click('Save JSON')).then(r => r.error), 'Save JSON');
      await f.observe();
      await sleep(3500);
      const [row] = await f.rows(requestId);
      assert.equal(row!.status, 'pending', `the hold ended before the human decided: ${JSON.stringify(row)}`);
      assert.equal(broker.byId(requestId)!.status, 'pending');
      broker.byId(requestId)!.status = 'approved';
      const [after] = await f.rows(requestId, 30000);
      assert.equal(after?.sent, true, JSON.stringify(after));
    }),
);

test('F7: once the hold has ended the session expires by its idle time-to-live again', { timeout: 60000 }, () =>
  withEngine({ sessionTtlMs: 2000 }, async (f, broker) => {
    const requestId = heldId(await outcome(f.click('Save JSON')).then(r => r.error), 'Save JSON');
    await f.observe();
    broker.byId(requestId)!.status = 'denied';
    const [row] = await f.rows(requestId, 30000);
    assert.equal(row!.status, 'denied');
    assert.equal(row!.sent, false);
    await sleep(4500);
    const after = await outcome(f.observe());
    assert.ok(
      after.error instanceof AdlError && after.error.code === 'E_TARGET_NOT_FOUND',
      `the session outlived the request it was kept for: ${JSON.stringify(after.error ?? 'observed')}`,
    );
  }),
);

test('F6: a set of which one request is refused at dispatch is not reported as sent', { timeout: 60000 }, () =>
  withEngine(
    {
      guard: (url, purpose) => {
        if (purpose === 'resource' && url.endsWith('/api/b'))
          throw new AdlError('E_POLICY_DENIED', 'origin_not_allowed');
      },
    },
    async (f, broker) => {
      const requestId = heldId(await outcome(f.click('Save pair')).then(r => r.error), 'Save pair');
      broker.byId(requestId)!.status = 'approved';
      const [row] = await f.rows(requestId, 30000);
      await sleep(500);
      assert.equal(row!.status, 'consumed');
      assert.equal(
        row!.sent,
        false,
        `a set is sent whole or not at all, and one request never left: ${JSON.stringify(row)}`,
      );
    },
  ),
);
