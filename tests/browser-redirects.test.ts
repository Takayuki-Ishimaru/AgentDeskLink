import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import { AdlError } from '../src/types.js';

// A redirect behaves as in a plain browser whether or not the session runs behind the network route: Set-Cookie on any hop
// reaches the cookie jar with the rules of that hop's URL, and a form POST answered with a redirect lands on its destination.
// standard runs behind the route; routed-all allows every operation behind it; all runs without it.

type Spec = { status?: number; location?: string; cookies?: string[]; html?: string };
type Mode = 'standard' | 'routed-all' | 'all';
type ActResult = { revision: number; ok?: boolean; warnings?: { code: string }[] };

const document = (title: string) =>
  `<!doctype html><title>${title}</title><p>${title}</p>
<form method="post" action="/post-303"><input name="t" aria-label="T" value="x"><button>See other</button></form>
<form method="post" action="/post-302"><input name="t" aria-label="T2" value="x"><button>Found</button></form>
<form method="post" action="/post-301"><input name="t" aria-label="T3" value="x"><button>Moved</button></form>
<form method="post" action="/post-login"><input name="t" aria-label="T4" value="x"><button>Log in</button></form>
<form method="post" action="/post-empty"><input name="t" aria-label="T5" value="x"><button>Empty</button></form>
<form method="post" action="/post-away"><input name="t" aria-label="T6" value="x"><button>Away</button></form>
<form method="post" action="/post-307"><input name="t" aria-label="T7" value="x"><button>Temporary</button></form>
<button onclick="fetch('/api/login').then(r=>r.text()).then(t=>{document.title=t})">Load data</button>
<button onclick="fetch('/api/post',{method:'POST',body:'b=1',headers:{'content-type':'text/plain'}}).then(r=>r.text()).then(t=>{document.title=t})">Fetch post</button>`;

const PAGES: Record<string, Spec> = {
  '/login': { status: 302, location: '/home', cookies: ['sid=1; Path=/', 'scoped=2; Path=/app; HttpOnly'] },
  '/first': { status: 302, location: '/deep/second' },
  '/deep/second': { status: 302, location: '/deep/third', cookies: ['implicit=1'] },
  '/to-self': { status: 302, location: '/to-self', cookies: ['loop=1; Path=/'] },
  '/cookie-then-empty': { status: 302, location: '/empty', cookies: ['seen=1; Path=/'] },
  '/empty': { status: 204 },
  '/post-303': { status: 303, location: '/done' },
  '/post-302': { status: 302, location: '/done' },
  '/post-301': { status: 301, location: '/done' },
  '/post-login': { status: 303, location: '/done', cookies: ['sid=post; Path=/'] },
  '/post-empty': { status: 303, location: '/empty' },
  '/post-away': { status: 303, location: 'http://127.0.0.1:9/elsewhere' },
  '/post-307': { status: 307, location: '/post-target' },
  '/post-target': { html: document('Target') },
  '/api/login': { status: 302, location: '/api/ok', cookies: ['api=1; Path=/'] },
  '/api/ok': { html: 'fetched' },
  '/api/post': { status: 303, location: '/api/ok' },
};

