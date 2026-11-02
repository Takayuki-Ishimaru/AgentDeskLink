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
import { stubBroker } from './approval-broker-stub.js';

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

async function fixture(mode: 'standard' | 'ask', page: string = PAGE) {
  let posts = 0,
    gets = 0;
  const posted: string[] = [];
  const app = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'POST') {
      posts++;
      let body = '';
      for await (const chunk of req) body += chunk;
      posted.push(`${req.url} ${body}`);
      res.end('posted');
      return;
    }
    if ((req.url ?? '').startsWith('/apply')) {
      gets++;
      res.end('applied');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html>' + page);
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
      posted,
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

// Ask-mode page: forms that only submit (plain), a credential form and a destructive label. Each handler records that it ran.
const ASK_PAGE = `<form id="todo"><input aria-label="New item"><button id="add">Add</button></form><ul id="list"></ul>
<form id="post" method="post" action="/save"><input name="title" aria-label="Title" value="t"><button id="save" onclick="window.clicks=(window.clicks||[]).concat(this.id)">Save</button></form>
<form id="get" method="get" action="/apply"><input name="n" aria-label="Note" value="x"><button id="apply" onclick="window.clicks=(window.clicks||[]).concat(this.id)">Apply</button></form>
<form id="js" method="post" action="/save"><input name="t" value="1"><button id="go" onclick="window.clicks=(window.clicks||[]).concat(this.id)">Go</button></form>
<form id="cred" method="post" action="/save"><input type="password" name="pin" aria-label="Pin" value="1234"><button id="store" onclick="window.clicks=(window.clicks||[]).concat(this.id)">Store</button></form>
<form id="destructive" onsubmit="return false"><input aria-label="Reason"><button id="del" onclick="window.clicks=(window.clicks||[]).concat(this.id)">Delete</button></form>
<form id="named" method="post" action="/save"><input name="q" aria-label="Query" value="v"><button id="alt" name="op" value="alt" formaction="/alt">Alt save</button></form>
<script>document.getElementById('todo').addEventListener('submit',e=>{e.preventDefault();const li=document.createElement('li');li.textContent=document.querySelector('#todo input').value;document.getElementById('list').append(li);});
document.getElementById('js').addEventListener('submit',e=>{e.preventDefault();document.getElementById('js').submit();});</script>`;
const dispatched = (f: { page: Page }) =>
  f.page.evaluate(() => (window as unknown as { clicks?: string[] }).clicks ?? []);
const click = (f: Awaited<ReturnType<typeof fixture>>, observed: { revision: number }, id: string) =>
  f.engine.act(f.id, { action: 'click', element_id: id }, observed.revision);
const observe = (f: Awaited<ReturnType<typeof fixture>>) => f.engine.observe(f.id, { token_budget: 8000 });
const pendingRequest = (error: unknown) => {
  assert.ok(error instanceof AdlError, String(error));
  assert.equal(error.code, 'E_APPROVAL_REQUIRED');
  assert.equal(error.reason, 'form_submission_requires_approval');
  assert.ok(error.requestId, 'request_id');
  const safe = safeError(error);
  assert.equal(safe.may_have_executed, undefined);
  assert.equal(safe.retryable, true);
  assert.equal(typeof safe.revision, 'number');
  return { requestId: error.requestId, revision: safe.revision! };
};

test(
  'ask mode without a broker dispatches JS-handled forms and refuses only a real submission, after the attempt',
  { timeout: 60000 },
  async () => {
    const f = await fixture('ask', ASK_PAGE);
    try {
      let observed = await observe(f);
      await f.engine.act(
        f.id,
        { action: 'fill', element_id: byName(observed, 'New item').id, value: 'milk' },
        observed.revision,
      );
      observed = await observe(f);
      const added = await click(f, observed, byName(observed, 'Add').id);
      assert.equal(added.ok, true);
      assert.equal((added as { network_blocked?: boolean }).network_blocked, undefined);
      observed = await observe(f);
      assert.ok(observed.elements!.some(e => e.role === 'listitem' && e.name === 'milk'));
      await f.engine.act(
        f.id,
        { action: 'press', value: 'Enter', element_id: byName(observed, 'New item').id },
        observed.revision,
      );
      assert.equal(await f.page.locator('#list li').count(), 2);
      // Hovering a submit button submits nothing: it needs no approval either.
      observed = await observe(f);
      const hovered = await f.engine.act(
        f.id,
        { action: 'hover', element_id: byName(observed, 'Save').id },
        observed.revision,
      );
      assert.equal(hovered.ok, true);
      assert.deepEqual(await dispatched(f), []);
      // A real POST form: the click is dispatched, the submission is cancelled, and only then is the missing broker reported.
      observed = await observe(f);
      await assert.rejects(
        click(f, observed, byName(observed, 'Save').id),
        (error: unknown) =>
          error instanceof AdlError &&
          error.code === 'E_APPROVAL_REQUIRED' &&
          error.reason === 'approval_unavailable' &&
          error.requestId === undefined &&
          safeError(error).revision === undefined,
      );
      assert.deepEqual(await dispatched(f), ['save'], 'the handler ran once, as in standard mode');
      assert.equal(f.page.url(), f.origin + '/');
      assert.deepEqual(f.counts(), { posts: 0, gets: 0 });
    } finally {
      await f.close();
    }
  },
);

test(
  'ask mode: a blocked POST submission creates the request from the post-attempt state, retries are idempotent, approval sends it once',
  { timeout: 90000 },
  async () => {
    const broker = await stubBroker();
    const f = await fixture('ask', ASK_PAGE);
    try {
      let observed = await observe(f);
      const save = byName(observed, 'Save').id;
      let first!: { requestId: string; revision: number };
      await assert.rejects(click(f, observed, save), (error: unknown) => {
        first = pendingRequest(error);
        return true;
      });
      // Nothing left the browser, the handler ran once, and the error names the revision the identical retry must use.
      assert.deepEqual(f.counts(), { posts: 0, gets: 0 });
      assert.deepEqual(await dispatched(f), ['save']);
      assert.equal(f.page.url(), f.origin + '/');
      assert.equal(broker.state.posts, 1);
      assert.equal(first.revision, (await observe(f)).revision, 'the revision is the one a new observation returns');
      assert.ok(first.revision > observed.revision);
      const request = broker.byId(first.requestId)!;
      assert.equal(request.summary.risk, 'consequential');
      assert.ok(request.summary.details!.some(line => /^Form POST http:\/\/127\.0\.0\.1:\d+\/save$/.test(line)));
      assert.ok(request.summary.details!.includes('"title": "t"'));
      // Retrying while pending is idempotent: the same request, no second dispatch, no second broker request.
      for (let i = 0; i < 2; i++)
        await assert.rejects(
          f.engine.act(f.id, { action: 'click', element_id: save }, first.revision),
          (error: unknown) => {
            assert.deepEqual(pendingRequest(error), first);
            return true;
          },
        );
      assert.deepEqual(await dispatched(f), ['save'], 'no second dispatch while pending');
      assert.equal(broker.state.posts, 1);
      assert.deepEqual(f.counts(), { posts: 0, gets: 0 });
      assert.equal((await f.engine.approvals()).requests[0]?.status, 'pending');
      // Approved: the identical retry consumes the approval and sends the form exactly once.
      request.status = 'approved';
      const sent = await f.engine.act(f.id, { action: 'click', element_id: save }, first.revision);
      assert.equal(sent.ok, true);
      assert.deepEqual(f.counts(), { posts: 1, gets: 0 });
      assert.equal(broker.state.consumes, 1);
      assert.equal(await f.page.locator('body').innerText(), 'posted');
      assert.equal((await f.engine.approvals()).requests.length, 0);
      // The approval was single-use: the same revision does not send again.
      await assert.rejects(f.engine.act(f.id, { action: 'click', element_id: save }, first.revision));
      assert.deepEqual(f.counts(), { posts: 1, gets: 0 });
    } finally {
      await f.close();
      await broker.close();
    }
  },
);

test(
  'ask mode: a denied submission stays denied without a second dispatch, and a changed form is a new request',
  { timeout: 90000 },
  async () => {
    const broker = await stubBroker();
    const f = await fixture('ask', ASK_PAGE);
    try {
      const observed = await observe(f);
      const save = byName(observed, 'Save').id;
      let first!: { requestId: string; revision: number };
      await assert.rejects(click(f, observed, save), (error: unknown) => {
        first = pendingRequest(error);
        return true;
      });
      broker.byId(first.requestId)!.status = 'denied';
      for (let i = 0; i < 3; i++)
        await assert.rejects(
          f.engine.act(f.id, { action: 'click', element_id: save }, first.revision),
          (error: unknown) => {
            assert.ok(error instanceof AdlError);
            assert.equal(error.code, 'E_POLICY_DENIED');
            assert.equal(error.reason, 'approval_denied');
            assert.equal(safeError(error).retryable, false);
            return true;
          },
        );
      assert.deepEqual(await dispatched(f), ['save'], 'a denial is never re-dispatched');
      assert.equal(broker.state.posts, 1);
      assert.deepEqual(f.counts(), { posts: 0, gets: 0 });
      // Changing the form is a different action proof: the old denial does not apply and the new attempt asks again.
      let current = await observe(f);
      await f.engine.act(
        f.id,
        { action: 'fill', element_id: byName(current, 'Title').id, value: 'other' },
        current.revision,
      );
      current = await observe(f);
      await assert.rejects(click(f, current, byName(current, 'Save').id), (error: unknown) => {
        const next = pendingRequest(error);
        assert.notEqual(next.requestId, first.requestId);
        return true;
      });
      assert.equal(broker.state.posts, 2);
      assert.ok(broker.latest()!.summary.details!.includes('"title": "other"'));
      assert.deepEqual(f.counts(), { posts: 0, gets: 0 });
    } finally {
      await f.close();
      await broker.close();
    }
  },
);

test(
  'ask mode: GET, script form.submit() and Enter submissions are cancelled once, requested, and sent after approval',
  { timeout: 120000 },
  async () => {
    const broker = await stubBroker();
    const f = await fixture('ask', ASK_PAGE);
    try {
      const home = async () => {
        const at = await observe(f);
        await f.engine.act(f.id, { action: 'navigate', url: f.origin + '/' }, at.revision);
        return observe(f);
      };
      let observed = await observe(f);
      // A GET form that is not a search.
      const apply = byName(observed, 'Apply').id;
      let ask!: { requestId: string; revision: number };
      await assert.rejects(click(f, observed, apply), (error: unknown) => {
        ask = pendingRequest(error);
        return true;
      });
      assert.deepEqual(f.counts(), { posts: 0, gets: 0 });
      assert.ok(broker.byId(ask.requestId)!.summary.details!.some(line => /^Form GET .*\/apply$/.test(line)));
      broker.byId(ask.requestId)!.status = 'approved';
      assert.equal((await f.engine.act(f.id, { action: 'click', element_id: apply }, ask.revision)).ok, true);
      assert.deepEqual(f.counts(), { posts: 0, gets: 1 });
      // A submit handler that calls form.submit() is a real submission too.
      observed = await home();
      const go = byName(observed, 'Go').id;
      await assert.rejects(click(f, observed, go), (error: unknown) => {
        ask = pendingRequest(error);
        return true;
      });
      assert.deepEqual(f.counts(), { posts: 0, gets: 1 });
      broker.byId(ask.requestId)!.status = 'approved';
      assert.equal((await f.engine.act(f.id, { action: 'click', element_id: go }, ask.revision)).ok, true);
      assert.deepEqual(f.counts(), { posts: 1, gets: 1 });
      // Enter in a field of a POST form takes the same guarded path as the click.
      observed = await home();
      const title = byName(observed, 'Title').id;
      await assert.rejects(
        f.engine.act(f.id, { action: 'press', value: 'Enter', element_id: title }, observed.revision),
        (error: unknown) => {
          ask = pendingRequest(error);
          return true;
        },
      );
      assert.deepEqual(f.counts(), { posts: 1, gets: 1 });
      assert.equal(f.page.url(), f.origin + '/');
      assert.ok(broker.byId(ask.requestId)!.summary.details!.some(line => /^Form POST .*\/save$/.test(line)));
      await assert.rejects(
        f.engine.act(f.id, { action: 'press', value: 'Enter', element_id: title }, ask.revision),
        (error: unknown) => {
          assert.deepEqual(pendingRequest(error), ask);
          return true;
        },
      );
      assert.equal(broker.state.posts, 3);
      broker.byId(ask.requestId)!.status = 'approved';
      // Approved: the implicit submission is sent once, bound to the default button's request like a click on it.
      const entered = await f.engine.act(f.id, { action: 'press', value: 'Enter', element_id: title }, ask.revision);
      assert.equal(entered.ok, true);
      assert.equal((entered as { network_blocked?: boolean }).network_blocked, undefined);
      assert.deepEqual(f.counts(), { posts: 2, gets: 1 });
      assert.equal(await f.page.locator('body').innerText(), 'posted');
    } finally {
      await f.close();
      await broker.close();
    }
  },
);

test(
  'ask mode: Enter is approved and sent as the default button would send it, and the dialog shows that same request',
  { timeout: 90000 },
  async () => {
    const broker = await stubBroker();
    const f = await fixture('ask', ASK_PAGE);
    try {
      const observed = await observe(f);
      const query = byName(observed, 'Query').id;
      let ask!: { requestId: string; revision: number };
      await assert.rejects(
        f.engine.act(f.id, { action: 'press', value: 'Enter', element_id: query }, observed.revision),
        (error: unknown) => {
          ask = pendingRequest(error);
          return true;
        },
      );
      assert.deepEqual(f.posted, []);
      // The default button's formaction and its own name/value are part of what Enter submits, so they are what the human is shown.
      const details = broker.byId(ask.requestId)!.summary.details!;
      assert.ok(
        details.some(line => /^Form POST http:\/\/127\.0\.0\.1:\d+\/alt$/.test(line)),
        details.join('|'),
      );
      assert.ok(details.includes('"q": "v"') && details.includes('"op": "alt"'));
      broker.byId(ask.requestId)!.status = 'approved';
      const sent = await f.engine.act(f.id, { action: 'press', value: 'Enter', element_id: query }, ask.revision);
      assert.equal(sent.ok, true);
      assert.deepEqual(f.posted, ['/alt q=v&op=alt']);
    } finally {
      await f.close();
      await broker.close();
    }
  },
);

test(
  'ask mode: a field changed after the request makes the retry stale, and no form is sent',
  { timeout: 90000 },
  async () => {
    const broker = await stubBroker();
    const f = await fixture('ask', ASK_PAGE);
    try {
      const observed = await observe(f);
      const save = byName(observed, 'Save').id;
      let first!: { requestId: string; revision: number };
      await assert.rejects(click(f, observed, save), (error: unknown) => {
        first = pendingRequest(error);
        return true;
      });
      broker.byId(first.requestId)!.status = 'approved';
      await f.page.evaluate(() => {
        (document.querySelector('#post input') as HTMLInputElement).value = 'changed after the request';
      });
      await assert.rejects(f.engine.act(f.id, { action: 'click', element_id: save }, first.revision), {
        code: 'E_STALE_STATE',
      });
      assert.deepEqual(f.counts(), { posts: 0, gets: 0 });
      // The approval belonged to the form as it was: it is withdrawn (the broker retires an approved request on DELETE), never used for another.
      assert.equal(broker.state.deletes, 1);
      assert.equal(broker.byId(first.requestId)!.status, 'consumed');
      // The page is still the same document, and the changed form needs its own request.
      assert.equal(f.page.url(), f.origin + '/');
      const again = await observe(f);
      await assert.rejects(click(f, again, save), (error: unknown) => {
        assert.notEqual(pendingRequest(error).requestId, first.requestId);
        return true;
      });
      assert.ok(broker.latest()!.summary.details!.includes('"title": "changed after the request"'));
      assert.deepEqual(f.counts(), { posts: 0, gets: 0 });
    } finally {
      await f.close();
      await broker.close();
    }
  },
);

test(
  'ask mode still asks before dispatch for credential forms and destructive labels',
  { timeout: 90000 },
  async () => {
    const broker = await stubBroker();
    const f = await fixture('ask', ASK_PAGE);
    try {
      let observed = await observe(f);
      for (const [label, risk] of [
        ['Store', 'credential'],
        ['Delete', 'consequential'],
      ] as const) {
        let asked!: string;
        await assert.rejects(click(f, observed, byName(observed, label).id), (error: unknown) => {
          assert.ok(error instanceof AdlError);
          assert.equal(error.code, 'E_APPROVAL_REQUIRED');
          assert.notEqual(error.reason, 'form_submission_requires_approval', label);
          assert.ok(error.requestId, label);
          assert.equal(safeError(error).revision, undefined);
          asked = error.requestId;
          return true;
        });
        assert.equal(broker.byId(asked)!.summary.risk, risk);
        assert.deepEqual(await dispatched(f), [], `${label} was not dispatched while the request is pending`);
        // withdraw it so the next control can ask
        broker.byId(asked)!.status = 'denied';
        await assert.rejects(click(f, observed, byName(observed, label).id), { code: 'E_POLICY_DENIED' });
        observed = await observe(f);
      }
      assert.deepEqual(f.counts(), { posts: 0, gets: 0 });
    } finally {
      await f.close();
      await broker.close();
    }
  },
);

// ---------------------------------------------------------------------------------------------
// Shared consequential classifier (design V0.1.7 Part A): real Chromium.
// ---------------------------------------------------------------------------------------------
import { randomBytes, randomUUID } from 'node:crypto';
import type { LabelLists } from '../src/action-classifier.js';
import type { Action } from '../src/types.js';

const CLASS_PAGE = `<h1>Shop</h1>
<div id="buttons"><button type="button" onclick="hit('ok-out')">OK</button><button type="button" onclick="hit('sort')">Sort order</button><button type="button" onclick="hit('fav')">お気に入りに登録</button><button type="button" onclick="hit('kakutei')">確定</button><button type="button" onclick="hit('unsub')">Unsubscribe</button><button type="button" onclick="hit('archive')">Archive</button><button type="button" onclick="hit('reset')">Reset</button><button type="button" onclick="hit('clear')">Clear</button><button type="button" onclick="hit('resetf')">Reset filters</button></div>
<nav><a href="/help/how-to-cancel">How to cancel</a> <a href="/orders">Order history</a> <a href="/logout">Log out</a> <a href="/report.csv" download>Report</a></nav>
<ul id="todo"><li>Buy milk <button type="button" onclick="this.parentNode.remove();hit('delete')">Delete Buy milk</button></li></ul>
<form id="post" method="post" action="/save"><input name="title" aria-label="Title" value="t"><button id="save">Save</button></form>
<dialog open aria-label="Delete this item?" style="position:fixed;right:8px;bottom:8px;left:auto;top:auto;margin:0"><button type="button" onclick="hit('dc')">Cancel</button><button type="button" onclick="hit('ok-in')">OK</button></dialog>
<script>window.fired=[];function hit(s){window.fired.push(s)}</script>`;

// Optional loopback approval broker, as in approval-browser.test.ts: the test flips `approved`.
async function approvalBroker() {
  const token = randomBytes(32).toString('base64url');
  const epoch = randomUUID();
  const state = { request: undefined as any, approved: false, requests: 0 };
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.method === 'POST') {
      state.request = JSON.parse(Buffer.concat(parts).toString());
      state.requests++;
    }
    if (!state.request) {
      res.writeHead(404);
      res.end();
      return;
    }
    const status = req.method === 'DELETE' ? 'consumed' : state.approved ? 'approved' : 'pending';
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        v: 1,
        request_id: state.request.request_id,
        binding: state.request.binding,
        status,
        expires_at: state.request.expires_at,
        ...(req.method === 'DELETE' ? { consumed_now: state.approved } : {}),
      }),
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const saved = [process.env.ADL_APPROVAL_URL, process.env.ADL_APPROVAL_TOKEN, process.env.ADL_APPROVAL_EPOCH];
  process.env.ADL_APPROVAL_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.ADL_APPROVAL_TOKEN = token;
  process.env.ADL_APPROVAL_EPOCH = epoch;
  return {
    state,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const [key, value] of [
        ['ADL_APPROVAL_URL', saved[0]],
        ['ADL_APPROVAL_TOKEN', saved[1]],
        ['ADL_APPROVAL_EPOCH', saved[2]],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

async function classFixture(
  mode: 'standard' | 'ask',
  policyExtra: Record<string, unknown> = {},
  html: string = CLASS_PAGE,
) {
  const gets: string[] = [];
  const app = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'POST') {
      res.end('posted');
      return;
    }
    gets.push(req.url ?? '');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html>' + html);
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    operationMode: mode,
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 5000,
    browserTargets: [{ id: 'fixture', label: 'Fixture', url: origin, classification: 'PUBLIC' }],
    ...policyExtra,
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
    const page = (instance as unknown as { pageValue: Page }).pageValue;
    const id = session.session_id;
    const fired = () => page.evaluate(() => (window as unknown as { fired?: string[] }).fired ?? []);
    // Acts on the nth element with this accessible name, observing first. The observation is in document order.
    const target = async (name: string, nth = 0) => {
      const observed = await engine.observe(id, { token_budget: 8000 });
      const found = observed.elements!.filter(e => e.name === name);
      assert.ok(found[nth], `${name} #${nth}`);
      return { action: { action: 'click' as const, element_id: found[nth]!.id }, revision: observed.revision };
    };
    const click = async (name: string, nth = 0) => {
      const t = await target(name, nth);
      return engine.act(id, t.action, t.revision);
    };
    return { engine, origin, id, page, gets, fired, target, click, close, policy };
  } catch (error) {
    await close();
    throw error;
  }
}

