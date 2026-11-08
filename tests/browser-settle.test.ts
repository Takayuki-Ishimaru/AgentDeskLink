import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BrowserAdapter, CONTAINMENT_REPORT_MS, SETTLE_MAX_MS, SETTLE_QUIET_MS } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import {
  HeldWritesError,
  type Action,
  type AdapterActResult,
  type AdapterSession,
  type NetworkWarning,
  type Target,
} from '../src/types.js';

// After an input action the browser adapter waits for the page's reaction before the caller reads it: no attributable request in
// flight and a quiet document, at most SETTLE_MAX_MS after the dispatch. Navigation is not settled. Timing is measured at the
// adapter (from the dispatch to the end of act), so the engine's own work does not count.

type Timing = { dispatchedAt: number; endedAt: number; ms: number; outcome?: AdapterActResult | void };
const STATUS = `<p id="s" role="status">idle</p>`;

async function fixture(
  html: string,
  options: { mode?: 'standard' | 'ask'; allowAll?: boolean; slowMs?: number; start?: string } = {},
) {
  const hits: string[] = [];
  const answered: string[] = [];
  const app = createServer(async (req, res) => {
    const url = req.url ?? '/';
    if (url === '/' || url.startsWith('/page')) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(url === '/' ? html : `<!doctype html><title>Slow</title><script>fetch('/slow-long')</script><p>page</p>`);
      return;
    }
    for await (const _ of req) void _;
    hits.push(`${req.method} ${url}`);
    const delay = url === '/slow-long' ? 1500 : url.startsWith('/slow') ? (options.slowMs ?? 150) : 0;
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
      answered.push(url);
    }, delay);
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    ...(options.allowAll ? { allowAllOperations: true } : { operationMode: options.mode ?? 'standard' }),
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 5000,
    browserTargets: [{ id: 'p', label: 'Fixture', url: origin + (options.start ?? '/'), classification: 'PUBLIC' }],
  });
  const adapter = new BrowserAdapter(policy, (url, purpose) => assertUrlAllowed(url, policy, undefined, purpose));
  const open = adapter.open.bind(adapter);
  let timing: Timing | undefined;
  let session: AdapterSession | undefined;
  adapter.open = async (...args) => {
    const opened = await open(...args);
    session = opened;
    const act = opened.act.bind(opened);
    opened.act = async (action: Action, signal: AbortSignal, onDispatch, authorization) => {
      const record: Timing = { dispatchedAt: 0, endedAt: 0, ms: 0 };
      timing = record;
      try {
        const outcome = await act(
          action,
          signal,
          () => {
            onDispatch?.();
            record.dispatchedAt = Date.now();
          },
          authorization,
        );
        record.outcome = outcome;
        return outcome;
      } finally {
        record.endedAt = Date.now();
        record.ms = record.dispatchedAt ? record.endedAt - record.dispatchedAt : 0;
      }
    };
    return opened;
  };
  const engine = new Engine(policy, { browser: adapter });
  const id = (await engine.open((await engine.listTargets()).targets[0]!.target_id)).session_id;
  const observe = () => engine.observe(id, { token_budget: 8000 });
  const act = async (name: string, action: Partial<Action> = {}) => {
    const state = await observe();
    const element = state.elements!.find(e => e.name === name);
    assert.ok(element, name);
    const result = (await engine.act(
      id,
      { action: 'click', element_id: element.id, ...action } as Action,
      state.revision,
    )) as Record<string, unknown> & { observation?: unknown };
    return { result, timing: timing! };
  };
  return {
    engine,
    id,
    origin,
    hits,
    answered,
    observe,
    act,
    session: () => session!,
    timing: () => timing!,
    close: async () => {
      await engine.shutdown();
      app.closeAllConnections();
      await new Promise<void>(resolve => app.close(() => resolve()));
    },
  };
}

const blocksOf = (outcome: AdapterActResult | void): NetworkWarning[] => (outcome ? (outcome.blocks ?? []) : []);

