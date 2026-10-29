import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputProofStore } from '../src/input-proof-store.js';
function setup() {
  let now = 100;
  const store = new InputProofStore({ now: () => now, max_proofs: 2 });
  const data = {
    session_id: 's1',
    native_id: 'native1',
    action: 'fill' as const,
    revision: 1,
    target: { role: 'textbox', name: 'Reference' },
    ttl_ms: 2000,
    started_at: now,
  };
  return {
    store,
    data,
    advance: (n: number) => {
      now += n;
    },
  };
}
test('input confirmation is opaque, session-bound, immutable and one-shot', () => {
  const f = setup();
  const p = f.store.issue(f.data);
  assert.match(p.confirmation_id, /^c_[0-9a-f-]+$/);
  assert.equal(p.expires_in_ms, 2000);
  f.data.target.name = 'Changed';
  assert.throws(() => f.store.consume('other', p.confirmation_id), { code: 'E_TARGET_NOT_FOUND' });
  const got = f.store.consume('s1', p.confirmation_id);
  assert.equal(got.target.name, 'Reference');
  assert.equal(got.native_id, 'native1');
  assert.equal(got.revision, 1);
  assert.throws(() => f.store.consume('s1', p.confirmation_id));
});
test('input confirmation expiry starts before native preparation and respects its issued window', () => {
  const f = setup();
  f.advance(1200);
  const p = f.store.issue(f.data);
  assert.equal(p.expires_in_ms, 800);
  f.advance(801);
  assert.throws(() => f.store.consume('s1', p.confirmation_id), { code: 'E_STALE_STATE' });
  assert.throws(() => f.store.issue(f.data), { code: 'E_STALE_STATE' });
});
test('new preparation invalidates old proof for its own session only', () => {
  const f = setup();
  const a = f.store.issue(f.data),
    b = f.store.issue({ ...f.data, session_id: 's2' });
  const next = f.store.issue({ ...f.data, native_id: 'native2' });
  assert.throws(() => f.store.consume('s1', a.confirmation_id));
  assert.equal(f.store.consume('s2', b.confirmation_id).native_id, 'native1');
  assert.equal(f.store.consume('s1', next.confirmation_id).native_id, 'native2');
});
test('input proofs are bounded; invalidating sessions, expiry and shutdown reclaim them', () => {
  const f = setup();
  f.store.issue(f.data);
  f.store.issue({ ...f.data, session_id: 's2' });
  assert.throws(() => f.store.issue({ ...f.data, session_id: 's3' }), { code: 'E_RESOURCE_LIMIT' });
  f.store.invalidateSession('s1');
  f.store.issue({ ...f.data, session_id: 's3' });
  f.advance(2001);
  f.store.prune();
  const p = f.store.issue({ ...f.data, session_id: 's4', started_at: 2101 });
  f.store.clear();
  assert.throws(() => f.store.consume('s4', p.confirmation_id));
});
test('malformed proofs never enter the store', () => {
  for (const bad of [
    { ttl_ms: 0 },
    { ttl_ms: 30001 },
    { started_at: NaN },
    { started_at: 999 },
    { revision: 0 },
    { native_id: '' },
    { session_id: '' },
    { action: 'delete' },
  ]) {
    const f = setup();
    assert.throws(() => f.store.issue({ ...f.data, ...bad } as typeof f.data), { code: 'E_INVALID_ARGUMENT' });
  }
});
test('AI image inspection can use a 30s confirmation with a monotonic dispatch deadline', () => {
  const f = setup();
  const proof = f.store.issue({ ...f.data, ttl_ms: 30000 });
  f.advance(12000);
  const used = f.store.consume('s1', proof.confirmation_id);
  assert.equal(used.expires_at_ms, 30100);
});
