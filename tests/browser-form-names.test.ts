import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import { AdlError, type AdapterSession } from '../src/types.js';

// Form named properties (<input name="matches">) shadow element APIs in every JS
// world, and Playwright's injected code and CSS engine read them from the page's
// own DOM. Every control name must still be observable and operable end to end.
const NAMES = [
  'tagName',
  'getAttribute',
  'action',
  'method',
  'elements',
  'matches',
  'closest',
  'parentElement',
  'children',
  'submit',
  'id',
  'attributes',
  'hasAttribute',
  'tabIndex',
  'firstChild',
  'checkVisibility',
  'getRootNode',
  'isConnected',
  'nodeType',
  'enctype',
  'target',
  'querySelector',
  'querySelectorAll',
  'contains',
  'labels',
  'form',
  'disabled',
  'getBoundingClientRect',
  'shadowRoot',
  'firstElementChild',
  'ownerDocument',
  'nodeName',
  'childNodes',
  'parentNode',
  'nextSibling',
  'getClientRects',
  'offsetParent',
  'style',
  'className',
  'classList',
  'localName',
  'namespaceURI',
  'reset',
  'length',
  'name',
  'title',
  'type',
  'hidden',
  'lang',
  'dir',
  'onclick',
  'focus',
  'blur',
  'scrollIntoView',
  'dispatchEvent',
  'addEventListener',
  'getElementsByTagName',
  'innerText',
  'textContent',
  'nodeValue',
  'isContentEditable',
  'scrollWidth',
  'scrollHeight',
  'clientHeight',
  'clientWidth',
  'scrollTop',
  'scrollLeft',
  'offsetWidth',
  'offsetHeight',
  'offsetTop',
  'offsetLeft',
  'previousElementSibling',
  'nextElementSibling',
  'lastChild',
  'removeAttribute',
  'setAttribute',
  'insertAdjacentHTML',
  'compareDocumentPosition',
  'isEqualNode',
  'cloneNode',
  'appendChild',
  'scrollBy',
  'getAttributeNode',
  'getAttributeNames',
  'checkValidity',
  'reportValidity',
  'requestSubmit',
  'namedItem',
  'item',
  'baseURI',
  'assignedSlot',
  'slot',
  'part',
];
const TYPED =
  '<input type="date" aria-label="Day"><input type="time" aria-label="Clock"><input type="datetime-local" aria-label="Moment"><input type="month" aria-label="Period"><input type="week" aria-label="Sprint"><input type="color" aria-label="Tint"><input type="range" min="0" max="10" aria-label="Level">';
