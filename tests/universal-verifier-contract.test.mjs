import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
test('archive verifier defaults to the host VSIX and accepts an explicit universal path', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adl-verifier-contract-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'scripts'));
  await fs.copyFile(path.join(root, 'scripts/verify-vsix.mjs'), path.join(dir, 'scripts/verify-vsix.mjs'));
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg));
  await fs.symlink(
    path.join(root, 'node_modules'),
    path.join(dir, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const run = args =>
    new Promise((yes, no) => {
      const p = spawn(process.execPath, [path.join(dir, 'scripts/verify-vsix.mjs'), ...args], {
        cwd: dir,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '';
      const timer = setTimeout(() => {
        p.kill('SIGKILL');
        no(new Error('verifier default-path probe timed out'));
      }, 10000);
      p.stdout.on('data', c => (text += c));
      p.stderr.on('data', c => (text += c));
      p.on('error', e => {
        clearTimeout(timer);
        no(e);
      });
      p.on('close', code => {
        clearTimeout(timer);
        yes({ code, text });
      });
    });
  const ordinary = await run([]);
  assert.notEqual(ordinary.code, 0);
  assert.ok(
    ordinary.text.includes(`agentdesklink-${process.platform}-${process.arch}-${pkg.version}.vsix`),
    ordinary.text,
  );
  const universal = await run(['--universal']);
  assert.notEqual(universal.code, 0);
  assert.ok(universal.text.includes(`agentdesklink-${pkg.version}.vsix`), universal.text);
  const explicit = path.join(dir, 'explicit-component.vsix');
  const component = await run([explicit]);
  assert.notEqual(component.code, 0);
  assert.ok(component.text.includes(explicit), component.text);
});
