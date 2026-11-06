import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core.js';
import { parsePolicy } from '../src/policy.js';
import { SnapshotStore } from '../src/snapshot.js';
import type { Action, Adapter, NetworkWarning, RawSnapshot } from '../src/types.js';

// The engine side of "warnings cover only the operation that produced them": a fake browser adapter that keeps a block sequence number, scopes
// the blocks of an action's window to its result (AdapterActResult.blocks) and forgets what an observation delivered (acknowledgeWarnings).
type Block = NetworkWarning & { seq: number };
type ActResult = {
  ok: boolean;
  revision: number;
  network_blocked?: boolean;
  subresources_blocked?: number;
  write_blocked?: boolean;
  warnings?: NetworkWarning[];
  observation?: Record<string, unknown>;
};
const write: NetworkWarning = { code: 'method_requires_approval', count: 1, method: 'POST', resource_type: 'fetch' };
const sheet: NetworkWarning = { code: 'origin_not_allowed', count: 2, method: 'GET', resource_type: 'stylesheet' };

async function fixture(options: { legacy?: boolean; acknowledge?: boolean; elements?: number } = {}) {
  const state = {
    seq: 0,
    /** Blocks outside any action: every snapshot carries them until an observation delivered them. */
    unreported: [] as Block[],
    /** Blocks the next action's window collects. */
    next: [] as NetworkWarning[],
    acks: [] as number[],
    /** Legacy adapters: every block ever recorded, merged by class, never forgotten. */
    history: [] as NetworkWarning[],
  };
  const elements = Array.from({ length: options.elements ?? 3 }, (_, i) => ({
    id: i === 0 ? 'go' : `item-${i}`,
    role: i === 0 ? 'button' : 'listitem',
    name: i === 0 ? 'Go' : `Item number ${i} with a reasonably long accessible name`,
    enabled: true,
  }));
  const adapter: Adapter = {
    open: async () => ({
      snapshot: async (): Promise<RawSnapshot> => ({
        fingerprint: `f${state.seq}`,
        truncated: false,
        elements,
        // Like the browser adapter, the freshness of an action does not depend on the blocks: a late block does not make the agent's revision stale.
        actionEvidence: { navigation: 'document-1', elements: { go: 'go-v1' } },
        ...(options.legacy
          ? state.history.length
            ? { warnings: state.history.map(w => ({ ...w })) }
            : {}
          : {
              ...(state.unreported.length ? { warnings: state.unreported.map(({ seq: _seq, ...w }) => w) } : {}),
              warningSeq: state.seq,
            }),
      }),
      act: async (_action, _signal, dispatch) => {
        dispatch?.();
        const blocks = state.next;
        state.next = [];
        state.seq += blocks.length;
        if (options.legacy) {
          for (const block of blocks) {
            const same = state.history.find(
              w => w.code === block.code && w.method === block.method && w.resource_type === block.resource_type,
            );
            if (same) same.count += block.count;
            else state.history.push({ ...block });
          }
          return undefined;
        }
        return { blocks };
      },
      ...(options.acknowledge === false || options.legacy
        ? {}
        : {
            acknowledgeWarnings: (upTo: number) => {
              state.acks.push(upTo);
              state.unreported = state.unreported.filter(b => b.seq > upTo);
            },
          }),
      close: async () => {},
    }),
    close: async () => {},
  };
  const policy = parsePolicy({
    allowAllOperations: true,
    allowLoopback: true,
    browserTargets: [{ id: 't', label: 'T', url: 'http://127.0.0.1:8123/', classification: 'PUBLIC' }],
  });
  const engine = new Engine(policy, { browser: adapter });
  const session = await engine.open((await engine.listTargets()).targets[0]!.target_id);
  const id = session.session_id;
  const revision = async () => (await engine.observe(id)).revision;
  /** The revision the agent last saw, without observing (an observation would deliver the warnings the test wants to see later). */
  const known = () => engine.listSessions().sessions.find(s => s.session_id === id)!.revision;
  return {
    engine,
    id,
    state,
    /** A block outside any action (a timer, a late response): reported by the next observation, once. */
    background: (warning: NetworkWarning) => {
      state.seq++;
      state.unreported.push({ ...warning, seq: state.seq });
    },
    /** The next action's window collects these. */
    during: (...warnings: NetworkWarning[]) => {
      state.next.push(...warnings);
    },
    click: async (extra: Partial<Action> = {}) =>
      (await engine.act(id, { action: 'click', element_id: 'e1', ...extra } as Action, known())) as ActResult,
    revision,
    known,
    close: () => engine.shutdown(),
  };
}

