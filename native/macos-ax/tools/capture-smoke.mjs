// Explicit local runtime check. Captures ONLY the synthetic ADLFixture app configured below.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appPath = resolve(root, 'build/ADLFixture.app/Contents/MacOS/ADLFixture');
const helperPath = resolve(root, 'build/adl-macos-ax-helper');
const processes = [];
class Peer {
  constructor(path, args = []) {
    this.child = spawn(path, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    processes.push(this.child);
    this.queue = [];
    this.lines = [];
    createInterface({ input: this.child.stdout }).on('line', line => {
      const next = this.queue.shift();
      if (next) next.resolve(JSON.parse(line));
      else this.lines.push(line);
    });
    this.child.stderr.on('data', () => {});
    this.child.on('exit', () => {
      for (const pending of this.queue.splice(0)) pending.reject(new Error('Process exited'));
    });
  }
  next() {
    if (this.lines.length) return Promise.resolve(JSON.parse(this.lines.shift()));
    return new Promise((resolve, reject) => {
      const pending = {
        resolve: v => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: e => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        this.queue = this.queue.filter(x => x !== pending);
        reject(new Error('Response timed out'));
      }, 10_000);
      this.queue.push(pending);
    });
  }
  send(data) {
    const reply = this.next();
    this.child.stdin.write(JSON.stringify(data) + '\n');
    return reply;
  }
  call(op, args = {}) {
    return this.send({ op, request_id: randomUUID(), ...args });
  }
}
const base = ['--app-id', 'local.agentdesklink.fixture', '--app-path', appPath];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = frame => createHash('sha256').update(frame.result.png_base64).digest('hex');
let checks = 0;
const check = (label, body) => {
  body();
  checks++;
  console.log(`PASS ${label}`);
};
try {
  const fixture = new Peer(appPath),
    ready = await fixture.next();
  assert.equal(ready.ready, true);
  const defaultHelper = new Peer(helperPath, base);
  let disabled;
  // AppKit announces ready before its accessibility windows finish materializing.
  for (let attempt = 0; attempt < 20; attempt++) {
    disabled = await defaultHelper.call('discover');
    if (disabled.ok) break;
    assert.equal(disabled.error.code, 'E_TARGET_NOT_FOUND', JSON.stringify(disabled));
    await delay(100);
  }
  check('native capture is default-off', () => {
    assert.equal(disabled.ok, true, JSON.stringify(disabled));
    assert.equal(disabled.result.visual_capture, false);
    assert(disabled.result.targets.every(t => !t.capture_only));
  });
  defaultHelper.child.kill();
  const helper = new Peer(helperPath, [...base, '--visual-enabled']);
  let discovery;
  for (let attempt = 0; attempt < 20; attempt++) {
    discovery = await helper.call('discover');
    if (discovery.ok && discovery.result.targets.some(t => t.capture_only)) break;
    await delay(100);
  }
  assert.equal(discovery.ok, true);
  if (!discovery.result.visual_capture)
    throw new Error('BLOCKED: existing Screen Recording permission is absent; no permission prompt was requested.');
  const targets = discovery.result.targets.filter(t => t.capture_only && !t.window.minimized);
  assert(targets.length > 0);
  // Establish the baseline after launching the test fixture. The monitor is read-only.
  const monitor = new Peer(resolve(root, 'build/adl-macos-monitor'));
  const baseline = await monitor.next();
  assert.equal(baseline.ready, true, 'foreground/focus/cursor probe must be available');
  check('separate ScreenCaptureKit capture targets discovered', () => {
    assert(targets.every(t => t.application_id === 'local.agentdesklink.fixture'));
    assert(discovery.result.targets.some(t => !t.capture_only));
  });
  const sessions = [];
  for (const target of targets) {
    const open = await helper.call('open', { target_id: target.target_id, mode: 'background_semantic' });
    assert.equal(open.ok, true, JSON.stringify({ target, open }));
    const owner = { target_id: target.target_id, session_id: open.result.session_id };
    const snapshot = await helper.call('snapshot', owner);
    assert.equal(snapshot.ok, true);
    assert.deepEqual(snapshot.result.elements, []);
    const frame = await helper.call('capture', owner);
    assert.equal(frame.ok, true);
    const png = Buffer.from(frame.result.png_base64, 'base64');
    check('real synthetic-window PNG and desktop transform', () => {
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      const width = png.readUInt32BE(16),
        height = png.readUInt32BE(20);
      assert(
        width > 0 &&
          height > 0 &&
          width <= 4096 &&
          height <= 4096 &&
          width * height <= 4_194_304 &&
          png.length <= 8 * 1024 * 1024,
      );
      assert.equal(width, frame.result.viewport.width);
      assert.equal(height, frame.result.viewport.height);
      assert.equal(frame.result.coordinate_space, 'window_pixels');
      assert.equal(frame.result.source_to_desktop.coordinate_space, 'desktop_points_top_left');
      assert(frame.result.source_to_desktop.scale_x > 0 && frame.result.source_to_desktop.scale_y > 0);
      assert.equal(frame.result.redacted, false);
    });
    sessions.push({ owner, hash: hash(frame), epoch: frame.result.surface_epoch });
    const physical = await helper.call('act', {
      ...owner,
      expected_revision: 0,
      action: 'click',
      element_id: 'anything',
    });
    check('capture-only target rejects semantic mutations', () => {
      assert.equal(physical.ok, false);
      assert.equal(physical.error.code, 'E_UNSUPPORTED_ACTION');
    });
  }
  for (const window of ready.windows)
    await fixture.send({ op: 'set', index: window.index, value: 'Synthetic capture update' });
  await delay(100);
  for (const session of sessions) {
    const frame = await helper.call('capture', session.owner);
    assert.equal(frame.ok, true);
    check('repeated frames observe changed fixture pixels at stable geometry', () => {
      assert.notEqual(hash(frame), session.hash);
      assert.equal(frame.result.surface_epoch, session.epoch);
    });
  }
  const monitorResult = monitor.next();
  monitor.child.stdin.end();
  const noninterference = await monitorResult;
  check('capture preserves foreground, AX focus and cursor', () => {
    assert(noninterference.samples > 0);
    assert.equal(noninterference.probe_errors, 0);
    assert.equal(noninterference.changed_samples, 0);
  });
  for (const window of ready.windows) await fixture.send({ op: 'close', index: window.index });
  await delay(350);
  for (const session of sessions) {
    const stale = await helper.call('capture', session.owner);
    check('closed exact capture target is rejected', () => {
      assert.equal(stale.ok, false);
      assert(['E_TARGET_NOT_FOUND', 'E_UNSUPPORTED_ACTION'].includes(stale.error.code), JSON.stringify(stale));
    });
  }
  for (const window of ready.windows) await fixture.send({ op: 'reopen', index: window.index });
  await delay(100);
  const recreated = await helper.call('discover');
  assert.equal(recreated.ok, true);
  check('same-title recreated windows receive new opaque targets', () => {
    const newIDs = new Set(
      recreated.result.targets.filter(t => t.capture_only && !t.window.minimized).map(t => t.target_id),
    );
    assert(newIDs.size > 0);
    assert(targets.every(t => !newIDs.has(t.target_id)));
  });
  for (const session of sessions) {
    const stale = await helper.call('capture', session.owner);
    assert.equal(stale.ok, false);
    assert(['E_TARGET_NOT_FOUND', 'E_UNSUPPORTED_ACTION'].includes(stale.error.code), JSON.stringify(stale));
    const closed = await helper.call('close', session.owner);
    assert.equal(closed.ok, true);
  }
  check('sessions close after target retirement', () => {});
  await fixture.send({ op: 'quit' });
  console.log(`${checks}/${checks} real macOS synthetic capture checks passed`);
} finally {
  for (const child of processes) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}
