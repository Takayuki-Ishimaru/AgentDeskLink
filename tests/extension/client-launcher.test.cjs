'use strict';
// Blackbox tests for the managed MCP stdio launcher generator.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const mod = require('../../dist/src/extension/client-launcher.js');
const { writeManagedLauncher, readManagedDescriptor, writeManagedDescriptor } = mod;

const NODE = process.execPath;

function mkTmp() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'adl-launcher-'));
}

function baseDescriptor(overrides) {
  return Object.assign(
    {
      schemaVersion: 1,
      owner: 'test-owner',
      generation: 'gen-1',
      enabled: true,
      command: NODE,
      args: [],
      env: {},
      cwd: fs.realpathSync(os.tmpdir()),
    },
    overrides || {},
  );
}

function writeDescriptor(file, descriptor) {
  writeManagedDescriptor(file, descriptor);
}

function startLauncher(launcherPath, descriptorPath, opts) {
  const child = cp.spawn(
    NODE,
    [launcherPath, descriptorPath],
    Object.assign(
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, {
          ADL_POLICY: 'old',
          ADL_BROWSER_EXECUTABLE: '/old/browser',
          PLAYWRIGHT_BROWSERS_PATH: '/old/pw',
        }),
      },
      opts || {},
    ),
  );
  return child;
}

function once(emitter, event, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timeout waiting for ${event}`));
    }, ms || 8000);
    const child = emitter;
    const done = payload => {
      clearTimeout(timer);
      emitter.removeListener('error', onErr);
      resolve(payload);
    };
    const onErr = err => {
      clearTimeout(timer);
      reject(err);
    };
    emitter.once(event, done);
    emitter.once('error', onErr);
  });
}

async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + (ms || 5000);
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timeout: ${label || 'predicate'}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

function readStdoutLines(child, count, ms) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const lines = [];
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${count} stdout line(s); got: ${JSON.stringify(buf)}`)),
      ms || 8000,
    );
    child.stdout.on('data', d => {
      buf += d.toString('utf8');
      for (;;) {
        const nl = buf.indexOf('\n');
        if (nl < 0) break;
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (lines.length >= count) {
          clearTimeout(timer);
          resolve(lines);
          return;
        }
      }
    });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const STUB = [
  'process.stdin.on("data", (d) => {',
  '  for (const line of String(d).split("\\n")) {',
  '    if (!line.trim()) continue;',
  '    let msg;',
  '    try { msg = JSON.parse(line); } catch (e) { continue; }',
  '    const payload = { id: msg.id, cwd: process.cwd(), env: process.env, args: process.argv.slice(2) };',
  '    process.stdout.write(JSON.stringify(payload) + "\\n");',
  '  }',
  '});',
  'process.stdin.on("end", () => process.exit(0));',
].join('\n');

function writeStub(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'stub.cjs');
  fs.writeFileSync(file, STUB, 'utf8');
  return file;
}

