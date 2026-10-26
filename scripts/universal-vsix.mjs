#!/usr/bin/env node
// Universal VSIX assembly: merges the three schema-2 platform VSIX archives
// (darwin-arm64, win32-x64, linux-x64) into one schema-3 multi-target VSIX.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { PassThrough, Transform, addAbortSignal } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { assertNodeVersion, acquireLock } from './runtime-utils.mjs';

const vsceRequire = createRequire(createRequire(import.meta.url).resolve('@vscode/vsce'));
const yauzl = vsceRequire('yauzl');
const { ZipFile } = vsceRequire('yazl');

export const UNIVERSAL_TARGETS = Object.freeze(['darwin-arm64', 'win32-x64', 'linux-x64']);
const PRODUCT_NAME = 'agentdesklink';
const PRODUCT_PUBLISHER = 'agentdesklink';
const CONTENT_TYPES = '[Content_Types].xml';
const VSIX_MANIFEST = 'extension.vsixmanifest';
const RUNTIME_PREFIX = 'extension/runtime/';
const RUNTIME_INDEX = `${RUNTIME_PREFIX}manifest.json`;
const PACKAGE_JSON = 'extension/package.json';
const SHARP_PREFIX = 'extension/node_modules/@img/sharp-';
const MAX_SPECIAL_BYTES = 8 * 1024 * 1024;

function fail(message) { throw new Error(message); }
function throwIfAborted(signal, stage) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(`aborted during ${stage}`);
}

function assertSafeZipName(name, label) {
  if (typeof name !== 'string' || name.length === 0) fail(`${label}: entry name must be a non-empty string`);
  if (name.includes('\\')) fail(`${label}: unsafe ZIP path (backslash): ${name}`);
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) fail(`${label}: unsafe ZIP path (absolute): ${name}`);
  if (name.includes('\0')) fail(`${label}: unsafe ZIP path (NUL): ${name}`);
  if (name.split('/').some(part => part === '' || part === '.' || part === '..')) fail(`${label}: unsafe ZIP path segments: ${name}`);
  return name;
}

function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, {
    lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false,
  }, (err, zip) => err ? reject(err) : resolve(zip)));
}

async function withEntryStream(zip, entry) {
  const source = await new Promise((resolve, reject) => zip.openReadStream(entry, (err, stream) => err ? reject(err) : resolve(stream)));
  // yauzl 2 uses legacy fd-slicer streams whose destroy() does not emit close.
  // Keep modern pipeline/AbortSignal teardown on a native stream boundary.
  const stream = new PassThrough();
  source.on('error', error => stream.destroy(error));
  stream.once('close', () => {
    source.unpipe(stream);
    if (!source.destroyed && !source.readableEnded) source.destroy();
  });
  source.pipe(stream);
  return stream;
}

