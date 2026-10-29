const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const targets = ['darwin-arm64', 'win32-x64', 'linux-x64'];
const dirs = [];
afterEach(() => {
  for (const p of dirs.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-common-runtime-'));
  dirs.push(root);
  const rt = path.join(root, 'runtime');
  fs.mkdirSync(rt);
  fs.writeFileSync(path.join(rt, 'manifest.json'), JSON.stringify({ schemaVersion: 3, targets }));
  for (const target of targets) {
    const win = target.startsWith('win32'),
      mac = target.startsWith('darwin');
    const d = path.join(rt, target);
    fs.mkdirSync(d);
    const helper = mac
        ? 'helper/adl-macos-ax-helper'
        : win
          ? 'helper/adl-windows-uia-helper.exe'
          : 'helper/adl-linux-atspi-helper',
      node = win ? 'node.exe' : 'node';
    for (const rel of [node, helper].filter(Boolean)) {
      const p = path.join(d, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, target);
      fs.chmodSync(p, 0o755);
    }
    fs.writeFileSync(
      path.join(d, 'manifest.json'),
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
  }
  return { root, rt };
}
test('same universal bundle selects the exact local runtime on macOS, Windows and Linux', async () => {
  const { resolveRuntime } = await import('../../dist/src/extension/runtime.js');
  const f = fixture();
  for (const target of targets) {
    const [platform, arch] = target.split('-');
    const r = await resolveRuntime({ extensionRoot: f.root, platform, arch });
    assert.equal(r.runtimeDir, path.join(f.rt, target));
    assert.equal(r.manifest.target, target);
    assert.equal(fs.readFileSync(r.nodePath, 'utf8'), target);
    assert.equal(fs.readFileSync(r.helperPath, 'utf8'), target);
    assert.equal(r.env.ADL_BUNDLED_HELPER_PATH, r.helperPath);
  }
  await assert.rejects(
    resolveRuntime({ extensionRoot: f.root, platform: 'linux', arch: 'arm64' }),
    /unsupported|not.*bundled|missing|対応/i,
  );
});
test('missing target, malformed index, traversal names and escaping runtime directories fail closed', async t => {
  const { resolveRuntime } = await import('../../dist/src/extension/runtime.js');
  const f = fixture();
  const opts = { extensionRoot: f.root, platform: 'linux', arch: 'x64' };
  for (const targets of [['darwin-arm64'], ['../linux-x64'], ['linux-x64', 'linux-x64'], [], null]) {
    fs.writeFileSync(path.join(f.rt, 'manifest.json'), JSON.stringify({ schemaVersion: 3, targets }));
    await assert.rejects(resolveRuntime(opts));
  }
  fs.writeFileSync(path.join(f.rt, 'manifest.json'), JSON.stringify({ schemaVersion: 3, targets: ['linux-x64'] }));
  fs.renameSync(path.join(f.rt, 'linux-x64'), path.join(f.root, 'outside'));
  try {
    fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.rt, 'linux-x64'), 'junction');
  } catch (e) {
    if (e.code === 'EPERM' && process.platform === 'win32') {
      t.skip('Windows symlink privilege unavailable');
      return;
    }
    throw e;
  }
  await assert.rejects(resolveRuntime(opts), /escape|outside|ランタイム外/i);
});
test('smaller native update assets are preferred with a universal fallback', async () => {
  const { findGitHubUpdate } = await import('../../dist/src/extension/update-source.js');
  const base = 'https://github.com/Takayuki-Ishimaru/AgentDeskLink';
  const sha = 'a'.repeat(64);
  const asset = name => ({
    name,
    state: 'uploaded',
    digest: 'sha256:' + sha,
    browser_download_url: base + '/releases/download/v0.1.3/' + name,
  });
  const release = {
    tag_name: 'v0.1.3',
    draft: false,
    prerelease: true,
    assets: [asset('agentdesklink-darwin-arm64-0.1.3.vsix'), asset('agentdesklink-0.1.3.vsix')],
  };
  for (const target of targets) {
    const [p, a] = target.split('-');
    assert.equal(
      findGitHubUpdate([release], p, a).url,
      base +
        '/releases/download/v0.1.3/' +
        (target === 'darwin-arm64' ? 'agentdesklink-darwin-arm64-0.1.3.vsix' : 'agentdesklink-0.1.3.vsix'),
    );
  }
  assert.equal(
    findGitHubUpdate([{ ...release, assets: [asset('agentdesklink-0.1.3.vsix')] }], 'linux', 'arm64'),
    undefined,
  );
  assert.equal(
    findGitHubUpdate([{ ...release, assets: [asset('agentdesklink-darwin-arm64-0.1.3.vsix')] }], 'darwin', 'arm64')
      .sha256,
    sha,
  );
  assert.equal(
    findGitHubUpdate(
      [{ ...release, assets: [{ ...asset('agentdesklink-0.1.3.vsix'), digest: 'bad' }] }],
      'linux',
      'x64',
    ),
    undefined,
  );
});