async function fixture(mode: Mode | 'ask', start = '/') {
  const log: { method: string; path: string; cookie?: string; body: string; type?: string; origin?: string }[] = [];
  const app = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on('data', chunk => parts.push(chunk));
    request.on('end', () => {
      const path = (request.url ?? '/').split('?')[0]!;
      log.push({
        method: request.method!,
        path,
        cookie: request.headers.cookie,
        body: Buffer.concat(parts).toString(),
        type: request.headers['content-type'],
        origin: request.headers.origin,
      });
      const spec = PAGES[path] ?? { html: document(path) };
      response.statusCode = spec.status ?? 200;
      if (spec.location) response.setHeader('location', spec.location);
      if (spec.cookies) response.setHeader('set-cookie', spec.cookies);
      if (spec.html !== undefined) response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(spec.html ?? (spec.status ? '' : document(path)));
    });
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const access = {
    standard: { operationMode: 'standard' },
    ask: { operationMode: 'ask' },
    'routed-all': { allowAllOperations: true, restrictTargets: true },
    all: { allowAllOperations: true },
  }[mode];
  const policy = parsePolicy({
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 5000,
    ...access,
    browserTargets: [{ id: 'p', label: 'Fixture', url: origin + start, classification: 'PUBLIC' }],
  });
  const engine = new Engine(policy, {
    browser: new BrowserAdapter(policy, (url, purpose) => assertUrlAllowed(url, policy, undefined, purpose)),
  });
  const close = async () => {
    await engine.shutdown();
    app.closeAllConnections();
    await new Promise<void>(resolve => app.close(() => resolve()));
  };
  let id: string;
  try {
    id = (await engine.open((await engine.listTargets()).targets[0]!.target_id)).session_id;
  } catch (error) {
    await close();
    throw error;
  }
  const observe = () => engine.observe(id, { token_budget: 8000 });
  return {
    engine,
    id,
    origin,
    log,
    observe,
    close,
    hits: (method: string, path: string) => log.filter(r => r.method === method && r.path === path),
    navigate: async (path: string) =>
      (await engine.act(id, { action: 'navigate', url: origin + path }, (await observe()).revision)) as ActResult,
    click: async (name: string) => {
      const state = await observe();
      const element = state.elements!.find(e => e.name === name)!;
      return (await engine.act(id, { action: 'click', element_id: element.id }, state.revision)) as ActResult;
    },
  };
}

const ROUTED = ['routed-all', 'all'] as const;
const noContent = (result: ActResult) =>
  assert.ok(
    result.warnings?.some(w => w.code === 'no_content'),
    'no_content',
  );

for (const mode of ['standard', ...ROUTED] as const) {
  test(`${mode}: Set-Cookie on a redirect reaches the destination and later requests`, { timeout: 60000 }, async () => {
    const f = await fixture(mode);
    try {
      await f.navigate('/login');
      const landed = await f.observe();
      assert.equal(new URL(landed.url!).pathname, '/home');
      assert.equal(landed.title, '/home');
      assert.equal(f.hits('GET', '/login').length, 1, 'the redirect was requested once');
      assert.equal(f.hits('GET', '/home').length, 1, 'the destination was requested once');
      assert.equal(f.hits('GET', '/home')[0]!.cookie, 'sid=1', 'the destination carries the cookie its hop set');
      await f.navigate('/check');
      assert.equal(f.hits('GET', '/check')[0]!.cookie, 'sid=1');
      await f.navigate('/app/page');
      const scoped = f.hits('GET', '/app/page')[0]!.cookie!;
      assert.deepEqual(scoped.split('; ').sort(), ['scoped=2', 'sid=1'], 'every cookie of the hop is stored');
    } finally {
      await f.close();
    }
  });

  test(
    `${mode}: a later hop sets its cookie with the rules of its own URL, each hop requested once`,
    {
      timeout: 60000,
    },
    async () => {
      const f = await fixture(mode);
      try {
        await f.navigate('/first');
        const landed = await f.observe();
        assert.equal(new URL(landed.url!).pathname, '/deep/third');
        assert.deepEqual(
          f.log.filter(r => r.path !== '/').map(r => r.path),
          ['/first', '/deep/second', '/deep/third'],
        );
        assert.equal(f.hits('GET', '/deep/third')[0]!.cookie, 'implicit=1');
        await f.navigate('/shallow');
        assert.equal(f.hits('GET', '/shallow')[0]!.cookie, undefined, 'without Path the cookie is scoped to /deep');
      } finally {
        await f.close();
      }
    },
  );

  test(`${mode}: a target that opens through a redirect keeps its cookie`, { timeout: 60000 }, async () => {
    const f = await fixture(mode, '/login');
    try {
      const opened = await f.observe();
      assert.equal(new URL(opened.url!).pathname, '/home');
      assert.equal(f.hits('GET', '/home')[0]!.cookie, 'sid=1');
    } finally {
      await f.close();
    }
  });

  test(`${mode}: a fetch that is redirected stores the cookie of its hop`, { timeout: 60000 }, async () => {
    const f = await fixture(mode);
    try {
      await f.click('Load data');
      for (let i = 0; i < 50 && (await f.observe()).title !== 'fetched'; i++)
        await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal((await f.observe()).title, 'fetched');
      await f.navigate('/check');
      assert.equal(f.hits('GET', '/check')[0]!.cookie, 'api=1');
    } finally {
      await f.close();
    }
  });

  test(`${mode}: a redirect loop that keeps setting a cookie ends without hanging`, { timeout: 60000 }, async () => {
    const f = await fixture(mode);
    try {
      const started = Date.now();
      await f.navigate('/to-self').catch(() => undefined);
      assert.ok(Date.now() - started < 8000);
      assert.ok(f.hits('GET', '/to-self').length <= 22, 'the loop is bounded');
    } finally {
      await f.close();
    }
  });

  test(`${mode}: a redirect that sets a cookie and ends in 204 says so`, { timeout: 60000 }, async () => {
    const f = await fixture(mode);
    try {
      noContent(await f.navigate('/cookie-then-empty'));
      await f.navigate('/check');
      assert.equal((await f.observe()).title, '/check', 'the session survives');
      assert.equal(f.hits('GET', '/check')[0]!.cookie, 'seen=1');
    } finally {
      await f.close();
    }
  });
}

