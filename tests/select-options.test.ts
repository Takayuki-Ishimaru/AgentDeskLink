import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Engine } from '../src/core.js';
import { BrowserAdapter } from '../src/browser.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import { chromium } from 'playwright';
import { ensureBrowserPrivacySelectors, privacyMaskSelector } from '../src/browser-privacy.js';

async function fixture(html: string, extra: Record<string, unknown> = {}) {
  const app = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(html);
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    allowedOrigins: [origin],
    allowLoopback: true,
    allowAllOperations: true,
    browserTargets: [{ id: 'f', label: 'Fixture', url: origin, classification: 'PUBLIC' }],
    ...extra,
  });
  const browser = new BrowserAdapter(policy, url => assertUrlAllowed(url, policy));
  const engine = new Engine(policy, { browser });
  try {
    const session = await engine.open('f');
    return {
      engine,
      session,
      browser,
      close: async () => {
        await engine.shutdown();
        app.closeAllConnections();
        await new Promise<void>(resolve => app.close(() => resolve()));
      },
    };
  } catch (error) {
    await engine.shutdown();
    app.closeAllConnections();
    app.close();
    throw error;
  }
}

test(
  'live options search finds choices beyond 100 and distinguishes source and response limits',
  { timeout: 30000 },
  async () => {
    const f = await fixture(
      `<label>項目<select>${Array.from({ length: 150 }, (_, i) => `<option value="v${i}" ${i === 149 ? 'selected' : ''} ${i === 0 ? 'disabled' : ''}>候補${i}</option>`).join('')}</select></label>`,
    );
    try {
      const initial = await f.engine.observe(f.session.session_id, { byte_budget: 32000 });
      const select = initial.elements!.find(e => e.role === 'combobox')!;
      assert.equal(select.options_total, 150);
      assert.deepEqual(select.options_truncation, ['source_limit']);
      assert.equal(select.value, 'v149');
      const found = await f.engine.observe(f.session.session_id, {
        byte_budget: 1024,
        options: { element_id: select.id, query: '候補149' },
      });
      assert.equal(found.options?.matched, 1);
      assert.equal(found.options?.items[0]?.selected, true);
      assert.equal(found.options?.items[0]?.value, 'v149');
      assert.ok(Buffer.byteLength(JSON.stringify(found)) <= 1024);
      const first = await f.engine.observe(f.session.session_id, {
        byte_budget: 32000,
        options: { element_id: select.id, limit: 100 },
      });
      assert.equal(first.options?.total, 150);
      assert.equal(first.options?.next_offset, 100);
      assert.equal(first.options?.items[0]?.disabled, true);
      const last = await f.engine.observe(f.session.session_id, {
        byte_budget: 32000,
        options: { element_id: select.id, offset: 100, limit: 100 },
      });
      assert.equal(last.options?.items.length, 50);
      assert.equal(last.options?.next_offset, null);
      const tiny = await f.engine.observe(f.session.session_id, { byte_budget: 1024, scope: `id:${select.id}` });
      assert.equal(tiny.elements?.[0]?.options_total, 150);
      assert.ok(tiny.elements?.[0]?.options_truncation?.includes('response_budget'));
      assert.equal(tiny.elements?.[0]?.value, 'v149');
      await assert.rejects(f.engine.observe(f.session.session_id, { options: { element_id: select.id, limit: 101 } }), {
        code: 'E_INVALID_ARGUMENT',
      });
      const cancelled = new AbortController();
      cancelled.abort();
      await assert.rejects(
        f.engine.observe(f.session.session_id, { options: { element_id: select.id } }, cancelled.signal),
        { code: 'E_CANCELLED' },
      );
    } finally {
      await f.close();
    }
  },
);

test('option search uses masked labels and values and refuses protected controls', { timeout: 30000 }, async () => {
  const f = await fixture(
    '<select aria-label="色"><option>Password=PRIVATE_CANARY</option><option>Blue</option></select><label>氏名<select><option>架空 表子</option></select></label><div data-adl-sensitive><select aria-label="protected"><option>PROTECTED_CANARY</option></select></div>',
  );
  try {
    const before = await f.engine.observe(f.session.session_id, { byte_budget: 32000 });
    const normal = before.elements!.find(e => e.role === 'combobox' && e.name === '色')!;
    const person = before.elements!.find(e => e.role === 'combobox' && e.name === '氏名')!;
    assert.equal(person.value, '[redacted]');
    assert.equal(person.options?.[0]?.label, '[redacted]');
    assert.equal(person.options?.[0]?.value ?? person.options?.[0]?.label, '[redacted]');
    assert.ok(!JSON.stringify(before).includes('架空'));
    const hidden = await f.engine.observe(f.session.session_id, {
      options: { element_id: normal.id, query: 'PRIVATE_CANARY' },
    });
    assert.equal(hidden.options?.matched, 0);
    const personQuery = await f.engine.observe(f.session.session_id, {
      options: { element_id: person.id, query: '架空' },
    });
    assert.equal(personQuery.options?.matched, 0);
    const list = await f.engine.observe(f.session.session_id, { options: { element_id: normal.id } });
    assert.ok(!JSON.stringify(list).includes('PRIVATE_CANARY'));
    assert.ok(list.options?.items.some(o => o.label === '[redacted]'));
    const protectedSelect = before.elements!.find(e => e.role === 'combobox' && e.protected)!;
    assert.ok(protectedSelect);
    await assert.rejects(f.engine.observe(f.session.session_id, { options: { element_id: protectedSelect.id } }), {
      code: 'E_PRIVACY_BLOCKED',
    });
  } finally {
    await f.close();
  }
});

