import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { BrowserAdapter } from '../src/browser.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
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

// The browser adapter's write holding, driven without the engine: in ask mode with holding enabled, a main-frame fetch/XHR write
// the page sends while a click runs is paused inside the network route and reported as HeldWritesError after the action's window;
// releasing sends exactly its bytes once, everything else aborts it. The engine (core.ts) turns this into approvals.

type Recorded = { method: string; url: string; contentType: string; body: string };

const page = (api: string, other: string) => `<!doctype html><title>Tasks</title>
<p id="status" role="status">idle</p><ul id="list"></ul>
<button onclick="saveJson()">Save JSON</button>
<button onclick="saveXhr()">Save XHR</button>
<button onclick="saveBoth()">Save both</button>
<button onclick="saveFive()">Save five</button>
<button onclick="attach()">Attach</button>
<button onclick="big()">Save big</button>
<button onclick="withTimeout()">Save with timeout</button>
<button onclick="quickAbort()">Save with quick abort</button>
<button onclick="later()">Save later</button>
<button onclick="beacon()">Send beacon</button>
<button onclick="saveApi()">Save to API origin</button>
<button onclick="saveElsewhere()">Save elsewhere</button>
<button onclick="saveAndLeave()">Save and leave</button>
<ul><li id="milk">Buy milk <button onclick="fired('d1');document.getElementById('milk').remove()">Delete Buy milk</button></li></ul>
<button onclick="fired('d2');fetch('/items/1',{method:'DELETE'}).then(()=>status('deleted'),()=>status('delete failed'))">Delete on server</button>
<button onclick="fired('d3');fetch('/items/1/remove').catch(()=>{})">Delete by read</button>
<button onclick="fired('d4');navigator.sendBeacon('/beacon','x')">Delete quietly</button>
<script>
window.fires=[];window.fired=n=>window.fires.push(n);
const status=t=>{document.getElementById('status').textContent=t};
const done=(ok,bad)=>[()=>status(ok),()=>status(bad)];
function saveJson(){status('saving');fetch('/api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Buy milk',nonce:crypto.randomUUID(),password:'hunter22'})}).then(r=>r.json()).then(()=>{const li=document.createElement('li');li.textContent='Buy milk';document.getElementById('list').append(li);status('saved')},()=>status('could not save'))}
function saveXhr(){const x=new XMLHttpRequest();x.open('PUT','/api/xhr');x.setRequestHeader('content-type','application/x-www-form-urlencoded');x.onload=()=>status('xhr saved');x.onerror=()=>status('xhr failed');x.send('a=b&c=d')}
function saveBoth(){status('saving both');Promise.all([fetch('/api/a',{method:'POST',body:'a'}),fetch('/api/b',{method:'POST',body:'b'})]).then(...done('saved both','could not save both'))}
function saveFive(){status('saving five');Promise.all([0,1,2,3,4].map(i=>fetch('/api/n'+i,{method:'POST',body:String(i)}))).then(...done('saved five','could not save five'))}
function attach(){const f=new FormData();f.append('file',new Blob(['x']),'a.txt');fetch('/api/upload',{method:'POST',body:f}).then(...done('uploaded','upload failed'))}
function big(){fetch('/api/big',{method:'POST',body:'x'.repeat(70000)}).then(...done('big saved','big failed'))}
function withTimeout(){const c=new AbortController();setTimeout(()=>c.abort(),1500);fetch('/api/slowsave',{method:'POST',body:'x',signal:c.signal}).then(...done('saved','timed out'))}
function quickAbort(){const c=new AbortController();setTimeout(()=>c.abort(),100);fetch('/api/quick',{method:'POST',body:'x',signal:c.signal}).then(...done('saved','timed out'))}
function later(){setTimeout(()=>fetch('/api/later',{method:'POST',body:'z'}).then(...done('later saved','later failed')),900)}
function beacon(){navigator.sendBeacon('/api/beacon','x')}
function saveApi(){fetch('${api}/api/tasks',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'cross'})}).then(...done('api saved','api failed'))}
function saveElsewhere(){fetch('${other}/api/tasks',{method:'POST',body:'x'}).then(...done('elsewhere saved','elsewhere failed'))}
function saveAndLeave(){fetch('/api/leave',{method:'POST',body:'x'}).catch(()=>{});setTimeout(()=>{location.href='/other'},50)}
</script>`;

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function recorder(requests: Recorded[], html?: () => string) {
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
    if (req.method === 'GET' && !url.startsWith('/items/') && !url.startsWith('/api/')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(url === '/other' ? '<!doctype html><title>Other</title><button>Elsewhere</button>' : html?.());
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
  holding?: boolean;
  allowAll?: boolean;
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
  const app = recorder(requests, () => page(apiOrigin, otherOrigin));
  const origin = await listen(app);
  const policy = parsePolicy({
    ...(options.allowAll ? { allowAllOperations: true } : { operationMode: options.mode ?? 'ask' }),
    allowedOrigins: options.grantApi ? [origin, apiOrigin] : [origin],
    allowLoopback: true,
    actionTimeoutMs: 5000,
    browserTargets: [{ id: 'p', label: 'Fixture', url: origin + (options.start ?? '/'), classification: 'PUBLIC' }],
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
  if (options.holding !== false && !options.allowAll) session.setWriteHolding!(true);
  const pageOf = () => (session as unknown as { pageValue: Page }).pageValue;
  const status = () => pageOf().evaluate(() => document.getElementById('status')?.textContent ?? '');
  const act = async (action: Action, auth: Partial<ActionAuthorization> = {}): Promise<void | AdapterActResult> => {
    const signal = new AbortController().signal;
    const prepared = action.element_id ? await session.prepareAction!(action, signal) : undefined;
    return session.act(
      action,
      signal,
      undefined,
      options.allowAll
        ? undefined
        : {
            holdWrites: true,
            ...(prepared ? { normalOperations: true, approvalProof: prepared.proof, approved: false } : {}),
            ...auth,
          },
    );
  };
  const click = async (name: string, auth: Partial<ActionAuthorization> = {}) => {
    const snapshot = await session.snapshot();
    const element = snapshot.elements.find(e => e.name === name);
    assert.ok(element, name);
    return act({ action: 'click', element_id: element.id }, auth);
  };
  return {
    session,
    origin,
    apiOrigin,
    otherOrigin,
    requests,
    apiRequests,
    otherRequests,
    status,
    click,
    act,
    close: async () => {
      await adapter.close();
      for (const server of [app, api, other]) {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

// assert.deepEqual(list, []) would narrow the list to never[].
const sentNothing = (list: readonly Recorded[], message?: string) =>
  assert.equal(list.length, 0, message ?? JSON.stringify(list));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(25);
  }
  assert.fail(`timed out waiting for ${what}`);
}
/** Runs the click and returns what it threw. */
async function held(f: Fixture, name: string): Promise<HeldWritesError> {
  const error = await f.click(name).then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(error instanceof HeldWritesError, `${name} should hold its write, got ${String(error)}`);
  assert.equal(error.code, 'E_APPROVAL_REQUIRED');
  assert.equal(error.reason, 'request_requires_approval');
  assert.equal(error.mayHaveExecuted, false, 'the session survives');
  assert.equal(error.detail.page_script_ran, true);
  return error;
}
const blocksOf = (outcome: void | AdapterActResult): NetworkWarning[] => (outcome ? (outcome.blocks ?? []) : []);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const warningsOf = async (f: Fixture) => (await f.session.snapshot()).warnings ?? [];

test(
  'ask: a fetch write is held with its exact description, then released once with exactly its bytes',
  {
    timeout: 60000,
  },
  async () => {
    const f = await fixture();
    try {
      const error = await held(f, 'Save JSON');
      assert.equal(error.hold.requests.length, 1);
      const [request] = error.hold.requests;
      assert.equal(request!.method, 'POST');
      assert.equal(request!.url, `${f.origin}/api/tasks`);
      assert.equal(request!.content_type, 'application/json');
      assert.equal(request!.secret, true, 'the password is masked');
      const lines = request!.details;
      assert.equal(lines[0], `Request POST ${f.origin}/api/tasks`);
      assert.ok(lines.includes('"title": "Buy milk"'), lines.join('\n'));
      assert.ok(lines.includes('"password": [secret, 8 characters]'), lines.join('\n'));
      const nonce = lines.find(line => line.startsWith('"nonce": '))!;
      assert.ok(nonce, lines.join('\n'));
      assert.ok(!lines.join('\n').includes('hunter22'));
      await sleep(300);
      sentNothing(f.requests, 'nothing left the browser');
      assert.equal(await f.status(), 'saving', 'the page is waiting for the answer');
      assert.equal(f.session.heldWritesAlive!(error.hold.id), true);
      assert.equal(f.session.heldWriteOutcome!(error.hold.id), undefined, 'nothing released yet');

      await f.session.releaseHeldWrites!(error.hold.id, Date.now() + 30000);
      await until(() => f.requests.length > 0, 'the released request');
      await until(async () => (await f.status()) === 'saved', 'the page to see the answer');
      const [sent] = f.requests;
      assert.equal(sent!.method, 'POST');
      assert.equal(sent!.url, '/api/tasks');
      assert.equal(sent!.contentType, 'application/json');
      assert.equal(request!.body_sha256, sha(sent!.body), 'exactly the bytes that were described');
      assert.equal(request!.body_length, Buffer.byteLength(sent!.body));
      assert.equal(`"nonce": ${JSON.stringify(JSON.parse(sent!.body).nonce)}`, nonce);
      assert.equal(JSON.parse(sent!.body).password, 'hunter22');
      await until(
        () => f.session.heldWriteOutcome!(error.hold.id) !== undefined,
        'the outcome once the request finished',
      );
      assert.deepEqual(f.session.heldWriteOutcome!(error.hold.id), { dispatched: 1, refused: 0, response_status: 200 });
      assert.equal(f.session.heldWritesAlive!(error.hold.id), false);
      await assert.rejects(f.session.releaseHeldWrites!(error.hold.id, Date.now() + 30000), (e: unknown) => {
        return e instanceof AdlError && e.code === 'E_STALE_STATE';
      });
      await sleep(300);
      assert.equal(f.requests.length, 1, 'sent once');
      assert.deepEqual(await warningsOf(f), [], 'no block to report');
    } finally {
      await f.close();
    }
  },
);

test('ask: every kind of abort sends nothing and tells the page why', { timeout: 90000 }, async () => {
  const f = await fixture();
  try {
    for (const [outcome, code] of [
      ['denied', 'approval_denied'],
      ['expired', 'approval_expired'],
      ['invalidated', 'approval_invalidated'],
      ['not_approvable', 'request_not_approvable'],
    ] as const) {
      const error = await held(f, 'Save JSON');
      await f.session.abortHeldWrites!(error.hold.id, outcome);
      await until(async () => (await f.status()) === 'could not save', `${outcome}: the page's own failure message`);
      sentNothing(f.requests, `${outcome}: nothing was sent`);
      const warnings = await warningsOf(f);
      assert.deepEqual(
        warnings.filter(w => w.code === code),
        [{ code, count: 1, resource_type: 'fetch', method: 'POST' }],
        `${outcome}: the next observation says why the save failed, once`,
      );
      const seq = (await f.session.snapshot()).warningSeq!;
      f.session.acknowledgeWarnings!(seq);
      assert.deepEqual(await warningsOf(f), [], `${outcome}: reported once`);
      await f.session.abortHeldWrites!(error.hold.id, 'denied'); // an unknown id is a no-op
    }
    assert.equal(f.session.heldWritesAlive!('unknown'), false);
  } finally {
    await f.close();
  }
});

test(
  'ask: a release after the approval expired is refused at dispatch like the form permit',
  { timeout: 60000 },
  async () => {
    const f = await fixture();
    try {
      const error = await held(f, 'Save JSON');
      await f.session.releaseHeldWrites!(error.hold.id, Date.now() - 1000);
      await until(async () => (await f.status()) === 'could not save', 'the page to see the refusal');
      sentNothing(f.requests, 'an expired approval sends nothing');
      await until(
        () => f.session.heldWriteOutcome!(error.hold.id) !== undefined,
        'the outcome once the request finished',
      );
      assert.deepEqual(
        f.session.heldWriteOutcome!(error.hold.id),
        { dispatched: 0, refused: 1 },
        'refused at dispatch: finished without an answer',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'ask: another action while a set is held runs, and its write is blocked as pending-other',
  { timeout: 60000 },
  async () => {
    const f = await fixture();
    try {
      const error = await held(f, 'Save JSON');
      const outcome = await f.click('Save XHR');
      assert.ok(
        blocksOf(outcome).some(
          w => w.code === 'approval_pending_other_action' && w.method === 'PUT' && w.resource_type === 'xhr',
        ),
        JSON.stringify(blocksOf(outcome)),
      );
      await sleep(200);
      sentNothing(f.requests);
      assert.equal(f.session.heldWritesAlive!(error.hold.id), true, 'the first set is still pending');
      await f.session.abortHeldWrites!(error.hold.id, 'denied');
    } finally {
      await f.close();
    }
  },
);

test('ask: parallel writes of one action are one set, released together', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const error = await held(f, 'Save both');
    assert.deepEqual(error.hold.requests.map(r => `${r.method} ${new URL(r.url).pathname}`).sort(), [
      'POST /api/a',
      'POST /api/b',
    ]);
    const lines = error.hold.requests.flatMap(r => r.details);
    assert.ok(lines.length <= 25);
    sentNothing(f.requests);
    await f.session.releaseHeldWrites!(error.hold.id, Date.now() + 30000);
    await until(async () => (await f.status()) === 'saved both', 'both answers');
    assert.deepEqual(f.requests.map(r => r.url).sort(), ['/api/a', '/api/b']);
  } finally {
    await f.close();
  }
});

test('ask: a fifth parallel write fails the whole set closed', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const error = await f.click('Save five').then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(error instanceof AdlError && !(error instanceof HeldWritesError), String(error));
    assert.equal(error.code, 'E_APPROVAL_REQUIRED');
    assert.equal(error.reason, 'request_not_approvable');
    assert.equal(error.detail.page_script_ran, true);
    assert.equal(error.mayHaveExecuted, false);
    await until(async () => (await f.status()) === 'could not save five', 'the page to see the failure');
    sentNothing(f.requests, 'not even the first four were sent');
    assert.ok((await f.session.snapshot()).elements.length > 0, 'the session survives');
    assert.equal(f.session.heldWritesAlive!('anything'), false);
  } finally {
    await f.close();
  }
});

test(
  'ask: uploads, large bodies and beacons are not approvable, and blocked with that code',
  { timeout: 60000 },
  async () => {
    const f = await fixture();
    try {
      for (const [name, resourceType] of [
        ['Attach', 'fetch'],
        ['Save big', 'fetch'],
        ['Send beacon', 'other'],
      ] as const) {
        const outcome = await f.click(name);
        assert.ok(
          blocksOf(outcome).some(
            w => w.code === 'request_not_approvable' && w.method === 'POST' && w.resource_type === resourceType,
          ),
          `${name}: ${JSON.stringify(blocksOf(outcome))}`,
        );
      }
      await sleep(200);
      sentNothing(f.requests);
    } finally {
      await f.close();
    }
  },
);

test('ask: a write after the action settled is background traffic and never held', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const before = (await f.session.snapshot()).fingerprint;
    const outcome = await f.click('Save later');
    assert.deepEqual(
      blocksOf(outcome).filter(w => w.method === 'POST'),
      [],
      'it belongs to no action',
    );
    await until(async () => (await f.status()) === 'later failed', 'the timer write');
    const observed = await f.session.snapshot();
    assert.deepEqual(
      (observed.warnings ?? []).filter(w => w.method === 'POST'),
      [{ code: 'background_write_blocked', count: 1, resource_type: 'fetch', method: 'POST' }],
    );
    assert.notEqual(observed.fingerprint, before, 'a new block is a new revision');
    sentNothing(f.requests);
  } finally {
    await f.close();
  }
});

test('ask: the page giving up on a held write abandons the hold', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const error = await held(f, 'Save with timeout');
    assert.equal(f.session.heldWritesAlive!(error.hold.id), true);
    await until(() => !f.session.heldWritesAlive!(error.hold.id), 'the page to abort its request', 5000);
    await until(async () => (await f.status()) === 'timed out', "the page's own timeout message");
    await assert.rejects(
      f.session.releaseHeldWrites!(error.hold.id, Date.now() + 30000),
      (e: unknown) => e instanceof AdlError && e.code === 'E_STALE_STATE',
    );
    await f.session.abortHeldWrites!(error.hold.id, 'invalidated');
    await sleep(200);
    sentNothing(f.requests, 'nothing is sent for a request the page cancelled');
  } finally {
    await f.close();
  }
});

