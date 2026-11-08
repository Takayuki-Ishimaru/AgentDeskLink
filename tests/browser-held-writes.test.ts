import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { Page } from 'playwright';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import { AdlError, safeError, type AdapterSession, type NetworkWarning } from '../src/types.js';
import { stubBroker } from './approval-broker-stub.js';

// Ask mode with an approver: a write (fetch/XHR POST, PUT, PATCH, DELETE) the page sends while an action runs is held unsent inside the browser,
// a human is asked about its exact content, and approving releases exactly those bytes once. End to end: Engine + BrowserAdapter + real Chromium +
// the approval broker stub. Standard mode, ask without an approver and read_only never hold; they block the write and say that the page's state
// was not saved (write_blocked).

// Without these the "no approver" cases would pick up a real broker from the environment. stubBroker() restores what it found (nothing).
for (const key of ['ADL_APPROVAL_URL', 'ADL_APPROVAL_TOKEN', 'ADL_APPROVAL_EPOCH']) delete process.env[key];

type Recorded = { method: string; url: string; contentType: string; body: string };
type Broker = Awaited<ReturnType<typeof stubBroker>>;
type ActResult = {
  ok: boolean;
  revision: number;
  network_blocked?: boolean;
  subresources_blocked?: number;
  write_blocked?: boolean;
  warnings?: NetworkWarning[];
  observation?: { changes?: { element?: { name?: string } }[] };
};

const SPA = (api: string, other: string) => `<!doctype html><title>Tasks</title>
<p id="status" role="status">idle</p><ul id="list"></ul>
<label><input type="checkbox" onchange="toggle(this,false)"> Done</label>
<label><input type="checkbox" onchange="toggle(this,true)"> Starred</label>
<button onclick="saveJson()">Save JSON</button>
<button onclick="saveXhr()">Save XHR</button>
<button onclick="saveBoth()">Save both</button>
<button onclick="saveFive()">Save five</button>
<button onclick="attach()">Attach</button>
<button onclick="big()">Save big</button>
<button onclick="withTimeout()">Save with timeout</button>
<button onclick="quickAbort()">Save with quick abort</button>
<button onclick="later()">Save later</button>
<button onclick="saveApi()">Save to API origin</button>
<button onclick="saveElsewhere()">Save elsewhere</button>
<button onclick="fetchElsewhere()">Fetch elsewhere</button>
<button onclick="addSheet()">Add stylesheet</button>
<button onclick="purchase()">Purchase</button>
<ul><li id="milk">Buy milk <button onclick="count('d1');document.getElementById('milk').remove()">Delete Buy milk</button></li></ul>
<button onclick="count('d2');fetch('/items/1',{method:'DELETE'}).then(()=>setStatus('deleted'),()=>setStatus('delete failed'))">Delete on server</button>
<button onclick="count('d3');fetch('/items/1/remove').catch(()=>{})">Delete by read</button>
<script>
window.calls={};const count=n=>{window.calls[n]=(window.calls[n]||0)+1};
const setStatus=t=>{document.getElementById('status').textContent=t};
const done=(ok,bad)=>[()=>setStatus(ok),()=>setStatus(bad)];
function saveJson(){count('saveJson');setStatus('saving');fetch('/api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Buy milk',nonce:crypto.randomUUID(),password:'hunter22'})}).then(r=>r.json()).then(()=>{const li=document.createElement('li');li.textContent='Saved: Buy milk';document.getElementById('list').append(li);setStatus('saved')},()=>setStatus('could not save'))}
function saveXhr(){const x=new XMLHttpRequest();x.open('PUT','/api/xhr');x.setRequestHeader('content-type','application/x-www-form-urlencoded');x.onload=()=>setStatus('xhr saved');x.onerror=()=>setStatus('xhr failed');x.send('a=b&c=d')}
function toggle(el,rollback){const want=el.checked;fetch('/api/todo/1',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({done:want})}).then(()=>setStatus('toggled'),()=>{if(rollback)el.checked=!want;setStatus('toggle failed')})}
function saveBoth(){setStatus('saving both');Promise.all([fetch('/api/a',{method:'POST',body:'a'}),fetch('/api/b',{method:'POST',body:'b'})]).then(...done('saved both','could not save both'))}
function saveFive(){setStatus('saving five');Promise.all([0,1,2,3,4].map(i=>fetch('/api/n'+i,{method:'POST',body:String(i)}))).then(...done('saved five','could not save five'))}
function attach(){const f=new FormData();f.append('file',new Blob(['x']),'a.txt');fetch('/api/upload',{method:'POST',body:f}).then(...done('uploaded','upload failed'))}
function big(){fetch('/api/big',{method:'POST',body:'x'.repeat(70*1024)}).then(...done('big saved','big failed'))}
function quickAbort(){const c=new AbortController();setTimeout(()=>c.abort(),100);fetch('/api/quick',{method:'POST',body:'x',signal:c.signal}).then(...done('saved','gave up'))}
function withTimeout(){const c=new AbortController();setTimeout(()=>c.abort(),2000);fetch('/api/slowsave',{method:'POST',body:'x',signal:c.signal}).then(...done('saved','timed out'))}
function later(){setTimeout(()=>fetch('/api/later',{method:'POST',body:'z'}).then(...done('later saved','later failed')),900)}
function saveApi(){fetch('${api}/api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'cross'})}).then(...done('api saved','api failed'))}
function saveElsewhere(){fetch('${other}/api/tasks',{method:'POST',body:'x'}).then(...done('elsewhere saved','elsewhere failed'))}
function fetchElsewhere(){fetch('${other}/data').catch(()=>{})}
function addSheet(){const l=document.createElement('link');l.rel='stylesheet';l.href='${other}/late.css';document.head.append(l)}
function purchase(){count('purchase');setStatus('ordering');fetch('/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sku:'A-1',qty:1})}).then(...done('ordered','order failed'))}
</script>`;

