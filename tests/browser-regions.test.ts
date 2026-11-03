import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import { safeError, AdlError } from '../src/types.js';

type Page = string | { html: string };
interface Options {
  operationMode?: 'read_only' | 'standard' | 'ask';
  allowPersonalData?: boolean;
}
/** The parts of an action result these tests read. */
type ActResult = { revision: number; warnings?: { code: string; count: number; message?: string }[] };

async function fixture(pages: Record<string, Page>, options: Options = {}) {
  const app = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]!;
    const page = pages[path] ?? pages['/'] ?? '';
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(typeof page === 'string' ? page : page.html);
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 5000,
    operationMode: options.operationMode ?? 'standard',
    browserTargets: [{ id: 'p', label: 'Fixture', url: origin + '/', classification: 'PUBLIC', controls: [] }],
  });
  if (options.allowPersonalData) policy.allowPersonalData = true;
  const engine = new Engine(policy, {
    browser: new BrowserAdapter(policy, (url, purpose) => assertUrlAllowed(url, policy, undefined, purpose)),
  });
  const opened = await engine.open((await engine.listTargets()).targets[0]!.target_id);
  const id = opened.session_id;
  return {
    engine,
    id,
    origin,
    observe: (extra: Parameters<Engine['observe']>[1] = {}) => engine.observe(id, { token_budget: 8000, ...extra }),
    act: async (action: Parameters<Engine['act']>[1], revision: number) =>
      (await engine.act(id, action, revision)) as ActResult,
    read: (element_id: string, offset = 0, length = 8192) =>
      engine.observe(id, { token_budget: 8000, text: { element_id, offset, length } }),
    close: async () => {
      await engine.shutdown();
      app.closeAllConnections();
      await new Promise<void>(resolve => app.close(() => resolve()));
    },
  };
}

const rows = (count: number, prefix = 'Customer') =>
  Array.from({ length: count }, (_, i) => `<tr><td>${prefix} ${i}</td><td>Plan ${i}</td></tr>`).join('');

test('within: searches inside one table of a real page, through paging and deltas', { timeout: 120000 }, async () => {
  const html = `<!doctype html><title>Customers</title><h1>Customers</h1>
<table aria-label="Active"><tbody id="active">${rows(400)}</tbody></table>
<table aria-label="Archived"><tbody>${rows(30)}</tbody></table>
<section aria-label="Billing"><button>Save</button><button>Cancel</button></section>
<section aria-label="Shipping"><button>Save</button></section>
<button onclick="const r = document.getElementById('active').insertRow(); r.insertCell().textContent = 'Customer new'; r.insertCell().textContent = 'Plan new';">Add row</button>`;
  const f = await fixture({ '/': html, '/other': '<h1>Other</h1>' });
  try {
    const tables = (await f.observe({ scope: 'role:table' })).elements!;
    const active = tables.find(e => e.name === 'Active')!,
      archived = tables.find(e => e.name === 'Archived')!;
    assert.ok(active && archived);

    // The same text is in both tables; within: picks the row of the table asked for.
    const both = await f.observe({ scope: 'text:"Customer 7 |"' });
    assert.equal(both.elements!.length, 2);
    const one = await f.observe({ scope: `within:${active.id},text:"Customer 399 |"` });
    assert.equal(one.elements!.length, 1);
    assert.equal(one.elements![0]!.name, 'Customer 399 | Plan 399');
    assert.equal(one.elements![0]!.parent_id, active.id);
    assert.equal(one.truncated, false);
    const inArchive = await f.observe({ scope: `within:${archived.id},text:"Customer 7 |"` });
    assert.equal(inArchive.elements!.length, 1);
    assert.equal(inArchive.elements![0]!.parent_id, archived.id);
    assert.equal(
      (await f.observe({ scope: `within:${archived.id},text:"Customer 399 |"` })).elements!.length,
      0,
      'a row of the other table is not found',
    );

    // Paging: 400 rows, every page within the budget, nothing from outside the table, nothing twice.
    const seen: string[] = [];
    let page = await f.observe({ scope: `within:${active.id}`, token_budget: 512 });
    let pages = 1;
    for (;;) {
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 512 * 4);
      for (const e of page.elements!) {
        assert.equal(e.role, 'row');
        assert.equal(e.parent_id, active.id);
        seen.push(e.name);
      }
      if (!page.next_cursor) break;
      page = await f.observe({ scope: `within:${active.id}`, token_budget: 512, cursor: page.next_cursor });
      assert.ok(++pages < 200);
    }
    assert.equal(page.truncated, false);
    assert.equal(seen.length, 400);
    assert.equal(new Set(seen).size, 400);
    assert.ok(pages > 3, 'the table takes several pages');

    // A container without any parent_id relation (a labelled section) works through DOM depth.
    const billing = (await f.observe({ scope: 'role:region,name:Billing' })).elements![0]!;
    assert.equal((await f.observe({ scope: 'role:button,name:Save' })).elements!.length, 2);
    const save = await f.observe({ scope: `within:${billing.id},role:button,name:Save` });
    assert.equal(save.elements!.length, 1);
    assert.deepEqual(
      (await f.observe({ scope: `within:${billing.id}`, format: 'lines' })).lines!.map(l => l.split(' ')[1]),
      ['button', 'button'],
    );

    // Deltas: only what changed inside the table is reported.
    const before = await f.observe({ scope: 'role:button,name:"Add row"' });
    const add = before.elements![0]!;
    const done = await f.act({ action: 'click', element_id: add.id }, before.revision);
    const delta = await f.observe({ since_revision: before.revision, scope: `within:${active.id}` });
    assert.deepEqual(
      delta.changes!.map(c => [c.op, c.element?.name]),
      [['added', 'Customer new | Plan new']],
    );
    assert.ok(done.revision > before.revision);
    assert.equal(
      (await f.observe({ since_revision: before.revision, scope: `within:${archived.id}` })).changes!.length,
      0,
    );

    // Unknown and stale ids are refused with a reason; so is an element of a replaced document.
    await assert.rejects(f.observe({ scope: 'within:e99999' }), {
      code: 'E_TARGET_NOT_FOUND',
      reason: 'scope_element_not_found',
    });
    const moved = await f.act({ action: 'navigate', url: f.origin + '/other' }, done.revision);
    assert.ok(moved.revision > done.revision);
    await assert.rejects(f.observe({ scope: `within:${active.id}` }), { reason: 'scope_element_not_found' });
  } finally {
    await f.close();
  }
});

