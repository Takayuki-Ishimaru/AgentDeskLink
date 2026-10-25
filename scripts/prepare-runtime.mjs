#!/usr/bin/env node
// VSIX runtime preparation: pinned Node and the native helper.
// The extension reuses Chrome or prepares the locked Chromium on first use.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_NODE_VERSION, SUPPORTED_TARGETS, assertNodeVersion, resolveTarget, assertNativeHost,
  nodeArchiveNames, parseShasums, findShasumEntry, sha256File, assertSafeRelativePath,
  fetchBounded, downloadFile, runCommand, acquireLock, requireNonEmptyFile, pathStat,
} from './runtime-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');
const DIST_BASE_URL = 'https://nodejs.org/dist';

function readLockedPlaywrightVersion(root) {
  let version;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (typeof pkg.dependencies?.playwright === 'string') version = pkg.dependencies.playwright;
  } catch { /* fall through to lockfile */ }
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    version = lock.packages?.['node_modules/playwright']?.version;
  }
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Cannot determine locked playwright version under ${root}`);
  return version;
}

async function installNode({ info, nodeVersion, stagingDir, options }) {
  const archive = nodeArchiveNames(nodeVersion, info.platform, info.arch);
  const shasumsUrl = `${options.distBaseUrl}/${nodeVersion}/SHASUMS256.txt`;
  const shasumsText = await fetchBounded(shasumsUrl, {
    fetchImpl: options.fetchImpl, signal: options.signal, timeoutMs: options.downloadTimeoutMs ?? 120_000,
  });
  const expected = findShasumEntry(parseShasums(shasumsText), archive.file);
  if (!expected) throw new Error(`No SHASUMS256.txt entry exactly matching ${archive.file} in ${shasumsUrl}`);
  const archivePath = path.join(stagingDir, `_download-${archive.file}`);
  try {
    await downloadFile(`${options.distBaseUrl}/${nodeVersion}/${archive.file}`, archivePath, {
      fetchImpl: options.fetchImpl, signal: options.signal, timeoutMs: options.downloadTimeoutMs ?? 300_000,
    });
    const actual = await sha256File(archivePath);
    if (actual !== expected) throw new Error(`SHA256 mismatch for ${archive.file}: expected ${expected}, got ${actual}`);
    const extractDir = path.join(stagingDir, '_extract');
    await fsp.mkdir(extractDir, { recursive: true });
    try {
      await options.runCommand(['tar', '-xf', archivePath, '-C', extractDir], { cwd: options.root, signal: options.signal });
      const nodeRoot = path.join(extractDir, archive.dir);
      const nodeBinary = info.windows ? path.join(nodeRoot, 'node.exe') : path.join(nodeRoot, 'bin', 'node');
      await requireNonEmptyFile(nodeBinary, 'Bundled Node executable inside archive');
      const license = path.join(nodeRoot, 'LICENSE');
      await requireNonEmptyFile(license, 'Node LICENSE inside archive');
      // The bundle layout is runtime/node (or runtime/node.exe) plus runtime/LICENSE: the
      // executable is a FILE at the staging root, never a nested node/node directory.
      const nodeDest = path.join(stagingDir, info.windows ? 'node.exe' : 'node');
      await fsp.copyFile(nodeBinary, nodeDest);
      await fsp.copyFile(license, path.join(stagingDir, 'LICENSE'));
      if (!info.windows) await fsp.chmod(nodeDest, 0o755);
    } finally {
      await fsp.rm(extractDir, { recursive: true, force: true });
    }
  } finally {
    await fsp.rm(archivePath, { recursive: true, force: true });
  }
  return info.windows ? 'node.exe' : 'node';
}

async function installMacHelper({ info, stagingDir, options }) {
  const srcDir = path.join(options.root, 'native', 'macos-ax', 'src');
  const sources = ['Contract.swift', 'Capture.swift', 'Interactive.swift', 'Lifecycle.swift', 'main.swift'];
  const dest = path.join(stagingDir, 'helper', 'adl-macos-ax-helper');
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const swiftTarget = info.arch === 'arm64' ? 'arm64-apple-macos14.0' : 'x86_64-apple-macos14.0';
  await options.runCommand(['swiftc', '-swift-version', '5', '-target', swiftTarget, '-O', ...sources.map(name => path.join(srcDir, name)), '-o', dest], { cwd: options.root, signal: options.signal });
  await requireNonEmptyFile(dest, 'macOS helper binary');
  await fsp.chmod(dest, 0o755);
  await options.runCommand(['codesign', '--force', '--sign', '-', dest], { cwd: options.root, signal: options.signal });
  return 'helper/adl-macos-ax-helper';
}

async function installWindowsHelper({ info, stagingDir, options }) {
  const projectDir = path.join(options.root, 'native', 'windows-uia-cpp');
  const buildDir = path.join(stagingDir, '_cmake-build');
  try {
    await options.runCommand(['cmake', '-S', projectDir, '-B', buildDir, '-G', 'Visual Studio 17 2022', '-A', info.arch === 'arm64' ? 'ARM64' : 'x64'], { cwd: options.root, signal: options.signal });
    await options.runCommand(['cmake', '--build', buildDir, '--config', 'Release', '--target', 'adl-windows-uia-helper', '--parallel'], { cwd: options.root, signal: options.signal });
    // Exact target output only: the project also builds test executables we must never ship.
    const built = path.join(buildDir, 'Release', 'adl-windows-uia-helper.exe');
    await requireNonEmptyFile(built, 'Windows helper build output');
    const dest = path.join(stagingDir, 'helper', 'adl-windows-uia-helper.exe');
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(built, dest);
    const license = path.join(projectDir, 'licenses', 'nlohmann-json-LICENSE.MIT');
    await requireNonEmptyFile(license, 'nlohmann-json license');
    await fsp.copyFile(license, path.join(stagingDir, 'helper', 'nlohmann-json-LICENSE.MIT'));
  } finally {
    await fsp.rm(buildDir, { recursive: true, force: true });
  }
  return 'helper/adl-windows-uia-helper.exe';
}

async function validateStaging({ stagingDir, manifest, windows }) {
  const required = [manifest.node, 'LICENSE'];
  if (manifest.helper) required.push(manifest.helper);
  for (const rel of required) {
    assertSafeRelativePath(rel, 'manifest component');
    await requireNonEmptyFile(path.join(stagingDir, rel), `Runtime component ${rel}`);
  }
  if (!windows) {
    await fsp.chmod(path.join(stagingDir, manifest.node), 0o755);
    if (manifest.helper) await fsp.chmod(path.join(stagingDir, manifest.helper), 0o755);
  }
}

export async function prepareRuntime(options = {}) {
  const root = path.resolve(options.root ?? options.projectRoot ?? DEFAULT_ROOT);
  const opts = {
    ...options,
    root,
    target: options.target ?? `${process.platform}-${process.arch}`,
    nodeVersion: options.nodeVersion ?? DEFAULT_NODE_VERSION,
    distBaseUrl: options.distBaseUrl ?? DIST_BASE_URL,
    runCommand: options.runCommand ?? runCommand,
  };
  const info = resolveTarget(opts.target);
  assertNativeHost(info.target, opts.host);
  assertNodeVersion(opts.nodeVersion);
  if (opts.signal?.aborted) throw new Error('aborted before runtime preparation');
  opts.playwrightVersion = opts.playwrightVersion ?? readLockedPlaywrightVersion(root);
  const runtimeDir = path.resolve(root, opts.runtimeDir ?? 'runtime');
  const relToRoot = path.relative(root, runtimeDir);
  if (!relToRoot || relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) throw new Error(`runtimeDir must be a directory inside the project root, refusing ${runtimeDir}`);
  if (runtimeDir !== path.join(root, 'runtime')) throw new Error('runtimeDir must be the reserved runtime directory inside the project root');
  const lockFile = opts.lockFile ?? `${runtimeDir}.lock`;
  const release = await acquireLock(lockFile, { timeoutMs: opts.lockTimeoutMs ?? 30_000, signal:opts.signal });
  // Staging is always a freshly created mkdtemp sibling: never a user-selected preexisting path.
  let stagingDir;
  let published = false;
  try {
    stagingDir = await fsp.mkdtemp(path.join(path.dirname(runtimeDir), `${path.basename(runtimeDir)}.staging-`));
    const nodeEntry = await installNode({ info, nodeVersion: opts.nodeVersion, stagingDir, options: opts });
    const helper = info.platform === 'darwin' ? await installMacHelper({ info, stagingDir, options: opts })
      : info.platform === 'win32' ? await installWindowsHelper({ info, stagingDir, options: opts }) : null;
    const manifest = {
      schemaVersion: 2,
      target: info.target,
      nodeVersion: opts.nodeVersion,
      playwrightVersion: opts.playwrightVersion,
      node: nodeEntry,
      browserMode: 'auto',
      helper,
    };
    await validateStaging({ stagingDir, manifest, windows: info.windows });
    await fsp.writeFile(path.join(stagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    // Atomic publish: swap the complete staged dir in; on any failure the previous runtime is restored.
    const backupDir = `${runtimeDir}.previous-${process.pid}-${Date.now()}`;
    if (await pathStat(runtimeDir)) await fsp.rename(runtimeDir, backupDir);
    try {
      await fsp.rename(stagingDir, runtimeDir);
      published = true;
    } catch (error) {
      if (!(await pathStat(runtimeDir)) && await pathStat(backupDir)) await fsp.rename(backupDir, runtimeDir);
      throw error;
    }
    if (await pathStat(backupDir)) await fsp.rm(backupDir, { recursive: true, force: true });
    return { runtimeDir, manifest };
  } finally {
    if (!published && stagingDir) await fsp.rm(stagingDir, { recursive: true, force: true });
    await release();
  }
}

function parseArgs(argv) {
  const args = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--node-version') args.nodeVersion = argv[++i];
    else if (arg.startsWith('--node-version=')) args.nodeVersion = arg.slice('--node-version='.length);
    else if (arg === '--target') args.target = argv[++i];
    else if (arg.startsWith('--target=')) args.target = arg.slice('--target='.length);
    else if (arg === '--runtime-dir') args.runtimeDir = argv[++i];
    else if (arg.startsWith('--runtime-dir=')) args.runtimeDir = arg.slice('--runtime-dir='.length);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node scripts/prepare-runtime.mjs [--node-version v24.22.1] [--target ${SUPPORTED_TARGETS.join('|')}] [--runtime-dir DIR]\nDownloads run at build time only; the target must match this host.`);
    return;
  }
  const result = await prepareRuntime(args);
  console.log(`runtime prepared: ${result.runtimeDir} (${result.manifest.target}, ${result.manifest.nodeVersion}, playwright ${result.manifest.playwrightVersion})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message ?? error); process.exitCode = 1; });
}
