// Physical input is authorized ONLY inside this script's own synthetic ADLFixture window.
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  appPath = resolve(root, 'build/ADLFixture.app/Contents/MacOS/ADLFixture'),
  helperPath = resolve(root, 'build/adl-macos-ax-helper');
const processes = [],
  delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class Peer {
  constructor(path, args = []) {
    this.child = spawn(path, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    processes.push(this.child);
    this.lines = [];
    this.waiters = [];
    createInterface({ input: this.child.stdout }).on('line', line => {
      const w = this.waiters.shift();
      if (w) w.resolve(JSON.parse(line));
      else this.lines.push(JSON.parse(line));
    });
    this.child.stderr.on('data', chunk => process.stderr.write(chunk));
    this.child.on('exit', () => {
      for (const w of this.waiters.splice(0)) w.reject(new Error('Process exited'));
    });
  }
  next() {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Native response timeout')), 12000);
      this.waiters.push({
        resolve: v => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: e => {
          clearTimeout(timer);
          reject(e);
        },
      });
    });
  }
  write(value) {
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  send(value) {
    const next = this.next();
    this.write(value);
    return next;
  }
  call(op, args = {}) {
    return this.send({ op, request_id: randomUUID(), ...args });
  }
}
const base = ['--app-id', 'local.agentdesklink.fixture', '--app-path', appPath],
  controls = resolve(root, 'build/interactive-controls.json');
