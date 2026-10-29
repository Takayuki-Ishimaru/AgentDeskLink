import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Engine } from '../dist/src/core.js';
import { WindowsAdapter } from '../dist/src/windows.js';
import { MacOSAdapter } from '../dist/src/macos.js';
import { parsePolicy } from '../dist/src/policy.js';
const [policyArg, outArg] = process.argv.slice(2);
assert.ok(['win32', 'darwin'].includes(process.platform));
assert.ok(
  policyArg && outArg,
  'Usage: node scripts/desktop-visual-e2e.mjs <trusted-fixture-policy.json> <output-directory>',
);
const out = resolve(outArg);
await mkdir(out, { recursive: true });
const checks = [];
const check = (name, details = {}) => {
  checks.push({ name, ...details });
  console.log(`PASS ${name}`);
};
const input = JSON.parse((await readFile(resolve(policyArg), 'utf8')).replace(/^\uFEFF/, ''));
const desktopKey = process.platform === 'win32' ? 'windows' : 'macos';
assert.equal(
  input[desktopKey]?.visual?.enabled,
  true,
  'Fixture policy must explicitly enable native visual disclosure',
);
const config = {
  ...input,
  actionTimeoutMs: 15000,
  auditPath: join(out, 'native-visual-audit.jsonl'),
  [desktopKey]: {
    ...input[desktopKey],
    visual: {
      ...input[desktopKey].visual,
      maskRegions: [{ x: 0, y: 0, width: 20, height: 20 }, ...(input[desktopKey].visual.maskRegions ?? [])],
    },
  },
};
const policy = parsePolicy(config);
async function black(png, x = 10, y = 10) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual(
    [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)],
    [0, 0, 0],
  );
}
async function metadataFrame(meta, png) {
  assert.equal(meta.coordinate_space, 'window_pixels');
  assert.equal(
    meta.source_to_desktop.coordinate_space,
    process.platform === 'win32' ? 'desktop_physical_pixels' : 'desktop_points_top_left',
  );
  assert.ok(meta.source_to_desktop.scale_x > 0 && Number.isFinite(meta.source_to_desktop.scale_x));
  assert.ok(meta.source_to_desktop.scale_y > 0 && Number.isFinite(meta.source_to_desktop.scale_y));
  assert.ok(meta.surface_epoch);
  assert.equal(meta.redacted, true);
  assert.equal((await sharp(png).metadata()).width, meta.output.width);
  assert.equal((await sharp(png).metadata()).height, meta.output.height);
  await black(
    png,
    Math.floor(5 / meta.output.source_pixels_per_output_x),
    Math.floor(5 / meta.output.source_pixels_per_output_y),
  );
}
const desktop = process.platform === 'win32' ? new WindowsAdapter(policy.windows) : new MacOSAdapter(policy.macos);
const fakeBrowser = {
  open: async () => {
    throw new Error('Browser is outside this fixture');
  },
  close: async () => {},
};
const engine = new Engine(policy, { browser: fakeBrowser, desktop });
try {
  const targets = (await engine.listTargets('desktop')).targets;
  const target = targets.find(t => t.capabilities.includes('capture') && !t.window?.minimized);
  assert.ok(target, 'No visible native capture-capable fixture target');
  const session = await engine.open(target.target_id, 'background_semantic');
  const observed = await engine.observe(session.session_id, { token_budget: 8000 });
  if (process.platform === 'win32') assert.ok(observed.elements.some(e => e.name === 'Fixture text'));
  assert.ok(!JSON.stringify(observed).includes('CANARY_NATIVE_PASSWORD'));
  const full = await engine.capture(session.session_id, { max_dimension: 2048 });
  await metadataFrame(full.metadata, full.png);
  await writeFile(join(out, 'engine-full.png'), full.png);
  check('Engine exact native capture and configured/native masks', {
    source: full.metadata.source,
    transform: full.metadata.source_to_desktop,
  });
  const crop = await engine.capture(session.session_id, {
    frame_id: full.metadata.frame_id,
    region: { x: 0, y: 0, width: 32, height: 32 },
  });
  assert.equal(crop.metadata.frame_id, full.metadata.frame_id);
  assert.equal(crop.metadata.captured_at, full.metadata.captured_at);
  assert.equal((await sharp(crop.png).metadata()).width, 32);
  await black(crop.png);
  check('Engine native crop preserves immutable source frame identity/time');
  const sequence = await engine.record(session.session_id, { frame_count: 3, interval_ms: 250, max_dimension: 512 });
  assert.equal(sequence.frames.length, 3);
  assert.equal(sequence.metadata.audio, false);
  assert.equal(sequence.metadata.encoding, 'timestamped_png_sequence');
  assert.equal(sequence.metadata.requested_interval_ms, 250);
  assert.ok(sequence.metadata.elapsed_ms >= 450);
  for (let i = 0; i < 3; i++) {
    const f = sequence.frames[i];
    await metadataFrame(f.metadata, f.png);
    assert.equal(sequence.metadata.frames[i].frame_id, f.metadata.frame_id);
    if (i) {
      assert.ok(sequence.metadata.frames[i].elapsed_ms > sequence.metadata.frames[i - 1].elapsed_ms);
      assert.ok(Date.parse(f.metadata.captured_at) >= Date.parse(sequence.frames[i - 1].metadata.captured_at));
    }
    const retained = await engine.capture(session.session_id, {
      frame_id: f.metadata.frame_id,
      region: { x: 0, y: 0, width: 32, height: 32 },
    });
    assert.equal(retained.metadata.captured_at, f.metadata.captured_at);
  }
  check('Engine native three-frame250ms sampling and retained crops', {
    elapsed_ms: sequence.metadata.elapsed_ms,
    frames: sequence.metadata.frames.map(f => ({
      captured_at: f.captured_at,
      elapsed_ms: f.elapsed_ms,
      frame_id: f.frame_id,
    })),
  });
  const last = sequence.frames[2];
  await assert.rejects(
    engine.gesture(session.session_id, {
      kind: 'drag',
      surface_id: 'native',
      frame_id: last.metadata.frame_id,
      expected_revision: last.metadata.revision,
      points: [
        { x: 30, y: 30, t_ms: 0 },
        { x: 40, y: 40, t_ms: 100 },
      ],
    }),
    { code: 'E_UNSUPPORTED_ACTION' },
  );
  check('native physical gestures explicitly unavailable');
  const cancel = new AbortController();
  const pending = engine.record(
    session.session_id,
    { frame_count: 8, interval_ms: 500, max_dimension: 512 },
    cancel.signal,
  );
  setTimeout(() => cancel.abort(), 150);
  await assert.rejects(pending, { code: 'E_CANCELLED' });
  await assert.rejects(engine.capture(session.session_id), { code: 'E_TARGET_NOT_FOUND' });
  check('native sequence cancellation invalidates its session');
} finally {
  await engine.shutdown();
}
const policyFile = join(out, 'mcp-policy.json');
await writeFile(policyFile, JSON.stringify(config));
for (const mode of ['legacy', 'modern']) {
  const client = new Client(
    { name: 'adl-native-visual-acceptance', version: '1' },
    { versionNegotiation: { mode: mode === 'legacy' ? 'legacy' : { pin: '2026-07-28' } } },
  );
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['dist/src/server.js', '--config', policyFile],
        cwd: process.cwd(),
        stderr: 'pipe',
      }),
    );
    const call = async (name, args = {}) => client.callTool({ name, arguments: args });
    const text = r => JSON.parse(r.content[0].text);
    const targets = text(await call('adl_targets', { surface: 'desktop' })).targets;
    const target = targets.find(t => t.capabilities.includes('capture') && !t.window?.minimized);
    assert.ok(target);
    const session = text(await call('adl_open', { target_id: target.target_id, mode: 'background_semantic' }));
    assert.ok(session.session_id);
    const full = await call('adl_capture', { session_id: session.session_id, max_dimension: 2048 });
    assert.ok(!full.isError, JSON.stringify(text(full)));
    assert.equal(full.content.length, 2);
    assert.equal(full.content[1].type, 'image');
    assert.equal(full.content[1].mimeType, 'image/png');
    await metadataFrame(text(full), Buffer.from(full.content[1].data, 'base64'));
    assert.ok(!full.content[0].text.includes('iVBOR'));
    const crop = await call('adl_capture', {
      session_id: session.session_id,
      frame_id: text(full).frame_id,
      region: { x: 0, y: 0, width: 32, height: 32 },
    });
    assert.ok(!crop.isError);
    assert.equal(text(crop).frame_id, text(full).frame_id);
    await black(Buffer.from(crop.content[1].data, 'base64'));
    const sequence = await call('adl_record', {
      session_id: session.session_id,
      frame_count: 3,
      interval_ms: 250,
      max_dimension: 512,
    });
    assert.ok(!sequence.isError, JSON.stringify(text(sequence)));
    assert.equal(sequence.content.length, 4);
    const meta = text(sequence);
    assert.equal(meta.frames.length, 3);
    assert.equal(meta.encoding, 'timestamped_png_sequence');
    assert.equal(meta.audio, false);
    assert.ok(meta.elapsed_ms >= 450);
    for (let i = 0; i < 3; i++) {
      const image = sequence.content[i + 1];
      assert.equal(image.type, 'image');
      await metadataFrame(meta.frames[i], Buffer.from(image.data, 'base64'));
      if (i) assert.ok(meta.frames[i].elapsed_ms > meta.frames[i - 1].elapsed_ms);
    }
    const invalid = await call('adl_capture', {
      session_id: session.session_id,
      region: { x: 0, y: 0, width: 32, height: 32 },
    });
    assert.ok(invalid.isError);
    assert.ok(invalid.content.every(c => c.type !== 'image'));
    const frame = meta.frames[2];
    const gesture = await call('adl_gesture', {
      session_id: session.session_id,
      kind: 'drag',
      surface_id: 'native',
      frame_id: frame.frame_id,
      expected_revision: frame.revision,
      points: [
        { x: 30, y: 30, t_ms: 0 },
        { x: 40, y: 40, t_ms: 100 },
      ],
    });
    assert.ok(gesture.isError);
    assert.equal(text(gesture).error.code, 'E_UNSUPPORTED_ACTION');
    await call('adl_close', { session_id: session.session_id });
    const closed = await call('adl_capture', { session_id: session.session_id, frame_id: frame.frame_id });
    assert.equal(text(closed).error.code, 'E_TARGET_NOT_FOUND');
    check(`stdio ${mode} native image/crop/three-frame250ms sequence/errors`, { elapsed_ms: meta.elapsed_ms });
  } finally {
    await client.close();
  }
}
const audit = await readFile(config.auditPath, 'utf8');
assert.ok(audit.includes('capture'));
assert.ok(!audit.includes('iVBOR'));
assert.ok(!audit.includes('CANARY_NATIVE_PASSWORD'));
check('native visual audit contains no PNG or fixture password');
await writeFile(
  join(out, 'desktop-js-visual-result.json'),
  JSON.stringify(
    {
      ok: true,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      finished: new Date().toISOString(),
      checks,
    },
    null,
    2,
  ),
);
