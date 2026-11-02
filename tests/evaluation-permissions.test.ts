import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as bundled from '../src/bundled-policy.js';
import { createServer } from 'node:http';
import { assertUrlAllowed, parsePolicy } from '../src/policy.js';
import { Engine } from '../src/core.js';
import { BrowserAdapter } from '../src/browser.js';
import { AdlError, safeError, type Adapter, type PolicyConfig } from '../src/types.js';
const profile = bundled.extensionPolicy as (...args: any[]) => PolicyConfig;

test('enabling MCP alone grants no targets or elevated permissions on any platform', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const p = profile('/installed/helper', platform);
    assert.equal(p.allowAllOperations, false);
    assert.equal(p.allowLoopback, false);
    assert.equal(p.allowPrivateNetwork, false);
    assert.deepEqual(p.allowedOrigins, []);
    assert.deepEqual(p.browserTargets, []);
    assert.equal(p.macos, undefined);
    assert.equal(p.windows, undefined);
  }
});
test('origin, operations, raw native images and physical input remain independent grants', async () => {
  const origins = { browserOrigins: ['http://127.0.0.1:8123'], allowLoopback: true };
  const p = profile('/installed/helper', 'darwin', { ...origins, allowAllOperations: true });
  assert.equal(p.restrictTargets, true);
  assert.equal(p.macos, undefined);
  await assertUrlAllowed('http://127.0.0.1:8123/path', p);
  await assert.rejects(assertUrlAllowed('http://127.0.0.1:8124/', p), { code: 'E_POLICY_DENIED' });
  const app = { desktopAppId: 'test.app', desktopAppPath: '/Applications/Test.app/Contents/MacOS/Test' };
  for (const platform of ['darwin', 'win32']) {
    const key = platform === 'darwin' ? 'macos' : 'windows';
    const semantic = profile('/installed/helper', platform, { ...app, allowAllOperations: true })[key]!;
    assert.equal(semantic.restrictTargets, true);
    assert.equal(semantic.allowAllOperations, true);
    assert.ok(!semantic.visual?.enabled);
    assert.ok(!semantic.interactive?.enabled);
    const images = profile('/installed/helper', platform, { ...app, allowUnredactedImages: true })[key]!;
    assert.equal(images.visual?.allowUnredacted, true);
    assert.ok(!images.interactive?.enabled);
    const physical = profile('/installed/helper', platform, { ...app, allowPhysicalInput: true })[key]!;
    assert.ok(!physical.interactive?.enabled);
    const all = profile('/installed/helper', platform, {
      ...app,
      allowPhysicalInput: true,
      allowUnredactedImages: true,
    })[key]!;
    assert.equal(all.interactive?.enabled, true);
  }
});
test('malformed or oversized environment permissions fail closed without partial grants', () => {
  const parse = (bundled as any).parsePermissionsEnv as (text: string) => unknown;
  assert.equal(typeof parse, 'function');
  for (const text of [
    '{',
    '[]',
    'null',
    JSON.stringify({ allowAllOperations: 'true' }),
    JSON.stringify({ allowAllOperations: true, browserOrigins: ['https://example.com/path'] }),
    ' '.repeat(65537),
  ]) {
    try {
      const p = profile(undefined, 'linux', parse(text));
      assert.deepEqual(p.browserTargets, []);
      assert.equal(p.allowAllOperations, false);
    } catch (error) {
      assert.equal((error as any).code, 'E_INVALID_ARGUMENT');
    }
  }
  assert.equal(
    profile('/installed/helper', 'darwin', { desktopAppId: '*', desktopAppPath: '/app', allowAllOperations: true })
      .macos,
    undefined,
  );
});
test('core URL admission checks origin/network grants before opening even with broad operations', async () => {
  let opens = 0,
    lastUrl = '';
  let policy: PolicyConfig;
  const adapter: Adapter = {
    open: async (target, _mode, _signal, config) => {
      opens++;
      assert.equal(config?.id, target.application_id);
      lastUrl = (policy.browserTargets.find(c => c.id === target.application_id) ?? config)!.url;
      return {
        snapshot: async () => ({ elements: [], fingerprint: 'same', truncated: false }),
        act: async () => {},
        close: async () => {},
      };
    },
    close: async () => {},
  };
  policy = profile(undefined, 'linux', {
    browserOrigins: ['http://127.0.0.1:8123'],
    allowLoopback: true,
    allowAllOperations: true,
  });
  const engine = new Engine(policy, { browser: adapter });
  try {
    await assert.rejects(engine.openUrl('http://127.0.0.1:8124'), { code: 'E_POLICY_DENIED' });
    assert.equal(opens, 0);
    const s = await engine.openUrl('http://127.0.0.1:8123/path');
    assert.equal(opens, 1);
    assert.equal(lastUrl, 'http://127.0.0.1:8123/path');
    await engine.close(s.session_id);
    policy.allowLoopback = false;
    await assert.rejects(engine.openUrl('http://127.0.0.1:8123/another'), { code: 'E_POLICY_DENIED' });
    assert.equal(opens, 1);
  } finally {
    await engine.shutdown();
  }
});