test('report once: an observation delivers a block that happened between actions, and the next one does not repeat it', async () => {
  const f = await fixture();
  try {
    const before = await f.revision();
    f.background(write);
    const first = await f.engine.observe(f.id);
    assert.deepEqual(first.warnings, [write]);
    assert.equal(first.revision, before + 1, 'a new block is a new revision');
    const second = await f.engine.observe(f.id);
    assert.equal(second.warnings, undefined);
    assert.equal(second.revision, first.revision, 'reporting never changes the revision');
    assert.equal((await f.engine.observe(f.id)).warnings, undefined);
    assert.deepEqual(f.state.acks, [1], 'the adapter forgot the block up to the snapshot that carried it');
    // The next block is reported once as well, and only itself.
    f.background({ ...sheet, count: 1 });
    const third = await f.engine.observe(f.id);
    assert.deepEqual(third.warnings, [{ ...sheet, count: 1 }]);
    assert.equal(third.revision, first.revision + 1);
    assert.equal((await f.engine.observe(f.id)).warnings, undefined);
    assert.deepEqual(f.state.acks, [1, 2]);
    // An observation without warnings acknowledges nothing.
    await f.engine.observe(f.id);
    assert.deepEqual(f.state.acks, [1, 2]);
  } finally {
    await f.close();
  }
});

test('action scope: a result carries exactly the blocks of its own window; older blocks wait for the next observation', async () => {
  const f = await fixture();
  try {
    f.background(sheet);
    f.during(write);
    const result = await f.click();
    assert.deepEqual(result.warnings, [write], 'not the earlier block');
    assert.equal(result.network_blocked, true);
    assert.equal(result.write_blocked, true);
    assert.equal(result.subresources_blocked, undefined);
    // The window's block was delivered with the action; the observation reports only what happened outside it.
    const observed = await f.engine.observe(f.id);
    assert.deepEqual(observed.warnings, [sheet]);
    assert.equal((await f.engine.observe(f.id)).warnings, undefined);
    // An action without blocks says nothing, whatever happened before.
    f.background(sheet);
    const quiet = await f.click();
    assert.equal(quiet.warnings, undefined);
    assert.equal(quiet.network_blocked, undefined);
    assert.equal(quiet.write_blocked, undefined);
    assert.deepEqual((await f.engine.observe(f.id)).warnings, [sheet]);
  } finally {
    await f.close();
  }
});

test('include_diff keeps the warnings in the action result, not in its nested observation', async () => {
  const f = await fixture();
  try {
    f.during(write);
    const result = await f.click({ include_diff: true });
    assert.deepEqual(result.warnings, [write]);
    assert.ok(result.observation);
    assert.equal('warnings' in result.observation!, false);
    assert.equal(
      (await f.engine.observe(f.id)).warnings,
      undefined,
      'the window block was not copied into the page-level list',
    );
  } finally {
    await f.close();
  }
});

test('action result fields: network_blocked / subresources_blocked / write_blocked and their order', async () => {
  const f = await fixture();
  try {
    f.during(write, sheet);
    const both = await f.click({ include_diff: true });
    assert.deepEqual(Object.keys(both), [
      'ok',
      'revision',
      'audit_id',
      'network_blocked',
      'subresources_blocked',
      'write_blocked',
      'save',
      'warnings',
      'observation',
    ]);
    assert.equal(both.subresources_blocked, 2);
    // A blocked stylesheet alone is neither a network block of the action nor a write.
    f.during(sheet);
    const asset = await f.click();
    assert.equal(asset.network_blocked, undefined);
    assert.equal(asset.write_blocked, undefined);
    assert.equal(asset.subresources_blocked, 2);
    // A blocked read the action started is a network block but not a write.
    f.during({ code: 'origin_not_allowed', count: 1, method: 'GET', resource_type: 'fetch' });
    const read = await f.click();
    assert.equal(read.network_blocked, true);
    assert.equal(read.write_blocked, undefined);
    // A write is a write whatever the resource type (a beacon, an image ping).
    for (const resource_type of ['image', 'other', 'xhr']) {
      f.during({ code: 'method_requires_approval', count: 1, method: 'PUT', resource_type });
      const ping = await f.click();
      assert.equal(ping.write_blocked, true, resource_type);
      assert.equal(ping.network_blocked, true, resource_type);
    }
  } finally {
    await f.close();
  }
});

test('cursor pages after the first one do not repeat the warnings', async () => {
  const f = await fixture({ elements: 60 });
  try {
    f.background(write);
    f.background({ ...sheet, count: 1 });
    const first = await f.engine.observe(f.id, { token_budget: 256 });
    assert.equal(first.warnings?.length, 2);
    assert.ok(first.next_cursor, 'the observation spans several pages');
    let page = first,
      pages = 1;
    while (page.next_cursor) {
      page = await f.engine.observe(f.id, { token_budget: 256, cursor: page.next_cursor });
      assert.equal(page.warnings, undefined, `page ${pages + 1}`);
      assert.equal(page.revision, first.revision);
      pages++;
    }
    assert.ok(pages > 2);
    // Starting again at the same revision does not repeat them either.
    const again = await f.engine.observe(f.id, { token_budget: 256 });
    assert.equal(again.warnings, undefined);
    assert.equal(again.revision, first.revision);
  } finally {
    await f.close();
  }
});

