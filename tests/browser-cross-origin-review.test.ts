import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { BrowserContext } from 'playwright';
import { Engine } from '../src/core.js';
import { BrowserAdapter } from '../src/browser.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import type { AdapterSession } from '../src/types.js';

test('all-mode configured cross-port frame actions recheck isolated host protection', { timeout: 30000 }, async () => {
  const child = createServer((_, res) => res.end('<button onclick="window.clicked=true">Cross origin action</button>'));
  await new Promise<void>(r => child.listen(0, '127.0.0.1', r));
  const childOrigin = `http://127.0.0.1:${(child.address() as { port: number }).port}`;
  const app = createServer((_, res) =>
    res.end(`<iframe id="host" src="${childOrigin}" style="width:400px;height:150px"></iframe>`),
  );
  await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    allowAllOperations: true,
    restrictTargets: true,
    allowedOrigins: [origin, childOrigin],
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
    await engine.wait(session.session_id, { name: 'Cross origin action' }, 3000);
    const observed = await engine.observe(session.session_id);
    const button = observed.elements!.find(e => e.name === 'Cross origin action');
    assert.ok(button);
    const rawId = (await instance.snapshot(new AbortController().signal)).elements.find(
      e => e.name === 'Cross origin action',
    )!.id;
    await engine.act(session.session_id, { action: 'click', element_id: button.id }, observed.revision);
    const page = (instance as unknown as { context: BrowserContext }).context.pages()[0]!;
    assert.equal(await page.frames()[1]!.evaluate(() => (window as any).clicked), true);
    const nativeMatches = await page.evaluateHandle(() => Element.prototype.matches);
    await page.evaluate(() => {
      document.querySelector('#host')!.setAttribute('data-adl-sensitive', '');
      Object.defineProperty(Element.prototype, 'matches', { value: () => false, configurable: true });
    });
    let dispatched = false;
    await assert.rejects(
      instance.act({ action: 'click', element_id: rawId }, new AbortController().signal, () => {
        dispatched = true;
      }),
      { code: 'E_PRIVACY_BLOCKED' },
    );
    assert.equal(dispatched, false);
    await page.evaluate(fn => {
      Element.prototype.matches = fn;
    }, nativeMatches);
    await nativeMatches.dispose();
    policy.allowedOrigins.splice(policy.allowedOrigins.indexOf(childOrigin), 1);
    await assert.rejects(
      instance.act({ action: 'click', element_id: rawId }, new AbortController().signal, () => {
        dispatched = true;
      }),
      { code: 'E_POLICY_DENIED' },
    );
    assert.equal(dispatched, false);
  } finally {
    await engine.shutdown();
    app.closeAllConnections();
    child.closeAllConnections();
    await Promise.all([new Promise<void>(r => app.close(() => r())), new Promise<void>(r => child.close(() => r()))]);
  }
});

test('standard mode does not gain cross-origin frame action permission', { timeout: 30000 }, async () => {
  const child = createServer((_, res) => res.end('<button>Cross origin action</button>'));
  await new Promise<void>(r => child.listen(0, '127.0.0.1', r));
  const childOrigin = `http://127.0.0.1:${(child.address() as { port: number }).port}`;
  const app = createServer((_, res) =>
    res.end(`<iframe src="${childOrigin}" style="width:400px;height:150px"></iframe>`),
  );
  await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    operationMode: 'standard',
    allowAllOperations: true,
    restrictTargets: true,
    allowedOrigins: [origin, childOrigin],
    allowLoopback: true,
    browserTargets: [{ id: 'f', label: 'Fixture', url: origin, classification: 'PUBLIC' }],
  });
  const adapter = new BrowserAdapter(policy, url => assertUrlAllowed(url, policy));
  const engine = new Engine(policy, { browser: adapter });
  try {
    const session = await engine.open((await engine.listTargets()).targets[0]!.target_id);
    await engine.wait(session.session_id, { name: 'Cross origin action' }, 3000);
    policy.allowAllOperations = false;
    const observed = await engine.observe(session.session_id);
    const button = observed.elements!.find(e => e.name === 'Cross origin action');
    assert.ok(button);
    await assert.rejects(
      engine.act(session.session_id, { action: 'click', element_id: button.id }, observed.revision),
      { code: 'E_POLICY_DENIED', reason: 'iframe_action_proof_unavailable' },
    );
  } finally {
    await engine.shutdown();
    app.closeAllConnections();
    child.closeAllConnections();
    await Promise.all([new Promise<void>(r => app.close(() => r())), new Promise<void>(r => child.close(() => r()))]);
  }
});
import { isolatedCollect } from '../src/browser-approval.js';
import { chromium } from 'playwright';
test('allowed out-of-process iframe fails closed with an explicit proof reason', { timeout: 30000 }, async () => {
  const child = createServer((_, res) => res.end('<button>Cross site</button>'));
  await new Promise<void>(r => child.listen(0, '127.0.0.1', r));
  const port = (child.address() as { port: number }).port;
  const childOrigin = `http://localhost:${port}`;
  const app = createServer((_, res) =>
    res.end(`<iframe src="${childOrigin}" style="width:400px;height:150px"></iframe>`),
  );
  await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, args: ['--site-per-process'] });
  try {
    const page = await browser.newPage();
    await page.goto(origin);
    const target = await page.locator('iframe').contentFrame().locator('button').elementHandle();
    assert.ok(target);
    await assert.rejects(
      isolatedCollect(target, () => ({ ok: true }), {}, [childOrigin]),
      { code: 'E_POLICY_DENIED', reason: 'iframe_action_proof_unavailable' },
    );
    await target.dispose();
  } finally {
    await browser.close();
    app.closeAllConnections();
    child.closeAllConnections();
    await Promise.all([new Promise<void>(r => app.close(() => r())), new Promise<void>(r => child.close(() => r()))]);
  }
});