test('ask: a page that cancels its write inside the window leaves nothing to approve', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    // The page aborts its fetch 100 ms after the click, before the action's window closes: the request is gone, so there is no set
    // to hand over and no human is asked. The action reports what happened to the write as a block.
    const outcome = await f.click('Save with quick abort');
    assert.ok(
      blocksOf(outcome).some(w => w.code === 'request_denied' && w.method === 'POST' && w.resource_type === 'fetch'),
      JSON.stringify(blocksOf(outcome)),
    );
    assert.equal(await f.status(), 'timed out');
    sentNothing(f.requests);
    assert.equal(f.session.heldWritesAlive!('anything'), false);
  } finally {
    await f.close();
  }
});

test(
  'ask: an abandoned set keeps blocking other writes until the engine withdraws it',
  { timeout: 60000 },
  async () => {
    const f = await fixture();
    try {
      const error = await held(f, 'Save with timeout');
      await until(() => !f.session.heldWritesAlive!(error.hold.id), 'the abandoned hold');
      const outcome = await f.click('Save XHR');
      assert.ok(
        blocksOf(outcome).some(w => w.method === 'PUT' && w.code === 'approval_pending_other_action'),
        JSON.stringify(blocksOf(outcome)),
      );
      await f.session.abortHeldWrites!(error.hold.id, 'invalidated');
      const again = await f.click('Save XHR').then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(again instanceof HeldWritesError, 'a withdrawn set no longer blocks: the next write is held');
      await f.session.abortHeldWrites!(again.hold.id, 'denied');
    } finally {
      await f.close();
    }
  },
);