for (const mode of ROUTED) {
  for (const [name, path] of [
    ['See other', '/post-303'],
    ['Found', '/post-302'],
    ['Moved', '/post-301'],
  ] as const)
    test(
      `${mode}: a form POST answered at ${path} lands on the destination with a GET`,
      { timeout: 60000 },
      async () => {
        const f = await fixture(mode);
        try {
          const done = await f.click(name);
          assert.equal(done.ok ?? true, true);
          const landed = await f.observe();
          assert.equal(new URL(landed.url!).pathname, '/done');
          assert.equal(landed.title, '/done');
          const posts = f.hits('POST', path);
          assert.equal(posts.length, 1, 'the POST was sent once');
          assert.ok(posts[0]!.body.startsWith('t=x'), 'with its body');
          const gets = f.hits('GET', '/done');
          assert.equal(gets.length, 1, 'the destination was requested once');
          assert.equal(gets[0]!.body, '', 'without the body');
          assert.equal(gets[0]!.type, undefined, 'and without the headers that described it');
          assert.equal(gets[0]!.origin, undefined);
          // The session keeps acting on the destination.
          assert.equal((await f.navigate('/next')) !== undefined, true);
          assert.equal((await f.observe()).title, '/next');
        } finally {
          await f.close();
        }
      },
    );

  for (const name of ['See other', 'Log in'])
    test(`${mode}: going back after "${name}" does not send the POST again`, { timeout: 60000 }, async () => {
      const f = await fixture(mode);
      try {
        await f.click(name);
        assert.equal(new URL((await f.observe()).url!).pathname, '/done');
        const posts = f.log.filter(r => r.method === 'POST').length;
        await f.engine.act(f.id, { action: 'back' }, (await f.observe()).revision);
        const back = await f.observe();
        assert.equal(new URL(back.url!).pathname, '/', 'back reaches the page with the form');
        assert.equal(f.log.filter(r => r.method === 'POST').length, posts, 'nothing was sent again');
      } finally {
        await f.close();
      }
    });

  test(`${mode}: a login POST that sets a cookie on its redirect stays logged in`, { timeout: 60000 }, async () => {
    const f = await fixture(mode);
    try {
      await f.click('Log in');
      assert.equal(new URL((await f.observe()).url!).pathname, '/done');
      assert.equal(f.hits('POST', '/post-login').length, 1);
      assert.equal(f.hits('GET', '/done')[0]!.cookie, 'sid=post');
    } finally {
      await f.close();
    }
  });

  test(`${mode}: a form POST redirected to 204 keeps the document`, { timeout: 60000 }, async () => {
    const f = await fixture(mode);
    try {
      noContent(await f.click('Empty'));
      assert.equal(f.hits('POST', '/post-empty').length, 1);
      assert.equal(f.hits('GET', '/empty').length, 1);
      const state = await f.observe();
      assert.equal(new URL(state.url!).pathname, '/');
    } finally {
      await f.close();
    }
  });

  test(`${mode}: 307 repeats the POST and its body at the destination`, { timeout: 60000 }, async () => {
    const f = await fixture(mode);
    try {
      await f.click('Temporary');
      assert.equal(new URL((await f.observe()).url!).pathname, '/post-target');
      const repeated = f.hits('POST', '/post-target');
      assert.equal(repeated.length, 1);
      assert.ok(repeated[0]!.body.startsWith('t=x'));
      assert.equal(repeated[0]!.type, 'application/x-www-form-urlencoded');
    } finally {
      await f.close();
    }
  });

  test(`${mode}: a fetch POST redirected with 303 reads the destination with a GET`, { timeout: 60000 }, async () => {
    const f = await fixture(mode);
    try {
      await f.click('Fetch post');
      for (let i = 0; i < 50 && (await f.observe()).title !== 'fetched'; i++)
        await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal((await f.observe()).title, 'fetched');
      assert.equal(f.hits('POST', '/api/post')[0]!.body, 'b=1');
      assert.equal(f.hits('GET', '/api/ok')[0]!.body, '');
      assert.equal(f.hits('GET', '/api/ok')[0]!.type, undefined);
    } finally {
      await f.close();
    }
  });
}

