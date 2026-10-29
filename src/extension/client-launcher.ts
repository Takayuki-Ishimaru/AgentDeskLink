import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ManagedLaunchDescriptor {
  schemaVersion: 1;
  owner: string;
  generation: string;
  enabled: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

const MAX_DESCRIPTOR_BYTES = 256 * 1024;
const MAX_ARG_BYTES = 32 * 1024;
const MAX_ENV_VALUE_BYTES = 64 * 1024;
const DESCRIPTOR_KEYS = ['schemaVersion', 'owner', 'generation', 'enabled', 'command', 'args', 'env', 'cwd'] as const;

export function validateManagedDescriptor(value: unknown): ManagedLaunchDescriptor | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(DESCRIPTOR_KEYS as readonly string[]).includes(key)) return undefined;
  }
  if (obj.schemaVersion !== 1) return undefined;
  if (typeof obj.owner !== 'string' || obj.owner.length === 0 || obj.owner.length > 8192) return undefined;
  if (typeof obj.generation !== 'string' || obj.generation.length === 0 || obj.generation.length > 256)
    return undefined;
  if (typeof obj.enabled !== 'boolean') return undefined;
  if (typeof obj.command !== 'string' || !path.isAbsolute(obj.command)) return undefined;
  if (typeof obj.cwd !== 'string' || !path.isAbsolute(obj.cwd)) return undefined;
  if (!Array.isArray(obj.args) || obj.args.length > 256) return undefined;
  for (const arg of obj.args) {
    if (typeof arg !== 'string' || Buffer.byteLength(arg, 'utf8') > MAX_ARG_BYTES) return undefined;
  }
  if (obj.env === null || typeof obj.env !== 'object' || Array.isArray(obj.env)) return undefined;
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(obj.env as Record<string, unknown>)) {
    if (key.length === 0 || typeof val !== 'string') return undefined;
    if (Buffer.byteLength(val, 'utf8') > MAX_ENV_VALUE_BYTES) return undefined;
    env[key] = val;
  }
  return {
    schemaVersion: 1,
    owner: obj.owner,
    generation: obj.generation,
    enabled: obj.enabled,
    command: obj.command,
    args: [...obj.args] as string[],
    env,
    cwd: obj.cwd,
  };
}

function readRegularFile(file: string, maxBytes: number): Buffer | undefined {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return undefined;
  }
  if (st.isSymbolicLink() || !st.isFile()) return undefined;
  if (st.size > maxBytes) return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY);
    const buf = Buffer.alloc(maxBytes + 1);
    const got = fs.readSync(fd, buf, 0, maxBytes + 1, 0);
    if (got > maxBytes) return undefined;
    return buf.subarray(0, got);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function readManagedDescriptor(file: string): ManagedLaunchDescriptor | undefined {
  const buf = readRegularFile(file, MAX_DESCRIPTOR_BYTES);
  if (buf === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    return undefined;
  }
  return validateManagedDescriptor(parsed);
}