test('ask: a navigation aborts the held write silently', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const error = await held(f, 'Save JSON');
    assert.equal(f.session.heldWritesAlive!(error.hold.id), true);
    await f.act({ action: 'navigate', url: `${f.origin}/other` });
    assert.equal(f.session.heldWritesAlive!(error.hold.id), false, 'the request died with its document');
    await sleep(200);
    sentNothing(f.requests);
    assert.deepEqual(await warningsOf(f), [], 'the replaced document takes its blocks with it');
    await assert.rejects(
      f.session.releaseHeldWrites!(error.hold.id, Date.now() + 30000),
      (e: unknown) => e instanceof AdlError && e.code === 'E_STALE_STATE',
    );
  } finally {
    await f.close();
  }
});

test('ask: a page that navigates away right after its write never gets it sent', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    // "Save and leave" posts and navigates 50 ms later. The request can be denied before the new document commits, silently
    // abandoned when the document changes, or returned as a hold that dies with the document. None of those paths may send it.
    const outcome = await f.click('Save and leave').then(
      value => ({ value }),
      (error: unknown) => ({ error }),
    );
    let id: string | undefined;
    if ('error' in outcome) {
      assert.ok(outcome.error instanceof HeldWritesError, String(outcome.error));
      id = outcome.error.hold.id;
    }
    await until(async () => (await f.session.snapshot()).title === 'Other', 'the page to have left');
    await sleep(200);
    sentNothing(f.requests);
    assert.equal(f.session.heldWritesAlive!(id ?? 'anything'), false);
    if ('value' in outcome) {
      const blocks = blocksOf(outcome.value);
      if (blocks.length) {
        assert.deepEqual(blocks, [{ code: 'request_denied', count: 1, method: 'POST', resource_type: 'fetch' }]);
      }
    }
  } finally {
    await f.close();
  }
});