// A fake VS Code approval broker (see approval-retry.test.ts): a request stays pending until the test approves it.
async function broker() {
  const saved = [process.env.ADL_APPROVAL_URL, process.env.ADL_APPROVAL_TOKEN, process.env.ADL_APPROVAL_EPOCH];
  const requests = new Map<string, { binding: string; expires_at: number }>();
  const approved = new Set<string>();
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
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        v: 1,
        request_id: id,
        binding: request.binding,
        status: req.method === 'DELETE' ? 'consumed' : approved.has(id) ? 'approved' : 'pending',
        expires_at: request.expires_at,
        ...(req.method === 'DELETE' ? { consumed_now: approved.has(id) } : {}),
      }),
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.ADL_APPROVAL_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.ADL_APPROVAL_TOKEN = randomBytes(32).toString('base64url');
  process.env.ADL_APPROVAL_EPOCH = randomUUID();
  return {
    approved,
    close: async () => {
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

type AskFixture = Awaited<ReturnType<typeof fixture>>;
async function approvedClick(f: AskFixture, approved: Set<string>, name: string) {
  const state = await f.observe();
  const element = state.elements!.find(e => e.name === name)!;
  const action = { action: 'click', element_id: element.id } as const;
  try {
    return (await f.engine.act(f.id, action, state.revision)) as ActResult;
  } catch (error) {
    assert.ok(error instanceof AdlError && error.code === 'E_APPROVAL_REQUIRED' && error.requestId, String(error));
    approved.add(error.requestId);
    // A stopped plain submission counts as an action, and its error gives the revision to retry at.
    const revision = (error.detail as { revision?: number }).revision ?? state.revision;
    return (await f.engine.act(f.id, action, revision)) as ActResult;
  }
}

test('ask: an approved POST redirected with 303 lands on the destination', { timeout: 60000 }, async () => {
  const b = await broker();
  const f = await fixture('ask');
  try {
    await approvedClick(f, b.approved, 'See other');
    assert.equal(new URL((await f.observe()).url!).pathname, '/done');
    assert.equal(f.hits('POST', '/post-303').length, 1, 'the approved POST was sent once');
    assert.equal(f.hits('GET', '/done').length, 1);
  } finally {
    await f.close();
    await b.close();
  }
});

test('ask: an approved login POST keeps the cookie of its redirect', { timeout: 60000 }, async () => {
  const b = await broker();
  const f = await fixture('ask');
  try {
    await approvedClick(f, b.approved, 'Log in');
    assert.equal(new URL((await f.observe()).url!).pathname, '/done');
    assert.equal(f.hits('GET', '/done')[0]!.cookie, 'sid=post');
  } finally {
    await f.close();
    await b.close();
  }
});

// The approval covers one request to one URL: a redirect that repeats the write elsewhere is a new write, and an answer that
// leaves the origin is not followed. The approved POST did leave, so both report that it may have executed.
for (const [name, path] of [
  ['Temporary', '/post-307'],
  ['Away', '/post-away'],
] as const)
  test(`ask: ${path} after an approved POST is not followed and may have executed`, { timeout: 60000 }, async () => {
    const b = await broker();
    const f = await fixture('ask');
    try {
      await assert.rejects(approvedClick(f, b.approved, name), (error: unknown) => {
        assert.ok(error instanceof AdlError, String(error));
        assert.equal(error.code, 'E_POLICY_DENIED');
        assert.equal(error.mayHaveExecuted, true);
        return true;
      });
      assert.equal(f.hits('POST', path).length, 1);
      assert.equal(f.hits('POST', '/post-target').length, 0, 'the write was not repeated');
    } finally {
      await f.close();
      await b.close();
    }
  });