test('writeManagedLauncher: fixed paths, POSIX owner-only dir, idempotent', () => {
  const dir = mkTmp();
  try {
    const r1 = writeManagedLauncher(dir);
    assert.equal(r1.launcherPath, path.join(dir, 'ai-clients', 'launcher.cjs'));
    assert.equal(r1.descriptorPath, path.join(dir, 'ai-clients', 'launch.json'));
    const mode = fs.statSync(path.join(dir, 'ai-clients')).mode & 0o777;
    // Windows chmod does not expose POSIX owner/group/other permission bits.
    if (process.platform !== 'win32') assert.equal(mode & 0o077, 0, 'directory must be owner-only');
    const src1 = fs.readFileSync(r1.launcherPath, 'utf8');
    assert.ok(!src1.includes('vscode'));
    const mtime1 = fs.statSync(r1.launcherPath).mtimeMs;
    const r2 = writeManagedLauncher(dir);
    assert.deepEqual(r2, r1);
    assert.equal(fs.readFileSync(r2.launcherPath, 'utf8'), src1);
    assert.equal(fs.statSync(r2.launcherPath).mtimeMs, mtime1, 'idempotent: bytes same, no rewrite');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('descriptor round-trip, schema and size validation', () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'launch.json');
    const d = baseDescriptor({ env: { FOO: 'bar' } });
    writeDescriptor(file, d);
    const got = readManagedDescriptor(file);
    assert.deepEqual(got, d);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    fs.writeFileSync(path.join(dir, 'bad1.json'), JSON.stringify(Object.assign({}, d, { extra: 1 })));
    assert.equal(readManagedDescriptor(path.join(dir, 'bad1.json')), undefined, 'unknown field rejected');
    fs.writeFileSync(path.join(dir, 'bad2.json'), JSON.stringify(Object.assign({}, d, { schemaVersion: 2 })));
    assert.equal(readManagedDescriptor(path.join(dir, 'bad2.json')), undefined);
    fs.writeFileSync(path.join(dir, 'bad3.json'), JSON.stringify(Object.assign({}, d, { generation: '' })));
    assert.equal(readManagedDescriptor(path.join(dir, 'bad3.json')), undefined, 'empty generation rejected');
    fs.writeFileSync(path.join(dir, 'bad4.json'), JSON.stringify(Object.assign({}, d, { command: 'node' })));
    assert.equal(readManagedDescriptor(path.join(dir, 'bad4.json')), undefined, 'relative command rejected');
    fs.writeFileSync(path.join(dir, 'bad5.json'), JSON.stringify(Object.assign({}, d, { env: { X: 5 } })));
    assert.equal(readManagedDescriptor(path.join(dir, 'bad5.json')), undefined, 'non-string env value rejected');
    fs.writeFileSync(path.join(dir, 'bad6.json'), JSON.stringify(Object.assign({}, d, { args: [1] })));
    assert.equal(readManagedDescriptor(path.join(dir, 'bad6.json')), undefined, 'non-string arg rejected');
    fs.writeFileSync(path.join(dir, 'bad7.json'), '{not json');
    assert.equal(readManagedDescriptor(path.join(dir, 'bad7.json')), undefined);
    assert.equal(readManagedDescriptor(path.join(dir, 'missing.json')), undefined, 'missing file -> undefined');

    fs.writeFileSync(path.join(dir, 'big.json'), Buffer.alloc(256 * 1024 + 10, 0x20));
    assert.equal(readManagedDescriptor(path.join(dir, 'big.json')), undefined, 'oversized rejected');

    assert.throws(() => writeManagedDescriptor(path.join(dir, 'rej.json'), Object.assign({}, d, { generation: '' })));
    assert.throws(() => writeManagedDescriptor(path.join(dir, 'rej.json'), Object.assign({}, d, { cwd: 'rel' })));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeManagedDescriptor rejects symlink leaf and ancestor', () => {
  const dir = mkTmp();
  try {
    const d = baseDescriptor();
    const real = path.join(dir, 'real.json');
    fs.writeFileSync(real, '{}', 'utf8');
    const link = path.join(dir, 'link.json');
    fs.symlinkSync(real, link);
    assert.throws(() => writeManagedDescriptor(link, d), /symlink/);
    assert.equal(fs.readlinkSync(link), real, 'symlink untouched');

    const linkDir = path.join(dir, 'linkdir');
    fs.symlinkSync(dir, linkDir);
    assert.throws(() => writeManagedDescriptor(path.join(linkDir, 'sub', 'launch.json'), d), /symlink/);
    assert.equal(fs.existsSync(path.join(dir, 'sub')), false, 'reject before creating directories through a symlink');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launcher: enabled descriptor echoes MCP-like stdout, cwd, env policy', async () => {
  const dir = mkTmp();
  try {
    const { launcherPath, descriptorPath } = writeManagedLauncher(dir);
    const stub = writeStub(dir);
    const workdir = path.join(dir, 'work');
    fs.mkdirSync(workdir);
    writeDescriptor(
      descriptorPath,
      baseDescriptor({
        command: NODE,
        args: [stub, 'ADL-ARG-1'],
        cwd: workdir,
        env: { ADL_BROWSER_EXECUTABLE: '/new/browser', KEEP_ME: 'yes' },
      }),
    );
    const child = startLauncher(launcherPath, descriptorPath);
    const lines = readStdoutLines(child, 1);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }) + '\n');
    const [line] = await lines;
    const payload = JSON.parse(line);
    assert.equal(payload.id, 7, 'protocol id unchanged through launcher');
    assert.equal(fs.realpathSync(payload.cwd), fs.realpathSync(workdir), 'child cwd from descriptor');
    assert.deepEqual(payload.args, ['ADL-ARG-1'], 'descriptor args passed verbatim');
    assert.equal(payload.env.ADL_BROWSER_EXECUTABLE, '/new/browser', 'descriptor overlay wins');
    assert.equal(payload.env.PLAYWRIGHT_BROWSERS_PATH, undefined, 'PLAYWRIGHT_BROWSERS_PATH cleared');
    assert.equal(payload.env.KEEP_ME, 'yes');
    assert.equal(payload.env.ADL_POLICY, undefined, 'inherited ADL_ vars stripped');
    child.stdin.end();
    await once(child, 'exit');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launcher: start denied for disabled, missing, malformed; exit code propagated', async () => {
  const dir = mkTmp();
  try {
    const { launcherPath, descriptorPath } = writeManagedLauncher(dir);
    const stub = writeStub(dir);
    const cases = [
      [
        'disabled',
        () => writeDescriptor(descriptorPath, baseDescriptor({ command: NODE, args: [stub], enabled: false })),
      ],
      ['missing', () => {}],
      ['malformed', () => fs.writeFileSync(descriptorPath, 'nope{')],
    ];
    for (const [name, setup] of cases) {
      setup();
      const child = startLauncher(launcherPath, descriptorPath);
      let stdout = '';
      child.stdout.on('data', d => {
        stdout += d.toString('utf8');
      });
      const code = await once(child, 'exit');
      assert.notEqual(code, 0, `${name}: nonzero exit`);
      assert.equal(stdout, '', `${name}: no stdout`);
      if (fs.existsSync(descriptorPath)) fs.rmSync(descriptorPath);
    }
    writeDescriptor(descriptorPath, baseDescriptor({ command: path.join(dir, 'definitely-missing-bin'), args: [] }));
    const enoent = startLauncher(launcherPath, descriptorPath);
    const ec = await once(enoent, 'exit');
    assert.notEqual(ec, 0, 'spawn ENOENT exits nonzero');

    const codeStub = path.join(dir, 'code.cjs');
    fs.writeFileSync(codeStub, 'process.exit(3);', 'utf8');
    writeDescriptor(descriptorPath, baseDescriptor({ command: NODE, args: [codeStub] }));
    const c2 = startLauncher(launcherPath, descriptorPath);
    const code = await once(c2, 'exit');
    assert.equal(code, 3, 'exit code propagated');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launcher: generation, owner, policy and cwd changes terminate running child', async () => {
  const dir = mkTmp();
  try {
    const { launcherPath, descriptorPath } = writeManagedLauncher(dir);
    const scenarios = [
      ['generation', d => Object.assign({}, d, { generation: 'gen-2' })],
      ['owner', d => Object.assign({}, d, { owner: 'other-owner' })],
      ['policy', d => Object.assign({}, d, { env: { POLICY: 'changed' } })],
      ['cwd', d => Object.assign({}, d, { cwd: path.join(dir, 'other') })],
    ];
    for (const [name, mutate] of scenarios) {
      const stub = writeStub(path.join(dir, name));
      const d0 = baseDescriptor({ command: NODE, args: [stub] });
      writeDescriptor(descriptorPath, d0);
      const child = startLauncher(launcherPath, descriptorPath);
      const lines = readStdoutLines(child, 1);
      child.stdin.write(JSON.stringify({ id: 1 }) + '\n');
      await lines;
      const exited = once(child, 'exit', 5000);
      writeDescriptor(descriptorPath, mutate(d0));
      const code = await exited;
      assert.notEqual(code, 0, `${name}: launcher exits nonzero after revoke`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launcher: rapid disable/re-enable with new generation never resumes old launcher', async () => {
  const dir = mkTmp();
  try {
    const { launcherPath, descriptorPath } = writeManagedLauncher(dir);
    const stub = writeStub(dir);
    const d0 = baseDescriptor({ command: NODE, args: [stub], generation: 'gen-1' });
    writeDescriptor(descriptorPath, d0);
    const child = startLauncher(launcherPath, descriptorPath);
    const lines = readStdoutLines(child, 1);
    child.stdin.write(JSON.stringify({ id: 1 }) + '\n');
    await lines;
    const exited = once(child, 'exit', 5000);
    writeDescriptor(descriptorPath, Object.assign({}, d0, { enabled: false }));
    writeDescriptor(descriptorPath, Object.assign({}, d0, { generation: 'gen-2' }));
    await exited;
    child.stdin.write(JSON.stringify({ id: 2 }) + '\n');
    const before = child.stdout.read();
    assert.ok(before === null || before.length === 0, 'no output after revoke');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launcher: descriptor removed while running terminates child', async () => {
  const dir = mkTmp();
  try {
    const { launcherPath, descriptorPath } = writeManagedLauncher(dir);
    const stub = writeStub(dir);
    writeDescriptor(descriptorPath, baseDescriptor({ command: NODE, args: [stub] }));
    const child = startLauncher(launcherPath, descriptorPath);
    const lines = readStdoutLines(child, 1);
    child.stdin.write(JSON.stringify({ id: 1 }) + '\n');
    await lines;
    const exited = once(child, 'exit', 5000);
    fs.rmSync(descriptorPath);
    await exited;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launcher: SIGTERM to launcher terminates child and exits', async () => {
  const dir = mkTmp();
  try {
    const { launcherPath, descriptorPath } = writeManagedLauncher(dir);
    const stub = writeStub(dir);
    writeDescriptor(descriptorPath, baseDescriptor({ command: NODE, args: [stub] }));
    const child = startLauncher(launcherPath, descriptorPath);
    const lines = readStdoutLines(child, 1);
    child.stdin.write(JSON.stringify({ id: 1 }) + '\n');
    await lines;
    const exited = once(child, 'exit', 5000);
    child.kill('SIGTERM');
    await exited;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launcher: missing cwd denies start', async () => {
  const dir = mkTmp();
  try {
    const { launcherPath, descriptorPath } = writeManagedLauncher(dir);
    const stub = writeStub(dir);
    writeDescriptor(descriptorPath, baseDescriptor({ command: NODE, args: [stub], cwd: path.join(dir, 'nope') }));
    const child = startLauncher(launcherPath, descriptorPath);
    let stdout = '';
    child.stdout.on('data', d => {
      stdout += d.toString('utf8');
    });
    const code = await once(child, 'exit');
    assert.notEqual(code, 0);
    assert.equal(stdout, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