test(
  'ask: a Delete control is contained only when the engine lets its writes be held',
  { timeout: 60000 },
  async () => {
    const f = await fixture();
    try {
      const refused = await f.click('Delete Buy milk', { holdWrites: false }).then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(refused instanceof AdlError, String(refused));
      assert.equal(refused.reason, 'requires_ask_mode');
      const fires = await (f.session as unknown as { pageValue: Page }).pageValue.evaluate(
        () => (window as unknown as { fires: string[] }).fires,
      );
      assert.deepEqual(fires, [], 'nothing was dispatched');
      // An approved dispatch is not contained, but its write is still held (the label was approved, not the request).
      const approved = await f.click('Delete on server', { approved: true, expires_at: Date.now() + 30000 }).then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(approved instanceof HeldWritesError, String(approved));
      assert.equal(approved.hold.requests[0]!.details[0], `Request DELETE ${f.origin}/items/1`);
      await f.session.abortHeldWrites!(approved.hold.id, 'denied');
    } finally {
      await f.close();
    }
  },
);

test('ask: a same-document navigation keeps the held write', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const error = await held(f, 'Save JSON');
    // pushState and hash changes replace no document: the page's request is still waiting for its answer.
    await (f.session as unknown as { pageValue: Page }).pageValue.evaluate(() => {
      history.pushState({}, '', '/pushed');
      location.hash = 'x';
    });
    await sleep(300);
    assert.equal(f.session.heldWritesAlive!(error.hold.id), true);
    await f.session.releaseHeldWrites!(error.hold.id, Date.now() + 30000);
    await until(() => f.requests.length === 1, 'the released request');
  } finally {
    await f.close();
  }
});

