import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { BrowserContext } from 'playwright';
import { Engine } from '../src/core.js';
import { BrowserAdapter } from '../src/browser.js';
import { inspectBrowserAction } from '../src/browser-approval.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import type { AdapterSession } from '../src/types.js';

test(
  'same-origin frame actions and reading use isolated identity and protect frame ancestors',
  { timeout: 45000 },
  async () => {
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (req.url?.startsWith('/frame'))
        res.end(
          '<button onclick="window.clicked=true">Open frame panel</button><input aria-label="Frame query"><p>Frame public text</p><form method="get"><input name="q" value="one"><button>Search</button></form><form method="post"><button>Search</button></form>',
        );
      else res.end('<iframe id="host" src="/frame" style="width:500px;height:200px"></iframe>');
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const policy = parsePolicy({
      operationMode: 'standard',
      allowedOrigins: [origin],
      allowLoopback: true,
      browserTargets: [{ id: 'f', label: 'Fixture', url: origin, classification: 'PUBLIC' }],
    });
    const adapter = new BrowserAdapter(policy, url => assertUrlAllowed(url, policy));
    const open = adapter.open.bind(adapter);
    let instance!: AdapterSession;
    adapter.open = async (...args) => (instance = await open(...args));
    const engine = new Engine(policy, { browser: adapter });
    try {
      const session = await engine.open((await engine.listTargets()).targets[0]!.target_id);
      const page = () => (instance as unknown as { context: BrowserContext }).context.pages()[0]!;
      let observed = await engine.observe(session.session_id);
      let button = observed.elements!.find(e => e.name === 'Open frame panel');
      assert.ok(button);
      const rawButton = (await instance.snapshot(new AbortController().signal)).elements.find(
        e => e.name === 'Open frame panel',
      )!.id;
      await engine.act(session.session_id, { action: 'click', element_id: button.id }, observed.revision);
      assert.equal(
        await page()
          .frames()[1]!
          .evaluate(() => (window as any).clicked),
        true,
      );
      observed = await engine.observe(session.session_id);
      let input = observed.elements!.find(e => e.name === 'Frame query');
      assert.ok(input);
      await engine.act(session.session_id, { action: 'fill', element_id: input.id, value: 'hello' }, observed.revision);
      assert.equal(await page().frames()[1]!.locator('input[aria-label]').inputValue(), 'hello');
      observed = await engine.observe(session.session_id);
      const paragraph = observed.elements!.find(e => e.name === 'Frame public text');
      assert.ok(paragraph);
      const rawParagraph = (await instance.snapshot(new AbortController().signal)).elements.find(
        e => e.name === 'Frame public text',
      )!.id;
      const reader = instance as AdapterSession & {
        readText: (id: string, offset: number, length: number, signal: AbortSignal) => Promise<{ text: string }>;
      };
      assert.equal(
        (await reader.readText(rawParagraph, 0, 100, new AbortController().signal)).text,
        'Frame public text',
      );
      const child = page().frames()[1]!;
      const search = await child.locator('form[method=get] button').elementHandle();
      assert.ok(search);
      const before = await inspectBrowserAction(search, { action: 'click' });
      assert.equal(before.risk, 'ordinary');
      await child.locator('input[name=q]').fill('two');
      assert.notEqual((await inspectBrowserAction(search, { action: 'click' })).proof, before.proof);
      await search.dispose();
      const post = await child.locator('form[method=post] button').elementHandle();
      assert.ok(post);
      assert.equal((await inspectBrowserAction(post, { action: 'click' })).risk, 'consequential');
      await post.dispose();
      const buttonHandle = await page().frames()[1]!.locator('button').first().elementHandle();
      assert.ok(buttonHandle);
      const nativeMatches = await page().evaluateHandle(() => Element.prototype.matches);
      await page().evaluate(() => {
        document.getElementById('host')!.setAttribute('data-adl-sensitive', '');
        Object.defineProperty(Element.prototype, 'matches', { value: () => false, configurable: true });
      });
      await assert.rejects(inspectBrowserAction(buttonHandle, { action: 'click' }), { code: 'E_PRIVACY_BLOCKED' });
      policy.allowAllOperations = true;
      let dispatched = false;
      await assert.rejects(
        instance.act({ action: 'click', element_id: rawButton }, new AbortController().signal, () => {
          dispatched = true;
        }),
        { code: 'E_PRIVACY_BLOCKED' },
      );
      assert.equal(dispatched, false);
      await assert.rejects(reader.readText(rawParagraph, 0, 100, new AbortController().signal), {
        code: 'E_PRIVACY_BLOCKED',
      });
      await page().evaluate(fn => {
        Element.prototype.matches = fn;
      }, nativeMatches);
      await nativeMatches.dispose();
      await page()
        .locator('#host')
        .evaluate(e => e.removeAttribute('data-adl-sensitive'));
      await page().mouse.move(700, 500);
      await buttonHandle.evaluate(button =>
        button.addEventListener(
          'mouseenter',
          () => parent.document.getElementById('host')!.setAttribute('data-adl-sensitive', ''),
          { once: true },
        ),
      );
      dispatched = false;
      await assert.rejects(
        instance.act({ action: 'click', element_id: rawButton }, new AbortController().signal, () => {
          dispatched = true;
        }),
        { code: 'E_PRIVACY_BLOCKED' },
      );
      assert.equal(dispatched, false);
      await buttonHandle.dispose();
    } finally {
      await engine.shutdown();
      server.closeAllConnections();
      await new Promise<void>(r => server.close(() => r()));
    }
  },
);

