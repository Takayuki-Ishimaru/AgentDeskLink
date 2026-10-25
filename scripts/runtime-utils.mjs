import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const DEFAULT_NODE_VERSION = 'v24.22.1';
export const SUPPORTED_TARGETS = Object.freeze(['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64']);

export function assertNodeVersion(version) {
  if (typeof version !== 'string' || !/^v\d+\.\d+\.\d+$/.test(version)) throw new Error(`Node version must be strict v-prefixed semver: ${version}`);
  const major = Number(version.slice(1).split('.')[0]);
  if (major < 24) throw new Error(`Node version must be >= 24: ${version}`);
  return version;
}

export function resolveTarget(target) {
  if (typeof target !== 'string' || !SUPPORTED_TARGETS.includes(target)) throw new Error(`Unsupported VSIX runtime target: ${target}`);
  const [platform, arch] = target.split('-');
  return { target, platform, arch, windows: platform === 'win32' };
}

export function assertNativeHost(target, host = { platform: process.platform, arch: process.arch }) {
  if (target !== `${host.platform}-${host.arch}`) throw new Error(`Cross-target runtime preparation is not allowed: target ${target}, host ${host.platform}-${host.arch}`);
  return target;
}

// Official nodejs.org naming: Windows archives use "win", not the Node platform id "win32".
export function nodeArchiveNames(version, platform, arch) {
  const osName = platform === 'win32' ? 'win' : platform;
  const base = `node-${version}-${osName}-${arch}`;
  return platform === 'win32' ? { dir: base, file: `${base}.zip`, kind: 'zip' } : { dir: base, file: `${base}.tar.gz`, kind: 'tar.gz' };
}

// SHASUMS256.txt lines are "<64hex>  <name>" (text mode) or "<64hex> *<name>" (binary mode).
export function parseShasums(text) {
  const entries = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/.exec(line.trimEnd());
    if (!match) continue;
    const name = match[2].trim();
    const hash = match[1].toLowerCase();
    const previous = entries.get(name);
    if (previous !== undefined && previous !== hash) throw new Error(`Conflicting SHASUMS256 entries for ${name}`);
    entries.set(name, hash);
  }
  return entries;
}

export function findShasumEntry(entries, fileName) {
  for (const [name, hash] of entries) if (name === fileName) return hash;
  return undefined;
}

export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

export function assertSafeRelativePath(rel, label = 'path') {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error(`${label} must be a non-empty relative path`);
  const normalized = rel.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || path.isAbsolute(normalized)) throw new Error(`${label} must be relative: ${rel}`);
  if (normalized.includes('\0') || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`${label} must not contain empty, dot or traversal segments: ${rel}`);
  return normalized;
}

// Bounds fetch AND body consumption with one timeout; honors an external abort signal.
export async function fetchBounded(url, { fetchImpl, signal, timeoutMs = 120_000 } = {}, consume = response => response.text()) {
  if (signal?.aborted) throw new Error(`aborted before download: ${url}`);
  const controller = new AbortController();
  let response;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = reason => {
    controller.abort(reason);
    void response?.body?.cancel().catch(() => {});
    rejectAbort(reason);
  };
  const onAbort = () => abort(signal.reason ?? new Error(`aborted: ${url}`));
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => abort(new Error(`download timed out after ${timeoutMs}ms: ${url}`)), timeoutMs);
  try {
    const work = async () => {
      response = await (fetchImpl ?? fetch)(url, { signal: controller.signal, redirect: 'follow' });
      controller.signal.throwIfAborted();
      if (!response.ok) throw new Error(`download failed HTTP ${response.status}: ${url}`);
      return consume(response);
    };
    return await Promise.race([work(), aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function downloadFile(url, dest, options = {}) {
  const bytes = await fetchBounded(url, options, async response => Buffer.from(await response.arrayBuffer()));
  await fsp.writeFile(dest, bytes);
  return bytes.length;
}

// argv-based spawn (never a shell string). On timeout/abort kills the child and settles only after close.
export async function runCommand(argv, { cwd, env, timeoutMs = 600_000, signal } = {}) {
  signal?.throwIfAborted();
  const [command, ...args] = argv;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killReason;
    const timer = setTimeout(() => { killReason = `command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`; child.kill('SIGKILL'); }, timeoutMs);
    const onAbort = () => { killReason = `command aborted: ${command} ${args.join(' ')}`; child.kill('SIGKILL'); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      reject(new Error(`command spawn failed: ${command}: ${error.message}`));
    });
    child.on('close', (code, sig) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (killReason) reject(new Error(killReason));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`command failed (${code ?? sig}): ${command} ${args.join(' ')}\n${stderr.slice(0, 2000)}`));
    });
  });
}

// Never steal a lock: a paused owner may still be publishing a complete bundle.
export async function acquireLock(lockFile, { timeoutMs = 30_000, retryMs = 50, signal } = {}) {
  await fsp.mkdir(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    try {
      const handle = await fsp.open(lockFile, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      let released = false;
      return async () => { if (released) return; released = true; await fsp.rm(lockFile, { force: true }); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`runtime preparation is locked by another invocation: ${lockFile}`);
      await new Promise(resolve => setTimeout(resolve, retryMs));
    }
  }
}

export async function pathStat(target) {
  try { return await fsp.stat(target); } catch { return undefined; }
}

export async function requireNonEmptyFile(target, label) {
  const stat = await pathStat(target);
  if (!stat || !stat.isFile() || stat.size === 0) throw new Error(`${label} is missing or empty: ${target}`);
  return stat;
}
