import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require0 = createRequire(import.meta.url);

import {
  DEFAULT_NODE_VERSION, SUPPORTED_TARGETS, assertNodeVersion, resolveTarget, assertNativeHost,
  nodeArchiveNames, parseShasums, findShasumEntry, sha256File, assertSafeRelativePath,
  fetchBounded, runCommand, acquireLock,
} from '../scripts/runtime-utils.mjs';
import { prepareRuntime } from '../scripts/prepare-runtime.mjs';

const PW_VERSION = '1.64.1';
const NODE_VERSION = 'v24.22.1';
// ---------- utility unit tests ----------

test('parseShasums accepts official text and binary line formats', () => {
  const text = [
    '9b644286718b04654eb5f434749e507297293926db3176e297f924d054cb47c7  node-v24.22.1-darwin-arm64.tar.gz',
    'aaaabbbbccccddddeeeeffff000011112222333344445555666677778888999e *node-v24.22.1-win-x64.zip',
    'garbage line',
  ].join('\n') + '\n';
  const entries = parseShasums(text);
  assert.equal(findShasumEntry(entries, 'node-v24.22.1-darwin-arm64.tar.gz'), '9b644286718b04654eb5f434749e507297293926db3176e297f924d054cb47c7');
  assert.equal(findShasumEntry(entries, 'node-v24.22.1-win-x64.zip'), 'aaaabbbbccccddddeeeeffff000011112222333344445555666677778888999e');
  assert.equal(findShasumEntry(entries, 'node-v24.22.1-linux-x64.tar.gz'), undefined);
});

test('parseShasums rejects duplicate conflicting checksums and accepts identical duplicates', () => {
  const name = 'node-v24.22.1-linux-x64.tar.gz';
  const h1 = 'a'.repeat(64);
  const h2 = 'b'.repeat(64);
  assert.throws(() => parseShasums(`${h1}  ${name}\n${h2}  ${name}\n`), /Conflicting/);
  assert.equal(findShasumEntry(parseShasums(`${h1}  ${name}\n${h1} *${name}\n`), name), h1);
});

test('findShasumEntry matches filenames exactly, not by substring', () => {
  const entries = parseShasums(`${'a'.repeat(64)}  node-${NODE_VERSION}-linux-x64.tar.xz\n`);
  assert.equal(findShasumEntry(entries, `node-${NODE_VERSION}-linux-x64.tar.gz`), undefined);
  assert.equal(findShasumEntry(entries, `node-${NODE_VERSION}-linux-x64.tar.xz`), 'a'.repeat(64));
});

test('nodeArchiveNames uses official naming including win (not win32) for Windows', () => {
  assert.deepEqual(nodeArchiveNames(NODE_VERSION, 'win32', 'x64'), { dir: `node-${NODE_VERSION}-win-x64`, file: `node-${NODE_VERSION}-win-x64.zip`, kind: 'zip' });
  assert.deepEqual(nodeArchiveNames(NODE_VERSION, 'win32', 'arm64'), { dir: `node-${NODE_VERSION}-win-arm64`, file: `node-${NODE_VERSION}-win-arm64.zip`, kind: 'zip' });
  assert.deepEqual(nodeArchiveNames(NODE_VERSION, 'darwin', 'arm64'), { dir: `node-${NODE_VERSION}-darwin-arm64`, file: `node-${NODE_VERSION}-darwin-arm64.tar.gz`, kind: 'tar.gz' });
  assert.deepEqual(nodeArchiveNames(NODE_VERSION, 'linux', 'x64'), { dir: `node-${NODE_VERSION}-linux-x64`, file: `node-${NODE_VERSION}-linux-x64.tar.gz`, kind: 'tar.gz' });
});

test('assertNodeVersion enforces strict v-semver >= 24', () => {
  assert.equal(assertNodeVersion(DEFAULT_NODE_VERSION), DEFAULT_NODE_VERSION);
  for (const bad of ['24.22.1', 'v23.6.1', 'v24', 'v24.22', 'latest', '', undefined, 'vx.y.z', 'v24.22.1-ext']) assert.throws(() => assertNodeVersion(bad), /Node version/);
});

