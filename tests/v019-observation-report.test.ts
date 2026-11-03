import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { assertUrlAllowed, parsePolicy, redactString, redactElement } from '../src/policy.js';
import { SnapshotStore, type ObservationFormat } from '../src/snapshot.js';
import { MAX_DOM_DEPTH, type Element } from '../src/types.js';

const element = (id: string, role: string, name: string, depth = 1): Element => ({
  id,
  role,
  name,
  depth,
  enabled: true,
});

test('main entry point survives a navigation-filled first response in every format and budget', () => {
  const store = new SnapshotStore();
  const elements = [
    element('nav', 'navigation', 'Chapters'),
    ...Array.from({ length: 150 }, (_, i) => element(`n${i}`, 'link', `Chapter ${i} 日本語 ${'x'.repeat(60)}`, 2)),
    element('main', 'main', '本文'),
    element('body', 'text', 'The actual body', 2),
  ];
  store.record('s', 1, { elements, fingerprint: 'one', truncated: false });
  for (const format of ['json', 'compact', 'lines'] as ObservationFormat[]) {
    for (const token_budget of [256, 1800]) {
      const first = store.observe('s', 1, { token_budget, format });
      assert.equal(first.landmarks?.[0]?.id, 'main');
      assert.equal(first.landmarks?.[0]?.role, 'main');
      assert.ok(Buffer.byteLength(JSON.stringify(first)) <= token_budget * 4);
      assert.ok(first.next_cursor);
      assert.equal(first.source_limits, undefined);
      const second = store.observe('s', 1, { token_budget, format, cursor: first.next_cursor });
      assert.equal(second.landmarks, undefined);
      assert.ok(Buffer.byteLength(JSON.stringify(second)) <= token_budget * 4);
    }
  }
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = store.observe('s', 1, { token_budget: 256, ...(cursor ? { cursor } : {}) });
    seen.push(...page.elements!.map(e => e.id));
    cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(
    seen,
    elements.map(e => e.id),
  );
  assert.deepEqual(
    store.observe('s', 1, { token_budget: 256, scope: 'within:main' }).elements?.map(e => e.id),
    ['body'],
  );
  for (const extra of [{ include: ['id'] }, { depth: 64 }, { scope: 'role:main' }, { since_revision: 1 }])
    assert.equal(store.observe('s', 1, { token_budget: 256, ...extra }).landmarks, undefined);
});

test('depth 64 is accepted and source loss is distinct from response paging', () => {
  const store = new SnapshotStore();
  store.record('s', 1, {
    elements: [element('b', 'button', 'Deep', 64)],
    fingerprint: 'f',
    truncated: true,
    source_limits: ['depth_limit'],
  });
  const result = store.observe('s', 1, { token_budget: 256, depth: MAX_DOM_DEPTH });
  assert.equal(result.elements?.[0]?.name, 'Deep');
  assert.deepEqual(result.source_limits, ['depth_limit']);
  assert.equal(result.next_cursor, undefined);
  assert.equal(result.truncated, true);
  assert.throws(() => store.observe('s', 1, { token_budget: 256, depth: MAX_DOM_DEPTH + 1 }), {
    reason: 'invalid_argument',
  });
});

test('public text lengths describe redacted content and short fields omit redundant state', () => {
  const store = new SnapshotStore();
  const name = 'Contact alice@example.com';
  store.record('s', 1, {
    fingerprint: 'f',
    truncated: false,
    elements: [
      { ...element('p', 'text', name), text_length: name.length },
      { ...element('c', 'checkbox', 'Done'), checked: false, value: 'on' },
      { ...element('o', 'option', 'One'), selected: false },
    ],
  });
  const response = store.observe('s', 1, { token_budget: 1800 });
  const [p, c, o] = response.elements!;
  assert.equal(p!.name, redactString(name));
  assert.equal(p!.text_length, undefined);
  assert.equal(c!.value, undefined);
  assert.equal(c!.checked, false);
  assert.equal(o!.selected, undefined);
});