test('frame proofs reject sibling overlays and opaque or cross-origin frames', { timeout: 45000 }, async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url?.startsWith('/child')) res.end('<button>Same position</button>');
    else if (req.url === '/nested') res.end('<iframe src="/child" style="width:300px;height:100px"></iframe>');
    else
      res.end(
        '<style>iframe{position:absolute;left:10px;top:10px;width:400px;height:200px}</style><iframe id="under" src="/child"></iframe><iframe id="over" src="/child"></iframe>',
      );
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    const under = await await page.locator('#under').contentFrame().locator('button').elementHandle();
    assert.ok(under);
    await assert.rejects(inspectBrowserAction(under, { action: 'click' }), {
      code: 'E_NOT_INTERACTABLE',
      reason: 'occluded',
    });
    await under.dispose();
    await page.locator('#over').evaluate(e => e.remove());
    await page.locator('#under').evaluate(e => ((e as HTMLIFrameElement).src = '/nested'));
    await page.waitForFunction(() =>
      document
        .querySelector<HTMLIFrameElement>('#under')
        ?.contentDocument?.querySelector('iframe')
        ?.contentDocument?.querySelector('button'),
    );
    const nested = await page
      .locator('#under')
      .contentFrame()
      .locator('iframe')
      .contentFrame()
      .locator('button')
      .elementHandle();
    assert.ok(nested);
    assert.equal((await inspectBrowserAction(nested, { action: 'click' })).risk, 'ordinary');
    await nested.dispose();
    const navigated = page.waitForEvent('framenavigated', { predicate: f => f.url().includes('localhost') });
    await page
      .locator('#under')
      .evaluate((e, url) => ((e as HTMLIFrameElement).src = url), origin.replace('127.0.0.1', 'localhost') + '/child');
    await navigated;
    const cross = await page.locator('#under').contentFrame().locator('button').elementHandle();
    assert.ok(cross);
    await assert.rejects(inspectBrowserAction(cross, { action: 'click' }), {
      code: 'E_POLICY_DENIED',
      reason: 'iframe_action_proof_unavailable',
    });
    await cross.dispose();
    const opaqueNav = page.waitForEvent('framenavigated', { predicate: f => f.url().includes('/child?opaque') });
    await page.locator('#under').evaluate((e, url) => {
      const frame = e as HTMLIFrameElement;
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.src = url;
    }, origin + '/child?opaque');
    await opaqueNav;
    const opaque = await page.locator('#under').contentFrame().locator('button').elementHandle();
    assert.ok(opaque);
    await assert.rejects(inspectBrowserAction(opaque, { action: 'click' }), {
      code: 'E_POLICY_DENIED',
      reason: 'iframe_action_proof_unavailable',
    });
    await opaque.dispose();
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
});
