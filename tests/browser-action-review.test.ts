import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { inspectBrowserAction } from '../src/browser-approval.js';
import { AdlError } from '../src/types.js';

test(
  'isolated action proof classifies visible labels, form methods and shadow targets',
  { timeout: 30000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        `<form method="get"><input name="q" value="cats"><button id="search">Search</button></form><form method="post"><button id="post">Search</button></form><button id="delete-record">Payload viewer</button><button id="filter">Remove filter</button><button id="cookie">Cookie recipes</button><button id="key">Key features</button><button id="pin">Pin to top</button><button id="session">Session schedule</button><button id="delete">Delete item</button><button id="jp">\u524a\u9664</button><input id="password" type="password"><div id="host"></div><button id="covered">Covered</button><div style="position:absolute;left:0;top:0;width:100%;height:100%;z-index:9;pointer-events:none" id="overlay"></div>`,
      );
      const proof = async (selector: string, action: 'click' | 'press' | 'fill' = 'click') => {
        const el = await page.locator(selector).elementHandle();
        assert.ok(el);
        try {
          return await inspectBrowserAction(el, {
            action,
            ...(action === 'press' ? { value: 'Enter' } : action === 'fill' ? { value: 'abc' } : {}),
          });
        } finally {
          await el.dispose();
        }
      };
      for (const selector of ['#search', '#delete-record', '#filter', '#cookie', '#key', '#pin', '#session'])
        assert.equal((await proof(selector)).risk, 'ordinary', selector);
      assert.equal((await proof('input[name=q]', 'press')).risk, 'ordinary');
      await page.locator('#search').evaluate(e => {
        const hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = 'page';
        hidden.value = '2';
        e.closest('form')!.append(hidden);
      });
      assert.equal((await proof('#search')).risk, 'ordinary');
      await page.locator('#search').evaluate(e => (e.textContent = 'Submit'));
      assert.equal((await proof('#search')).risk, 'ordinary');
      await page.locator('#search').evaluate(e => (e.textContent = 'Search'));
      for (const selector of ['#post', '#delete', '#jp'])
        assert.equal((await proof(selector)).risk, 'consequential', selector);
      assert.equal((await proof('#password', 'fill')).risk, 'credential');
      for (const label of [
        '\u8cfc\u5165',
        '\u6ce8\u6587',
        '\u652f\u6255',
        '\u9001\u4fe1',
        '\u767b\u9332',
        '\u30ad\u30e3\u30f3\u30bb\u30eb',
        '\u9001\u91d1',
        '\u78ba\u5b9a',
        '\u30ed\u30b0\u30a4\u30f3',
      ]) {
        await page.locator('#jp').evaluate((e, label) => (e.textContent = label), label);
        assert.equal((await proof('#jp')).risk, 'consequential', label);
      }
      const a = await proof('#search');
      await page.locator('input[name=q]').fill('dogs');
      assert.notEqual((await proof('#search')).proof, a.proof);
      await page.locator('#host').evaluate(e => {
        const root = e.attachShadow({ mode: 'open' });
        root.innerHTML = '<button id="shadow">Open</button><input id="shadow-input">';
      });
      assert.equal((await proof('#shadow')).risk, 'ordinary');
      assert.equal((await proof('#shadow-input', 'fill')).risk, 'ordinary');
      await page.locator('#overlay').evaluate(e => ((e as HTMLElement).style.pointerEvents = 'auto'));
      await assert.rejects(
        proof('#covered'),
        (e: unknown) => e instanceof AdlError && e.code === 'E_NOT_INTERACTABLE' && e.reason === 'occluded',
      );
    } finally {
      await browser.close();
    }
  },
);
import { createServer } from 'node:http';
import { Engine } from '../src/core.js';
import { BrowserAdapter } from '../src/browser.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import type { AdapterSession } from '../src/types.js';
import type { BrowserContext } from 'playwright';

