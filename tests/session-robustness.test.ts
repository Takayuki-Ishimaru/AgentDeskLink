import { browserRuntimeEnv } from './browser-runtime-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import {
  AdlError,
  safeError,
  type Adapter,
  type AdapterSession,
  type BrowserTargetConfig,
  type PolicyConfig,
} from '../src/types.js';

async function listen(server: Server) {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function shut(server: Server) {
  server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
}
async function page(
  html: string,
  policyExtra: Record<string, unknown> = {},
  controls?: { selector: string; actions: string[] }[],
) {
  const app = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  });
  const origin = await listen(app);
  const policy = parsePolicy({
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 4000,
    operationMode: 'standard',
    ...policyExtra,
    browserTargets: [
      { id: 'app', label: 'App', url: origin, classification: 'PUBLIC', ...(controls ? { controls } : {}) },
    ],
  });
  const engine = new Engine(policy, {
    browser: new BrowserAdapter(policy, (url, purpose) => assertUrlAllowed(url, policy, undefined, purpose)),
  });
  const open = async () => engine.open((await engine.listTargets()).targets[0]!.target_id);
  return {
    engine,
    open,
    origin,
    close: async () => {
      await engine.shutdown();
      await shut(app);
    },
  };
}
const REPLACING_PAGE = `<!doctype html><body><input id="todo" type="checkbox" aria-label="Buy milk"><button id="save">Save</button><input id="notes" aria-label="Notes">
<script>
document.getElementById('todo').addEventListener('click',()=>{const old=document.getElementById('todo'),n=document.createElement('input');n.type='checkbox';n.id='todo2';n.checked=true;n.setAttribute('aria-label','Buy milk');old.replaceWith(n);});
document.getElementById('save').addEventListener('click',()=>{const old=document.getElementById('save'),n=document.createElement('button');n.id='save2';n.textContent='Saved';old.replaceWith(n);});
</script></body>`;

test(
  'a checkbox the app re-renders after the click returns success with target_replaced and keeps the session usable',
  { timeout: 40000 },
  async () => {
    const f = await page(REPLACING_PAGE);
    try {
      const session = await f.open();
      let observed = await f.engine.observe(session.session_id);
      const checkbox = observed.elements!.find(e => e.name === 'Buy milk')!;
      const result = (await f.engine.act(
        session.session_id,
        { action: 'check', element_id: checkbox.id, checked: true },
        observed.revision,
      )) as { ok: boolean; warnings?: { code: string }[]; network_blocked?: boolean };
      assert.equal(result.ok, true);
      assert.ok(
        result.warnings?.some(w => w.code === 'target_replaced'),
        JSON.stringify(result),
      );
      assert.equal(result.network_blocked, undefined);
      assert.equal(f.engine.listSessions().sessions.length, 1, 'the session must survive');
      observed = await f.engine.observe(session.session_id);
      assert.equal(observed.elements!.find(e => e.name === 'Buy milk')!.checked, true);
      const notes = observed.elements!.find(e => e.name === 'Notes')!;
      await f.engine.act(
        session.session_id,
        { action: 'fill', element_id: notes.id, value: 'still works' },
        observed.revision,
      );
      observed = await f.engine.observe(session.session_id);
      assert.equal(observed.elements!.find(e => e.name === 'Notes')!.value, 'still works');
    } finally {
      await f.close();
    }
  },
);

test('a button that replaces itself on click succeeds and the session keeps working', { timeout: 40000 }, async () => {
  const f = await page(REPLACING_PAGE);
  try {
    const session = await f.open();
    let observed = await f.engine.observe(session.session_id);
    const result = (await f.engine.act(
      session.session_id,
      { action: 'click', element_id: observed.elements!.find(e => e.name === 'Save')!.id },
      observed.revision,
    )) as { ok: boolean };
    assert.equal(result.ok, true);
    observed = await f.engine.observe(session.session_id);
    assert.ok(observed.elements!.some(e => e.name === 'Saved'));
    await f.engine.act(
      session.session_id,
      { action: 'click', element_id: observed.elements!.find(e => e.name === 'Saved')!.id },
      observed.revision,
    );
    assert.equal(f.engine.listSessions().sessions.length, 1);
  } finally {
    await f.close();
  }
});

