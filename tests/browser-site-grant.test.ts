import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { Page } from 'playwright';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import { AdlError, safeError, type AdapterSession, type NetworkWarning } from '../src/types.js';
import { stubBroker } from './approval-broker-stub.js';

// Ask mode with a standing site grant (the third modal choice): the broker approves eligible requests at POST time, the Engine consumes and releases
// held fetch/XHR writes inside the same adl_act (ok:true with an approval object) and tells the agent that a form submission may be retried at once
// (approved:true). End to end: Engine + BrowserAdapter + real Chromium + the approval broker stub simulating the grant. Credentials, money-like
// controls and URLs, other origins and everything the adapter never holds keep their per-request behaviour.

// Without these the cases would pick up a real broker from the environment. stubBroker() restores what it found (nothing).
for (const key of ['ADL_APPROVAL_URL', 'ADL_APPROVAL_TOKEN', 'ADL_APPROVAL_EPOCH']) delete process.env[key];

type Recorded = { method: string; url: string; contentType: string; body: string };
type Broker = Awaited<ReturnType<typeof stubBroker>>;
type ActResult = {
  ok: boolean;
  revision: number;
  write_blocked?: boolean;
  network_blocked?: boolean;
  warnings?: NetworkWarning[];
  approval?: { request_id: string; status: string; sent: boolean; granted: string; response_status?: number };
  observation?: { changes?: { element?: { name?: string } }[] };
};

const SPA = (api: string, other: string) => `<!doctype html><title>Notes</title>
<p id="status" role="status">idle</p><ul id="list"></ul>
<label><input type="checkbox" onchange="toggle(this)"> Done</label>
<button onclick="saveNote()">Save note</button>
<button onclick="saveJson()">Save JSON</button>
<button onclick="saveXhr()">Save XHR</button>
<button onclick="saveBoth()">Save both</button>
<button onclick="attach()">Attach</button>
<button onclick="later()">Save later</button>
<button onclick="saveApi()">Save to API origin</button>
<button onclick="saveElsewhere()">Save elsewhere</button>
<button onclick="purchase()">Purchase</button>
<button onclick="donate()">Donate</button>
<button onclick="count('d2');fetch('/items/1',{method:'DELETE'}).then(()=>setStatus('deleted'),()=>setStatus('delete failed'))">Delete on server</button>
<script>
window.calls={};const count=n=>{window.calls[n]=(window.calls[n]||0)+1};
const setStatus=t=>{document.getElementById('status').textContent=t};
const done=(ok,bad)=>[()=>setStatus(ok),()=>setStatus(bad)];
function saveNote(){count('saveNote');setStatus('saving');fetch('/api/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Buy milk',nonce:crypto.randomUUID()})}).then(r=>r.json()).then(()=>{const li=document.createElement('li');li.textContent='Saved: Buy milk';document.getElementById('list').append(li);setStatus('saved')},()=>setStatus('could not save'))}
function saveJson(){count('saveJson');fetch('/api/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Buy milk',password:'hunter22'})}).then(...done('saved','could not save'))}
function saveXhr(){const x=new XMLHttpRequest();x.open('PUT','/api/xhr');x.setRequestHeader('content-type','application/x-www-form-urlencoded');x.onload=()=>setStatus('xhr saved');x.onerror=()=>setStatus('xhr failed');x.send('a=b&c=d')}
function toggle(el){fetch('/api/todo/1',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({done:el.checked})}).then(()=>setStatus('toggled'),()=>setStatus('toggle failed'))}
function saveBoth(){setStatus('saving both');Promise.all([fetch('/api/a',{method:'POST',body:'a'}),fetch('/api/b',{method:'POST',body:'b'})]).then(...done('saved both','could not save both'))}
function attach(){const f=new FormData();f.append('file',new Blob(['x']),'a.txt');fetch('/api/upload',{method:'POST',body:f}).then(...done('uploaded','upload failed'))}
function later(){setTimeout(()=>fetch('/api/later',{method:'POST',body:'z'}).then(...done('later saved','later failed')),900)}
function saveApi(){fetch('${api}/api/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'cross'})}).then(...done('api saved','api failed'))}
function saveElsewhere(){fetch('${other}/api/notes',{method:'POST',body:'x'}).then(...done('elsewhere saved','elsewhere failed'))}
function purchase(){count('purchase');setStatus('ordering');fetch('/api/notes',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sku:'A-1'})}).then(...done('ordered','order failed'))}
function donate(){count('donate');fetch('/api/gifts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({amount:5})}).then(...done('thanks','gift failed'))}
</script>`;

