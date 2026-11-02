import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRuntimeSettings,
  extensionPolicy,
  normalizeRuntimeSettings,
  parseRuntimeSettingsEnv,
  parseStartupPolicy,
  runtimeSettingsFromIdleMinutes,
  runtimeSettingsEnvJson,
} from '../src/bundled-policy.js';
import { resolve, dirname } from 'node:path';

const app = { appId: 'test.app', appPath: '/Applications/Test.app/Contents/MacOS/Test', classification: 'PUBLIC' };

test('extension runtime settings normalize idle minutes separately from permission grants', () => {
  assert.deepEqual(runtimeSettingsFromIdleMinutes(15), {
    sessionTtlMs: 900_000,
    browserHeadless: true,
    browserProxyServer: '',
    browserProxyConnectByHostname: false,
  });
  assert.deepEqual(normalizeRuntimeSettings({}), {
    sessionTtlMs: 900_000,
    browserHeadless: true,
    browserProxyServer: '',
    browserProxyConnectByHostname: false,
  });
  assert.deepEqual(
    parseRuntimeSettingsEnv(
      runtimeSettingsEnvJson({
        sessionTtlMs: 3_600_000,
        browserHeadless: false,
        browserProxyServer: 'https://proxy.example:8443/',
      }),
    ),
    {
      sessionTtlMs: 3_600_000,
      browserHeadless: false,
      browserProxyServer: 'https://proxy.example:8443',
      browserProxyConnectByHostname: false,
    },
  );
  assert.deepEqual(parseRuntimeSettingsEnv(undefined), {
    sessionTtlMs: 900_000,
    browserHeadless: true,
    browserProxyServer: '',
    browserProxyConnectByHostname: false,
  });
  assert.deepEqual(normalizeRuntimeSettings({ browserProxyConnectByHostname: true }), {
    sessionTtlMs: 900_000,
    browserHeadless: true,
    browserProxyServer: '',
    browserProxyConnectByHostname: true,
  });
  assert.equal(
    parseRuntimeSettingsEnv(
      JSON.stringify({ browserProxyServer: 'http://proxy.example:3128', browserProxyConnectByHostname: true }),
    ).browserProxyConnectByHostname,
    true,
  );
  for (const minutes of [0, -1, 1.5, 61, NaN]) assert.throws(() => runtimeSettingsFromIdleMinutes(minutes));
  for (const value of [
    { sessionTtlMs: 999 },
    { sessionTtlMs: 3_600_001 },
    { sessionTtlMs: 12_345.5 },
    { sessionTtlMs: 60_000, proxy: 'http://localhost' },
    { browserProxyServer: 'ftp://proxy.example' },
    { browserProxyServer: 'http://user:secret@proxy.example:8080' },
    { browserProxyServer: 'http://proxy.example/path' },
    { browserProxyServer: 'http://proxy.example/?q=secret' },
    { browserProxyServer: 'http://proxy.example/#fragment' },
    { browserProxyConnectByHostname: 'true' },
    { browserProxyConnectByHostname: 1 },
    { browserProxyConnectByHostname: [] },
    { browserProxyConnectByHostname: true, browserProxyConnectMethod: 'hostname' },
  ])
    assert.throws(() => normalizeRuntimeSettings(value));
  const base = parseStartupPolicy({ allowedOrigins: ['https://example.com'] });
  assert.equal(
    applyRuntimeSettings(base, {
      sessionTtlMs: 120_000,
      browserHeadless: false,
      browserProxyServer: 'http://proxy.example:3128',
    }).sessionTtlMs,
    120_000,
  );
  assert.equal(
    applyRuntimeSettings(base, {
      sessionTtlMs: 120_000,
      browserHeadless: false,
      browserProxyServer: 'http://proxy.example:3128',
    }).browserHeadless,
    false,
  );
  assert.equal(applyRuntimeSettings(base, { browserProxyConnectByHostname: true }).browserProxyConnectByHostname, true);
  assert.equal(base.sessionTtlMs, 900_000, 'applying runtime settings does not mutate the base policy');
});

test('extensionPolicy propagates browserProxyConnectByHostname from runtime settings', () => {
  assert.equal(
    extensionPolicy(undefined, 'linux', {}, { browserProxyServer: 'http://proxy.example:3128' })
      .browserProxyConnectByHostname,
    false,
  );
  const policy = extensionPolicy(
    undefined,
    'linux',
    {},
    { browserProxyServer: 'http://proxy.example:3128', browserProxyConnectByHostname: true },
  );
  assert.equal(policy.browserProxyConnectByHostname, true);
  assert.equal(policy.browserProxyServer, 'http://proxy.example:3128');
});

test('relative audit logs resolve beside the policy file independently of the host working directory', () => {
  const config = resolve('fixtures', 'settings', 'policy.json');
  const input = { auditPath: '../logs/audit.jsonl' };
  assert.equal(
    parseStartupPolicy(input, undefined, 'linux', config).auditPath,
    resolve(dirname(config), '../logs/audit.jsonl'),
  );
  assert.equal(input.auditPath, '../logs/audit.jsonl');
  const absolute = resolve('logs', 'audit.jsonl');
  assert.equal(parseStartupPolicy({ auditPath: absolute }, undefined, 'linux', config).auditPath, absolute);
  assert.equal(parseStartupPolicy(input).auditPath, input.auditPath);
});