// The page itself writes while it loads: nobody asked for it.
const AUTOSAVE = `<!doctype html><title>Autosave</title><p>Autosaving</p><script>fetch('/api/autosave',{method:'POST',body:'x'}).catch(()=>{})</script>`;

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** Serves pages for GET and records every other request (and every /api and /items request) with its body. */
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

type Options = {
  mode?: 'standard' | 'ask' | 'read_only';
  allowAll?: boolean;
  /** Start the stub broker (the default in ask mode). */
  broker?: boolean;
  grantApi?: boolean;
  start?: string;
};

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
    '/other': () => '<!doctype html><title>Other</title><button>Elsewhere</button>',
    '/autosave': () => AUTOSAVE,
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
      ...(options.allowAll ? { allowAllOperations: true } : { operationMode: options.mode ?? 'ask' }),
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
    /** The element with this accessible name, as the agent sees it now, and the revision to act on. */
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
  const withBroker = options.broker ?? ((options.mode ?? 'ask') === 'ask' && !options.allowAll);
  const broker = withBroker ? await stubBroker() : undefined;
  try {
    const f = await fixture(options);
    try {
      await body(f, broker as Broker);
    } finally {
      await f.close();
    }
  } finally {
    await broker?.close();
  }
}

// assert.deepEqual(list, []) would narrow the list to never[].
const sentNothing = (list: readonly Recorded[], message?: string) =>
  assert.equal(list.length, 0, message ?? JSON.stringify(list));
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
const warning = (code: string, method: string, resource_type: string): NetworkWarning => ({
  code,
  count: 1,
  resource_type,
  method,
});
const approve = (broker: Broker, requestId: string) => (broker.byId(requestId)!.status = 'approved');
const decide = (broker: Broker, requestId: string, status: 'approved' | 'denied') =>
  (broker.byId(requestId)!.status = status);
const detailsOf = (broker: Broker, requestId: string): string[] => broker.byId(requestId)!.summary.details ?? [];

/** The error of an action whose writes were held: request_requires_approval with the request to wait on, the session intact. */
function heldId(error: unknown, what: string): string {
  assert.ok(error instanceof AdlError, `${what} should have been held, got ${String(error)}`);
  assert.equal(error.code, 'E_APPROVAL_REQUIRED', what);
  assert.equal(error.reason, 'request_requires_approval', what);
  assert.equal(typeof error.requestId, 'string', what);
  const safe = safeError(error) as ReturnType<typeof safeError> & { page_script_ran?: boolean };
  assert.equal(safe.retryable, false, 'the way forward is adl_approvals, not a retry');
  assert.equal(safe.page_script_ran, true, 'the handler has run');
  assert.equal(safe.may_have_executed, undefined, 'the session survives');
  assert.equal(safe.request_id, error.requestId);
  return error.requestId!;
}
const held = async (f: Fixture, name: string) => heldId(await rejection(f.click(name)), name);

const rows = async (f: Fixture, requestId?: string, waitMs = 0) =>
  (await f.engine.approvals(requestId, waitMs)).requests;