test('ask: closing the session aborts held writes without hanging', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const error = await held(f, 'Save JSON');
    const closing = f.session.close();
    await Promise.race([closing, sleep(10000).then(() => assert.fail('close() hung on a held request'))]);
    assert.equal(f.session.heldWritesAlive!(error.hold.id), false);
    sentNothing(f.requests);
  } finally {
    await f.close();
  }
});

test(
  'ask: a write to a granted other origin is held with its full URL; an ungranted origin stays blocked',
  {
    timeout: 60000,
  },
  async () => {
    const f = await fixture({ grantApi: true });
    try {
      const error = await held(f, 'Save to API origin');
      assert.equal(error.hold.requests[0]!.details[0], `Request POST ${f.apiOrigin}/api/tasks`);
      sentNothing(f.apiRequests);
      await f.session.releaseHeldWrites!(error.hold.id, Date.now() + 30000);
      await until(() => f.apiRequests.length > 0, 'the released cross-origin write');
      await until(async () => (await f.status()) === 'api saved', 'the page to see the answer');
      assert.equal(f.apiRequests.length, 1);
      assert.equal(f.apiRequests[0]!.method, 'POST');
      assert.equal(JSON.parse(f.apiRequests[0]!.body).title, 'cross');

      const outcome = await f.click('Save elsewhere');
      assert.ok(
        blocksOf(outcome).some(
          w =>
            w.code === 'origin_not_allowed' &&
            w.method === 'POST' &&
            w.resource_type === 'fetch' &&
            w.origin === f.otherOrigin,
        ),
        JSON.stringify(blocksOf(outcome)),
      );
      sentNothing(f.otherRequests);
    } finally {
      await f.close();
    }
  },
);