test('Japanese postal addresses and labeled personal names follow the trusted personal-data opt-in', () => {
  const samples = [
    '〒100-0001 東京都千代田区千代田1-1',
    '郵便番号：１００－０００１',
    '住所：東京都千代田区千代田1-1',
    '氏名：山田 太郎',
    'お名前: 佐藤花子',
  ];
  for (const sample of samples) {
    assert.ok(redactString(sample).includes('[redacted]'), sample);
    assert.ok(!redactString(sample).includes('山田'), sample);
    assert.ok(!redactString(sample).includes('100-0001'), sample);
    assert.ok(!redactString(sample).includes('千代田1-1'), sample);
    assert.equal(redactString(sample, true), sample);
  }
  assert.equal(redactString('東京都の天気と氏名の入力方法'), '東京都の天気と氏名の入力方法');
  const field = { ...element('name', 'textbox', '氏名'), value: '山田 太郎', personal: true };
  assert.equal(redactElement(field).value, '[redacted]');
  assert.equal(redactElement(field, true).value, '山田 太郎');
  assert.ok(!('personal' in redactElement(field)));
  assert.equal(
    redactElement({ ...element('title', 'textbox', 'Name'), value: 'Project' }).value,
    'Project',
    'an ambiguous name label keeps its existing ordinary-field behavior',
  );
  assert.equal(redactElement({ ...element('person', 'textbox', 'Full name'), value: 'Ada' }).value, '[redacted]');
});

async function fixture(html: string) {
  const app = createServer((_, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(html);
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 5000,
    operationMode: 'standard',
    browserTargets: [{ id: 'p', label: 'Fixture', url: origin, classification: 'PUBLIC' }],
  });
  const engine = new Engine(policy, { browser: new BrowserAdapter(policy, url => assertUrlAllowed(url, policy)) });
  const opened = await engine.open((await engine.listTargets()).targets[0]!.target_id);
  return {
    engine,
    id: opened.session_id,
    close: async () => {
      await engine.shutdown();
      app.closeAllConnections();
      await new Promise<void>(resolve => app.close(() => resolve()));
    },
  };
}

test(
  'deep modern DOM remains searchable, readable and actionable while source depth stays bounded',
  { timeout: 30000 },
  async () => {
    const deep = (depth: number) =>
      '<div>'.repeat(depth - 1) + `<button type="button">Depth ${depth}</button>` + '</div>'.repeat(depth - 1);
    const f = await fixture([13, 33, 34, 64, 65].map(deep).join(''));
    try {
      const all = await f.engine.observe(f.id, { token_budget: 8000, depth: 64 });
      for (const depth of [13, 33, 34, 64]) assert.ok(all.elements!.some(e => e.name === `Depth ${depth}`));
      assert.ok(!all.elements!.some(e => e.name === 'Depth 65'));
      assert.deepEqual(all.source_limits, ['depth_limit']);
      const scoped = await f.engine.observe(f.id, { scope: 'name:"Depth 33"', depth: 64 });
      assert.equal(scoped.elements!.length, 1);
      assert.equal(scoped.revision, all.revision);
      const read = await f.engine.observe(f.id, { text: { element_id: scoped.elements![0]!.id } });
      assert.equal(read.text?.content, 'Depth 33');
      assert.ok(all.elements!.every(e => !('depth' in e)));
      const action = await f.engine.act(
        f.id,
        { action: 'click', element_id: scoped.elements![0]!.id },
        scoped.revision,
      );
      assert.equal(action.ok, true);
    } finally {
      await f.close();
    }
  },
);

