import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotStore } from '../src/snapshot.js';
import type { Element } from '../src/types.js';

// within:<element_id> restricts a scope to the inside of one element.
const page = (): Element[] => [
  { id: 'e1', role: 'heading', name: 'Orders', enabled: true, depth: 2 },
  { id: 'e2', role: 'table', name: '', enabled: true, depth: 2 },
  { id: 'e3', role: 'row', name: 'Ann | Paid', enabled: true, depth: 4, parent_id: 'e2' },
  { id: 'e4', role: 'link', name: 'Ann', enabled: true, depth: 6, parent_id: 'e3', href: '/ann' },
  { id: 'e5', role: 'row', name: 'Bob | Open', enabled: true, depth: 4, parent_id: 'e2' },
  { id: 'e6', role: 'table', name: '', enabled: true, depth: 2 },
  { id: 'e7', role: 'row', name: 'Ann | Late', enabled: true, depth: 4, parent_id: 'e6' },
  { id: 'e8', role: 'region', name: 'Notes', enabled: true, depth: 2 },
  { id: 'e9', role: 'text', name: 'Ann wrote this', enabled: true, depth: 3 },
  { id: 'e10', role: 'button', name: 'Ann export', enabled: true, depth: 3 },
  { id: 'e11', role: 'button', name: 'Outside', enabled: true, depth: 2 },
];
const ids = (r: { elements?: Element[] }): string[] => (r.elements ?? []).map(e => e.id);
const recorded = (elements: Element[] = page()): SnapshotStore => {
  const s = new SnapshotStore();
  s.record('s', 1, { elements, fingerprint: 'a', truncated: false });
  return s;
};
const observe = (s: SnapshotStore, scope: string, extra: Record<string, unknown> = {}) =>
  s.observe('s', 1, { token_budget: 8000, scope, ...extra });

test('within: lists the descendants of one element, not the element itself, and combines with other terms as AND', () => {
  const s = recorded();
  assert.deepEqual(ids(observe(s, 'within:e2')), ['e3', 'e4', 'e5']);
  assert.deepEqual(ids(observe(s, 'within:e6')), ['e7']);
  // Plain text matches elements anywhere; within: keeps only the ones inside the table.
  assert.deepEqual(ids(observe(s, 'Ann')), ['e3', 'e4', 'e7', 'e9', 'e10']);
  assert.deepEqual(ids(observe(s, 'within:e2,Ann')), ['e3', 'e4']);
  assert.deepEqual(ids(observe(s, 'text:ann, within:e2, role:row')), ['e3']);
  // The key and the id are case-insensitive like role:/id:, and a quoted id works.
  assert.deepEqual(ids(observe(s, 'WITHIN:E2')), ['e3', 'e4', 'e5']);
  assert.deepEqual(ids(observe(s, 'within:"e2"')), ['e3', 'e4', 'e5']);
  // Two within: terms are nested containers; an element with no descendants gives an empty page.
  assert.deepEqual(ids(observe(s, 'within:e2,within:e3')), ['e4']);
  assert.deepEqual(ids(observe(s, 'within:e2,within:e6')), []);
  const leaf = observe(s, 'within:e4');
  assert.equal(leaf.ok, true);
  assert.deepEqual(ids(leaf), []);
});

test('within: follows DOM depth for containers without a parent_id chain and parent_id for snapshots without depth', () => {
  // e8 (a region) has no parent_id relation to its children: document order and depth carry it.
  assert.deepEqual(ids(observe(recorded(), 'within:e8')), ['e9', 'e10']);
  // The next element that is not deeper ends the container.
  assert.deepEqual(ids(observe(recorded(), 'within:e9')), []);
  // Without depth only the parent_id chain (table > row > cell) applies.
  const flat = page().map(({ depth: _depth, ...e }) => e);
  const s = recorded(flat);
  assert.deepEqual(ids(observe(s, 'within:e2')), ['e3', 'e4', 'e5']);
  assert.deepEqual(ids(observe(s, 'within:e8')), []);
});

test('within: with an unknown id, an empty id or a snapshot without structure is rejected with a reason', () => {
  const s = recorded();
  assert.throws(() => observe(s, 'within:e999'), { code: 'E_TARGET_NOT_FOUND', reason: 'scope_element_not_found' });
  assert.throws(() => observe(s, 'within:'), { code: 'E_INVALID_ARGUMENT', reason: 'invalid_scope' });
  assert.throws(() => observe(s, 'within:""'), { reason: 'invalid_scope' });
  assert.throws(() => observe(s, 'within:e2,within:nope'), { reason: 'scope_element_not_found' });
  // Desktop snapshots are flat: neither depth nor parent_id.
  const desktop = recorded([
    { id: 'e1', role: 'textbox', name: 'Search', enabled: true },
    { id: 'e2', role: 'button', name: 'Find', enabled: true },
  ]);
  assert.throws(() => observe(desktop, 'within:e1'), {
    code: 'E_UNSUPPORTED_ACTION',
    reason: 'scope_within_unsupported',
  });
  // An unknown prefix is still plain text.
  assert.deepEqual(ids(observe(desktop, 'inside:e1')), []);
});

