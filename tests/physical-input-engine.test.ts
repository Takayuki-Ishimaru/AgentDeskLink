import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { Engine } from '../src/core.js';
import { parsePolicy } from '../src/policy.js';
import { AdlError, type Adapter, type AdapterSession, type Target } from '../src/types.js';
import type { CapturedImage } from '../src/visual-types.js';
import type { GestureReference } from '../src/gesture-types.js';
import type { PreparedInput, PrepareInputRequest } from '../src/physical-input-types.js';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => (resolve = r));
  return { resolve, promise };
}
async function setup(
  options: {
    interactive?: boolean;
    capability?: boolean;
    mode?: 'background_semantic' | 'interactive_desktop';
    open?: boolean;
  } = {},
) {
  const png = await sharp({ create: { width: 320, height: 200, channels: 3, background: { r: 23, g: 67, b: 191 } } })
    .png()
    .toBuffer();
  const state = {
    opens: 0,
    closed: 0,
    closeFinished: false,
    onClose: undefined as (() => Promise<void>) | undefined,
    captures: 0,
    prepares: 0,
    commits: 0,
    gestures: 0,
    semanticActs: 0,
    external: 0,
    onSnapshot: undefined as (() => Promise<void>) | undefined,
    proofCounter: 0,
    tokenCounter: 0,
    target: {
      role: 'textbox',
      name: 'Reference',
      enabled: true,
      focused: true,
      editable: true,
      selection: { start: 2, length: 3 },
    },
    captureError: undefined as AdlError | undefined,
    prepareError: undefined as AdlError | undefined,
    onPrepare: undefined as (() => Promise<void>) | undefined,
    onCommit: undefined as ((signal: AbortSignal) => Promise<void>) | undefined,
    prepareReference: undefined as GestureReference | undefined,
    gestureReference: undefined as GestureReference | undefined,
    committedNative: undefined as string | undefined,
    committedValue: undefined as string | undefined,
    nativeProof: '',
  };
  const target: Target = {
    target_id: 't_fixture_window',
    application_id: 'fixture',
    surface: 'desktop',
    label: 'Synthetic physical fixture',
    policy_class: 'PUBLIC',
    capabilities: [
      'observe',
      'capture',
      'gesture',
      'prepare_input',
      'commit_input',
      ...(options.capability === false ? [] : ['interactive_desktop']),
    ],
    window: {
      bounds: {
        x: 100,
        y: 50,
        width: 320,
        height: 200,
        coordinate_space: process.platform === 'darwin' ? 'desktop_points_top_left' : 'desktop_physical_pixels',
      },
      display_ids: ['display_synthetic'],
      minimized: false,
    },
  };
  const adapter: Adapter = {
    discover: async () => [target],
    open: async (): Promise<AdapterSession> => {
      state.opens++;
      let closed = false;
      return {
        capabilities: options.mode === 'background_semantic' ? ['observe'] : ['observe', 'interactive_desktop'],
        snapshot: async () => {
          await state.onSnapshot?.();
          return {
            fingerprint: String(state.external),
            truncated: false,
            elements: [
              { id: 'e_reference', role: 'textbox', name: 'Reference', enabled: true },
              { id: 'e_inspect', role: 'button', name: 'Inspect', enabled: true },
            ],
          };
        },
        capture: async (): Promise<CapturedImage> => {
          state.captures++;
          if (state.captureError) throw state.captureError;
          return {
            png,
            captured_at: new Date().toISOString(),
            coordinate_space: 'window_pixels',
            viewport: { width: 320, height: 200, scroll_x: 0, scroll_y: 0, device_scale_factor: 1 },
            source_to_desktop: {
              origin_x: 100,
              origin_y: 50,
              scale_x: 1,
              scale_y: 1,
              coordinate_space: process.platform === 'darwin' ? 'desktop_points_top_left' : 'desktop_physical_pixels',
            },
            surface_epoch: 'synthetic-window-generation',
            input_token: `native_frame_${++state.tokenCounter}`,
            redacted: true,
          };
        },
        prepareInput: async (request, reference) => {
          state.prepares++;
          state.prepareReference = reference;
          await state.onPrepare?.();
          if (state.prepareError) throw state.prepareError;
          if (
            request.expected_target &&
            ((request.expected_target.role !== undefined && request.expected_target.role !== state.target.role) ||
              (request.expected_target.name !== undefined && request.expected_target.name !== state.target.name))
          )
            throw new AdlError('E_STALE_STATE');
          state.nativeProof = `native_private_confirmation_${++state.proofCounter}`;
          return {
            confirmation_id: state.nativeProof,
            expires_in_ms: 30000,
            action: request.action,
            target: { ...state.target },
            pointer_on_target: true,
            focus_matches_target: state.target.focused,
          } satisfies PreparedInput;
        },
        commitInput: async (id, value, signal) => {
          state.commits++;
          state.committedNative = id;
          state.committedValue = value;
          await state.onCommit?.(signal);
          return {
            released_input: true,
            action: value === undefined ? 'click' : 'fill',
            verified: 'input_sequence_completed',
          };
        },
        gesture: async (plan, reference) => {
          state.gestures++;
          state.gestureReference = reference;
          return {
            released_input: true,
            kind: plan.kind,
            points_executed: plan.points.length,
            verified: 'input_sequence_completed',
            input_backend: plan.kind === 'drag' ? 'mouse_drag' : 'scroll_swipe',
          };
        },
        act: async () => {
          state.semanticActs++;
        },
        close: async () => {
          if (!closed) {
            closed = true;
            state.closed++;
            await state.onClose?.();
            state.closeFinished = true;
          }
        },
      };
    },
    close: async () => {},
  };
  const config = {
    helperPath: '/synthetic/helper',
    appId: 'fixture',
    appPath: '/synthetic/app',
    controlsPath: '/synthetic/controls',
    classification: 'PUBLIC',
    visual: { enabled: true, allowUnredacted: true, maskRegions: [] },
    interactive: {
      enabled: options.interactive !== false,
      surfaces: [
        {
          id: 'board',
          region: { x: 0, y: 0, width: 320, height: 200 },
          kinds: ['drag', 'swipe'],
          swipe_backend: 'scroll',
        },
      ],
    },
  };
  const policy = parsePolicy({ macos: config, windows: config });
  const engine = new Engine(policy, { browser: adapter, desktop: adapter });
  await engine.listTargets('desktop');
  const session =
    options.open === false ? undefined : await engine.open(target.target_id, options.mode ?? 'interactive_desktop');
  const capture = async () => engine.capture(session!.session_id);
  const request = async (action: 'click' | 'fill' = 'click', include_image = false): Promise<PrepareInputRequest> => {
    const frame = await capture();
    return {
      frame_id: frame.metadata.frame_id,
      expected_revision: frame.metadata.revision,
      action,
      point: { x: 160, y: 100 },
      expected_target: { role: state.target.role, name: state.target.name },
      include_image,
    };
  };
  const prepare = async (action: 'click' | 'fill' = 'click', include_image = false) =>
    engine.prepareInput(session!.session_id, await request(action, include_image));
  return { engine, state, target, session, capture, request, prepare };
}