const isAskRequired = (reason: string) => (error: unknown) =>
  error instanceof AdlError && error.code === 'E_APPROVAL_REQUIRED' && error.reason === reason;

test(
  'standard mode: dismiss idiom, nouns and harmless links are ordinary; verbs, dialog confirms and gated links are not',
  {
    timeout: 90000,
  },
  async () => {
    const f = await classFixture('standard');
    try {
      // Ordinary controls are dispatched.
      const ordinary: [string, number, string][] = [
        ['Cancel', 0, 'dc'],
        ['OK', 0, 'ok-out'],
        ['Sort order', 0, 'sort'],
        ['お気に入りに登録', 0, 'fav'],
        ['確定', 0, 'kakutei'],
        ['Reset filters', 0, 'resetf'],
      ];
      const expected: string[] = [];
      for (const [name, nth, hit] of ordinary) {
        await f.click(name, nth);
        expected.push(hit);
        assert.deepEqual(await f.fired(), expected, name);
      }
      // Gated controls are refused with requires_ask_mode and nothing is dispatched.
      const getsBefore = [...f.gets];
      const gated: [string, number][] = [
        ['Unsubscribe', 0],
        ['Archive', 0],
        ['Reset', 0],
        ['Clear', 0],
        ['Log out', 0],
        ['Report', 0],
      ];
      for (const [name, nth] of gated)
        await assert.rejects(f.click(name, nth), isAskRequired('requires_ask_mode'), `${name} #${nth}`);
      assert.deepEqual(await f.fired(), expected, 'nothing was dispatched');
      assert.deepEqual(f.gets, getsBefore, 'no link was followed');
      assert.equal(f.page.url(), f.origin + '/');
      // "Delete" and the confirmation of a "Delete" dialog run with the network closed: tests/browser-contained-delete.test.ts.
      await f.click('Delete Buy milk');
      expected.push('delete');
      assert.deepEqual(await f.fired(), expected, 'contained Delete');
      // The refusal names the way out.
      const refused = await f.click('Archive').catch((error: unknown) => safeError(error));
      assert.equal((refused as { reason?: string }).reason, 'requires_ask_mode');
      assert.equal((refused as { workspace_setting?: string }).workspace_setting, 'agentdesklink.operationMode');
      assert.equal((refused as { policy_setting?: string }).policy_setting, 'consequentialAllowLabels');
      assert.match((refused as { safe_message: string }).safe_message, /consequentialAllowLabels/);
      // Navigation-only links with a harmless label and URL are followed; the session stays usable.
      await f.click('How to cancel');
      assert.equal(f.page.url(), f.origin + '/help/how-to-cancel');
      await f.click('Order history');
      assert.equal(f.page.url(), f.origin + '/orders');
      assert.equal(f.gets.at(-1), '/orders');
      await assert.rejects(f.click('Log out'), isAskRequired('requires_ask_mode'));
      assert.equal(f.page.url(), f.origin + '/orders');
      assert.ok((await f.engine.observe(f.id, { token_budget: 8000 })).elements!.length > 5, 'session alive');
    } finally {
      await f.close();
    }
  },
);

