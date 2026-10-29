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
import type { Adapter, DesktopConfig } from '../src/types.js';

const APP = 'local.adl.background';
const HELPER = `import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';
let pending;const out=(r,result,error,maybe=false)=>process.stdout.write(JSON.stringify({ok:!error,request_id:r.request_id,...(error?{error:{code:error},may_have_executed:maybe}:{result})})+'\\n');
createInterface({input:process.stdin}).on('line',l=>{const r=JSON.parse(l);appendFileSync(process.env.ADL_LOG,JSON.stringify(r)+'\\n');
if(r.op==='cancel_input'){if(pending&&process.env.ADL_MODE!=='hang'){out(pending,null,'E_CANCELLED',true);pending=undefined;}return;}
if(r.op!=='application'){out(r,null,'E_INVALID_ARGUMENT');return;}
if(r.action==='launch'&&['cancel','hang'].includes(process.env.ADL_MODE)){pending=r;return;}
if(process.env.ADL_MODE==='bad'){out(r,{running:'yes',managed:false,changed:false});return;}
if(process.env.ADL_MODE==='extra'){out(r,{running:false,managed:false,changed:false,path:'/untrusted'});return;}
if(process.env.ADL_MODE==='incoherent'){out(r,{running:false,managed:true,changed:false});return;}
if(process.env.ADL_MODE==='denied'&&r.action==='quit'){out(r,null,'E_POLICY_DENIED');return;}
setTimeout(()=>out(r,{running:r.action==='launch',managed:r.action==='launch',changed:r.action!=='status'}),20);
});`;
async function harness(mode = '', platform = 'darwin') {
  const dir = await mkdtemp(join(tmpdir(), 'adl-life-contract-')),
    file = join(dir, 'helper.mjs'),
    log = join(dir, 'calls');
  await writeFile(file, HELPER);
  const children: ReturnType<typeof spawn>[] = [];
  const argsLog: string[][] = [];
  const config: DesktopConfig = {
    helperPath: file,
    appId: APP,
    appPath: '/Applications/Background.app/Contents/MacOS/Background',
    classification: 'PUBLIC',
    lifecycle: { enabled: true },
  };
  const adapter = new NativeDesktopAdapter(config, {
    platform,
    spawnFn: (exe, args) => {
      argsLog.push(args);
      const child = spawn(process.execPath, [exe, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ADL_MODE: mode, ADL_LOG: log },
      });
      children.push(child);
      return child;
    },
  });
  return {
    adapter,
    config,
    children,
    argsLog,
    rows: async () => {
      try {
        return (await readFile(log, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(l => JSON.parse(l));
      } catch {
        return [];
      }
    },
    close: async () => {
      await adapter.close();
      for (const p of children) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const sig = () => new AbortController().signal;
test('malformed lifecycle state closes the backend instead of trusting it', { timeout: 10000 }, async () => {
  for (const mode of ['bad', 'extra', 'incoherent']) {
    const h = await harness(mode);
    try {
      await assert.rejects(h.adapter.application(APP, 'status', sig()), { code: 'E_BACKEND_UNAVAILABLE' });
      await assert.rejects(h.adapter.application(APP, 'status', sig()), { code: 'E_TARGET_NOT_FOUND' });
      assert.equal(h.children.length, 1);
    } finally {
      await h.close();
    }
  }
});
test('refusing an unmanaged application preserves native error and later status', { timeout: 10000 }, async () => {
  const h = await harness('denied');
  try {
    await assert.rejects(h.adapter.application(APP, 'quit', sig()), { code: 'E_POLICY_DENIED' });
    assert.equal((await h.adapter.application(APP, 'status', sig())).running, false);
    assert.equal(h.children.length, 1);
  } finally {
    await h.close();
  }
});
test('concurrent lifecycle calls are dispatched in FIFO order', { timeout: 10000 }, async () => {
  const h = await harness();
  try {
    await Promise.all(
      ['launch', 'status', 'quit'].map(action =>
        h.adapter.application(APP, action as 'launch' | 'status' | 'quit', sig()),
      ),
    );
    assert.deepEqual(
      (await h.rows()).map(r => r.action),
      ['launch', 'status', 'quit'],
    );
  } finally {
    await h.close();
  }
});
for (const mode of ['cancel', 'hang'])
  test(`in-flight lifecycle ${mode} cancels without acquiring physical input`, { timeout: 10000 }, async () => {
    const h = await harness(mode),
      c = new AbortController();
    try {
      const result = h.adapter.application(APP, 'launch', c.signal).then(
        () => ({ code: 'UNEXPECTED', maybe: false }),
        e => ({ code: e.code, maybe: e.mayHaveExecuted }),
      );
      for (let i = 0; i < 100 && !(await h.rows()).some(r => r.op === 'application'); i++) await delay(10);
      assert.ok((await h.rows()).some(r => r.op === 'application'));
      c.abort();
      assert.deepEqual(await result, { code: 'E_CANCELLED', maybe: true });
      assert.ok((await h.rows()).some(r => r.op === 'cancel_input'));
      assert.ok(
        h.argsLog.every(args => !args.includes('--release-input')),
        'lifecycle never acquires or releases a physical-input lease',
      );
    } finally {
      await h.close();
    }
  });
test('Windows lifecycle is advertised and dispatched like macOS', { timeout: 10000 }, async () => {
  const h = await harness('', 'win32');
  try {
    assert.deepEqual(await h.adapter.application(APP, 'launch', sig()), {
      running: true,
      managed: true,
      changed: true,
    });
    assert.equal((await h.adapter.application(APP, 'status', sig())).changed, false);
    assert.deepEqual(
      (await h.rows()).map(r => r.action),
      ['launch', 'status'],
    );
    assert.deepEqual(
      (await h.rows()).map(r => Object.keys(r).sort()),
      [
        ['action', 'op', 'request_id'],
        ['action', 'op', 'request_id'],
      ],
    );
    assert.equal(h.children.length, 1, 'one helper for the whole lifecycle');
    assert.ok(
      h.argsLog.every(args => args.includes('--lifecycle-enabled')),
      'the opted-in Windows helper is told lifecycle is enabled',
    );
  } finally {
    await h.close();
  }
});
for (const platform of ['linux', 'freebsd'])
  test(`${platform} lifecycle stays unavailable and never spawns a helper`, { timeout: 10000 }, async () => {
    const h = await harness('', platform);
    try {
      await assert.rejects(h.adapter.application(APP, 'launch', sig()), { code: 'E_UNSUPPORTED_ACTION' });
      assert.equal(h.children.length, 0);
      assert.ok(h.argsLog.every(args => !args.includes('--lifecycle-enabled')));
    } finally {
      await h.close();
    }
  });
test('quitting an application preserves an unrelated browser session', { timeout: 10000 }, async () => {
  const h = await harness();
  let browserClosed = 0;
  const browser: Adapter = {
    open: async () => ({
      snapshot: async () => ({
        fingerprint: 'one',
        elements: [{ id: 'heading', role: 'heading', name: 'Browser remains available', enabled: true }],
        truncated: false,
      }),
      act: async () => {},
      close: async () => {
        browserClosed++;
      },
    }),
    close: async () => {},
  };
  const policy = parsePolicy({
    macos: h.config,
    browserTargets: [{ id: 'browser', label: 'Browser', url: 'https://example.com', classification: 'PUBLIC' }],
  });
  const engine = new Engine(policy, { browser, desktop: h.adapter }, 'darwin');
  try {
    const session = await engine.open((await engine.listTargets('browser')).targets[0]!.target_id);
    await engine.application(APP, 'quit');
    assert.equal(browserClosed, 0);
    assert.equal((await engine.observe(session.session_id)).elements![0]!.name, 'Browser remains available');
  } finally {
    await engine.shutdown();
    await h.close();
  }
});
