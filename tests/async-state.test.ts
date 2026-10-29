import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/core.js';
import { parsePolicy } from '../src/policy.js';
import { NativeError, type Adapter, type Target } from '../src/types.js';
function setup() {
  let ready = false,
    writes = 0;
  let timer: NodeJS.Timeout | undefined;
  const adapter: Adapter = {
    open: async () => ({
      snapshot: async () => ({
        fingerprint: String(ready),
        truncated: false,
        elements: [
          { id: 'run', role: 'button', name: 'Find', enabled: true },
          { id: 'status', role: 'status', name: ready ? 'Ready' : 'Pending', enabled: true },
        ],
      }),
      act: async () => {
        writes++;
        timer = setTimeout(() => {
          ready = true;
        }, 25);
      },
      close: async () => {
        clearTimeout(timer);
      },
    }),
    close: async () => {},
  };
  const engine = new Engine(
    parsePolicy({
      browserTargets: [{ id: 'fixture', label: 'Fixture', url: 'https://example.com', classification: 'PUBLIC' }],
    }),
    { browser: adapter },
  );
  return {
    engine,
    change: () => {
      ready = true;
    },
    writes: () => writes,
  };
}
test('read-only batch wait accepts asynchronous UI progress and advances the next mutation revision', async () => {
  const { engine } = setup();
  try {
    const t = (await engine.listTargets()).targets[0] as Target;
    const s = await engine.open(t.target_id);
    const task = engine.execute(
      [
        { session_id: s.session_id, action: 'click', element_id: 'e1' },
        { session_id: s.session_id, action: 'wait_for', role: 'status', name: 'Ready', timeout_ms: 1000 },
        { session_id: s.session_id, action: 'click', element_id: 'e1' },
      ],
      { [s.session_id]: s.revision },
    );
    let state;
    for (let i = 0; i < 200; i++) {
      state = engine.task(task.task_id);
      if (!['queued', 'running'].includes(state.status)) break;
      await delay(5);
    }
    assert.equal(state?.status, 'completed', JSON.stringify(state));
  } finally {
    await engine.shutdown();
  }
});
test('read_state can refresh an outdated revision while mutation still rejects it', async () => {
  const { engine, change, writes } = setup();
  try {
    const t = (await engine.listTargets()).targets[0] as Target;
    const s = await engine.open(t.target_id);
    change();
    const read = await engine.act(s.session_id, { action: 'read_state' }, 1);
    assert.equal(read.revision, 2);
    await assert.rejects(engine.act(s.session_id, { action: 'click', element_id: 'e1' }, 1), { code: 'E_STALE_STATE' });
    assert.equal(writes(), 0);
  } finally {
    await engine.shutdown();
  }
});
test('explicit stale mutation override still blocks after successful asynchronous wait', async () => {
  const { engine, writes } = setup();
  try {
    const t = (await engine.listTargets()).targets[0] as Target;
    const s = await engine.open(t.target_id);
    const task = engine.execute(
      [
        { session_id: s.session_id, action: 'click', element_id: 'e1' },
        { session_id: s.session_id, action: 'wait_for', role: 'status', name: 'Ready', timeout_ms: 1000 },
        { session_id: s.session_id, action: 'click', element_id: 'e1', expected_revision: 1 },
      ],
      { [s.session_id]: 1 },
    );
    let state;
    for (let i = 0; i < 200; i++) {
      state = engine.task(task.task_id);
      if (!['queued', 'running'].includes(state.status)) break;
      await delay(5);
    }
    assert.equal(state?.status, 'failed');
    assert.equal((state?.results[2]?.error as { code: string }).code, 'E_STALE_STATE');
    assert.equal(writes(), 1);
  } finally {
    await engine.shutdown();
  }
});

test('acknowledged mutation followed by failed native readback retains execution uncertainty', async () => {
  let snapshots = 0,
    actions = 0;
  const adapter: Adapter = {
    open: async () => ({
      snapshot: async () => {
        if (++snapshots >= 3) throw new NativeError('E_TARGET_NOT_FOUND', false);
        return {
          fingerprint: 'same',
          truncated: false,
          elements: [{ id: 'go', role: 'button', name: 'Find', enabled: true }],
        };
      },
      act: async () => {
        actions++;
      },
      close: async () => {},
    }),
    close: async () => {},
  };
  const e = new Engine(
    parsePolicy({
      browserTargets: [{ id: 'fixture', label: 'Fixture', url: 'https://example.com', classification: 'PUBLIC' }],
    }),
    { browser: adapter },
  );
  try {
    const s = await e.open((await e.listTargets()).targets[0]!.target_id);
    await assert.rejects(
      e.act(s.session_id, { action: 'click', element_id: 'e1' }, 1),
      error => error instanceof NativeError && error.mayHaveExecuted,
    );
    assert.equal(actions, 1);
  } finally {
    await e.shutdown();
  }
});