test(
  'the allow list makes the ToDo "Delete" clickable in standard mode and the deny list gates ordinary controls',
  {
    timeout: 90000,
  },
  async () => {
    const f = await classFixture('standard', {
      consequentialAllowLabels: ['Delete'],
      consequentialDenyLabels: ['Sort'],
    });
    try {
      assert.deepEqual(f.policy.consequentialAllowLabels, ['delete']);
      assert.equal(await f.page.locator('#todo li').count(), 1);
      await f.click('Delete Buy milk');
      assert.equal(await f.page.locator('#todo li').count(), 0, 'the item disappeared');
      assert.deepEqual(await f.fired(), ['delete']);
      // The allow list clears labels only: a real form submission is still stopped in place...
      await assert.rejects(f.click('Save'), (error: unknown) => {
        assert.ok(error instanceof AdlError);
        assert.equal(error.reason, 'form_submission_requires_approval');
        return true;
      });
      // ...other verbs stay gated, and the deny list beats everything for its own words.
      await assert.rejects(f.click('Archive'), isAskRequired('requires_ask_mode'));
      await assert.rejects(f.click('Sort order'), isAskRequired('requires_ask_mode'));
      assert.deepEqual(await f.fired(), ['delete']);
      // A download link is never relaxed by a list entry.
      const g = await classFixture('standard', { consequentialAllowLabels: ['Report', 'Log out'] });
      try {
        await assert.rejects(g.click('Report'), isAskRequired('requires_ask_mode'));
        await g.click('Log out');
        assert.equal(g.page.url(), g.origin + '/logout', 'the allow-listed link verb is followed');
      } finally {
        await g.close();
      }
    } finally {
      await f.close();
    }
  },
);

