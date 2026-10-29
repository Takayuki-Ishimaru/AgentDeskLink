import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeDesktopAdapter } from '../src/desktop.js';
import { Engine } from '../src/core.js';
import { parsePolicy } from '../src/policy.js';
import type { Adapter, DesktopConfig, Target } from '../src/types.js';

const APP = 'com.example.background';
const HELPER = `import{createInterface}from'node:readline';
let running=false,managed=false;
createInterface({input:process.stdin}).on('line',async l=>{const r=JSON.parse(l);await import('node:fs/promises').then(fs=>fs.appendFile(process.env.ADL_TEST_LOG,JSON.stringify(r)+'\\n'));
if(r.op==='application'){let changed=false;if(r.action==='launch'){changed=!running;running=true;managed=true;}if(r.action==='quit'){changed=running;running=false;managed=false;}process.stdout.write(JSON.stringify({ok:true,request_id:r.request_id,result:{running,managed,changed}})+'\\n');return;}
process.stdout.write(JSON.stringify({ok:false,request_id:r.request_id,error:{code:'E_INVALID_ARGUMENT'}})+'\\n');});`;
const browser: Adapter = {
  open: async () => {
    throw new Error('not used');
  },
  close: async () => {},
};
async function harness(enabled = true, platform = 'darwin') {
  const dir = await mkdtemp(join(tmpdir(), 'adl-app-test-')),
    file = join(dir, 'helper.mjs'),
    log = join(dir, 'calls.jsonl');
  await writeFile(file, HELPER);
  let starts = 0;
  let argv: string[] = [];
  const config = {
    helperPath: file,
    appId: APP,
    appPath: '/Applications/Background.app/Contents/MacOS/Background',
    classification: 'PUBLIC',
    lifecycle: { enabled },
  } as unknown as DesktopConfig;
  const adapter = new NativeDesktopAdapter(config, {
    platform,
    spawnFn: (exe, args) => {
      starts++;
      argv = args;
      return spawn(process.execPath, [exe, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ADL_TEST_LOG: log },
      });
    },
  });
  const lifecycle = adapter as unknown as {
    application(
      id: string,
      action: 'status' | 'launch' | 'quit',
      signal: AbortSignal,
    ): Promise<{ running: boolean; managed: boolean; changed: boolean }>;
  };
  return {
    adapter,
    lifecycle,
    config,
    starts: () => starts,
    args: () => argv,
    rows: async () => JSON.parse('[' + (await readFile(log, 'utf8')).trim().split('\n').join(',') + ']'),
    close: async () => {
      await adapter.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const signal = () => new AbortController().signal;
test('lifecycle is explicit opt-in and wrong app IDs cannot start a helper', { timeout: 10000 }, async () => {
  const off = await harness(false),
    on = await harness();
  try {
    await assert.rejects(off.lifecycle.application(APP, 'launch', signal()), { code: 'E_POLICY_DENIED' });
    assert.equal(off.starts(), 0);
    await assert.rejects(on.lifecycle.application('com.other.app', 'launch', signal()), { code: 'E_POLICY_DENIED' });
    assert.equal(on.starts(), 0);
  } finally {
    await off.close();
    await on.close();
  }
});
test('native lifecycle sends only fixed application operation and startup flag', { timeout: 10000 }, async () => {
  const h = await harness();
  try {
    assert.deepEqual(await h.lifecycle.application(APP, 'status', signal()), {
      running: false,
      managed: false,
      changed: false,
    });
    assert.deepEqual(await h.lifecycle.application(APP, 'launch', signal()), {
      running: true,
      managed: true,
      changed: true,
    });
    assert.equal((await h.lifecycle.application(APP, 'launch', signal())).changed, false);
    assert.deepEqual(await h.lifecycle.application(APP, 'quit', signal()), {
      running: false,
      managed: false,
      changed: true,
    });
    assert.ok(h.args().includes('--lifecycle-enabled'));
    for (const row of await h.rows()) {
      assert.equal(row.op, 'application');
      assert.deepEqual(Object.keys(row).sort(), ['action', 'op', 'request_id']);
    }
  } finally {
    await h.close();
  }
});
test('pre-cancelled lifecycle does not launch its helper', { timeout: 10000 }, async () => {
  const h = await harness();
  try {
    const c = new AbortController();
    c.abort();
    await assert.rejects(h.lifecycle.application(APP, 'launch', c.signal), { code: 'E_CANCELLED' });
    assert.equal(h.starts(), 0);
  } finally {
    await h.close();
  }
});
test('lifecycle policy validates a strict boolean opt-in', () => {
  const base = { macos: { helperPath: '/helper', appId: APP, appPath: '/app', classification: 'PUBLIC' } };
  assert.doesNotThrow(() => parsePolicy({ ...base, macos: { ...base.macos, lifecycle: { enabled: true } } }));
  for (const lifecycle of [
    { enabled: 'true' },
    { enabled: true, command: 'arbitrary' },
    { enabled: true, force: true },
  ])
    assert.throws(() => parsePolicy({ ...base, macos: { ...base.macos, lifecycle } }));
});
test(
  'Engine exposes only its configured opted-in application and returns lifecycle state',
  { timeout: 10000 },
  async () => {
    const h = await harness();
    const policy = parsePolicy({ macos: h.config });
    const engine = new Engine(policy, { browser, desktop: h.adapter }, 'darwin');
    const api = engine as unknown as {
      applications(): Promise<{ ok: boolean; applications: { application_id: string }[] }>;
      application(
        id: string,
        action: 'status' | 'launch' | 'quit',
        signal?: AbortSignal,
      ): Promise<{ ok: boolean; running: boolean; managed: boolean; changed: boolean }>;
    };
    try {
      const listed = await api.applications();
      assert.equal(listed.ok, true);
      assert.deepEqual(
        listed.applications.map(x => x.application_id),
        [APP],
      );
      assert.equal((await api.application(APP, 'launch')).running, true);
      assert.equal((await api.application(APP, 'quit')).running, false);
      await assert.rejects(api.application('com.other.app', 'launch'), { code: 'E_POLICY_DENIED' });
    } finally {
      await engine.shutdown();
      await h.close();
    }
  },
);

const WIN_APP = 'local.adl.background';
const HANG = `import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';
let pending;const out=(r,result)=>process.stdout.write(JSON.stringify({ok:true,request_id:r.request_id,result})+'\\n');
createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);appendFileSync(process.env.ADL_TEST_LOG,JSON.stringify(r)+'\\n');
if(r.op==='cancel_input'){if(pending){const p=pending;pending=undefined;out(p,{running:true,managed:true,changed:true});}return;}
if(r.op!=='application'){out(r,{running:false,managed:false,changed:false});return;}
if(r.action==='launch'&&process.env.ADL_MODE==='hang'){pending=r;return;}
if(r.action==='launch'&&process.env.ADL_MODE==='slow'){setTimeout(()=>out(r,{running:true,managed:true,changed:true}),400);return;}
if(r.action==='launch'){out(r,{running:true,managed:true,changed:true});return;}
out(r,{running:false,managed:false,changed:r.action==='quit'});});`;
async function raw(platform: string, mode = '', helper = HELPER) {
  const dir = await mkdtemp(join(tmpdir(), 'adl-app-raw-')),
    file = join(dir, 'helper.mjs'),
    log = join(dir, 'calls.jsonl');
  await writeFile(file, helper);
  const starts: string[][] = [];
  const config = {
    helperPath: file,
    appId: WIN_APP,
    appPath: '/opt/app',
    classification: 'PUBLIC',
    lifecycle: { enabled: true },
  } as unknown as DesktopConfig;
  const adapter = new NativeDesktopAdapter(config, {
    platform,
    spawnFn: (exe, args) => {
      starts.push(args);
      return spawn(process.execPath, [exe, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ADL_TEST_LOG: log, ADL_MODE: mode },
      });
    },
  });
  const rows = async () => {
    try {
      return (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const close = async () => {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  };
  return { adapter, config, starts, rows, close };
}

const baseConfig = {
  helperPath: '/helper',
  appId: APP,
  appPath: '/Applications/Background.app/Contents/MacOS/Background',
  classification: 'PUBLIC',
} as unknown as DesktopConfig;
function fakeBrowser() {
  let closed = 0;
  const adapter = {
    open: async () => ({
      snapshot: async () => ({
        fingerprint: 'b',
        elements: [{ id: 'h', role: 'heading', name: 'Browser remains available', enabled: true }],
        truncated: false,
      }),
      act: async () => {},
      close: async () => {
        closed++;
      },
    }),
    close: async () => {},
  } as unknown as Adapter;
  return { adapter, closed: () => closed };
}
function fakeDesktop(appId: string) {
  const targets = [
    {
      target_id: 't_win1',
      surface: 'desktop',
      application_id: appId,
      label: 'App',
      policy_class: 'PUBLIC',
      capabilities: ['observe', 'click', 'fill', 'select', 'check', 'scroll', 'read_state', 'wait_for'],
    } as unknown as Target,
  ];
  let opened = 0,
    closed = 0;
  const lifecycle: string[] = [];
  let alive = true;
  const adapter = {
    discover: async () => (alive ? targets.map(t => ({ ...t })) : []),
    open: async () => {
      opened++;
      return {
        snapshot: async () => ({
          fingerprint: 'd' + opened,
          elements: [{ id: 'e1', role: 'button', name: 'Desktop window', enabled: true }],
          truncated: false,
        }),
        act: async () => {},
        close: async () => {
          closed++;
        },
      };
    },
    close: async () => {},
    application: async (_id: string, action: 'status' | 'launch' | 'quit') => {
      lifecycle.push(action);
      if (action === 'quit') {
        alive = false;
        return { running: false, managed: false, changed: true };
      }
      const was = alive;
      alive = true;
      return { running: true, managed: true, changed: !was };
    },
    desktopCapabilities: () => ({ available: true, mutations: true, lifecycle: true }),
  } as unknown as Adapter;
  return { adapter, openedCount: () => opened, closedCount: () => closed, lifecycle };
}

type Life = {
  application(
    id: string,
    action: 'status' | 'launch' | 'quit',
    signal: AbortSignal,
  ): Promise<{ running: boolean; managed: boolean; changed: boolean }>;
};
const life = (a: unknown) => a as Life;

test('Windows lifecycle is explicit opt-in and wrong app IDs cannot start a helper', { timeout: 10000 }, async () => {
  const off = await harness(false, 'win32'),
    on = await harness(true, 'win32');
  try {
    await assert.rejects(off.lifecycle.application(APP, 'launch', signal()), { code: 'E_POLICY_DENIED' });
    assert.equal(off.starts(), 0);
    await assert.rejects(on.lifecycle.application('com.other.app', 'launch', signal()), { code: 'E_POLICY_DENIED' });
    assert.equal(on.starts(), 0);
    const c = new AbortController();
    c.abort();
    await assert.rejects(on.lifecycle.application(APP, 'launch', c.signal), { code: 'E_CANCELLED' });
    assert.equal(on.starts(), 0);
  } finally {
    await off.close();
    await on.close();
  }
});
test('Windows lifecycle sends the same fixed protocol and startup flag as macOS', { timeout: 10000 }, async () => {
  const h = await harness(true, 'win32');
  try {
    assert.deepEqual(await h.lifecycle.application(APP, 'status', signal()), {
      running: false,
      managed: false,
      changed: false,
    });
    assert.deepEqual(await h.lifecycle.application(APP, 'launch', signal()), {
      running: true,
      managed: true,
      changed: true,
    });
    assert.equal((await h.lifecycle.application(APP, 'launch', signal())).changed, false);
    assert.deepEqual(await h.lifecycle.application(APP, 'quit', signal()), {
      running: false,
      managed: false,
      changed: true,
    });
    assert.ok(h.args().includes('--lifecycle-enabled'));
    for (const row of await h.rows()) {
      assert.equal(row.op, 'application');
      assert.deepEqual(Object.keys(row).sort(), ['action', 'op', 'request_id']);
    }
  } finally {
    await h.close();
  }
});
test('Engine advertises and dispatches lifecycle identically on win32 and darwin', { timeout: 10000 }, async () => {
  for (const platform of ['win32', 'darwin']) {
    const h = await harness(true, platform);
    const policy = parsePolicy(platform === 'win32' ? { windows: h.config } : { macos: h.config });
    const engine = new Engine(policy, { browser, desktop: h.adapter }, platform);
    try {
      const caps = engine.capabilities() as unknown as {
        lifecycle: { configured: boolean; available: boolean; platform_supported: boolean; mode: string };
      };
      assert.deepEqual(caps.lifecycle, {
        configured: true,
        available: true,
        platform_supported: true,
        mode: 'background_semantic',
      });
      const listed = await (
        engine as unknown as {
          applications(): Promise<{ applications: { application_id: string; capabilities: string[]; mode: string }[] }>;
        }
      ).applications();
      assert.deepEqual(
        listed.applications.map(x => x.application_id),
        [APP],
      );
      assert.equal((await engine.application(APP, 'launch')).running, true);
      assert.equal((await engine.application(APP, 'launch')).changed, false);
      assert.equal((await engine.application(APP, 'quit')).running, false);
      await assert.rejects(engine.application('com.other.app', 'launch'), { code: 'E_POLICY_DENIED' });
    } finally {
      await engine.shutdown();
      await h.close();
    }
  }
});
test('unsupported platforms neither advertise nor dispatch lifecycle', { timeout: 10000 }, async () => {
  for (const platform of ['linux', 'freebsd']) {
    const h = await harness(true, platform);
    const engine = new Engine(parsePolicy({ windows: h.config }), { browser, desktop: h.adapter }, platform);
    try {
      const caps = engine.capabilities() as unknown as {
        lifecycle: { configured: boolean; available: boolean; platform_supported: boolean };
      };
      assert.deepEqual(
        {
          configured: caps.lifecycle.configured,
          available: caps.lifecycle.available,
          platform_supported: caps.lifecycle.platform_supported,
        },
        { configured: true, available: false, platform_supported: false },
      );
      assert.deepEqual((await engine.applications()).applications, []);
      await assert.rejects(engine.application(APP, 'launch'), { code: 'E_UNSUPPORTED_ACTION' });
      await assert.rejects(life(h.adapter).application(APP, 'launch', signal()), { code: 'E_UNSUPPORTED_ACTION' });
      assert.equal(h.starts(), 0);
    } finally {
      await engine.shutdown();
      await h.close();
    }
  }
});
test(
  'Windows lifecycle cancellation after dispatch reports mayHaveExecuted and never touches input',
  { timeout: 10000 },
  async () => {
    const h = await raw('win32', 'hang', HANG);
    try {
      const c = new AbortController();
      const p = life(h.adapter)
        .application(WIN_APP, 'launch', c.signal)
        .then(
          () => ({ code: 'UNEXPECTED', maybe: false }),
          e => ({ code: e.code, maybe: e.mayHaveExecuted }),
        );
      for (let i = 0; i < 100 && !(await h.rows()).some(r => r.op === 'application'); i++) await delay(10);
      assert.ok((await h.rows()).some(r => r.op === 'application'));
      c.abort();
      assert.deepEqual(await p, { code: 'E_CANCELLED', maybe: true });
      assert.ok((await h.rows()).some(r => r.op === 'cancel_input'));
      assert.ok(h.starts.every(a => a.includes('--lifecycle-enabled') && !a.includes('--release-input')));
    } finally {
      await h.close();
    }
  },
);
test('Windows lifecycle timeout after dispatch reports mayHaveExecuted', { timeout: 10000 }, async () => {
  const h = await raw('win32', 'slow', HANG);
  try {
    const engine = new Engine(
      parsePolicy({ windows: h.config, actionTimeoutMs: 100 }),
      { browser, desktop: h.adapter },
      'win32',
    );
    try {
      await assert.rejects(
        engine.application(WIN_APP, 'launch'),
        (e: Error & { code: string; mayHaveExecuted?: boolean }) =>
          e.code === 'E_TIMEOUT' && e.mayHaveExecuted === true,
      );
    } finally {
      await engine.shutdown();
    }
  } finally {
    await h.close();
  }
});
test('Windows lifecycle calls are dispatched FIFO over one helper', { timeout: 10000 }, async () => {
  const h = await raw('win32', '', HANG);
  try {
    await Promise.all(
      ['launch', 'status', 'quit'].map(a =>
        life(h.adapter).application(WIN_APP, a as 'launch' | 'status' | 'quit', signal()),
      ),
    );
    assert.deepEqual(
      (await h.rows()).map(r => r.action),
      ['launch', 'status', 'quit'],
    );
    assert.equal(h.starts.length, 1);
  } finally {
    await h.close();
  }
});
test(
  'Windows quit closes the desktop session and denies its old handle while the browser session stays usable',
  { timeout: 10000 },
  async () => {
    const desktop = fakeDesktop(WIN_APP);
    const browserFake = fakeBrowser();
    const policy = parsePolicy({
      windows: { ...baseConfig, appId: WIN_APP, lifecycle: { enabled: true } },
      browserTargets: [{ id: 'browser', label: 'Browser', url: 'https://example.com', classification: 'PUBLIC' }],
    });
    const engine = new Engine(policy, { browser: browserFake.adapter, desktop: desktop.adapter }, 'win32');
    try {
      const targets = await engine.listTargets();
      const desktopTarget = targets.targets.find(t => t.surface === 'desktop')!;
      assert.ok(desktopTarget);
      const desk = await engine.open(desktopTarget.target_id, 'background_semantic');
      const browser = await engine.open((await engine.listTargets('browser')).targets[0]!.target_id);
      assert.equal((await engine.observe(desk.session_id)).elements![0]!.name, 'Desktop window');
      assert.equal((await engine.application(WIN_APP, 'launch')).running, true);
      assert.equal((await engine.application(WIN_APP, 'quit')).running, false);
      assert.equal(desktop.closedCount(), 1, 'the desktop adapter session must actually be closed');
      await assert.rejects(engine.observe(desk.session_id), { code: 'E_TARGET_NOT_FOUND' });
      assert.equal((await engine.observe(browser.session_id)).elements![0]!.name, 'Browser remains available');
      assert.deepEqual(
        (await engine.listTargets()).targets.filter(t => t.surface === 'desktop'),
        [],
      );
    } finally {
      await engine.shutdown();
    }
  },
);