test(
  'interactive desktop is explicit, requires local opt-in/capability, and has one exclusive lease',
  { timeout: 5000 },
  async () => {
    for (const option of [{ interactive: false }, { capability: false }]) {
      const f = await setup({ ...option, open: false });
      try {
        await assert.rejects(f.engine.open(f.target.target_id, 'interactive_desktop'));
        assert.equal(f.state.opens, 0);
      } finally {
        await f.engine.shutdown();
      }
    }
    const f = await setup();
    try {
      await assert.rejects(f.engine.open(f.target.target_id, 'interactive_desktop'), { code: 'E_INTERFERENCE_RISK' });
      assert.equal(f.state.opens, 1);
      await f.engine.close(f.session!.session_id);
      const next = await f.engine.open(f.target.target_id, 'interactive_desktop');
      assert.equal(next.mode, 'interactive_desktop');
      assert.equal(f.state.opens, 2);
    } finally {
      await f.engine.shutdown();
    }
  },
);
test(
  'background sessions cannot prepare, commit, or perform physical desktop gestures',
  { timeout: 5000 },
  async () => {
    const f = await setup({ mode: 'background_semantic' });
    try {
      const request = await f.request();
      await assert.rejects(f.engine.prepareInput(f.session!.session_id, request), { code: 'E_UNSUPPORTED_ACTION' });
      await assert.rejects(f.engine.commitInput(f.session!.session_id, { confirmation_id: 'c_unavailable' }), {
        code: 'E_UNSUPPORTED_ACTION',
      });
      await assert.rejects(
        f.engine.gesture(f.session!.session_id, {
          frame_id: request.frame_id,
          expected_revision: request.expected_revision,
          surface_id: 'board',
          kind: 'drag',
          points: [
            { x: 10, y: 10, t_ms: 0 },
            { x: 30, y: 30, t_ms: 100 },
          ],
        }),
        { code: 'E_INTERFERENCE_RISK' },
      );
      assert.equal(f.state.prepares + f.state.commits + f.state.gestures, 0);
    } finally {
      await f.engine.shutdown();
    }
  },
);
test(
  'prepare reports actual control/focus plus surrounding source crop, and hides native proof identity',
  { timeout: 5000 },
  async () => {
    const f = await setup();
    try {
      const prepared = await f.prepare('fill', true);
      assert.equal(prepared.metadata.ok, true);
      assert.equal(prepared.metadata.session_id, f.session!.session_id);
      assert.deepEqual(prepared.metadata.target, f.state.target);
      assert.equal(prepared.metadata.pointer_on_target, true);
      assert.equal(prepared.metadata.focus_matches_target, true);
      assert.match(prepared.metadata.confirmation_id, /^c_[0-9a-f-]+$/i);
      assert.ok(prepared.metadata.expires_in_ms > 25000 && prepared.metadata.expires_in_ms <= 30000);
      assert.ok(!JSON.stringify(prepared).includes(f.state.nativeProof));
      assert.equal(f.state.commits, 0);
      assert.equal(f.state.prepareReference?.coordinate_space, 'window_pixels');
      assert.match(f.state.prepareReference?.input_token ?? '', /^native_frame_/);
      assert.ok(prepared.image);
      assert.deepEqual(prepared.image!.metadata.region, { x: 32, y: 4, width: 256, height: 192 });
      assert.equal((await sharp(prepared.image!.png).metadata()).width, 256);
    } finally {
      await f.engine.shutdown();
    }
  },
);
test(
  'commit consumes only its own opaque proof once and forwards native identity internally',
  { timeout: 5000 },
  async () => {
    const f = await setup();
    try {
      const prepared = await f.prepare('click');
      const background = await f.engine.open(f.target.target_id, 'background_semantic');
      await assert.rejects(
        f.engine.commitInput(background.session_id, { confirmation_id: prepared.metadata.confirmation_id }),
      );
      assert.equal(f.state.commits, 0);
      const output = await f.engine.commitInput(f.session!.session_id, {
        confirmation_id: prepared.metadata.confirmation_id,
      });
      assert.equal(output.metadata.input.action, 'click');
      assert.equal(output.metadata.input.released_input, true);
      assert.equal(f.state.committedNative, f.state.nativeProof);
      assert.ok(!JSON.stringify(output.metadata).includes(f.state.nativeProof));
      await assert.rejects(
        f.engine.commitInput(f.session!.session_id, { confirmation_id: prepared.metadata.confirmation_id }),
      );
      assert.equal(f.state.commits, 1);
    } finally {
      await f.engine.shutdown();
    }
  },
);
test(
  'expired proof never dispatches physical input even while the session remains valid',
  { timeout: 5000 },
  async () => {
    const originalDate = Date.now,
      ownNow = Object.getOwnPropertyDescriptor(performance, 'now'),
      startDate = Date.now(),
      startMono = performance.now();
    let advance = 0;
    Date.now = () => startDate + advance;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => startMono + advance });
    let f: Awaited<ReturnType<typeof setup>> | undefined;
    try {
      f = await setup();
      const prepared = await f.prepare();
      advance = 31000;
      await assert.rejects(
        f.engine.commitInput(f.session!.session_id, { confirmation_id: prepared.metadata.confirmation_id }),
      );
      assert.equal(f.state.commits, 0);
      assert.equal((await f.engine.observe(f.session!.session_id)).ok, true);
    } finally {
      Date.now = originalDate;
      if (ownNow) Object.defineProperty(performance, 'now', ownNow);
      else delete (performance as any).now;
      await f?.engine.shutdown();
    }
  },
);
test(
  'revision changes invalidate prepared intent before native input and preserve the ordinary session',
  { timeout: 5000 },
  async () => {
    const f = await setup();
    try {
      const prepared = await f.prepare();
      f.state.external++;
      await assert.rejects(
        f.engine.commitInput(f.session!.session_id, { confirmation_id: prepared.metadata.confirmation_id }),
        { code: 'E_STALE_STATE' },
      );
      assert.equal(f.state.commits, 0);
      assert.equal(f.state.closed, 0);
      await assert.rejects(
        f.engine.commitInput(f.session!.session_id, { confirmation_id: prepared.metadata.confirmation_id }),
      );
    } finally {
      await f.engine.shutdown();
    }
  },
);
test('new preparation and physical gesture invalidate earlier confirmations', { timeout: 5000 }, async () => {
  const f = await setup();
  try {
    const first = await f.prepare(),
      second = await f.prepare();
    await assert.rejects(
      f.engine.commitInput(f.session!.session_id, { confirmation_id: first.metadata.confirmation_id }),
    );
    const third = await f.prepare();
    await assert.rejects(
      f.engine.commitInput(f.session!.session_id, { confirmation_id: second.metadata.confirmation_id }),
    );
    const frame = await f.capture();
    await f.engine.gesture(f.session!.session_id, {
      frame_id: frame.metadata.frame_id,
      expected_revision: frame.metadata.revision,
      surface_id: 'board',
      kind: 'drag',
      points: [
        { x: 10, y: 10, t_ms: 0 },
        { x: 30, y: 30, t_ms: 100 },
      ],
    });
    await assert.rejects(
      f.engine.commitInput(f.session!.session_id, { confirmation_id: third.metadata.confirmation_id }),
    );
    assert.equal(f.state.commits, 0);
    assert.equal(f.state.gestures, 1);
    assert.match(f.state.gestureReference?.input_token ?? '', /^native_frame_/);
  } finally {
    await f.engine.shutdown();
  }
});
test(
  'click values, missing fill values and control characters cannot dispatch physical input',
  { timeout: 5000 },
  async () => {
    const f = await setup();
    try {
      for (const [action, value] of [
        ['click', 'unexpected'],
        ['fill', undefined],
        ['fill', 'abc\nxyz'],
        ['fill', 'abc\txyz'],
        ['fill', 'abc\u0000xyz'],
      ] as const) {
        const prepared = await f.prepare(action);
        await assert.rejects(
          f.engine.commitInput(f.session!.session_id, {
            confirmation_id: prepared.metadata.confirmation_id,
            ...(value !== undefined ? { value } : {}),
          }),
          { code: 'E_INVALID_ARGUMENT' },
        );
      }
      assert.equal(f.state.commits, 0);
      const prepared = await f.prepare('fill');
      await f.engine.commitInput(f.session!.session_id, {
        confirmation_id: prepared.metadata.confirmation_id,
        value: 'Hello 世界',
      });
      assert.equal(f.state.committedValue, 'Hello 世界');
      assert.equal(f.state.commits, 1);
    } finally {
      await f.engine.shutdown();
    }
  },
);
test(
  'password and consequential confirmed targets remain forbidden for physical click/fill',
  { timeout: 5000 },
  async () => {
    const f = await setup();
    try {
      for (const [action, name] of [
        ['fill', 'Password'],
        ['click', 'Pay now'],
        ['click', 'Delete account'],
      ] as const) {
        f.state.target.name = name;
        const prepared = await f.prepare(action);
        await assert.rejects(
          f.engine.commitInput(f.session!.session_id, {
            confirmation_id: prepared.metadata.confirmation_id,
            ...(action === 'fill' ? { value: 'untrusted-secret' } : {}),
          }),
        );
      }
      assert.equal(f.state.commits, 0);
    } finally {
      await f.engine.shutdown();
    }
  },
);
test('ordinary expected-target mismatch preserves session and sends no commit', { timeout: 5000 }, async () => {
  const f = await setup();
  try {
    const request = await f.request();
    await assert.rejects(
      f.engine.prepareInput(f.session!.session_id, {
        ...request,
        expected_target: { role: 'button', name: 'Unexpected' },
      }),
      { code: 'E_STALE_STATE' },
    );
    assert.equal(f.state.closed, 0);
    assert.equal(f.state.commits, 0);
    assert.equal((await f.engine.observe(f.session!.session_id)).ok, true);
    const background = await f.engine.open(f.target.target_id, 'background_semantic');
    const observed = await f.engine.observe(background.session_id);
    await assert.rejects(
      f.engine.act(
        background.session_id,
        { action: 'click', element_id: 'e2', expected_target: { role: 'button', name: 'Different intent' } },
        observed.revision,
      ),
      { code: 'E_STALE_STATE' },
    );
    assert.equal(f.state.semanticActs, 0);
    assert.equal(f.state.closed, 0);
  } finally {
    await f.engine.shutdown();
  }
});
test(
  'prepare rejects historical/latest mismatches and wrong revision before native pointer inspection',
  { timeout: 5000 },
  async () => {
    const f = await setup();
    try {
      const old = await f.capture(),
        latest = await f.capture();
      await assert.rejects(
        f.engine.prepareInput(f.session!.session_id, {
          frame_id: old.metadata.frame_id,
          expected_revision: old.metadata.revision,
          action: 'click',
          point: { x: 160, y: 100 },
        }),
        { code: 'E_STALE_STATE' },
      );
      await assert.rejects(
        f.engine.prepareInput(f.session!.session_id, {
          frame_id: latest.metadata.frame_id,
          expected_revision: latest.metadata.revision + 1,
          action: 'click',
          point: { x: 160, y: 100 },
        }),
        { code: 'E_STALE_STATE' },
      );
      assert.equal(f.state.prepares, 0);
    } finally {
      await f.engine.shutdown();
    }
  },
);
test(
  'failed prepared image leaves no usable confirmation and preserves a retryable session',
  { timeout: 5000 },
  async () => {
    const f = await setup();
    try {
      const request = await f.request('click', true);
      f.state.captureError = new AdlError('E_PRIVACY_BLOCKED');
      await assert.rejects(f.engine.prepareInput(f.session!.session_id, request), { code: 'E_PRIVACY_BLOCKED' });
      await assert.rejects(f.engine.commitInput(f.session!.session_id, { confirmation_id: f.state.nativeProof }));
      assert.equal(f.state.commits, 0);
      assert.equal(f.state.closed, 0);
      f.state.captureError = undefined;
      const retry = await f.prepare();
      await f.engine.commitInput(f.session!.session_id, { confirmation_id: retry.metadata.confirmation_id });
      assert.equal(f.state.commits, 1);
    } finally {
      await f.engine.shutdown();
    }
  },
);
test(
  'late cancellation after commit dispatch reports uncertainty, closes session and suppresses late frame retention',
  { timeout: 5000 },
  async () => {
    const f = await setup(),
      entered = deferred(),
      release = deferred(),
      cancel = new AbortController();
    f.state.onCommit = async () => {
      entered.resolve();
      await release.promise;
    };
    try {
      const frame = await f.capture(),
        prepared = await f.prepare();
      const committing = f.engine.commitInput(
        f.session!.session_id,
        { confirmation_id: prepared.metadata.confirmation_id },
        cancel.signal,
      );
      const rejected = assert.rejects(
        committing,
        (e: unknown) => e instanceof AdlError && e.code === 'E_CANCELLED' && e.mayHaveExecuted,
      );
      await entered.promise;
      cancel.abort();
      await rejected;
      assert.equal(f.state.closed, 1);
      release.resolve();
      await delay(10);
      await assert.rejects(f.engine.capture(f.session!.session_id, { frame_id: frame.metadata.frame_id }), {
        code: 'E_TARGET_NOT_FOUND',
      });
      assert.equal(f.state.commits, 1);
    } finally {
      release.resolve();
      await f.engine.shutdown();
    }
  },
);
test(
  'failure to capture after completed physical input reports partial execution and invalidates session',
  { timeout: 5000 },
  async () => {
    const f = await setup();
    try {
      const prepared = await f.prepare();
      f.state.onCommit = async () => {
        f.state.captureError = new AdlError('E_PRIVACY_BLOCKED');
      };
      await assert.rejects(
        f.engine.commitInput(f.session!.session_id, { confirmation_id: prepared.metadata.confirmation_id }),
        (e: unknown) => e instanceof AdlError && e.code === 'E_PRIVACY_BLOCKED' && e.mayHaveExecuted,
      );
      assert.equal(f.state.commits, 1);
      assert.equal(f.state.closed, 1);
      await assert.rejects(f.engine.observe(f.session!.session_id), { code: 'E_TARGET_NOT_FOUND' });
    } finally {
      await f.engine.shutdown();
    }
  },
);

