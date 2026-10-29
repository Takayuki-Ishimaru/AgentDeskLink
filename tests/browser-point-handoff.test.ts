import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium, type BrowserContext, type Browser } from 'playwright';
import { Engine } from '../src/core.js';
import { BrowserAdapter } from '../src/browser.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import type { Adapter, AdapterSession } from '../src/types.js';

async function fixture(html: string, extra: Record<string, unknown> = {}) {
  const app = createServer((_, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(
      '<style>body{margin:0}#target{position:absolute;left:10px;top:10px;width:100px;height:80px}#status{position:absolute;top:150px}</style>' +
        html,
    );
  });
  await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    allowedOrigins: [origin],
    allowLoopback: true,
    operationMode: 'standard',
    browserTargets: [
      {
        id: 'p',
        label: 'Point',
        url: origin,
        classification: 'PUBLIC',
        visual: { enabled: true },
        controls: [{ selector: '#target', actions: ['click'] }],
      },
    ],
    ...extra,
  });
  const adapter = new BrowserAdapter(policy, url => assertUrlAllowed(url, policy));
  const original = adapter.open.bind(adapter);
  let instance: AdapterSession;
  adapter.open = async (...args) => {
    instance = await original(...args);
    return instance;
  };
  const engine = new Engine(policy, { browser: adapter });
  try {
    const s = await engine.open((await engine.listTargets()).targets[0]!.target_id);
    return {
      engine,
      id: s.session_id,
      page: () => (instance as unknown as { context: BrowserContext }).context.pages()[0]!,
      close: async () => {
        await engine.shutdown();
        app.closeAllConnections();
        await new Promise<void>(r => app.close(() => r()));
      },
    };
  } catch (e) {
    await engine.shutdown();
    app.close();
    throw e;
  }
}
test(
  'coordinate click uses captured source pixels, trusted input and normal permission checks',
  { timeout: 15000 },
  async () => {
    const f = await fixture(
      '<button id="target" type="button" onclick="document.getElementById(\'status\').textContent=event.clientX+\',\'+event.clientY+\' \'+event.isTrusted">Add</button><p id="status">Ready</p>',
    );
    try {
      const frame = await f.engine.capture(f.id);
      await f.engine.act(
        f.id,
        { action: 'click', point: { frame_id: frame.metadata.frame_id, x: 31, y: 29 } },
        frame.metadata.revision,
      );
      assert.ok((await f.engine.observe(f.id)).elements?.some(e => e.name === '31,29 true'));
    } finally {
      await f.close();
    }
  },
);
test(
  'coordinates reject geometry-only drift, old frames and explicitly protected targets',
  { timeout: 15000 },
  async () => {
    const f = await fixture('<button id="target" type="button">Add</button>');
    try {
      const frame = await f.engine.capture(f.id);
      await f.page().evaluate(() => {
        document.getElementById('target')!.style.left = '11px';
      });
      assert.equal((await f.engine.observe(f.id)).revision, frame.metadata.revision);
      await assert.rejects(
        f.engine.act(
          f.id,
          { action: 'click', point: { frame_id: frame.metadata.frame_id, x: 31, y: 29 } },
          frame.metadata.revision,
        ),
        { code: 'E_STALE_STATE' },
      );
      const newest = await f.engine.capture(f.id);
      await assert.rejects(
        f.engine.act(
          f.id,
          { action: 'click', point: { frame_id: frame.metadata.frame_id, x: 31, y: 29 } },
          newest.metadata.revision,
        ),
        { code: 'E_STALE_STATE' },
      );
    } finally {
      await f.close();
    }
    const protectedPage = await fixture(
      '<div data-adl-sensitive><button id="target" type="button" onclick="document.getElementById(\'status\').textContent=\'Wrong\'">Hidden action</button></div><p id="status">Ready</p>',
      { allowAllOperations: true },
    );
    try {
      const frame = await protectedPage.engine.capture(protectedPage.id);
      await assert.rejects(
        protectedPage.engine.act(
          protectedPage.id,
          { action: 'click', point: { frame_id: frame.metadata.frame_id, x: 31, y: 29 } },
          frame.metadata.revision,
        ),
        { code: 'E_STALE_STATE' },
      );
      assert.ok((await protectedPage.engine.observe(protectedPage.id)).elements?.some(e => e.name === 'Ready'));
    } finally {
      await protectedPage.close();
    }
    const closed = await fixture(
      '<div id="target"></div><script>document.getElementById("target").attachShadow({mode:"closed"}).innerHTML="<button data-adl-sensitive style=width:100px;height:80px>Hidden</button>";</script>',
      { allowAllOperations: true },
    );
    try {
      const frame = await closed.engine.capture(closed.id);
      await assert.rejects(
        closed.engine.act(
          closed.id,
          { action: 'click', point: { frame_id: frame.metadata.frame_id, x: 31, y: 29 } },
          frame.metadata.revision,
        ),
        { code: 'E_PRIVACY_BLOCKED' },
      );
    } finally {
      await closed.close();
    }
  },
);
test(
  'nested text does not bypass consequential button approval; unstructured canvas needs broad permission',
  { timeout: 15000 },
  async () => {
    const f = await fixture('<button id="target" type="button"><span>Delete account</span></button>');
    try {
      const frame = await f.engine.capture(f.id);
      await assert.rejects(
        f.engine.act(
          f.id,
          { action: 'click', point: { frame_id: frame.metadata.frame_id, x: 31, y: 29 } },
          frame.metadata.revision,
        ),
        { code: 'E_APPROVAL_REQUIRED' },
      );
    } finally {
      await f.close();
    }
    for (const allowAllOperations of [false, true]) {
      const canvas = await fixture(
        '<canvas id="target" width="100" height="80"></canvas><p id="status">Ready</p><script>document.getElementById("target").addEventListener("click",e=>document.getElementById("status").textContent=e.clientX+","+e.clientY);</script>',
        { allowAllOperations },
      );
      try {
        const frame = await canvas.engine.capture(canvas.id);
        const action = { action: 'click' as const, point: { frame_id: frame.metadata.frame_id, x: 31, y: 29 } };
        if (allowAllOperations) {
          await canvas.engine.act(canvas.id, action, frame.metadata.revision);
          assert.ok((await canvas.engine.observe(canvas.id)).elements?.some(e => e.name === '31,29'));
        } else
          await assert.rejects(canvas.engine.act(canvas.id, action, frame.metadata.revision), {
            code: 'E_APPROVAL_REQUIRED',
          });
      } finally {
        await canvas.close();
      }
    }
  },
);
test('visible browser handoff pauses mutations, invalidates revisions and resumes after a human step', async () => {
  let humanValue = 'Before',
    mutations = 0,
    manual = false;
  const adapter: Adapter = {
    open: async () => ({
      handoff: async paused => {
        manual = paused;
      },
      snapshot: async () => ({
        fingerprint: humanValue,
        elements: [{ id: 'e', role: 'button', name: humanValue, enabled: true }],
        truncated: false,
      }),
      act: async () => {
        mutations++;
      },
      close: async () => {},
    }),
    close: async () => {},
  };
  const policy = parsePolicy({
    browserHeadless: false,
    allowAllOperations: true,
    browserTargets: [{ id: 'p', label: 'Visible', url: 'https://example.test', classification: 'PUBLIC' }],
  });
  const engine = new Engine(policy, { browser: adapter });
  try {
    const s = await engine.open((await engine.listTargets()).targets[0]!.target_id);
    const paused = await engine.handoff(s.session_id, 'pause');
    assert.equal(manual, true);
    assert.equal(engine.listSessions().sessions[0]!.paused, true);
    await assert.rejects(engine.act(s.session_id, { action: 'click', element_id: 'e1' }, paused.revision), {
      code: 'E_POLICY_DENIED',
    });
    humanValue = 'After manual login';
    assert.ok((await engine.observe(s.session_id)).ok);
    const resumed = await engine.handoff(s.session_id, 'resume');
    assert.equal(manual, false);
    await assert.rejects(engine.act(s.session_id, { action: 'click', element_id: 'e1' }, paused.revision), {
      code: 'E_STALE_STATE',
    });
    await engine.act(s.session_id, { action: 'click', element_id: 'e1' }, resumed.revision);
    assert.equal(mutations, 1);
  } finally {
    await engine.shutdown();
  }
});
test('explicit read_only overrides control rules while an omitted mode preserves CLI compatibility', async () => {
  for (const operationMode of [undefined, 'read_only'] as const) {
    const f = await fixture('<button id="target" type="button">Add</button>', { operationMode });
    try {
      const observed = await f.engine.observe(f.id);
      const action = { action: 'click' as const, element_id: observed.elements!.find(e => e.name === 'Add')!.id };
      if (operationMode === 'read_only') {
        await assert.rejects(f.engine.act(f.id, action, observed.revision), { code: 'E_POLICY_DENIED' });
        assert.ok(!(await f.engine.listTargets()).targets[0]!.capabilities.includes('click'));
      } else assert.equal((await f.engine.act(f.id, action, observed.revision)).ok, true);
    } finally {
      await f.close();
    }
  }
});

