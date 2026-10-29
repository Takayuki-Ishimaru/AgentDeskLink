const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const load = () => import('../../dist/src/extension/runtime.js');
const targets = ['darwin-arm64', 'win32-x64', 'linux-x64'];
const dirs = [];
afterEach(() => {
  for (const p of dirs.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});
function layout(target) {
  const win = target.startsWith('win32'),
    mac = target.startsWith('darwin');
  return {
    node: win ? 'node.exe' : 'node',
    helper: mac
      ? 'helper/adl-macos-ax-helper'
      : win
        ? 'helper/adl-windows-uia-helper.exe'
        : 'helper/adl-linux-atspi-helper',
  };
}
function fixture(index, writeChildren) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-universal-'));
  dirs.push(root);
  const rt = path.join(root, 'runtime');
  fs.mkdirSync(rt);
  fs.writeFileSync(path.join(rt, 'manifest.json'), typeof index === 'string' ? index : JSON.stringify(index));
  const children = {};
  for (const target of writeChildren === false ? [] : targets) {
    const { node, helper } = layout(target);
    const dir = path.join(rt, target);
    fs.mkdirSync(dir, { recursive: true });
    for (const rel of [node, helper]) {
      if (typeof rel !== 'string' || !rel) continue;
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, target);
      fs.chmodSync(file, 0o755);
    }
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 2,
        target,
        nodeVersion: 'v24.22.1',
        playwrightVersion: '1.64.1',
        node,
        browserMode: 'auto',
        helper,
      }),
    );
    children[target] = dir;
  }
  return { root, rt, children };
}
const host = target => ({ platform: target.split('-')[0], arch: target.split('-')[1] });
test('universal bundle selects the exact child per host and never falls back to another OS', async () => {
  const { resolveRuntime } = await load();
  const f = fixture({ schemaVersion: 3, targets });
  for (const target of targets) {
    const r = await resolveRuntime({ extensionRoot: f.root, ...host(target) });
    assert.equal(r.runtimeDir, path.join(f.rt, target));
    assert.equal(r.manifest.target, target);
    assert.equal(fs.readFileSync(r.nodePath, 'utf8'), target);
    assert.equal(r.env.PLAYWRIGHT_SKIP_BROWSER_GC, '1');
    const { helper } = layout(target);
    if (helper === null) {
      assert.equal(r.helperPath, null);
      assert.equal(r.env.ADL_BUNDLED_HELPER_PATH, undefined);
    } else {
      assert.equal(r.helperPath, path.join(f.rt, target, helper));
      assert.equal(r.env.ADL_BUNDLED_HELPER_PATH, r.helperPath);
    }
  }
  for (const [platform, arch] of [
    ['linux', 'arm64'],
    ['win32', 'arm64'],
    ['darwin', 'x64'],
  ]) {
    await assert.rejects(resolveRuntime({ extensionRoot: f.root, platform, arch }), /not bundled|unsupported|対応/i);
  }
  fs.rmSync(path.join(f.rt, 'linux-x64'), { recursive: true, force: true });
  await assert.rejects(resolveRuntime({ extensionRoot: f.root, ...host('linux-x64') }), /missing|not bundled/i);
  assert.equal(fs.readFileSync(path.join(f.rt, 'win32-x64', 'node.exe'), 'utf8'), 'win32-x64');
});
test('index rejects malformed schema, extra keys, duplicate, empty and unknown target names', async () => {
  const { resolveRuntime } = await load();
  const bad = [
    { schemaVersion: 3, targets: ['linux-x64'], extra: 1 },
    { schemaVersion: 3, targets: 'linux-x64' },
    { schemaVersion: 3, targets: [1] },
    { schemaVersion: 3, targets: [''] },
    { schemaVersion: 3, targets: ['LINUX-X64'] },
    { schemaVersion: 3, targets: ['linux-x64 '] },
    { schemaVersion: 3, targets: ['linux-x64', 'linux-x64'] },
    { schemaVersion: 3, targets: ['linux-x64/'] },
    { schemaVersion: 3, targets: ['./linux-x64'] },
    { schemaVersion: 3, targets: ['../linux-x64'] },
    { schemaVersion: 3, targets: ['linux', 'x64'] },
    { schemaVersion: 3, targets: ['darwin-x64'] },
    { schemaVersion: 3 },
    { schemaVersion: 2, targets: ['linux-x64'] },
    { targets: ['linux-x64'] },
    ['linux-x64'],
    '{"schemaVersion":3,targets:["linux-x64"]',
  ];
  for (const index of bad) {
    const f = fixture(index);
    await assert.rejects(
      resolveRuntime({ extensionRoot: f.root, ...host('linux-x64') }),
      /Bundled runtime/,
      JSON.stringify(index),
    );
  }
});
test('child manifests must stay schema 2, match their directory and keep paths inside the bundle', async () => {
  const { resolveRuntime } = await load();
  const f = fixture({ schemaVersion: 3, targets });
  const opts = { extensionRoot: f.root, ...host('linux-x64') };
  const dir = f.children['linux-x64'];
  const good = {
    schemaVersion: 2,
    target: 'linux-x64',
    nodeVersion: 'v24.22.1',
    playwrightVersion: '1.64.1',
    node: 'node',
    browserMode: 'auto',
    helper: 'helper/adl-linux-atspi-helper',
  };
  const write = manifest => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const patch of [
    { target: 'darwin-arm64' },
    { target: 'win32-x64' },
    { schemaVersion: 3 },
    { schemaVersion: 1 },
    { node: '../node' },
    { node: 'node.exe' },
    { helper: 'helper/x' },
    { nodeVersion: 'v23.0.0' },
    { browserMode: 'download-all' },
  ]) {
    write({ ...good, ...patch });
    await assert.rejects(resolveRuntime(opts), /Bundled runtime/, JSON.stringify(patch));
  }
  write(good);
  await resolveRuntime(opts);
  fs.rmSync(path.join(dir, 'manifest.json'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{');
  await assert.rejects(resolveRuntime(opts), /valid JSON/);
});
test('universal children cannot symlink out of the root runtime; execute bits repair and resolve retries coalesce', async t => {
  const { resolveRuntime } = await load();
  const f = fixture({ schemaVersion: 3, targets });
  const opts = { extensionRoot: f.root, ...host('linux-x64') };
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-outside-'));
  dirs.push(outside);
  fs.mkdirSync(path.join(outside, 'child'));
  fs.writeFileSync(path.join(outside, 'child', 'node'), 'evil');
  fs.writeFileSync(
    path.join(outside, 'child', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 2,
      target: 'linux-x64',
      nodeVersion: 'v24.22.1',
      playwrightVersion: '1.64.1',
      node: 'node',
      browserMode: 'auto',
      helper: 'helper/adl-linux-atspi-helper',
    }),
  );
  fs.rmSync(path.join(f.rt, 'linux-x64'), { recursive: true, force: true });
  try {
    fs.symlinkSync(path.join(outside, 'child'), path.join(f.rt, 'linux-x64'), 'junction');
  } catch (error) {
    if (error.code === 'EPERM' && process.platform === 'win32') {
      t.skip('Windows symlink privilege unavailable');
      return;
    }
    throw error;
  }
  await assert.rejects(resolveRuntime(opts), /escape|outside|ランタイム外/i);
  fs.rmSync(path.join(f.rt, 'linux-x64'), { recursive: true, force: true });
  fs.mkdirSync(path.join(f.rt, 'linux-x64', 'helper'), { recursive: true });
  fs.writeFileSync(
    path.join(f.rt, 'linux-x64', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 2,
      target: 'linux-x64',
      nodeVersion: 'v24.22.1',
      playwrightVersion: '1.64.1',
      node: 'node',
      browserMode: 'auto',
      helper: 'helper/adl-linux-atspi-helper',
    }),
  );
  fs.writeFileSync(path.join(f.rt, 'linux-x64', 'node'), 'linux');
  fs.writeFileSync(path.join(f.rt, 'linux-x64', 'helper', 'adl-linux-atspi-helper'), '#!/usr/bin/python3\n');
  fs.chmodSync(path.join(f.rt, 'linux-x64', 'node'), 0o644);
  fs.chmodSync(path.join(f.rt, 'linux-x64', 'helper', 'adl-linux-atspi-helper'), 0o644);
  const a = resolveRuntime(opts),
    b = resolveRuntime(opts);
  assert.equal(a, b);
  const r = await a;
  if (process.platform !== 'win32') {
    assert.ok(fs.statSync(r.nodePath).mode & 0o100);
    assert.ok(fs.statSync(r.helperPath).mode & 0o100, 'the Linux helper execute bit is repaired too');
  }
  fs.rmSync(path.join(f.rt, 'linux-x64'), { recursive: true, force: true });
  await assert.rejects(resolveRuntime(opts), /missing|not bundled/i);
  fs.mkdirSync(path.join(f.rt, 'linux-x64', 'helper'), { recursive: true });
  fs.writeFileSync(
    path.join(f.rt, 'linux-x64', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 2,
      target: 'linux-x64',
      nodeVersion: 'v24.22.1',
      playwrightVersion: '1.64.1',
      node: 'node',
      browserMode: 'auto',
      helper: 'helper/adl-linux-atspi-helper',
    }),
  );
  fs.writeFileSync(path.join(f.rt, 'linux-x64', 'node'), 'linux');
  await assert.rejects(resolveRuntime(opts), /missing/, 'a Linux bundle without its helper fails closed');
  fs.writeFileSync(path.join(f.rt, 'linux-x64', 'helper', 'adl-linux-atspi-helper'), '#!/usr/bin/python3\n');
  await resolveRuntime(opts);
});
test('schema 2 component bundles keep resolving flat next to universal support', async () => {
  const { resolveRuntime } = await load();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-component-'));
  dirs.push(root);
  const rt = path.join(root, 'runtime');
  fs.mkdirSync(rt);
  fs.writeFileSync(
    path.join(rt, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 2,
      target: 'linux-x64',
      nodeVersion: 'v24.22.1',
      playwrightVersion: '1.64.1',
      node: 'node',
      browserMode: 'auto',
      helper: 'helper/adl-linux-atspi-helper',
    }),
  );
  fs.writeFileSync(path.join(rt, 'node'), 'node');
  fs.chmodSync(path.join(rt, 'node'), 0o755);
  fs.mkdirSync(path.join(rt, 'helper'));
  fs.writeFileSync(path.join(rt, 'helper', 'adl-linux-atspi-helper'), '#!/usr/bin/python3\n');
  fs.chmodSync(path.join(rt, 'helper', 'adl-linux-atspi-helper'), 0o755);
  const r = await resolveRuntime({ extensionRoot: root, ...host('linux-x64') });
  assert.equal(r.runtimeDir, rt);
  assert.equal(fs.readFileSync(r.nodePath, 'utf8'), 'node');
  await assert.rejects(resolveRuntime({ extensionRoot: root, ...host('darwin-arm64') }), /target mismatch/);
});