// A button with an ordinary label whose request goes to a path that names an order.
const SHOP = `<!doctype html><title>Shop</title><p id="status" role="status">idle</p>
<button onclick="fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sku:'A-1'})}).then(()=>{document.getElementById('status').textContent='saved'})">Save</button>`;

// Real urlencoded POST forms: the profile one is ordinary, the checkout one posts to a payment path under an ordinary label.
const FORM = `<!doctype html><title>Profile</title>
<form method="post" action="/profile"><input name="name" aria-label="Name" value="Taro"><button>Save profile</button></form>
<form method="post" action="/checkout"><input name="sku" aria-label="Item" value="A-1"><button>Save item</button></form>`;

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** Serves pages for GET and records every other request with its body. */
function recorder(requests: Recorded[], pages: Record<string, () => string> = {}) {
  return createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    res.setHeader('access-control-allow-methods', '*');
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    const url = req.url ?? '/';
    const path = url.split('?')[0]!;
    if (req.method === 'GET' && pages[path]) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(pages[path]!());
      return;
    }
    requests.push({
      method: req.method ?? '',
      url,
      contentType: String(req.headers['content-type'] ?? ''),
      body: Buffer.concat(parts).toString('utf8'),
    });
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
  });
}

type Options = { grantApi?: boolean; start?: string };