test('an origin grant alone does not let a write through when nothing can hold it', { timeout: 60000 }, async () => {
  const f = await fixture({ grantApi: true, holding: false });
  try {
    const outcome = await f.click('Save to API origin');
    assert.ok(
      blocksOf(outcome).some(w => w.code === 'origin_not_allowed' && w.method === 'POST'),
      JSON.stringify(blocksOf(outcome)),
    );
    sentNothing(f.apiRequests);
  } finally {
    await f.close();
  }
});

test(
  'ask without an approver, standard and read_only never hold, and the codes say why',
  { timeout: 120000 },
  async () => {
    const askWithout = await fixture({ mode: 'ask', holding: false });
    try {
      const outcome = await askWithout.click('Save JSON');
      assert.deepEqual(
        blocksOf(outcome).filter(w => w.method === 'POST'),
        [{ code: 'approval_unavailable', count: 1, resource_type: 'fetch', method: 'POST' }],
      );
      const attach = await askWithout.click('Attach');
      assert.ok(blocksOf(attach).some(w => w.code === 'request_not_approvable'));
      sentNothing(askWithout.requests);
    } finally {
      await askWithout.close();
    }
    const standard = await fixture({ mode: 'standard', holding: false });
    try {
      const outcome = await standard.click('Save JSON');
      assert.deepEqual(
        blocksOf(outcome).filter(w => w.method === 'POST'),
        [{ code: 'method_requires_approval', count: 1, resource_type: 'fetch', method: 'POST' }],
      );
      const attach = await standard.click('Attach');
      assert.ok(blocksOf(attach).some(w => w.code === 'request_not_approvable'));
      const beacon = await standard.click('Send beacon');
      assert.ok(blocksOf(beacon).some(w => w.code === 'request_not_approvable' && w.resource_type === 'other'));
      sentNothing(standard.requests);
    } finally {
      await standard.close();
    }
  },
);

