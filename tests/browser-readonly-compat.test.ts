import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import type { AdapterSession } from '../src/types.js';

const capabilitySet = ['observe', 'read_state', 'wait_for', 'navigate', 'back'];
const dangerousPage = `<!doctype html><title>Compatibility page</title><main id="main"><h1>Readable page</h1><p>Public body copy</p><p>Contact alice@example.com</p><p style="display:none">HIDDEN_CANARY</p><div data-adl-sensitive><p>PRIVATE_CANARY</p></div><input id="matches" name="parentElement" aria-label="Search" value="native"><input id="password" type="password" aria-label="Password" value="SECRET_PASSWORD"><input id="check" type="checkbox" aria-label="Toggle"><select id="choice" aria-label="Choice"><option value="a">A</option><option value="b">B</option></select><button id="open" onclick="window.__compat.clicks++">Open</button><custom-panel><p>Custom visible text</p></custom-panel><iframe id="child" srcdoc="<p>FRAME_CANARY</p>"></iframe>${Array.from({ length: 90 }, (_, i) => `<p>page-item-${i}</p>`).join('')}<script>
  const state = { hooks: 0, clicks: 0 };
  window.__compat = state;
  for (const name of ['insertBefore', 'removeChild']) {
    const original = Object.getOwnPropertyDescriptor(Node.prototype, name);
    Object.defineProperty(Node.prototype, name, { ...original, value: function () { state.hooks++; throw new Error('page wrapper called'); } });
  }
  const matches = Element.prototype.matches;
  Object.defineProperty(Element.prototype, 'matches', { configurable: true, value: new Proxy(matches, { apply(target, receiver, args) { state.hooks++; throw new Error('matches proxy called'); } }) });
  class Panel extends window.HTMLElement {
    get type() { state.hooks++; throw new Error('custom type getter called'); }
    get disabled() { state.hooks++; throw new Error('custom disabled getter called'); }
    get prefix() { state.hooks++; throw new Error('custom prefix getter called'); }
  }
  customElements.define('custom-panel', Panel);
  Object.defineProperty(HTMLElement.prototype, 'constructor', { configurable: true, writable: true, value: function SpoofedHTMLElement() {} });
  Object.defineProperty(document, 'title', { configurable: true, get() { state.hooks++; throw new Error('document.title getter called'); } });
  Object.defineProperty(window, 'HTMLElement', { configurable: true, value: function ReplacedHTMLElement() {} });
</script></main>`;
const cleanPage =
  '<!doctype html><title>Next document</title><main><h1>Safe next page</h1><p>next page body</p></main>';