test(
  'ask mode asks before dispatching every gated control, and an allow-listed Delete needs no approval',
  {
    timeout: 120000,
  },
  async () => {
    const broker = await approvalBroker();
    const f = await classFixture('ask');
    try {
      const hits = async (name: string, nth: number, hit: string | undefined) => {
        const t = await f.target(name, nth);
        const before = await f.fired();
        await assert.rejects(
          f.engine.act(f.id, t.action, t.revision),
          (error: unknown) =>
            error instanceof AdlError && error.code === 'E_APPROVAL_REQUIRED' && typeof error.requestId === 'string',
          name,
        );
        assert.deepEqual(await f.fired(), before, `${name}: nothing dispatched before the approval`);
        assert.equal(broker.state.request.summary.name, name);
        assert.equal((await f.engine.approvals()).requests[0]?.status, 'pending');
        broker.state.approved = true;
        try {
          await f.engine.act(f.id, t.action, t.revision);
        } finally {
          broker.state.approved = false;
        }
        if (hit) assert.deepEqual(await f.fired(), [...before, hit], `${name}: dispatched after the approval`);
        assert.equal((await f.engine.approvals()).requests.length, 0, 'the approval was consumed');
      };
      // Ordinary controls need no approval.
      await f.click('Sort order');
      await f.click('Cancel');
      assert.equal(broker.state.requests, 0);
      await hits('OK', 1, 'ok-in');
      await hits('Unsubscribe', 0, 'unsub');
      await hits('Archive', 0, 'archive');
      await hits('Reset', 0, 'reset');
      await hits('Clear', 0, 'clear');
      await hits('Delete Buy milk', 0, 'delete');
      assert.equal(broker.state.requests, 6);
      // A log-out link is followed only after the approval.
      await hits('Log out', 0, undefined);
      assert.equal(f.page.url(), f.origin + '/logout');
      // A download link asks as well (left pending; nothing is downloaded).
      const t = await f.target('Report');
      await assert.rejects(f.engine.act(f.id, t.action, t.revision), (error: unknown) => {
        return error instanceof AdlError && error.code === 'E_APPROVAL_REQUIRED' && typeof error.requestId === 'string';
      });
      assert.equal(broker.state.requests, 8);
    } finally {
      await f.close();
      await broker.close();
    }
    const b2 = await approvalBroker();
    const g = await classFixture('ask', { consequentialAllowLabels: ['Delete'] });
    try {
      await g.click('Delete Buy milk');
      assert.equal(await g.page.locator('#todo li').count(), 0);
      assert.equal(b2.state.requests, 0, 'no approval was requested');
      await assert.rejects(g.click('Archive'), (error: unknown) => {
        return error instanceof AdlError && error.code === 'E_APPROVAL_REQUIRED' && typeof error.requestId === 'string';
      });
      assert.equal(b2.state.requests, 1);
    } finally {
      await g.close();
      await b2.close();
    }
  },
);