test('all 64 configured origins can open their root without allocating another target', async () => {
  const browserOrigins = Array.from({ length: 64 }, (_, i) => `http://127.0.0.1:${8100 + i}`);
  const policy = profile(undefined, 'linux', { browserOrigins, allowLoopback: true });
  const adapter: Adapter = {
    open: async () => ({
      snapshot: async () => ({ elements: [], fingerprint: 'same', truncated: false }),
      act: async () => {},
      close: async () => {},
    }),
    close: async () => {},
  };
  const engine = new Engine(policy, { browser: adapter });
  try {
    await engine.openUrl(`${browserOrigins[0]}/`);
    assert.equal(policy.browserTargets.length, 64);
  } finally {
    await engine.shutdown();
  }
});

test('read_only refuses every browser mutation as read_only_mode (the setting to change, no policy-file hint), but not navigation or scroll', async () => {
  let acts = 0;
  const adapter: Adapter = {
    open: async () => ({
      snapshot: async () => ({
        elements: [{ id: 'b', role: 'button', name: 'Add', enabled: true }],
        fingerprint: 'same',
        truncated: false,
      }),
      act: async () => {
        acts++;
      },
      close: async () => {},
    }),
    close: async () => {},
  };
  const policy = profile(undefined, 'linux', { browserOrigins: ['http://127.0.0.1:8123'], allowLoopback: true });
  assert.equal(policy.operationMode, 'read_only');
  const engine = new Engine(policy, { browser: adapter });
  try {
    const s = await engine.openUrl('http://127.0.0.1:8123/');
    const observed = await engine.observe(s.session_id);
    const id = observed.elements!.find(e => e.name === 'Add')!.id;
    for (const action of [
      { action: 'click' as const, element_id: id },
      { action: 'fill' as const, element_id: id, value: 'x' },
      { action: 'press' as const, element_id: id, value: 'Enter' },
      { action: 'hover' as const, element_id: id },
    ])
      await assert.rejects(engine.act(s.session_id, action, observed.revision), (error: unknown) => {
        assert.ok(error instanceof AdlError, action.action);
        assert.equal(error.code, 'E_POLICY_DENIED');
        assert.equal(error.reason, 'read_only_mode');
        const safe = safeError(error);
        assert.equal(safe.workspace_setting, 'agentdesklink.operationMode');
        assert.equal(safe.policy_setting, undefined);
        assert.match(safe.safe_message, /read_only/);
        assert.doesNotMatch(safe.safe_message, /controls/);
        return true;
      });
    assert.equal(acts, 0);
    await engine.act(s.session_id, { action: 'scroll', element_id: id, direction: 'down' }, observed.revision);
    await engine.act(s.session_id, { action: 'navigate', url: 'http://127.0.0.1:8123/next' }, observed.revision);
    assert.equal(acts, 2);
  } finally {
    await engine.shutdown();
  }
});

test('legacy CLI controls keep operation_not_granted with the controls hint', { timeout: 30000 }, async () => {
  const app = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<button type="button">Add</button>');
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 5000,
    browserTargets: [{ id: 'cli', label: 'CLI', url: origin, classification: 'PUBLIC', controls: [] }],
  });
  assert.equal(policy.operationMode, undefined);
  const engine = new Engine(policy, { browser: new BrowserAdapter(policy, url => assertUrlAllowed(url, policy)) });
  try {
    const s = await engine.open((await engine.listTargets()).targets[0]!.target_id);
    const observed = await engine.observe(s.session_id);
    await assert.rejects(
      engine.act(
        s.session_id,
        { action: 'click', element_id: observed.elements!.find(e => e.name === 'Add')!.id },
        observed.revision,
      ),
      (error: unknown) => {
        assert.ok(error instanceof AdlError);
        assert.equal(error.reason, 'operation_not_granted');
        assert.equal(safeError(error).policy_setting, 'browserTargets[].controls');
        return true;
      },
    );
  } finally {
    await engine.shutdown();
    app.closeAllConnections();
    await new Promise<void>(resolve => app.close(() => resolve()));
  }
});

test('effective permission summary agrees with browser grants and native prerequisites', () => {
  const effective = (bundled as any).effectivePermissions as (
    grants: unknown,
    helper?: string,
    platform?: string,
  ) => any;
  assert.equal(typeof effective, 'function');
  const grants = { desktopAppId: 'test.app', desktopAppPath: '/app', allowPhysicalInput: true };
  for (const platform of ['darwin', 'win32']) {
    const missingImages = effective(grants, '/helper', platform);
    assert.equal(missingImages.allowPhysicalInput, false);
    assert.ok(missingImages.reasons.some((r: string) => /images|画像/.test(r)));
    assert.equal(effective({ ...grants, allowUnredactedImages: true }, '/helper', platform).allowPhysicalInput, true);
    assert.equal(effective({ ...grants, allowUnredactedImages: true }, undefined, platform).allowPhysicalInput, false);
    assert.equal(
      effective({ ...grants, allowUnredactedImages: true }, 'relative-helper', platform).allowPhysicalInput,
      false,
    );
  }
  assert.equal(effective({ ...grants, allowUnredactedImages: true }, '/helper', 'linux').allowPhysicalInput, false);
  assert.equal(
    effective({ browserOrigins: ['https://example.com'], allowAllOperations: true }, undefined, 'linux')
      .allowAllOperations,
    true,
    'browser-wide operation grant must not depend on native app',
  );
});