test(
  'ask: a fetch write is held with its exact content, then sent once with exactly those bytes',
  { timeout: 120000 },
  () =>
    scenario({ mode: 'ask' }, async (f, broker) => {
      const id = await held(f, 'Save JSON');
      await sleep(300);
      sentNothing(f.requests, 'nothing left the browser while it is held');
      assert.equal(broker.state.posts, 1);
      assert.equal(broker.byId(id)!.summary.risk, 'credential', 'the password is masked and marks the request');
      const details = detailsOf(broker, id);
      assert.equal(details[0], `Request POST ${f.origin}/api/tasks`);
      assert.ok(details.includes('"title": "Buy milk"'), details.join('\n'));
      assert.ok(details.includes('"password": [secret, 8 characters]'), details.join('\n'));
      const nonceLine = details.find(line => line.startsWith('"nonce": '));
      assert.ok(nonceLine, details.join('\n'));
      assert.ok(!JSON.stringify(broker.byId(id)).includes('hunter22'), 'the secret never reaches the broker');
      assert.equal(await f.status(), 'saving', 'the page is waiting for the answer');
      const pending = await rows(f, id);
      assert.deepEqual(
        pending.map(r => [r.request_id, r.status]),
        [[id, 'pending']],
      );
      assert.equal((await rows(f)).length, 1, 'adl_approvals without an id lists the pending request');

      approve(broker, id);
      const started = Date.now();
      const [row] = await rows(f, id, 30000);
      assert.ok(Date.now() - started < 10000, 'the approval is learned of at once, not at the end of the wait');
      assert.equal(row!.status, 'consumed');
      assert.equal(row!.sent, true);
      assert.equal(row!.response_status, 200);
      assert.equal(f.requests.length, 1, 'sent once');
      const [sent] = f.requests;
      assert.equal(sent!.method, 'POST');
      assert.equal(sent!.url, '/api/tasks');
      assert.equal(sent!.contentType, 'application/json');
      const body = JSON.parse(sent!.body) as { title: string; nonce: string; password: string };
      assert.equal(
        `"nonce": ${JSON.stringify(body.nonce)}`,
        nonceLine,
        'the nonce the human saw is the one the server received',
      );
      assert.equal(body.title, 'Buy milk');
      assert.equal(body.password, 'hunter22');
      assert.equal(broker.state.consumes, 1);

      await until(async () => (await f.status()) === 'saved', 'the page to see the answer');
      const observed = await f.observe();
      assert.ok(observed.elements!.some(e => e.role === 'listitem' && e.name === 'Saved: Buy milk'));
      assert.equal(observed.warnings, undefined, 'a released write blocks nothing');
      assert.deepEqual(await rows(f), [], 'adl_approvals without an id lists only pending requests');
      const [again] = await rows(f, id);
      assert.equal(again!.status, 'consumed');
      assert.equal(again!.sent, true);
      assert.equal(again!.response_status, 200);
      await sleep(300);
      assert.equal(f.requests.length, 1, 'still sent once');
    }),
);

test(
  'ask: a denial sends nothing, the page shows its failure and the next observation says why, once',
  { timeout: 120000 },
  () =>
    scenario({ mode: 'ask' }, async (f, broker) => {
      const id = await held(f, 'Save JSON');
      decide(broker, id, 'denied');
      const [row] = await rows(f, id, 30000);
      assert.equal(row!.status, 'denied');
      assert.equal(row!.sent, false);
      await until(async () => (await f.status()) === 'could not save', "the page's own failure message");
      sentNothing(f.requests);
      const observed = await f.observe();
      assert.deepEqual(only(warningsOf(observed), 'approval_denied'), [warning('approval_denied', 'POST', 'fetch')]);
      assert.ok(!observed.elements!.some(e => e.role === 'listitem' && e.name === 'Saved: Buy milk'));
      const next = await f.observe();
      assert.equal(next.warnings, undefined, 'reported once');
      assert.equal(next.revision, observed.revision, 'reporting does not change the revision');
      assert.deepEqual(await rows(f), []);
      sentNothing(f.requests);
    }),
);

test(
  'ask: the identical action while the write is held is the same request and dispatches nothing',
  { timeout: 120000 },
  () =>
    scenario({ mode: 'ask' }, async (f, broker) => {
      const id = await held(f, 'Save JSON');
      assert.deepEqual(await f.calls(), { saveJson: 1 });
      const again = heldId(await rejection(f.click('Save JSON')), 'the identical retry');
      assert.equal(again, id, 'the same request');
      assert.deepEqual(await f.calls(), { saveJson: 1 }, 'the handler did not run again');
      assert.equal(broker.state.posts, 1, 'no second approval');
      sentNothing(f.requests);
      approve(broker, id);
      const [row] = await rows(f, id, 30000);
      assert.equal(row!.sent, true);
      assert.equal(f.requests.length, 1, 'still exactly one write');
    }),
);

