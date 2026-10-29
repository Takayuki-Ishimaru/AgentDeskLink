import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import {
  initializeOperationState,
  readOperationState,
  writeOperationState,
  watchOperationControl,
  replaceFileSync,
} from '../src/operation-control.js';
import { Engine } from '../src/core.js';
import { extensionPolicy } from '../src/bundled-policy.js';
import { authorizeAction, parsePolicy, assertUrlAllowed } from '../src/policy.js';
import type { Adapter, AdapterSession, Action } from '../src/types.js';

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'adl-stop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'operations.json');
  initializeOperationState(file);
  return file;
}
test('extension profile grants nothing without explicit opt-in and honours explicit grants', async () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const denied = extensionPolicy('/installed/helper', platform);
    assert.equal(denied.allowAllOperations, false);
    assert.deepEqual(denied.browserTargets, []);
    assert.equal(denied.macos, undefined);
    assert.equal(denied.windows, undefined);
    const key = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : undefined;
    const policy = extensionPolicy('/installed/helper', platform, {
      browserOrigins: ['http://127.0.0.1:3000', 'http://internal.example'],
      allowLoopback: true,
      allowPrivateNetwork: true,
      allowAllOperations: true,
      desktopAppId: 'test.app',
      desktopAppPath: '/Applications/Test.app/Contents/MacOS/Test',
    });
    assert.equal(policy.allowAllOperations, true);
    assert.ok(policy.browserTargets.length);
    await assertUrlAllowed('http://127.0.0.1:3000', policy);
    await assertUrlAllowed('http://internal.example', policy, async () => ['192.168.1.1']);
    const desktop = key ? policy[key] : undefined;
    if (platform !== 'linux') {
      assert.equal(desktop?.appId, 'test.app');
      assert.equal(desktop?.allowAllOperations, true);
      assert.equal(desktop?.controlsPath, undefined);
      assert.ok(!desktop?.visual?.enabled);
      assert.ok(!desktop?.interactive?.enabled);
    } else assert.equal(desktop, undefined);
  }
  const action: Action = { action: 'fill', value: 'user@example.com' },
    control = { id: 'password', role: 'textbox', name: 'Password', enabled: true, sensitive: true };
  assert.doesNotThrow(() => authorizeAction(action, control, true));
  assert.doesNotThrow(() =>
    authorizeAction({ action: 'click' }, { id: 'send', role: 'button', name: 'Submit payment', enabled: true }, true),
  );
  assert.throws(() => authorizeAction(action, { ...control, enabled: false }, true), { code: 'E_POLICY_DENIED' });
  assert.throws(() => authorizeAction(action, control), { code: 'E_PRIVACY_BLOCKED' });
  assert.equal(parsePolicy({}).allowAllOperations, undefined);
});
test('stop persists, malformed state fails closed, rapid stop/resume revokes old generations', async t => {
  const file = await fixture(t),
    initial = readOperationState(file)!;
  let stopped = 0;
  const watch = watchOperationControl(file, initial.epoch, () => stopped++);
  t.after(async () => watch.dispose());
  writeOperationState(file, true);
  initializeOperationState(file);
  assert.equal(readOperationState(file)?.stopped, true);
  const fresh = writeOperationState(file, false);
  assert.notEqual(fresh.epoch, initial.epoch);
  assert.equal(watch.check(), false);
  assert.equal(stopped, 1);
  assert.equal(watch.check(), false);
  assert.equal(stopped, 1);
  const current = watchOperationControl(file, fresh.epoch, () => stopped++);
  t.after(async () => current.dispose());
  assert.equal(current.check(), true);
  await writeFile(file, 'corrupt');
  assert.equal(current.check(), false);
  assert.equal(stopped, 2);
});
test('stop cancels running wait, queued mutations and batch suffix across multiple servers', async t => {
  const file = await fixture(t),
    epoch = readOperationState(file)!.epoch;
  let acts = 0,
    closed = 0;
  const adapter: Adapter = {
    open: async (): Promise<AdapterSession> => ({
      snapshot: async () => ({
        fingerprint: 'one',
        truncated: false,
        elements: [{ id: 'e', role: 'button', name: 'Submit', enabled: true }],
      }),
      act: async () => {
        acts++;
      },
      close: async () => {
        closed++;
      },
    }),
    close: async () => {},
  };
  const engines: Array<Engine> = [],
    watches: Array<ReturnType<typeof watchOperationControl>> = [];
  t.after(async () => {
    watches.forEach(w => w.dispose());
    await Promise.all(engines.map(e => e.shutdown()));
  });
  for (let i = 0; i < 2; i++) {
    let watch: ReturnType<typeof watchOperationControl> | undefined;
    const engine = new Engine(
      extensionPolicy(undefined, 'linux', {
        browserOrigins: ['http://127.0.0.1:8123'],
        allowLoopback: true,
        allowAllOperations: true,
      }),
      { browser: adapter },
      'linux',
      () => watch?.check() ?? true,
    );
    watch = watchOperationControl(file, epoch, () => {
      void engine.shutdown();
    });
    engines.push(engine);
    watches.push(watch);
  }
  const sessions = await Promise.all(engines.map(e => e.openUrl('http://127.0.0.1:8123/')));
  const batch = engines[0]!.execute(
    [
      { session_id: sessions[0]!.session_id, action: 'wait_for', name: 'never', timeout_ms: 30000 },
      { session_id: sessions[0]!.session_id, action: 'click', element_id: 'e1' },
    ],
    { [sessions[0]!.session_id]: 1 },
  );
  const waiting = engines[1]!.wait(sessions[1]!.session_id, { name: 'never' }, 30000);
  const queued = engines[1]!.act(sessions[1]!.session_id, { action: 'click', element_id: 'e1' }, 1);
  const results = Promise.allSettled([waiting, queued]);
  await delay(30);
  const started = Date.now();
  writeOperationState(file, true);
  const done = await results;
  assert.ok(Date.now() - started < 1000);
  assert.ok(done.every(r => r.status === 'rejected' && r.reason.code === 'E_CANCELLED'));
  assert.ok(done.every(r => r.status === 'rejected' && r.reason.reason === 'emergency_stop'));
  for (let i = 0; i < 100 && engines[0]!.task(batch.task_id).status === 'running'; i++) await delay(10);
  const status = engines[0]!.task(batch.task_id);
  assert.equal(status.status, 'cancelled');
  assert.equal(status.results[1]?.status, 'not_executed');
  assert.equal(acts, 0);
  assert.ok(closed >= 2);
  writeOperationState(file, false);
  for (const engine of engines) await assert.rejects(engine.openUrl('https://example.net'), { code: 'E_CANCELLED' });
});
test('a revoked process cannot admit work in the interval before the poll runs', async t => {
  const file = await fixture(t),
    initial = readOperationState(file)!;
  let opens = 0;
  const adapter: Adapter = {
    open: async () => {
      opens++;
      throw Error('should not open');
    },
    close: async () => {},
  };
  let watch: ReturnType<typeof watchOperationControl> | undefined;
  const engine = new Engine(
    extensionPolicy(undefined, 'linux', {
      browserOrigins: ['http://127.0.0.1:8123'],
      allowLoopback: true,
      allowAllOperations: true,
    }),
    { browser: adapter },
    'linux',
    () => watch?.check() ?? true,
  );
  watch = watchOperationControl(file, initial.epoch, () => {
    void engine.shutdown();
  });
  t.after(async () => {
    watch?.dispose();
    await engine.shutdown();
  });
  writeOperationState(file, true);
  await assert.rejects(engine.openUrl('http://127.0.0.1:8123'), { code: 'E_CANCELLED' });
  assert.equal(opens, 0);
});

test('replacing the operation state retries transient Windows refusals and still fails on persistent ones', () => {
  const fail = (code: string) => Object.assign(new Error(code), { code });
  let calls = 0;
  replaceFileSync('a.tmp', 'a', () => {
    if (++calls < 3) throw fail('EPERM');
  });
  assert.equal(calls, 3, 'two transient EPERM refusals are retried until the rename succeeds');
  calls = 0;
  assert.throws(
    () =>
      replaceFileSync('a.tmp', 'a', () => {
        calls++;
        throw fail('EBUSY');
      }),
    { code: 'EBUSY' },
  );
  assert.equal(calls, 41, 'a persistent refusal is bounded');
  calls = 0;
  assert.throws(
    () =>
      replaceFileSync('a.tmp', 'a', () => {
        calls++;
        throw fail('ENOENT');
      }),
    { code: 'ENOENT' },
  );
  assert.equal(calls, 1, 'other errors are not retried');
});
