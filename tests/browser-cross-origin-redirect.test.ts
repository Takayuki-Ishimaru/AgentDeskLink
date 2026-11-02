import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import { AdlError } from '../src/types.js';

// A sign-in that passes through an identity provider: the site redirects to it and it redirects back. A server redirect may take
// the session to an origin the workspace granted, never to another; a link or navigate still cannot open a new origin by itself.

type Mode = 'standard' | 'routed-all' | 'all' | 'controls';
type Log = { server: string; method: string; path: string; cookie?: string };

// Cookies ignore the port, so the provider gets a host name of its own.
type Internals = {
  manualNetworkExpires: number;
  manualNetworkOrigin?: string;
  pageValue: { evaluate(fn: () => Promise<unknown>): Promise<unknown> };
};
function listen(app: Server, host: string) {
  return new Promise<string>(resolve =>
    app.listen(0, () => resolve(`http://${host}:${(app.address() as { port: number }).port}`)),
  );
}

async function fixture(
  mode: Mode,
  options: {
    start?: string;
    grant?: 'idp' | 'hidden' | 'hidden-site' | 'none';
    controls?: { selector: string; actions: string[] }[];
  } = {},
) {
  const log: Log[] = [];
  const urls = { site: '', idp: '', other: '' };
  const server = (name: 'site' | 'idp' | 'other') =>
    createServer((request, response) => {
      const parts: Buffer[] = [];
      request.on('data', chunk => parts.push(chunk));
      request.on('end', () => {
        const path = (request.url ?? '/').split('?')[0]!;
        log.push({ server: name, method: request.method!, path, cookie: request.headers.cookie });
        const redirect = (status: number, location: string, cookie?: string) => {
          response.statusCode = status;
          response.setHeader('location', location);
          if (cookie) response.setHeader('set-cookie', cookie);
          response.end();
        };
        if (name === 'site' && path === '/protected')
          return redirect(302, urls.idp + '/authorize', 'state=abc; Path=/');
        if (name === 'site' && path === '/post-away') return redirect(303, urls.idp + '/authorize');
        if (name === 'site' && path === '/post-307') return redirect(307, urls.idp + '/authorize');
        if (name === 'site' && path === '/to-other') return redirect(302, urls.other + '/page');
        if (name === 'site' && path === '/callback') return redirect(302, '/home', 'sid=1; Path=/');
        if (name === 'idp' && path === '/authorize') {
          response.setHeader('set-cookie', 'idp=1; Path=/');
          response.setHeader('content-type', 'text/html; charset=utf-8');
          return response.end(
            `<!doctype html><title>Provider</title><p>Provider</p><a href="/continue">Continue</a><button id="only" onclick="window.fired=1">Protected</button>`,
          );
        }
        if (name === 'idp' && path === '/continue') return redirect(302, urls.site + '/callback');
        response.setHeader('content-type', 'text/html; charset=utf-8');
        response.end(
          `<!doctype html><title>${name} ${path}</title><p>${path}</p><a href="${urls.other}/page">Other link</a><a href="${urls.idp}/page">Provider link</a><a href="/to-other">To other</a>
<form method="post" action="/post-away"><input name="t" aria-label="T" value="x"><button>Sign in elsewhere</button></form>
<form method="post" action="/post-307"><input name="t" aria-label="T2" value="x"><button>Repeat elsewhere</button></form>
<button id="only" type="button">Local</button>`,
        );
      });
    });
  const apps = { site: server('site'), idp: server('idp'), other: server('other') };
  urls.site = await listen(apps.site, '127.0.0.1');
  urls.idp = await listen(apps.idp, 'localhost');
  urls.other = await listen(apps.other, '127.0.0.1');
  const grant = options.grant ?? 'idp';
  const access = {
    standard: { operationMode: 'standard' },
    'routed-all': { allowAllOperations: true, restrictTargets: true },
    all: { allowAllOperations: true },
    controls: {},
  }[mode];
  const policy = parsePolicy({
    allowedOrigins: grant === 'none' ? [urls.site] : [urls.site, urls.idp],
    allowLoopback: true,
    actionTimeoutMs: 5000,
    ...access,
    browserTargets: [
      {
        id: 'p',
        label: 'Site',
        url: urls.site + (options.start ?? '/'),
        classification: 'PUBLIC',
        visual: { enabled: true },
        ...(options.controls ? { controls: options.controls } : {}),
      },
      ...(grant === 'hidden' ? [{ id: 'h', label: 'Hidden', url: urls.idp, classification: 'SECRET' as const }] : []),
      ...(grant === 'hidden-site'
        ? [{ id: 'h', label: 'Hidden', url: urls.site + '/secret', classification: 'SECRET' as const }]
        : []),
    ],
  });
  const adapter = new BrowserAdapter(policy, (url, purpose) => assertUrlAllowed(url, policy, undefined, purpose));
  const open = adapter.open.bind(adapter);
  let instance: unknown;
  adapter.open = async (...args) => (instance = await open(...args)) as Awaited<ReturnType<typeof open>>;
  const engine = new Engine(policy, { browser: adapter });
  const close = async () => {
    await engine.shutdown();
    for (const app of Object.values(apps)) {
      app.closeAllConnections();
      await new Promise<void>(resolve => app.close(() => resolve()));
    }
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
    session: () => instance as Internals,
    urls,
    log,
    observe,
    close,
    hits: (name: string, path: string) => log.filter(r => r.server === name && r.path === path),
    navigate: async (url: string) => engine.act(id, { action: 'navigate', url }, (await observe()).revision),
    click: async (name: string) => {
      const state = await observe();
      const element = state.elements!.find(e => e.name === name);
      assert.ok(element, name);
      return engine.act(id, { action: 'click', element_id: element.id }, state.revision);
    },
  };
}