// ---- Fact collection and proof binding (inspectBrowserAction in a real page) ----------------

async function probeServer() {
  let html = '';
  const app = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html>' + html);
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  return {
    async show(content: string) {
      html = content;
      await page.goto(origin + '/page', { waitUntil: 'domcontentloaded' });
    },
    async probe(selector: string, action: Action = { action: 'click' }, lists?: LabelLists) {
      const el = await page.locator(selector).elementHandle();
      assert.ok(el, selector);
      try {
        await el.scrollIntoViewIfNeeded();
        return await inspectBrowserAction(el, action, undefined, lists);
      } finally {
        await el.dispose();
      }
    },
    page,
    async close() {
      await browser.close();
      app.closeAllConnections();
      await new Promise<void>(resolve => app.close(() => resolve()));
    },
  };
}

test('link, form and credential facts: lists clear label risk only', { timeout: 60000 }, async () => {
  const p = await probeServer();
  try {
    await p.show(`<form role="search" method="get" action="/s"><input type="search" aria-label="Search products" name="q"><button id="go">Search</button></form>
<form method="post" action="/save"><input name="title" aria-label="Title" value="t"><button id="save">Save</button></form>
<form method="post" action="/login"><input type="password" name="pw" aria-label="Pass"><button id="signin">Continue</button></form>
<input type="password" id="pw" aria-label="Password">
<input type="file" id="file" aria-label="Upload">
<a id="orders" href="/orders">Order history</a><a id="go-link" href="/logout">Go</a><a id="js" href="javascript:void(0)">Delete</a><a id="nohref">Delete</a>
<a id="dl" href="/report.csv" download>Report</a><a id="cross" href="https://other.example/orders">Order history</a><a id="crossdel" href="https://other.example/account">Delete account</a>`);
    // Search forms: Enter and the Search button are ordinary and not a submission.
    const enter = await p.probe('input[type=search]', { action: 'press', value: 'Enter' });
    assert.equal(enter.risk, 'ordinary');
    assert.equal(enter.submission, undefined);
    assert.equal((await p.probe('#go')).risk, 'ordinary');
    // A POST form is a submission: the allow list cannot clear it, the deny list turns it into a labelled risk.
    const plain = await p.probe('#save');
    assert.equal(plain.risk, 'consequential');
    assert.equal(plain.submission, 'plain');
    assert.equal(plain.classification, null);
    const allowed = await p.probe('#save', { action: 'click' }, { allow: ['Save'], deny: [] });
    assert.equal(allowed.risk, 'consequential');
    assert.equal(allowed.submission, 'plain');
    assert.equal(allowed.classification, 'allow_list');
    const denied = await p.probe('#save', { action: 'click' }, { allow: ['Save'], deny: ['Save'] });
    assert.equal(denied.risk, 'consequential');
    assert.equal(denied.submission, undefined);
    assert.equal(denied.classification, 'deny_list');
    // Credentials stay credentials whatever the lists say.
    const lists = { allow: ['Password', 'Pass', 'Continue'], deny: [] };
    assert.equal((await p.probe('#pw', { action: 'fill', value: 'x' }, lists)).risk, 'credential');
    assert.equal((await p.probe('#signin', { action: 'click' }, lists)).risk, 'credential');
    assert.equal((await p.probe('#signin', { action: 'click' })).risk, 'credential');
    // File inputs cannot be inspected at all.
    await assert.rejects(p.probe('#file', { action: 'click' }, { allow: ['Upload'], deny: [] }));
    // Links.
    const orders = await p.probe('#orders');
    assert.equal(orders.risk, 'ordinary');
    assert.equal(orders.classification, null);
    assert.equal(
      (await p.probe('#orders', { action: 'click' }, { allow: [], deny: ['Order history'] })).risk,
      'consequential',
    );
    assert.equal((await p.probe('#go-link')).classification, 'link_url');
    assert.equal((await p.probe('#js')).classification, 'label');
    assert.equal((await p.probe('#nohref')).classification, 'label');
    assert.equal((await p.probe('#dl')).classification, 'download');
    assert.equal(
      (await p.probe('#dl', { action: 'click' }, { allow: ['Report'], deny: [] })).classification,
      'download',
    );
    assert.equal((await p.probe('#cross')).risk, 'ordinary');
    const cross = await p.probe('#crossdel');
    assert.equal(cross.risk, 'consequential');
    assert.equal(cross.classification, 'label');
  } finally {
    await p.close();
  }
});