test('holdWrites without the session flag, and allowAllOperations, hold nothing', { timeout: 120000 }, async () => {
  // The authorization alone is not enough: the engine enables holding on the session.
  const notEnabled = await fixture({ holding: false });
  try {
    const outcome = await notEnabled.click('Save JSON', { holdWrites: true });
    assert.ok(blocksOf(outcome).some(w => w.code === 'approval_unavailable'));
  } finally {
    await notEnabled.close();
  }
  // Enabled on the session but not authorized for the action: blocked as background, never held.
  const unauthorized = await fixture();
  try {
    const outcome = await unauthorized.click('Save JSON', { holdWrites: false });
    assert.ok(
      blocksOf(outcome).some(w => w.code === 'background_write_blocked'),
      JSON.stringify(blocksOf(outcome)),
    );
    sentNothing(unauthorized.requests);
  } finally {
    await unauthorized.close();
  }
  const all = await fixture({ allowAll: true });
  try {
    const outcome = await all.click('Save JSON');
    assert.deepEqual(blocksOf(outcome), []);
    await until(() => all.requests.length === 1, 'the unrestricted write');
  } finally {
    await all.close();
  }
});

test('read_only: a write the page makes on its own is background traffic', { timeout: 60000 }, async () => {
  const f = await fixture({ mode: 'read_only', holding: false });
  try {
    await f.session.snapshot();
    await f.act({ action: 'scroll', direction: 'down' }).catch(() => undefined);
    // Page-driven write without any action: send one from the page itself.
    await (f.session as unknown as { pageValue: Page }).pageValue.evaluate(() => {
      void fetch('/api/autosave', { method: 'POST', body: 'x' }).catch(() => undefined);
    });
    await until(
      async () => (await warningsOf(f)).some(w => w.code === 'background_write_blocked' && w.method === 'POST'),
      'the background block',
    );
    sentNothing(f.requests);
  } finally {
    await f.close();
  }
});