test('revision stability: delivering warnings never changes the revision, a new block does', async () => {
  const f = await fixture();
  try {
    const start = await f.revision();
    f.background(write);
    const revisions = [];
    for (let i = 0; i < 4; i++) revisions.push((await f.engine.observe(f.id)).revision);
    assert.deepEqual(revisions, [start + 1, start + 1, start + 1, start + 1]);
    f.background(write);
    assert.equal(await f.revision(), start + 2);
    assert.equal(await f.revision(), start + 2);
    // since_revision deltas carry the unreported warnings of the current revision once.
    f.background(sheet);
    const delta = await f.engine.observe(f.id, { since_revision: start + 2 });
    assert.deepEqual(delta.warnings, [sheet]);
    assert.equal(delta.revision, start + 3);
    assert.equal((await f.engine.observe(f.id, { since_revision: start + 2 })).warnings, undefined);
  } finally {
    await f.close();
  }
});

test('adl_execute steps carry only their own blocks', async () => {
  const f = await fixture();
  try {
    f.during(write);
    const started = f.engine.execute(
      [
        { session_id: f.id, action: 'click', element_id: 'e1' },
        { session_id: f.id, action: 'click', element_id: 'e1' },
      ],
      { [f.id]: f.known() },
    );
    let task = f.engine.task(started.task_id);
    for (; task.status === 'queued' || task.status === 'running'; task = f.engine.task(started.task_id))
      await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(task.status, 'completed');
    const [first, second] = task.results as ActResult[];
    assert.deepEqual(first!.warnings, [write]);
    assert.equal(first!.write_blocked, true);
    assert.equal(second!.warnings, undefined, 'the second step does not repeat the first one');
    assert.equal(second!.network_blocked, undefined);
    assert.equal(second!.write_blocked, undefined);
  } finally {
    await f.close();
  }
});

test('adapters without per-action blocks: the growth of the snapshot warnings is what an action reports', async () => {
  const f = await fixture({ legacy: true });
  try {
    f.during(write);
    const first = await f.click();
    assert.deepEqual(first.warnings, [write]);
    assert.equal(first.network_blocked, true);
    assert.equal(first.write_blocked, true);
    // The snapshot still carries the old block; an action that blocked nothing new reports nothing.
    const quiet = await f.click();
    assert.equal(quiet.warnings, undefined);
    assert.equal(quiet.network_blocked, undefined);
    assert.equal(quiet.write_blocked, undefined);
    // The same class again is reported by what is new, not by the total.
    f.during(write, sheet);
    const second = await f.click();
    assert.deepEqual(second.warnings, [{ ...write, count: 1 }, sheet]);
    assert.equal(second.subresources_blocked, 2);
    assert.equal(second.write_blocked, true);
    // Observations still show the warnings once (the engine keeps them from repeating; such adapters cannot forget blocks).
    const observed = await f.engine.observe(f.id);
    assert.equal(observed.warnings?.length, 2);
    assert.equal((await f.engine.observe(f.id)).warnings, undefined);
  } finally {
    await f.close();
  }
});

test('an adapter that cannot acknowledge warnings still reports them once per observation', async () => {
  const f = await fixture({ acknowledge: false });
  try {
    f.background(write);
    const first = await f.engine.observe(f.id);
    assert.deepEqual(first.warnings, [write]);
    const second = await f.engine.observe(f.id);
    assert.equal(second.warnings, undefined);
    assert.equal(second.revision, first.revision);
    assert.deepEqual(f.state.acks, []);
  } finally {
    await f.close();
  }
});

test('SnapshotStore.markWarningsDelivered removes the warnings of the named revision only', () => {
  const store = new SnapshotStore();
  const snapshot = (fingerprint: string): RawSnapshot => ({
    fingerprint,
    truncated: false,
    elements: [{ id: 'a', role: 'button', name: 'A', enabled: true }],
    url: 'https://example.com/',
    warnings: [write],
  });
  store.record('s', 1, snapshot('one'));
  store.record('s', 2, snapshot('two'));
  const options = { token_budget: 2000, element_limit: 100 };
  assert.deepEqual(store.observe('s', 2, options).warnings, [write]);
  store.markWarningsDelivered('s', 2);
  const delivered = store.observe('s', 2, options);
  assert.equal(delivered.warnings, undefined);
  assert.equal(delivered.url, 'https://example.com/', 'everything else stays');
  assert.deepEqual(store.observe('s', 1, options).warnings, [write], 'an older revision is not touched');
  assert.equal(store.observe('s', 2, { ...options, since_revision: 1 }).warnings, undefined);
  // Unknown sessions and revisions are ignored.
  store.markWarningsDelivered('missing', 2);
  store.markWarningsDelivered('s', 9);
  assert.deepEqual(store.observe('s', 1, options).warnings, [write]);
});