for (const mode of ['standard', 'routed-all', 'all'] as const) {
  test(
    `${mode}: a sign-in through a granted provider goes there and back with its cookies`,
    { timeout: 60000 },
    async () => {
      const f = await fixture(mode, { start: '/protected' });
      try {
        let state = await f.observe();
        assert.equal(new URL(state.url!).origin, f.urls.idp, 'the session works on the provider');
        assert.equal(state.title, 'Provider');
        assert.equal(f.hits('idp', '/authorize').length, 1);
        assert.equal(f.hits('idp', '/authorize')[0]!.cookie, undefined, 'the site cookie stays on the site');
        await f.click('Continue');
        state = await f.observe();
        assert.equal(new URL(state.url!).href, f.urls.site + '/home', 'and it returns');
        assert.equal(f.hits('idp', '/continue')[0]!.cookie, 'idp=1');
        assert.equal(
          f.hits('site', '/callback')[0]!.cookie,
          'state=abc',
          'the callback carries the state of the start',
        );
        assert.deepEqual(f.hits('site', '/home')[0]!.cookie?.split('; ').sort(), ['sid=1', 'state=abc']);
      } finally {
        await f.close();
      }
    },
  );
}

test('standard: a redirect to an origin nobody granted stops at the boundary', { timeout: 60000 }, async () => {
  const f = await fixture('standard');
  try {
    await assert.rejects(f.click('To other'), AdlError);
    assert.equal(f.hits('other', '/page').length, 0, 'nothing reached it');
  } finally {
    await f.close();
  }
});

test(
  'standard: an ungranted provider at the start of a session stops at the boundary',
  { timeout: 60000 },
  async () => {
    await assert.rejects(fixture('standard', { start: '/protected', grant: 'none' }), AdlError);
  },
);

test('standard: a granted origin whose target is hidden is not reached', { timeout: 60000 }, async () => {
  await assert.rejects(fixture('standard', { start: '/protected', grant: 'hidden' }), AdlError);
});