test('within: pages through a large table by cursor and never returns an element from outside it', () => {
  const rows = (table: string, count: number): Element[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `${table}r${i}`,
      role: 'row',
      name: `Customer ${i} ${'x'.repeat(40)}`,
      enabled: true,
      depth: 4,
      parent_id: table,
    }));
  const s = recorded([
    { id: 'a', role: 'table', name: '', enabled: true, depth: 2 },
    ...rows('a', 60),
    { id: 'b', role: 'table', name: '', enabled: true, depth: 2 },
    ...rows('b', 60),
  ]);
  const seen: string[] = [];
  let p = s.observe('s', 1, { token_budget: 256, scope: 'within:a' });
  let pages = 1;
  assert.equal(p.truncated, true);
  assert.ok(p.next_cursor);
  for (;;) {
    seen.push(...ids(p));
    if (!p.next_cursor) break;
    p = s.observe('s', 1, { token_budget: 256, scope: 'within:a', cursor: p.next_cursor });
    assert.ok(++pages < 100);
  }
  assert.equal(p.truncated, false);
  assert.deepEqual(
    seen,
    rows('a', 60).map(e => e.id),
  );
  // The cursor belongs to the scope that issued it.
  const cursor = s.observe('s', 1, { token_budget: 256, scope: 'within:a' }).next_cursor!;
  assert.throws(() => s.observe('s', 1, { token_budget: 256, scope: 'within:b', cursor }), { code: 'E_STALE_STATE' });
  // A single match inside a large table is one small page.
  const one = s.observe('s', 1, { token_budget: 256, scope: 'within:b,text:"Customer 59 "' });
  assert.deepEqual(ids(one), ['br59']);
  assert.equal(one.truncated, false);
});

test('within: applies to each revision of a delta and works with depth and the lines format', () => {
  const s = recorded();
  const next = page().filter(e => e.id !== 'e5');
  next.splice(4, 0, { id: 'e12', role: 'row', name: 'Cy | New', enabled: true, depth: 4, parent_id: 'e2' });
  next.splice(next.findIndex(e => e.id === 'e7') + 1, 0, {
    id: 'e13',
    role: 'row',
    name: 'Di | New',
    enabled: true,
    depth: 4,
    parent_id: 'e6',
  });
  s.record('s', 2, { elements: next, fingerprint: 'b', truncated: false });
  const delta = s.observe('s', 2, {
    token_budget: 8000,
    since_revision: 1,
    scope: 'within:e2',
    representation: 'delta',
  });
  assert.deepEqual(
    delta.changes?.map(c => `${c.op}:${c.id}`).sort(),
    ['added:e12', 'removed:e5'],
    'only changes inside the table; the row added to the other table is not reported',
  );
  // A container that did not exist in the base revision: everything inside it is new, not an error.
  s.record('s', 3, {
    elements: [
      ...next,
      { id: 'e20', role: 'table', name: '', enabled: true, depth: 2 },
      { id: 'e21', role: 'row', name: 'Eve', enabled: true, depth: 4, parent_id: 'e20' },
    ],
    fingerprint: 'c',
    truncated: false,
  });
  const fresh = s.observe('s', 3, {
    token_budget: 8000,
    since_revision: 2,
    scope: 'within:e20',
    representation: 'delta',
  });
  assert.deepEqual(
    fresh.changes?.map(c => `${c.op}:${c.id}`),
    ['added:e21'],
  );
  // The container must exist in the revision being observed, also for a delta.
  assert.throws(() => s.observe('s', 3, { token_budget: 8000, since_revision: 1, scope: 'within:e5' }), {
    reason: 'scope_element_not_found',
  });
  // depth keeps its meaning (DOM depth of the page) next to within:.
  assert.deepEqual(ids(observe(s, 'within:e2', { depth: 5 })), ['e3', 'e5']);
  const lines = observe(s, 'within:e2', { format: 'lines' });
  assert.equal(lines.lines?.length, 3);
  assert.ok(lines.lines!.every(l => !l.startsWith('e6 ') && !l.startsWith('e7 ')));
  assert.ok(lines.lines![0]!.startsWith('e3 row "Ann | Paid"'));
});