async function fixture(initial = dangerousPage, guard?: () => Promise<void> | void) {
  const app = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/next' ? cleanPage : initial);
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    allowedOrigins: [origin],
    allowLoopback: true,
    operationMode: 'standard',
    actionTimeoutMs: 5000,
    browserTargets: [
      {
        id: 'readonly-compat',
        label: 'Compatibility fixture',
        url: origin,
        classification: 'PUBLIC',
        visual: { enabled: true },
        gestures: { enabled: true, surfaces: [{ id: 'canvas', selector: '#open', kinds: ['drag'] }] },
      },
    ],
  });
  const adapter = new BrowserAdapter(policy, async (url, purpose) => {
    assertUrlAllowed(url, policy, undefined, purpose);
    await guard?.();
  });
  let instance: AdapterSession | undefined;
  const engine = new Engine(policy, {
    browser: {
      open: async (...args) => (instance = await adapter.open(...args)),
      close: () => adapter.close(),
    },
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await engine.shutdown();
    app.closeAllConnections();
    await new Promise<void>(resolve => app.close(() => resolve()));
  };
  try {
    const session = await engine.open((await engine.listTargets()).targets[0]!.target_id);
    return {
      origin,
      engine,
      instance: instance!,
      session,
      page: (instance as unknown as { pageValue: import('playwright').Page }).pageValue,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function assertReadOnly(session: unknown): void {
  const value = session as { capabilities?: string[]; read_only?: boolean };
  assert.equal(value.read_only, true);
  assert.deepEqual(value.capabilities, capabilitySet);
}
async function assertIsolatedReadDenied(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(
    promise,
    error => typeof error === 'object' && error !== null && 'reason' in error && error.reason === 'isolated_read_only',
  );
}

test(
  'initial incompatible main world publishes only isolated reads with privacy, bounds, and refusal guarantees',
  { timeout: 60000 },
  async () => {
    const f = await fixture();
    try {
      assertReadOnly(f.session);
      const json = await f.engine.observe(f.session.session_id, { format: 'json', token_budget: 8000 });
      assert.equal((json as unknown as { read_only?: boolean }).read_only, true);
      assert.ok(json.elements?.some(e => e.name === 'Readable page'));
      assert.ok(json.elements?.some(e => e.name === 'Custom visible text'));
      assert.ok(!JSON.stringify(json).includes('PRIVATE_CANARY'));
      assert.ok(!JSON.stringify(json).includes('SECRET_PASSWORD'));
      assert.ok(!JSON.stringify(json).includes('HIDDEN_CANARY'));
      assert.ok(!JSON.stringify(json).includes('FRAME_CANARY'));
      assert.ok((json.source_limits ?? []).includes('frame_unavailable'));
      assert.ok(!('actionEvidence' in json) && !('action_evidence' in json));

      const main = json.elements!.find(e => e.role === 'main')!;
      const text = await f.engine.observe(f.session.session_id, {
        text: { element_id: main.id, offset: 0, length: 8192 },
      });
      assert.match(text.text!.content, /Public body copy/);
      assert.match(text.text!.content, /\[redacted\]/);
      assert.ok(!text.text!.content.includes('PRIVATE_CANARY'));
      assert.ok(!text.text!.content.includes('HIDDEN_CANARY'));
      const limited = await f.engine.observe(f.session.session_id, { token_budget: 256, format: 'json' });
      assert.ok(limited.next_cursor, 'large page should return a continuation cursor');
      const continuation = await f.engine.observe(f.session.session_id, {
        token_budget: 256,
        cursor: limited.next_cursor,
        format: 'json',
      });
      assert.equal(continuation.ok, true);
      assert.equal((continuation as unknown as { read_only?: boolean }).read_only, true);
      const compact = await f.engine.observe(f.session.session_id, { token_budget: 8000, format: 'compact' });
      assert.equal(compact.ok, true);
      assert.equal((compact as unknown as { read_only?: boolean }).read_only, true);
      const lines = await f.engine.observe(f.session.session_id, { token_budget: 8000, format: 'lines' });
      assert.equal((lines as unknown as { read_only?: boolean }).read_only, true);
      await assert.rejects(
        f.engine.observe(f.session.session_id, { text: { element_id: main.id, offset: 1_048_577, length: 1 } }),
      );
      await assert.rejects(
        f.engine.observe(f.session.session_id, { text: { element_id: main.id, offset: 0, length: 8193 } }),
      );

      const open = json.elements!.find(e => e.name === 'Open')!;
      const search = json.elements!.find(e => e.name === 'Search')!;
      const toggle = json.elements!.find(e => e.name === 'Toggle')!;
      const choice = json.elements!.find(e => e.name === 'Choice')!;
      const denied = [
        { action: 'click', element_id: open.id },
        { action: 'fill', element_id: search.id, value: 'changed' },
        { action: 'press', element_id: search.id, value: 'Enter' },
        { action: 'check', element_id: toggle.id, checked: true },
        { action: 'select', element_id: choice.id, value: 'b' },
        { action: 'hover', element_id: open.id },
        { action: 'scroll', direction: 'down' },
      ];
      for (const action of denied) {
        const current = await f.engine.observe(f.session.session_id);
        await assertIsolatedReadDenied(f.engine.act(f.session.session_id, action as never, current.revision));
      }
      await assertIsolatedReadDenied(f.engine.capture(f.session.session_id));
      const controller = new AbortController();
      await assertIsolatedReadDenied(f.instance.prepareAction!(denied[0] as never, controller.signal));
      await assertIsolatedReadDenied(f.instance.act(denied[0] as never, controller.signal));
      await assertIsolatedReadDenied(f.instance.capture!(controller.signal));
      await assertIsolatedReadDenied(
        f.instance.clickPoint!({ x: 1, y: 1 } as never, {} as never, controller.signal, () => {}),
      );
      await assertIsolatedReadDenied(
        f.instance.gesture!(
          {
            surface_id: 'canvas',
            kind: 'drag',
            points: [
              { x: 1, y: 1, t_ms: 0 },
              { x: 2, y: 2, t_ms: 10 },
            ],
          },
          {} as never,
          controller.signal,
        ),
      );
      await assertIsolatedReadDenied(f.instance.handoff!(true, controller.signal));
      assert.equal(
        await f.page.evaluate(
          () => (window as unknown as { __compat: { hooks: number; clicks: number } }).__compat.hooks,
        ),
        0,
      );
      assert.equal(
        await f.page.evaluate(() => (window as unknown as { __compat: { clicks: number } }).__compat.clicks),
        0,
      );
      assert.equal(await f.page.locator('#matches').inputValue(), 'native');
      assert.equal(await f.page.locator('#check').isChecked(), false);
      assert.equal(await f.page.locator('#choice').inputValue(), 'a');
    } finally {
      await f.close();
    }
  },
);

test(
  'isolated compatibility navigation preserves guards and invalidates old IDs; abort and close clean up',
  { timeout: 45000 },
  async () => {
    const f = await fixture();
    try {
      assertReadOnly(f.session);
      const before = await f.engine.observe(f.session.session_id, { token_budget: 8000 });
      const oldMain = before.elements!.find(e => e.role === 'main')!;
      await f.engine.act(f.session.session_id, { action: 'navigate', url: `${f.origin}/next` }, before.revision);
      const next = await f.engine.observe(f.session.session_id, { token_budget: 8000 });
      assert.ok(next.elements?.some(e => e.name === 'Safe next page'));
      assert.equal((next as unknown as { read_only?: boolean }).read_only, true);
      await assert.rejects(f.engine.observe(f.session.session_id, { text: { element_id: oldMain.id, length: 100 } }));
      const refreshed = await f.engine.observe(f.session.session_id);
      await assert.rejects(
        f.engine.act(f.session.session_id, { action: 'navigate', url: 'https://example.com/' }, refreshed.revision),
      );
      await f.engine.act(f.session.session_id, { action: 'back' }, refreshed.revision);
      assert.ok((await f.engine.observe(f.session.session_id)).elements?.length);
      const abort = new AbortController();
      abort.abort();
      await assert.rejects(f.engine.observe(f.session.session_id, {}, abort.signal), { code: 'E_CANCELLED' });
      const page = f.page;
      await f.close();
      assert.equal(page.isClosed(), true);
    } finally {
      await f.close().catch(() => undefined);
    }
  },
);

test(
  'already trusted documents never auto-downgrade after a same-document integrity forgery',
  { timeout: 30000 },
  async () => {
    const f = await fixture(cleanPage);
    try {
      const opened = f.session as unknown as { read_only?: boolean };
      assert.notEqual(opened.read_only, true);
      await f.engine.observe(f.session.session_id);
      await f.page.evaluate(() => {
        (window as unknown as { hits: number }).hits = 0;
        Object.defineProperty(Element.prototype, 'matches', {
          configurable: true,
          get() {
            (window as unknown as { hits: number }).hits++;
            throw new Error('forgery invoked');
          },
        });
      });
      await assert.rejects(f.engine.observe(f.session.session_id), { code: 'E_PRIVACY_BLOCKED' });
      assert.equal(await f.page.evaluate(() => (window as unknown as { hits: number }).hits), 0);
    } finally {
      await f.close();
    }
  },
);

for (const method of ['snapshot', 'readText'] as const) {
  for (const interruption of ['abort', 'close'] as const) {
    test(`isolated ${method} rejects ${interruption} during the final policy guard`, { timeout: 15000 }, async () => {
      let lateGuard: (() => Promise<void>) | undefined;
      const f = await fixture(dangerousPage, () => lateGuard?.());
      try {
        const raw = await f.instance.snapshot();
        const main = raw.elements.find(element => element.role === 'main')!;
        const controller = new AbortController();
        let guards = 0;
        lateGuard = async () => {
          if (++guards === 2) {
            if (interruption === 'abort') controller.abort();
            else await f.instance.close();
          }
        };
        const operation =
          method === 'snapshot'
            ? f.instance.snapshot(controller.signal)
            : f.instance.readText!(main.id, 0, 100, controller.signal);
        await assert.rejects(operation, {
          code: interruption === 'abort' ? 'E_CANCELLED' : 'E_TARGET_NOT_FOUND',
        });
        assert.equal(guards, 2);
      } finally {
        lateGuard = undefined;
        await f.close();
      }
    });
  }
}