async function readEntryBuffer(zip, entry, limit, label, signal) {
  if (entry.uncompressedSize > limit) fail(`${label}: metadata entry too large`);
  const stream = await withEntryStream(zip, entry);
  if (signal) addAbortSignal(signal, stream);
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) fail(`${label}: entry ${entry.fileName} exceeds ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function hashEntry(zip, entry, signal) {
  const stream = await withEntryStream(zip, entry);
  if (signal) addAbortSignal(signal, stream);
  const hash = crypto.createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function parseIdentity(xml, label) {
  const tag = /<Identity\b[^>]*>/i.exec(xml)?.[0];
  if (!tag) fail(`${label}: extension.vsixmanifest has no Identity element`);
  const attr = name => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1];
  return { id: attr('Id'), version: attr('Version'), publisher: attr('Publisher'), targetPlatform: attr('TargetPlatform') };
}

function parseContentTypes(xml, label) {
  if (!/<Types\b[^>]*schemas\.openxmlformats\.org\/package\/2006\/content-types/i.test(xml)) fail(`${label}: unsupported [Content_Types].xml root element`);
  const defaults = new Map();
  for (const m of xml.matchAll(/<Default\b[^>]*\/>/gi)) {
    const ext = /\bExtension\s*=\s*"([^"]*)"/i.exec(m[0])?.[1];
    const type = /\bContentType\s*=\s*"([^"]*)"/i.exec(m[0])?.[1];
    if (ext === undefined || type === undefined) fail(`${label}: [Content_Types].xml Default missing Extension/ContentType`);
    const key = ext.toLowerCase();
    if (defaults.has(key) && defaults.get(key).type !== type) fail(`${label}: conflicting content type defaults for ${ext}`);
    defaults.set(key, { ext, type });
  }
  const overrides = new Map();
  for (const m of xml.matchAll(/<Override\b[^>]*\/>/gi)) {
    const part = /\bPartName\s*=\s*"([^"]*)"/i.exec(m[0])?.[1];
    const type = /\bContentType\s*=\s*"([^"]*)"/i.exec(m[0])?.[1];
    if (part === undefined || type === undefined) fail(`${label}: [Content_Types].xml Override missing PartName/ContentType`);
    const key = part.toLowerCase();
    if (overrides.has(key) && overrides.get(key).type !== type) fail(`${label}: conflicting content type overrides for ${part}`);
    overrides.set(key, { part, type });
  }
  return { defaults, overrides };
}

function mergeContentTypes(scans) {
  const defaults = new Map();
  const overrides = new Map();
  for (const scan of scans) {
    for (const [key, value] of scan.contentTypes.defaults) {
      if (defaults.has(key) && defaults.get(key).type !== value.type) fail(`content type default conflict for ${value.ext}`);
      defaults.set(key, value);
    }
    for (const [key, value] of scan.contentTypes.overrides) {
      if (overrides.has(key) && overrides.get(key).type !== value.type) fail(`content type override conflict for ${value.part}`);
      overrides.set(key, value);
    }
  }
  const root = /<Types\b[^>]*>/i.exec(scans[0].contentTypesXml)?.[0];
  const parts = ['<?xml version="1.0" encoding="utf-8"?>', root];
  for (const value of [...defaults.values()].sort((a, b) => a.ext.localeCompare(b.ext))) parts.push(`<Default Extension="${value.ext}" ContentType="${value.type}"/>`);
  for (const value of [...overrides.values()].sort((a, b) => a.part.localeCompare(b.part))) parts.push(`<Override PartName="${value.part}" ContentType="${value.type}"/>`);
  parts.push('</Types>');
  return Buffer.from(parts.join(''), 'utf8');
}

function universalVsixManifest(xml) {
  const stripped = xml.replace(/(<Identity\b[^>]*?)\s+TargetPlatform\s*=\s*"[^"]*"/i, '$1');
  if (/<Identity\b[^>]*TargetPlatform/i.test(stripped)) fail('could not remove TargetPlatform from extension.vsixmanifest');
  return Buffer.from(stripped, 'utf8');
}

const MAX_COMPONENT_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

async function scanComponent(file, version, signal) {
  const zip = await openZip(file);
  const entries = [], digests = new Map(), special = {}, seen = new Set();
  let total = 0, cancelScan;
  try {
    throwIfAborted(signal, 'component scan');
    await new Promise((resolve, reject) => {
      cancelScan = () => reject(signal.reason instanceof Error ? signal.reason : new Error('component scan aborted'));
      signal?.addEventListener('abort', cancelScan, { once: true });
      if (signal?.aborted) { cancelScan(); return; }
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', async entry => {
        try {
          throwIfAborted(signal, 'component scan');
          const directory = entry.fileName.endsWith('/');
          const name = assertSafeZipName(directory ? entry.fileName.slice(0, -1) : entry.fileName, file);
          const key = name.toLowerCase();
          if (seen.has(key)) fail(`${file}: duplicate or case-colliding ZIP entry ${name}`);
          seen.add(key);
          const mode = (entry.externalFileAttributes >>> 16) & 0o177777;
          const kind = mode & 0o170000;
          if (kind === 0o120000) fail(`${file}: archive symlinks are not allowed: ${name}`);
          if (kind && kind !== (directory ? 0o040000 : 0o100000)) fail(`${file}: unsupported ZIP entry type: ${name}`);
          if (directory) { zip.readEntry(); return; }
          total += entry.uncompressedSize;
          if (entry.uncompressedSize > MAX_ENTRY_BYTES || total > MAX_COMPONENT_BYTES || entries.length >= 20000) fail(`${file}: component size budget exceeded`);
          entries.push({ name, mode, size: entry.uncompressedSize, zipEntry: entry });
          if ([RUNTIME_INDEX, VSIX_MANIFEST, PACKAGE_JSON, CONTENT_TYPES].includes(name)) {
            const bytes = await readEntryBuffer(zip, entry, MAX_SPECIAL_BYTES, file, signal);
            special[name] = bytes.toString('utf8');
            digests.set(name, crypto.createHash('sha256').update(bytes).digest('hex'));
          } else digests.set(name, await hashEntry(zip, entry, signal));
          zip.readEntry();
        } catch (error) { reject(error); }
      });
      zip.readEntry();
    });
    for (const name of [RUNTIME_INDEX, VSIX_MANIFEST, PACKAGE_JSON, CONTENT_TYPES]) if (!(name in special)) fail(`${file}: missing ${name}`);
    let manifest, product;
    try { manifest = JSON.parse(special[RUNTIME_INDEX]); product = JSON.parse(special[PACKAGE_JSON]); }
    catch { fail(`${file}: invalid JSON metadata`); }
    if (!manifest || typeof manifest !== 'object' || manifest.schemaVersion !== 2) fail(`${file}: unsupported runtime manifest schema`);
    const target = manifest.target;
    if (!UNIVERSAL_TARGETS.includes(target)) fail(`${file}: unsupported universal target ${target}`);
    const node = target.startsWith('win32') ? 'node.exe' : 'node';
    const helper = target.startsWith('darwin') ? 'helper/adl-macos-ax-helper' : target.startsWith('win32') ? 'helper/adl-windows-uia-helper.exe' : null;
    if (manifest.node !== node || manifest.helper !== helper || manifest.browserMode !== 'auto') fail(`${file}: runtime layout mismatch for ${target}`);
    assertNodeVersion(manifest.nodeVersion);
    if (!/^\d+\.\d+\.\d+$/.test(manifest.playwrightVersion ?? '')) fail(`${file}: invalid playwright version`);
    const identity = parseIdentity(special[VSIX_MANIFEST], file);
    if (identity.id !== PRODUCT_NAME || identity.publisher !== PRODUCT_PUBLISHER || identity.targetPlatform !== target) fail(`${file}: VSIX identity/target mismatch`);
    if (identity.version !== version || product?.version !== version) fail(`${file}: product version mismatch`);
    if (product?.name !== PRODUCT_NAME || product.publisher !== PRODUCT_PUBLISHER) fail(`${file}: product identity mismatch`);
    if (product.dependencies?.playwright !== undefined && product.dependencies.playwright !== manifest.playwrightVersion) fail(`${file}: locked playwright version mismatch`);
    for (const rel of [node, ...(helper ? [helper] : [])]) {
      if (!entries.some(e => e.name === RUNTIME_PREFIX + rel && e.size > 0)) fail(`${file}: missing or empty runtime component ${rel}`);
    }
    if (!entries.some(e => e.name.startsWith(`${SHARP_PREFIX}${target}/`) && e.name.endsWith('.node') && e.size > 0)) fail(`${file}: missing native sharp package for ${target}`);
    return { file, zip, target, manifest, entries, digests, special, contentTypes: parseContentTypes(special[CONTENT_TYPES], file), contentTypesXml: special[CONTENT_TYPES] };
  } catch (error) { zip.close(); throw error; }
  finally { if (cancelScan) signal?.removeEventListener('abort', cancelScan); }
}

export async function assembleUniversalVsix({ components, output, version, signal } = {}) {
  if (!Array.isArray(components) || components.length !== UNIVERSAL_TARGETS.length || components.some(p => typeof p !== 'string' || !p)) fail('exactly three component VSIX paths are required');
  if (typeof output !== 'string' || !path.isAbsolute(output)) fail('output must be an absolute file path');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? '')) fail('version must be strict SemVer');
  throwIfAborted(signal, 'assembly');
  await fsp.mkdir(path.dirname(output), { recursive: true });
  const release = await acquireLock(output + '.lock', { timeoutMs: 30000, signal });
  const scans = [], bridges = new Set();
  let stagingDir, writing, zipOut;
  try {
    for (const file of components) scans.push(await scanComponent(file, version, signal));
    const byTarget = new Map();
    for (const scan of scans) {
      if (byTarget.has(scan.target)) fail(`duplicate component target ${scan.target}`);
      byTarget.set(scan.target, scan);
    }
    if (!UNIVERSAL_TARGETS.every(target => byTarget.has(target))) fail('missing universal component target');
    const ordered = UNIVERSAL_TARGETS.map(target => byTarget.get(target));
    const first = ordered[0].manifest;
    if (ordered.some(s => s.manifest.nodeVersion !== first.nodeVersion || s.manifest.playwrightVersion !== first.playwrightVersion)) fail('locked runtime version mismatch');
    const specialNames = new Set([CONTENT_TYPES, VSIX_MANIFEST, RUNTIME_INDEX]);
    const outputs = new Map(), caseNames = new Map();
    for (const scan of ordered) for (const entry of scan.entries) {
      if (entry.name === CONTENT_TYPES || entry.name === VSIX_MANIFEST) continue;
      const name = entry.name.startsWith(RUNTIME_PREFIX) ? `${RUNTIME_PREFIX}${scan.target}/${entry.name.slice(RUNTIME_PREFIX.length)}` : entry.name;
      if (specialNames.has(name)) fail(`reserved ZIP entry collision: ${name}`);
      const priorCase = caseNames.get(name.toLowerCase());
      if (priorCase && priorCase !== name) fail(`case-colliding output paths: ${name}`);
      caseNames.set(name.toLowerCase(), name);
      const previous = outputs.get(name);
      if (previous && previous.scan.digests.get(previous.entry.name) !== scan.digests.get(entry.name)) fail(`shared file conflict: ${name}`);
      if (!previous) outputs.set(name, { scan, entry });
    }
    stagingDir = await fsp.mkdtemp(path.join(path.dirname(output), `.${path.basename(output)}.staging-`));
    const staged = path.join(stagingDir, path.basename(output));
    zipOut = new ZipFile();
    zipOut.on('error', error => zipOut.outputStream.destroy(error));
    zipOut.outputStream.on('error', () => {});
    const outputFailure = new AbortController();
    const copySignal = signal ? AbortSignal.any([signal, outputFailure.signal]) : outputFailure.signal;
    writing = pipeline(zipOut.outputStream, createWriteStream(staged, { flags: 'wx' }), { signal });
    // Observe early output errors while an input stream is still being fed.
    writing.catch(error => outputFailure.abort(error));
    const fixedDate = new Date('2000-01-01T00:00:00Z');
    const addBuffer = (bytes, name) => zipOut.addBuffer(bytes, name, { mode: 0o100644, mtime: fixedDate });
    addBuffer(mergeContentTypes(ordered), CONTENT_TYPES);
    addBuffer(universalVsixManifest(ordered[0].special[VSIX_MANIFEST]), VSIX_MANIFEST);
    addBuffer(Buffer.from(JSON.stringify({ schemaVersion: 3, targets: [...UNIVERSAL_TARGETS] }) + '\n'), RUNTIME_INDEX);
    for (const [name, { scan, entry }] of outputs) {
      throwIfAborted(signal, 'assembly');
      const bridge = new PassThrough();
      bridges.add(bridge); bridge.on('error', () => {}); bridge.once('end', () => bridges.delete(bridge));
      zipOut.addReadStream(bridge, name, { mode: 0o100000 | ((entry.mode & 0o777) || 0o644), mtime: fixedDate, size: entry.size });
      const source = await withEntryStream(scan.zip, entry.zipEntry);
      const digest = crypto.createHash('sha256');
      const hashing = new Transform({ transform(chunk, _encoding, next) { digest.update(chunk); next(null, chunk); } });
      await pipeline(source, hashing, bridge, { signal: copySignal });
      if (digest.digest('hex') !== scan.digests.get(entry.name)) fail(`component changed during assembly: ${entry.name}`);
    }
    zipOut.end();
    await writing;
    throwIfAborted(signal, 'assembly commit');
    await fsp.rename(staged, output);
    return { output, version, targets: [...UNIVERSAL_TARGETS] };
  } finally {
    for (const bridge of bridges) bridge.destroy();
    zipOut?.outputStream.destroy();
    if (writing) await writing.catch(() => {});
    for (const scan of scans) scan.zip.close();
    try { if (stagingDir) await fsp.rm(stagingDir, { recursive: true, force: true }); }
    finally { await release(); }
  }
}