test(
  'ask: another action while a write is held runs, and its own write is blocked as pending-other',
  { timeout: 120000 },
  () =>
    scenario({ mode: 'ask' }, async (f, broker) => {
      const id = await held(f, 'Save JSON');
      const result = await f.click('Save XHR');
      assert.equal(result.ok, true);
      assert.equal(result.write_blocked, true);
      assert.equal(result.network_blocked, true);
      assert.deepEqual(only(warningsOf(result), 'approval_pending_other_action'), [
        warning('approval_pending_other_action', 'PUT', 'xhr'),
      ]);
      await until(async () => (await f.status()) === 'xhr failed', 'the page to see the refusal');
      assert.equal(broker.state.posts, 1, 'no second approval');
      assert.deepEqual(
        (await rows(f, id)).map(r => r.status),
        ['pending'],
        'the first request is still waiting',
      );
      sentNothing(f.requests);
    }),
);

test('ask: adl_execute exposes the resume point after a real browser write is released', { timeout: 120000 }, () =>
  scenario({ mode: 'ask' }, async (f, broker) => {
    const observed = await f.observe();
    const ids = ['Save JSON', 'Save XHR'].map(name => observed.elements!.find(e => e.name === name)!.id);
    const started = f.engine.execute(
      ids.map(element_id => ({ session_id: f.id, action: 'click' as const, element_id })),
      { [f.id]: observed.revision },
    );
    const read = () => f.engine.task(started.task_id);
    await until(() => read().status === 'blocked_on_approval', 'the batch to reach its approval');
    const task = read();
    assert.deepEqual(
      task.results.map(r => r.status),
      ['blocked_on_approval', 'not_executed'],
    );
    const id = broker.latest()!.request_id;
    assert.equal(task.pending_request_id, id);
    assert.equal(task.next_step_index, 1);
    assert.deepEqual(await f.calls(), { saveJson: 1 }, 'the second step never ran');
    assert.equal(broker.state.posts, 1);
    sentNothing(f.requests);
    approve(broker, id);
    assert.equal((await rows(f, id, 30000))[0]?.sent, true);
    const resumed = read();
    assert.equal(resumed.status, 'ready_to_resume');
    assert.equal(resumed.pending_request_id, undefined);
    assert.equal(resumed.next_step_index, 1);
    assert.deepEqual(
      resumed.results.map(r => r.status),
      ['completed', 'not_executed'],
    );
    assert.equal(f.requests.length, 1);
    assert.deepEqual(await f.calls(), { saveJson: 1 }, 'neither step was replayed');
  }),
);

test('ask: a checkbox PATCH is held; approving sends it, denying lets the page roll back', { timeout: 120000 }, () =>
  scenario({ mode: 'ask' }, async (f, broker) => {
    const done = await rejection(f.check('Done', true));
    const doneId = heldId(done, 'Done');
    assert.equal(detailsOf(broker, doneId)[0], `Request PATCH ${f.origin}/api/todo/1`);
    assert.ok(detailsOf(broker, doneId).includes('"done": true'), detailsOf(broker, doneId).join('\n'));
    // The dialog asks to send the request the check box left waiting, and names the control as the observation does.
    assert.equal(broker.byId(doneId)!.summary.action, 'send_request');
    assert.equal(broker.byId(doneId)!.summary.role, 'checkbox');
    sentNothing(f.requests);
    approve(broker, doneId);
    const [sentRow] = await rows(f, doneId, 30000);
    assert.equal(sentRow!.sent, true);
    assert.deepEqual(
      f.requests.map(r => `${r.method} ${r.url}`),
      ['PATCH /api/todo/1'],
    );
    assert.deepEqual(JSON.parse(f.requests[0]!.body), { done: true });
    await until(async () => (await f.status()) === 'toggled', 'the page to see the answer');

    const starred = heldId(await rejection(f.check('Starred', true)), 'Starred');
    decide(broker, starred, 'denied');
    const [deniedRow] = await rows(f, starred, 30000);
    assert.equal(deniedRow!.status, 'denied');
    assert.equal(deniedRow!.sent, false);
    await until(async () => (await f.status()) === 'toggle failed', 'the page to roll back');
    const observed = await f.observe();
    assert.equal(
      observed.elements!.find(e => e.name === 'Starred')!.checked,
      false,
      'the screen matches what was saved',
    );
    assert.equal(observed.elements!.find(e => e.name === 'Done')!.checked, true);
    assert.deepEqual(only(warningsOf(observed), 'approval_denied'), [warning('approval_denied', 'PATCH', 'fetch')]);
    assert.equal(f.requests.length, 1, 'only the approved PATCH was sent');
  }),
);

test('ask: the page giving up on a held write withdraws the request and sends nothing', { timeout: 120000 }, () =>
  scenario({ mode: 'ask' }, async (f, broker) => {
    // The fetch is aborted 2 s after the click, long after the action's window closed and the request was handed over.
    const id = await held(f, 'Save with timeout');
    const [row] = await rows(f, id, 30000);
    assert.equal(row!.status, 'invalidated');
    assert.equal(row!.sent, false);
    assert.equal(broker.byId(id)!.status, 'invalidated', 'the broker entry was withdrawn');
    await until(async () => (await f.status()) === 'timed out', "the page's own timeout message");
    sentNothing(f.requests);
    assert.deepEqual(await rows(f), []);
  }),
);