async function actionFixture(html: string, all = false) {
  const app = createServer((_, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    operationMode: 'standard',
    allowAllOperations: all,
    allowedOrigins: [origin],
    allowLoopback: true,
    browserTargets: [{ id: 'f', label: 'Fixture', url: origin, classification: 'PUBLIC' }],
  });
  const adapter = new BrowserAdapter(policy, url => assertUrlAllowed(url, policy));
  const open = adapter.open.bind(adapter);
  let instance: AdapterSession;
  adapter.open = async (...args) => (instance = await open(...args));
  const engine = new Engine(policy, { browser: adapter });
  try {
    const session = await engine.open((await engine.listTargets()).targets[0]!.target_id);
    return {
      engine,
      id: session.session_id,
      page: () => (instance as unknown as { context: BrowserContext }).context.pages()[0]!,
      close: async () => {
        await engine.shutdown();
        app.closeAllConnections();
        await new Promise<void>(r => app.close(() => r()));
      },
    };
  } catch (error) {
    await engine.shutdown();
    app.close();
    throw error;
  }
}

test('standard mode permits GET search click and Enter', { timeout: 30000 }, async () => {
  const f = await actionFixture(
    '<button id="cookie" onclick="window.count=(window.count||0)+1">Cookie recipes</button><button id="key">Key features</button><button id="pin">Pin to top</button><button id="session">Session schedule</button><form method="get"><input name="q" value="cats" aria-label="Search query"><button>Search</button></form>',
  );
  try {
    let observed = await f.engine.observe(f.id);
    let search = observed.elements!.find(e => e.name === 'Search')!;
    assert.ok(search);
    await f.engine.act(f.id, { action: 'click', element_id: search.id }, observed.revision);
    assert.equal(new URL(f.page().url()).searchParams.get('q'), 'cats');
    observed = await f.engine.observe(f.id);
    const input = observed.elements!.find(e => e.name === 'Search query')!;
    assert.ok(input);
    await f.engine.act(f.id, { action: 'press', value: 'Enter', element_id: input.id }, observed.revision);
    assert.equal(new URL(f.page().url()).searchParams.get('q'), 'cats');
  } finally {
    await f.close();
  }
});

test('open shadow click and fill succeed in standard and all modes', { timeout: 30000 }, async () => {
  for (const all of [false, true]) {
    const f = await actionFixture(
      '<div id="host"></div><script>const root=document.getElementById("host").attachShadow({mode:"open"});root.innerHTML=`<button>Open panel</button><input aria-label="Search query">`;root.querySelector("button").onclick=()=>window.clicked=true</script>',
      all,
    );
    try {
      let observed = await f.engine.observe(f.id);
      const button = observed.elements!.find(e => e.name === 'Open panel')!;
      assert.ok(button);
      await f.engine.act(f.id, { action: 'click', element_id: button.id }, observed.revision);
      assert.equal(await f.page().evaluate(() => (window as any).clicked), true);
      observed = await f.engine.observe(f.id);
      const input = observed.elements!.find(e => e.name === 'Search query')!;
      assert.ok(input);
      await f.engine.act(f.id, { action: 'fill', value: 'hello', element_id: input.id }, observed.revision);
      assert.equal(
        await f
          .page()
          .locator('#host')
          .evaluate(e => (e.shadowRoot!.querySelector('input') as HTMLInputElement).value),
        'hello',
      );
    } finally {
      await f.close();
    }
  }
});

test('unsupported directional scroll leaves the session usable', { timeout: 30000 }, async () => {
  const f = await actionFixture('<button>Small target</button>');
  try {
    const observed = await f.engine.observe(f.id);
    const button = observed.elements!.find(e => e.name === 'Small target')!;
    assert.ok(button);
    await assert.rejects(
      f.engine.act(f.id, { action: 'scroll', direction: 'down', element_id: button.id }, observed.revision),
      { code: 'E_UNSUPPORTED_ACTION' },
    );
    assert.equal((await f.engine.observe(f.id)).ok, true);
  } finally {
    await f.close();
  }
});

test('standard mode permits public labels with credential-like ids', { timeout: 30000 }, async () => {
  const f = await actionFixture(
    '<button id="cookie">Cookie recipes</button><button id="key">Key features</button><button id="pin">Pin to top</button><button id="session">Session schedule</button>',
  );
  try {
    for (const label of ['Cookie recipes', 'Key features', 'Pin to top', 'Session schedule']) {
      const observed = await f.engine.observe(f.id);
      const element = observed.elements!.find(e => e.name === label);
      assert.ok(element, label);
      await f.engine.act(f.id, { action: 'click', element_id: element.id }, observed.revision);
    }
  } finally {
    await f.close();
  }
});
