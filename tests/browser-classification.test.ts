import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import { inspectBrowserAction } from '../src/browser-approval.js';
import { AdlError, safeError, type AdapterSession, type NetworkWarning } from '../src/types.js';
import { isActionNetworkBlock } from '../src/network-warnings.js';

const PAGE = `<label>Sort <select name="sort"><option value="o">Order now</option><option value="d" selected>Date</option><option value="x">Delete</option></select></label>
<form id="todo"><input aria-label="New item"><button id="add">Add</button></form><ul id="list"></ul>
<form id="post" method="post" action="/save"><input name="title" aria-label="Title" value="t"><button id="save">Save</button></form>
<form id="get" method="get" action="/apply"><input name="n" aria-label="Note" value="x"><button id="apply">Apply</button></form>
<form id="js" method="post" action="/save"><input name="t" value="1"><button id="go">Go</button></form>
<form id="destructive" onsubmit="return false"><input aria-label="Reason"><button id="del" onclick="window.deleted=(window.deleted||0)+1">Delete</button></form>
<form id="enter" onsubmit="return false"><input aria-label="Confirm text"><button id="delall">Delete all</button></form>
<div id="plain"><button type="button" onclick="window.fired=(window.fired||[]).concat(this.textContent)">Purchase</button><button type="button" onclick="window.fired=(window.fired||[]).concat(this.textContent)">購入</button><button type="button" onclick="window.fired=(window.fired||[]).concat(this.textContent)">Log in</button><button type="button" onclick="window.fired=(window.fired||[]).concat(this.textContent)">ログイン</button><button type="button" onclick="window.fired=(window.fired||[]).concat(this.textContent)">Details</button></div>
<script>document.getElementById('todo').addEventListener('submit',e=>{e.preventDefault();const li=document.createElement('li');li.textContent=document.querySelector('#todo input').value;document.getElementById('list').append(li);});
document.getElementById('js').addEventListener('submit',e=>{e.preventDefault();document.getElementById('js').submit();});</script>`;