test('ask: a page that gives up on its write inside the action leaves nothing to approve', { timeout: 120000 }, () =>
  scenario({ mode: 'ask' }, async (f, broker) => {
    // The fetch is aborted 100 ms after the click, before the action's window closes: the request is gone, so there is nothing to hand over
    // and nobody is asked. The action reports what happened to the write as a block.
    const outcome = await f.click('Save with quick abort').then(
      value => ({ value }),
      (error: unknown) => ({ error }),
    );
    if ('error' in outcome) {
      // Only on a machine so slow that the window closed before the page gave up: the request was handed over and the cancellation withdraws it.
      const id = heldId(outcome.error, 'Save with quick abort');
      const [row] = await rows(f, id, 30000);
      assert.equal(row!.status, 'invalidated');
      assert.equal(row!.sent, false);
    } else {
      assert.equal(outcome.value.ok, true);
      assert.equal(outcome.value.write_blocked, true);
      assert.deepEqual(only(warningsOf(outcome.value), 'request_denied'), [warning('request_denied', 'POST', 'fetch')]);
      assert.equal(broker.state.posts, 0, 'nobody was asked');
    }
    await until(async () => (await f.status()) === 'gave up', "the page's own message");
    sentNothing(f.requests);
    assert.deepEqual(await rows(f), [], 'nothing is left waiting for a human');
  }),
);

test('ask: closing the session aborts the held write and withdraws the request', { timeout: 120000 }, () =>
  scenario({ mode: 'ask' }, async (f, broker) => {
    const id = await held(f, 'Save JSON');
    assert.equal(broker.state.deletes, 0);
    await f.engine.close(f.id);
    assert.equal(broker.state.deletes, 1, 'the request was withdrawn from the broker once');
    assert.equal(broker.byId(id)!.status, 'invalidated');
    const [row] = await rows(f, id);
    assert.equal(row!.status, 'invalidated');
    assert.equal(row!.sent, false);
    await sleep(300);
    sentNothing(f.requests);
  }),
);

test('ask: navigating away aborts the held write and withdraws the request', { timeout: 120000 }, () =>
  scenario({ mode: 'ask' }, async (f, broker) => {
    const id = await held(f, 'Save JSON');
    const observed = await f.observe();
    await f.engine.act(f.id, { action: 'navigate', url: `${f.origin}/other` }, observed.revision);
    const [row] = await rows(f, id, 30000);
    assert.equal(row!.status, 'invalidated');
    assert.equal(row!.sent, false);
    assert.equal(broker.byId(id)!.status, 'invalidated');
    await sleep(300);
    sentNothing(f.requests);
    const next = await f.observe();
    assert.ok(
      next.elements!.some(e => e.name === 'Elsewhere'),
      'the session is on the new page',
    );
    assert.equal(next.warnings, undefined, 'the replaced document took its blocks with it');
  }),
);

test('ask: two parallel writes are one approval and are released together', { timeout: 120000 }, () =>
  scenario({ mode: 'ask' }, async (f, broker) => {
    const id = await held(f, 'Save both');
    const details = detailsOf(broker, id);
    assert.ok(details.length <= 25, details.join('\n'));
    assert.ok(details.includes(`Request POST ${f.origin}/api/a`), details.join('\n'));
    assert.ok(details.includes(`Request POST ${f.origin}/api/b`), details.join('\n'));
    assert.equal(broker.state.posts, 1, 'one approval for both');
    sentNothing(f.requests);
    approve(broker, id);
    const [row] = await rows(f, id, 30000);
    assert.equal(row!.status, 'consumed');
    assert.equal(row!.sent, true);
    assert.equal(broker.state.consumes, 1);
    await until(async () => (await f.status()) === 'saved both', 'both answers');
    assert.deepEqual(f.requests.map(r => r.url).sort(), ['/api/a', '/api/b']);
  }),
);

test('ask: five parallel writes are refused as not approvable and none is sent', { timeout: 120000 }, () =>
  scenario({ mode: 'ask' }, async (f, broker) => {
    const error = await rejection(f.click('Save five'));
    assert.ok(error instanceof AdlError, String(error));
    assert.equal(error.code, 'E_APPROVAL_REQUIRED');
    assert.equal(error.reason, 'request_not_approvable');
    assert.equal(error.requestId, undefined, 'there is nothing to wait for');
    const safe = safeError(error) as ReturnType<typeof safeError> & { page_script_ran?: boolean };
    assert.equal(safe.page_script_ran, true);
    assert.equal(safe.may_have_executed, undefined);
    assert.equal(broker.state.posts, 0, 'nobody was asked');
    await until(async () => (await f.status()) === 'could not save five', 'the page to see the failure');
    sentNothing(f.requests, 'not even the first four');
    assert.ok((await f.observe()).elements!.length > 0, 'the session survives');
  }),
);

