import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
const req = createRequire(import.meta.url);
const zipReq = createRequire(req.resolve('@vscode/vsce'));
const { ZipFile } = zipReq('yazl');
const yauzl = zipReq('yauzl');
const targets = ['darwin-arm64', 'win32-x64', 'linux-x64'];
async function component(dir, target, extra = {}, modes = {}) {
  const p = path.join(dir, target + '.vsix'),
    z = new ZipFile();
  const helper = target.startsWith('darwin')
    ? 'helper/adl-macos-ax-helper'
    : target.startsWith('win32')
      ? 'helper/adl-windows-uia-helper.exe'
      : 'helper/adl-linux-atspi-helper';
  const node = target.startsWith('win32') ? 'node.exe' : 'node';
  const files = {
    '[Content_Types].xml':
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".js" ContentType="application/javascript"/></Types>',
    'extension.vsixmanifest': `<PackageManifest><Metadata><Identity Id="agentdesklink" Version="0.1.3" Publisher="agentdesklink" TargetPlatform="${target}"/></Metadata></PackageManifest>`,
    'extension/package.json': JSON.stringify({ name: 'agentdesklink', publisher: 'agentdesklink', version: '0.1.3' }),
    'extension/runtime/manifest.json': JSON.stringify({
      schemaVersion: 2,
      target,
      nodeVersion: 'v24.22.1',
      playwrightVersion: '1.64.1',
      browserMode: 'auto',
      node,
      helper,
    }),
    ['extension/runtime/' + node]: target + ' node',
    ...(helper ? { ['extension/runtime/' + helper]: target + ' helper' } : {}),
    'extension/dist/src/server.js': 'export const version="0.1.3";',
    'extension/node_modules/sharp/lib/index.js': 'module.exports="shared-sharp";',
    [`extension/node_modules/@img/sharp-${target}/lib/sharp.node`]: target + ' native sharp',
    'extension/release-docs/README.md': 'public guide',
    ...extra,
  };
  for (const [name, value] of Object.entries(files))
    z.addBuffer(Buffer.from(value), name, { mode: modes[name] ?? 0o100755 });
  z.end();
  await pipeline(z.outputStream, createWriteStream(p));
  return p;
}
async function entries(p) {
  const z = await new Promise((yes, no) => yauzl.open(p, { lazyEntries: true }, (e, v) => (e ? no(e) : yes(v))));
  const out = {};
  await new Promise((yes, no) => {
    z.on('error', no);
    z.on('end', yes);
    z.on('entry', entry => {
      z.openReadStream(entry, (e, s) => {
        if (e) return no(e);
        const chunks = [];
        s.on('data', c => chunks.push(c));
        s.on('error', no);
        s.on('end', () => {
          out[entry.fileName] = Buffer.concat(chunks).toString();
          z.readEntry();
        });
      });
    });
    z.readEntry();
  });
  return out;
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adl-universal-contract-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
test('one universal VSIX preserves three native runtimes and sharp dependencies without TargetPlatform', async t => {
  const { assembleUniversalVsix } = await import('../scripts/universal-vsix.mjs');
  const dir = await fixture(t);
  const components = await Promise.all(targets.map(target => component(dir, target)));
  const output = path.join(dir, 'agentdesklink-0.1.3.vsix');
  await assembleUniversalVsix({ components, output, version: '0.1.3' });
  const files = await entries(output);
  assert.ok(!/TargetPlatform=/.test(files['extension.vsixmanifest']));
  assert.deepEqual(JSON.parse(files['extension/runtime/manifest.json']), { schemaVersion: 3, targets });
  for (const target of targets) {
    assert.equal(JSON.parse(files[`extension/runtime/${target}/manifest.json`]).target, target);
    assert.equal(files[`extension/node_modules/@img/sharp-${target}/lib/sharp.node`], target + ' native sharp');
  }
  assert.equal(files['extension/runtime/linux-x64/node'], 'linux-x64 node');
  assert.equal(files['extension/runtime/win32-x64/helper/adl-windows-uia-helper.exe'], 'win32-x64 helper');
  assert.equal(files['extension/runtime/darwin-arm64/helper/adl-macos-ax-helper'], 'darwin-arm64 helper');
  assert.equal(files['extension/runtime/linux-x64/helper/adl-linux-atspi-helper'], 'linux-x64 helper');
  assert.equal(files['extension/dist/src/server.js'], 'export const version="0.1.3";');
  assert.equal(JSON.parse(files['extension/package.json']).version, '0.1.3');
  assert.ok(files['[Content_Types].xml'].includes('<Types xmlns='));
  assert.equal(files['extension/release-docs/README.md'], 'public guide');
  assert.equal(files['extension/runtime/node'], undefined);
});

test('concurrent assemblies serialize and cancellation in flight preserves a prior output', async t => {
  const { assembleUniversalVsix } = await import('../scripts/universal-vsix.mjs');
  const dir = await fixture(t);
  const components = await Promise.all(
    targets.map(target =>
      component(dir, target, { 'extension/node_modules/data.bin': Buffer.alloc(8 * 1024 * 1024, 91) }),
    ),
  );
  const output = path.join(dir, 'output.vsix');
  await fs.writeFile(output, 'previous');
  const c = new AbortController();
  const pending = assembleUniversalVsix({ components, output, version: '0.1.3', signal: c.signal });
  const timer = setTimeout(() => c.abort(new Error('cancelled in flight')), 2);
  try {
    await assert.rejects(pending, /abort|cancel/i);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(await fs.readFile(output, 'utf8'), 'previous');
  await Promise.all([
    assembleUniversalVsix({ components, output, version: '0.1.3' }),
    assembleUniversalVsix({ components, output, version: '0.1.3' }),
  ]);
  assert.equal(JSON.parse((await entries(output))['extension/package.json']).version, '0.1.3');
  assert.ok(!(await fs.readdir(dir)).some(n => n.includes('staging') || n.endsWith('.lock')));
});

test('case-colliding paths, archive symlinks and missing native components fail closed', async t => {
  const { assembleUniversalVsix } = await import('../scripts/universal-vsix.mjs');
  const dir = await fixture(t);
  const components = await Promise.all(targets.map(target => component(dir, target)));
  const output = path.join(dir, 'output.vsix');
  await fs.writeFile(output, 'previous');
  for (const [extra, modes] of [
    [{ 'extension/DIST/src/server.js': 'collision' }, {}],
    [{ 'extension/runtime/link': 'outside' }, { 'extension/runtime/link': 0o120777 }],
    [{ 'extension/runtime/node': '' }, {}],
    [{ 'extension/node_modules/@img/sharp-linux-x64/lib/sharp.node': '' }, {}],
  ]) {
    components[2] = await component(dir, 'linux-x64', extra, modes);
    await assert.rejects(assembleUniversalVsix({ components, output, version: '0.1.3' }));
    assert.equal(await fs.readFile(output, 'utf8'), 'previous');
  }
});

test('abort after output bytes are written settles and removes its lock and staging directory', async t => {
  const { assembleUniversalVsix } = await import('../scripts/universal-vsix.mjs');
  const dir = await fixture(t);
  const data = randomBytes(12 * 1024 * 1024);
  const components = await Promise.all(
    targets.map(target => component(dir, target, { 'extension/node_modules/data.bin': data })),
  );
  const output = path.join(dir, 'output.vsix');
  await fs.writeFile(output, 'previous');
  const c = new AbortController();
  let aborted = false,
    timeout;
  const pending = assembleUniversalVsix({ components, output, version: '0.1.3', signal: c.signal });
  const poll = setInterval(async () => {
    if (aborted) return;
    try {
      const stage = (await fs.readdir(dir)).find(name => name.includes('.staging-'));
      if (!stage) return;
      if ((await fs.stat(path.join(dir, stage, 'output.vsix'))).size > 128 * 1024) {
        aborted = true;
        c.abort(new Error('cancelled during write'));
      }
    } catch {}
  }, 2);
  let outcome;
  try {
    outcome = await Promise.race([
      pending.then(
        () => ({ resolved: true }),
        error => ({ error }),
      ),
      new Promise(yes => {
        timeout = setTimeout(() => yes({ timedout: true }), 4000);
      }),
    ]);
  } finally {
    clearInterval(poll);
    clearTimeout(timeout);
  }
  assert.ok(aborted, 'probe must reach the write phase');
  assert.ok(!outcome.timedout, 'assembly did not settle after mid-write abort');
  assert.ok(outcome.error, 'assembly must reject the abort');
  assert.equal(await fs.readFile(output, 'utf8'), 'previous');
  assert.ok(!(await fs.readdir(dir)).some(n => n.includes('staging') || n.endsWith('.lock')));
});
test('missing or duplicate targets, shared-code conflicts and version mismatches preserve existing output', async t => {
  const { assembleUniversalVsix } = await import('../scripts/universal-vsix.mjs');
  const dir = await fixture(t);
  const components = await Promise.all(targets.map(target => component(dir, target)));
  const output = path.join(dir, 'output.vsix');
  await fs.writeFile(output, 'previous');
  for (const inputs of [components.slice(0, 2), [components[0], components[0], components[2]]]) {
    await assert.rejects(assembleUniversalVsix({ components: inputs, output, version: '0.1.3' }));
    assert.equal(await fs.readFile(output, 'utf8'), 'previous');
  }
  components[1] = await component(dir, 'win32-x64', { 'extension/dist/src/server.js': 'different executable code' });
  await assert.rejects(assembleUniversalVsix({ components, output, version: '0.1.3' }), /conflict|differ|mismatch/i);
  assert.equal(await fs.readFile(output, 'utf8'), 'previous');
  components[1] = await component(dir, 'win32-x64', {
    'extension/package.json': JSON.stringify({ name: 'agentdesklink', publisher: 'agentdesklink', version: '0.1.2' }),
  });
  await assert.rejects(assembleUniversalVsix({ components, output, version: '0.1.3' }), /version|mismatch/i);
  assert.equal(await fs.readFile(output, 'utf8'), 'previous');
});
test('cancelled assembly never replaces output or leaves staging files', async t => {
  const { assembleUniversalVsix } = await import('../scripts/universal-vsix.mjs');
  const dir = await fixture(t);
  const components = await Promise.all(targets.map(target => component(dir, target)));
  const output = path.join(dir, 'output.vsix');
  await fs.writeFile(output, 'previous');
  const c = new AbortController();
  c.abort(new Error('cancelled'));
  await assert.rejects(assembleUniversalVsix({ components, output, version: '0.1.3', signal: c.signal }));
  assert.equal(await fs.readFile(output, 'utf8'), 'previous');
  assert.ok(!(await fs.readdir(dir)).some(n => n.includes('staging') || n.endsWith('.lock')));
});