async function fixture(mode: 'standard' | 'ask') {
  let posts = 0,
    gets = 0;
  const app = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'POST') {
      posts++;
      res.end('posted');
      return;
    }
    if ((req.url ?? '').startsWith('/apply')) {
      gets++;
      res.end('applied');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html>' + PAGE);
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    operationMode: mode,
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 5000,
    browserTargets: [{ id: 'fixture', label: 'Fixture', url: origin, classification: 'PUBLIC' }],
  });
  const adapter = new BrowserAdapter(policy, url => assertUrlAllowed(url, policy));
  const open = adapter.open.bind(adapter);
  let instance: AdapterSession | undefined;
  adapter.open = async (...args) => (instance = await open(...args));
  const engine = new Engine(policy, { browser: adapter });
  const close = async () => {
    await engine.shutdown();
    app.closeAllConnections();
    await new Promise<void>(resolve => app.close(() => resolve()));
  };
  try {
    const session = await engine.open((await engine.listTargets()).targets[0]!.target_id);
    return {
      engine,
      origin,
      instance: instance!,
      id: session.session_id,
      page: (instance as unknown as { pageValue: Page }).pageValue,
      counts: () => ({ posts, gets }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
// The submission guard's warnings are the action's own traffic: document navigations with the submitting form's real method.
const guardBlocks = (observed: { warnings?: NetworkWarning[] }) => {
  const found = (observed.warnings ?? []).filter(w => w.code === 'form_submission_requires_approval');
  for (const w of found) assert.equal(isActionNetworkBlock(w), true, JSON.stringify(w));
  return found.map(w => `${w.resource_type} ${w.method} ${w.count}`).sort();
};
const byName = (observed: { elements?: { id: string; name: string; value?: string }[] }, name: string) => {
  const element = observed.elements!.find(e => e.name === name);
  assert.ok(element, name);
  return element;
};

test('option text does not make a select consequential; label/aria/title name it', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(PAGE);
    const proof = async (selector: string, action: 'click' | 'press' | 'fill' | 'select' = 'click') => {
      const el = await page.locator(selector).elementHandle();
      assert.ok(el);
      try {
        return await inspectBrowserAction(el, {
          action,
          ...(action === 'press' ? { value: 'Enter' } : action === 'fill' || action === 'select' ? { value: 'o' } : {}),
        });
      } finally {
        await el.dispose();
      }
    };
    const sort = await proof('select[name=sort]', 'select');
    assert.equal(sort.risk, 'ordinary');
    assert.equal(sort.name, 'Sort');
    await page.locator('select[name=sort]').evaluate(e => e.setAttribute('aria-label', 'Delete order'));
    assert.equal((await proof('select[name=sort]', 'select')).risk, 'consequential');
    const add = await proof('#add');
    assert.equal(add.risk, 'consequential');
    assert.equal(add.submission, 'plain');
    const enter = await proof('#todo input', 'press');
    assert.equal(enter.risk, 'consequential');
    assert.equal(enter.submission, 'plain');
    assert.equal((await proof('#del')).submission, undefined);
    // Enter in a text field activates the default button, so its destructive label counts.
    const enterDelete = await proof('#enter input', 'press');
    assert.equal(enterDelete.risk, 'consequential');
    assert.equal(enterDelete.submission, undefined);
  } finally {
    await browser.close();
  }
});

test(
  'standard mode selects an "Order" option and submits JS-handled forms, while real submissions are stopped in place',
  { timeout: 60000 },
  async () => {
    const f = await fixture('standard');
    try {
      let observed = await f.engine.observe(f.id, { token_budget: 8000 });
      await f.engine.act(
        f.id,
        { action: 'select', element_id: byName(observed, 'Sort').id, value: 'o' },
        observed.revision,
      );
      observed = await f.engine.observe(f.id, { token_budget: 8000 });
      assert.equal(byName(observed, 'Sort').value, 'o');
      // JS-handled (preventDefault) form: click and Enter both work and no request leaves.
      await f.engine.act(
        f.id,
        { action: 'fill', element_id: byName(observed, 'New item').id, value: 'milk' },
        observed.revision,
      );
      observed = await f.engine.observe(f.id, { token_budget: 8000 });
      const added = await f.engine.act(
        f.id,
        { action: 'click', element_id: byName(observed, 'Add').id },
        observed.revision,
      );
      assert.equal(added.ok, true);
      assert.equal((added as { network_blocked?: boolean }).network_blocked, undefined);
      observed = await f.engine.observe(f.id, { token_budget: 8000 });
      assert.ok(observed.elements!.some(e => e.role === 'listitem' && e.name === 'milk'));
      await f.engine.act(
        f.id,
        { action: 'press', value: 'Enter', element_id: byName(observed, 'New item').id },
        observed.revision,
      );
      assert.equal(await f.page.locator('#list li').count(), 2);
      // A real POST form: the click is dispatched, the submission navigation is cancelled before any request, the session stays usable.
      observed = await f.engine.observe(f.id, { token_budget: 8000 });
      await assert.rejects(
        f.engine.act(f.id, { action: 'click', element_id: byName(observed, 'Save').id }, observed.revision),
        (error: unknown) => {
          assert.ok(error instanceof AdlError);
          assert.equal(error.code, 'E_APPROVAL_REQUIRED');
          assert.equal(error.reason, 'form_submission_requires_approval');
          assert.equal(safeError(error).may_have_executed, undefined);
          return true;
        },
      );
      assert.equal(f.page.url(), f.origin + '/');
      assert.deepEqual(f.counts(), { posts: 0, gets: 0 });
      observed = await f.engine.observe(f.id, { token_budget: 8000 });
      assert.ok(
        observed.elements!.some(e => e.role === 'listitem' && e.name === 'milk'),
        'same document, session alive',
      );
      assert.deepEqual(guardBlocks(observed), ['document POST 1']);
      // A GET form that is not a search: its navigation is cancelled as well.
      await assert.rejects(
        f.engine.act(f.id, { action: 'click', element_id: byName(observed, 'Apply').id }, observed.revision),
        (error: unknown) => error instanceof AdlError && error.reason === 'form_submission_requires_approval',
      );
      assert.equal(f.page.url(), f.origin + '/');
      assert.deepEqual(f.counts(), { posts: 0, gets: 0 });
      assert.deepEqual(guardBlocks(await f.engine.observe(f.id, { token_budget: 8000 })), [
        'document GET 1',
        'document POST 1',
      ]);
      // Script form.submit() from the submit handler is a form submission too.
      observed = await f.engine.observe(f.id, { token_budget: 8000 });
      await assert.rejects(
        f.engine.act(f.id, { action: 'click', element_id: byName(observed, 'Go').id }, observed.revision),
        (error: unknown) => error instanceof AdlError && error.reason === 'form_submission_requires_approval',
      );
      assert.equal(f.page.url(), f.origin + '/');
      assert.deepEqual(f.counts(), { posts: 0, gets: 0 });
      // Destructive labels are never dispatched in standard mode, whether clicked or reached through Enter.
      observed = await f.engine.observe(f.id, { token_budget: 8000 });
      await assert.rejects(
        f.engine.act(f.id, { action: 'click', element_id: byName(observed, 'Delete').id }, observed.revision),
        (error: unknown) =>
          error instanceof AdlError && error.code === 'E_APPROVAL_REQUIRED' && error.reason === 'requires_ask_mode',
      );
      await assert.rejects(
        f.engine.act(
          f.id,
          { action: 'press', value: 'Enter', element_id: byName(observed, 'Confirm text').id },
          observed.revision,
        ),
        (error: unknown) =>
          error instanceof AdlError && error.code === 'E_APPROVAL_REQUIRED' && error.reason === 'requires_ask_mode',
      );
      assert.equal(await f.page.evaluate(() => (window as unknown as { deleted?: number }).deleted ?? 0), 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'standard mode refuses purchase and log-in buttons like delete, in English and Japanese, and still clicks an ordinary button',
  { timeout: 30000 },
  async () => {
    const f = await fixture('standard');
    try {
      let observed = await f.engine.observe(f.id, { token_budget: 8000 });
      const fired = () => f.page.evaluate(() => (window as unknown as { fired?: string[] }).fired ?? []);
      for (const label of ['Purchase', '購入', 'Log in', 'ログイン'])
        await assert.rejects(
          f.engine.act(f.id, { action: 'click', element_id: byName(observed, label).id }, observed.revision),
          (error: unknown) =>
            error instanceof AdlError && error.code === 'E_APPROVAL_REQUIRED' && error.reason === 'requires_ask_mode',
          label,
        );
      assert.deepEqual(await fired(), [], 'nothing was dispatched');
      observed = await f.engine.observe(f.id, { token_budget: 8000 });
      await f.engine.act(f.id, { action: 'click', element_id: byName(observed, 'Details').id }, observed.revision);
      assert.deepEqual(await fired(), ['Details'], 'the session still works and an ordinary button is clicked');
    } finally {
      await f.close();
    }
  },
);

test(
  'ask mode still requests approval for a plain form submission instead of guarding it',
  { timeout: 30000 },
  async () => {
    const f = await fixture('ask');
    try {
      const observed = await f.engine.observe(f.id, { token_budget: 8000 });
      await assert.rejects(
        f.engine.act(f.id, { action: 'click', element_id: byName(observed, 'Save').id }, observed.revision),
        (error: unknown) =>
          error instanceof AdlError && error.code === 'E_APPROVAL_REQUIRED' && error.reason === 'approval_unavailable',
      );
      assert.deepEqual(f.counts(), { posts: 0, gets: 0 });
    } finally {
      await f.close();
    }
  },
);
