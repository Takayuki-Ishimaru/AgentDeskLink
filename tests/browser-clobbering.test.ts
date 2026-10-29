import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import { AdlError, safeError, type AdapterSession } from '../src/types.js';

// Named properties that Chromium exposes as own keys of the document, of
// element collections and of forms, overlapping reserved DOM API names.
const COLLECTION_NAMES =
  '<div id="wrap"><input type="hidden" name="item" value="1"><span id="length">Length label</span><p id="namedItem">Named paragraph</p><div item="x" length="y" constructor="z"><button id="go" type="button" onclick="window.went=(window.went||0)+1">Go</button></div><input aria-label="Query"><span id="constructor">c</span><span id="toString">t</span></div><label>Pick <select name="pick"><option id="item">A</option><option name="length" selected>B</option></select></label>';
const DOCUMENT_NAMES =
  '<img name="cookie" src="data:,"><img name="title" src="data:,"><img name="body" src="data:,"><img name="forms" src="data:,"><img name="images" src="data:,"><img name="images" src="data:,"><img name="domain" src="data:,"><img name="createTreeWalker" src="data:,"><img name="getElementById" src="data:,"><img name="baseURI" src="data:,"><img name="toString" src="data:,"><form name="scrollingElement"></form><iframe name="activeElement" src="about:blank" style="width:10px;height:10px"></iframe><object name="querySelectorAll"></object><embed name="querySelector"><h1>Visible heading</h1><button id="go" type="button" onclick="window.went=(window.went||0)+1">Go</button><input aria-label="Query">';
const FORM_NAMES =
  '<form id="f" action="/real" method="post"><input name="tagName" value="a"><input name="getAttribute" value="b"><input name="action" value="/evil"><input name="method" value="get"><input name="elements"><input name="closest"><input name="children"><input name="submit"><input name="id"><input name="attributes"><input name="hasAttribute"><input name="tabIndex"><input name="firstChild"><input name="checkVisibility"><input name="getRootNode"><input name="isConnected"><input name="nodeType"><input name="enctype"><input name="target"><input name="querySelector"><input name="contains"><input name="labels"><input name="form"><input name="disabled"><input name="getBoundingClientRect"><input name="shadowRoot"><input name="firstElementChild"><input name="ownerDocument"><input name="ownerDocument"><input name="nodeName"><input name="childNodes"><input name="style"><input name="length"><button id="send">Send</button></form><form id="g" action="/other"><input name="tagName"><input name="action"><input name="method"><input name="elements"><input name="submit"><input name="id"><input name="children"><input name="isConnected"><input aria-label="Memo"></form><button id="go" type="button" onclick="window.went=(window.went||0)+1">Go</button>';