test(
  'adl_execute step results carry the target_replaced warning and the batch completes',
  { timeout: 40000 },
  async () => {
    const f = await page(REPLACING_PAGE);
    try {
      const session = await f.open();
      const observed = await f.engine.observe(session.session_id);
      const task = f.engine.execute(
        [
          {
            session_id: session.session_id,
            action: 'check',
            element_id: observed.elements!.find(e => e.name === 'Buy milk')!.id,
            checked: true,
          },
        ],
        { [session.session_id]: observed.revision },
      );
      let state = f.engine.task(task.task_id);
      for (let i = 0; i < 200 && ['queued', 'running'].includes(state.status); i++) {
        await new Promise(r => setTimeout(r, 50));
        state = f.engine.task(task.task_id);
      }
      assert.equal(state.status, 'completed', JSON.stringify(state));
      assert.ok(
        (state.results[0]!.warnings as { code: string }[] | undefined)?.some(w => w.code === 'target_replaced'),
        JSON.stringify(state.results),
      );
      assert.equal(f.engine.listSessions().sessions.length, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'a checkbox that vanishes before the click still fails safely and closes the session',
  { timeout: 40000 },
  async () => {
    // The overlay keeps Playwright retrying; the first mouse move over it removes the checkbox, so the same "not attached" error arrives with no click ever sent.
    const html = `<!doctype html><body><input id="ghost" type="checkbox" aria-label="Ghost"><div id="cover" style="position:fixed;left:0;top:0;right:0;bottom:0"></div>
<script>document.getElementById('cover').addEventListener('mousemove',()=>setTimeout(()=>document.getElementById('ghost').remove(),150));</script></body>`;
    const f = await page(html, { operationMode: undefined }, [{ selector: '#ghost', actions: ['check'] }]);
    try {
      const session = await f.open();
      const observed = await f.engine.observe(session.session_id);
      const ghost = observed.elements!.find(e => e.name === 'Ghost')!;
      await assert.rejects(
        f.engine.act(session.session_id, { action: 'check', element_id: ghost.id, checked: true }, observed.revision),
        (error: unknown) => {
          const safe = safeError(error);
          return safe.code === 'E_INTERNAL' && safe.may_have_executed === true;
        },
      );
      assert.equal(
        f.engine.listSessions().sessions.length,
        0,
        'unproven execution keeps the safe close-the-session behaviour',
      );
    } finally {
      await f.close();
    }
  },
);

function fakeBrowser(seen: { config?: BrowserTargetConfig | undefined }[] = []): Adapter & { pngs: Buffer[] } {
  const pngs: Buffer[] = [];
  return {
    pngs,
    open: async (_target, _mode, _signal, config) => {
      seen.push({ config });
      const session: AdapterSession = {
        snapshot: async () => ({
          elements: [{ id: 'e', role: 'button', name: 'Go', enabled: true }],
          fingerprint: 'same',
          truncated: false,
        }),
        act: async () => {},
        close: async () => {},
        capture: async () => ({
          png: await sharp({ create: { width: 32, height: 32, channels: 3, background: '#336699' } })
            .png()
            .toBuffer(),
          captured_at: new Date().toISOString(),
          coordinate_space: 'viewport_css_pixels',
          viewport: { width: 32, height: 32, scroll_x: 0, scroll_y: 0, device_scale_factor: 1 },
          redacted: false,
        }),
      };
      return session;
    },
    close: async () => {},
  };
}
const broad = (extra: Partial<PolicyConfig> = {}) => ({
  ...parsePolicy({ allowAllOperations: true, allowLoopback: true }),
  ...extra,
});

test('100 distinct URL opens never fail and never mutate the trusted target list', { timeout: 30000 }, async () => {
  const seen: { config?: BrowserTargetConfig | undefined }[] = [];
  const policy = broad(),
    engine = new Engine(policy, { browser: fakeBrowser(seen) });
  try {
    for (let i = 0; i < 100; i++) {
      const session = await engine.openUrl(`http://127.0.0.1:8123/page/${i}?q=${i}`);
      assert.equal(seen[i]!.config?.url, `http://127.0.0.1:8123/page/${i}?q=${i}`);
      await engine.close(session.session_id);
    }
    assert.equal(policy.browserTargets.length, 0, 'URL opens must not touch policy.browserTargets');
    assert.equal((await engine.listTargets()).targets.length, 0, 'idle URL targets are not listed');
  } finally {
    await engine.shutdown();
  }
});

test(
  'a URL target with an open session is listed, never evicted and is reused for the same URL',
  { timeout: 30000 },
  async () => {
    const seen: { config?: BrowserTargetConfig | undefined }[] = [];
    const policy = broad(),
      engine = new Engine(policy, { browser: fakeBrowser(seen) });
    try {
      const first = await engine.openUrl('http://127.0.0.1:8123/keep');
      const targetId = engine.listSessions().sessions[0]!.target_id;
      for (let i = 0; i < 100; i++) {
        const session = await engine.openUrl(`http://127.0.0.1:8123/other/${i}`);
        await engine.close(session.session_id);
      }
      const listed = (await engine.listTargets()).targets;
      assert.deepEqual(
        listed.map(t => t.target_id),
        [targetId],
        'only the target that has a session remains listed',
      );
      const again = await engine.openUrl('http://127.0.0.1:8123/keep');
      assert.equal(
        engine.listSessions().sessions.filter(s => s.target_id === targetId).length,
        2,
        'same URL reuses the same target',
      );
      assert.equal(seen[0]!.config!.id, seen.at(-1)!.config!.id);
      await engine.close(again.session_id);
      await engine.close(first.session_id);
    } finally {
      await engine.shutdown();
    }
  },
);

test('capture still finds the configuration of a URL-opened target', { timeout: 30000 }, async () => {
  const adapter = fakeBrowser(),
    policy = broad(),
    engine = new Engine(policy, { browser: adapter });
  try {
    const session = await engine.openUrl('http://127.0.0.1:8123/shot');
    const image = await engine.capture(session.session_id);
    assert.ok(image.metadata.frame_id);
    assert.ok(image.png.length > 0);
  } finally {
    await engine.shutdown();
  }
});

test(
  'gesture and capture find the registry configuration of a URL-opened real browser target',
  { timeout: 40000 },
  async () => {
    const app = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><body style="margin:0;height:400px;background:#ffffff">Board</body>');
    });
    const origin = await listen(app);
    const policy = parsePolicy({ allowAllOperations: true, allowLoopback: true, actionTimeoutMs: 5000 });
    const engine = new Engine(policy, {
      browser: new BrowserAdapter(policy, (url, purpose) => assertUrlAllowed(url, policy, undefined, purpose)),
    });
    try {
      const session = await engine.openUrl(origin + '/board');
      assert.equal(policy.browserTargets.length, 0);
      const frame = await engine.capture(session.session_id);
      const moved = await engine.gesture(session.session_id, {
        frame_id: frame.metadata.frame_id,
        expected_revision: frame.metadata.revision,
        surface_id: 'page',
        kind: 'drag',
        points: [
          { x: 50, y: 50, t_ms: 0 },
          { x: 150, y: 80, t_ms: 50 },
          { x: 260, y: 120, t_ms: 100 },
        ],
      });
      assert.equal(moved.metadata.gesture.released_input, true);
    } finally {
      await engine.shutdown();
      await shut(app);
    }
  },
);

test(
  'configured targets stay untouched while many URL opens under their origin inherit their controls',
  { timeout: 30000 },
  async () => {
    const seen: { config?: BrowserTargetConfig | undefined }[] = [];
    const controls = [{ selector: '#go', actions: ['click' as const] }];
    const policy = parsePolicy({
      allowedOrigins: ['http://127.0.0.1:8123'],
      allowLoopback: true,
      browserTargets: [
        { id: 'fixed', label: 'Fixed', url: 'http://127.0.0.1:8123/', classification: 'PUBLIC', controls },
      ],
    });
    const engine = new Engine(policy, { browser: fakeBrowser(seen) });
    try {
      for (let i = 0; i < 80; i++) {
        const session = await engine.openUrl(`http://127.0.0.1:8123/doc/${i}`);
        await engine.close(session.session_id);
      }
      assert.equal(policy.browserTargets.length, 1);
      assert.deepEqual(
        engine.capabilities().permissions.targets,
        [{ application_id: 'fixed', origin: 'http://127.0.0.1:8123' }],
        'capabilities list only configured targets',
      );
      const listed = (await engine.listTargets()).targets;
      assert.equal(listed.length, 1);
      assert.equal(listed[0]!.application_id, 'fixed');
      assert.deepEqual(seen.at(-1)!.config!.controls, controls);
      assert.equal(seen.at(-1)!.config!.url, 'http://127.0.0.1:8123/doc/79');
      const configuredSession = await engine.openUrl('http://127.0.0.1:8123/');
      assert.equal(configuredSession.ok, true);
    } finally {
      await engine.shutdown();
    }
  },
);

test(
  'a really exhausted URL registry raises a specific resource-limit reason and recovers when a session closes',
  { timeout: 30000 },
  async () => {
    const policy = broad({ maxSessions: 100 }),
      engine = new Engine(policy, { browser: fakeBrowser() });
    try {
      const sessions = [];
      for (let i = 0; i < 64; i++) sessions.push(await engine.openUrl(`http://127.0.0.1:8123/live/${i}`));
      await assert.rejects(engine.openUrl('http://127.0.0.1:8123/live/64'), (error: unknown) => {
        const safe = safeError(error);
        return safe.code === 'E_RESOURCE_LIMIT' && safe.reason === 'target_limit' && safe.limit === 64;
      });
      assert.equal((await engine.listTargets()).targets.length, 64);
      await engine.close(sessions[0]!.session_id);
      const next = await engine.openUrl('http://127.0.0.1:8123/live/64');
      assert.equal(next.ok, true);
    } finally {
      await engine.shutdown();
    }
  },
);

test(
  'session limit, URL, argument and revision mistakes report specific reasons with hints',
  { timeout: 30000 },
  async () => {
    const policy = broad({ maxSessions: 1 }),
      engine = new Engine(policy, { browser: fakeBrowser() });
    try {
      const session = await engine.openUrl('http://127.0.0.1:8123/a');
      await assert.rejects(engine.openUrl('http://127.0.0.1:8123/b'), (error: unknown) => {
        const safe = safeError(error);
        return (
          safe.code === 'E_RESOURCE_LIMIT' &&
          safe.reason === 'session_limit' &&
          safe.limit === 1 &&
          /adl_close/.test(safe.safe_message) &&
          /adl_sessions/.test(safe.safe_message)
        );
      });
      await assert.rejects(
        engine.openUrl('ftp://127.0.0.1/x'),
        (error: unknown) => safeError(error).reason === 'invalid_url',
      );
      await assert.rejects(engine.act(session.session_id, { action: 'click' }, 1), (error: unknown) => {
        const safe = safeError(error);
        return safe.code === 'E_INVALID_ARGUMENT' && safe.argument === 'element_id';
      });
      await assert.rejects(
        engine.act(session.session_id, { action: 'click', element_id: 'e1' }, session.revision + 5),
        (error: unknown) => {
          const safe = safeError(error);
          return (
            safe.code === 'E_STALE_STATE' &&
            safe.reason === 'revision_ahead' &&
            safe.argument === 'expected_revision' &&
            /adl_observe/.test(safe.safe_message)
          );
        },
      );
      assert.throws(
        () =>
          engine.execute([{ session_id: session.session_id, action: 'click', element_id: 'e1' }], {
            [session.session_id]: session.revision + 9,
          }),
        (error: unknown) => safeError(error).reason === 'revision_ahead',
      );
      assert.throws(
        () =>
          engine.execute([{ session_id: session.session_id, action: 'click', element_id: 'e1' }], {
            [session.session_id]: 0,
          }),
        (error: unknown) => safeError(error).argument === 'expected_revisions',
      );
      await assert.rejects(
        engine.capture(session.session_id, { region: { x: 0, y: 0, width: 8, height: 8 } }),
        (error: unknown) => {
          const safe = safeError(error);
          return safe.code === 'E_INVALID_ARGUMENT' && safe.reason === 'region_requires_frame_id';
        },
      );
      await assert.rejects(
        engine.record(session.session_id, { frame_count: 16, interval_ms: 2000 }),
        (error: unknown) => safeError(error).reason === 'sequence_span_too_long',
      );
      // The mistakes above never consumed or damaged the session.
      const ok = await engine.act(session.session_id, { action: 'click', element_id: 'e1' }, session.revision);
      assert.equal(ok.ok, true);
    } finally {
      await engine.shutdown();
    }
  },
);

test(
  'observe argument mistakes name the argument, and an unknown target_id says to list targets again',
  { timeout: 30000 },
  async () => {
    const policy = broad(),
      engine = new Engine(policy, { browser: fakeBrowser() });
    try {
      const session = await engine.openUrl('http://127.0.0.1:8123/args');
      const bad: [string, Record<string, unknown>][] = [
        ['token_budget', { token_budget: 100 }],
        ['token_budget', { token_budget: 9000 }],
        ['token_budget', { token_budget: 'big' }],
        ['include', { include: ['bogus'] }],
        ['include', { include: 'id' }],
        ['include', { include: [7] }],
        ['representation', { representation: 'bogus' }],
        ['format', { format: 'xml' }],
        ['cursor', { cursor: 'no-such-cursor' }],
        ['since_revision', { since_revision: -1 }],
        ['since_revision', { since_revision: 1.5 }],
        ['scope', { scope: 5 }],
        ['depth', { depth: 0 }],
      ];
      for (const [argument, options] of bad)
        await assert.rejects(
          engine.observe(session.session_id, options as never),
          (error: unknown) => {
            const safe = safeError(error);
            return (
              safe.code === 'E_INVALID_ARGUMENT' && safe.reason === 'invalid_argument' && safe.argument === argument
            );
          },
          JSON.stringify(options),
        );
      await assert.rejects(
        engine.observe(session.session_id, { since_revision: session.revision + 9 }),
        (error: unknown) => {
          const safe = safeError(error);
          return (
            safe.code === 'E_INVALID_ARGUMENT' && safe.reason === 'revision_ahead' && safe.argument === 'since_revision'
          );
        },
      );
      await assert.rejects(engine.open('t_does_not_exist'), (error: unknown) => {
        const safe = safeError(error);
        return (
          safe.code === 'E_TARGET_NOT_FOUND' &&
          safe.reason === 'unknown_target' &&
          safe.argument === 'target_id' &&
          /adl_targets/.test(safe.safe_message)
        );
      });
      // The mistakes never consumed or damaged the session.
      assert.equal((await engine.observe(session.session_id, { token_budget: 1800 })).ok, true);
    } finally {
      await engine.shutdown();
    }
  },
);

test('safeError keeps carrying workspace setting hints consistently', () => {
  assert.equal(
    safeError(new AdlError('E_POLICY_DENIED', 'origin_not_allowed')).workspace_setting,
    'agentdesklink.browserOrigins',
  );
  assert.equal(
    safeError(new AdlError('E_POLICY_DENIED', 'method_requires_approval')).workspace_setting,
    'agentdesklink.operationMode',
  );
  assert.equal(
    safeError(new AdlError('E_APPROVAL_REQUIRED', 'consequential_operation')).workspace_setting,
    'agentdesklink.operationMode',
  );
  assert.equal(
    safeError(new AdlError('E_APPROVAL_REQUIRED', 'operation_not_granted')).policy_setting,
    'browserTargets[].controls',
  );
  const plain = safeError(new AdlError('E_INVALID_ARGUMENT'));
  assert.equal(plain.argument, undefined);
  assert.equal(plain.limit, undefined);
});

test('stdio clients receive specific reasons instead of "Invalid input"', { timeout: 60000 }, async () => {
  const app = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<body><button>Go</button></body>');
  });
  const origin = await listen(app);
  const dir = await mkdtemp(join(tmpdir(), 'adl-robust-'));
  await writeFile(
    join(dir, 'policy.json'),
    JSON.stringify({
      allowedOrigins: [origin],
      allowLoopback: true,
      maxSessions: 1,
      operationMode: 'standard',
      browserTargets: [
        { id: 'fixture', label: 'Fixture', url: origin, classification: 'PUBLIC', visual: { enabled: true } },
      ],
    }),
  );
  const client = new Client({ name: 'robustness', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['dist/src/server.js', '--config', join(dir, 'policy.json')],
        cwd: process.cwd(),
        stderr: 'pipe',
        env: browserRuntimeEnv(),
      }),
    );
    const call = async (name: string, args: Record<string, unknown> = {}) =>
      JSON.parse(
        ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text,
      );
    const targets = await call('adl_targets');
    const session = await call('adl_open', { target_id: targets.targets[0].target_id });
    const second = await call('adl_open', { target_id: targets.targets[0].target_id });
    assert.equal(second.error.code, 'E_RESOURCE_LIMIT');
    assert.equal(second.error.reason, 'session_limit');
    assert.equal(second.error.limit, 1);
    const region = await call('adl_capture', {
      session_id: session.session_id,
      region: { x: 0, y: 0, width: 10, height: 10 },
    });
    assert.equal(region.error.code, 'E_INVALID_ARGUMENT');
    assert.equal(region.error.reason, 'region_requires_frame_id');
    const ahead = await call('adl_act', {
      session_id: session.session_id,
      expected_revision: session.revision + 7,
      action: 'click',
      element_id: 'x',
    });
    assert.equal(ahead.error.reason, 'revision_ahead');
    const record = await call('adl_record', { session_id: session.session_id, frame_count: 16, interval_ms: 2000 });
    assert.equal(record.error.reason, 'sequence_span_too_long');
    const cursor = await call('adl_observe', { session_id: session.session_id, cursor: 'no-such-cursor' });
    assert.equal(cursor.error.code, 'E_INVALID_ARGUMENT');
    assert.equal(cursor.error.reason, 'invalid_argument');
    assert.equal(cursor.error.argument, 'cursor');
    const since = await call('adl_observe', { session_id: session.session_id, since_revision: session.revision + 7 });
    assert.equal(since.error.code, 'E_INVALID_ARGUMENT');
    assert.equal(since.error.reason, 'revision_ahead');
    assert.equal(since.error.argument, 'since_revision');
    const unknown = await call('adl_open', { target_id: 't_does_not_exist' });
    assert.equal(unknown.error.code, 'E_TARGET_NOT_FOUND');
    assert.equal(unknown.error.reason, 'unknown_target');
    assert.equal(unknown.error.argument, 'target_id');
    assert.match(unknown.error.safe_message, /adl_targets/);
    for (const args of [{}, { target_id: targets.targets[0].target_id, url: origin }]) {
      const both = await call('adl_open', args);
      assert.equal(both.error.code, 'E_INVALID_ARGUMENT');
      assert.equal(both.error.reason, 'invalid_argument');
      assert.equal(both.error.argument, 'target_id|url');
    }
  } finally {
    await client.close();
    await shut(app);
    await rm(dir, { recursive: true, force: true });
  }
});