test(
  'paragraph names keep the text of inline links and children; hidden and protected text is not merged',
  {
    timeout: 60000,
  },
  async () => {
    const html = `<!doctype html><title>Inline</title>
<p>See <a href="/guide">the guide</a> for details.</p>
<p>Nested <a href="/n"><span>link <b>deep</b></span></a> done.</p>
<p>Plain <span style="display:none">DISPLAY_NONE_CANARY</span><span style="opacity:0">OPACITY_CANARY</span><span data-adl-sensitive>PROTECTED_CANARY</span> text <button>Press</button> end</p>
<p>Line one<br>Line two <input value="INPUT_CANARY"> tail</p>
<h2>Welcome to <em>our</em> site</h2>
<ul><li>Item <a href="/i">link</a></li></ul>
<p>${'long '.repeat(200)}<a href="/t">tail link</a></p>`;
    const f = await fixture({ '/': html });
    try {
      const o = await f.observe();
      const byName = (name: string) => o.elements!.find(e => e.name === name)!;
      const guide = o.elements!.find(e => e.role === 'text' && e.name.startsWith('See'))!;
      assert.equal(guide.name, 'See the guide for details.', 'the link text stays in the sentence');
      assert.equal(guide.text_length, undefined, 'short uncut text needs no redundant length');
      assert.ok(!guide.hidden_text);
      assert.equal(byName('the guide').role, 'link', 'the link is still listed on its own');
      assert.equal(byName('Nested link deep done.').role, 'text');
      assert.equal(byName('Welcome to our site').role, 'heading');
      assert.equal(byName('Item link').role, 'listitem');
      assert.equal(byName('Line one\nLine two tail').role, 'text', 'controls are left out and <br> is a line break');

      const plain = byName('Plain text end');
      assert.equal(plain.hidden_text, true, 'a paragraph that holds invisible text says so');
      const json = JSON.stringify(o);
      assert.ok(!json.includes('DISPLAY_NONE_CANARY'), 'text that is not rendered is not listed at all');
      assert.ok(!json.includes('PROTECTED_CANARY'));
      // Concealed prose carries an omission marker without exporting its content.
      assert.ok(o.elements!.some(e => e.name === '' && e.hidden_text));
      assert.ok(!json.includes('OPACITY_CANARY'));
      assert.ok(!plain.name.includes('OPACITY_CANARY'));

      // A long sentence is clipped in the name and reported in full by text_length; the read returns all of it.
      const long = o.elements!.find(e => e.name.startsWith('long long'))!;
      assert.equal(long.name_truncated, true);
      assert.equal(long.text_length, 'long '.repeat(200).length + 'tail link'.length);
      const read = await f.read(long.id);
      assert.equal(read.text!.total_length, long.text_length);
      assert.ok(read.text!.content.startsWith('long long') && !read.text!.hidden_text);
      assert.equal((await f.read(guide.id)).text!.content, 'See the guide for details.');
    } finally {
      await f.close();
    }
  },
);

