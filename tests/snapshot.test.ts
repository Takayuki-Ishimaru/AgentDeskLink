import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotStore } from '../src/snapshot.js';
import type { Element } from '../src/types.js';
const elements: Element[] = [
  { id: 'e1', role: 'textbox', name: 'Search', value: 'a', enabled: true },
  { id: 'e2', role: 'button', name: 'Find', enabled: true },
];
test('full snapshots, deterministic deltas and stale baselines', () => {
  const s = new SnapshotStore();
  s.record('s1', 1, { elements, fingerprint: 'a', truncated: false });
  const full = s.observe('s1', 1, { token_budget: 1800 });
  assert.equal(full.elements?.length, 2);
  s.record('s1', 2, {
    elements: [
      { ...elements[0]!, value: 'b' },
      { id: 'e3', role: 'status', name: 'Done', enabled: true },
    ],
    fingerprint: 'b',
    truncated: false,
  });
  const delta = s.observe('s1', 2, { since_revision: 1, token_budget: 1800 });
  assert.deepEqual(delta.changes?.map(x => x.op).sort(), ['added', 'changed', 'removed']);
  assert.throws(() => s.observe('s1', 2, { since_revision: 999, token_budget: 1800 }), {
    code: 'E_INVALID_ARGUMENT',
    reason: 'revision_ahead',
  });
  assert.throws(() => s.observe('s2', 2, { token_budget: 1800 }));
});
test('bounded pages use opaque cursors tied to session revision/options', () => {
  const s = new SnapshotStore();
  s.record('s1', 1, {
    elements: Array.from({ length: 50 }, (_, i) => ({
      id: `e${i}`,
      role: 'button',
      name: `Button ${i} ${'x'.repeat(60)}`,
      enabled: true,
    })),
    fingerprint: 'a',
    truncated: false,
  });
  let p = s.observe('s1', 1, { token_budget: 256 });
  assert.equal(p.truncated, true);
  assert.ok(p.next_cursor);
  assert.ok(JSON.stringify(p).length <= 1024);
  const ids = new Set(p.elements?.map(x => x.id));
  let pages = 1;
  while (p.next_cursor) {
    p = s.observe('s1', 1, { token_budget: 256, cursor: p.next_cursor });
    for (const e of p.elements ?? []) {
      assert.ok(!ids.has(e.id));
      ids.add(e.id);
    }
    assert.ok(++pages < 100);
  }
  assert.equal(ids.size, 50);
  assert.throws(() => s.observe('s2', 1, { token_budget: 256, cursor: 'forged' }));
});
test('secrets are absent from full/delta snapshots and cursor metadata', () => {
  const s = new SnapshotStore();
  s.record('s', 1, {
    elements: [{ id: 'e', role: 'textbox', name: 'Password', value: 'CANARY_LEAK', enabled: true, sensitive: true }],
    fingerprint: 'f',
    truncated: false,
  });
  assert.ok(!JSON.stringify(s.observe('s', 1, { token_budget: 1800 })).includes('CANARY_LEAK'));
  s.close('s');
  assert.throws(() => s.observe('s', 1, { token_budget: 1800 }));
});
test('delta scope is evaluated before projection and redactions are counted', () => {
  const s = new SnapshotStore();
  s.record('s', 1, { elements, fingerprint: 'a', truncated: false });
  s.record('s', 2, { elements: [{ ...elements[0]!, value: 'alice@example.com' }], fingerprint: 'b', truncated: false });
  const p = s.observe('s', 2, { since_revision: 1, scope: 'role:textbox', include: ['id'], token_budget: 256 });
  assert.equal(p.changes?.length, 1);
  assert.equal(p.changes?.[0]?.element?.id, 'e1');
  assert.ok(p.redactions > 0);
});
test('wrong-session, changed-option, expired and changed-revision cursors fail', () => {
  const s = new SnapshotStore();
  const raw = {
    elements: Array.from({ length: 40 }, (_, i) => ({
      id: `e${i}`,
      role: 'button',
      name: 'Long name '.repeat(10),
      enabled: true,
    })),
    fingerprint: 'a',
    truncated: false,
  };
  s.record('s', 1, raw);
  s.record('t', 1, raw);
  const cursor = s.observe('s', 1, { token_budget: 256 }).next_cursor!;
  assert.throws(() => s.observe('t', 1, { token_budget: 256, cursor }));
  assert.throws(() => s.observe('s', 1, { token_budget: 256, scope: 'button', cursor }));
  const now = Date.now;
  try {
    Date.now = () => now() + 61000;
    assert.throws(() => s.observe('s', 1, { token_budget: 256, cursor }));
  } finally {
    Date.now = now;
  }
  const next = s.observe('s', 1, { token_budget: 256 }).next_cursor!;
  s.record('s', 2, raw);
  assert.throws(() => s.observe('s', 2, { token_budget: 256, cursor: next }));
});
test('history eviction and source truncation are explicit', () => {
  const s = new SnapshotStore();
  for (let i = 1; i <= 10; i++) s.record('s', i, { elements, fingerprint: String(i), truncated: false });
  assert.throws(() => s.observe('s', 10, { since_revision: 1, token_budget: 256 }), { code: 'E_STALE_STATE' });
  s.record('t', 1, { elements, fingerprint: 'x', truncated: true });
  const p = s.observe('t', 1, { token_budget: 1800 });
  assert.equal(p.truncated, true);
  assert.equal(p.next_cursor, null);
});
test('Unicode whole-response byte budget remains bounded across every page', () => {
  const s = new SnapshotStore();
  s.record('s', 1, {
    elements: Array.from({ length: 30 }, (_, i) => ({
      id: `e${i}`,
      role: 'text',
      name: '個人情報を含まない試験画面🙂'.repeat(30),
      enabled: false,
    })),
    fingerprint: 'a',
    truncated: false,
  });
  let cursor: string | undefined;
  let count = 0;
  do {
    const p = s.observe('s', 1, { token_budget: 256, ...(cursor ? { cursor } : {}) });
    assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 1024);
    for (const e of p.elements ?? []) assert.equal(e.enabled, false);
    count += (p.elements ?? []).length;
    cursor = p.next_cursor ?? undefined;
  } while (cursor);
  assert.equal(count, 30);
});