test('a failed handoff readback revokes the manual lease and keeps automation paused', async () => {
  let manual = false,
    fail = false;
  const adapter: Adapter = {
    open: async () => ({
      handoff: async paused => {
        manual = paused;
        if (paused) fail = true;
      },
      snapshot: async () => {
        if (fail) throw new Error('readback failed');
        return { fingerprint: 'ready', elements: [], truncated: false };
      },
      act: async () => {},
      close: async () => {},
    }),
    close: async () => {},
  };
  const policy = parsePolicy({
    browserHeadless: false,
    allowAllOperations: true,
    browserTargets: [{ id: 'p', label: 'Visible', url: 'https://example.test', classification: 'PUBLIC' }],
  });
  const engine = new Engine(policy, { browser: adapter });
  try {
    const s = await engine.open((await engine.listTargets()).targets[0]!.target_id);
    await assert.rejects(engine.handoff(s.session_id, 'pause'));
    assert.equal(manual, false);
    assert.equal(engine.listSessions().sessions[0]!.paused, true);
  } finally {
    await engine.shutdown();
  }
});

test('manual network access requires an expiring host grant and is revoked on resume', { timeout: 20000 }, async () => {
  let posts = 0;
  const app = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.method === 'POST') {
      posts++;
      res.end('<p>Signed in</p>');
    } else
      res.end(
        '<form method="post" action="/login"><input name="username" value="public"><button>Sign in</button></form>',
      );
  });
  await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    operationMode: 'ask',
    browserHeadless: false,
    allowedOrigins: [origin],
    allowLoopback: true,
    browserTargets: [{ id: 'manual', label: 'Manual', url: origin, classification: 'PUBLIC' }],
  });
  const adapter = new BrowserAdapter(policy, url => assertUrlAllowed(url, policy));
  // Exercise real Chromium trusted-event/network behavior in headless CI; the
  // production headful launch option is unchanged and handoff mode is explicit.
  (adapter as unknown as { browser: Browser }).browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
  });
  const target = {
    target_id: 't',
    surface: 'browser' as const,
    application_id: 'manual',
    label: 'Manual',
    capabilities: [],
    policy_class: 'PUBLIC' as const,
  };
  let session: AdapterSession | undefined;
  try {
    session = await adapter.open(target, 'strict_isolated', new AbortController().signal);
    const page = (session as unknown as { context: BrowserContext }).context.pages()[0]!;
    const blocked = page.waitForEvent('requestfailed', r => r.method() === 'POST');
    const cdp = await page.context().newCDPSession(page);
    try {
      await cdp.send('Page.enable');
      const stopped = new Promise<void>(resolve => cdp.once('Page.frameStoppedLoading', () => resolve()));
      await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("form").submit()', userGesture: false });
      await blocked;
      await stopped;
    } finally {
      await cdp.detach();
    }
    assert.equal(posts, 0);
    await page.goto(origin);
    await assert.rejects(session.handoff!(true, new AbortController().signal), { code: 'E_POLICY_DENIED' });
    await session.handoff!(true, new AbortController().signal, Date.now() + 60000);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForLoadState('domcontentloaded');
    assert.equal(posts, 1);
    await session.handoff!(false, new AbortController().signal);
    await page.goto(origin);
    const denied = page.waitForEvent('requestfailed', r => r.method() === 'POST');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await denied;
    assert.equal(posts, 1);
  } finally {
    await session?.close();
    await adapter.close();
    app.closeAllConnections();
    await new Promise<void>(r => app.close(() => r()));
  }
});