test(
  'cancelled preparation reports that physical pointer movement may already have occurred',
  { timeout: 5000 },
  async () => {
    const f = await setup(),
      entered = deferred(),
      release = deferred(),
      cancel = new AbortController();
    f.state.onPrepare = async () => {
      entered.resolve();
      await release.promise;
    };
    try {
      const request = await f.request();
      const preparing = f.engine.prepareInput(f.session!.session_id, request, cancel.signal);
      const rejected = assert.rejects(
        preparing,
        (e: unknown) => e instanceof AdlError && e.code === 'E_CANCELLED' && e.mayHaveExecuted,
      );
      await entered.promise;
      cancel.abort();
      await rejected;
      assert.equal(f.state.closed, 1);
      release.resolve();
      await delay(10);
      await assert.rejects(f.engine.observe(f.session!.session_id), { code: 'E_TARGET_NOT_FOUND' });
    } finally {
      release.resolve();
      await f.engine.shutdown();
    }
  },
);
test(
  'physical cancellation waits for bounded adapter release acknowledgement before returning',
  { timeout: 5000 },
  async () => {
    const f = await setup(),
      entered = deferred(),
      release = deferred(),
      cancel = new AbortController();
    f.state.onCommit = async () => {
      entered.resolve();
      await release.promise;
    };
    f.state.onClose = async () => {
      await delay(1250);
    };
    try {
      const prepared = await f.prepare();
      const committing = f.engine.commitInput(
        f.session!.session_id,
        { confirmation_id: prepared.metadata.confirmation_id },
        cancel.signal,
      );
      const rejected = assert.rejects(
        committing,
        (e: unknown) => e instanceof AdlError && e.code === 'E_CANCELLED' && e.mayHaveExecuted,
      );
      await entered.promise;
      cancel.abort();
      await rejected;
      assert.equal(f.state.closeFinished, true, 'physical input cleanup must finish before the cancellation reply');
    } finally {
      release.resolve();
      await delay(1300);
      await f.engine.shutdown();
    }
  },
);