test('resolveTarget and assertNativeHost reject unsupported and cross targets', () => {
  for (const t of SUPPORTED_TARGETS) assert.equal(resolveTarget(t).target, t);
  for (const bad of ['freebsd-x64', 'linux-ia32', 'darwin', '', null, 'linux-x64 ']) assert.throws(() => resolveTarget(bad), /Unsupported/);
  const host = { platform: 'linux', arch: 'x64' };
  assert.equal(assertNativeHost('linux-x64', host), 'linux-x64');
  assert.throws(() => assertNativeHost('darwin-arm64', host), /Cross-target/);
  assert.throws(() => assertNativeHost('win32-x64', host), /Cross-target/);
});

test('assertSafeRelativePath rejects absolute, traversal and empty paths', () => {
  assert.equal(assertSafeRelativePath('browsers/x/chrome'), 'browsers/x/chrome');
  assert.equal(assertSafeRelativePath('helper\\adl.exe'), 'helper/adl.exe');
  for (const bad of ['/etc/passwd', '../escape', 'a/../../b', 'C:\\Windows\\x.exe', '', '.', 'node/../../x']) assert.throws(() => assertSafeRelativePath(bad), /must/);
});

test('fetchBounded aborts a slow body read and honors a pre-aborted signal', async () => {
  const controller = new AbortController();
  const body = new ReadableStream({ pull() { return new Promise(() => {}); } });
  const fetchImpl = async () => new Response(body, { status: 200 });
  await assert.rejects(fetchBounded('https://x/y', { fetchImpl, signal: controller.signal, timeoutMs: 150 }), /timed out/);
  controller.abort(new Error('user cancel'));
  let called = 0;
  await assert.rejects(fetchBounded('https://x/y', { fetchImpl: () => { called++; return Promise.resolve(new Response('z')); }, signal: controller.signal, timeoutMs: 1000 }), /aborted/);
  assert.equal(called, 0, 'pre-aborted signal must not start downloads');
});

test('fetchBounded releases unread bodies after HTTP and consumer failures', async () => {
  for (const status of [500, 200]) {
    let cancelled=false, signal;
    const body=new ReadableStream({cancel(){cancelled=true;}});
    const fetchImpl=async(_url,options)=>{signal=options.signal;return new Response(body,{status});};
    await assert.rejects(fetchBounded('https://x/y',{fetchImpl},()=>{throw new Error('consumer failed');}),status===500 ? /HTTP 500/ : /consumer failed/);
    assert.equal(cancelled,true);
    assert.equal(signal.aborted,true);
  }
});

test('fetchBounded cancels a response that arrives after the deadline', async () => {
  let respond,cancelled=false;
  const response=new Response(new ReadableStream({cancel(){cancelled=true;}}));
  const fetchImpl=()=>new Promise(resolve=>respond=resolve);
  await assert.rejects(fetchBounded('https://x/y',{fetchImpl,timeoutMs:20}),/timed out/);
  respond(response);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cancelled,true);
});

test('runCommand fails on spawn error, non-zero exit, timeout and abort', async () => {
  await assert.rejects(runCommand(['definitely-not-a-real-binary-xyz']), /spawn failed/);
  await assert.rejects(runCommand([process.execPath, '-e', 'process.exit(3)']), /command failed/);
  const started = Date.now();
  await assert.rejects(runCommand([process.execPath, '-e', 'setInterval(()=>{},1000)'], { timeoutMs: 150 }), /timed out/);
  assert.ok(Date.now() - started >= 140, 'timeout must wait for the child to close before rejecting');
  const controller = new AbortController();
  const pending = runCommand([process.execPath, '-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 60);
  await assert.rejects(pending, /aborted/);
});

test('acquireLock is exclusive, bounded on contention, and never removes a live lock due to age alone', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'adl-lock-'));
  const lock = path.join(dir, 'runtime.lock');
  const release = await acquireLock(lock);
  await assert.rejects(acquireLock(lock, { timeoutMs: 200 }), /locked by another invocation/);
  const old = new Date(Date.now() - 60 * 60_000);
  await fsp.utimes(lock, old, old);
  await assert.rejects(acquireLock(lock, { timeoutMs: 200 }), /locked/);
  assert.ok(fs.existsSync(lock), 'live lock with old mtime must survive');
  await release();
  assert.ok(!fs.existsSync(lock));
  await fsp.writeFile(lock, '999999\n');
  await fsp.utimes(lock, old, old);
  await assert.rejects(acquireLock(lock, { timeoutMs: 100 }), /locked/);
  assert.ok(fs.existsSync(lock));
  await fsp.rm(dir, { recursive: true, force: true });
});


