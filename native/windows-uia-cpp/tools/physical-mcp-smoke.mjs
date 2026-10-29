import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const buildDir = process.argv[2];
assert.ok(buildDir);
const work = join(buildDir, 'physical-mcp-' + randomUUID());
await mkdir(work, { recursive: true });
const app = join(buildDir, 'interactive-fixture', 'InteractiveFixture.exe');
const helper = join(buildDir, 'Release', 'adl-windows-uia-helper.exe');
const checks = [];
function check(ok, name) {
  assert.ok(ok, name);
  checks.push(name);
  console.log('PASS ' + name);
}
let fixtureProcess,
  client,
  fixtureDir,
  fid = 0,
  state;
async function fixture(op, extra = {}) {
  const id = ++fid,
    tmp = join(fixtureDir, 'input.tmp'),
    path = join(fixtureDir, 'input.json');
  await writeFile(tmp, JSON.stringify({ id, op, ...extra }));
  for (let n = 0; ; n++) {
    try {
      await rename(tmp, path);
      break;
    } catch (e) {
      if (n >= 30) throw e;
      await sleep(5);
    }
  }
  for (let n = 0; n < 200; n++) {
    try {
      const got = JSON.parse(await readFile(join(fixtureDir, 'output.json'), 'utf8'));
      if (got.id === id) {
        state = got;
        return got;
      }
    } catch {}
    await sleep(20);
  }
  throw Error('fixture command timeout: ' + op);
}
async function call(name, args = {}) {
  const raw = await client.callTool({ name, arguments: args });
  const metadata = JSON.parse(raw.content[0].text);
  if (raw.isError) throw Error(name + ': ' + JSON.stringify(metadata));
  return { metadata, raw };
}
function point(rect, frame) {
  return {
    x: Math.floor(rect.x + rect.width / 2 - frame.source_to_desktop.origin_x),
    y: Math.floor(rect.y + rect.height / 2 - frame.source_to_desktop.origin_y),
  };
}
async function png(result, name) {
  const images = result.raw.content.filter(c => c.type === 'image');
  check(images.length === 1, name + ' contains one real PNG');
  const bytes = Buffer.from(images[0].data, 'base64');
  check((await sharp(bytes).metadata()).format === 'png', name + ' PNG decodes');
  await writeFile(join(work, name + '.png'), bytes);
  return bytes;
}
try {
  for (const mode of ['legacy', 'modern']) {
    fixtureDir = join(work, 'fixture-' + mode);
    await mkdir(fixtureDir, { recursive: true });
    fid = 0;
    state = undefined;
    fixtureProcess = spawn(app, [fixtureDir], { stdio: 'ignore', windowsHide: false });
    fixtureProcess.on('error', e => {
      console.error(e);
    });
    for (let n = 0; n < 200; n++) {
      try {
        state = JSON.parse(await readFile(join(fixtureDir, 'output.json'), 'utf8'));
        if (state.ready) break;
      } catch {}
      await sleep(25);
    }
    check(state?.ready, mode + ' fixture ready');
    await fixture('foreground');
    check(state.foreground, mode + ' fixture exact foreground');
    const controls = join(work, 'controls-' + mode + '.json');
    await writeFile(
      controls,
      JSON.stringify({
        FixtureText: { role: 'edit', allowed: ['fill'] },
        FixtureButton: { role: 'button', allowed: ['click'] },
      }),
    );
    const config = join(work, 'config-' + mode + '.json');
    await writeFile(
      config,
      JSON.stringify({
        auditPath: join(work, 'audit-' + mode + '.jsonl'),
        actionTimeoutMs: 15000,
        windows: {
          helperPath: helper,
          appId: 'physical-fixture',
          appPath: app,
          controlsPath: controls,
          classification: 'PUBLIC',
          visual: { enabled: true },
          interactive: {
            enabled: true,
            surfaces: [
              {
                id: 'canvas',
                region: { x: 0, y: 180, width: 610, height: 350 },
                kinds: ['drag', 'swipe'],
                swipe_backend: 'scroll',
              },
            ],
          },
        },
      }),
    );
    client = new Client(
      { name: 'windows-physical-smoke', version: '1.0.0' },
      { versionNegotiation: { mode: mode === 'legacy' ? 'legacy' : { pin: '2026-07-28' } } },
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['dist/src/server.js', '--config', config],
        cwd: process.cwd(),
        stderr: 'pipe',
      }),
    );
    const targets = (await call('adl_targets')).metadata.targets;
    check(
      targets.length === 1 && targets[0].capabilities.includes('interactive_desktop'),
      mode + ' exact physical capability target',
    );
    const session = (await call('adl_open', { target_id: targets[0].target_id, mode: 'interactive_desktop' })).metadata;
    const session_id = session.session_id;
    const capture = () => call('adl_capture', { session_id });
    const prepare = async (which, action, role, name) => {
      await fixture('state');
      const full = await capture();
      const expected = point(state[which], full.metadata);
      const prepared = await call('adl_prepare_input', {
        session_id,
        frame_id: full.metadata.frame_id,
        expected_revision: full.metadata.revision,
        action,
        point: expected,
        expected_target: { role, name },
        include_image: true,
      });
      const region = prepared.metadata.image?.region;
      check(
        region &&
          expected.x >= region.x &&
          expected.y >= region.y &&
          expected.x < region.x + region.width &&
          expected.y < region.y + region.height,
        mode + ' preparation crop contains actual intended point',
      );
      return prepared;
    };
    let full = await capture();
    const fullBytes = await png(full, mode + '-capture');
    const raw = await sharp(fullBytes).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const blueSource = {
      x: state.canvas.x + state.box.x + 10 - full.metadata.source_to_desktop.origin_x,
      y: state.canvas.y + state.box.y + 10 - full.metadata.source_to_desktop.origin_y,
    };
    const ox = Math.floor((blueSource.x - full.metadata.region.x) / full.metadata.output.source_pixels_per_output_x),
      oy = Math.floor((blueSource.y - full.metadata.region.y) / full.metadata.output.source_pixels_per_output_y);
    const offset = (oy * raw.info.width + ox) * raw.info.channels;
    check(
      raw.data[offset + 2] > 180 && raw.data[offset] < 100,
      mode + ' rendered synthetic blue canvas pixels retained',
    );
    check(!('input_token' in full.metadata), mode + ' private native proof absent from MCP');
    let prepared = await prepare('button', 'click', 'button', 'Fixture button');
    check(
      prepared.metadata.pointer_on_target && prepared.metadata.target.role === 'button',
      mode + ' actual hover target checked',
    );
    await png(prepared, mode + '-prepare-click');
    await capture();
    const clicked = await call('adl_commit_input', { session_id, confirmation_id: prepared.metadata.confirmation_id });
    check(clicked.metadata.input?.released_input === true, mode + ' read-only capture preserves armed click');
    await png(clicked, mode + '-click');
    await sleep(80);
    await fixture('state');
    check(state.clicks === 1, mode + ' fixture actual click readback');
    prepared = await prepare('field_rect', 'fill', 'textbox', 'Fixture text');
    await png(prepared, mode + '-prepare-fill');
    const value = 'ADL 日本語 🚀 ' + mode;
    const filled = await call('adl_commit_input', {
      session_id,
      confirmation_id: prepared.metadata.confirmation_id,
      value,
    });
    check(filled.metadata.input?.released_input === true, mode + ' Unicode fill released');
    await png(filled, mode + '-fill');
    await fixture('state');
    check(state.field === value && state.second === 'Untouched', mode + ' exact Unicode field readback');
    const replay = await client.callTool({
      name: 'adl_commit_input',
      arguments: { session_id, confirmation_id: prepared.metadata.confirmation_id, value: 'replay' },
    });
    check(replay.isError, mode + ' confirmation one shot');
    await fixture('focus_canvas');
    full = await capture();
    let source = point({ x: state.canvas.x + 20, y: state.canvas.y + 40, width: 80, height: 80 }, full.metadata);
    const dragged = await call('adl_gesture', {
      session_id,
      frame_id: full.metadata.frame_id,
      expected_revision: full.metadata.revision,
      surface_id: 'canvas',
      kind: 'drag',
      points: [
        { ...source, t_ms: 0 },
        { x: source.x + 80, y: source.y + 50, t_ms: 160 },
      ],
    });
    check(
      dragged.metadata.gesture?.released_input === true && dragged.metadata.gesture?.input_backend === 'mouse_drag',
      mode + ' physical mouse backend acknowledged',
    );
    await png(dragged, mode + '-drag');
    await fixture('state');
    check(
      state.drags === 1 && state.box.x > 30 && !state.mouse_down,
      mode + ' actual drag movement and release readback',
    );
    await fixture('focus_canvas');
    full = await capture();
    source = point({ x: state.canvas.x + 20, y: state.canvas.y + 40, width: 80, height: 80 }, full.metadata);
    const swiped = await call('adl_gesture', {
      session_id,
      frame_id: full.metadata.frame_id,
      expected_revision: full.metadata.revision,
      surface_id: 'canvas',
      kind: 'swipe',
      swipe_backend: 'scroll',
      points: [
        { ...source, t_ms: 0 },
        { x: source.x + 50, y: source.y + 60, t_ms: 160 },
      ],
    });
    check(
      swiped.metadata.gesture?.released_input === true && swiped.metadata.gesture?.input_backend === 'scroll_swipe',
      mode + ' scroll backend is explicit',
    );
    await png(swiped, mode + '-swipe');
    await fixture('state');
    check(state.wheel !== 0, mode + ' actual wheel readback');
    await call('adl_close', { session_id });
    await client.close();
    client = undefined;
    if (fixtureProcess.exitCode === null) {
      const exited = new Promise(resolve => fixtureProcess.once('exit', resolve));
      fixtureProcess.kill();
      await Promise.race([
        exited,
        sleep(2000).then(() => {
          throw Error('synthetic fixture cleanup timeout');
        }),
      ]);
    }
    fixtureProcess = undefined;
  }
  await writeFile(
    join(work, 'result.json'),
    JSON.stringify({ ok: true, checks, finished: new Date().toISOString() }, null, 2),
  );
  console.log('RESULT ' + work);
} catch (error) {
  await writeFile(
    join(work, 'result.json'),
    JSON.stringify(
      { ok: false, error: String(error), stack: error.stack, checks, finished: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.error(error);
  console.log('RESULT ' + work);
  process.exitCode = 1;
} finally {
  if (client) await client.close().catch(() => {});
  if (fixtureProcess && fixtureProcess.exitCode === null) fixtureProcess.kill();
}