test('ask: multipart and oversized bodies are blocked as not approvable', { timeout: 120000 }, () =>
  scenario({ mode: 'ask' }, async (f, broker) => {
    for (const [name, failed] of [
      ['Attach', 'upload failed'],
      ['Save big', 'big failed'],
    ] as const) {
      const result = await f.click(name);
      assert.equal(result.ok, true, name);
      assert.equal(result.write_blocked, true, name);
      assert.equal(result.network_blocked, true, name);
      assert.deepEqual(only(warningsOf(result), 'request_not_approvable'), [
        warning('request_not_approvable', 'POST', 'fetch'),
      ]);
      await until(async () => (await f.status()) === failed, `${name}: the page to see the refusal`);
    }
    assert.equal(broker.state.posts, 0, 'nobody was asked');
    sentNothing(f.requests);
  }),
);

test(
  'ask: a write after the action ended is background traffic: never asked, reported once by the next observation',
  { timeout: 120000 },
  () =>
    scenario({ mode: 'ask' }, async (f, broker) => {
      const result = await f.click('Save later');
      assert.equal(result.ok, true);
      assert.equal(result.write_blocked, undefined, 'it belongs to no action');
      assert.equal(result.network_blocked, undefined);
      assert.deepEqual(
        warningsOf(result).filter(w => w.method === 'POST'),
        [],
      );
      await until(async () => (await f.status()) === 'later failed', 'the timer write to be refused');
      const observed = await f.observe();
      assert.deepEqual(
        warningsOf(observed).filter(w => w.method === 'POST'),
        [warning('background_write_blocked', 'POST', 'fetch')],
      );
      assert.equal((await f.observe()).warnings, undefined, 'reported once');
      assert.equal(broker.state.posts, 0, 'nobody was asked');
      sentNothing(f.requests);
    }),
);

test(
  'ask: a write to a granted other origin is held with its full URL; an ungranted origin stays blocked',
  { timeout: 120000 },
  () =>
    scenario({ mode: 'ask', grantApi: true }, async (f, broker) => {
      const id = await held(f, 'Save to API origin');
      assert.equal(detailsOf(broker, id)[0], `Request POST ${f.apiOrigin}/api/tasks`);
      sentNothing(f.apiRequests);
      approve(broker, id);
      const [row] = await rows(f, id, 30000);
      assert.equal(row!.sent, true);
      assert.equal(f.apiRequests.length, 1);
      assert.equal(f.apiRequests[0]!.method, 'POST');
      assert.equal(JSON.parse(f.apiRequests[0]!.body).title, 'cross');
      await until(async () => (await f.status()) === 'api saved', 'the page to see the answer');

      const result = await f.click('Save elsewhere');
      assert.equal(result.ok, true);
      assert.equal(result.write_blocked, true);
      assert.equal(result.network_blocked, true);
      const blocked = only(warningsOf(result), 'origin_not_allowed');
      assert.equal(blocked.length, 1, JSON.stringify(result.warnings));
      assert.equal(blocked[0]!.method, 'POST');
      assert.equal(blocked[0]!.resource_type, 'fetch');
      assert.equal(blocked[0]!.origin, f.otherOrigin);
      assert.equal(broker.state.posts, 1, 'the ungranted origin was never put to a human');
      sentNothing(f.otherRequests);
      assert.equal(f.requests.length, 0);
    }),
);