test('a rejected write: the status the page renders after it is in the diff', { timeout: 60000 }, async () => {
  const f = await fixture(
    `<!doctype html>${STATUS}<button onclick="fetch('/api',{method:'POST',body:'x'}).then(()=>{s.textContent='saved'},()=>new Promise(r=>setTimeout(r,40)).then(()=>{s.textContent='could not save'}))">Save</button><script>const s=document.getElementById('s')</script>`,
  );
  try {
    const { result, timing } = await f.act('Save', { include_diff: true });
    assert.ok(
      JSON.stringify(result.observation).includes('could not save'),
      `the diff shows the page's reaction: ${JSON.stringify(result.observation)}`,
    );
    assert.ok(
      blocksOf(timing.outcome).some(
        w => w.code === 'method_requires_approval' && w.method === 'POST' && w.resource_type === 'fetch',
      ),
      JSON.stringify(blocksOf(timing.outcome)),
    );
    assert.deepEqual(f.hits, []);
  } finally {
    await f.close();
  }
});

test('allowAllOperations: the answer to a slow request is in the diff', { timeout: 60000 }, async () => {
  const f = await fixture(
    `<!doctype html>${STATUS}<button onclick="s.textContent='saving';fetch('/slow-save',{method:'POST',body:'x'}).then(()=>{s.textContent='saved'},()=>{s.textContent='failed'})">Save</button><script>const s=document.getElementById('s')</script>`,
    { allowAll: true, slowMs: 150 },
  );
  try {
    const { result, timing } = await f.act('Save', { include_diff: true });
    assert.ok(JSON.stringify(result.observation).includes('saved'), JSON.stringify(result.observation));
    assert.ok(!JSON.stringify(result.observation).includes('saving'), 'the final state, not the intermediate one');
    assert.ok(timing.ms >= 150 - 20, `waited for the answer (${timing.ms} ms)`);
    // The adapter's wall time also includes the final document/freshness verification after
    // the bounded settle loop. Do not mistake a scheduler delay there for an unbounded wait.
    assert.ok(timing.ms < SETTLE_MAX_MS + 100, `bounded settle plus final verification (${timing.ms} ms)`);
  } finally {
    await f.close();
  }
});

test(
  'a page that mutates all the time is cut off at SETTLE_MAX_MS after the dispatch',
  { timeout: 60000 },
  async () => {
    const f = await fixture(
      `<!doctype html><p id="tick">0</p><button id="go">Go</button>
      <script>
        const tick = document.getElementById('tick');
        document.getElementById('go').onclick = () => {
          // Keep producing mutations past the assertion's upper bound. Posted tasks yield to
          // the browser's other work without relying on its background timer frequency.
          const end = performance.now() + ${3 * SETTLE_MAX_MS};
          const channel = new MessageChannel();
          let count = 0;
          const mutate = () => {
            if (performance.now() >= end) {
              channel.port1.close();
              channel.port2.close();
              return;
            }
            tick.textContent = String(++count);
            channel.port2.postMessage(null);
          };
          channel.port1.onmessage = mutate;
          mutate();
        };
      </script>`,
    );
    try {
      const { timing } = await f.act('Go');
      assert.ok(timing.ms >= SETTLE_MAX_MS - 20, `waited for quiet until the cap (${timing.ms} ms)`);
      assert.ok(timing.ms < SETTLE_MAX_MS + 400, `and not longer (${timing.ms} ms)`);
    } finally {
      await f.close();
    }
  },
);

test('what the page was already polling does not delay the settle', { timeout: 60000 }, async () => {
  const f = await fixture(
    `<!doctype html>${STATUS}<button onclick="window.clicked=true">Go</button><script>setInterval(()=>fetch('/poll?t='+Date.now()),50)</script>`,
  );
  try {
    for (let i = 0; i < 40 && f.hits.filter(h => h.startsWith('GET /poll')).length < 3; i++)
      await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(f.hits.filter(h => h.startsWith('GET /poll')).length >= 3, 'the page polls');
    const { timing } = await f.act('Go');
    assert.ok(timing.ms < SETTLE_MAX_MS - 40, `the poll is background traffic (${timing.ms} ms)`);
  } finally {
    await f.close();
  }
});

test('a quiet page: fill returns quickly and its diff shows the value', { timeout: 60000 }, async () => {
  const f = await fixture(`<!doctype html><label>Name <input id="n" type="text"></label>`);
  try {
    const { result, timing } = await f.act('Name', { action: 'fill', value: 'Ada', include_diff: true });
    assert.ok(timing.ms < SETTLE_MAX_MS - 40, `${timing.ms} ms`);
    assert.ok(JSON.stringify(result.observation).includes('Ada'), JSON.stringify(result.observation));
  } finally {
    await f.close();
  }
});

