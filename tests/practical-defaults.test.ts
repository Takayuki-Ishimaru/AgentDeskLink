import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extensionPolicy, normalizePermissions, parsePermissionsEnv } from '../src/bundled-policy.js';
import { assertUrlAllowed } from '../src/policy.js';

test('trusted extension manifest enables operations and URL/app access by default', () => {
  const p = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).contributes.configuration
    .properties;
  for (const key of [
    'enabled',
    'allowAllOperations',
    'allowAllBrowserOrigins',
    'allowAllApplications',
    'allowPhysicalInput',
    'allowUnredactedImages',
    'allowLoopback',
    'allowPrivateNetwork',
  ])
    assert.equal(p[`agentdesklink.${key}`]?.default, true, key);
  assert.equal(p['agentdesklink.allowPersonalData'].default, false);
});

test('broad extension access requires no application or origin registration', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const p = extensionPolicy('/installed/helper', platform, {
      allowAllBrowserOrigins: true,
      allowAllApplications: true,
      allowAllOperations: true,
      allowPhysicalInput: true,
      allowUnredactedImages: true,
      allowLoopback: true,
      allowPrivateNetwork: true,
    });
    await assertUrlAllowed('http://127.0.0.1:32145/path', p);
    await assertUrlAllowed('http://192.168.1.2/path', p);
    const native = platform === 'win32' ? p.windows : platform === 'darwin' ? p.macos : p.linux;
    assert.equal(native?.allowAllApplications, true);
    assert.equal(native?.appId, '*');
    assert.equal(native?.appPath, '/installed/helper');
    assert.equal(native?.interactive?.enabled, platform === 'linux' ? undefined : true);
  }
});

test('read-only broad browsing is independent from write permissions', async () => {
  const p = extensionPolicy('/installed/helper', 'win32', {
    allowAllBrowserOrigins: true,
    allowAllApplications: true,
    operationMode: 'read_only',
    allowLoopback: true,
  });
  assert.equal(p.allowAllOperations, false);
  await assertUrlAllowed('http://127.0.0.1:32146/', p);
  assert.equal(p.windows?.allowAllApplications, true);
});

test('an unused incomplete application selection does not block broad application access', () => {
  const p = extensionPolicy('/installed/helper', 'win32', {
    allowAllApplications: true,
    desktopAppId: 'Old incomplete selection',
  });
  assert.equal(p.windows?.allowAllApplications, true);
  assert.equal(p.windows?.appPath, '/installed/helper');
  assert.throws(
    () =>
      extensionPolicy('/installed/helper', 'win32', {
        allowAllApplications: false,
        desktopAppId: 'Old incomplete selection',
      }),
    { code: 'E_INVALID_ARGUMENT' },
  );
});

test('explicit false, missing and malformed permission transports retain denial', () => {
  for (const input of [undefined, '', '{', '{"allowAllOperations":"true"}']) {
    const p = parsePermissionsEnv(input);
    assert.equal(p.allowAllOperations, false);
    assert.equal((p as unknown as Record<string, unknown>).allowAllApplications, false);
    assert.equal((p as unknown as Record<string, unknown>).allowAllBrowserOrigins, false);
  }
  const p = normalizePermissions({
    allowAllOperations: false,
    allowAllApplications: false,
    allowAllBrowserOrigins: false,
  });
  assert.equal(p.allowAllOperations, false);
});