test(
  'text reads a whole main, article or section in one paged read with paragraph breaks',
  {
    timeout: 60000,
  },
  async () => {
    const html = `<!doctype html><title>Handbook</title>
<main>
  <h1>Handbook</h1>
  <article aria-label="Chapter one">
    <h2>Intro</h2>
    <p>First para with <a href="/x">a link</a>.</p>
    <p>Second para <span style="opacity:0">HIDDEN_CANARY</span><span style="display:none">NONE_CANARY</span>ends.</p>
    <div data-adl-sensitive><p>PROTECTED_CANARY</p></div>
    <label for="pw">PW_LABEL_CANARY</label><input id="pw" type="password" value="PW_CANARY">
    <ul><li>Alpha</li><li>Beta <a href="/b">link</a></li></ul>
    <table><tr><td>A1</td><td>B1</td></tr><tr><td>A2</td><td>B2</td></tr></table>
    <pre>kept\n   spacing</pre>
    <p>Contact alice@example.com</p>
  </article>
</main>
<section aria-label="Appendix"><p>Appendix text</p></section>
<section><p>Unlabelled section</p></section>
<div data-adl-sensitive><article aria-label="Secret chapter"><p>SECRET_ARTICLE_CANARY</p></article></div>`;
    const f = await fixture({ '/': html });
    try {
      const o = await f.observe();
      const main = o.elements!.find(e => e.role === 'main')!;
      const article = o.elements!.find(e => e.role === 'article' && !e.protected)!;
      const appendix = o.elements!.find(e => e.role === 'region')!;
      assert.deepEqual([main.name, article.name, appendix.name], ['Handbook', 'Chapter one', 'Appendix']);
      assert.deepEqual(
        o.elements!.filter(e => e.role === 'region').map(e => e.name),
        ['Appendix'],
        'a section without a name is not a landmark',
      );
      assert.ok(!JSON.stringify(o).includes('SECRET_ARTICLE_CANARY'));
      const secret = o.elements!.find(e => e.protected && e.role === 'article')!;
      assert.equal(secret.name, '[redacted]');

      const expected = [
        'Intro',
        'First para with a link.',
        'Second para ends.',
        'Alpha\nBeta link',
        'A1 | B1\nA2 | B2',
        'kept\n   spacing',
        'Contact [redacted]',
      ].join('\n\n');
      const whole = await f.read(article.id);
      assert.equal(whole.text!.content, expected);
      assert.equal(whole.text!.total_length, expected.length);
      assert.equal(whole.text!.next_offset, null);
      assert.equal(whole.text!.hidden_text, true, 'the read says that invisible text was left out');
      assert.equal(whole.redactions, 1);
      for (const canary of [
        'HIDDEN_CANARY',
        'NONE_CANARY',
        'PROTECTED_CANARY',
        'PW_LABEL_CANARY',
        'PW_CANARY',
        'alice@',
      ])
        assert.ok(!whole.text!.content.includes(canary), canary);

      // main holds the article and its heading but not the section after it.
      const all = await f.read(main.id);
      assert.equal(all.text!.content, `Handbook\n\n${expected}`);
      assert.equal((await f.read(appendix.id)).text!.content, 'Appendix text');
      assert.ok(!(await f.read(appendix.id)).text!.hidden_text);

      // Paged: offset/length/next_offset reassemble the same text.
      let joined = '',
        offset = 0,
        reads = 0;
      for (;;) {
        const chunk = (await f.read(article.id, offset, 20)).text!;
        assert.ok(chunk.content.length <= 20 && chunk.total_length === expected.length);
        joined += chunk.content;
        reads++;
        if (chunk.next_offset === null) break;
        offset = chunk.next_offset;
      }
      assert.equal(joined, expected);
      assert.ok(reads > 5);

      // Directly reading a concealed node cannot recover its omitted prose.
      const hidden = o.elements!.find(e => e.name === '' && e.hidden_text)!;
      assert.equal(hidden.hidden_text, true);
      assert.equal((await f.read(hidden.id)).text!.content, '');
      await assert.rejects(f.read(secret.id), { code: 'E_PRIVACY_BLOCKED' });
    } finally {
      await f.close();
    }
  },
);