let checks = 0;
const check = (label, fn) => {
  fn();
  checks++;
  console.log(`PASS ${label}`);
};
const success = r => assert.equal(r.ok, true, JSON.stringify(r));
const refused = (r, codes) => {
  assert.equal(r.ok, false, JSON.stringify(r));
  if (codes) assert(codes.includes(r.error.code), JSON.stringify(r));
};
let fixture, helper, owner, point, region;
async function state() {
  const r = await fixture.send({ op: 'state' });
  return r.windows.find(w => w.index === 0);
}
async function frame() {
  const r = await helper.call('capture', owner);
  success(r);
  assert(r.result.input_token);
  return r.result;
}
const sourcePoint = (p, f) => ({
  x: (p.x - f.source_to_desktop.origin_x) / f.source_to_desktop.scale_x,
  y: (p.y - f.source_to_desktop.origin_y) / f.source_to_desktop.scale_y,
});
async function prepare(action, which, expected_target) {
  const f = await frame(),
    s = await state();
  return helper.call('prepare_input', {
    ...owner,
    input_token: f.input_token,
    point: sourcePoint(s.points[which], f),
    action,
    ...(expected_target ? { expected_target } : {}),
  });
}
try {
  await writeFile(
    controls,
    JSON.stringify({
      FixtureText: { role: 'textbox', allowed: ['fill'] },
      FixtureButton: { role: 'button', allowed: ['click'] },
    }),
  );
  fixture = new Peer(appPath);
  const ready = await fixture.next();
  assert(ready.ready);
  await fixture.send({ op: 'foreground', index: 0 });
  await delay(150);
  const preliminary = new Peer(helperPath, [...base, '--visual-enabled']);
  let found;
  for (let i = 0; i < 20; i++) {
    found = await preliminary.call('discover');
    if (found.ok && found.result.targets.some(t => t.capture_only)) break;
    await delay(100);
  }
  success(found);
  const s = await state(),
    target = found.result.targets.find(
      t =>
        t.capture_only &&
        !t.window.minimized &&
        s.points.button.x >= t.window.bounds.x &&
        s.points.button.x < t.window.bounds.x + t.window.bounds.width &&
        s.points.button.y >= t.window.bounds.y &&
        s.points.button.y < t.window.bounds.y + t.window.bounds.height,
    );
  assert(target);
  const opened = await preliminary.call('open', { target_id: target.target_id, mode: 'background_semantic' });
  success(opened);
  const preliminaryOwner = { target_id: target.target_id, session_id: opened.result.session_id },
    first = await preliminary.call('capture', preliminaryOwner);
  success(first);
  const center = sourcePoint(s.points.canvas, first.result);
  region = { x: center.x - 50, y: center.y - 30, width: 100, height: 60 };
  point = center;
  await preliminary.call('close', preliminaryOwner);
  preliminary.child.kill();
  const policy = JSON.stringify({
    enabled: true,
    surfaces: [{ id: 'canvas', region, kinds: ['drag', 'swipe'], swipe_backend: 'scroll' }],
  });
  helper = new Peer(helperPath, [
    ...base,
    '--visual-enabled',
    '--controls-file',
    controls,
    '--interactive-config',
    policy,
  ]);
  const discover = await helper.call('discover');
  success(discover);
  check('explicit interactive capability advertises mouse and scroll, never touch', () => {
    assert.equal(discover.result.interactive_input, true);
    assert(
      discover.result.targets
        .filter(t => t.capture_only)
        .every(
          t =>
            t.gesture_backends.includes('mouse_drag') &&
            t.gesture_backends.includes('scroll_swipe') &&
            !t.gesture_backends.includes('touch'),
        ),
    );
  });
  const chosen = discover.result.targets.find(
    t =>
      t.capture_only &&
      !t.window.minimized &&
      s.points.button.x >= t.window.bounds.x &&
      s.points.button.x < t.window.bounds.x + t.window.bounds.width &&
      s.points.button.y >= t.window.bounds.y &&
      s.points.button.y < t.window.bounds.y + t.window.bounds.height,
  );
  assert(chosen);
  await fixture.send({ op: 'background-window' });
  await delay(80);
  const background = (await fixture.send({ op: 'state' })).windows.find(w => w.index === 9);
  assert(background);
  const backgroundDiscover = await helper.call('discover');
  success(backgroundDiscover);
  const backgroundTarget = backgroundDiscover.result.targets.find(
    t =>
      t.capture_only &&
      background.points.canvas.x >= t.window.bounds.x &&
      background.points.canvas.x < t.window.bounds.x + t.window.bounds.width &&
      background.points.canvas.y >= t.window.bounds.y &&
      background.points.canvas.y < t.window.bounds.y + t.window.bounds.height,
  );
  assert(backgroundTarget);
  const backgroundOpen = await helper.call('open', {
    target_id: backgroundTarget.target_id,
    mode: 'interactive_desktop',
  });
  check('same-app exposed background window cannot acquire foreground input', () =>
    refused(backgroundOpen, ['E_INTERFERENCE_RISK']),
  );
  await fixture.send({ op: 'close', index: 9 });
  await fixture.send({ op: 'foreground', index: 0 });
  await delay(80);
  const open = await helper.call('open', { target_id: chosen.target_id, mode: 'interactive_desktop' });
  success(open);
  owner = { target_id: chosen.target_id, session_id: open.result.session_id };
  const snap = await helper.call('snapshot', owner);
  success(snap);
  let revision = snap.result.revision;
  const pipeline = [
    ['capture', randomUUID()],
    ['snapshot', randomUUID()],
    ['capture', randomUUID()],
  ];
  const pipelined = await Promise.all(pipeline.map(([op, request_id]) => helper.send({ op, request_id, ...owner })));
  check('pipelined capture and snapshot remain serial across nested run-loop waits', () => {
    for (let i = 0; i < pipeline.length; i++) {
      success(pipelined[i]);
      assert.equal(pipelined[i].request_id, pipeline[i][1]);
      assert.equal('png_base64' in pipelined[i].result, pipeline[i][0] === 'capture');
    }
  });
  const second = new Peer(helperPath, [
      ...base,
      '--visual-enabled',
      '--controls-file',
      controls,
      '--interactive-config',
      policy,
    ]),
    secondDiscover = await second.call('discover');
  success(secondDiscover);
  const otherTarget = secondDiscover.result.targets.find(t => t.capture_only && !t.window.minimized);
  const lease = await second.call('open', { target_id: otherTarget.target_id, mode: 'interactive_desktop' });
  check('second helper cannot acquire the cross-process input lease', () => refused(lease, ['E_INTERFERENCE_RISK']));
  second.child.kill();
  let f = await frame(),
    before = await state();
  let result = await helper.call('gesture', {
    ...owner,
    expected_revision: revision,
    input_token: f.input_token,
    surface_id: 'canvas',
    kind: 'drag',
    points: [
      { x: point.x - 20, y: point.y, t_ms: 0 },
      { x: point.x + 20, y: point.y, t_ms: 200 },
    ],
  });
  success(result);
  await delay(70);
  let after = await state();
  check('physical synthetic canvas drag receives down, motion and released mouse-up', () => {
    assert(result.result.released_input);
    assert.equal(result.result.kind, 'drag');
    assert.equal(result.result.points_executed, 2);
    assert(
      after.input.downs > before.input.downs &&
        after.input.drags > before.input.drags &&
        after.input.ups > before.input.ups,
    );
  });
  f = await frame();
  before = await state();
  result = await helper.call('gesture', {
    ...owner,
    expected_revision: revision,
    input_token: f.input_token,
    surface_id: 'canvas',
    kind: 'swipe',
    swipe_backend: 'scroll',
    points: [
      { x: point.x, y: point.y - 20, t_ms: 0 },
      { x: point.x, y: point.y + 20, t_ms: 200 },
    ],
  });
  success(result);
  await delay(70);
  after = await state();
  check('scroll swipe uses real wheel events without claiming multitouch', () => {
    assert.equal(result.result.backend, 'scroll_swipe');
    assert(after.input.scrolls > before.input.scrolls);
  });
  let proof = await prepare('click', 'button', { role: 'button', name: 'Run search' });
  success(proof);
  check('post-hover confirmation identifies exact safe control and has bounded 30 second TTL', () => {
    assert.equal(proof.result.target.role, 'button');
    assert(proof.result.pointer_on_target);
    assert(proof.result.expires_in_ms > 29000 && proof.result.expires_in_ms <= 30000);
  });
  await frame();
  before = await state();
  result = await helper.call('commit_input', { ...owner, confirmation_id: proof.result.confirmation_id });
  success(result);
  await delay(50);
  after = await state();
  check('surrounding-image capture preserves one-shot proof and safe click commits', () =>
    assert.equal(after.clicks, before.clicks + 1),
  );
  const replay = await helper.call('commit_input', { ...owner, confirmation_id: proof.result.confirmation_id });
  check('confirmation replay is refused', () => refused(replay, ['E_STALE_STATE']));
  // Failed proofs quarantine the session; close and reopen before the next independent scenario.
  async function reopen() {
    await helper.call('close', owner);
    const r = await helper.call('open', { target_id: chosen.target_id, mode: 'interactive_desktop' });
    success(r);
    owner = { target_id: chosen.target_id, session_id: r.result.session_id };
    const snap = await helper.call('snapshot', owner);
    success(snap);
    revision = snap.result.revision;
  }
  await helper.call('close', owner);
  await fixture.send({ op: 'hold-left' });
  await delay(60);
  before = await state();
  try {
    const noOp = spawnSync(helperPath, ['--release-input'], { encoding: 'utf8', timeout: 5000 });
    after = await state();
    check('empty ownership journal preserves human-held mouse button', () => {
      assert.equal(noOp.status, 0);
      assert(after.held.left);
      assert.equal(after.input.ups, before.input.ups);
    });
  } finally {
    await fixture.send({ op: 'release-left' });
    await delay(60);
  }
  await fixture.send({ op: 'hold-key' });
  await delay(60);
  try {
    const noOp = spawnSync(helperPath, ['--release-input'], { encoding: 'utf8', timeout: 5000 });
    after = await state();
    check('empty ownership journal preserves human-held key', () => {
      assert.equal(noOp.status, 0);
      assert(after.held.key0);
    });
  } finally {
    await fixture.send({ op: 'release-key' });
    await delay(60);
  }
  await helper.call('close', owner);
  await fixture.send({ op: 'hold-extra' });
  await delay(60);
  try {
    const heldOpen = await helper.call('open', { target_id: chosen.target_id, mode: 'interactive_desktop' });
    check('held extra mouse button blocks interactive session entry', () => refused(heldOpen, ['E_INTERFERENCE_RISK']));
  } finally {
    await fixture.send({ op: 'release-extra' });
    await delay(60);
  }
  await reopen();
  await fixture.send({ op: 'hold-extra' });
  await delay(60);
  try {
    const heldCapture = await helper.call('capture', owner);
    check('fresh capture cannot re-arm over a held extra mouse button', () =>
      refused(heldCapture, ['E_INTERFERENCE_RISK']),
    );
  } finally {
    await fixture.send({ op: 'release-extra' });
    await delay(60);
  }
  await reopen();
  await fixture.send({ op: 'hold-key' });
  await delay(60);
  try {
    const heldKeyCapture = await helper.call('capture', owner);
    check('fresh capture cannot re-arm over a held physical key', () =>
      refused(heldKeyCapture, ['E_INTERFERENCE_RISK']),
    );
  } finally {
    await fixture.send({ op: 'release-key' });
    await delay(60);
  }
  await reopen();
  await fixture.send({ op: 'canvas-button' });
  f = await frame();
  before = await state();
  result = await helper.call('gesture', {
    ...owner,
    expected_revision: revision,
    input_token: f.input_token,
    surface_id: 'canvas',
    kind: 'drag',
    points: [
      { x: point.x - 1, y: point.y, t_ms: 0 },
      { x: point.x + 1, y: point.y, t_ms: 100 },
    ],
  });
  check('gesture refuses ordinary interactive controls inside trusted canvas', () =>
    refused(result, ['E_POLICY_DENIED']),
  );
  assert.equal((await state()).clicks, before.clicks);
  await fixture.send({ op: 'clear-canvas-button' });
  await reopen();
  proof = await prepare('click', 'button', { role: 'button', name: 'Run search' });
  success(proof);
  before = await state();
  await fixture.send({ op: 'nudge-pointer' });
  await delay(60);
  const interferedCapture = await helper.call('capture', owner);
  const interferedCommit = await helper.call('commit_input', {
    ...owner,
    confirmation_id: proof.result.confirmation_id,
  });
  check('surrounding-image capture cannot erase untagged pointer interference', () => {
    refused(interferedCapture, ['E_FOCUS_CHANGED']);
    refused(interferedCommit, ['E_STALE_STATE']);
  });
  assert.equal((await state()).clicks, before.clicks);
  await reopen();
  proof = await prepare('fill', 'field', { role: 'textbox', name: 'Reference' });
  success(proof);
  result = await helper.call('commit_input', {
    ...owner,
    confirmation_id: proof.result.confirmation_id,
    value: 'Plain Unicode 界🙂',
  });
  success(result);
  await delay(80);
  after = await state();
  check('physical fill focuses exact field and sends plain Unicode without clipboard', () =>
    assert.equal(after.field, 'Plain Unicode 界🙂'),
  );
  await reopen();
  proof = await prepare('fill', 'field', { role: 'textbox', name: 'Reference' });
  success(proof);
  const longValue = '界🙂'.repeat(36);
  result = await helper.call('commit_input', {
    ...owner,
    confirmation_id: proof.result.confirmation_id,
    value: longValue,
  });
  success(result);
  check('multi-chunk Unicode fill preserves every scalar and exact caret', () =>
    assert.equal(result.result.action, 'fill'),
  );
  assert.equal((await state()).field, longValue);
  await reopen();
  proof = await prepare('fill', 'field', { role: 'textbox', name: 'Reference' });
  success(proof);
  result = await helper.call('commit_input', { ...owner, confirmation_id: proof.result.confirmation_id, value: '' });
  success(result);
  check('empty plain fill uses verified selection and owned delete key', () =>
    assert.equal(result.result.released_input, true),
  );
  assert.equal((await state()).field, '');
  await fixture.send({ op: 'reset-field' });
  await reopen();
  proof = await prepare('fill', 'field', { role: 'textbox', name: 'Reference' });
  success(proof);
  assert.equal(proof.result.focus_matches_target, false);
  await fixture.send({ op: 'focus-trap' });
  result = await helper.call('commit_input', {
    ...owner,
    confirmation_id: proof.result.confirmation_id,
    value: 'MUST_NOT_APPEAR',
  });
  check('click-focus handler cannot replace prepare-time identity before typing', () => {
    refused(result, ['E_STALE_STATE']);
    assert(result.may_have_executed);
  });
  assert.equal((await state()).field, 'Initial-0');
  for (const kind of ['name', 'geometry', 'editable', 'focus', 'caret', 'value']) {
    await fixture.send({ op: 'reset-field' });
    await reopen();
    proof = await prepare('fill', 'field', { role: 'textbox', name: 'Reference' });
    success(proof);
    await fixture.send({ op: 'typing-trap', kind });
    result = await helper.call('commit_input', {
      ...owner,
      confirmation_id: proof.result.confirmation_id,
      value: longValue,
    });
    after = await state();
    check(`per-chunk ${kind} change halts typing before remaining text`, () => {
      refused(result, ['E_STALE_STATE', 'E_POLICY_DENIED', 'E_FOCUS_CHANGED', 'E_PARTIAL_EXECUTION']);
      assert(result.may_have_executed);
      assert.notEqual(after.field, longValue);
      assert(!after.held.key0 && !after.held.left);
    });
  }
  await fixture.send({ op: 'reset-field' });
  await reopen();
  await fixture.send({ op: 'focus-field' });
  await fixture.send({ op: 'select-all-range' });
  proof = await prepare('fill', 'field', { role: 'textbox', name: 'Reference' });
  success(proof);
  await fixture.send({ op: 'select-range' });
  result = await helper.call('commit_input', {
    ...owner,
    confirmation_id: proof.result.confirmation_id,
    value: 'MUST_NOT_APPEAR',
  });
  check('caret-only change revokes prepared typing before dispatch', () => refused(result, ['E_STALE_STATE']));
  assert.notEqual((await state()).field, 'MUST_NOT_APPEAR');
  await reopen();
  proof = await prepare('fill', 'readonly');
  check('read-only control never yields input confirmation', () => refused(proof, ['E_POLICY_DENIED']));
  await reopen();
  proof = await prepare('click', 'button', { role: 'textbox', name: 'Wrong target' });
  check('wrong intended target is rejected before click', () => refused(proof, ['E_STALE_STATE']));
  await reopen();
  proof = await prepare('fill', 'field', { role: 'textbox', name: 'Reference' });
  success(proof);
  await fixture.send({ op: 'focus-canvas' });
  result = await helper.call('commit_input', {
    ...owner,
    confirmation_id: proof.result.confirmation_id,
    value: 'MUST_NOT_APPEAR',
  });
  check('focus change revokes prepared typing before dispatch', () => refused(result, ['E_FOCUS_CHANGED']));
  assert.notEqual((await state()).field, 'MUST_NOT_APPEAR');
  await reopen();
  await fixture.send({ op: 'clear-overlay' });
  await fixture.send({ op: 'hover-overlay' });
  proof = await prepare('click', 'button', { role: 'button', name: 'Run search' });
  check('hover overlay prevents confirmation or changes its exact vetted target', () =>
    refused(proof, ['E_POLICY_DENIED', 'E_STALE_STATE']),
  );
  await fixture.send({ op: 'clear-overlay' });
  await reopen();
  f = await frame();
  let id = randomUUID();
  helper.write({ op: 'cancel_input', request_id: id });
  result = await helper.send({
    op: 'gesture',
    request_id: id,
    ...owner,
    expected_revision: revision,
    input_token: f.input_token,
    surface_id: 'canvas',
    kind: 'drag',
    points: [
      { x: point.x - 20, y: point.y, t_ms: 0 },
      { x: point.x + 20, y: point.y, t_ms: 200 },
    ],
  });
  check('out-of-band pre-abort prevents physical dispatch', () => refused(result, ['E_CANCELLED']));
  await reopen();
  f = await frame();
  before = await state();
  id = randomUUID();
  const pending = helper.send({
    op: 'gesture',
    request_id: id,
    ...owner,
    expected_revision: revision,
    input_token: f.input_token,
    surface_id: 'canvas',
    kind: 'drag',
    points: [
      { x: point.x - 20, y: point.y, t_ms: 0 },
      { x: point.x + 20, y: point.y, t_ms: 4000 },
    ],
  });
  let pressed = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await state()).input.downs > before.input.downs) {
      pressed = true;
      break;
    }
    await delay(20);
  }
  assert(pressed, 'driver must press before exercising mid-drag cancellation');
  helper.write({ op: 'cancel_input', request_id: id });
  result = await pending;
  await delay(80);
  after = await state();
  check('mid-drag cancellation releases pressed mouse before reply', () => {
    refused(result, ['E_CANCELLED']);
    assert(after.input.downs > before.input.downs);
    assert(after.input.ups > before.input.ups);
    assert(result.may_have_executed);
  });
  await reopen();
  f = await frame();
  await delay(5100);
  const staleCapture = await helper.call('prepare_input', {
    ...owner,
    input_token: f.input_token,
    point: sourcePoint((await state()).points.button, f),
    action: 'click',
  });
  check('expired image input token refuses pointer movement', () => refused(staleCapture, ['E_STALE_STATE']));
  await reopen();
  proof = await prepare('click', 'button', { role: 'button', name: 'Run search' });
  success(proof);
  before = await state();
  await delay(proof.result.expires_in_ms + 60);
  const expired = await helper.call('commit_input', { ...owner, confirmation_id: proof.result.confirmation_id });
  after = await state();
  check('expired one-shot confirmation refuses dispatch', () => {
    refused(expired, ['E_STALE_STATE']);
    assert.equal(after.clicks, before.clicks);
  });
  await reopen();
  f = await frame();
  before = await state();
  id = randomUUID();
  const eofPending = helper.send({
    op: 'gesture',
    request_id: id,
    ...owner,
    expected_revision: revision,
    input_token: f.input_token,
    surface_id: 'canvas',
    kind: 'drag',
    points: [
      { x: point.x - 20, y: point.y, t_ms: 0 },
      { x: point.x + 20, y: point.y, t_ms: 4000 },
    ],
  });
  pressed = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await state()).input.downs > before.input.downs) {
      pressed = true;
      break;
    }
    await delay(20);
  }
  assert(pressed);
  helper.child.stdin.end();
  const eofResult = await eofPending;
  await delay(60);
  after = await state();
  check('stdin EOF releases an active drag before process exit', () => {
    refused(eofResult, ['E_CANCELLED']);
    assert(after.input.ups > before.input.ups);
  });
  owner = undefined;

  const killedHelper = new Peer(helperPath, [
    ...base,
    '--visual-enabled',
    '--controls-file',
    controls,
    '--interactive-config',
    policy,
  ]);
  helper = killedHelper;
  const killedDiscover = await helper.call('discover');
  success(killedDiscover);
  const killedTarget = killedDiscover.result.targets.find(
    t =>
      t.capture_only &&
      !t.window.minimized &&
      s.points.button.x >= t.window.bounds.x &&
      s.points.button.x < t.window.bounds.x + t.window.bounds.width &&
      s.points.button.y >= t.window.bounds.y &&
      s.points.button.y < t.window.bounds.y + t.window.bounds.height,
  );
  assert(killedTarget);
  const killedOpen = await helper.call('open', { target_id: killedTarget.target_id, mode: 'interactive_desktop' });
  success(killedOpen);
  owner = { target_id: killedTarget.target_id, session_id: killedOpen.result.session_id };
  const killedSnap = await helper.call('snapshot', owner);
  success(killedSnap);
  revision = killedSnap.result.revision;
  const liveFallback = spawnSync(helperPath, ['--release-input'], { encoding: 'utf8', timeout: 5000 });
  check('fallback cannot acquire or release a live helper lease', () => {
    assert.equal(liveFallback.status, 2);
    assert.equal(JSON.parse(liveFallback.stdout).released_input, false);
  });
  f = await frame();
  before = await state();
  const killedPending = helper
    .call('gesture', {
      ...owner,
      expected_revision: revision,
      input_token: f.input_token,
      surface_id: 'canvas',
      kind: 'drag',
      points: [
        { x: point.x - 20, y: point.y, t_ms: 0 },
        { x: point.x + 20, y: point.y, t_ms: 4000 },
      ],
    })
    .catch(() => undefined);
  pressed = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await state()).input.downs > before.input.downs) {
      pressed = true;
      break;
    }
    await delay(20);
  }
  assert(pressed);
  const died = new Promise(resolve => helper.child.once('exit', resolve));
  helper.child.kill('SIGKILL');
  await died;
  await killedPending;
  owner = undefined;
  const fallback = spawnSync(helperPath, ['--release-input'], { encoding: 'utf8', timeout: 5000 });
  await delay(80);
  after = await state();
  check('unexpected helper death is recovered by fixed lease-guarded button-up', () => {
    assert.equal(fallback.status, 0);
    assert.equal(JSON.parse(fallback.stdout).released_input, true);
    assert(after.input.ups > before.input.ups);
  });
  await fixture.send({ op: 'focus-canvas' });
  const keyProbe = new Peer(resolve(root, 'build/adl-macos-recovery-probe'), ['--key0-down']);
  assert((await keyProbe.next()).owned_key0_down);
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await state()).held.key0) break;
    await delay(10);
  }
  assert((await state()).held.key0);
  const keyDied = new Promise(resolve => keyProbe.child.once('exit', resolve));
  keyProbe.child.kill('SIGKILL');
  await keyDied;
  const keyFallback = spawnSync(helperPath, ['--release-input'], { encoding: 'utf8', timeout: 5000 });
  await delay(60);
  check('journalled own key-down survives forced owner death and fixed key-up recovers it', () => {
    assert.equal(keyFallback.status, 0);
    assert.equal(JSON.parse(keyFallback.stdout).released_input, true);
  });
  assert.equal((await state()).held.key0, false);
  console.log(`${checks}/${checks} real macOS synthetic interactive checks passed`);
} finally {
  if (helper && owner) await helper.call('close', owner).catch(() => {});
  if (fixture) await fixture.send({ op: 'quit' }).catch(() => {});
  for (const p of processes) if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM');
  await rm(controls, { force: true });
}
