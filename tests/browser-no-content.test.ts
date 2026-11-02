import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import { AdlError } from '../src/types.js';

// A 204/205 response has no document to show: Chromium keeps the current one. Such a navigation is a completed action
// (ok with a no_content warning, session kept, http_status of the page still on screen), not an unknown outcome.
// standard mode runs behind the network route; allowAllOperations without restrictTargets runs without one.

type Page = string | { status: number; html?: string; location?: string; cookie?: string };
type ActResult = { revision: number; http_status?: number; warnings?: { code: string }[] };
type Mode = 'standard' | 'all';

// A search form submits freely in standard mode; the other GET form is a plain submission, held by the submission guard.
const LINKS = `<a href="/nocontent">Empty link</a><a href="/blank">Blank link</a><a href="/next">Next</a>
<a href="/to-empty">Redirect link</a>
<form action="/nocontent" method="get"><input name="q" aria-label="Query" value="hello"><button>Search</button></form>
<form action="/nocontent" method="get"><input name="item" aria-label="Item" value="one"><button>Go</button></form>`;
const PAGES: Record<string, Page> = {
  '/': `<!doctype html><title>Home</title><p>Home page</p>${LINKS}`,
  '/missing': { status: 404, html: `<!doctype html><title>Not found</title><p>Nothing here</p>${LINKS}` },
  '/next': '<!doctype html><title>Next</title><p>Next page</p>',
  '/nocontent': { status: 204 },
  '/blank': { status: 205 },
  '/to-empty': { status: 302, location: '/nocontent' },
  '/via': { status: 302, location: '/to-empty' },
  '/to-next': { status: 302, location: '/next' },
  '/app/login': { status: 200, html: '<!doctype html><title>Login</title>', cookie: 'sid=1; Path=/app' },
  '/to-app': { status: 302, location: '/app/home' },
  '/app/home': '<!doctype html><title>App</title>',
};

