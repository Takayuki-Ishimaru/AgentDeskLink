import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { AliasMap, ALIAS_CAP } from '../src/aliases.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import type { Adapter, DesktopConfig, Target, Element } from '../src/types.js';

const ALIAS = /^e[1-9][0-9]*$/;
const PAGES: Record<string, string> = {
  '/': '<!doctype html><ul><li><a href="/two">Next page</a></li><li>Item</li></ul><form><input aria-label="Query"><button type="button">Go</button></form><p>Long text paragraph for reading.</p>',
  '/two': '<!doctype html><button type="button">Second page button</button><input aria-label="Other">',
};
async function setup(extra: Record<string, unknown> = {}) {
  const app = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(PAGES[req.url ?? '/'] ?? PAGES['/']);
  });
  await new Promise<void>(r => app.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    allowedOrigins: [origin],
    allowLoopback: true,
    allowAllOperations: true,
    actionTimeoutMs: 5000,
    browserTargets: [{ id: 't', label: 'Fixture', url: origin, classification: 'PUBLIC' }],
    ...extra,
  });
  const engine = new Engine(policy, { browser: new BrowserAdapter(policy, url => assertUrlAllowed(url, policy)) });
  const session = await engine.open((await engine.listTargets()).targets[0]!.target_id);
  return {
    engine,
    session,
    id: session.session_id,
    origin,
    close: async () => {
      await engine.shutdown();
      app.closeAllConnections();
      await new Promise<void>(r => app.close(() => r()));
    },
  };
}
const find = (els: Element[] | undefined, name: string) => {
  const e = els!.find(x => x.name === name);
  assert.ok(e, name);
  return e;
};
async function finish(engine: Engine, taskId: string) {
  for (let i = 0; i < 200; i++) {
    const t = engine.task(taskId) as { status: string };
    if (!['queued', 'running'].includes(t.status)) return t;
    await delay(25);
  }
  throw new Error('task did not finish');
}