test(
  'ask: a contained Delete asks only for its write, and stops on anything it reads',
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      const local = await f.click('Delete Buy milk');
      assert.ok((local as AdapterActResult).warnings?.some(w => w.code === 'contained_action'));
      assert.deepEqual(blocksOf(local), []);
      sentNothing(f.requests);

      const error = await held(f, 'Delete on server');
      assert.deepEqual(error.hold.requests[0]!.details, [`Request DELETE ${f.origin}/items/1`, '(no body)']);
      sentNothing(f.requests);
      await f.session.releaseHeldWrites!(error.hold.id, Date.now() + 30000);
      await until(() => f.requests.length === 1, 'the released DELETE');
      assert.equal(f.requests[0]!.method, 'DELETE');
      assert.equal(f.requests[0]!.url, '/items/1');

      const read = await f.click('Delete by read').then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(read instanceof AdlError && !(read instanceof HeldWritesError), String(read));
      assert.equal(read.code, 'E_APPROVAL_REQUIRED');
      assert.equal(read.reason, 'contained_request_blocked');
      assert.equal(read.detail.page_script_ran, true);
      assert.equal(read.mayHaveExecuted, false);
      // An action that ended with an error reports nothing itself: what it caused shows once in the next observation.
      assert.deepEqual(
        (await warningsOf(f)).filter(w => w.code === 'contained_request_blocked'),
        [{ code: 'contained_request_blocked', count: 1, resource_type: 'fetch', method: 'GET' }],
      );

      const beacon = await f.click('Delete quietly').then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(beacon instanceof AdlError && !(beacon instanceof HeldWritesError), String(beacon));
      assert.equal(beacon.reason, 'request_not_approvable');
      assert.equal(beacon.detail.page_script_ran, true);
      await sleep(200);
      assert.deepEqual(
        f.requests.map(r => `${r.method} ${r.url}`),
        ['DELETE /items/1'],
        'nothing but the approved DELETE left',
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'standard: a contained Delete that writes says what ask mode would do, or that nothing can',
  { timeout: 120000 },
  async () => {
    const f = await fixture({ mode: 'standard', holding: false });
    try {
      const write = await f.click('Delete on server').then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(write instanceof AdlError, String(write));
      assert.equal(write.reason, 'requires_ask_mode');
      assert.equal(write.detail.page_script_ran, true);
      const read = await f.click('Delete by read').then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(read instanceof AdlError, String(read));
      assert.equal(read.reason, 'contained_request_blocked');
      const beacon = await f.click('Delete quietly').then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(beacon instanceof AdlError, String(beacon));
      assert.equal(beacon.reason, 'request_not_approvable');
      sentNothing(f.requests);
    } finally {
      await f.close();
    }
  },
);

test('ask: the unreleased set is aborted when its time is up', { timeout: 60000 }, async () => {
  // The adapter does not wait for ever: the set it handed over is aborted by the lifetime timer. The timer is long, so this only
  // checks that an explicit abort clears it (no stray timer keeps the process alive) and that a second abort is harmless.
  const f = await fixture();
  try {
    const error = await held(f, 'Save JSON');
    await f.session.abortHeldWrites!(error.hold.id, 'expired');
    await f.session.abortHeldWrites!(error.hold.id, 'expired');
    await until(async () => (await f.status()) === 'could not save', 'the page to see the failure');
  } finally {
    await f.close();
  }
});
