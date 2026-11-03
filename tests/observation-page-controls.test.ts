import { browserRuntimeEnv } from './browser-runtime-env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';

type Page = string | { status?: number; html?: string; headers?: Record<string, string> };
interface Options {
  controls?: { selector: string; actions: string[] }[];
  operationMode?: 'read_only' | 'standard' | 'ask';
  start?: string;
}
/** The parts of an action result these tests read. */
type ActResult = {
  revision: number;
  http_status?: number;
  observation?: { changes?: { op: string; id: string; element?: { value?: string } }[] };
};

async function fixture(pages: Record<string, Page>, options: Options = {}) {
  const app = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]!;
    const page = pages[path] ?? pages['/'] ?? '';
    const spec = typeof page === 'string' ? { html: page } : page;
    response.statusCode = spec.status ?? 200;
    response.setHeader('content-type', 'text/html; charset=utf-8');
    for (const [name, value] of Object.entries(spec.headers ?? {})) response.setHeader(name, value);
    response.end(spec.html ?? '');
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 5000,
    ...(options.operationMode ? { operationMode: options.operationMode } : {}),
    browserTargets: [
      {
        id: 'p',
        label: 'Fixture',
        url: origin + (options.start ?? '/'),
        classification: 'PUBLIC',
        controls: options.controls ?? [],
      },
    ],
  });
  const engine = new Engine(policy, {
    browser: new BrowserAdapter(policy, (url, purpose) => assertUrlAllowed(url, policy, undefined, purpose)),
  });
  const opened = await engine.open((await engine.listTargets()).targets[0]!.target_id);
  const id = opened.session_id;
  return {
    engine,
    opened: opened as typeof opened & { http_status?: number },
    id,
    origin,
    observe: (extra: Parameters<Engine['observe']>[1] = {}) => engine.observe(id, { token_budget: 8000, ...extra }),
    act: async (action: Parameters<Engine['act']>[1], revision: number) =>
      (await engine.act(id, action, revision)) as ActResult,
    close: async () => {
      await engine.shutdown();
      app.closeAllConnections();
      await new Promise<void>(resolve => app.close(() => resolve()));
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const EDITORS = `<!doctype html><title>Editors</title>
<div id="rich" contenteditable="true" role="textbox" aria-label="Notes editor"></div>
<div id="bare" contenteditable aria-label="Bare editor"></div>
<div data-adl-sensitive><div id="private" contenteditable role="textbox" aria-label="Notes">CANARY_REGION_TEXT</div></div>
<div id="token" contenteditable role="textbox" aria-label="API token"><p>CANARY_TOKEN_TEXT</p></div>
<div id="mixed" contenteditable role="textbox" aria-label="Mixed"><p>Visible start</p><div hidden>CANARY_HIDDEN_ATTR</div><span style="display:none">CANARY_DISPLAY_NONE</span><span style="visibility:hidden">CANARY_VISIBILITY</span><span aria-hidden="true">CANARY_ARIA_HIDDEN</span><span data-adl-sensitive>CANARY_INNER_REGION</span><p style="font-size:1px">TINY_TEXT</p><input value="CANARY_INPUT_VALUE"><p>Visible <b>end</b></p></div>
<div id="long" contenteditable role="textbox" aria-label="Long editor">${'word '.repeat(300)}</div>`;

test(
  'contenteditable text is its value: observation, action diff and revision follow typing',
  { timeout: 60000 },
  async () => {
    const f = await fixture({ '/': EDITORS }, { operationMode: 'standard' });
    try {
      const before = await f.observe();
      const rich = before.elements!.find(e => e.name === 'Notes editor')!;
      assert.equal(rich.role, 'textbox');
      assert.ok(!('value' in rich), 'an empty editor is listed, and its empty value is omitted like any empty value');
      const bare = before.elements!.find(e => e.name === 'Bare editor')!;
      assert.equal(bare.role, 'textbox', 'a bare editing host is a textbox');

      const done = await f.act(
        {
          action: 'fill',
          element_id: rich.id,
          value: 'Hello editor',
          expected_target: { role: 'textbox', name: 'Notes editor' },
          include_diff: true,
        },
        before.revision,
      );
      assert.ok(done.revision > before.revision, 'typing advances the revision');
      const changed = done.observation?.changes?.find(c => c.id === rich.id);
      assert.equal(changed?.op, 'changed');
      assert.equal(changed?.element?.value, 'Hello editor', 'the action diff carries the typed text');

      const after = await f.observe();
      assert.equal(after.elements!.find(e => e.id === rich.id)!.value, 'Hello editor');
      const row = (await f.observe({ format: 'lines' })).lines!.find(l => l.includes('"Notes editor"'))!;
      assert.match(row, /value="Hello editor"/);

      const bareDone = await f.act({ action: 'fill', element_id: bare.id, value: 'Bare text' }, after.revision);
      assert.ok(bareDone.revision > after.revision);
      const delta = await f.observe({ since_revision: after.revision, representation: 'delta' });
      assert.deepEqual(
        delta.changes!.map(c => [c.op, c.id, c.element?.value]),
        [['changed', bare.id, 'Bare text']],
      );

      const cleared = await f.act({ action: 'fill', element_id: rich.id, value: '' }, bareDone.revision);
      assert.ok(cleared.revision > bareDone.revision);
      assert.equal((await f.observe()).elements!.find(e => e.id === rich.id)!.value, undefined, 'empty again');
    } finally {
      await f.close();
    }
  },
);

test(
  'contenteditable value keeps protected regions, secret labels and hidden text out',
  { timeout: 60000 },
  async () => {
    const f = await fixture({ '/': EDITORS });
    try {
      const state = await f.observe();
      const text = JSON.stringify(state);
      for (const canary of [
        'CANARY_REGION_TEXT',
        'CANARY_TOKEN_TEXT',
        'CANARY_HIDDEN_ATTR',
        'CANARY_DISPLAY_NONE',
        'CANARY_VISIBILITY',
        'CANARY_INNER_REGION',
        'TINY_TEXT',
      ])
        assert.ok(!text.includes(canary), canary);

      const privateEditor = state.elements!.find(e => e.protected && e.role === 'textbox')!;
      assert.ok(privateEditor, 'an editor inside a protected region is listed as protected');
      assert.equal(privateEditor.value ?? '', '', 'its text is not read at all');

      const token = state.elements!.find(e => e.name === 'API token')!;
      assert.equal(token.value, '[redacted]', 'a secret-labelled editor has a redacted value');
      assert.ok(
        !state.elements!.some(e => e.name.includes('CANARY_TOKEN_TEXT')),
        'nothing inside a secret-labelled editor is listed',
      );

      const mixed = state.elements!.find(e => e.name === 'Mixed')!;
      assert.equal(
        mixed.value,
        'Visible start\nVisible end',
        'blocks become lines; hidden, protected and nested controls are skipped',
      );
      assert.equal(mixed.hidden_text, true, 'text a human cannot see is still flagged');

      const long = state.elements!.find(e => e.name === 'Long editor')!;
      assert.equal(long.value!.length, 512);
      assert.equal(long.value_truncated, true);
      assert.equal(state.text_clipped, true);
      assert.equal(state.truncated, false, 'a clipped value never claims that elements are missing');
    } finally {
      await f.close();
    }
  },
);

test(
  'contenteditable fill works through control grants and keeps the line breaks of a pre-wrap editor',
  { timeout: 60000 },
  async () => {
    const f = await fixture(
      {
        '/': '<!doctype html><title>t</title><div id="pre" contenteditable="plaintext-only" role="textbox" aria-label="Plain" style="white-space:pre-wrap"></div>',
      },
      { controls: [{ selector: '#pre', actions: ['fill'] }] },
    );
    try {
      const before = await f.observe();
      const editor = before.elements!.find(e => e.name === 'Plain')!;
      await f.act({ action: 'fill', element_id: editor.id, value: 'line one\nline two' }, before.revision);
      assert.equal((await f.observe()).elements!.find(e => e.id === editor.id)!.value, 'line one\nline two');
    } finally {
      await f.close();
    }
  },
);

const SLIDERS = `<!doctype html><title>Sliders</title>
<label for="vol">Volume</label><input id="vol" type="range" min="0" max="10" step="2" value="4">
<label for="qty">Quantity</label><input id="qty" type="number" min="1" max="9" step="1" value="3">
<label for="free">Free number</label><input id="free" type="number" value="5">
<label for="bare">Bare range</label><input id="bare" type="range">
<label for="any">Any step</label><input id="any" type="number" step="any" value="1.5">
<label for="txt">Plain text</label><input id="txt" type="text" value="abc">
<div role="slider" aria-label="Brightness" aria-valuemin="0" aria-valuemax="100" aria-valuenow="40" tabindex="0"></div>
<div role="spinbutton" aria-label="Count" aria-valuenow="2" aria-valuemax="12" tabindex="0"></div>
<label for="pin">PIN code</label><input id="pin" type="range" min="0" max="9" value="3">`;

test(
  'range and number inputs, and their ARIA widgets, are slider and spinbutton with bounds',
  { timeout: 60000 },
  async () => {
    const f = await fixture({ '/': SLIDERS });
    try {
      const state = await f.observe();
      const get = (name: string) => state.elements!.find(e => e.name === name)!;
      assert.deepEqual(
        ['Volume', 'Quantity', 'Free number', 'Bare range', 'Any step', 'Plain text', 'Brightness', 'Count'].map(
          name => get(name).role,
        ),
        ['slider', 'spinbutton', 'spinbutton', 'slider', 'spinbutton', 'textbox', 'slider', 'spinbutton'],
      );
      const bounds = (name: string) => {
        const { min, max, step } = get(name);
        return {
          ...(min !== undefined ? { min } : {}),
          ...(max !== undefined ? { max } : {}),
          ...(step !== undefined ? { step } : {}),
        };
      };
      assert.deepEqual(bounds('Volume'), { min: 0, max: 10, step: 2 });
      assert.deepEqual(bounds('Quantity'), { min: 1, max: 9, step: 1 });
      assert.deepEqual(bounds('Free number'), {}, 'absent bounds are omitted');
      assert.deepEqual(bounds('Bare range'), {});
      assert.deepEqual(bounds('Any step'), { step: 'any' });
      assert.deepEqual(bounds('Plain text'), {});
      assert.deepEqual(bounds('Brightness'), { min: 0, max: 100 });
      assert.deepEqual(bounds('Count'), { max: 12 });
      assert.equal(get('Volume').value, '4');
      assert.equal(get('Brightness').value, '40', 'an ARIA widget reports aria-valuenow as its value');
      assert.equal(get('Count').value, '2');
      assert.equal(get('PIN code').value, '[redacted]', 'privacy rules still follow the secret label');
      assert.deepEqual(bounds('PIN code'), {}, 'a masked control exposes no bounds');

      const compact = await f.observe({ format: 'compact' });
      const slider = compact.elements!.find(e => e.name === 'Volume')!;
      assert.deepEqual([slider.role, slider.min, slider.max, slider.step], ['slider', 0, 10, 2]);
      const free = compact.elements!.find(e => e.name === 'Free number')!;
      assert.ok(!('min' in free) && !('max' in free) && !('step' in free));

      const lines = (await f.observe({ format: 'lines' })).lines!;
      const row = (name: string) => lines.find(l => l.includes(`"${name}"`))!;
      assert.match(row('Volume'), /^e\d+ slider "Volume" value="4" min=0 max=10 step=2/);
      assert.match(row('Quantity'), /^e\d+ spinbutton "Quantity" value="3" min=1 max=9 step=1/);
      assert.match(row('Count'), /^e\d+ spinbutton "Count" value="2" max=12/);
      assert.doesNotMatch(row('Free number'), /(?:^|\s)(?:min|max|step)=/);
      assert.match(row('Any step'), /step="any"/);

      const slim = await f.observe({ include: ['id', 'role', 'name', 'min', 'max'] });
      const volume = slim.elements!.find(e => e.name === 'Volume')!;
      assert.deepEqual([volume.min, volume.max, volume.step, volume.value], [0, 10, undefined, undefined]);
    } finally {
      await f.close();
    }
  },
);

test(
  'fill and press still work on number and range inputs, including expected_target with the new roles',
  { timeout: 60000 },
  async () => {
    const f = await fixture({ '/': SLIDERS }, { operationMode: 'standard' });
    try {
      let state = await f.observe();
      const find = (name: string) => state.elements!.find(e => e.name === name)!;
      await f.act(
        {
          action: 'fill',
          element_id: find('Quantity').id,
          value: '7',
          expected_target: { role: 'spinbutton', name: 'Quantity' },
        },
        state.revision,
      );
      state = await f.observe();
      assert.equal(find('Quantity').value, '7');
      assert.equal(find('Quantity').max, 9, 'bounds survive an edit');

      await f.act(
        {
          action: 'fill',
          element_id: find('Volume').id,
          value: '8',
          expected_target: { role: 'slider', name: 'Volume' },
        },
        state.revision,
      );
      state = await f.observe();
      assert.equal(find('Volume').value, '8');

      await f.act({ action: 'press', element_id: find('Volume').id, value: 'ArrowLeft' }, state.revision);
      state = await f.observe();
      assert.equal(find('Volume').value, '6', 'one step down from 8 with step 2');
      await assert.rejects(
        f.act(
          { action: 'fill', element_id: find('Volume').id, value: '2', expected_target: { role: 'textbox' } },
          state.revision,
        ),
        { code: 'E_STALE_STATE' },
      );
    } finally {
      await f.close();
    }
  },
);

const STATUS_PAGES: Record<string, Page> = {
  '/': '<!doctype html><title>Home</title><a href="#section">Jump</a><button id="push" type="button" onclick="history.pushState({},\'\',\'/pushed\')">Push</button><p>Real page</p>',
  '/missing': { status: 404, html: '<!doctype html><title>Not found</title><p>Nothing here</p>' },
  // The script asks for a 204 resource a moment later: the document stays when the response has no content.
  '/missing-then-empty': {
    status: 404,
    html: '<!doctype html><title>Not found</title><p>Nothing here</p><script>setTimeout(() => { location.href = "/empty"; }, 100)</script>',
  },
  '/broken': { status: 503, html: '<!doctype html><title>Broken</title><p>Unavailable</p>' },
  '/to-missing': { status: 302, headers: { location: '/missing' } },
  '/empty': { status: 204 },
};

test(
  'http_status is reported for error pages only: navigation, observation, redirects, same-document changes and back',
  { timeout: 60000 },
  async () => {
    const f = await fixture(STATUS_PAGES, { operationMode: 'standard' });
    try {
      assert.equal('http_status' in f.opened, false, 'a 200 page carries no http_status');
      let state = await f.observe();
      assert.equal(state.http_status, undefined);
      assert.ok(!JSON.stringify(state).includes('http_status'));

      const missing = await f.act({ action: 'navigate', url: f.origin + '/missing' }, state.revision);
      assert.equal(missing.http_status, 404, 'the navigation result reports the error page');
      state = await f.observe();
      assert.equal(state.http_status, 404);
      for (const format of ['compact', 'lines'] as const) assert.equal((await f.observe({ format })).http_status, 404);

      // Same-document navigations keep the status of the document that is still on screen.
      const hash = await f.act({ action: 'navigate', url: f.origin + '/missing#part' }, state.revision);
      assert.equal(hash.http_status, 404);
      state = await f.observe();
      assert.equal(state.http_status, 404);
      assert.ok(state.url!.endsWith('/missing'));

      const broken = await f.act({ action: 'navigate', url: f.origin + '/broken' }, state.revision);
      assert.equal(broken.http_status, 503);
      const redirected = await f.act({ action: 'navigate', url: f.origin + '/to-missing' }, broken.revision);
      assert.equal(redirected.http_status, 404, 'the status is the one of the final document after a redirect');

      const home = await f.act({ action: 'navigate', url: f.origin + '/' }, redirected.revision);
      assert.equal('http_status' in home, false);
      state = await f.observe();
      assert.equal(state.http_status, undefined, 'a successful document clears the status');

      const push = state.elements!.find(e => e.name === 'Push')!;
      await f.act({ action: 'click', element_id: push.id }, state.revision);
      state = await f.observe();
      assert.ok(state.url!.endsWith('/pushed'));
      assert.equal(state.http_status, undefined);

      const gone = await f.act({ action: 'navigate', url: f.origin + '/missing' }, state.revision);
      assert.equal(gone.http_status, 404);
      const back = await f.act({ action: 'back' }, gone.revision);
      assert.equal('http_status' in back, false, 'back reaches a 200 page again');
      assert.equal((await f.observe()).http_status, undefined);
    } finally {
      await f.close();
    }
  },
);

test(
  'adl_open reports the status of an error page, for a configured target and for a URL',
  { timeout: 60000 },
  async () => {
    const f = await fixture(STATUS_PAGES, { start: '/missing', operationMode: 'standard' });
    try {
      assert.equal(f.opened.http_status, 404, 'a target whose page is missing reports it');
      const state = await f.observe();
      assert.equal(state.http_status, 404);
      assert.equal(state.title, 'Not found');
      const viaUrl = await f.engine.openUrl(f.origin + '/broken');
      assert.equal((viaUrl as { http_status?: number }).http_status, 503);
      const ok = await f.engine.openUrl(f.origin + '/');
      assert.equal('http_status' in ok, false);
      assert.equal((await f.engine.observe(ok.session_id, { token_budget: 8000 })).http_status, undefined);
    } finally {
      await f.close();
    }
  },
);

test(
  'a 204 response requested by the page leaves the current document and its status in place',
  { timeout: 60000 },
  async () => {
    const f = await fixture(STATUS_PAGES, { start: '/missing-then-empty', operationMode: 'standard' });
    try {
      assert.equal(f.opened.http_status, 404);
      await new Promise(resolve => setTimeout(resolve, 600));
      const state = await f.observe();
      assert.equal(state.http_status, 404);
      assert.ok(state.url!.endsWith('/missing-then-empty'), 'the document was not replaced');
    } finally {
      await f.close();
    }
  },
);

const SCROLL_PAGE = `<!doctype html><title>Scroll</title><style>body{margin:0}#tall{height:4000px}#pane{height:100px;width:200px;overflow:auto}</style>
<div role="status">Y:0</div><div role="alert">P:0</div>
<div id="pane" role="region" aria-label="Pane"><div style="height:600px">Pane content</div></div><div id="tall">Tall page</div>
<script>
addEventListener('scroll',()=>{document.querySelector('[role=status]').textContent='Y:'+Math.round(scrollY)});
document.getElementById('pane').addEventListener('scroll',e=>{document.querySelector('[role=alert]').textContent='P:'+Math.round(e.target.scrollTop)});
</script>`;

const position = async (f: Fixture, role: 'status' | 'alert', done: (n: number) => boolean) => {
  let value = NaN;
  for (let i = 0; i < 40; i++) {
    const state = await f.observe();
    value = Number(state.elements!.find(e => e.role === role)!.name.split(':')[1]);
    if (done(value)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return value;
};

test('scroll without element_id moves the page; element scroll is unchanged', { timeout: 60000 }, async () => {
  const f = await fixture({ '/': SCROLL_PAGE });
  try {
    let state = await f.observe();
    const pane = state.elements!.find(e => e.name === 'Pane')!;
    await f.act({ action: 'scroll', element_id: pane.id, direction: 'down' }, state.revision);
    const paneTop = await position(f, 'alert', n => n > 0);
    assert.ok(paneTop > 0, `the element scrolled (P:${paneTop})`);
    assert.equal(await position(f, 'status', () => true), 0, 'an element scroll does not move the page');

    state = await f.observe();
    await f.act({ action: 'scroll', direction: 'down' }, state.revision);
    const y = await position(f, 'status', n => n > 0);
    assert.ok(y > 100, `window.scrollY moved (Y:${y})`);

    state = await f.observe();
    await f.act({ action: 'scroll', direction: 'down' }, state.revision);
    const further = await position(f, 'status', n => n > y);
    assert.ok(further > y, 'a second scroll moves further');

    state = await f.observe();
    await f.act({ action: 'scroll', direction: 'up' }, state.revision);
    const back = await position(f, 'status', n => n < further);
    assert.ok(back < further, 'up scrolls back');
    assert.equal(await position(f, 'alert', () => true), paneTop, 'a page scroll does not move the element');
  } finally {
    await f.close();
  }
});

const TICK_PAGE = `<!doctype html><title>Tick</title><style>body{margin:0}</style><div role="status">tick 0</div><div style="height:4000px">Tall</div>
<script>let n=0;setInterval(()=>{document.querySelector('[role=status]').textContent='tick '+(++n)},40)</script>`;

test('page scroll follows the freshness rules and needs only a direction', { timeout: 60000 }, async () => {
  const f = await fixture({
    '/': TICK_PAGE,
    '/short': '<!doctype html><title>Short</title><p>Short page</p>',
  });
  try {
    const first = await f.observe();
    await assert.rejects(f.engine.act(f.id, { action: 'scroll' }, first.revision), {
      code: 'E_INVALID_ARGUMENT',
      detail: { argument: 'direction' },
    });
    await assert.rejects(
      f.engine.act(f.id, { action: 'scroll', direction: 'down', expected_target: { role: 'region' } }, first.revision),
      { code: 'E_INVALID_ARGUMENT' },
    );
    await assert.rejects(f.engine.act(f.id, { action: 'scroll', direction: 'down' }, first.revision + 100), {
      code: 'E_STALE_STATE',
      reason: 'revision_ahead',
    });

    // The document keeps changing by itself; an older revision of the same document is still current enough.
    await new Promise(resolve => setTimeout(resolve, 150));
    const later = await f.observe();
    assert.ok(later.revision > first.revision);
    const scrolled = await f.act({ action: 'scroll', direction: 'down' }, first.revision);
    assert.ok(scrolled.revision >= later.revision);

    // A replaced document is not.
    const nav = await f.act({ action: 'navigate', url: f.origin + '/short' }, (await f.observe()).revision);
    await assert.rejects(f.engine.act(f.id, { action: 'scroll', direction: 'down' }, first.revision), {
      code: 'E_STALE_STATE',
    });
    await assert.rejects(f.engine.act(f.id, { action: 'scroll', direction: 'down' }, nav.revision), {
      code: 'E_UNSUPPORTED_ACTION',
    });
    // Other element actions still need an element.
    await assert.rejects(f.engine.act(f.id, { action: 'click' }, nav.revision), {
      code: 'E_INVALID_ARGUMENT',
      detail: { argument: 'element_id' },
    });
  } finally {
    await f.close();
  }
});

test(
  'stdio: adl_act documents optional element_id for scroll, scrolls the page; adl_open reports http_status',
  { timeout: 90000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adl-page-'));
    const http = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (request.url === '/missing') {
        response.statusCode = 404;
        response.end('<!doctype html><title>Gone</title><p>Missing</p>');
      } else
        response.end(
          '<!doctype html><title>Tall</title><style>body{margin:0}</style><div role="status">Y:0</div><div style="height:4000px">Tall</div><script>addEventListener("scroll",()=>{document.querySelector("[role=status]").textContent="Y:"+Math.round(scrollY)})</script>',
        );
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    const config = join(dir, 'policy.json');
    await writeFile(
      config,
      JSON.stringify({
        allowedOrigins: [origin],
        allowLoopback: true,
        browserTargets: [{ id: 'tall', label: 'Tall', url: origin + '/', classification: 'PUBLIC' }],
      }),
    );
    const client = new Client(
      { name: 'adl-page-controls', version: '1.0.0' },
      { versionNegotiation: { mode: 'legacy' } },
    );
    const call = async (name: string, args: Record<string, unknown>) =>
      JSON.parse(
        ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content[0]!.text,
      );
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['dist/src/server.js', '--config', config],
          cwd: process.cwd(),
          stderr: 'pipe',
          env: browserRuntimeEnv(),
        }),
      );
      const tools = (await client.listTools()).tools;
      const description = (name: string) => tools.find(t => t.name === name)!.description!;
      assert.match(description('adl_act'), /an optional element_id/);
      assert.match(description('adl_act'), /without element_id it scrolls the whole page/);
      assert.match(description('adl_open'), /http_status/);
      assert.match(description('adl_observe'), /http_status/);

      const target = (await call('adl_targets', {})).targets[0];
      const opened = await call('adl_open', { target_id: target.target_id });
      assert.equal(opened.ok, true, JSON.stringify(opened));
      assert.equal('http_status' in opened, false);
      const seen = await call('adl_observe', { session_id: opened.session_id });
      const scrolled = await call('adl_act', {
        session_id: opened.session_id,
        action: 'scroll',
        direction: 'down',
        expected_revision: seen.revision,
      });
      assert.equal(scrolled.ok, true, JSON.stringify(scrolled));
      let y = 0;
      for (let i = 0; i < 40 && y === 0; i++) {
        const next = await call('adl_observe', { session_id: opened.session_id });
        y = Number(next.elements.find((e: { role: string }) => e.role === 'status').name.split(':')[1]);
        if (!y) await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(y > 100, `page scrolled through MCP (Y:${y})`);
      const bad = await call('adl_act', {
        session_id: opened.session_id,
        action: 'scroll',
        expected_revision: seen.revision,
      });
      assert.equal(bad.error.code, 'E_INVALID_ARGUMENT');
      assert.equal(bad.error.argument, 'direction');

      const missing = await call('adl_open', { url: origin + '/missing' });
      assert.equal(missing.http_status, 404);
      const missingView = await call('adl_observe', { session_id: missing.session_id, format: 'lines' });
      assert.equal(missingView.http_status, 404);
    } finally {
      await client.close();
      await new Promise<void>(resolve => {
        http.closeAllConnections();
        http.close(() => resolve());
      });
      await rm(dir, { recursive: true, force: true });
    }
  },
);