const FORM =
  '<input aria-label="Memo"><input type="checkbox" aria-label="Agree"><select aria-label="Pick"><option value="A">A</option><option value="B">B</option></select><button id="go" type="button" onclick="window.went=(window.went||0)+1">Go</button>';

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(mode: 'standard' | 'ask') {
  const state = { submissions: 0 };
  const app = createServer(async (req, res) => {
    if (req.method === 'POST') {
      state.submissions++;
      for await (const _ of req) {
        /* drain */
      }
      res.end('<!doctype html><p>Thanks</p>');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const url = new URL(req.url ?? '/', 'http://x'),
      name = url.searchParams.get('n') ?? 'matches',
      img = url.searchParams.get('img'),
      typed = url.searchParams.get('typed') ? TYPED : '';
    // img: document-named images whose id/name shadow document.documentElement/body/etc. on top of the form controls.
    res.end(
      '<!doctype html><title>Real title</title><style>input,select,button{display:block;margin:8px}</style>' +
        `<form id="f" action="/real" method="post"><input name="${name}" value="v">${FORM}${typed}<button id="send">Send</button></form>` +
        (img
          ? `<img id="documentElement" name="${img}" src="data:,"><img id="body" name="documentElement" src="data:,"><img name="ownerDocument" src="data:,">`
          : '') +
        '<p>After</p>',
    );
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
      state,
      instance: instance!,
      id: session.session_id,
      page: (instance as unknown as { pageValue: Page }).pageValue,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

// A fake VS Code approval broker (see approval-retry.test.ts): requests stay pending until approved.
async function broker() {
  const saved = [process.env.ADL_APPROVAL_URL, process.env.ADL_APPROVAL_TOKEN, process.env.ADL_APPROVAL_EPOCH],
    token = randomBytes(32).toString('base64url');
  const requests = new Map<string, { request_id: string; binding: string; expires_at: number }>(),
    approved = new Set<string>();
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    let id = req.url!.split('/').pop()!;
    if (req.method === 'POST') {
      const body = JSON.parse(Buffer.concat(parts).toString());
      requests.set(body.request_id, body);
      id = body.request_id;
    }
    const request = requests.get(id);
    if (!request) {
      res.writeHead(404);
      res.end();
      return;
    }
    const status = req.method === 'DELETE' ? 'consumed' : approved.has(id) ? 'approved' : 'pending';
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        v: 1,
        request_id: id,
        binding: request.binding,
        status,
        expires_at: request.expires_at,
        ...(req.method === 'DELETE' ? { consumed_now: approved.has(id) } : {}),
      }),
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.ADL_APPROVAL_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.ADL_APPROVAL_TOKEN = token;
  process.env.ADL_APPROVAL_EPOCH = randomUUID();
  return {
    approved,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(r => server.close(() => r()));
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

async function exercise(f: Fixture, url: string, label: string, approve?: Set<string>) {
  await f.page.goto(url);
  const act = async (action: any, revision: number) => {
    try {
      return await f.engine.act(f.id, action, revision);
    } catch (error) {
      if (approve && error instanceof AdlError && error.code === 'E_APPROVAL_REQUIRED' && error.requestId) {
        approve.add(error.requestId);
        return await f.engine.act(f.id, action, revision);
      }
      throw error;
    }
  };
  let view = await f.engine.observe(f.id, { token_budget: 8000 });
  const find = (n: string) => {
    const e = view.elements!.find(x => x.name === n);
    assert.ok(e, `${label}: ${n} observed`);
    return e;
  };
  await act({ action: 'click', element_id: find('Go').id }, view.revision);
  assert.equal(await f.page.evaluate(() => (window as unknown as { went?: number }).went), 1, `${label}: click`);
  view = await f.engine.observe(f.id, { token_budget: 8000 });
  await act({ action: 'fill', element_id: find('Memo').id, value: 'typed' }, view.revision);
  view = await f.engine.observe(f.id, { token_budget: 8000 });
  assert.equal(find('Memo').value, 'typed', `${label}: fill`);
  await act({ action: 'check', element_id: find('Agree').id, checked: true }, view.revision);
  view = await f.engine.observe(f.id, { token_budget: 8000 });
  assert.equal(
    await f.page.evaluate(() => (document.querySelector('input[type=checkbox]') as HTMLInputElement).checked),
    true,
    `${label}: check`,
  );
  await act({ action: 'select', element_id: find('Pick').id, value: 'B' }, view.revision);
  view = await f.engine.observe(f.id, { token_budget: 8000 });
  assert.equal(
    await f.page.evaluate(() => (document.querySelector('select') as HTMLSelectElement).value),
    'B',
    `${label}: select`,
  );
  await act({ action: 'press', element_id: find('Memo').id, value: 'Tab' }, view.revision);
  view = await f.engine.observe(f.id, { token_budget: 8000 });
  const text = await f.engine.observe(f.id, { text: { element_id: find('Go').id, offset: 0, length: 100 } });
  assert.equal(text.text?.content, 'Go', `${label}: readText`);
  if (approve) {
    // The form-submitting click goes through the approval proof, then dispatches.
    const before = f.state.submissions;
    await act({ action: 'click', element_id: find('Send').id }, view.revision);
    for (let i = 0; i < 50 && f.state.submissions === before; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(f.state.submissions, before + 1, `${label}: approved submit`);
  }
}

// Each problem group (names read by Playwright's selector engine or injected actionability code) gets its own page; the full probe list runs on one page per name.
for (const mode of ['standard', 'ask'] as const)
  for (const group of [
    'plainName',
    'matches',
    'parentNode',
    'parentElement',
    'getAttribute',
    'closest',
    'tagName',
    'ownerDocument',
    'documentElement-image',
  ])
    test(`form control "${group}" keeps every action working in ${mode} mode`, { timeout: 60000 }, async () => {
      const b = mode === 'ask' ? await broker() : undefined,
        f = await fixture(mode);
      try {
        await exercise(
          f,
          group === 'documentElement-image' ? `${f.origin}/?n=title&img=tagName` : `${f.origin}/?n=${group}`,
          group,
          b?.approved,
        );
      } finally {
        await f.close();
        await b?.close();
      }
    });

test('every probed control name keeps the form operable in standard mode', { timeout: 900000 }, async () => {
  const f = await fixture('standard');
  const failures: string[] = [];
  try {
    for (const name of process.env.ADL_NAMES ? process.env.ADL_NAMES.split(',') : new Set(NAMES))
      try {
        await Promise.race([
          exercise(f, `${f.origin}/?n=${name}`, name),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 30000)),
        ]);
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message.split('\n')[0] : error}`);
        if (!(await f.engine.listSessions()).sessions.length) break;
      }
    assert.deepEqual(failures, []);
  } finally {
    await f.close();
  }
});

// Input types Playwright fills through their value setter (not by typing) must stay fillable beside a control that shadows the DOM APIs it reads.
const TYPED_FILLS = [
  ['Day', 'date', '2026-03-04'],
  ['Clock', 'time', '13:45'],
  ['Moment', 'datetime-local', '2026-03-04T13:45'],
  ['Period', 'month', '2026-03'],
  ['Sprint', 'week', '2026-W10'],
  ['Tint', 'color', '#12ab34'],
  ['Level', 'range', '7'],
] as const;
for (const name of ['getAttribute', 'matches', 'parentElement', 'closest'])
  test(
    `date, time, color and range controls are filled natively beside a form control named "${name}"`,
    { timeout: 60000 },
    async () => {
      const f = await fixture('standard');
      try {
        await f.page.goto(`${f.origin}/?n=${name}&typed=1`);
        await f.page.evaluate(() => {
          const log: string[] = [];
          (window as unknown as { events: string[] }).events = log;
          for (const type of ['input', 'change'])
            document.addEventListener(type, event => log.push(`${type}:${(event.target as HTMLInputElement).type}`));
        });
        let view = await f.engine.observe(f.id, { token_budget: 8000 });
        for (const [label, type, value] of TYPED_FILLS) {
          const element = view.elements!.find(x => x.name === label);
          assert.ok(element, `${label} observed`);
          await f.engine.act(f.id, { action: 'fill', element_id: element.id, value }, view.revision);
          view = await f.engine.observe(f.id, { token_budget: 8000 });
          assert.equal(
            await f.page.evaluate(t => (document.querySelector(`input[type=${t}]`) as HTMLInputElement).value, type),
            value,
            `${type}: value`,
          );
          assert.deepEqual(
            (await f.page.evaluate(() => (window as unknown as { events: string[] }).events)).filter(event =>
              event.endsWith(`:${type}`),
            ),
            [`input:${type}`, `change:${type}`],
            `${type}: input and change events`,
          );
        }
      } finally {
        await f.close();
      }
    },
  );

test(
  'a malformed date value is an invalid argument and leaves the date control unchanged beside a clobbering control',
  { timeout: 60000 },
  async () => {
    const f = await fixture('standard');
    try {
      await f.page.goto(`${f.origin}/?n=getAttribute&typed=1`);
      let view = await f.engine.observe(f.id, { token_budget: 8000 });
      const day = () => view.elements!.find(x => x.name === 'Day')!;
      await f.engine.act(f.id, { action: 'fill', element_id: day().id, value: '2026-03-04' }, view.revision);
      view = await f.engine.observe(f.id, { token_budget: 8000 });
      await assert.rejects(
        f.engine.act(f.id, { action: 'fill', element_id: day().id, value: 'not-a-date' }, view.revision),
        (error: unknown) => error instanceof AdlError && error.code === 'E_INVALID_ARGUMENT',
      );
      assert.equal(
        await f.page.evaluate(() => (document.querySelector('input[type=date]') as HTMLInputElement).value),
        '2026-03-04',
      );
      view = await f.engine.observe(f.id, { token_budget: 8000 });
      await f.engine.act(f.id, { action: 'fill', element_id: day().id, value: '2027-01-02' }, view.revision);
      assert.equal(
        await f.page.evaluate(() => (document.querySelector('input[type=date]') as HTMLInputElement).value),
        '2027-01-02',
      );
    } finally {
      await f.close();
    }
  },
);