async function fixture(
  mode: 'standard' | 'ask',
  pages: Record<string, string>,
  onRequest?: (req: IncomingMessage, res: ServerResponse) => boolean,
) {
  const app = createServer((req, res) => {
    if (onRequest?.(req, res)) return;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Real title</title>' + (pages[req.url ?? '/'] ?? pages['/']));
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
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

for (const [label, html] of [
  ['collection', COLLECTION_NAMES],
  ['document', DOCUMENT_NAMES],
  ['form', FORM_NAMES],
] as const)
  test(
    `${label} named properties keep a script-free page observable and operable in standard mode`,
    { timeout: 30000 },
    async () => {
      const f = await fixture('standard', { '/': html });
      try {
        let observed = await f.engine.observe(f.id, { token_budget: 8000 });
        assert.equal(observed.title, 'Real title');
        const go = observed.elements!.find(e => e.name === 'Go')!;
        assert.ok(go, 'button after the named elements is observed');
        if (label === 'document')
          assert.ok(
            observed.elements!.some(e => e.role === 'heading' && e.name === 'Visible heading'),
            'document.body shadowing does not hide the body',
          );
        if (label === 'form')
          assert.ok(
            observed.elements!.some(e => e.name === 'Memo'),
            'form named properties do not hide the form controls',
          );
        await f.engine.act(f.id, { action: 'click', element_id: go.id }, observed.revision);
        assert.equal(await f.page.evaluate(() => (window as unknown as { went?: number }).went), 1);
        observed = await f.engine.observe(f.id, { token_budget: 8000 });
        const field = observed.elements!.find(e => e.name === (label === 'form' ? 'Memo' : 'Query'))!;
        assert.ok(field);
        await f.engine.act(f.id, { action: 'fill', element_id: field.id, value: 'typed' }, observed.revision);
        observed = await f.engine.observe(f.id, { token_budget: 8000 });
        assert.equal(observed.elements!.find(e => e.id === field.id)!.value, 'typed');
        if (label === 'collection') {
          const pick = observed.elements!.find(e => e.name === 'Pick')!;
          assert.ok(pick);
          await f.engine.act(f.id, { action: 'select', element_id: pick.id, value: 'A' }, observed.revision);
          observed = await f.engine.observe(f.id, { token_budget: 8000 });
          assert.equal(observed.elements!.find(e => e.id === pick.id)!.value, 'A');
        }
        const text = await f.engine.observe(f.id, {
          text: { element_id: observed.elements!.find(e => e.name === 'Go')!.id, offset: 0, length: 100 },
        });
        assert.equal(text.text?.content, 'Go');
      } finally {
        await f.close();
      }
    },
  );

test('approval details use the real form action, never a control named "action"', { timeout: 30000 }, async () => {
  const saved = [process.env.ADL_APPROVAL_URL, process.env.ADL_APPROVAL_TOKEN, process.env.ADL_APPROVAL_EPOCH];
  const token = randomBytes(32).toString('base64url'),
    epoch = randomUUID();
  let request: any;
  const broker = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(Buffer.from(c));
    const data = Buffer.concat(parts).toString();
    if (req.method === 'POST') request = JSON.parse(data);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        v: 1,
        request_id: request.request_id,
        binding: request.binding,
        status: 'pending',
        expires_at: request.expires_at,
      }),
    );
  });
  await new Promise<void>(resolve => broker.listen(0, '127.0.0.1', resolve));
  process.env.ADL_APPROVAL_URL = `http://127.0.0.1:${(broker.address() as { port: number }).port}`;
  process.env.ADL_APPROVAL_TOKEN = token;
  process.env.ADL_APPROVAL_EPOCH = epoch;
  const html =
    '<form id="f" action="/real" method="post"><input name="action" value="/evil"><input name="method" value="get"><input name="enctype" value="multipart/form-data"><input name="elements" value="e"><input name="tagName" value="t"><input aria-label="Memo" name="memo" value="hello"><button id="send">Send</button></form>';
  const f = await fixture('ask', { '/': html });
  try {
    const observed = await f.engine.observe(f.id, { token_budget: 8000 });
    const send = observed.elements!.find(e => e.name === 'Send')!;
    assert.ok(send);
    await assert.rejects(
      f.engine.act(f.id, { action: 'click', element_id: send.id }, observed.revision),
      (error: unknown) =>
        error instanceof AdlError && error.code === 'E_APPROVAL_REQUIRED' && typeof error.requestId === 'string',
    );
    const details: string[] = request.summary.details;
    assert.equal(details[0], `Form POST ${f.origin}/real`);
    assert.deepEqual(details.slice(1), [
      '"action": "/evil"',
      '"method": "get"',
      '"enctype": "multipart/form-data"',
      '"elements": "e"',
      '"tagName": "t"',
      '"memo": "hello"',
    ]);
  } finally {
    await f.close();
    broker.closeAllConnections();
    await new Promise<void>(r => broker.close(() => r()));
    for (const [key, value] of [
      ['ADL_APPROVAL_URL', saved[0]],
      ['ADL_APPROVAL_TOKEN', saved[1]],
      ['ADL_APPROVAL_EPOCH', saved[2]],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test(
  'own properties that are not genuine named properties still fail closed without running page code',
  { timeout: 60000 },
  async () => {
    const attacks: [string, () => void][] = [
      [
        'document.body data property',
        () => {
          Object.defineProperty(document, 'body', {
            value: document.createElement('div'),
            configurable: true,
            writable: true,
            enumerable: true,
          });
        },
      ],
      [
        'document.title accessor',
        () => {
          Object.defineProperty(document, 'title', {
            get() {
              (window as unknown as { runs: number }).runs++;
              return 'forged';
            },
            configurable: true,
          });
        },
      ],
      [
        'document.images Proxy value',
        () => {
          Object.defineProperty(document, 'images', {
            value: new Proxy(document.createElement('img'), {
              get() {
                (window as unknown as { runs: number }).runs++;
                return undefined;
              },
              getPrototypeOf() {
                (window as unknown as { runs: number }).runs++;
                return HTMLImageElement.prototype;
              },
              ownKeys() {
                (window as unknown as { runs: number }).runs++;
                return [];
              },
            }),
            configurable: true,
            writable: true,
            enumerable: true,
          });
        },
      ],
      [
        'document.forms mismatched element',
        () => {
          Object.defineProperty(document, 'forms', {
            value: document.querySelector('img[name=cookie]'),
            configurable: true,
            writable: true,
            enumerable: true,
          });
        },
      ],
      [
        'document.createTreeWalker function value',
        () => {
          Object.defineProperty(document, 'createTreeWalker', {
            value: () => null,
            configurable: true,
            writable: true,
            enumerable: true,
          });
        },
      ],
      [
        'children collection item override',
        () => {
          Object.defineProperty(document.getElementById('wrap')!.children, 'item', {
            value: () => null,
            configurable: true,
          });
        },
      ],
      [
        'attributes map getNamedItem override',
        () => {
          Object.defineProperty(document.getElementById('wrap')!.attributes, 'getNamedItem', {
            value: () => null,
            configurable: true,
          });
        },
      ],
      [
        'form action data property',
        () => {
          Object.defineProperty(document.getElementById('plain')!, 'action', {
            value: 'https://evil.example/',
            configurable: true,
            writable: true,
          });
        },
      ],
      [
        'form elements accessor',
        () => {
          Object.defineProperty(document.getElementById('plain')!, 'elements', {
            get() {
              (window as unknown as { runs: number }).runs++;
              return [];
            },
            configurable: true,
          });
        },
      ],
    ];
    for (const [name, attack] of attacks) {
      const f = await fixture('standard', {
        '/': COLLECTION_NAMES + '<img name="cookie" src="data:,"><form id="plain"><input name="q"></form>',
      });
      try {
        assert.equal((await f.engine.observe(f.id, { token_budget: 8000 })).ok, true, name);
        await f.page.evaluate(() => {
          (window as unknown as { runs: number }).runs = 0;
        });
        await f.page.evaluate(attack);
        await assert.rejects(
          f.instance.snapshot(),
          (error: unknown) =>
            error instanceof AdlError && error.code === 'E_PRIVACY_BLOCKED' && error.reason === 'untrusted_dom_api',
          name,
        );
        assert.equal(await f.page.evaluate(() => (window as unknown as { runs: number }).runs), 0, name);
      } finally {
        await f.close();
      }
    }
  },
);

test(
  'a navigation that lands on an unverifiable page reports untrusted_dom_api without destroying the session, and the session can leave',
  { timeout: 30000 },
  async () => {
    const f = await fixture('standard', {
      '/': '<button id="go" type="button">Go</button>',
      '/bad': '<script>Element.prototype.matches=function(){return false}</script><button type="button">Bad</button>',
    });
    try {
      const before = await f.engine.observe(f.id);
      await assert.rejects(
        f.engine.act(f.id, { action: 'navigate', url: f.origin + '/bad' }, before.revision),
        (error: unknown) => {
          assert.ok(error instanceof AdlError);
          assert.equal(error.code, 'E_PRIVACY_BLOCKED');
          assert.equal(error.reason, 'untrusted_dom_api');
          assert.equal(safeError(error).may_have_executed, undefined);
          return true;
        },
      );
      assert.equal(f.page.url(), f.origin + '/bad');
      assert.ok(
        (await f.engine.listSessions()).sessions.some(s => s.session_id === f.id),
        'session survives',
      );
      await assert.rejects(
        f.engine.observe(f.id),
        (error: unknown) =>
          error instanceof AdlError && error.code === 'E_PRIVACY_BLOCKED' && error.reason === 'untrusted_dom_api',
      );
      await assert.rejects(
        f.instance.snapshot(),
        (error: unknown) =>
          error instanceof AdlError && error.code === 'E_PRIVACY_BLOCKED' && error.reason === 'untrusted_dom_api',
      );
      // Leaving the page reads nothing from its DOM, so the adapter still navigates away.
      await f.instance.act({ action: 'navigate', url: f.origin + '/' }, new AbortController().signal);
      const after = await f.engine.observe(f.id);
      assert.ok(after.elements!.some(e => e.name === 'Go'));
      // The engine also lets a client leave an unverifiable page with its last revision.
      await assert.rejects(f.engine.act(f.id, { action: 'navigate', url: f.origin + '/bad' }, after.revision), {
        code: 'E_PRIVACY_BLOCKED',
      });
      const left = await f.engine.act(f.id, { action: 'back' }, after.revision);
      assert.equal(left.ok, true);
      assert.ok((await f.engine.observe(f.id)).elements!.some(e => e.name === 'Go'));
    } finally {
      await f.close();
    }
  },
);