test('personal select opt-in is consistent between capture and option search', { timeout: 30000 }, async () => {
  const html =
    '<select aria-label="Contact" autocomplete="section-order name"><option value="person-id">架空 表子</option></select>';
  for (const allowPersonalData of [false, true]) {
    const f = await fixture(html, { allowPersonalData });
    try {
      const initial = await f.engine.observe(f.session.session_id);
      const select = initial.elements!.find(e => e.role === 'combobox' && e.name === 'Contact')!;
      assert.equal(select.value, allowPersonalData ? 'person-id' : '[redacted]');
      assert.equal(select.options?.[0]?.label, allowPersonalData ? '架空 表子' : '[redacted]');
      const queried = await f.engine.observe(f.session.session_id, {
        options: { element_id: select.id, query: 'person-id' },
      });
      assert.equal(queried.options?.matched, allowPersonalData ? 1 : 0);
    } finally {
      await f.close();
    }
  }
});

test(
  'Japanese table and definition-list values stay masked in observations and direct reads',
  { timeout: 30000 },
  async () => {
    const f = await fixture(
      '<main aria-label="本文"><table><tr><th>氏名</th><th>状態</th></tr><tr><td><span>架空 表子</span></td><td>完了</td></tr></table><table><tr><th scope="row">住所</th><td>架空住所CANARY</td></tr></table><dl><dt>電話番号</dt><dd>PHONE_CANARY</dd></dl><p>電話番号：090-1234-5678</p><p>電話番号：09012345678</p><p>電話番号：０９０－１２３４－５６７８</p><p>氏名：必須項目です。漢字で入力してください。</p><p>製品番号：123-4567</p><p>東京都内で2026-11-04開催の勉強会</p></main>',
      { allowAllOperations: false, operationMode: 'read_only' },
    );
    try {
      const before = await f.engine.observe(f.session.session_id, { byte_budget: 32000 });
      const serialized = JSON.stringify(before);
      for (const hidden of ['架空 表子', '架空住所CANARY', 'PHONE_CANARY', '5678', '５６７８'])
        assert.ok(!serialized.includes(hidden), hidden);
      assert.ok(serialized.includes('必須項目'));
      assert.ok(serialized.includes('製品番号：123-4567'));
      assert.ok(serialized.includes('2026-11-04'));
      const main = before.elements!.find(e => e.role === 'main')!;
      const text = await f.engine.observe(f.session.session_id, { byte_budget: 32000, text: { element_id: main.id } });
      for (const hidden of ['架空 表子', '架空住所CANARY', 'PHONE_CANARY', '5678', '５６７８'])
        assert.ok(!JSON.stringify(text).includes(hidden), hidden);
      assert.ok(text.text?.content.includes('必須項目'));
      assert.equal(f.browser.startupDiagnostics().first_attempt_succeeded, true);
    } finally {
      await f.close();
    }
  },
);

test(
  'image masks use table and definition labels while retaining Japanese instructions',
  { timeout: 30000 },
  async () => {
    await ensureBrowserPrivacySelectors();
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      ...(process.env.ADL_BROWSER_EXECUTABLE ? { executablePath: process.env.ADL_BROWSER_EXECUTABLE } : {}),
    });
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<table><tr><th>氏名</th><td id="person">架空 表子</td></tr></table><dl><dt>住所</dt><dd id="address">架空住所</dd></dl><p id="instruction">氏名：必須項目です。漢字で入力してください。</p><p id="product">製品番号：123-4567</p>',
      );
      const ids = await page.locator(privacyMaskSelector()).evaluateAll(elements => elements.map(e => e.id));
      assert.ok(ids.includes('person'));
      assert.ok(ids.includes('address'));
      assert.ok(!ids.includes('instruction'));
      assert.ok(!ids.includes('product'));
      const revealed = await page.locator(privacyMaskSelector(true)).evaluateAll(elements => elements.map(e => e.id));
      assert.ok(!revealed.includes('person'));
    } finally {
      await browser.close();
    }
  },
);