test('standard: links and navigate still cannot open a granted origin by themselves', { timeout: 60000 }, async () => {
  const f = await fixture('standard');
  try {
    await assert.rejects(
      f.navigate(f.urls.idp + '/page'),
      (error: unknown) => error instanceof AdlError && error.reason === 'origin_not_allowed',
    );
    assert.equal(f.hits('idp', '/page').length, 0);
    await f.click('Provider link').catch(() => undefined);
    assert.equal(f.hits('idp', '/page').length, 0, 'the link did not leave');
  } finally {
    await f.close();
  }
});

test('standard: from the provider the session may return, and nowhere new', { timeout: 60000 }, async () => {
  const f = await fixture('standard', { start: '/protected' });
  try {
    await assert.rejects(
      f.navigate(f.urls.other + '/page'),
      (error: unknown) => error instanceof AdlError && error.reason === 'origin_not_allowed',
    );
    assert.equal(f.hits('other', '/page').length, 0);
    await f.navigate(f.urls.site + '/again');
    const state = await f.observe();
    assert.equal(new URL(state.url!).href, f.urls.site + '/again');
  } finally {
    await f.close();
  }
});

test(
  'standard: a site that shares its origin with a hidden target can still be returned to',
  { timeout: 60000 },
  async () => {
    const f = await fixture('standard', { start: '/protected', grant: 'hidden-site' });
    try {
      assert.equal(new URL((await f.observe()).url!).origin, f.urls.idp);
      await f.click('Continue');
      assert.equal(new URL((await f.observe()).url!).href, f.urls.site + '/home');
    } finally {
      await f.close();
    }
  },
);

// The human approves temporary network access for one origin; the real handoff needs a headed browser, so the grant is set directly.
test('standard: a manual network grant does not follow a redirect to another origin', { timeout: 60000 }, async () => {
  const f = await fixture('standard');
  try {
    const session = f.session();
    session.manualNetworkExpires = Date.now() + 60000;
    session.manualNetworkOrigin = f.urls.site;
    const write = () =>
      session.pageValue.evaluate(() => fetch('/write', { method: 'POST', body: 'x' }).catch(() => undefined));
    await write();
    assert.equal(f.hits('site', '/write').length, 1, 'the granted origin may write');
    await f.navigate(f.urls.site + '/protected');
    assert.equal(new URL((await f.observe()).url!).origin, f.urls.idp);
    await write();
    assert.equal(f.hits('idp', '/write').length, 0, 'the provider was not part of the grant');
  } finally {
    await f.close();
  }
});

test('the grants of a target do not follow the session to the provider', { timeout: 60000 }, async () => {
  const controls = [{ selector: '#only', actions: ['click'] }];
  const home = await fixture('controls', { controls });
  try {
    await home.click('Local');
    await home.engine.capture(home.id);
  } finally {
    await home.close();
  }
  const f = await fixture('controls', { start: '/protected', controls });
  try {
    assert.equal((await f.observe()).title, 'Provider');
    await assert.rejects(f.click('Protected'), AdlError, 'the control of the site does not apply here');
    await assert.rejects(f.engine.capture(f.id), (error: unknown) => {
      assert.ok(error instanceof AdlError, String(error));
      assert.equal(error.code, 'E_PRIVACY_BLOCKED');
      return true;
    });
  } finally {
    await f.close();
  }
});

for (const mode of ['routed-all', 'all'] as const)
  test(
    `${mode}: a form POST answered with 303 lands on the granted origin with a GET`,
    { timeout: 60000 },
    async () => {
      const f = await fixture(mode);
      try {
        await f.click('Sign in elsewhere');
        assert.equal(new URL((await f.observe()).url!).origin, f.urls.idp);
        assert.equal(f.hits('idp', '/authorize')[0]!.method, 'GET');
      } finally {
        await f.close();
      }
    },
  );

test('routed-all: 307 does not repeat a POST on another origin', { timeout: 60000 }, async () => {
  const f = await fixture('routed-all');
  try {
    await assert.rejects(f.click('Repeat elsewhere'), (error: unknown) => {
      assert.ok(error instanceof AdlError, String(error));
      assert.equal(error.mayHaveExecuted, true);
      return true;
    });
    assert.equal(f.hits('idp', '/authorize').length, 0);
  } finally {
    await f.close();
  }
});