test('the document base URL decides whether a link is same-origin', { timeout: 60000 }, async () => {
  const p = await probeServer();
  try {
    await p.show(`<a id="a" href="/account">Delete account</a>`);
    assert.equal((await p.probe('#a')).classification, 'link_verb');
    await p.show(`<base href="https://other.example/"><a id="a" href="/account">Delete account</a>`);
    assert.equal((await p.probe('#a')).classification, 'label', 'resolved cross-origin: the button vocabulary applies');
    await p.show(`<base href="/shop/"><a id="a" href="logout">Go</a>`);
    assert.equal((await p.probe('#a')).classification, 'link_url', 'relative href resolved against <base>');
    await p.show(`<a id="a" href="/${'x/'.repeat(40)}logout">Go</a>`);
    assert.equal((await p.probe('#a')).classification, 'link_url', 'padding segments do not hide the action word');
  } finally {
    await p.close();
  }
});

test(
  'an affirmative button inherits its dialog; the dialog name and link are part of the proof',
  {
    timeout: 60000,
  },
  async () => {
    const p = await probeServer();
    try {
      await p.show(`<dialog open aria-label="Delete this item?" style="position:static"><button id="a">OK</button><button id="a2">Cancel</button></dialog>
<div role="dialog" aria-labelledby="t1"><h2 id="t1">注文を確定しますか</h2><button id="b">はい</button></div>
<div role="alertdialog"><h3>Delete everything</h3><button id="c">Confirm</button></div>
<div role="dialog" aria-label="Settings"><button id="d">OK</button></div>
<form role="dialog" aria-label="Delete this item?"><input name="matches"><input name="querySelector"><input name="getAttribute"><input name="parentElement"><input name="getRootNode"><button type="button" id="e">OK</button></form>
<button id="f">OK</button>`);
      assert.equal((await p.probe('#a')).classification, 'dialog');
      assert.equal((await p.probe('#a')).risk, 'consequential');
      assert.equal((await p.probe('#a2')).risk, 'ordinary');
      assert.equal((await p.probe('#b')).classification, 'dialog');
      assert.equal((await p.probe('#c')).classification, 'dialog');
      assert.equal((await p.probe('#d')).risk, 'ordinary');
      assert.equal(
        (await p.probe('#e')).classification,
        'dialog',
        'named properties of the dialog form do not hide it',
      );
      assert.equal((await p.probe('#f')).risk, 'ordinary');
      // Allowing the label "OK" clears the inherited verdict (label risk only).
      assert.equal((await p.probe('#a', { action: 'click' }, { allow: ['OK'], deny: [] })).risk, 'ordinary');
      // A changed dialog title or link destination changes the proof, so an approval cannot be replayed on it.
      const before = (await p.probe('#d')).proof;
      await p.page.locator('[aria-label="Settings"]').evaluate(e => e.setAttribute('aria-label', 'Delete account'));
      const after = await p.probe('#d');
      assert.notEqual(after.proof, before);
      assert.equal(after.classification, 'dialog');
      await p.show(
        `<a id="l" href="/orders">Open</a><div role="dialog"><h2>Title</h2><button id="b">Next</button></div>`,
      );
      const link = (await p.probe('#l')).proof;
      const dialog = (await p.probe('#b')).proof;
      await p.page.locator('#l').evaluate(e => e.setAttribute('href', '/orders/cancel'));
      await p.page.locator('h2').evaluate(e => (e.textContent = 'Other title'));
      assert.notEqual((await p.probe('#l')).proof, link);
      assert.notEqual((await p.probe('#b')).proof, dialog);
    } finally {
      await p.close();
    }
  },
);

test(
  'snapshot fingerprints are stable without the vocabulary and still see a submit control leave its form',
  {
    timeout: 60000,
  },
  async () => {
    const f = await classFixture('standard');
    try {
      const first = await f.engine.observe(f.id, { token_budget: 8000 });
      const second = await f.engine.observe(f.id, { token_budget: 8000 });
      assert.equal(second.revision, first.revision, 'the same DOM keeps its revision');
      // A submit button that leaves its form changes the fingerprint (its name is unchanged).
      await f.page.locator('#save').evaluate(e => document.body.append(e));
      const third = await f.engine.observe(f.id, { token_budget: 8000 });
      assert.notEqual(third.revision, second.revision);
      const fourth = await f.engine.observe(f.id, { token_budget: 8000 });
      assert.equal(fourth.revision, third.revision, 'and the new DOM is stable again');
    } finally {
      await f.close();
    }
  },
);