test(
  'a contained Delete takes CONTAINMENT_REPORT_MS in total, not the settle and the wait',
  { timeout: 60000 },
  async () => {
    const f = await fixture(
      `<!doctype html><ul><li id="milk">Buy milk <button onclick="document.getElementById('milk').remove()">Delete Buy milk</button></li></ul>`,
    );
    try {
      const { result, timing } = await f.act('Delete Buy milk');
      assert.ok(
        (result.warnings as { code: string }[] | undefined)?.some(w => w.code === 'contained_action'),
        JSON.stringify(result),
      );
      assert.ok(timing.ms >= CONTAINMENT_REPORT_MS - 20, `${timing.ms} ms`);
      assert.ok(timing.ms < CONTAINMENT_REPORT_MS + 400, `${timing.ms} ms`);
    } finally {
      await f.close();
    }
  },
);

test('navigation is not settled: it returns before the new page finishes fetching', { timeout: 60000 }, async () => {
  const f = await fixture(`<!doctype html><title>Home</title><p>home</p>`);
  try {
    const result = await f.engine.act(
      f.id,
      { action: 'navigate', url: `${f.origin}/page` },
      (await f.observe()).revision,
    );
    assert.equal((result as { ok: boolean }).ok, true);
    assert.deepEqual(f.answered, [], 'the page script is still waiting for its fetch');
  } finally {
    await f.close();
  }
});

test('the constants are the documented ones', () => {
  assert.equal(SETTLE_QUIET_MS, 60);
  assert.equal(SETTLE_MAX_MS, 400);
  assert.equal(CONTAINMENT_REPORT_MS, 500);
});

test('ask: a held write keeps the action open until SETTLE_MAX_MS, then reports it', { timeout: 60000 }, async () => {
  const requests: string[] = [];
  const app = createServer(async (req, res) => {
    for await (const _ of req) void _;
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        `<!doctype html><button onclick="fetch('/api',{method:'POST',body:'x'}).catch(()=>{})">Save</button><button onclick="window.quiet=1">Quiet</button>`,
      );
      return;
    }
    requests.push(`${req.method} ${req.url}`);
    res.end('{}');
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    operationMode: 'ask',
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 5000,
    browserTargets: [{ id: 'p', label: 'Fixture', url: origin, classification: 'PUBLIC' }],
  });
  const adapter = new BrowserAdapter(policy, (url, purpose) => assertUrlAllowed(url, policy, undefined, purpose));
  const target: Target = {
    target_id: 't',
    application_id: 'p',
    label: 'Fixture',
    surface: 'browser',
    policy_class: 'PUBLIC',
    capabilities: [],
  };
  const session = await adapter.open(target, 'strict_isolated', new AbortController().signal);
  session.setWriteHolding!(true);
  try {
    const click = async (name: string) => {
      const signal = new AbortController().signal;
      const element = (await session.snapshot()).elements.find(e => e.name === name)!;
      const action: Action = { action: 'click', element_id: element.id };
      const prepared = await session.prepareAction!(action, signal);
      let dispatchedAt = 0;
      const outcome = await session
        .act(
          action,
          signal,
          () => {
            dispatchedAt = Date.now();
          },
          { normalOperations: true, approvalProof: prepared.proof, approved: false, holdWrites: true },
        )
        .then(
          value => ({ value }),
          (error: unknown) => ({ error }),
        );
      return { outcome, ms: Date.now() - dispatchedAt };
    };
    const { outcome, ms } = await click('Save');
    assert.ok('error' in outcome && outcome.error instanceof HeldWritesError, JSON.stringify(outcome));
    assert.ok(ms >= SETTLE_MAX_MS - 20, `a request in flight keeps the window open (${ms} ms)`);
    assert.ok(ms < SETTLE_MAX_MS + 600, `${ms} ms`);
    await session.abortHeldWrites!((outcome.error as HeldWritesError).hold.id, 'denied');
    const quiet = await click('Quiet');
    assert.ok('value' in quiet.outcome, JSON.stringify(quiet.outcome));
    assert.ok(quiet.ms < SETTLE_MAX_MS - 40, `an action without requests does not wait (${quiet.ms} ms)`);
    assert.deepEqual(requests, []);
  } finally {
    await adapter.close();
    app.closeAllConnections();
    await new Promise<void>(resolve => app.close(() => resolve()));
  }
});