// Preparation uses a synthetic, checksummed archive; real binaries are tested from the VSIX.
async function fixture(t, target = 'linux-x64', settings = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'adl-runtime-build-'));
  t.after(() => fsp.rm(root, {recursive:true,force:true}));
  await fsp.writeFile(path.join(root,'package.json'), JSON.stringify({dependencies:{playwright:PW_VERSION}}));
  await fsp.writeFile(path.join(root,'package-lock.json'), JSON.stringify({packages:{'node_modules/playwright':{version:PW_VERSION}}}));
  await fsp.mkdir(path.join(root,'native/windows-uia-cpp/licenses'),{recursive:true});
  await fsp.writeFile(path.join(root,'native/windows-uia-cpp/licenses/nlohmann-json-LICENSE.MIT'),'MIT license');
  const info = resolveTarget(target);
  const archive = nodeArchiveNames(NODE_VERSION,info.platform,info.arch);
  const bytes = Buffer.from('Node archive fixture');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const requests=[], commands=[];
  const fetchImpl = async (url, options) => {
    requests.push(url);
    if (settings.slow) await new Promise((yes,no) => {
      const timer=setTimeout(yes,5000);
      options.signal.addEventListener('abort',()=>{clearTimeout(timer);no(options.signal.reason);},{once:true});
    });
    return new Response(url.endsWith('SHASUMS256.txt')
      ? `${settings.badHash ? 'a'.repeat(64) : digest}  ${settings.missingHash ? 'different-file' : archive.file}\n`
      : bytes);
  };
  const run = async (args, options) => {
    commands.push(args);
    assert.equal(options.cwd,root);
    if (settings.commandFailure) throw new Error('builder failed');
    if (args[0]==='tar') {
      const dest=path.join(args[args.indexOf('-C')+1],archive.dir);
      const node=path.join(dest,...(info.windows?['node.exe']:['bin','node']));
      await fsp.mkdir(path.dirname(node),{recursive:true});
      await fsp.writeFile(node,settings.emptyNode?'':'node binary');
      await fsp.writeFile(path.join(dest,'LICENSE'),'Node license');
    } else if (args[0]==='swiftc') {
      await fsp.writeFile(args[args.indexOf('-o')+1],settings.emptyHelper?'':'mac helper');
    } else if (args[0]==='cmake' && args[1]==='--build') {
      const dest=path.join(args[2],'Release');
      await fsp.mkdir(dest,{recursive:true});
      await fsp.writeFile(path.join(dest,'adl-windows-uia-helper.exe'),settings.emptyHelper?'':'windows helper');
      await fsp.writeFile(path.join(dest,'adl_protocol_tests.exe'),'must not ship');
    }
    return {stdout:'',stderr:''};
  };
  return {root,info,archive,requests,commands,options:{root,target,host:{platform:info.platform,arch:info.arch},fetchImpl,runCommand:run}};
}
const leftovers = root => fs.readdirSync(root).filter(name=>name.includes('.staging-')||name.includes('.previous-')||name.endsWith('.lock'));

