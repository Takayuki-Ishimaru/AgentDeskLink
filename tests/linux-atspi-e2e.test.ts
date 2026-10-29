import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LinuxAdapter } from '../src/linux.js';
import { Engine } from '../src/core.js';
import { parsePolicy } from '../src/policy.js';
import { type Adapter, type AdlError } from '../src/types.js';

// End to end: Engine + LinuxAdapter + the real Python helper + the GTK3 fixture, inside a headless accessibility desktop.
// native/linux-atspi/tests/run-xvfb.sh sets ADL_LINUX_ATSPI_E2E=1; everywhere else this file only skips.
const root = fileURLToPath(new URL('../../', import.meta.url));
const helperPath = join(root, 'native/linux-atspi/adl-linux-atspi-helper.py'),
  fixturePath = join(root, 'native/linux-atspi/fixture/fixture.py');
const python = (() => {
  try {
    return realpathSync('/usr/bin/python3');
  } catch {
    return '';
  }
})();
const enabled =
  process.platform === 'linux' && process.env.ADL_LINUX_ATSPI_E2E === '1' && !!python && existsSync(helperPath);
const fakeBrowser: Adapter = {
  open: async () => ({
    snapshot: async () => ({ fingerprint: 'empty', elements: [], truncated: false }),
    act: async () => {},
    close: async () => {},
  }),
  close: async () => {},
};
const appId = `adl-fixture-e2e-${process.pid}`;
async function startFixture(control: string): Promise<ChildProcess> {
  const child = spawn(python, [fixturePath], {
    env: { ...process.env, ADL_FIXTURE_CONTROL: control, ADL_FIXTURE_APP_NAME: appId },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('exit', code => reject(new Error(`fixture exited ${code}`)));
  });
  return child;
}
function engineFor(operationMode: 'standard' | 'read_only', allowAllOperations = false) {
  const policy = parsePolicy({
    operationMode,
    allowAllOperations,
    actionTimeoutMs: 15000,
    browserTargets: [],
    linux: { helperPath, appId, appPath: python, classification: 'PUBLIC', allowAllOperations },
  });
  const adapter = new LinuxAdapter(policy.linux!, { operationMode });
  return new Engine(policy, { browser: fakeBrowser, desktop: adapter }, 'linux');
}
async function waitForTarget(engine: Engine) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const { targets } = await engine.listTargets('desktop');
    const target = targets.find(t => t.label === 'ADL Fixture');
    if (target) return target;
    await delay(300);
  }
  throw new Error('fixture window never appeared on the accessibility bus');
}
const fail = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    error => error as AdlError,
  );