test(
  'interactive sessions require prepared physical writes while observation still works',
  { timeout: 5000 },
  async () => {
    const f = await setup();
    try {
      const observed = await f.engine.observe(f.session!.session_id);
      await assert.rejects(
        f.engine.act(f.session!.session_id, { action: 'click', element_id: 'e2' }, observed.revision),
        { code: 'E_UNSUPPORTED_ACTION' },
      );
      assert.equal(f.state.semanticActs, 0);
      assert.equal((await f.engine.act(f.session!.session_id, { action: 'read_state' }, observed.revision)).ok, true);
    } finally {
      await f.engine.shutdown();
    }
  },
);
test(
  'wrong proof session does not consume a confirmation belonging to the active lease',
  { timeout: 5000 },
  async () => {
    const f = await setup();
    try {
      const prepared = await f.prepare();
      const other = await f.engine.open(f.target.target_id, 'background_semantic');
      await assert.rejects(
        f.engine.commitInput(other.session_id, { confirmation_id: prepared.metadata.confirmation_id }),
      );
      await f.engine.commitInput(f.session!.session_id, { confirmation_id: prepared.metadata.confirmation_id });
      assert.equal(f.state.commits, 1);
    } finally {
      await f.engine.shutdown();
    }
  },
);
test(
  'failed input commit is one-shot even when native preflight rejected before dispatch',
  { timeout: 5000 },
  async () => {
    const f = await setup();
    try {
      const prepared = await f.prepare();
      f.state.onCommit = async () => {
        throw new AdlError('E_FOCUS_CHANGED');
      };
      await assert.rejects(
        f.engine.commitInput(f.session!.session_id, { confirmation_id: prepared.metadata.confirmation_id }),
        { code: 'E_FOCUS_CHANGED' },
      );
      await assert.rejects(
        f.engine.commitInput(f.session!.session_id, { confirmation_id: prepared.metadata.confirmation_id }),
      );
      assert.equal(f.state.commits, 1);
    } finally {
      await f.engine.shutdown();
    }
  },
);

