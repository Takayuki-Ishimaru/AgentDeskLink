import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotStore, type ObserveOptions } from '../src/snapshot.js';

test('explicit byte budgets bound Japanese JSON, compact, lines, deltas and cursors', () => {
  const store = new SnapshotStore();
  for (const rev of [1, 2])
    store.record('s', rev, {
      fingerprint: String(rev),
      truncated: false,
      elements: Array.from({ length: 80 }, (_, i) => ({
        id: `e${i}`,
        role: 'button',
        name: `日本語の説明${i}項目${rev}`.repeat(5),
        enabled: true,
      })),
    });
  for (const format of ['json', 'compact', 'lines'] as const) {
    let cursor: string | undefined;
    const ids = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const result = store.observe('s', 2, {
        byte_budget: 1200,
        format,
        ...(cursor ? { cursor } : {}),
      } as ObserveOptions);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1200, `${format} page ${page}`);
      for (const e of result.elements ?? []) ids.add(e.id);
      cursor = result.next_cursor;
      if (!cursor) break;
    }
    if (format !== 'lines') assert.equal(ids.size, 80);
    const delta = store.observe('s', 2, {
      byte_budget: 1400,
      since_revision: 1,
      representation: 'auto',
      format,
    } as ObserveOptions);
    assert.ok(Buffer.byteLength(JSON.stringify(delta)) <= 1400);
  }
});

test('byte_budget is exclusive with token_budget and validates bounds', () => {
  const store = new SnapshotStore();
  store.record('s', 1, { fingerprint: '1', truncated: false, elements: [] });
  for (const byte_budget of [1023, 32001, 1024.5, NaN])
    assert.throws(() => store.observe('s', 1, { byte_budget } as ObserveOptions), { code: 'E_INVALID_ARGUMENT' });
  assert.throws(() => store.observe('s', 1, { byte_budget: 2048, token_budget: 512 } as ObserveOptions), {
    code: 'E_INVALID_ARGUMENT',
  });
  assert.equal(store.observe('s', 1, { byte_budget: 1024 } as ObserveOptions).ok, true);
});
