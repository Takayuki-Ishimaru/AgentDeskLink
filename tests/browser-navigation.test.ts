import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {BrowserAdapter} from '../src/browser.js';
import {AdlError, type PolicyConfig, type Target} from '../src/types.js';

const HOME_HTML = `<html><body>
<a id="next" href="/next">Next</a>
<a id="extlink" href="/next">Ext</a>
<button id="delayed" type="button" onclick="setTimeout(()=>{location.href='/next'},150)">Delayed</button>
<button id="hashbtn" type="button" onclick="location.hash='x'">Hash</button>
<button id="pushbtn" type="button" onclick="history.pushState({},'','/p1')">Push</button>
<input id="keepfield" aria-label="Keep field">
</body></html>`;
const NEXT_HTML = `<html><body><h1>Next page</h1><a id="back" href="/">Back</a><input id="dest" aria-label="Destination"></body></html>`;

async function fixture() {
  let nextRequests = 0;
  const foreign = createServer((_q, r) => {r.setHeader('content-type', 'text/html'); r.end('<html><body>foreign</body></html>');});
  await new Promise<void>((r) => foreign.listen(0, '127.0.0.1', r));
  const foreignOrigin = `http://127.0.0.1:${(foreign.address() as {port: number}).port}`;
  const app = createServer((q, r) => {
    r.setHeader('content-type', 'text/html');
    if (q.url === '/next') {nextRequests++; r.end(NEXT_HTML); return;}
    if ((q.url ?? '').startsWith('/ext/')) {r.end(HOME_HTML.replace('id="extlink" href="/next"', `id="extlink" href="http://127.0.0.1:${q.url!.slice(5)}/x"`)); return;}
    r.end(HOME_HTML);
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(app.address() as {port: number}).port}`;
  const config: PolicyConfig = {allowedOrigins: [origin], browserTargets: [{id: 'nav', label: 'Nav', url: origin, classification: 'PUBLIC', controls: [
    {selector: '#next', actions: ['click']}, {selector: '#back', actions: ['click']}, {selector: '#extlink', actions: ['click']},
    {selector: '#delayed', actions: ['click']}, {selector: '#hashbtn', actions: ['click']}, {selector: '#pushbtn', actions: ['click']},
    {selector: '#dest', actions: ['fill']}, {selector: '#keepfield', actions: ['fill']}]}],
    allowLoopback: true, allowPrivateNetwork: false, maxSessions: 4, sessionTtlMs: 60000, maxBatchSteps: 20,
    defaultTokenBudget: 1800, maxElements: 1000, actionTimeoutMs: 3000};
  const guard = async (url: string) => {if (new URL(url).origin !== origin) throw new AdlError('E_POLICY_DENIED');};
  const adapter = new BrowserAdapter(config, guard);
  const target: Target = {target_id: 't_nav', application_id: 'nav', label: 'Nav', surface: 'browser', policy_class: 'PUBLIC', capabilities: []};
  return {adapter, target, origin, foreignPort: new URL(foreignOrigin).port, nextRequests: () => nextRequests, close: async () => {await adapter.close(); await Promise.all([new Promise<void>((r) => app.close(() => r())), new Promise<void>((r) => foreign.close(() => r()))]);}};
}
const sig = () => new AbortController().signal;
const byName = (p: {elements: {name?: string; id: string; value?: string}[]}, name: string) => p.elements.find((e) => e.name === name)!;

test('same-origin link click rebuilds the store; old ids rejected, new ids usable, repeated clicks', {timeout: 30000}, async () => {
  const f = await fixture();
  try {
    const s = await f.adapter.open(f.target, 'strict_isolated', sig());
    const a = await s.snapshot();
    const oldNext = byName(a, 'Next').id;
    await s.act({action: 'click', element_id: oldNext}, sig());
    const b = await s.snapshot();
    assert.ok(b.elements.some((e) => e.role === 'heading' && e.name === 'Next page'));
    await assert.rejects(s.act({action: 'fill', element_id: oldNext, value: 'x'}, sig()), {code: 'E_TARGET_NOT_FOUND'});
    await s.act({action: 'fill', element_id: byName(b, 'Destination').id, value: 'typed'}, sig());
    assert.equal(byName(await s.snapshot(), 'Destination').value, 'typed');
    await s.act({action: 'click', element_id: byName(b, 'Back').id}, sig());
    const c = await s.snapshot();
    assert.ok(c.elements.some((e) => e.name === 'Keep field'));
    await s.act({action: 'click', element_id: byName(c, 'Next').id}, sig());
    const d = await s.snapshot();
    assert.ok(d.elements.some((e) => e.role === 'heading' && e.name === 'Next page'));
    await s.close();
  } finally {await f.close();}
});

test('same-document hash and pushState navigations keep element ids stable', {timeout: 30000}, async () => {
  const f = await fixture();
  try {
    const s = await f.adapter.open(f.target, 'strict_isolated', sig());
    const a = await s.snapshot();
    const keepId = byName(a, 'Keep field').id;
    await s.act({action: 'click', element_id: byName(a, 'Hash').id}, sig());
    await s.act({action: 'click', element_id: byName(a, 'Push').id}, sig());
    const b = await s.snapshot();
    assert.equal(byName(b, 'Keep field').id, keepId);
    await s.close();
  } finally {await f.close();}
});

test('document navigation delayed past the action is recovered on the next observation', {timeout: 30000}, async () => {
  const f = await fixture();
  try {
    const s = await f.adapter.open(f.target, 'strict_isolated', sig());
    const a = await s.snapshot();
    const before = f.nextRequests();
    await s.act({action: 'click', element_id: byName(a, 'Delayed').id}, sig());
    // The action returned before the delayed navigation was even requested.
    assert.equal(f.nextRequests(), before);
    let b: Awaited<ReturnType<typeof s.snapshot>> | null = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      b = await s.snapshot();
      if (b.elements.some((e) => e.role === 'heading' && e.name === 'Next page')) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(b && b.elements.some((e) => e.role === 'heading' && e.name === 'Next page'));
    assert.ok(f.nextRequests() > before);
    await assert.rejects(s.act({action: 'click', element_id: byName(a, 'Next').id}, sig()), {code: 'E_TARGET_NOT_FOUND'});
    await s.close();
  } finally {await f.close();}
});

test('cross-origin link click denies the next observation and closes the session', {timeout: 30000}, async () => {
  const f = await fixture();
  try {
    const s = await f.adapter.open(f.target, 'strict_isolated', sig());
    await s.act({action: 'navigate', url: `${f.origin}/ext/${f.foreignPort}`}, sig());
    const a = await s.snapshot();
    await s.act({action: 'click', element_id: byName(a, 'Ext').id}, sig());
    await assert.rejects(s.snapshot(), (e: AdlError) => e.code === 'E_POLICY_DENIED' || e.code === 'E_TARGET_NOT_FOUND');
    await assert.rejects(s.snapshot(), {code: 'E_TARGET_NOT_FOUND'});
    await s.close();
  } finally {await f.close();}
});

test('cancellation before a navigating click dispatch preserves the session', {timeout: 30000}, async () => {
  const f = await fixture();
  try {
    const s = await f.adapter.open(f.target, 'strict_isolated', sig());
    const a = await s.snapshot();
    const c = new AbortController();
    const p = s.act({action: 'click', element_id: byName(a, 'Next').id}, c.signal);
    c.abort();
    await assert.rejects(p,(error:AdlError)=>error.code==='E_CANCELLED'&&!error.mayHaveExecuted);
    assert.ok((await s.snapshot()).elements.some(e=>e.name==='Next'));
    assert.equal(f.nextRequests(),0);
    await s.close();
  } finally {await f.close();}
});

// Recovery-budget regressions. These intercept the session's own private
// methods through a cast so the race is deterministic without any product hook.
type StoreHandle = {evaluate: (fn: (value: unknown) => unknown) => Promise<unknown>};
type SessionInternals = {
  store: StoreHandle | null;
  collectSnapshot(store: StoreHandle, cfg: unknown, signal?: AbortSignal): Promise<unknown>;
  assertIntegrity(signal?: AbortSignal): Promise<void>;
  pageValue: {goto: (url: string, opts?: {waitUntil?: string}) => Promise<unknown>} | null;
};
const internals = (s: object) => s as unknown as SessionInternals;
const DESTROYED = 'Execution context was destroyed during collection';

test('snapshot recovery budget spans collection and final integrity', {timeout: 30000}, async () => {
  const f = await fixture();
  try {
    const s = await f.adapter.open(f.target, 'strict_isolated', sig());
    const held = internals(s);
    const navigate = async () => {await held.pageValue!.goto(`${f.origin}/next`, {waitUntil: 'load'});};
    const before = f.nextRequests();
    let collects = 0;
    const realCollect = held.collectSnapshot.bind(held);
    held.collectSnapshot = async (h, cfg, signal) => {
      collects++;
      if (collects === 1) {await navigate(); throw new Error(DESTROYED);}
      return realCollect(h, cfg, signal);
    };
    const realIntegrity = held.assertIntegrity.bind(held);
    held.assertIntegrity = async (signal) => {await navigate(); await realIntegrity(signal);};
    // One recovery was already spent on the collection race, so the second
    // confirmed navigation must fail closed instead of collecting a third time.
    await assert.rejects(s.snapshot(), {code: 'E_STALE_STATE'});
    assert.equal(collects, 2);
    assert.equal(f.nextRequests(), before + 2);
    held.collectSnapshot = realCollect;
    held.assertIntegrity = realIntegrity;
    const b = await s.snapshot();
    assert.ok(b.elements.some((e) => e.role === 'heading' && e.name === 'Next page'));
    assert.equal(f.nextRequests(), before + 2);
    await s.close();
  } finally {await f.close();}
});

test('final integrity navigation recovers once with fresh element IDs', {timeout: 30000}, async () => {
  const f = await fixture();
  try {
    const s = await f.adapter.open(f.target, 'strict_isolated', sig());
    const held = internals(s);
    const a = await s.snapshot();
    const oldNext = byName(a, 'Next').id;
    const before = f.nextRequests();
    let collects = 0;
    const realCollect = held.collectSnapshot.bind(held);
    held.collectSnapshot = (h, cfg, signal) => {collects++; return realCollect(h, cfg, signal);};
    // The navigation commits after the old document was collected and before
    // the snapshot validated integrity.
    let fired = false;
    const realIntegrity = held.assertIntegrity.bind(held);
    held.assertIntegrity = async (signal) => {
      if (!fired) {fired = true; await held.pageValue!.goto(`${f.origin}/next`, {waitUntil: 'load'});}
      await realIntegrity(signal);
    };
    const b = await s.snapshot();
    assert.equal(collects, 2);
    assert.ok(b.elements.some((e) => e.role === 'heading' && e.name === 'Next page'));
    assert.ok(!b.elements.some((e) => e.name === 'Next' && e.id === oldNext));
    assert.equal(f.nextRequests(), before + 1);
    await assert.rejects(s.act({action: 'fill', element_id: oldNext, value: 'x'}, sig()), {code: 'E_TARGET_NOT_FOUND'});
    held.assertIntegrity = realIntegrity;
    const c = await s.snapshot();
    assert.ok(c.elements.some((e) => e.role === 'heading' && e.name === 'Next page'));
    assert.ok(c.elements.some((e) => e.name === 'Destination' && e.id !== oldNext));
    await s.act({action: 'fill', element_id: byName(c, 'Destination').id, value: 'typed'}, sig());
    assert.equal(byName(await s.snapshot(), 'Destination').value, 'typed');
    await s.close();
  } finally {await f.close();}
});

test('repeated final integrity navigation is bounded at two attempts', {timeout: 30000}, async () => {
  const f = await fixture();
  try {
    const s = await f.adapter.open(f.target, 'strict_isolated', sig());
    const held = internals(s);
    const before = f.nextRequests();
    let collects = 0;
    const realCollect = held.collectSnapshot.bind(held);
    held.collectSnapshot = (h, cfg, signal) => {collects++; return realCollect(h, cfg, signal);};
    const realIntegrity = held.assertIntegrity.bind(held);
    held.assertIntegrity = async (signal) => {await held.pageValue!.goto(`${f.origin}/next`, {waitUntil: 'load'}); await realIntegrity(signal);};
    await assert.rejects(s.snapshot(), {code: 'E_STALE_STATE'});
    assert.equal(collects, 2);
    assert.equal(f.nextRequests(), before + 2);
    held.assertIntegrity = realIntegrity;
    assert.ok((await s.snapshot()).elements.some((e) => e.role === 'heading' && e.name === 'Next page'));
    await s.close();
  } finally {await f.close();}
});

test('E_STALE_STATE from a live store context is not retried', {timeout: 30000}, async () => {
  const f = await fixture();
  try {
    const s = await f.adapter.open(f.target, 'strict_isolated', sig());
    const held = internals(s);
    const store = held.store!;
    let collects = 0;
    const realCollect = held.collectSnapshot.bind(held);
    held.collectSnapshot = (h, cfg, signal) => {collects++; return realCollect(h, cfg, signal);};
    const realIntegrity = held.assertIntegrity.bind(held);
    held.assertIntegrity = async () => {await store.evaluate(() => undefined); throw new AdlError('E_STALE_STATE');};
    await assert.rejects(s.snapshot(), {code: 'E_STALE_STATE'});
    assert.equal(collects, 1);
    held.assertIntegrity = realIntegrity;
    assert.ok((await s.snapshot()).elements.some((e) => e.name === 'Next'));
    await s.close();
  } finally {await f.close();}
});

test('privacy, cancellation and timeout failures are never retried', {timeout: 30000}, async () => {
  const f = await fixture();
  try {
    const s = await f.adapter.open(f.target, 'strict_isolated', sig());
    const held = internals(s);
    let collects = 0;
    const realCollect = held.collectSnapshot.bind(held);
    held.collectSnapshot = (h, cfg, signal) => {collects++; return realCollect(h, cfg, signal);};
    const realIntegrity = held.assertIntegrity.bind(held);
    for (const error of [new AdlError('E_PRIVACY_BLOCKED', 'untrusted_dom_api'), new AdlError('E_CANCELLED'), new AdlError('E_TIMEOUT')]) {
      collects = 0;
      held.assertIntegrity = async () => {throw error;};
      await assert.rejects(s.snapshot(), {code: error.code});
      assert.equal(collects, 1);
    }
    held.assertIntegrity = realIntegrity;
    assert.ok((await s.snapshot()).elements.some((e) => e.name === 'Next'));
    await s.close();
  } finally {await f.close();}
});

test('cancellation after a confirmed navigation does not recover', {timeout: 30000}, async () => {
  const f = await fixture();
  try {
    const s = await f.adapter.open(f.target, 'strict_isolated', sig());
    const held = internals(s);
    const before = f.nextRequests();
    const realIntegrity = held.assertIntegrity.bind(held);
    const c = new AbortController();
    held.assertIntegrity = async (signal) => {await held.pageValue!.goto(`${f.origin}/next`, {waitUntil: 'load'}); c.abort(); await realIntegrity(signal);};
    await assert.rejects(s.snapshot(c.signal), {code: 'E_CANCELLED'});
    assert.equal(f.nextRequests(), before + 1);
    held.assertIntegrity = realIntegrity;
    assert.ok((await s.snapshot()).elements.some((e) => e.role === 'heading' && e.name === 'Next page'));
    await s.close();
  } finally {await f.close();}
});