async function fixture(options: Options = {}) {
  const requests: Recorded[] = [];
  const apiRequests: Recorded[] = [];
  const otherRequests: Recorded[] = [];
  const api = recorder(apiRequests);
  const other = recorder(otherRequests);
  const apiOrigin = await listen(api);
  const otherOrigin = await listen(other);
  const app = recorder(requests, {
    '/': () => SPA(apiOrigin, otherOrigin),
    '/shop': () => SHOP,
    '/form': () => FORM,
  });
  const origin = await listen(app);
  const servers = [app, api, other];
  const closeServers = async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
  let engine: Engine | undefined;
  try {
    const policy = parsePolicy({
      operationMode: 'ask',
      allowedOrigins: options.grantApi ? [origin, apiOrigin] : [origin],
      allowLoopback: true,
      actionTimeoutMs: 10000,
      browserTargets: [{ id: 'p', label: 'Fixture', url: origin + (options.start ?? '/'), classification: 'PUBLIC' }],
    });
    const adapter = new BrowserAdapter(policy, (url, purpose) => assertUrlAllowed(url, policy, undefined, purpose));
    const open = adapter.open.bind(adapter);
    let instance: AdapterSession | undefined;
    adapter.open = async (...args) => (instance = await open(...args));
    engine = new Engine(policy, { browser: adapter });
    const opened = await engine.open((await engine.listTargets()).targets[0]!.target_id);
    const e = engine;
    const id = opened.session_id;
    const pageOf = () => (instance as unknown as { pageValue: Page }).pageValue;
    const observe = (options: { since_revision?: number; token_budget?: number } = {}) =>
      e.observe(id, { token_budget: 8000, ...options });
    const target = async (name: string) => {
      const observed = await observe();
      const element = observed.elements!.find(x => x.name === name);
      assert.ok(element, `${name} in ${observed.elements!.map(x => x.name).join(' | ')}`);
      return { element, revision: observed.revision };
    };
    const click = async (name: string, extra: { include_diff?: boolean } = {}) => {
      const t = await target(name);
      return (await e.act(id, { action: 'click', element_id: t.element.id, ...extra }, t.revision)) as ActResult;
    };
    const check = async (name: string, checked: boolean) => {
      const t = await target(name);
      return (await e.act(id, { action: 'check', element_id: t.element.id, checked }, t.revision)) as ActResult;
    };
    return {
      engine: e,
      id,
      origin,
      apiOrigin,
      otherOrigin,
      requests,
      apiRequests,
      otherRequests,
      observe,
      target,
      click,
      check,
      page: pageOf,
      status: () => pageOf().evaluate(() => document.getElementById('status')?.textContent ?? ''),
      calls: () => pageOf().evaluate(() => (window as unknown as { calls: Record<string, number> }).calls),
      close: async () => {
        try {
          await e.shutdown();
        } finally {
          await closeServers();
        }
      },
    };
  } catch (error) {
    await engine?.shutdown().catch(() => undefined);
    await closeServers();
    throw error;
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Runs the body with a fixture (and the approval broker stub, which must exist before the Engine does) and closes everything. */
async function scenario(options: Options, body: (f: Fixture, broker: Broker) => Promise<void>) {
  const broker = await stubBroker();
  try {
    const f = await fixture(options);
    try {
      await body(f, broker);
    } finally {
      await f.close();
    }
  } finally {
    await broker.close();
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );
const warningsOf = (result: { warnings?: unknown[] }) => (result.warnings ?? []) as NetworkWarning[];
const only = (list: NetworkWarning[], code: string) => list.filter(w => w.code === code);
const sent = (list: readonly Recorded[]) => list.map(r => `${r.method} ${r.url}`);
// assert.deepEqual(list, []) would narrow the list to never[].
const sentNothing = (list: readonly Recorded[], message?: string) =>
  assert.equal(list.length, 0, message ?? JSON.stringify(list));

/** The error of an action whose writes were held for a human: request_requires_approval with the request to wait on. */
function heldId(error: unknown, what: string): string {
  assert.ok(error instanceof AdlError, `${what} should have been held, got ${String(error)}`);
  assert.equal(error.code, 'E_APPROVAL_REQUIRED', what);
  assert.equal(error.reason, 'request_requires_approval', what);
  assert.equal(typeof error.requestId, 'string', what);
  return error.requestId!;
}
const held = async (f: Fixture, name: string) => heldId(await rejection(f.click(name)), name);
const rows = async (f: Fixture, requestId?: string, waitMs = 0) =>
  (await f.engine.approvals(requestId, waitMs)).requests;
const GRANT = (origin: string) => ({ scope: 'site_writes', origin });

/** What the human's third choice does at the broker: the request is approved and the origin is granted from now on. */
function chooseSiteGrant(broker: Broker, requestId: string, origin: string) {
  const entry = broker.byId(requestId)!;
  entry.status = 'approved';
  entry.granted = 'site_writes';
  broker.grant(origin);
}

test(
  'ask: the first save asks; after the grant, saves by POST, PUT, PATCH and DELETE are sent at once, with their exact bytes, once each',
  { timeout: 120000 },
  () =>
    scenario({}, async (f, broker) => {
      // No grant yet: the save is held and a request is created (the modal offers the third choice for it).
      const id = await held(f, 'Save note');
      assert.deepEqual(broker.byId(id)!.summary.grant, GRANT(f.origin));
      assert.equal(broker.byId(id)!.status, 'pending');
      sentNothing(f.requests, 'nothing left while it waits');
      // The human chooses "allow further writes to this site": this request is approved by it (use 1) and sent by the engine's watcher.
      chooseSiteGrant(broker, id, f.origin);
      const [first] = await rows(f, id, 30000);
      assert.deepEqual([first!.status, first!.sent, first!.granted], ['consumed', true, 'site_writes']);
      assert.deepEqual(sent(f.requests), ['POST /api/notes']);
      await until(async () => (await f.status()) === 'saved', 'the page to see the answer');

      // Later saves: no request waits, the act itself returns the sent write.
      const xhr = await f.click('Save XHR', { include_diff: true });
      assert.equal(xhr.ok, true);
      assert.equal(xhr.write_blocked, undefined);
      assert.deepEqual(
        { status: xhr.approval?.status, sent: xhr.approval?.sent, granted: xhr.approval?.granted },
        { status: 'consumed', sent: true, granted: 'site_writes' },
      );
      assert.equal(xhr.approval?.response_status, 200);
      assert.equal(xhr.approval?.request_id, broker.latest()!.request_id);
      assert.deepEqual(f.requests.at(-1), {
        method: 'PUT',
        url: '/api/xhr',
        contentType: 'application/x-www-form-urlencoded',
        body: 'a=b&c=d',
      });
      assert.deepEqual(
        xhr.observation?.changes?.map(change => change.element?.name),
        ['xhr saved'],
        'the diff already shows the page reacting to the answer',
      );
      await until(async () => (await f.status()) === 'xhr saved', 'the XHR answer to reach the page');

      const patch = await f.check('Done', true);
      assert.equal(patch.approval?.granted, 'site_writes');
      assert.deepEqual(f.requests.at(-1), {
        method: 'PATCH',
        url: '/api/todo/1',
        contentType: 'application/json',
        body: '{"done":true}',
      });
      const del = await f.click('Delete on server');
      assert.equal(del.approval?.granted, 'site_writes');
      assert.deepEqual(f.requests.at(-1), { method: 'DELETE', url: '/items/1', contentType: '', body: '' });
      const again = await f.click('Save note');
      assert.equal(again.approval?.granted, 'site_writes');
      assert.equal((JSON.parse(f.requests.at(-1)!.body) as { title: string }).title, 'Buy milk');

      assert.deepEqual(sent(f.requests), [
        'POST /api/notes',
        'PUT /api/xhr',
        'PATCH /api/todo/1',
        'DELETE /items/1',
        'POST /api/notes',
      ]);
      assert.deepEqual(
        [broker.state.posts, broker.state.consumes, broker.state.autoApproved],
        [5, 5, 4],
        'one request per write, each consumed exactly once, four of them without a dialog',
      );
      // Nothing waits: adl_approvals lists no pending request, and the explicit ids report who decided.
      assert.deepEqual(await rows(f), []);
      const [row] = await rows(f, xhr.approval!.request_id);
      assert.deepEqual(
        [row!.status, row!.sent, row!.granted, row!.response_status],
        ['consumed', true, 'site_writes', 200],
      );
      await until(async () => (await f.status()) === 'saved', 'the last answer to reach the page');
      assert.deepEqual(
        warningsOf(await f.observe()).filter(w => w.method),
        [],
        'a released write blocks nothing and leaves no blocked-request warning behind',
      );
      await sleep(300);
      assert.equal(f.requests.length, 5, 'no write was sent twice');
    }),
);

test(
  'ask: a secret in the body, a money-like control and a money-like path still ask under a grant',
  { timeout: 120000 },
  () =>
    scenario({}, async (f, broker) => {
      broker.grant(f.origin);
      // A password in the body: held, offered without the grant field, a credential request.
      const secret = await held(f, 'Save JSON');
      assert.equal(broker.byId(secret)!.summary.grant, undefined);
      assert.equal(broker.byId(secret)!.summary.risk, 'credential');
      assert.equal(broker.byId(secret)!.status, 'pending');
      sentNothing(f.requests);
      // Resolve it so that the next action can ask: denied sends nothing.
      broker.byId(secret)!.status = 'denied';
      assert.equal((await rows(f, secret, 30000))[0]!.status, 'denied');

      // A control the label vocabulary gates: its click is approved per action, then its request is asked separately.
      const t = await f.target('Purchase');
      const action = { action: 'click' as const, element_id: t.element.id };
      const click = await rejection(f.engine.act(f.id, action, t.revision));
      assert.ok(click instanceof AdlError, String(click));
      assert.equal(click.reason, undefined, 'a plain approval before dispatch');
      assert.equal(broker.byId(click.requestId!)!.summary.grant, undefined, 'a click approval is never covered');
      assert.equal(broker.byId(click.requestId!)!.status, 'pending');
      broker.byId(click.requestId!)!.status = 'approved';
      const order = heldId(await rejection(f.engine.act(f.id, action, t.revision)), 'the approved Purchase click');
      assert.equal(broker.byId(order)!.summary.grant, undefined, 'a money-like control never offers the grant');
      assert.equal(broker.byId(order)!.status, 'pending');
      broker.byId(order)!.status = 'denied';
      assert.equal((await rows(f, order, 30000))[0]!.status, 'denied');

      // An ordinary-looking Donate button: the tier vocabulary does not gate it, the money-like vocabulary still withholds the grant.
      const donate = await held(f, 'Donate');
      assert.equal(broker.byId(donate)!.summary.grant, undefined);
      assert.equal(broker.byId(donate)!.status, 'pending');
      broker.byId(donate)!.status = 'denied';
      assert.equal((await rows(f, donate, 30000))[0]!.status, 'denied');

      assert.equal(broker.state.autoApproved, 0, 'nothing was approved by the grant');
      sentNothing(f.requests, 'nothing was sent');
    }),
);

test('ask: a write to a payment-like path under an ordinary label still asks under a grant', { timeout: 120000 }, () =>
  scenario({ start: '/shop' }, async (f, broker) => {
    broker.grant(f.origin);
    const id = await held(f, 'Save');
    assert.equal(broker.byId(id)!.summary.grant, undefined, 'the path names an order');
    assert.equal(broker.byId(id)!.status, 'pending');
    sentNothing(f.requests);
    broker.byId(id)!.status = 'approved';
    const [row] = await rows(f, id, 30000);
    assert.deepEqual([row!.sent, row!.granted], [true, undefined], 'an ordinary approval, not a granted one');
    assert.deepEqual(sent(f.requests), ['POST /api/orders']);
  }),
);

test(
  'ask: the grant is keyed on the destination origin: the API origin is asked until it has its own grant',
  { timeout: 120000 },
  () =>
    scenario({ grantApi: true }, async (f, broker) => {
      broker.grant(f.origin);
      // The page's own origin is granted; the write goes to the API origin, so it asks and names that origin.
      const id = await held(f, 'Save to API origin');
      assert.deepEqual(broker.byId(id)!.summary.grant, GRANT(f.apiOrigin));
      assert.equal(broker.byId(id)!.status, 'pending');
      sentNothing(f.apiRequests);
      broker.byId(id)!.status = 'approved';
      assert.equal((await rows(f, id, 30000))[0]!.sent, true);
      assert.equal(f.apiRequests.length, 1);
      await until(async () => (await f.status()) === 'api saved', 'the page to see the answer');

      // Now the API origin is granted too: the same save is sent inside the act.
      broker.grant(f.apiOrigin);
      const result = await f.click('Save to API origin');
      assert.equal(result.ok, true);
      assert.equal(result.approval?.granted, 'site_writes');
      assert.equal(f.apiRequests.length, 2);
      assert.deepEqual(
        f.apiRequests.map(r => `${r.method} ${r.url}`),
        ['POST /api/notes', 'POST /api/notes'],
      );
      sentNothing(f.requests, 'nothing went to the page origin');

      // Two writes to the grant's origin are one request and one consume.
      const consumes = broker.state.consumes;
      const both = await f.click('Save both');
      assert.equal(both.approval?.granted, 'site_writes');
      assert.deepEqual(sent(f.requests).sort(), ['POST /api/a', 'POST /api/b']);
      assert.equal(broker.state.consumes, consumes + 1, 'one approval for the whole set');
    }),
);

test(
  'ask: a real form submission under a grant is retried once without a dialog and sends the form exactly once',
  { timeout: 120000 },
  () =>
    scenario({ start: '/form' }, async (f, broker) => {
      broker.grant(f.origin);
      const observed = await f.observe();
      const save = observed.elements!.find(e => e.name === 'Save profile')!;
      const error = await rejection(f.engine.act(f.id, { action: 'click', element_id: save.id }, observed.revision));
      assert.ok(error instanceof AdlError, String(error));
      assert.equal(error.code, 'E_APPROVAL_REQUIRED');
      assert.equal(error.reason, 'form_submission_requires_approval');
      const safe = safeError(error) as ReturnType<typeof safeError> & { approved?: boolean };
      assert.equal(safe.approved, true, 'the grant already approved it: retry at once');
      assert.equal(safe.retryable, true);
      assert.equal(typeof safe.revision, 'number');
      assert.equal(safe.request_id, error.requestId);
      sentNothing(f.requests, 'cancelled in the browser, nothing left');
      const entry = broker.byId(error.requestId!)!;
      assert.equal(entry.status, 'approved');
      assert.deepEqual(entry.summary.grant, GRANT(f.origin));
      assert.deepEqual([broker.state.posts, broker.state.consumes, broker.state.autoApproved], [1, 0, 1]);

      // The identical action at the returned revision consumes the approval and sends the form with its exact body.
      const result = (await f.engine.act(f.id, { action: 'click', element_id: save.id }, safe.revision!)) as ActResult;
      assert.equal(result.ok, true);
      assert.equal(f.requests.length, 1);
      assert.equal(f.requests[0]!.method, 'POST');
      assert.equal(f.requests[0]!.url, '/profile');
      assert.equal(f.requests[0]!.contentType, 'application/x-www-form-urlencoded');
      assert.equal(f.requests[0]!.body, 'name=Taro');
      assert.deepEqual([broker.state.posts, broker.state.consumes], [1, 1]);
      const [row] = await rows(f, error.requestId);
      assert.deepEqual([row!.status, row!.granted], ['consumed', 'site_writes']);
      // The approval was single-use.
      await assert.rejects(f.engine.act(f.id, { action: 'click', element_id: save.id }, safe.revision!));
      assert.equal(f.requests.length, 1);
    }),
);

test(
  'ask: a form that posts to a payment-like path asks even though its button label is ordinary',
  { timeout: 120000 },
  () =>
    scenario({ start: '/form' }, async (f, broker) => {
      broker.grant(f.origin);
      const observed = await f.observe();
      const save = observed.elements!.find(e => e.name === 'Save item')!;
      const error = await rejection(f.engine.act(f.id, { action: 'click', element_id: save.id }, observed.revision));
      assert.ok(error instanceof AdlError, String(error));
      assert.equal(error.reason, 'form_submission_requires_approval');
      assert.equal((safeError(error) as { approved?: boolean }).approved, undefined);
      const entry = broker.byId(error.requestId!)!;
      assert.equal(entry.summary.grant, undefined);
      assert.equal(entry.status, 'pending');
      sentNothing(f.requests);
      assert.equal(broker.state.autoApproved, 0);
    }),
);

test('ask: a containable Delete under a grant needs no dialog at all', { timeout: 120000 }, () =>
  scenario({}, async (f, broker) => {
    broker.grant(f.origin);
    const result = await f.click('Delete on server');
    assert.equal(result.ok, true);
    assert.equal(result.approval?.granted, 'site_writes');
    assert.equal(result.approval?.sent, true);
    assert.deepEqual(sent(f.requests), ['DELETE /items/1']);
    assert.equal(broker.state.posts, 1, 'only the request of the DELETE itself was created');
    assert.equal(broker.state.autoApproved, 1);
    await until(async () => (await f.status()) === 'deleted', 'the page to see the answer');
  }),
);

test(
  'ask: a grant never widens what is held: uploads, background writes and other origins stay blocked',
  { timeout: 120000 },
  () =>
    scenario({}, async (f, broker) => {
      broker.grant(f.origin);
      broker.grant(f.otherOrigin);
      const attach = await f.click('Attach');
      assert.equal(attach.ok, true);
      assert.equal(attach.write_blocked, true);
      assert.equal(attach.approval, undefined);
      assert.equal(only(warningsOf(attach), 'request_not_approvable').length, 1, JSON.stringify(attach.warnings));
      await until(async () => (await f.status()) === 'upload failed', 'the page to see the refusal');

      const later = await f.click('Save later');
      assert.equal(later.ok, true);
      assert.equal(later.write_blocked, undefined, 'it belongs to no action');
      await until(async () => (await f.status()) === 'later failed', 'the timer write to be refused');
      assert.deepEqual(
        warningsOf(await f.observe())
          .filter(w => w.method === 'POST')
          .map(w => w.code),
        ['background_write_blocked'],
      );

      const elsewhere = await f.click('Save elsewhere');
      assert.equal(elsewhere.ok, true);
      assert.equal(elsewhere.write_blocked, true);
      assert.equal(only(warningsOf(elsewhere), 'origin_not_allowed').length, 1, JSON.stringify(elsewhere.warnings));
      assert.equal(elsewhere.approval, undefined);

      assert.equal(broker.state.posts, 0, 'nobody was asked and nothing was approved');
      sentNothing(f.requests);
      sentNothing(f.otherRequests);
    }),
);

test('ask: once the grant ends, saves ask again and nothing is sent until a human decides', { timeout: 120000 }, () =>
  scenario({}, async (f, broker) => {
    broker.grant(f.origin);
    const first = await f.click('Save XHR');
    assert.equal(first.approval?.granted, 'site_writes');
    assert.deepEqual(sent(f.requests), ['PUT /api/xhr']);
    await until(async () => (await f.status()) === 'xhr saved', 'the page to see the answer');

    // Expiry, revoke, emergency stop and settings changes all end at the broker; the engine only sees that the next request waits.
    broker.revokeGrants();
    const id = await held(f, 'Save XHR');
    assert.equal(broker.byId(id)!.status, 'pending');
    assert.deepEqual(broker.byId(id)!.summary.grant, GRANT(f.origin), 'the dialog offers the third choice again');
    assert.deepEqual(sent(f.requests), ['PUT /api/xhr'], 'the second save is held, not sent');
    assert.equal(broker.state.autoApproved, 1);
    broker.byId(id)!.status = 'denied';
    assert.equal((await rows(f, id, 30000))[0]!.sent, false);
    await until(async () => (await f.status()) === 'xhr failed', 'the page to see the denial');
    assert.deepEqual(sent(f.requests), ['PUT /api/xhr']);
  }),
);
