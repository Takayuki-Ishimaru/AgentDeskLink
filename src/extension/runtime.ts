import * as fs from 'node:fs';
import * as path from 'node:path';

// Bundled runtime contract shipped inside the VSIX at <extensionRoot>/runtime/manifest.json.
export interface RuntimeManifest {
  schemaVersion: 2;
  target: string;
  nodeVersion: string;
  playwrightVersion: string;
  node: string;
  browserMode: 'auto';
  helper: string | null;
}

// Universal bundle index shipped at <extensionRoot>/runtime/manifest.json with EXACTLY these two keys.
export interface UniversalManifest {
  schemaVersion: 3;
  targets: string[];
}

export interface ResolvedRuntime {
  runtimeDir: string;
  nodePath: string;
  helperPath: string | null;
  env: Record<string, string>;
  manifest: RuntimeManifest;
}

export interface ResolveOptions {
  extensionRoot: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

export class RuntimeError extends Error {}

const SUPPORTED_PLATFORMS = ['darwin', 'win32', 'linux'];
const SUPPORTED_ARCHS = ['x64', 'arm64'];
// Universal (schema 3) bundles carry exactly these three children.
export const UNIVERSAL_TARGETS = ['darwin-arm64', 'win32-x64', 'linux-x64'];
const HELPERS: Record<string, string> = {
  darwin: 'helper/adl-macos-ax-helper',
  win32: 'helper/adl-windows-uia-helper.exe',
  // Python 3 script (needs python3-gi + gir1.2-atspi-2.0 at runtime); the server reports missing prerequisites per request.
  linux: 'helper/adl-linux-atspi-helper',
};

function fail(message: string): never {
  throw new RuntimeError(
    `AgentDeskLink 同梱ランタイムを確認できません / Bundled runtime is missing or incomplete: ${message}`,
  );
}

// Rejects absolute paths, drive letters, backslashes, empty segments and any raw '..'
// segment before normalization, so "foo/../node" style paths never reach the filesystem.
function checkRelative(raw: unknown, what: string): string {
  if (typeof raw !== 'string' || raw.length === 0) fail(`${what} が不正です / invalid path in manifest: ${what}`);
  const p = raw as string;
  if (p.includes('\0') || p.includes('\\') || /^[a-zA-Z]:/.test(p) || path.isAbsolute(p) || p.startsWith('/')) {
    fail(`${what} に不正なパス指定 / absolute, drive or backslash path not allowed: ${p}`);
  }
  if (p.split('/').some(s => s === '' || s === '.' || s === '..')) {
    fail(`${what} に親ディレクトリ参照 / empty, dot or traversal segment not allowed: ${p}`);
  }
  return p;
}

async function regularFile(file: string): Promise<fs.Stats | null> {
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(file); // lstat: symlinks are checked by the anchor below, never followed blindly
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  return st;
}

// Realpath anchor check: the resolved path must live inside the real runtime directory.
async function assertInsideRuntime(runtimeDir: string, file: string, what: string): Promise<void> {
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = await fs.promises.realpath(runtimeDir);
    realFile = await fs.promises.realpath(file);
  } catch {
    fail(`${what} を解決できません / cannot resolve path: ${file}`);
  }
  if (realFile !== realRoot && !realFile.startsWith(realRoot + path.sep)) {
    fail(`${what} がランタイム外を指します / path escapes the runtime directory: ${file}`);
  }
}

async function requireExecutable(runtimeDir: string, rel: string, what: string, restoreMode: boolean): Promise<string> {
  const file = path.join(runtimeDir, ...rel.split('/'));
  let st = await regularFile(file);
  if (!st) fail(`${what} が見つかりません / required file is missing or not a regular file: ${rel}`);
  if (st.size === 0) fail(`${what} が空です / required file is empty: ${rel}`);
  await assertInsideRuntime(runtimeDir, file, what);
  if (restoreMode) {
    // Zip round-trips can drop exec bits; restore them for known bundled files only (inside the bundle).
    const needed = fs.constants.S_IXUSR | fs.constants.S_IXGRP | fs.constants.S_IXOTH;
    if ((st.mode & needed) !== needed) {
      try {
        await fs.promises.chmod(file, st.mode | 0o111);
      } catch {
        /* keep failing closed below */
      }
      st = await regularFile(file);
      if (!st) fail(`${what} が不正です / file became invalid: ${rel}`);
    }
    if ((st.mode & fs.constants.S_IXUSR) === 0) {
      fail(`${what} に実行権限がありません / cannot restore execute permission: ${rel}`);
    }
  }
  return file;
}