test('bundled helper fills only the current platform and never changes the source policy', () => {
  for (const [platform, key] of [
    ['darwin', 'macos'],
    ['win32', 'windows'],
  ] as const) {
    const input = { [key]: { ...app } };
    const before = JSON.stringify(input);
    const result = parseStartupPolicy(input, '/installed/helper', platform);
    assert.equal(result[key]?.helperPath, '/installed/helper');
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(result.allowedOrigins, []);
    assert.equal(result[key]?.interactive, undefined);
    assert.equal(result[key]?.visual, undefined);
    assert.equal(result[key]?.lifecycle, undefined);
  }
});

test('custom helper is preserved and invalid explicit paths fail instead of falling back', () => {
  assert.equal(
    parseStartupPolicy({ macos: { ...app, helperPath: '/custom/helper' } }, '/installed/helper', 'darwin').macos
      ?.helperPath,
    '/custom/helper',
  );
  for (const helperPath of ['', null, 'relative/helper', 42]) {
    assert.throws(() => parseStartupPolicy({ macos: { ...app, helperPath } }, '/installed/helper', 'darwin'), {
      code: 'E_INVALID_ARGUMENT',
    });
  }
});

test('standalone, other platforms, and malformed policies retain strict validation', () => {
  for (const [input, helper, platform] of [
    [{ macos: app }, undefined, 'darwin'],
    [{ macos: app }, '/installed/helper', 'win32'],
    [{ macos: app }, '/installed/helper', 'linux'],
    [{ macos: app }, 'relative/helper', 'darwin'],
    [{ macos: { ...app, unknown: true } }, '/installed/helper', 'darwin'],
    [{ macos: { ...app, interactive: { enabled: true, surfaces: [] } } }, '/installed/helper', 'darwin'],
    [{ macos: [] }, '/installed/helper', 'darwin'],
    [[], '/installed/helper', 'darwin'],
  ] as const)
    assert.throws(() => parseStartupPolicy(input, helper, platform), { code: 'E_INVALID_ARGUMENT' });
});

test('bundled setup grants no targets or desktop access by default', () => {
  const policy = parseStartupPolicy({}, '/installed/helper', 'darwin');
  assert.deepEqual(policy.browserTargets, []);
  assert.equal(policy.macos, undefined);
  assert.equal(policy.windows, undefined);
  assert.equal(policy.allowLoopback, false);
  assert.equal(policy.allowPrivateNetwork, false);
});

// ---- consequentialAllowLabels / consequentialDenyLabels grants (design V0.1.7 Part A) ----
import {
  describePermissionError,
  effectivePermissions,
  normalizePermissions,
  parsePermissionsEnv,
} from '../src/bundled-policy.js';

test('label lists travel in the grants only when set, and reach the policy normalized', () => {
  // Defaults leave the serialized grants (and so the MCP definition) unchanged.
  assert.equal('consequentialAllowLabels' in normalizePermissions({}), false);
  assert.equal('consequentialDenyLabels' in normalizePermissions({ consequentialAllowLabels: [] }), false);
  const grants = normalizePermissions({
    browserOrigins: ['https://example.com'],
    consequentialAllowLabels: ['Delete', 'Delete', '削除する'],
    consequentialDenyLabels: ['Sort order'],
  });
  assert.deepEqual(grants.consequentialAllowLabels, ['Delete', '削除する']);
  assert.deepEqual(grants.consequentialDenyLabels, ['Sort order']);
  const policy = extensionPolicy(undefined, 'linux', grants);
  assert.deepEqual(policy.consequentialAllowLabels, ['delete', '削除']);
  assert.deepEqual(policy.consequentialDenyLabels, ['sort order']);
  assert.deepEqual(extensionPolicy(undefined, 'linux', {}).consequentialAllowLabels, []);
  const effective = effectivePermissions(grants, undefined, 'linux');
  assert.deepEqual(effective.consequentialAllowLabels, ['delete', '削除']);
  assert.deepEqual(effective.consequentialDenyLabels, ['sort order']);
  assert.equal('consequentialAllowLabels' in effectivePermissions({}, undefined, 'linux'), false);
  // The environment transport round-trips them.
  const decoded = parsePermissionsEnv(JSON.stringify(grants));
  assert.deepEqual(decoded.consequentialAllowLabels, ['Delete', '削除する']);
});

test('malformed label lists deny every grant and name the setting', () => {
  const bad: unknown[] = [
    Array.from({ length: 65 }, (_, i) => `label ${i}`),
    ['x'.repeat(65)],
    [''],
    ['bad\u0000label'],
    ['bad\u001flabel'],
    ['a'],
    ['×'],
    ['ﷺ'.repeat(4)],
    'Delete',
    [1],
    [null],
  ];
  for (const key of ['consequentialAllowLabels', 'consequentialDenyLabels'] as const)
    for (const value of bad) {
      const grants = { browserOrigins: ['https://example.com'], allowAllOperations: true, [key]: value };
      let caught: unknown;
      try {
        normalizePermissions(grants);
      } catch (error) {
        caught = error;
      }
      assert.ok(caught, `${key} ${JSON.stringify(value)}`);
      assert.equal((caught as { code: string }).code, 'E_INVALID_ARGUMENT');
      assert.match(describePermissionError(caught), new RegExp(`agentdesklink\\.${key}`));
      // The environment decoder fails closed: no origins, no operation grant.
      const env = parsePermissionsEnv(JSON.stringify(grants));
      assert.deepEqual(env.browserOrigins, []);
      assert.equal(env.allowAllOperations, false);
    }
  // The boundary is valid.
  normalizePermissions({
    consequentialAllowLabels: Array.from({ length: 64 }, (_, i) => `label ${i}`),
    consequentialDenyLabels: ['x'.repeat(63) + 'y'],
  });
});