async function fixture(options: { mode?: Mode; start?: string } = {}) {
  const requests: string[] = [];
  const cookies = new Map<string, string | undefined>();
  const app = createServer((request, response) => {
    requests.push(request.url ?? '/');
    const path = (request.url ?? '/').split('?')[0]!;
    cookies.set(path, request.headers.cookie);
    const page = PAGES[path] ?? PAGES['/']!;
    const spec = typeof page === 'string' ? { status: 200, html: page } : page;
    response.statusCode = spec.status;
    if (spec.location) response.setHeader('location', spec.location);
    if (spec.cookie) response.setHeader('set-cookie', spec.cookie);
    if (spec.html !== undefined) response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(spec.html ?? '');
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 5000,
    ...(options.mode === 'all' ? { allowAllOperations: true } : { operationMode: 'standard' }),
    browserTargets: [
      { id: 'p', label: 'Fixture', url: origin + (options.start ?? '/'), classification: 'PUBLIC', controls: [] },
    ],
  });
  const engine = new Engine(policy, {
    browser: new BrowserAdapter(policy, (url, purpose) => assertUrlAllowed(url, policy, undefined, purpose)),
  });
  const opened = await engine.open((await engine.listTargets()).targets[0]!.target_id);
  const id = opened.session_id;
  const observe = () => engine.observe(id, { token_budget: 8000 });
  return {
    engine,
    origin,
    requests,
    cookies,
    observe,
    find: async (name: string) => {
      const state = await observe();
      return { state, element: state.elements!.find(e => e.name === name)! };
    },
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

const noContent = (result: ActResult) =>
  assert.ok(
    result.warnings?.some(w => w.code === 'no_content'),
    'no_content',
  );

/** The current document is still the one before the action, and the session still acts on it. */
async function assertDocumentKept(f: Fixture, path: string, title: string, status: number | undefined) {
  const state = await f.observe();
  assert.equal(new URL(state.url!).pathname, path, 'the document was not replaced');
  assert.equal(state.title, title);
  assert.equal(state.http_status, status, 'http_status is the one of the document still on screen');
  const next = state.elements!.find(e => e.name === 'Next')!;
  const done = await f.act({ action: 'click', element_id: next.id }, state.revision);
  assert.ok(!done.warnings?.some(w => w.code === 'no_content'), 'a navigation that commits carries no no_content');
  const after = await f.observe();
  assert.equal(after.title, 'Next', 'the session survives and keeps acting');
  assert.equal(after.http_status, undefined);
}

for (const mode of ['standard', 'all'] as const)
  test(
    `${mode}: clicking a link to a 204 or 205 resource keeps the document and the session`,
    {
      timeout: 60000,
    },
    async () => {
      for (const [name, path] of [
        ['Empty link', '/nocontent'],
        ['Blank link', '/blank'],
      ] as const) {
        const f = await fixture({ mode });
        try {
          const { state, element } = await f.find(name);
          const started = Date.now();
          const done = await f.act({ action: 'click', element_id: element.id }, state.revision);
          assert.ok(Date.now() - started < 2500, `${path}: the click does not wait for a document that never comes`);
          noContent(done);
          assert.ok(f.requests.includes(path), `${path} was requested`);
          await assertDocumentKept(f, '/', 'Home', undefined);
        } finally {
          await f.close();
        }
      }
    },
  );

test('a 204 link on an error page leaves its http_status in place', { timeout: 60000 }, async () => {
  const f = await fixture({ start: '/missing' });
  try {
    const { state, element } = await f.find('Empty link');
    assert.equal(state.http_status, 404);
    noContent(await f.act({ action: 'click', element_id: element.id }, state.revision));
    assert.ok(f.requests.includes('/nocontent'));
    await assertDocumentKept(f, '/missing', 'Not found', 404);
  } finally {
    await f.close();
  }
});

for (const mode of ['standard', 'all'] as const)
  test(
    `${mode}: navigate to a 204 or 205 URL keeps the document, its ids and the session`,
    {
      timeout: 60000,
    },
    async () => {
      const f = await fixture({ mode, start: '/missing' });
      try {
        let state = await f.observe();
        const ids = state.elements!.map(e => e.id);
        const empty = await f.act({ action: 'navigate', url: f.origin + '/nocontent' }, state.revision);
        assert.equal(empty.http_status, 404, 'the 404 document is still on screen');
        noContent(empty);
        assert.ok(f.requests.includes('/nocontent'));
        state = await f.observe();
        assert.equal(new URL(state.url!).pathname, '/missing');
        assert.deepEqual(
          state.elements!.map(e => e.id),
          ids,
          'the document and its element ids are unchanged',
        );
        const blank = await f.act({ action: 'navigate', url: f.origin + '/blank' }, state.revision);
        assert.equal(blank.http_status, 404);
        noContent(blank);
        assert.ok(f.requests.includes('/blank'));
        await assertDocumentKept(f, '/missing', 'Not found', 404);
      } finally {
        await f.close();
      }
    },
  );

// The network route follows a main-frame redirect itself, so a chain that ends in 204/205 must not replace the document first.
for (const mode of ['standard', 'all'] as const)
  test(
    `${mode}: a redirect to a 204 resource, by click and by navigate, keeps the document and the session`,
    {
      timeout: 60000,
    },
    async () => {
      const f = await fixture({ mode });
      const count = (path: string) => f.requests.filter(r => r === path).length;
      try {
        const { state, element } = await f.find('Redirect link');
        const started = Date.now();
        noContent(await f.act({ action: 'click', element_id: element.id }, state.revision));
        assert.ok(Date.now() - started < 2500, 'the click does not wait for a document that never comes');
        assert.deepEqual([count('/to-empty'), count('/nocontent')], [1, 1], 'each hop was requested once');
        let now = await f.observe();
        assert.equal(new URL(now.url!).pathname, '/', 'the document was not replaced');
        assert.equal(now.title, 'Home');
        const ids = now.elements!.map(e => e.id);
        noContent(await f.act({ action: 'navigate', url: f.origin + '/to-empty' }, now.revision));
        noContent(await f.act({ action: 'navigate', url: f.origin + '/via' }, (await f.observe()).revision));
        assert.deepEqual([count('/via'), count('/to-empty'), count('/nocontent')], [1, 3, 3]);
        now = await f.observe();
        assert.deepEqual(
          now.elements!.map(e => e.id),
          ids,
          'the document and its element ids are unchanged',
        );
        await assertDocumentKept(f, '/', 'Home', undefined);
        // A redirect chain that ends in a document still lands on it, and its destination is fetched once.
        const landed = await f.act({ action: 'navigate', url: f.origin + '/to-next' }, (await f.observe()).revision);
        assert.ok(!landed.warnings?.some(w => w.code === 'no_content'));
        now = await f.observe();
        assert.equal(new URL(now.url!).pathname, '/next');
        assert.equal(now.title, 'Next');
        assert.deepEqual(
          [count('/to-next'), count('/next')],
          [1, 2],
          'one request for /next besides the earlier click',
        );
      } finally {
        await f.close();
      }
    },
  );

// Each hop of a followed redirect carries the cookies of its own path, as when the browser requested the hop itself.
for (const mode of ['standard', 'all'] as const)
  test(`${mode}: a redirect hop carries the cookies scoped to its own path`, { timeout: 60000 }, async () => {
    const f = await fixture({ mode });
    try {
      await f.act({ action: 'navigate', url: f.origin + '/app/login' }, (await f.observe()).revision);
      await f.act({ action: 'navigate', url: f.origin + '/to-app' }, (await f.observe()).revision);
      const now = await f.observe();
      assert.equal(new URL(now.url!).pathname, '/app/home');
      assert.equal(now.title, 'App');
      assert.equal(f.cookies.get('/to-app'), undefined, 'the cookie is scoped to /app');
      assert.equal(f.cookies.get('/app/home'), 'sid=1', 'the hop under /app carries it');
    } finally {
      await f.close();
    }
  });

for (const mode of ['standard', 'all'] as const)
  test(
    `${mode}: a form GET to a 204 endpoint, by click and by Enter, keeps the document and the session`,
    {
      timeout: 60000,
    },
    async () => {
      const f = await fixture({ mode });
      try {
        const { state, element } = await f.find('Search');
        noContent(await f.act({ action: 'click', element_id: element.id }, state.revision));
        assert.ok(f.requests.includes('/nocontent?q=hello'), 'the form was submitted by the click');
        const query = await f.find('Query');
        const started = Date.now();
        noContent(await f.act({ action: 'press', element_id: query.element.id, value: 'Enter' }, query.state.revision));
        assert.ok(Date.now() - started < 2500, 'Enter does not wait for a document that never comes');
        assert.equal(f.requests.filter(r => r === '/nocontent?q=hello').length, 2, 'and by Enter');
        await assertDocumentKept(f, '/', 'Home', undefined);
      } finally {
        await f.close();
      }
    },
  );

test(
  'standard: the submission guard still holds a plain GET form to a 204 endpoint before it is sent',
  {
    timeout: 60000,
  },
  async () => {
    const f = await fixture();
    try {
      const { state, element } = await f.find('Go');
      await assert.rejects(
        f.act({ action: 'click', element_id: element.id }, state.revision),
        (error: unknown) =>
          error instanceof AdlError &&
          error.code === 'E_APPROVAL_REQUIRED' &&
          error.reason === 'form_submission_requires_approval' &&
          !error.mayHaveExecuted,
      );
      assert.ok(!f.requests.some(r => r.startsWith('/nocontent')), 'the guarded submission never left');
      await assertDocumentKept(f, '/', 'Home', undefined);
    } finally {
      await f.close();
    }
  },
);