test(
  'MCP engine drives the GTK3 fixture through the Linux AT-SPI helper in the standard tier',
  { skip: !enabled, timeout: 120000 },
  async () => {
    const control = await mkdtemp(join(tmpdir(), 'adl-e2e-ctl-'));
    const fixture = await startFixture(control);
    const engine = engineFor('standard');
    try {
      const caps = engine.capabilities() as unknown as {
        adapters: { desktop: string; desktop_mutations?: boolean };
        permissions: { desktop_app: string };
        platform_unsupported: string[];
      };
      assert.equal(caps.adapters.desktop, 'linux_atspi_probe_required');
      assert.equal(caps.permissions.desktop_app, appId);
      assert.deepEqual(caps.platform_unsupported, [
        'physical_input',
        'interactive_desktop',
        'desktop_capture',
        'lifecycle',
      ]);
      const target = await waitForTarget(engine);
      assert.equal(target.window?.bounds.coordinate_space, 'desktop_physical_pixels');
      assert.ok(
        target.capabilities.includes('click') && target.capabilities.includes('fill'),
        target.capabilities.join(','),
      );
      assert.equal(
        (engine.capabilities() as unknown as { adapters: { desktop_mutations: boolean } }).adapters.desktop_mutations,
        true,
      );
      await assert.rejects(engine.open(target.target_id, 'strict_isolated'), { code: 'E_INTERFERENCE_RISK' });
      const opened = await engine.open(target.target_id, 'background_semantic');
      let observed = await engine.observe(opened.session_id, { token_budget: 8000 });
      const find = (role: string, name: string) => {
        const element = observed.elements!.find(e => e.role === role && e.name === name);
        assert.ok(element, `${role} ${name} in ${JSON.stringify(observed.elements!.map(e => [e.role, e.name]))}`);
        return element!;
      };
      assert.equal(observed.elements![0]!.role, 'window');
      const password = find('textbox', 'Password');
      assert.equal(password.value, undefined, 'password values never leave the helper');
      const run = find('button', 'Run'),
        status = observed.elements!.find(e => e.role === 'text' && e.name.startsWith('Status:'))!;
      assert.equal(status.name, 'Status: ready');
      const consequential = await fail(
        engine.act(
          opened.session_id,
          { action: 'click', element_id: find('button', 'Delete all').id },
          observed.revision,
        ),
      );
      assert.equal(consequential?.code, 'E_APPROVAL_REQUIRED');
      assert.equal(consequential?.reason, 'consequential_operation');
      await assert.rejects(
        engine.act(opened.session_id, { action: 'fill', element_id: password.id, value: 'hunter2' }, observed.revision),
        { code: 'E_PRIVACY_BLOCKED' },
      );
      const clicked = await engine.act(opened.session_id, { action: 'click', element_id: run.id }, observed.revision);
      assert.equal(clicked.revision, observed.revision + 1);
      observed = await engine.observe(opened.session_id, { token_budget: 8000 });
      assert.equal(
        observed.elements!.find(e => e.role === 'text' && e.name.startsWith('Status:'))!.name,
        'Status: clicked 1',
      );
      await assert.rejects(
        engine.act(opened.session_id, { action: 'click', element_id: run.id }, observed.revision - 1),
        { code: 'E_STALE_STATE' },
      );
      const filled = await engine.act(
        opened.session_id,
        { action: 'fill', element_id: find('textbox', 'Name').id, value: 'AgentDeskLink ワールド' },
        observed.revision,
      );
      observed = await engine.observe(opened.session_id, { token_budget: 8000 });
      assert.equal(find('textbox', 'Name').value, 'AgentDeskLink ワールド');
      assert.equal(filled.revision, observed.revision);
      await engine.act(
        opened.session_id,
        { action: 'check', element_id: find('checkbox', 'Enabled').id, checked: true },
        observed.revision,
      );
      observed = await engine.observe(opened.session_id, { token_budget: 8000 });
      assert.equal(find('checkbox', 'Enabled').checked, true);
      await engine.act(
        opened.session_id,
        { action: 'select', element_id: find('option', 'Gamma').id },
        observed.revision,
      );
      observed = await engine.observe(opened.session_id, { token_budget: 8000 });
      assert.equal(observed.elements!.find(e => e.role === 'combobox')?.value, 'Gamma');
      const capture = await fail(engine.capture(opened.session_id));
      assert.equal(capture?.code, 'E_UNSUPPORTED_ACTION');
      assert.equal(capture?.reason, 'platform_unsupported');
      assert.equal((await engine.close(opened.session_id)).closed, true);
    } finally {
      await engine.shutdown();
      fixture.kill('SIGKILL');
      await rm(control, { recursive: true, force: true });
    }
  },
);

test(
  'read_only keeps the Linux desktop observe-only and a closed window invalidates its session',
  { skip: !enabled, timeout: 120000 },
  async () => {
    const control = await mkdtemp(join(tmpdir(), 'adl-e2e-ctl-'));
    const fixture = await startFixture(control);
    const engine = engineFor('read_only');
    try {
      const target = await waitForTarget(engine);
      assert.deepEqual(target.capabilities, ['observe', 'read_state', 'wait_for']);
      const opened = await engine.open(target.target_id, 'background_semantic');
      const observed = await engine.observe(opened.session_id, { token_budget: 8000 });
      const run = observed.elements!.find(e => e.role === 'button' && e.name === 'Run')!;
      const denied = await fail(
        engine.act(opened.session_id, { action: 'click', element_id: run.id }, observed.revision),
      );
      assert.equal(denied?.code, 'E_POLICY_DENIED');
      assert.equal(denied?.reason, 'desktop_operation_not_granted');
      fixture.kill('SIGTERM');
      await delay(1000);
      const gone = await fail(engine.observe(opened.session_id));
      assert.equal(gone?.code, 'E_TARGET_NOT_FOUND');
      assert.deepEqual((await engine.listTargets('desktop')).targets, []);
    } finally {
      await engine.shutdown();
      if (fixture.exitCode === null) fixture.kill('SIGKILL');
      await rm(control, { recursive: true, force: true });
    }
  },
);