test(
  'manual network requests waiting on guard cannot outlive resume, expiry or a replacement grant',
  { timeout: 20000 },
  async () => {
    let posts = 0;
    const app = createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      if (req.method === 'POST') posts++;
      res.end('<p>Ready</p>');
    });
    await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    try {
      for (const scenario of ['resume', 'expiry', 'replacement'] as const) {
        let enter!: () => void,
          release!: () => void,
          waiting = true;
        const entered = new Promise<void>(r => {
          enter = r;
        });
        const gate = new Promise<void>(r => {
          release = r;
        });
        const policy = parsePolicy({
          operationMode: 'ask',
          browserHeadless: false,
          allowedOrigins: [origin],
          allowLoopback: true,
          browserTargets: [{ id: 'manual', label: 'Manual', url: origin, classification: 'PUBLIC' }],
        });
        const adapter = new BrowserAdapter(policy, async url => {
          await assertUrlAllowed(url, policy);
          if (waiting && url.endsWith('/mutation')) {
            enter();
            await gate;
          }
        });
        (adapter as unknown as { browser: Browser }).browser = await chromium.launch({
          headless: true,
          chromiumSandbox: true,
        });
        let session: AdapterSession | undefined;
        try {
          session = await adapter.open(
            {
              target_id: 't',
              surface: 'browser',
              application_id: 'manual',
              label: 'Manual',
              capabilities: [],
              policy_class: 'PUBLIC',
            },
            'strict_isolated',
            new AbortController().signal,
          );
          const page = (session as unknown as { context: BrowserContext }).context.pages()[0]!;
          const expires = Date.now() + 1000;
          await session.handoff!(true, new AbortController().signal, expires);
          const request = page.evaluate(() =>
            fetch('/mutation', { method: 'POST', body: 'public' }).then(
              () => true,
              () => false,
            ),
          );
          await entered;
          if (scenario === 'expiry') await new Promise(r => setTimeout(r, Math.max(0, expires - Date.now() + 10)));
          else {
            await session.handoff!(false, new AbortController().signal);
            if (scenario === 'replacement')
              await session.handoff!(true, new AbortController().signal, Date.now() + 60000);
          }
          release();
          assert.equal(await request, false, scenario);
          assert.equal(posts, 0, scenario);
          waiting = false;
          await session.handoff!(true, new AbortController().signal, Date.now() + 60000);
          assert.equal(
            await page.evaluate(() =>
              fetch('/mutation', { method: 'POST', body: 'public' }).then(
                () => true,
                () => false,
              ),
            ),
            true,
          );
          assert.equal(posts, 1);
          posts = 0;
        } finally {
          release();
          await session?.close();
          await adapter.close();
        }
      }
    } finally {
      app.closeAllConnections();
      await new Promise<void>(r => app.close(() => r()));
    }
  },
);