for (const target of SUPPORTED_TARGETS) test(`lightweight ${target} bundle contains Node/helper and auto browser configuration`,async t=>{
  const f=await fixture(t,target);
  const {runtimeDir,manifest}=await prepareRuntime(f.options);
  assert.deepEqual(manifest,{
    schemaVersion:2,target,nodeVersion:NODE_VERSION,playwrightVersion:PW_VERSION,
    node:f.info.windows?'node.exe':'node',browserMode:'auto',
    helper:f.info.platform==='darwin'?'helper/adl-macos-ax-helper':f.info.windows?'helper/adl-windows-uia-helper.exe':null,
  });
  assert.equal(fs.readFileSync(path.join(runtimeDir,manifest.node),'utf8'),'node binary');
  assert.equal(fs.readFileSync(path.join(runtimeDir,'LICENSE'),'utf8'),'Node license');
  assert.ok(!fs.existsSync(path.join(runtimeDir,'browsers')));
  assert.deepEqual(fs.readdirSync(runtimeDir).sort(),['LICENSE',...(manifest.helper?['helper']:[]),'manifest.json',manifest.node].sort());
  assert.deepEqual(leftovers(f.root),[]);
  assert.ok(f.requests.includes(`https://nodejs.org/dist/${NODE_VERSION}/${f.archive.file}`));
  assert.ok(!f.commands.some(args=>args.includes('chromium')||args.includes('npm')));
  if (manifest.helper) assert.equal(fs.readFileSync(path.join(runtimeDir,manifest.helper),'utf8'),f.info.windows?'windows helper':'mac helper');
  if (f.info.windows) {
    const build=f.commands.find(args=>args[0]==='cmake'&&args[1]==='--build');
    assert.equal(build[build.indexOf('--target')+1],'adl-windows-uia-helper');
    const configure=f.commands.find(args=>args[0]==='cmake'&&args[1]==='-S');
    assert.equal(configure[configure.indexOf('-A')+1],f.info.arch==='arm64'?'ARM64':'x64');
    assert.ok(fs.existsSync(path.join(runtimeDir,'helper/nlohmann-json-LICENSE.MIT')));
  }
  if (f.info.platform==='darwin') {
    const swift=f.commands.find(args=>args[0]==='swiftc');
    assert.equal(swift[swift.indexOf('-target')+1],f.info.arch==='arm64'?'arm64-apple-macos14.0':'x86_64-apple-macos14.0');
    assert.equal(swift.filter(arg=>arg.endsWith('.swift')).length,5);
    assert.ok(f.commands.some(args=>args[0]==='codesign'));
  }
});

test('bad or missing exact checksum prevents extraction and preserves the previous bundle',async t=>{
  for (const settings of [{badHash:true},{missingHash:true}]) {
    const f=await fixture(t,'linux-x64',settings);
    await fsp.mkdir(path.join(f.root,'runtime'));
    await fsp.writeFile(path.join(f.root,'runtime/sentinel'),'old');
    await assert.rejects(prepareRuntime(f.options),/SHA256|No SHASUMS/);
    assert.equal(f.commands.length,0);
    assert.equal(fs.readFileSync(path.join(f.root,'runtime/sentinel'),'utf8'),'old');
    assert.deepEqual(leftovers(f.root),[]);
  }
});

test('missing components or failed compiler never publish incomplete runtime',async t=>{
  for (const [target,settings] of [['linux-x64',{emptyNode:true}],['darwin-arm64',{emptyHelper:true}],['win32-x64',{emptyHelper:true}],['linux-x64',{commandFailure:true}]]) {
    const f=await fixture(t,target,settings);
    await assert.rejects(prepareRuntime(f.options),/missing or empty|builder failed/);
    assert.ok(!fs.existsSync(path.join(f.root,'runtime')));
    assert.deepEqual(leftovers(f.root),[]);
  }
});

test('pre-abort, in-flight cancellation and deadline clean up only their staging directory',async t=>{
  const f=await fixture(t,'linux-x64',{slow:true});
  const pre=new AbortController();pre.abort();
  await assert.rejects(prepareRuntime({...f.options,signal:pre.signal}),/aborted/);
  assert.equal(f.requests.length,0);
  const abort=new AbortController();
  const pending=prepareRuntime({...f.options,signal:abort.signal});
  setTimeout(()=>abort.abort(new Error('cancelled')),40);
  await assert.rejects(pending,/cancelled/);
  await assert.rejects(prepareRuntime({...f.options,downloadTimeoutMs:30}),/timed out/);
  assert.deepEqual(leftovers(f.root),[]);
});

test('parallel invocations serialize and release the lock after publishing',async t=>{
  const f=await fixture(t);
  const [a,b]=await Promise.all([prepareRuntime(f.options),prepareRuntime(f.options)]);
  assert.equal(a.runtimeDir,b.runtimeDir);
  assert.deepEqual(leftovers(f.root),[]);
  const unlock=await acquireLock(path.join(f.root,'runtime.lock'));
  try {await assert.rejects(prepareRuntime({...f.options,lockTimeoutMs:20}),/locked/);} finally {await unlock();}
});

test('runtime destination cannot replace sources or escape the project',async t=>{
  const f=await fixture(t);
  for (const dest of ['src','../outside',f.root]) await assert.rejects(prepareRuntime({...f.options,runtimeDir:dest}),/inside the project root/);
  assert.equal(f.requests.length,0);
});