test(
  'a long sidebar exposes a usable main entry point and deep shadow/iframe content',
  { timeout: 30000 },
  async () => {
    const nav =
      '<nav><ul>' +
      Array.from({ length: 150 }, (_, i) => `<li><a href="#main">Chapter ${i}</a></li>`).join('') +
      '</ul></nav>';
    const nested = (body: string) => '<div>'.repeat(33) + body + '</div>'.repeat(33);
    const f =
      await fixture(`<!doctype html>${nav}<main id="main"><h1>The body</h1><p>Useful content after the navigation.</p>
    <div id="shadow"></div></main><iframe srcdoc="${nested('<button>Frame control</button>')}"></iframe>
    <script>document.getElementById('shadow').attachShadow({mode:'open'}).innerHTML=${JSON.stringify(nested('<button>Shadow control</button>'))}</script>`);
    try {
      const first = await f.engine.observe(f.id);
      const main = first.landmarks?.find(e => e.role === 'main');
      assert.ok(main);
      assert.ok(!first.elements!.some(e => e.name === 'Useful content after the navigation.'));
      const read = await f.engine.observe(f.id, { text: { element_id: main.id } });
      assert.ok(read.text?.content.includes('Useful content after the navigation.'));
      const within = await f.engine.observe(f.id, { scope: `within:${main.id}` });
      assert.ok(within.elements!.some(e => e.name === 'Useful content after the navigation.'));
      assert.ok(within.elements!.every(e => !e.name.startsWith('Chapter')));
      for (const name of ['Shadow control', 'Frame control']) {
        const found = await f.engine.observe(f.id, { scope: `name:"${name}"` });
        assert.equal(found.elements!.length, 1, name);
      }
    } finally {
      await f.close();
    }
  },
);

test(
  'assistive labels remain usable while hidden prose never reaches observations or direct reads',
  { timeout: 30000 },
  async () => {
    const f =
      await fixture(`<!doctype html><style>.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}</style>
    <button><span class="sr">Close</span></button><a class="sr" href="#main">Skip to main content</a>
    <span id="label" style="display:none">Named control</span><button aria-labelledby="label"></button>
    <label>氏名<input autocomplete="name" value="山田 太郎"></label>
    <input aria-label="Contact" autocomplete="section-shipping name" value="AUTOCOMPLETE_PERSON_CANARY">
    <label>住所<input autocomplete="street-address" value="東京都千代田区千代田1-1"></label>
    <main id="main"><p>Visible <span style="opacity:0">HIDDEN_BODY_CANARY</span> text</p>
    <a href="#main">Open <span style="font-size:1px">LINK_CANARY</span> now</a>
    <p style="opacity:0">ROOT_CANARY</p><div style="opacity:0"><span>ANCESTOR_CANARY</span></div></main>`);
    try {
      const state = await f.engine.observe(f.id, { token_budget: 8000 });
      const encoded = JSON.stringify(state);
      assert.ok(!encoded.includes('山田') && !encoded.includes('千代田1-1'));
      for (const marker of [
        'HIDDEN_BODY_CANARY',
        'LINK_CANARY',
        'ROOT_CANARY',
        'ANCESTOR_CANARY',
        'AUTOCOMPLETE_PERSON_CANARY',
      ])
        assert.ok(!encoded.includes(marker), marker);
      for (const label of ['Close', 'Skip to main content', 'Named control']) {
        const control = state.elements!.find(e => e.name === label)!;
        assert.ok(control, label);
        assert.equal(control.hidden_text, undefined, label);
      }
      assert.equal(state.elements!.find(e => e.role === 'link' && e.name.startsWith('Open'))?.name, 'Open now');
      const concealed = state.elements!.filter(e => e.name === '' && e.hidden_text);
      assert.ok(concealed.length >= 2);
      for (const entry of concealed) {
        const read = await f.engine.observe(f.id, { text: { element_id: entry.id } });
        assert.equal(read.text?.content, '');
        assert.equal(read.text?.hidden_text, true);
      }
      const main = state.landmarks!.find(e => e.role === 'main')!;
      const read = await f.engine.observe(f.id, { text: { element_id: main.id } });
      assert.ok(read.text?.content.includes('Visible text'));
      assert.ok(!JSON.stringify(read).includes('CANARY'));
    } finally {
      await f.close();
    }
  },
);
