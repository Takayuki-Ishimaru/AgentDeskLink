// Explicit real MCP/Engine test. All physical input targets only this own fixture.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const project = resolve(process.argv[2] ?? resolve(root, '../..'));
const req = createRequire(join(project, 'package.json'));
const { Client } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/client')).href);
const { StdioClientTransport } = await import(pathToFileURL(req.resolve('@modelcontextprotocol/client/stdio')).href);
const sharp = req('sharp'),
  delay = ms => new Promise(r => setTimeout(r, ms));
const appPath = resolve(root, 'build/ADLFixture.app/Contents/MacOS/ADLFixture'),
  helperPath = resolve(root, 'build/adl-macos-ax-helper');
const dir = await mkdtemp(join(tmpdir(), 'adl-real-mac-input-'));
let fixture,
  client,
  session,
  checks = 0;
class Fixture {
  constructor() {
    this.child = spawn(appPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.lines = [];
    this.waiters = [];
    createInterface({ input: this.child.stdout }).on('line', line => {
      const w = this.waiters.shift(),
        v = JSON.parse(line);
      if (w) w(v);
      else this.lines.push(v);
    });
    this.child.stderr.on('data', v => process.stderr.write(v));
  }
  next() {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    return new Promise(resolve => this.waiters.push(resolve));
  }
  send(v) {
    const p = this.next();
    this.child.stdin.write(JSON.stringify(v) + '\n');
    return p;
  }
}
const check = (name, body) => {
  body();
  checks++;
  console.log(`PASS ${name}`);
};
const metadata = r => {
  assert(!r.isError, JSON.stringify(r));
  return JSON.parse(r.content[0].text);
};
async function png(r, label) {
  const m = metadata(r),
    image = r.content.find(c => c.type === 'image');
  assert(image, label);
  const info = await sharp(Buffer.from(image.data, 'base64')).metadata();
  assert.equal(info.format, 'png');
  assert(info.width > 0 && info.height > 0);
  assert(!r.content[0].text.includes(image.data));
  return m;
}
const state = async () => (await fixture.send({ op: 'state' })).windows.find(w => w.index === 0);
const point = (p, f) => ({
  x: (p.x - f.source_to_desktop.origin_x) / f.source_to_desktop.scale_x,
  y: (p.y - f.source_to_desktop.origin_y) / f.source_to_desktop.scale_y,
});
async function call(name, args = {}) {
  return client.callTool({ name, arguments: args });
}
try {
  fixture = new Fixture();
  assert((await fixture.next()).ready);
  await fixture.send({ op: 'foreground', index: 0 });
  await delay(120);
  const controls = join(dir, 'controls.json'),
    config = join(dir, 'policy.json');
  await writeFile(
    controls,
    JSON.stringify({
      FixtureText: { role: 'textbox', allowed: ['fill'] },
      FixtureButton: { role: 'button', allowed: ['click'] },
    }),
  );
  await writeFile(
    config,
    JSON.stringify({
      actionTimeoutMs: 30000,
      macos: {
        helperPath,
        appId: 'local.agentdesklink.fixture',
        appPath,
        controlsPath: controls,
        classification: 'PUBLIC',
        visual: { enabled: true, allowUnredacted: true },
        interactive: {
          enabled: true,
          surfaces: [
            {
              id: 'canvas',
              region: { x: 0, y: 0, width: 4096, height: 4096 },
              kinds: ['drag', 'swipe'],
              swipe_backend: 'scroll',
            },
          ],
        },
      },
    }),
  );
  for (const mode of ['legacy', 'modern']) {
    client = new Client(
      { name: 'real-macos-physical-smoke', version: '1.0.0' },
      { versionNegotiation: { mode: mode === 'legacy' ? 'legacy' : { pin: '2026-07-28' } } },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve(project, 'dist/src/server.js'), '--config', config],
      cwd: project,
      stderr: 'pipe',
    });
    await client.connect(transport);
    transport.stderr?.on('data', v => process.stderr.write(v));
    const targets = metadata(await call('adl_targets', { surface: 'desktop' })),
      s = await state();
    const target = targets.targets.find(
      t =>
        t.capabilities.includes('interactive_desktop') &&
        s.points.button.x >= t.window.bounds.x &&
        s.points.button.x < t.window.bounds.x + t.window.bounds.width &&
        s.points.button.y >= t.window.bounds.y &&
        s.points.button.y < t.window.bounds.y + t.window.bounds.height,
    );
    assert(target);
    session = metadata(await call('adl_open', { target_id: target.target_id, mode: 'interactive_desktop' }));
    let frame = await png(await call('adl_capture', { session_id: session.session_id }), 'initial image');
    const beforeClick = (await state()).clicks;
    let preparedRaw = await call('adl_prepare_input', {
      session_id: session.session_id,
      frame_id: frame.frame_id,
      expected_revision: frame.revision,
      point: point((await state()).points.button, frame),
      action: 'click',
      expected_target: { role: 'button', name: 'Run search' },
      include_image: true,
    });
    let proof = await png(preparedRaw, 'surrounding image');
    check(`${mode} real prepare returns actual target plus bounded PNG surrounding crop`, () => {
      assert(proof.pointer_on_target);
      assert.equal(proof.target.name, 'Run search');
      assert(proof.image.region.width <= 256 && proof.image.region.height <= 192);
      assert(!preparedRaw.content[0].text.includes('input_token'));
    });
    frame = await png(
      await call('adl_commit_input', { session_id: session.session_id, confirmation_id: proof.confirmation_id }),
      'click result image',
    );
    await delay(50);
    check(`${mode} Engine surrounding-image capture preserves proof and committed click`, () => {
      assert.equal(frame.input.action, 'click');
      assert(frame.input.released_input);
    });
    assert.equal((await state()).clicks, beforeClick + 1);
    proof = await png(
      await call('adl_prepare_input', {
        session_id: session.session_id,
        frame_id: frame.frame_id,
        expected_revision: frame.revision,
        point: point((await state()).points.field, frame),
        action: 'fill',
        expected_target: { role: 'textbox', name: 'Reference' },
        include_image: true,
      }),
      'typing surrounding image',
    );
    const value = `MCP ${mode} 界🙂`;
    frame = await png(
      await call('adl_commit_input', { session_id: session.session_id, confirmation_id: proof.confirmation_id, value }),
      'typing result image',
    );
    await delay(60);
    check(`${mode} exact focused Unicode fill crosses MCP, Engine and native helper`, () => {
      assert.equal(frame.input.action, 'fill');
      assert(frame.input.released_input);
    });
    assert.equal((await state()).field, value);
    let p = point((await state()).points.canvas, frame),
      before = (await state()).input;
    frame = await png(
      await call('adl_gesture', {
        session_id: session.session_id,
        frame_id: frame.frame_id,
        expected_revision: frame.revision,
        surface_id: 'canvas',
        kind: 'drag',
        points: [
          { x: p.x - 20, y: p.y, t_ms: 0 },
          { x: p.x + 20, y: p.y, t_ms: 160 },
        ],
      }),
      'drag result image',
    );
    await delay(50);
    let after = (await state()).input;
    check(`${mode} real native drag crosses MCP and reports actual backend plus PNG`, () => {
      assert.equal(frame.gesture.input_backend, 'mouse_drag');
      assert.equal(frame.gesture.points_executed, 2);
      assert(frame.gesture.released_input);
      assert(after.downs > before.downs && after.drags > before.drags && after.ups > before.ups);
    });
    p = point((await state()).points.canvas, frame);
    before = (await state()).input;
    frame = await png(
      await call('adl_gesture', {
        session_id: session.session_id,
        frame_id: frame.frame_id,
        expected_revision: frame.revision,
        surface_id: 'canvas',
        kind: 'swipe',
        swipe_backend: 'scroll',
        points: [
          { x: p.x, y: p.y - 20, t_ms: 0 },
          { x: p.x, y: p.y + 20, t_ms: 160 },
        ],
      }),
      'scroll result image',
    );
    await delay(50);
    after = (await state()).input;
    check(`${mode} real scroll swipe crosses MCP with truthful backend and PNG`, () => {
      assert.equal(frame.gesture.input_backend, 'scroll_swipe');
      assert(after.scrolls > before.scrolls);
    });
    metadata(await call('adl_close', { session_id: session.session_id }));
    session = undefined;
    await client.close();
    client = undefined;
  }
  console.log(`${checks}/${checks} real macOS MCP/Engine physical-input checks passed`);
} finally {
  if (client && session) await call('adl_close', { session_id: session.session_id }).catch(() => {});
  await client?.close();
  if (fixture) {
    await fixture.send({ op: 'quit' }).catch(() => {});
    if (fixture.child.exitCode === null) fixture.child.kill();
  }
  await rm(dir, { recursive: true, force: true });
}