function parseManifest(text: string): RuntimeManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('manifest.json が読み取れません / manifest.json is not valid JSON');
  }
  const m = raw as Record<string, unknown>;
  if (!m || typeof m !== 'object' || m.schemaVersion !== 2)
    fail('manifest.json の schemaVersion が未対応です / unsupported manifest schemaVersion (expected 2)');
  for (const key of ['target', 'nodeVersion', 'playwrightVersion', 'node'] as const) {
    if (typeof m[key] !== 'string' || (m[key] as string).length === 0)
      fail(`manifest.json に ${key} がありません / manifest is missing ${key}`);
  }
  if (!/^v\d+\.\d+\.\d+$/.test(m.nodeVersion as string))
    fail(`manifest.json の nodeVersion が不正です / nodeVersion must be vMAJOR.MINOR.PATCH: ${m.nodeVersion}`);
  const nodeMajor = Number((m.nodeVersion as string).slice(1).split('.')[0]);
  if (nodeMajor < 24) fail(`manifest.json の Node バージョンが古いです / bundled Node must be >= 24: ${m.nodeVersion}`);
  if (m.browserMode !== 'auto') fail('browserMode は auto が必要です / browserMode must be auto');
  if (m.helper !== null && typeof m.helper !== 'string')
    fail('manifest.json の helper が不正です / manifest helper must be a string or null');
  return m as unknown as RuntimeManifest;
}

function parseIndex(text: string): UniversalManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail('index の manifest.json が読み取れません / universal manifest.json is not valid JSON');
  }
  const m = raw as Record<string, unknown>;
  if (!m || typeof m !== 'object' || Array.isArray(m))
    fail('index の manifest.json がオブジェクトではありません / universal manifest is not an object');
  const keys = Object.keys(m).sort();
  if (keys.length !== 2 || keys[0] !== 'schemaVersion' || keys[1] !== 'targets') {
    fail('index の manifest.json のキーが不正です / universal manifest must have exactly schemaVersion and targets');
  }
  if (m.schemaVersion !== 3)
    fail('index の schemaVersion が未対応です / unsupported universal manifest schemaVersion (expected 3)');
  const targets = m.targets;
  if (!Array.isArray(targets) || targets.length === 0)
    fail('index の targets が不正です / universal manifest targets must be a non-empty array');
  const seen = new Set<string>();
  for (const target of targets as unknown[]) {
    if (typeof target !== 'string' || target.length === 0)
      fail('index の targets に不正な値 / target names must be non-empty strings');
    if (seen.has(target)) fail(`index の targets に重複 / duplicate target in universal manifest: ${target}`);
    seen.add(target);
    if (!UNIVERSAL_TARGETS.includes(target))
      fail(`index の targets に未対応のターゲット / unknown target in universal manifest: ${target}`);
  }
  return { schemaVersion: 3, targets: targets as string[] };
}

async function readManifestFile(runtimeDir: string): Promise<string> {
  const manifestPath = path.join(runtimeDir, 'manifest.json');
  try {
    const st = await fs.promises.stat(manifestPath);
    if (!st.isFile()) fail('manifest.json がファイルではありません / manifest.json is not a file');
    await assertInsideRuntime(runtimeDir, manifestPath, 'manifest.json'); // manifest symlink must stay inside
    return await fs.promises.readFile(manifestPath, 'utf8');
  } catch (err) {
    if (err instanceof RuntimeError) throw err;
    fail(`manifest.json が読み取れません / cannot read ${manifestPath}`);
  }
}

async function loadManifest(runtimeDir: string): Promise<RuntimeManifest> {
  return parseManifest(await readManifestFile(runtimeDir));
}