test(
  'ask: a label-gated control asks twice, for the click and then for the exact request it sent',
  { timeout: 120000 },
  () =>
    scenario({ mode: 'ask' }, async (f, broker) => {
      const t = await f.target('Purchase');
      const action = { action: 'click' as const, element_id: t.element.id };
      const click = rejection(f.engine.act(f.id, action, t.revision));
      const first = await click;
      assert.ok(first instanceof AdlError, String(first));
      assert.equal(first.code, 'E_APPROVAL_REQUIRED');
      assert.equal(first.reason, undefined, 'a plain approval before dispatch');
      const clickId = first.requestId!;
      assert.ok(clickId);
      assert.deepEqual(await f.calls(), {}, 'nothing ran before the click was approved');
      assert.equal(broker.byId(clickId)!.summary.name, 'Purchase');
      assert.equal(broker.byId(clickId)!.summary.details, undefined);

      approve(broker, clickId);
      const second = await rejection(f.engine.act(f.id, action, t.revision));
      const orderId = heldId(second, 'the approved Purchase click');
      assert.notEqual(orderId, clickId, 'a click approval does not release the request');
      assert.deepEqual(await f.calls(), { purchase: 1 });
      const details = detailsOf(broker, orderId);
      assert.equal(details[0], `Request POST ${f.origin}/api/orders`);
      assert.ok(details.includes('"sku": "A-1"'), details.join('\n'));
      sentNothing(f.requests);
      assert.equal(broker.state.posts, 2);

      approve(broker, orderId);
      const [row] = await rows(f, orderId, 30000);
      assert.equal(row!.status, 'consumed');
      assert.equal(row!.sent, true);
      assert.equal(f.requests.length, 1, 'sent once');
      assert.equal(f.requests[0]!.url, '/api/orders');
      assert.deepEqual(JSON.parse(f.requests[0]!.body), { sku: 'A-1', qty: 1 });
      assert.equal(broker.state.consumes, 2);
      await until(async () => (await f.status()) === 'ordered', 'the page to see the answer');
    }),
);

test(
  'ask: a containable Delete asks only for the request it sends, and stops on anything it reads',
  { timeout: 120000 },
  () =>
    scenario({ mode: 'ask' }, async (f, broker) => {
      // A local delete: no dialog, no request; it runs with the network closed and says so.
      const local = await f.click('Delete Buy milk');
      assert.equal(local.ok, true);
      assert.ok(
        warningsOf(local).some(w => w.code === 'contained_action'),
        JSON.stringify(local.warnings),
      );
      assert.equal(local.write_blocked, undefined);
      assert.deepEqual(await f.calls(), { d1: 1 });
      assert.equal(broker.state.posts, 0, 'nobody was asked');
      sentNothing(f.requests);
      assert.ok(!(await f.observe()).elements!.some(e => e.name === 'Delete Buy milk'), 'the item is gone');

      // A delete that goes to the server: one dialog, for the DELETE request itself.
      const id = await held(f, 'Delete on server');
      assert.deepEqual(detailsOf(broker, id), [`Request DELETE ${f.origin}/items/1`, '(no body)']);
      assert.equal(broker.state.posts, 1);
      sentNothing(f.requests);
      approve(broker, id);
      const [row] = await rows(f, id, 30000);
      assert.equal(row!.status, 'consumed');
      assert.equal(row!.sent, true);
      assert.deepEqual(
        f.requests.map(r => `${r.method} ${r.url}`),
        ['DELETE /items/1'],
      );
      await until(async () => (await f.status()) === 'deleted', 'the page to see the answer');

      // A delete whose effect is a GET cannot be held: it is stopped, and the handler has run.
      const read = await rejection(f.click('Delete by read'));
      assert.ok(read instanceof AdlError, String(read));
      assert.equal(read.code, 'E_APPROVAL_REQUIRED');
      assert.equal(read.reason, 'contained_request_blocked');
      assert.equal(read.requestId, undefined);
      const safe = safeError(read) as ReturnType<typeof safeError> & { page_script_ran?: boolean };
      assert.equal(safe.page_script_ran, true);
      assert.equal(safe.policy_setting, 'consequentialAllowLabels');
      assert.equal(safe.may_have_executed, undefined);
      await sleep(300);
      assert.deepEqual(
        f.requests.map(r => `${r.method} ${r.url}`),
        ['DELETE /items/1'],
        'nothing but the approved DELETE left',
      );
      assert.equal(broker.state.posts, 1);
    }),
);

test(
  'ask without an approver: the write is blocked, never held, and the diff shows the failure',
  { timeout: 120000 },
  () =>
    scenario({ mode: 'ask', broker: false }, async (f, broker) => {
      assert.equal(broker, undefined);
      const result = await f.click('Save JSON', { include_diff: true });
      assert.equal(result.ok, true);
      assert.equal(result.network_blocked, true);
      assert.equal(result.write_blocked, true);
      assert.deepEqual(only(warningsOf(result), 'approval_unavailable'), [
        warning('approval_unavailable', 'POST', 'fetch'),
      ]);
      assert.ok(
        result.observation?.changes?.some(c => c.element?.name === 'could not save'),
        JSON.stringify(result.observation),
      );
      const attach = await f.click('Attach');
      assert.equal(attach.write_blocked, true);
      assert.deepEqual(only(warningsOf(attach), 'request_not_approvable'), [
        warning('request_not_approvable', 'POST', 'fetch'),
      ]);
      sentNothing(f.requests);
    }),
);