test('personal data in a region read stays redacted unless the workspace allows it', { timeout: 60000 }, async () => {
  const html = '<main><h1>Contacts</h1><p>Mail alice@example.com today</p></main>';
  for (const allowPersonalData of [false, true]) {
    const f = await fixture({ '/': html }, { allowPersonalData });
    try {
      const main = (await f.observe()).elements!.find(e => e.role === 'main')!;
      const content = (await f.read(main.id)).text!.content;
      assert.equal(
        content,
        allowPersonalData ? 'Contacts\n\nMail alice@example.com today' : 'Contacts\n\nMail [redacted] today',
      );
    } finally {
      await f.close();
    }
  }
});

test(
  'a page that cannot scroll says why, in every permission tier; an edge is a notice, not an error',
  {
    timeout: 90000,
  },
  async () => {
    for (const operationMode of ['standard', 'read_only'] as const) {
      const f = await fixture({ '/': '<h1>Short</h1><button>Small target</button>' }, { operationMode });
      try {
        const o = await f.observe();
        await assert.rejects(f.act({ action: 'scroll', direction: 'down' }, o.revision), (error: unknown) => {
          assert.ok(error instanceof AdlError);
          assert.equal(error.code, 'E_UNSUPPORTED_ACTION');
          assert.equal(error.reason, 'not_scrollable', operationMode);
          assert.equal(error.mayHaveExecuted, false);
          const safe = safeError(error);
          assert.match(safe.safe_message, /fits in the viewport/);
          assert.match(safe.safe_message, /adl_observe/);
          return true;
        });
        const button = o.elements!.find(e => e.name === 'Small target')!;
        await assert.rejects(f.act({ action: 'scroll', direction: 'up', element_id: button.id }, o.revision), {
          code: 'E_UNSUPPORTED_ACTION',
          reason: 'not_scrollable',
        });
        assert.equal((await f.observe()).ok, true, 'the session stays usable');
      } finally {
        await f.close();
      }
    }
  },
);

test('page and region scroll at an edge return a notice and keep read-only scrolling', { timeout: 90000 }, async () => {
  const html = `<!doctype html><body style="margin:0"><h1>Long</h1>
<div style="height:3000px">Tall content</div>
<div role="region" aria-label="Log" style="height:100px;width:200px;overflow:auto"><div style="height:400px">Log lines</div></div>`;
  const f = await fixture({ '/': html }, { operationMode: 'read_only' });
  try {
    let revision = (await f.observe()).revision;
    // At the top, scrolling up moves nothing.
    const top = await f.act({ action: 'scroll', direction: 'up' }, revision);
    assert.deepEqual(
      top.warnings?.map(w => w.code),
      ['scroll_at_edge'],
    );
    assert.match(top.warnings![0]!.message!, /page is already at the top/);
    revision = top.revision;
    // Down moves, with no notice, until the bottom is reached.
    const first = await f.act({ action: 'scroll', direction: 'down' }, revision);
    assert.equal(first.warnings, undefined);
    revision = first.revision;
    let last: ActResult = first;
    for (let i = 0; i < 10 && !last.warnings; i++) {
      last = await f.act({ action: 'scroll', direction: 'down' }, revision);
      revision = last.revision;
    }
    assert.equal(last.warnings?.[0]?.code, 'scroll_at_edge');
    assert.match(last.warnings![0]!.message!, /page is already at the bottom/);

    // A scrollable region: moves, then reports its end.
    const log = (await f.observe()).elements!.find(e => e.name === 'Log' && e.role === 'region')!;
    revision = (await f.observe()).revision;
    const moved = await f.act({ action: 'scroll', direction: 'down', element_id: log.id }, revision);
    assert.equal(moved.warnings, undefined);
    revision = moved.revision;
    let end: ActResult = moved;
    for (let i = 0; i < 10 && !end.warnings; i++) {
      end = await f.act({ action: 'scroll', direction: 'down', element_id: log.id }, revision);
      revision = end.revision;
    }
    assert.equal(end.warnings?.[0]?.code, 'scroll_at_edge');
    assert.match(end.warnings![0]!.message!, /region is already at the bottom/);
  } finally {
    await f.close();
  }
});