test(
  'browser observations expose short session aliases for ids and parent ids in every format',
  { timeout: 20000 },
  async () => {
    const f = await setup();
    try {
      const json = await f.engine.observe(f.id, { token_budget: 8000 });
      assert.ok(json.elements!.length > 5);
      for (const e of json.elements!) {
        assert.match(e.id, ALIAS);
        if (e.parent_id !== undefined) {
          assert.match(e.parent_id, ALIAS);
          assert.ok(json.elements!.some(p => p.id === e.parent_id));
        }
      }
      assert.ok(json.elements!.some(e => e.parent_id !== undefined));
      const lines = await f.engine.observe(f.id, { token_budget: 8000, format: 'lines' });
      assert.ok(
        lines.lines!.every(l => /^"e[0-9]+" /.test(l)),
        lines.lines!.join('\n'),
      );
      const compact = await f.engine.observe(f.id, { token_budget: 8000, format: 'compact' });
      assert.ok(compact.elements!.every(e => ALIAS.test(e.id)));
      assert.deepEqual(
        compact.elements!.map(e => e.id),
        json.elements!.map(e => e.id),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'every id input translates aliases and refuses internal or unknown ids with E_TARGET_NOT_FOUND',
  { timeout: 30000 },
  async () => {
    const f = await setup();
    try {
      const view = await f.engine.observe(f.id, { token_budget: 8000 });
      const query = find(view.elements, 'Query'),
        go = find(view.elements, 'Go'),
        para = find(view.elements, 'Long text paragraph for reading.');
      const filled = await f.engine.act(f.id, { action: 'fill', element_id: query.id, value: 'hello' }, view.revision);
      assert.equal(filled.ok, true);
      const after = await f.engine.observe(f.id, { token_budget: 8000 });
      assert.equal(find(after.elements, 'Query').value, 'hello');
      for (const bad of ['e9999', 'x', '5nNuHi6eOPcW-1', '__proto__'])
        await assert.rejects(
          f.engine.act(f.id, { action: 'click', element_id: bad }, after.revision),
          { code: 'E_TARGET_NOT_FOUND' },
          bad,
        );
      // wait condition.element_id, directly and through the wait_for action
      assert.equal((await f.engine.wait(f.id, { element_id: go.id }, 2000)).matched, true);
      await assert.rejects(f.engine.wait(f.id, { element_id: 'e9999' }, 500), { code: 'E_TARGET_NOT_FOUND' });
      await assert.rejects(f.engine.act(f.id, { action: 'wait_for', element_id: 'e9999' }, after.revision), {
        code: 'E_TARGET_NOT_FOUND',
      });
      assert.equal((await f.engine.act(f.id, { action: 'wait_for', element_id: go.id }, after.revision)).ok, true);
      // observe text.element_id returns the alias and refuses others
      const text = await f.engine.observe(f.id, { text: { element_id: para.id, length: 100 } });
      assert.equal(text.text!.element_id, para.id);
      assert.match(text.text!.content, /Long text/);
      await assert.rejects(f.engine.observe(f.id, { text: { element_id: 'e9999' } }), { code: 'E_TARGET_NOT_FOUND' });
      // scope id:/element_id: terms use the alias
      for (const term of [`id:${go.id}`, `element_id:${go.id}`]) {
        const scoped = await f.engine.observe(f.id, { token_budget: 8000, scope: term });
        assert.deepEqual(
          scoped.elements!.map(e => e.name),
          ['Go'],
          term,
        );
      }
      assert.equal((await f.engine.observe(f.id, { token_budget: 8000, scope: 'id:e9999' })).elements!.length, 0);
      // execute steps
      const task = f.engine.execute(
        [
          { session_id: f.id, action: 'fill', element_id: query.id, value: 'batch' },
          { session_id: f.id, action: 'wait_for', element_id: go.id },
        ],
        { [f.id]: after.revision },
      );
      assert.equal((await finish(f.engine, task.task_id)).status, 'completed');
      const bad = f.engine.execute([{ session_id: f.id, action: 'click', element_id: 'e9999' }], {
        [f.id]: (await f.engine.observe(f.id, { token_budget: 8000 })).revision,
      });
      assert.equal((await finish(f.engine, bad.task_id)).status, 'failed');
    } finally {
      await f.close();
    }
  },
);

test(
  'aliases are never reused across navigation and an old alias cannot reach the new document',
  { timeout: 30000 },
  async () => {
    const f = await setup();
    try {
      const first = await f.engine.observe(f.id, { token_budget: 8000 });
      const oldIds = new Set(first.elements!.map(e => e.id));
      const oldGo = find(first.elements, 'Go');
      await f.engine.act(f.id, { action: 'navigate', url: `${f.origin}/two` }, first.revision);
      await f.engine.wait(f.id, { name: 'Second page button' }, 5000);
      const second = await f.engine.observe(f.id, { token_budget: 8000 });
      for (const e of second.elements!) assert.ok(!oldIds.has(e.id), `${e.id} was issued for the previous document`);
      const num = (id: string) => Number(id.slice(1));
      assert.ok(Math.min(...second.elements!.map(e => num(e.id))) > Math.max(...[...oldIds].map(num)));
      // the old alias stays bound to its old internal id: stale/not found, never another element
      await assert.rejects(f.engine.act(f.id, { action: 'click', element_id: oldGo.id }, second.revision), {
        code: 'E_TARGET_NOT_FOUND',
      });
      await assert.rejects(f.engine.observe(f.id, { text: { element_id: oldGo.id } }), { code: 'E_TARGET_NOT_FOUND' });
      await assert.rejects(f.engine.act(f.id, { action: 'click', element_id: oldGo.id }, first.revision), {
        code: 'E_STALE_STATE',
      });
      assert.equal((await f.engine.wait(f.id, { element_id: oldGo.id, state: 'hidden' }, 1500)).matched, true);
      const third = await f.engine.observe(f.id, { token_budget: 8000 });
      assert.deepEqual(
        third.elements!.map(e => e.id),
        second.elements!.map(e => e.id),
      );
    } finally {
      await f.close();
    }
  },
);

test('deltas, cursors and since_revision keep working with aliases', { timeout: 30000 }, async () => {
  const f = await setup();
  try {
    const base = await f.engine.observe(f.id, { token_budget: 8000 });
    const query = find(base.elements, 'Query');
    await f.engine.act(f.id, { action: 'fill', element_id: query.id, value: 'delta' }, base.revision);
    const now = await f.engine.observe(f.id, {
      token_budget: 8000,
      since_revision: base.revision,
      representation: 'delta',
    });
    assert.equal(now.representation, 'delta');
    assert.ok(now.changes!.length >= 1 && now.changes!.every(c => ALIAS.test(c.id)));
    const changed = now.changes!.find(c => c.id === query.id);
    assert.equal(changed?.op, 'changed');
    assert.equal(changed?.element?.value, 'delta');
    const withDiff = await f.engine.act(
      f.id,
      { action: 'fill', element_id: query.id, value: 'diff', include_diff: true },
      now.revision,
    );
    const obs = (withDiff as { observation?: unknown }).observation as {
      changes?: { id: string }[];
      elements?: { id: string }[];
    };
    assert.ok([...(obs.changes ?? []), ...(obs.elements ?? [])].every(c => ALIAS.test(c.id)));
    // cursors page through lines with aliases and reconstruct the full list
    const current = await f.engine.observe(f.id, { token_budget: 8000 });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i++) {
      const page = await f.engine.observe(f.id, { token_budget: 300, format: 'lines', ...(cursor ? { cursor } : {}) });
      for (const line of page.lines!) {
        const m = /^"(e[0-9]+)"/.exec(line);
        assert.ok(m, line);
        seen.push(m[1]!);
      }
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    assert.deepEqual(
      seen,
      current.elements!.map(e => e.id),
    );
    assert.ok(seen.length > 5);
  } finally {
    await f.close();
  }
});

test('alias maps are per session and a closed session no longer resolves anything', { timeout: 30000 }, async () => {
  const f = await setup();
  try {
    const a = await f.engine.observe(f.id, { token_budget: 8000 });
    const other = await f.engine.open((await f.engine.listTargets()).targets[0]!.target_id);
    const b = await f.engine.observe(other.session_id, { token_budget: 8000 });
    assert.equal(a.elements![0]!.id, 'e1');
    assert.equal(b.elements![0]!.id, 'e1');
    await f.engine.close(other.session_id);
    await assert.rejects(f.engine.observe(other.session_id, { token_budget: 8000 }), { code: 'E_TARGET_NOT_FOUND' });
  } finally {
    await f.close();
  }
});

test('desktop sessions expose aliases while the native adapter keeps native ids', { timeout: 10000 }, async () => {
  const APP = 'com.example.native';
  const nativeIds = ['AX:window/0', 'AX:window/0/button[3]', 'AX:window/0/field[7]'];
  const acted: (string | undefined)[] = [];
  let tick = 0;
  const target = {
    target_id: 't_win1',
    surface: 'desktop',
    application_id: APP,
    label: 'App',
    policy_class: 'PUBLIC',
    capabilities: ['observe', 'click', 'fill', 'select', 'check', 'scroll', 'read_state', 'wait_for'],
  } as unknown as Target;
  const desktop = {
    discover: async () => [{ ...target }],
    close: async () => {},
    desktopCapabilities: () => ({ available: true, mutations: true, lifecycle: false }),
    open: async () => ({
      snapshot: async () => ({
        fingerprint: 'd' + tick,
        truncated: false,
        elements: [
          { id: nativeIds[0], role: 'window', name: 'Main', enabled: true },
          { id: nativeIds[1], role: 'button', name: 'Save', enabled: true, parent_id: nativeIds[0] },
          {
            id: nativeIds[2],
            role: 'textbox',
            name: 'Title',
            enabled: true,
            value: String(tick),
            parent_id: nativeIds[0],
          },
        ],
      }),
      act: async (a: { element_id?: string }) => {
        acted.push(a.element_id);
        tick++;
      },
      close: async () => {},
    }),
  } as unknown as Adapter;
  const browser = {
    open: async () => {
      throw new Error('unused');
    },
    close: async () => {},
  } as unknown as Adapter;
  const policy = parsePolicy({
    allowAllOperations: true,
    windows: {
      helperPath: 'C:/helper.exe',
      appId: APP,
      appPath: 'C:/app.exe',
      classification: 'PUBLIC',
    } as unknown as DesktopConfig,
  });
  const engine = new Engine(policy, { browser, desktop }, 'win32');
  try {
    const t = (await engine.listTargets()).targets.find(x => x.surface === 'desktop')!;
    const s = await engine.open(t.target_id, 'background_semantic');
    const view = await engine.observe(s.session_id, { token_budget: 8000 });
    assert.deepEqual(
      view.elements!.map(e => e.id),
      ['e1', 'e2', 'e3'],
    );
    assert.deepEqual(
      view.elements!.map(e => e.parent_id),
      [undefined, 'e1', 'e1'],
    );
    await assert.rejects(engine.act(s.session_id, { action: 'click', element_id: nativeIds[1]! }, view.revision), {
      code: 'E_TARGET_NOT_FOUND',
    });
    assert.deepEqual(acted, []);
    const r = await engine.act(s.session_id, { action: 'click', element_id: 'e2' }, view.revision);
    assert.equal(r.ok, true);
    assert.deepEqual(acted, [nativeIds[1]]);
    const next = await engine.observe(s.session_id, {
      token_budget: 8000,
      since_revision: view.revision,
      representation: 'delta',
    });
    assert.deepEqual(
      next.changes!.map(c => c.id),
      ['e3'],
    );
    assert.equal(next.changes![0]!.element!.parent_id, 'e1');
  } finally {
    await engine.shutdown();
  }
});

test('AliasMap never reissues an alias, even after eviction beyond the cap, and keeps retained aliases', () => {
  const map = new AliasMap();
  const snap = (ids: string[]) => ({
    fingerprint: 'x',
    truncated: false,
    elements: ids.map(id => ({ id, role: 'button', name: id, enabled: true })),
  });
  const issued = new Set<string>();
  const first = map.project(snap(['doc1-0', 'doc1-1']), () => new Set());
  assert.deepEqual(
    first.elements.map(e => e.id),
    ['e1', 'e2'],
  );
  assert.equal(map.resolve('e1'), 'doc1-0');
  assert.equal(map.resolve('doc1-0'), undefined);
  const again = map.project(snap(['doc1-1', 'doc1-0']), () => new Set());
  assert.deepEqual(
    again.elements.map(e => e.id),
    ['e2', 'e1'],
  );
  const big = map.project(snap(Array.from({ length: ALIAS_CAP - 1 }, (_, i) => `doc2-${i}`)), () => new Set(['e1']));
  big.elements.forEach(e => {
    assert.ok(!issued.has(e.id));
    issued.add(e.id);
  });
  assert.equal(map.resolve('e1'), 'doc1-0', 'retained alias survives eviction');
  assert.equal(map.resolve('e2'), undefined, 'unretained old alias is evicted and stops resolving');
  assert.equal(map.size, ALIAS_CAP);
  const hard = map.project(snap(Array.from({ length: ALIAS_CAP }, (_, i) => `doc3-${i}`)), () => new Set(['e1']));
  hard.elements.forEach(e => {
    assert.ok(!issued.has(e.id));
    issued.add(e.id);
  });
  assert.ok(map.size <= ALIAS_CAP, 'the hard cap also evicts retained aliases, oldest first');
  assert.equal(map.resolve('e1'), undefined);
  const later = map.project(snap(['doc1-1']), () => new Set());
  assert.ok(
    !issued.has(later.elements[0]!.id) && later.elements[0]!.id !== 'e2',
    'an evicted internal id gets a fresh alias, never the old one',
  );
});