test(
  'fill preparation may be unfocused while still requiring an enabled editable target',
  { timeout: 5000 },
  async () => {
    const f = await setup();
    try {
      f.state.target.focused = false;
      const prepared = await f.prepare('fill');
      assert.equal(prepared.metadata.focus_matches_target, false);
      await f.engine.commitInput(f.session!.session_id, {
        confirmation_id: prepared.metadata.confirmation_id,
        value: 'Approved text',
      });
      assert.equal(f.state.commits, 1);
      for (const field of ['enabled', 'editable'] as const) {
        f.state.target[field] = false;
        await assert.rejects(f.prepare('fill'), { code: 'E_STALE_STATE' });
        f.state.target[field] = true;
      }
      assert.equal(f.state.commits, 1);
    } finally {
      await f.engine.shutdown();
    }
  },
);
test(
  'confirmation expiry is rechecked after awaited refresh immediately before dispatch',
  { timeout: 5000 },
  async () => {
    const own = Object.getOwnPropertyDescriptor(performance, 'now'),
      base = performance.now();
    let advance = 0;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => base + advance });
    let f: Awaited<ReturnType<typeof setup>> | undefined;
    try {
      f = await setup();
      const prepared = await f.prepare();
      f.state.onSnapshot = async () => {
        advance = 30001;
      };
      await assert.rejects(
        f.engine.commitInput(f.session!.session_id, { confirmation_id: prepared.metadata.confirmation_id }),
        { code: 'E_STALE_STATE' },
      );
      assert.equal(f.state.commits, 0);
      assert.equal(f.state.closed, 0);
    } finally {
      if (own) Object.defineProperty(performance, 'now', own);
      else delete (performance as any).now;
      await f?.engine.shutdown();
    }
  },
);
test('plain physical fill is bounded by UTF8 bytes, not only string length', { timeout: 5000 }, async () => {
  const f = await setup();
  try {
    const prepared = await f.prepare('fill');
    await assert.rejects(
      f.engine.commitInput(f.session!.session_id, {
        confirmation_id: prepared.metadata.confirmation_id,
        value: '界'.repeat(1366),
      }),
      { code: 'E_INVALID_ARGUMENT' },
    );
    assert.equal(f.state.commits, 0);
  } finally {
    await f.engine.shutdown();
  }
});
test('unverifiable physical cleanup quarantines the engine before another operation', { timeout: 5000 }, async () => {
  const f = await setup();
  try {
    const prepared = await f.prepare();
    f.state.onCommit = async () => {
      const error = new AdlError('E_PARTIAL_EXECUTION');
      error.mayHaveExecuted = true;
      throw error;
    };
    f.state.onClose = async () => {
      throw new AdlError('E_BACKEND_UNAVAILABLE');
    };
    await assert.rejects(
      f.engine.commitInput(f.session!.session_id, { confirmation_id: prepared.metadata.confirmation_id }),
      (e: unknown) => e instanceof AdlError && e.mayHaveExecuted,
    );
    await assert.rejects(f.engine.listTargets('desktop'), { code: 'E_CANCELLED' });
    assert.equal(f.state.closed, 1);
    assert.equal(f.state.commits, 1);
  } finally {
    await f.engine.shutdown();
  }
});