// Applies the schema 2 contract (node/helper names, files, execute bits, realpath anchors) to one runtime directory.
async function validateChild(
  runtimeDir: string,
  manifest: RuntimeManifest,
  platform: NodeJS.Platform,
): Promise<ResolvedRuntime> {
  const isWin = platform === 'win32';
  const expectedNode = isWin ? 'node.exe' : 'node';
  if (manifest.node !== expectedNode)
    fail(`node フィールドが不一致 / node must be "${expectedNode}" on ${platform}: ${manifest.node}`);
  const expectedHelper = HELPERS[platform] ?? null;
  if (manifest.helper !== expectedHelper) {
    fail(
      `${platform} の helper は ${String(expectedHelper)} でなければなりません / helper must be ${String(expectedHelper)} on ${platform}: ${String(manifest.helper)}`,
    );
  }
  const restoreMode = !isWin && process.platform !== 'win32';
  const nodePath = await requireExecutable(runtimeDir, checkRelative(manifest.node, 'node'), 'node', restoreMode);
  let helperPath: string | null = null;
  if (manifest.helper !== null) {
    helperPath = await requireExecutable(runtimeDir, checkRelative(manifest.helper, 'helper'), 'helper', restoreMode);
  }
  const env: Record<string, string> = {
    PLAYWRIGHT_SKIP_BROWSER_GC: '1',
  };
  if (helperPath !== null) env.ADL_BUNDLED_HELPER_PATH = helperPath;
  return { runtimeDir, nodePath, helperPath, env, manifest };
}

// Universal index: the host child directory must be a real directory inside the root runtime
// (its own realpath anchor cannot see a child directory that is itself a symlink out).
async function validateUniversal(
  index: UniversalManifest,
  runtimeDir: string,
  platform: NodeJS.Platform,
  arch: string,
): Promise<ResolvedRuntime> {
  const expectedTarget = `${platform}-${arch}`;
  if (!index.targets.includes(expectedTarget)) {
    fail(
      `このホストは同梱されていません / host ${expectedTarget} is not bundled in this universal runtime (targets: ${index.targets.join(', ')})`,
    );
  }
  const childDir = path.join(runtimeDir, expectedTarget);
  let escaped = false;
  try {
    if (!(await fs.promises.lstat(childDir)).isDirectory())
      escaped =
        (await fs.promises.realpath(childDir)) !== (await fs.promises.realpath(runtimeDir)) &&
        !(await fs.promises.realpath(childDir)).startsWith((await fs.promises.realpath(runtimeDir)) + path.sep);
  } catch {
    /* missing or dangling link: reported below */
  }
  if (escaped) fail(`ターゲットディレクトリがランタイム外を指します / ${expectedTarget} escapes the runtime directory`);
  try {
    if (!(await fs.promises.lstat(childDir)).isDirectory())
      fail(`ターゲットディレクトリが不正です / ${expectedTarget} is not a directory`);
  } catch (err) {
    if (err instanceof RuntimeError) throw err;
    fail(`ターゲットディレクトリが見つかりません / missing runtime/${expectedTarget}`);
  }
  await assertInsideRuntime(runtimeDir, childDir, `runtime/${expectedTarget}`);
  const manifest = await loadManifest(childDir);
  if (manifest.target !== expectedTarget) {
    fail(
      `対象プラットフォーム不一致 / target mismatch: child manifest は ${manifest.target}、ディレクトリは ${expectedTarget}`,
    );
  }
  return validateChild(childDir, manifest, platform);
}

async function validate(options: ResolveOptions): Promise<ResolvedRuntime> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (!SUPPORTED_PLATFORMS.includes(platform) || !SUPPORTED_ARCHS.includes(arch)) {
    fail(`このプラットフォームには対応していません / unsupported host platform/arch: ${platform}-${arch}`);
  }
  const runtimeDir = path.join(options.extensionRoot, 'runtime');
  const text = await readManifestFile(runtimeDir);
  let schemaVersion: unknown;
  try {
    const raw = JSON.parse(text) as Record<string, unknown> | null;
    schemaVersion = raw && typeof raw === 'object' ? raw.schemaVersion : undefined;
  } catch {
    schemaVersion = undefined;
  }
  if (schemaVersion === 3) return validateUniversal(parseIndex(text), runtimeDir, platform, arch);
  const manifest = parseManifest(text);
  const expectedTarget = `${platform}-${arch}`;
  if (manifest.target !== expectedTarget) {
    fail(
      `対象プラットフォーム不一致 / target mismatch: manifest は ${manifest.target}、このマシンは ${expectedTarget}`,
    );
  }
  return validateChild(runtimeDir, manifest, platform);
}

// Coalesces concurrent resolutions per bundle; failures are removed so the next call retries.
const inFlight = new Map<string, Promise<ResolvedRuntime>>();

export function resolveRuntime(options: ResolveOptions): Promise<ResolvedRuntime> {
  const key = JSON.stringify([
    path.resolve(options.extensionRoot),
    options.platform ?? process.platform,
    options.arch ?? process.arch,
  ]);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const pending = validate(options).finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  });
  inFlight.set(key, pending);
  return pending;
}