function assertNoSymlinkAncestors(target: string): void {
  let current = path.resolve(target);
  for (;;) {
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(current);
    } catch {
      // Missing leaf/parents do not exempt existing ancestors from checks.
    }
    if (st?.isSymbolicLink()) {
      throw new Error('managed launcher path component is a symlink');
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function mkdirPrivate(dir: string): void {
  assertNoSymlinkAncestors(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertNoSymlinkAncestors(dir);
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort on non-POSIX */
  }
}

function atomicWrite(file: string, data: string, mode: number): boolean {
  const dir = path.dirname(file);
  mkdirPrivate(dir);
  assertNoSymlinkAncestors(file);
  const leaf = (() => {
    try {
      return fs.lstatSync(file);
    } catch {
      return undefined;
    }
  })();
  if (leaf !== undefined && leaf.isSymbolicLink()) {
    throw new Error('managed launcher target is a symlink');
  }
  if (leaf !== undefined && leaf.isFile()) {
    try {
      if (fs.readFileSync(file).equals(Buffer.from(data, 'utf8'))) return false;
    } catch {
      /* rewrite below */
    }
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    mode,
  );
  try {
    fs.writeFileSync(fd, data, 'utf8');
    fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
  try {
    assertNoSymlinkAncestors(file);
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* renamed */
    }
  }
  return true;
}

export function writeManagedDescriptor(file: string, descriptor: ManagedLaunchDescriptor): void {
  const d = validateManagedDescriptor(descriptor);
  if (d === undefined) throw new Error('invalid managed launch descriptor');
  // Serialize only explicit descriptor fields; never any caller environment.
  const text = JSON.stringify({
    schemaVersion: 1,
    owner: d.owner,
    generation: d.generation,
    enabled: d.enabled,
    command: d.command,
    args: d.args,
    env: d.env,
    cwd: d.cwd,
  });
  if (Buffer.byteLength(text, 'utf8') > MAX_DESCRIPTOR_BYTES) throw new Error('managed launch descriptor is too large');
  atomicWrite(file, text, 0o600);
}

const LAUNCHER_SOURCE = `#!/usr/bin/env node
'use strict';
// AgentDeskLink managed MCP stdio launcher (generated; do not edit).
var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var MAX_BYTES = 256 * 1024;
var MAX_ARG_BYTES = 32 * 1024;
var MAX_ENV_VALUE_BYTES = 64 * 1024;
var KEYS = ['schemaVersion', 'owner', 'generation', 'enabled', 'command', 'args', 'env', 'cwd'];
var POLL_MS = 50;
var KILL_GRACE_MS = 500;

function fail(msg) {
  try { process.stderr.write('agentdesklink-launcher: ' + msg + '\\n'); } catch (e) { /* ignore */ }
}

function validate(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  var k;
  for (k in value) {
    if (Object.prototype.hasOwnProperty.call(value, k) && KEYS.indexOf(k) < 0) return null;
  }
  if (value.schemaVersion !== 1) return null;
  if (typeof value.owner !== 'string' || value.owner.length === 0 || value.owner.length > 8192) return null;
  if (typeof value.generation !== 'string' || value.generation.length === 0 || value.generation.length > 256) return null;
  if (typeof value.enabled !== 'boolean') return null;
  if (typeof value.command !== 'string' || !path.isAbsolute(value.command)) return null;
  if (typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd)) return null;
  if (!Array.isArray(value.args) || value.args.length > 256) return null;
  for (var i = 0; i < value.args.length; i++) {
    if (typeof value.args[i] !== 'string' || Buffer.byteLength(value.args[i], 'utf8') > MAX_ARG_BYTES) return null;
  }
  if (value.env === null || typeof value.env !== 'object' || Array.isArray(value.env)) return null;
  for (var key in value.env) {
    if (!Object.prototype.hasOwnProperty.call(value.env, key)) continue;
    if (key.length === 0 || typeof value.env[key] !== 'string') return null;
    if (Buffer.byteLength(value.env[key], 'utf8') > MAX_ENV_VALUE_BYTES) return null;
  }
  return value;
}

function readSnapshotText() {
  var st;
  try { st = fs.lstatSync(DESCRIPTOR_PATH); } catch (e) { return null; }
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_BYTES) return null;
  var fd;
  try {
    fd = fs.openSync(DESCRIPTOR_PATH, fs.constants.O_RDONLY);
    var buf = Buffer.alloc(MAX_BYTES + 1);
    var got = fs.readSync(fd, buf, 0, MAX_BYTES + 1, 0);
    if (got > MAX_BYTES) return null;
    return buf.toString('utf8', 0, got);
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e2) { /* ignore */ } }
  }
}

function buildEnv(descriptor) {
  var base = {};
  var inherited = process.env;
  var name;
  for (name in inherited) {
    if (!Object.prototype.hasOwnProperty.call(inherited, name)) continue;
    if (/^ADL_/i.test(name)) continue;
    if (name === 'PLAYWRIGHT_BROWSERS_PATH') continue;
    base[name] = inherited[name];
  }
  delete base.ADL_BROWSER_EXECUTABLE;
  delete base.ADL_BROWSER_EXECUTABLE_UP;
  var env = descriptor.env;
  for (name in env) {
    if (Object.prototype.hasOwnProperty.call(env, name)) base[name] = env[name];
  }
  return base;
}

var DESCRIPTOR_PATH = process.argv[2];
if (typeof DESCRIPTOR_PATH !== 'string' || DESCRIPTOR_PATH.length === 0) {
  fail('usage: launcher.cjs <descriptorPath>');
  process.exit(2);
}
if (!path.isAbsolute(DESCRIPTOR_PATH)) {
  DESCRIPTOR_PATH = path.resolve(DESCRIPTOR_PATH);
}

var initialText = readSnapshotText();
if (initialText === null) {
  fail('descriptor missing, oversized or not a regular file');
  process.exit(2);
}
var initial;
try { initial = validate(JSON.parse(initialText)); } catch (e) { initial = null; }
if (initial === null) {
  fail('descriptor malformed');
  process.exit(2);
}
if (initial.enabled !== true) {
  fail('descriptor disabled');
  process.exit(2);
}
var cwdOk = false;
try { cwdOk = fs.statSync(initial.cwd).isDirectory(); } catch (e) { cwdOk = false; }
if (!cwdOk) {
  fail('descriptor cwd does not exist');
  process.exit(2);
}

var child = null;
var pollTimer = null;
var killTimer = null;
var terminating = false;
var exited = false;

function stopPolling() {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
}

function killChild() {
  if (child === null || terminating || exited) return;
  terminating = true;
  try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
  killTimer = setTimeout(function () {
    killTimer = null;
    try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
  }, KILL_GRACE_MS);
}

function finish(code) {
  if (exited) return;
  exited = true;
  stopPolling();
  if (killTimer !== null) { clearTimeout(killTimer); killTimer = null; }
  process.exitCode = code;
}

try {
  child = cp.spawn(initial.command, initial.args, {
    cwd: initial.cwd,
    env: buildEnv(initial),
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    detached: false
  });
} catch (e) {
  fail('spawn failed');
  process.exit(1);
}

child.on('error', function () {
  fail('child error');
  finish(1);
});

child.on('exit', function (code, signal) {
  if (terminating) {
    finish(1);
  } else {
    finish(typeof code === 'number' ? code : 1);
  }
});

pollTimer = setInterval(function () {
  if (terminating || exited) return;
  var text = readSnapshotText();
  if (text === initialText) return;
  fail('launch revoked');
  killChild();
}, POLL_MS);

function onSignal() {
  if (exited) return;
  killChild();
}
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
`;

export function writeManagedLauncher(storageDir: string): { launcherPath: string; descriptorPath: string } {
  const dir = path.join(storageDir, 'ai-clients');
  const launcherPath = path.join(dir, 'launcher.cjs');
  const descriptorPath = path.join(dir, 'launch.json');
  atomicWrite(launcherPath, LAUNCHER_SOURCE, 0o600);
  return { launcherPath, descriptorPath };
}