test(
  'standard: the write is blocked and says the page was not saved; ask mode is named as the way',
  { timeout: 120000 },
  () =>
    // A broker in the environment changes nothing in standard mode: nobody is asked.
    scenario({ mode: 'standard', broker: true }, async (f, broker) => {
      const result = await f.click('Save JSON', { include_diff: true });
      assert.equal(result.ok, true);
      assert.equal(result.network_blocked, true);
      assert.equal(result.write_blocked, true);
      assert.deepEqual(only(warningsOf(result), 'method_requires_approval'), [
        warning('method_requires_approval', 'POST', 'fetch'),
      ]);
      assert.ok(
        result.observation?.changes?.some(c => c.element?.name === 'could not save'),
        JSON.stringify(result.observation),
      );
      const message = safeError(new AdlError('E_POLICY_DENIED', 'method_requires_approval')).safe_message;
      assert.match(message, /ask/);
      assert.match(message, /not saved/);

      const attach = await f.click('Attach');
      assert.equal(attach.write_blocked, true);
      assert.deepEqual(only(warningsOf(attach), 'request_not_approvable'), [
        warning('request_not_approvable', 'POST', 'fetch'),
      ]);
      const xhr = await f.click('Save XHR');
      assert.deepEqual(only(warningsOf(xhr), 'method_requires_approval'), [
        warning('method_requires_approval', 'PUT', 'xhr'),
      ]);
      assert.equal(broker.state.posts, 0, 'nobody was asked');
      sentNothing(f.requests);
    }),
);

test(
  'standard: a blocked checkbox PATCH is write_blocked and the screen keeps the unsaved state',
  { timeout: 120000 },
  () =>
    scenario({ mode: 'standard', broker: false }, async f => {
      const result = await f.check('Done', true);
      assert.equal(result.ok, true);
      assert.equal(result.write_blocked, true);
      assert.equal(result.network_blocked, true);
      assert.deepEqual(only(warningsOf(result), 'method_requires_approval'), [
        warning('method_requires_approval', 'PATCH', 'fetch'),
      ]);
      const observed = await f.observe();
      assert.equal(observed.elements!.find(e => e.name === 'Done')!.checked, true, 'the mismatch the flag names');
      assert.equal(observed.warnings, undefined, 'the block was reported by the action');
      sentNothing(f.requests);
    }),
);

test(
  'standard: a blocked GET fetch is network_blocked without write_blocked, a blocked stylesheet neither',
  { timeout: 120000 },
  () =>
    scenario({ mode: 'standard', broker: false }, async f => {
      const read = await f.click('Fetch elsewhere');
      assert.equal(read.network_blocked, true);
      assert.equal(read.write_blocked, undefined);
      const blocked = only(warningsOf(read), 'origin_not_allowed');
      assert.equal(blocked.length, 1, JSON.stringify(read.warnings));
      assert.equal(blocked[0]!.method, 'GET');
      assert.equal(blocked[0]!.resource_type, 'fetch');

      const sheet = await f.click('Add stylesheet');
      assert.equal(sheet.network_blocked, undefined, JSON.stringify(sheet));
      assert.equal(sheet.write_blocked, undefined, JSON.stringify(sheet));
      assert.equal(sheet.subresources_blocked, 1);
      assert.ok(warningsOf(sheet).some(w => w.resource_type === 'stylesheet' && w.code === 'origin_not_allowed'));
      sentNothing(f.otherRequests);
    }),
);

test(
  'read_only: a write the page sends on its own is background traffic, reported once and never sent',
  { timeout: 120000 },
  () =>
    scenario({ mode: 'read_only', broker: false, start: '/autosave' }, async f => {
      let reported: NetworkWarning[] = [];
      await until(async () => {
        const observed = await f.observe();
        reported = reported.concat(only(warningsOf(observed), 'background_write_blocked'));
        return reported.length > 0;
      }, 'the autosave to be blocked');
      assert.deepEqual(reported, [warning('background_write_blocked', 'POST', 'fetch')]);
      assert.equal((await f.observe()).warnings, undefined, 'reported once');
      sentNothing(f.requests);
    }),
);

test('allowAllOperations: the write is sent as before, nothing is held or flagged', { timeout: 120000 }, () =>
  scenario({ allowAll: true }, async f => {
    const result = await f.click('Save JSON');
    assert.equal(result.ok, true);
    assert.equal(result.write_blocked, undefined);
    assert.equal(result.network_blocked, undefined);
    assert.deepEqual(
      warningsOf(result).filter(w => w.method === 'POST'),
      [],
    );
    await until(async () => (await f.status()) === 'saved', 'the page to see the answer');
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0]!.method, 'POST');
    assert.equal(JSON.parse(f.requests[0]!.body).password, 'hunter22');
    const attach = await f.click('Attach');
    assert.equal(attach.write_blocked, undefined);
    await until(async () => (await f.status()) === 'uploaded', 'the upload');
    assert.equal(f.requests.length, 2);
  }),
);
