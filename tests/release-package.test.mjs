import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const realPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

// The public payload allowlist is the privacy boundary: it must stay exactly this set.
const ALLOWLIST = [
  'runtime/**',
  'dist/src',
  'dist/extension/*.cjs',
  'config',
  'README.md',
  'README_en.md',
  'LICENSE',
  'release-docs/**/*.md',
  'media',
  'node_modules/**',
];

test('package.json files array is exactly the public payload allowlist', () => {
  assert.deepEqual([...realPkg.files].sort(), [...ALLOWLIST].sort());
  // Internal engineering/QA/native/script paths must never reappear in the allowlist.
  for (const forbidden of ['docs/', 'native/', 'scripts/', 'benchmarks', 'artifacts', 'tests/', 'src/']) {
    assert.ok(!realPkg.files.some(entry => entry === forbidden || entry.startsWith(forbidden)),
      `allowlist must not contain internal path ${forbidden}: ${realPkg.files.join(', ')}`);
  }
});

// Bounded child: kill npm if it ever hangs, and only ever run it with --ignore-scripts.
function npmPackDryRun(cwd) {
  return new Promise((resolve, reject) => {
    const args = ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', '--update-notifier=false', '--cache', path.join(cwd,'.npm-cache')];
    // npm.cmd cannot be spawned directly on Windows. npm scripts expose the CLI path.
    const npmCli = process.env.npm_execpath;
    const child = spawn(npmCli ? process.execPath : 'npm', npmCli ? [npmCli, ...args] : args, {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('npm pack --dry-run timed out'));
    }, 30_000);
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`npm pack failed (${code ?? sig}):\n${stderr.slice(0, 2000)}`));
      try {
        const parsed = JSON.parse(stdout);
        resolve(Array.isArray(parsed) ? parsed[0] : parsed);
      } catch (err) {
        reject(new Error(`npm pack JSON parse failed: ${err.message}\n${stdout.slice(0, 500)}`));
      }
    });
  });
}

async function writeFixtureFile(root, rel, contents, { executable = false } = {}) {
  const target = path.join(root, rel);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, contents);
  if (executable) await fsp.chmod(target, 0o755);
}

