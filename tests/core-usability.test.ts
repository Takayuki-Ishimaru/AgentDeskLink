import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core.js';
import { parsePolicy } from '../src/policy.js';
import { browserLaunchFailure } from '../src/browser.js';
import { AdlError, safeError, type Adapter, type AdapterSession } from '../src/types.js';

class Fake implements Adapter {
  opened: string[] = [];
  openedIds: string[] = [];
  async open(target: { application_id: string; target_id: string }): Promise<AdapterSession> {
    this.opened.push(target.application_id);
    this.openedIds.push(target.target_id);
    return {
      snapshot: async () => ({
        fingerprint: 'f',
        truncated: false,
        elements: [{ id: 'e', role: 'button', name: 'Find', enabled: true }],
      }),
      act: async () => {},
      close: async () => {},
      capture: async () => {
        throw new AdlError('E_INTERNAL');
      },
    } as AdapterSession;
  }
  async close() {}
}
const target = (id: string, url = 'https://example.com', visual?: { enabled: boolean }) => ({
  id,
  label: id,
  url,
  classification: 'PUBLIC',
  ...(visual ? { visual } : {}),
});
function engine(targets: ReturnType<typeof target>[]) {
  const adapter = new Fake();
  const policy = parsePolicy({
    allowedOrigins: ['https://example.com', 'https://other.example'],
    browserTargets: targets,
  });
  return { e: new Engine(policy, { browser: adapter }), adapter };
}

test('a configured target id opens the same target as its generated id', async () => {
  const { e, adapter } = engine([target('local-demo'), target('second', 'https://other.example')]);
  try {
    const listed = (await e.listTargets()).targets;
    const generated = listed.find(t => t.application_id === 'local-demo')!.target_id;
    assert.match(generated, /^t_/);
    assert.ok((await e.open('local-demo')).session_id);
    assert.ok((await e.open(generated)).session_id);
    assert.deepEqual(adapter.opened, ['local-demo', 'local-demo']);
    assert.deepEqual(adapter.openedIds, [generated, generated]);
  } finally {
    await e.shutdown();
  }
});

test('unknown aliases keep unknown_target', async () => {
  // Duplicate configured ids are rejected by the policy parser; the one-match rule in
  // resolveConfiguredAlias covers desktop windows that share an application id.
  const { e, adapter } = engine([target('known')]);
  try {
    await e.listTargets();
    for (const alias of ['Known', 'missing', 't_forged', '']) {
      await assert.rejects(e.open(alias), (error: AdlError) => {
        assert.equal(error.code, 'E_TARGET_NOT_FOUND');
        assert.equal(error.reason, 'unknown_target');
        return true;
      });
    }
    assert.equal(adapter.opened.length, 0);
  } finally {
    await e.shutdown();
  }
});

test('capture without an image opt-in names capture_not_enabled', async () => {
  const { e } = engine([target('plain'), target('pictures', 'https://other.example', { enabled: true })]);
  try {
    await e.listTargets();
    const plain = await e.open('plain');
    await assert.rejects(e.capture(plain.session_id), (error: AdlError) => {
      assert.equal(error.code, 'E_PRIVACY_BLOCKED');
      assert.equal(error.reason, 'capture_not_enabled');
      const safe = safeError(error);
      assert.equal(safe.reason, 'capture_not_enabled');
      assert.match(safe.safe_message, /allowUnredactedImages/);
      assert.match(safe.safe_message, /browserTargets\[\]\.visual\.enabled/);
      return true;
    });
    // With the opt-in the policy check passes and the adapter's own capture runs.
    const pictures = await e.open('pictures');
    await assert.rejects(e.capture(pictures.session_id), (error: AdlError) => {
      assert.notEqual(error.reason, 'capture_not_enabled');
      return true;
    });
  } finally {
    await e.shutdown();
  }
});

test('browser launch failures distinguish missing Chromium from an unavailable sandbox', () => {
  const sandbox = browserLaunchFailure(
    new Error('browserType.launch: Target page, context or browser has been closed\nNo usable sandbox! ...'),
  );
  assert.equal(sandbox.reason, 'browser_sandbox_unavailable');
  assert.match(sandbox.log, /^adl: Chromium launch failed: /);
  assert.match(sandbox.log, /non-root user/);
  assert.ok(!sandbox.log.includes('\n'.repeat(2)));
  const root = browserLaunchFailure(new Error('Running as root without --no-sandbox is not supported.'));
  assert.equal(root.reason, 'browser_sandbox_unavailable');
  const other = browserLaunchFailure(new Error('Executable does not exist at /nowhere/chrome'));
  assert.equal(other.reason, 'browser_executable_missing');
  assert.match(other.log, /Executable does not exist/);
  const huge = browserLaunchFailure(new Error('x'.repeat(10000)));
  assert.equal(huge.reason, undefined);
  assert.ok(huge.log.length < 1200);
  assert.equal(
    safeError(new AdlError('E_BACKEND_UNAVAILABLE', 'browser_sandbox_unavailable')).reason,
    'browser_sandbox_unavailable',
  );
});
