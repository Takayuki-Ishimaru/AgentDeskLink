import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Page } from 'playwright';
import { BrowserAdapter } from '../src/browser.js';
import { inspectBrowserAction } from '../src/browser-approval.js';
import { Engine } from '../src/core.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import type { AdapterSession } from '../src/types.js';
import { stubBroker } from './approval-broker-stub.js';

async function fixture(html: string) {
  const broker = await stubBroker();
  let writes = 0;
  const server = createServer((req, res) => {
    if (req.method !== 'GET') writes++;
    res.setHeader('content-type', 'text/html');
    res.end(req.method === 'GET' ? '<!doctype html>' + html : 'ok');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const policy = parsePolicy({
    operationMode: 'ask',
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 5000,
    browserTargets: [{ id: 'p', label: 'Fixture', url: origin, classification: 'PUBLIC' }],
  });
  const adapter = new BrowserAdapter(policy, (url, purpose) => assertUrlAllowed(url, policy, undefined, purpose));
  let session!: AdapterSession;
  const open = adapter.open.bind(adapter);
  adapter.open = async (...args) => (session = await open(...args));
  const engine = new Engine(policy, { browser: adapter });
  const opened = await engine.open((await engine.listTargets()).targets[0]!.target_id);
  const id = opened.session_id;
  const page = (session as unknown as { pageValue: Page }).pageValue;
  return {
    broker,
    engine,
    session,
    page,
    id,
    origin,
    writes: () => writes,
    async proof(selector = 'button') {
      const element = await page.$(selector);
      assert.ok(element);
      try {
        return await inspectBrowserAction(element, { action: 'click' }, page.mainFrame());
      } finally {
        await element.dispose();
      }
    },
    async click(name: string) {
      const state = await engine.observe(id, { token_budget: 8000 });
      const element = state.elements!.find(e => e.role === 'button' && e.name === name);
      assert.ok(element);
      return engine.act(id, { action: 'click', element_id: element.id }, state.revision);
    },
    async close() {
      await engine.shutdown();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await broker.close();
    },
  };
}

test(
  'optimistic DELETE keeps predispatched item context and complete request, without neighboring items',
  { timeout: 30000 },
  async () => {
    const f = await fixture(
      `<ul><li id="milk">Buy milk <button onclick="this.closest('li').remove();fetch('/api/todos/3',{method:'DELETE'}).catch(()=>{})">Delete</button></li><li>NEIGHBOR_CANARY <button>Other</button></li></ul>`,
    );
    try {
      await assert.rejects(f.click('Delete'), { code: 'E_APPROVAL_REQUIRED' });
      assert.equal(await f.page.locator('#milk').count(), 0);
      const details = f.broker.latest()!.summary.details!;
      assert.match(details[0]!, /Page context \(listitem; untrusted page text, not request identity\): "Buy milk"/);
      assert.deepEqual(details.slice(1), [`Request DELETE ${f.origin}/api/todos/3`, '(no body)']);
      assert.ok(!details.join(' ').includes('NEIGHBOR_CANARY'));
      assert.equal(f.broker.state.posts, 1);
      assert.equal(f.writes(), 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'context omits protected, concealed and control text and redacts personal data in approval',
  { timeout: 30000 },
  async () => {
    const f = await fixture(`<ul><li>Public alice@example.com
    <span data-adl-sensitive>PROTECTED_CANARY</span><span hidden>HIDDEN_CANARY</span>
    <span style="opacity:0">OPACITY_CANARY</span><span style="color:transparent">COLOR_CANARY</span>
    <span style="position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)">CLIP_CANARY</span>
    <input value="FIELD_CANARY"><label>Password LABEL_CANARY</label><div contenteditable>EDITOR_CANARY</div>
    <button onclick="fetch('/api/todos/3',{method:'DELETE'}).catch(()=>{})">Delete</button></li></ul>`);
    try {
      const proof = await f.proof();
      assert.equal(proof.context?.text, 'Public alice@example.com');
      await assert.rejects(f.click('Delete'), { code: 'E_APPROVAL_REQUIRED' });
      const text = JSON.stringify(f.broker.latest()!.summary);
      assert.ok(!text.includes('CANARY'));
      assert.ok(!text.includes('alice@example.com'));
      assert.ok(text.includes('[redacted]'));
    } finally {
      await f.close();
    }
  },
);

test('oversized, wide and deep contexts are omitted rather than truncated', { timeout: 30000 }, async () => {
  const f = await fixture(`<ul><li id="large">${'x'.repeat(513)}<button>Delete</button></li>
    <li id="wide">${'<span></span>'.repeat(140)}<button>Delete</button></li>
    <li id="deep">${'<span>'.repeat(10)}Deep${'</span>'.repeat(10)}<button>Delete</button></li></ul>`);
  try {
    for (const selector of ['#large button', '#wide button', '#deep button'])
      assert.equal((await f.proof(selector)).context, undefined, selector);
  } finally {
    await f.close();
  }
});

test('changed context invalidates a prepared action before dispatch', { timeout: 30000 }, async () => {
  const f = await fixture('<ul><li><span id="name">Buy milk</span><button>Delete</button></li></ul>');
  try {
    const raw = await f.session.snapshot();
    const target = raw.elements.find(e => e.role === 'button')!;
    const action = { action: 'click' as const, element_id: target.id };
    const proof = await f.session.prepareAction!(action, new AbortController().signal);
    await f.page.locator('#name').evaluate(el => (el.textContent = 'Different item'));
    assert.notEqual((await f.proof()).proof, proof.proof);
    let dispatched = false;
    await assert.rejects(
      f.session.act(
        action,
        new AbortController().signal,
        () => {
          dispatched = true;
        },
        {
          normalOperations: true,
          approvalProof: proof.proof,
          holdWrites: true,
        },
      ),
      { code: 'E_STALE_STATE' },
    );
    assert.equal(dispatched, false);
  } finally {
    await f.close();
  }
});

test(
  'purchase preapproval includes visible dialog total and still precedes activation',
  { timeout: 30000 },
  async () => {
    const f = await fixture(
      '<div role="dialog" aria-label="Checkout"><p>One book, total JPY 1200</p><button onclick="this.dataset.ran=\'yes\'">Purchase</button></div>',
    );
    try {
      await assert.rejects(f.click('Purchase'), { code: 'E_APPROVAL_REQUIRED' });
      assert.match(f.broker.latest()!.summary.details![0]!, /One book, total JPY 1200/);
      assert.equal(await f.page.locator('button').getAttribute('data-ran'), null);
      assert.equal(f.broker.latest()!.summary.action, 'click');
    } finally {
      await f.close();
    }
  },
);

test(
  'complete held request details take priority over context at line and byte budgets',
  { timeout: 60000 },
  async () => {
    for (const body of [
      Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`field${i}`, `value${i}`])),
      { first: 'a'.repeat(4000), second: 'b'.repeat(3200) },
    ]) {
      const f = await fixture(
        `<ul><li>${'Context '.repeat(60)}<button onclick='fetch("/api/items",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(${JSON.stringify(body)})}).catch(()=>{})'>Save</button></li></ul>`,
      );
      try {
        await assert.rejects(f.click('Save'), { code: 'E_APPROVAL_REQUIRED' });
        const details = f.broker.latest()!.summary.details!;
        assert.ok(details.length <= 25);
        assert.ok(Buffer.byteLength(JSON.stringify({ details })) <= 8192);
        assert.ok(!details.some(line => line.startsWith('Page context')));
        assert.equal(details[0], `Request POST ${f.origin}/api/items`);
        for (const [key, value] of Object.entries(body))
          assert.ok(details.includes(`${JSON.stringify(key)}: ${JSON.stringify(value)}`));
        assert.equal(f.writes(), 0);
      } finally {
        await f.close();
      }
    }
  },
);
