import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { BrowserAdapter } from '../src/browser.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import type { Action, AdapterActResult, AdapterSession, NetworkWarning, Target } from '../src/types.js';

// Blocks are scoped: an action's result carries the blocks of its own window, the document's other blocks are reported once by the
// next observation, a navigation takes the old document's blocks with it, and the revision follows a block sequence number, so
// that reporting never changes it while a new block does. Driven at the adapter, without the engine.

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function fixture(mode: 'standard' | 'ask' = 'standard') {
  const posts: string[] = [];
  const foreign = createServer((_req, res) => {
    res.end('');
  });
  const foreignOrigin = await listen(foreign);
  const app = createServer(async (req, res) => {
    for await (const _ of req) void _;
    const url = req.url ?? '/';
    if (req.method === 'POST') {
      posts.push(url);
      res.end('{}');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (url === '/b')
      res.end(
        `<!doctype html><title>B</title><link rel="stylesheet" href="${foreignOrigin}/b.css"><button>On B</button>`,
      );
    else
      res.end(`<!doctype html><title>A</title><img alt="" src="${foreignOrigin}/a.png">
<button onclick="fetch('/api',{method:'POST',body:'x'}).catch(()=>{})">Post now</button>
<button onclick="setTimeout(()=>fetch('/api/later',{method:'POST',body:'y'}).catch(()=>{}),300)">Post later</button>
<button onclick="fetch('/api',{method:'POST',body:'1'}).catch(()=>{});fetch('/api',{method:'POST',body:'2'}).catch(()=>{})">Post twice</button>
<button onclick="const l=document.createElement('link');l.rel='stylesheet';l.href='${foreignOrigin}/mixed.css';document.head.append(l);fetch('/api',{method:'PUT',body:'x'}).catch(()=>{})">Both kinds</button>
<button onclick="history.pushState({},'','/pushed')">Push</button>`);
  });
  const origin = await listen(app);
  const policy = parsePolicy({
    operationMode: mode,
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 5000,
    browserTargets: [{ id: 'p', label: 'Fixture', url: origin, classification: 'PUBLIC' }],
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
  const act = async (action: Action): Promise<void | AdapterActResult> => {
    const signal = new AbortController().signal;
    const prepared = action.element_id ? await session.prepareAction!(action, signal) : undefined;
    return session.act(
      action,
      signal,
      undefined,
      prepared ? { normalOperations: true, approvalProof: prepared.proof, approved: false } : undefined,
    );
  };
  const click = async (name: string) => {
    const element = (await session.snapshot()).elements.find(e => e.name === name);
    assert.ok(element, name);
    return act({ action: 'click', element_id: element.id });
  };
  return {
    session,
    origin,
    posts,
    act,
    click,
    close: async () => {
      await adapter.close();
      for (const server of [app, foreign]) {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    },
  };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const blocksOf = (outcome: void | AdapterActResult): NetworkWarning[] => (outcome ? (outcome.blocks ?? []) : []);
const codes = (warnings: NetworkWarning[] | undefined) =>
  (warnings ?? []).map(w => `${w.code} ${w.method} ${w.resource_type}`).sort();

test(
  'an action result carries the blocks of its window; the next observation does not repeat them',
  { timeout: 60000 },
  async () => {
    const f = await fixture();
    try {
      const first = await f.session.snapshot();
      assert.deepEqual(codes(first.warnings), ['origin_not_allowed GET image'], 'the page-load block of the document');
      assert.ok(first.warningSeq! >= 1);
      f.session.acknowledgeWarnings!(first.warningSeq!);
      const quiet = await f.session.snapshot();
      assert.equal(quiet.warnings, undefined, 'reported once');
      assert.equal(quiet.fingerprint, first.fingerprint, 'reporting never changes the revision');
      assert.equal(quiet.warningSeq, first.warningSeq);

      const outcome = await f.click('Post now');
      assert.deepEqual(codes(blocksOf(outcome)), ['method_requires_approval POST fetch']);
      assert.equal(blocksOf(outcome)[0]!.count, 1);
      const after = await f.session.snapshot();
      assert.equal(after.warnings, undefined, 'the action result already carried it');
      assert.ok(after.warningSeq! > first.warningSeq!, 'every block advances the sequence');
      assert.notEqual(after.fingerprint, quiet.fingerprint, 'a new block is a new revision');
      const again = await f.session.snapshot();
      assert.equal(again.fingerprint, after.fingerprint);
      assert.deepEqual(f.posts, []);
    } finally {
      await f.close();
    }
  },
);

test('a block after the action settled belongs to the document and is reported once', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.session.snapshot();
    f.session.acknowledgeWarnings!(first.warningSeq!);
    const outcome = await f.click('Post later');
    assert.deepEqual(codes(blocksOf(outcome)), [], 'the timer fires after the window closed');
    await sleep(700);
    const late = await f.session.snapshot();
    assert.deepEqual(codes(late.warnings), ['method_requires_approval POST fetch']);
    assert.ok(late.warningSeq! > first.warningSeq!);
    assert.notEqual(late.fingerprint, first.fingerprint);
    // Acknowledging up to an older sequence leaves it; up to the snapshot's own clears it.
    f.session.acknowledgeWarnings!(first.warningSeq!);
    assert.deepEqual(codes((await f.session.snapshot()).warnings), ['method_requires_approval POST fetch']);
    f.session.acknowledgeWarnings!(late.warningSeq!);
    const done = await f.session.snapshot();
    assert.equal(done.warnings, undefined);
    assert.equal(done.fingerprint, late.fingerprint);
    assert.deepEqual(f.posts, []);
  } finally {
    await f.close();
  }
});

test('a navigation takes the unreported blocks of the old document with it', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    // The image block of page A was never reported.
    const outcome = await f.act({ action: 'navigate', url: `${f.origin}/b` });
    assert.ok(!codes(blocksOf(outcome)).some(c => c.endsWith(' image')), JSON.stringify(blocksOf(outcome)));
    const observed = await f.session.snapshot();
    assert.ok(!codes(observed.warnings).some(c => c.endsWith(' image')), JSON.stringify(observed.warnings));
    // Page B's own blocked stylesheet is reported, once, by the navigation's result or the observation.
    const own = [...codes(blocksOf(outcome)), ...codes(observed.warnings)].filter(c => c.endsWith(' stylesheet'));
    assert.deepEqual(own, ['origin_not_allowed GET stylesheet']);
  } finally {
    await f.close();
  }
});

test('a same-document navigation keeps the blocks of the document', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    await f.click('Push');
    const observed = await f.session.snapshot();
    assert.equal(new URL(observed.url!).pathname, '/pushed');
    assert.deepEqual(codes(observed.warnings), ['origin_not_allowed GET image']);
  } finally {
    await f.close();
  }
});

test('writes of one action that are blocked alike merge into one entry with a count', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const outcome = await f.click('Post twice');
    const writes = blocksOf(outcome).filter(w => w.method === 'POST');
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.count, 2);
    assert.deepEqual(f.posts, []);
  } finally {
    await f.close();
  }
});

test('the blocks of an action list what it set in motion first', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    const outcome = await f.click('Both kinds');
    assert.deepEqual(
      blocksOf(outcome).map(w => `${w.method} ${w.resource_type}`),
      ['PUT fetch', 'GET stylesheet'],
    );
  } finally {
    await f.close();
  }
});