// npm has its own 30s child bound; allow it to settle and run cleanup on slow Windows hosts.
test('npm pack payload keeps runtime/dist/docs/config/media and excludes internal engineering artifacts', {timeout:35_000}, async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'adl-release-pack-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  // Copy the ACTUAL package files allowlist into the fixture so the test guards the real boundary.
  await fsp.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: realPkg.name,
    version: realPkg.version,
    license: realPkg.license,
    type: realPkg.type,
    main: realPkg.main,
    bin: realPkg.bin,
    files: realPkg.files,
  }, null, 2));

  // Included: runtime node + native helper + license + manifest, dist/src, dist/extension, public docs, config, media.
  await writeFixtureFile(root, 'runtime/node', 'node-binary', { executable: true });
  await writeFixtureFile(root, 'runtime/helper/adl-windows-uia-helper.exe', 'helper-binary', { executable: true });
  await writeFixtureFile(root, 'runtime/LICENSE', 'node-license');
  await writeFixtureFile(root, 'runtime/manifest.json', '{"schemaVersion":2}');
  await writeFixtureFile(root, 'dist/src/server.js', 'server');
  await writeFixtureFile(root, 'dist/extension/extension.cjs', 'extension');
  await writeFixtureFile(root, 'config/settings.json', '{}');
  await writeFixtureFile(root, 'README.md', 'readme');
  await writeFixtureFile(root, 'README_en.md', 'readme-en');
  await writeFixtureFile(root, 'LICENSE', 'mit');
  await writeFixtureFile(root, 'release-docs/CHANGELOG.md', 'changelog');
  await writeFixtureFile(root, 'release-docs/guide/START.md', 'start');
  await writeFixtureFile(root, 'media/extension-icon.png', 'png');

  // Excluded: internal engineering docs, QA/benchmark artifacts, tests, raw TS/native source, scripts, unknown internal folder.
  await writeFixtureFile(root, 'docs/RELEASE_READINESS.md', 'internal');
  await writeFixtureFile(root, 'docs/TOKEN_MEASUREMENT.md', 'internal');
  await writeFixtureFile(root, 'benchmarks/browser.js', 'internal');
  await writeFixtureFile(root, 'artifacts/QA/run.log', 'internal');
  await writeFixtureFile(root, 'tests/package-runtime.test.mjs', 'internal');
  await writeFixtureFile(root, 'src/server.ts', 'internal');
  await writeFixtureFile(root, 'native/windows-uia/README.md', 'internal');
  await writeFixtureFile(root, 'native/windows-uia/Program.cs', 'internal');
  await writeFixtureFile(root, 'native/macos-ax/tests/ax_tests.swift', 'internal');
  await writeFixtureFile(root, 'scripts/package-vsix.mjs', 'internal');
  await writeFixtureFile(root, 'internal-secrets/keys.txt', 'internal');

  const packed = await npmPackDryRun(root);
  const paths = new Set(packed.files.map(f => f.path));
  const modeOf = Object.fromEntries(packed.files.map(f => [f.path, f.mode]));

  for (const included of [
    'runtime/node',
    'runtime/helper/adl-windows-uia-helper.exe',
    'runtime/LICENSE',
    'runtime/manifest.json',
    'dist/src/server.js',
    'dist/extension/extension.cjs',
    'config/settings.json',
    'README.md',
    'README_en.md',
    'LICENSE',
    'release-docs/CHANGELOG.md',
    'release-docs/guide/START.md',
    'media/extension-icon.png',
    'package.json',
  ]) {
    assert.ok(paths.has(included), `expected ${included} in payload`);
  }

  // Windows does not use POSIX executable bits; its packaged files are checked above.
  // Unix bundles must retain their executable permissions.
  if (process.platform !== 'win32') {
    for (const exec of ['runtime/node', 'runtime/helper/adl-windows-uia-helper.exe']) {
      assert.ok(modeOf[exec] & 0o111, `expected executable mode for ${exec}, got ${modeOf[exec]?.toString(8)}`);
    }
  }

  for (const excluded of [
    'docs/RELEASE_READINESS.md',
    'docs/TOKEN_MEASUREMENT.md',
    'benchmarks/browser.js',
    'artifacts/QA/run.log',
    'tests/package-runtime.test.mjs',
    'src/server.ts',
    'native/windows-uia/README.md',
    'native/windows-uia/Program.cs',
    'native/macos-ax/tests/ax_tests.swift',
    'scripts/package-vsix.mjs',
    'internal-secrets/keys.txt',
  ]) {
    assert.ok(!paths.has(excluded), `must NOT ship internal file ${excluded}`);
  }

  // No internal top-level folder leaks, including a future unknown one.
  const internalTopLevel = new Set(['docs', 'benchmarks', 'artifacts', 'tests', 'src', 'native', 'scripts', 'internal-secrets']);
  const leaked = [...paths].filter(p => internalTopLevel.has(p.split('/')[0]));
  assert.deepEqual(leaked, [], `internal top-level paths leaked: ${leaked.join(', ')}`);

  // Exercise the VSIX packager too: npm and VSCE have different file collectors.
  const { listFiles, PackageManager } = createRequire(import.meta.url)('@vscode/vsce');
  const vsixPaths = new Set(await listFiles({ cwd: root, packageManager: PackageManager.None, manifest: {
    ...realPkg, dependencies: {}, devDependencies: {},
  } }));
  for (const included of paths) assert.ok(vsixPaths.has(included), `VSCE must include ${included}`);
  assert.deepEqual([...vsixPaths].filter(p => internalTopLevel.has(p.split('/')[0])), [],
    'VSCE must exclude internal folders too');

  // node_modules is auto-excluded by npm (no bundledDependencies); never assert it is packed.
  assert.ok(!realPkg.bundledDependencies && !realPkg.bundleDependencies,
    'fixture relies on npm auto-excluding node_modules without bundledDependencies');
  assert.ok(![...paths].some(p => p === 'node_modules' || p.startsWith('node_modules/')),
    'node_modules must not appear in npm pack output here');
});
