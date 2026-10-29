import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const cases = JSON.parse(await readFile('native/macos-ax/tests/semantic/cases.json', 'utf8'));
assert.ok(Array.isArray(cases) && cases.length >= 35 && cases.length <= 60);
assert.equal(new Set(cases.map(c => c.name)).size, cases.length);
const point = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const integer = n => Number.isInteger(n) && n >= 0 && n <= 2147483647;
for (const c of cases) {
  assert.ok(c.name && typeof c.expected === 'boolean');
  for (const k of ['before_pid', 'after_pid', 'target', 'own']) assert.ok(integer(c[k]) && c[k] > 0, c.name + ':' + k);
  assert.ok(point(c.before_point) && point(c.after_point));
  assert.ok(
    ['known', 'transient', 'denied'].includes(c.before_focus) &&
      ['known', 'transient', 'denied'].includes(c.after_focus),
  );
  assert.equal(typeof c.focus_equal, 'boolean');
  assert.equal(typeof c.healthy, 'boolean');
  assert.ok(Number.isFinite(c.checkpoint) && Number.isFinite(c.now) && c.now >= c.checkpoint);
  for (const e of [...(c.prior_events ?? []), ...(c.events ?? [])]) {
    assert.ok(integer(e.source) || e.source === -1);
    assert.ok(Number.isFinite(e.at));
    assert.ok(e.point === null || point(e.point));
    assert.equal(typeof e.activation, 'boolean');
  }
}
assert.ok(cases.some(c => c.expected) && cases.some(c => !c.expected));
for (const tag of [
  'pointer',
  'activation',
  'target',
  'monitor',
  'transient',
  'permission',
  'stale',
  'source',
  'rounding',
  'retention',
])
  assert.ok(
    cases.some(c => c.name.includes(tag)),
    tag,
  );
console.log(`${cases.length} semantic regression vectors are valid`);
