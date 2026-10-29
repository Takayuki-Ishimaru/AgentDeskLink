import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { Engine } from '../src/core.js';
import { BrowserAdapter } from '../src/browser.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import { AdlError } from '../src/types.js';

// A fake VS Code approval broker: requests stay pending until `decide` is set.
async function fixture() {
  const saved = [process.env.ADL_APPROVAL_URL, process.env.ADL_APPROVAL_TOKEN, process.env.ADL_APPROVAL_EPOCH];
  const token = randomBytes(32).toString('base64url');
  const requests = new Map<string, { request_id: string; binding: string; expires_at: number }>();
  const state = { approved: new Set<string>(), deleted: [] as string[], submissions: 0 };
  const broker = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
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
    if (req.method === 'DELETE') state.deleted.push(id);
    const status = req.method === 'DELETE' ? 'consumed' : state.approved.has(id) ? 'approved' : 'pending';
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        v: 1,
        request_id: id,
        binding: request.binding,
        status,
        expires_at: request.expires_at,
        ...(req.method === 'DELETE' ? { consumed_now: state.approved.has(id) } : {}),
      }),
    );
  });
  await new Promise<void>(resolve => broker.listen(0, '127.0.0.1', resolve));
  process.env.ADL_APPROVAL_URL = `http://127.0.0.1:${(broker.address() as { port: number }).port}`;
  process.env.ADL_APPROVAL_TOKEN = token;
  process.env.ADL_APPROVAL_EPOCH = randomUUID();
  const app = createServer(async (req, res) => {
    if (req.method === 'POST') {
      state.submissions++;
      for await (const _ of req) {
        /* drain */
      }
      res.end('<!doctype html><p>Thanks</p>');
      return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      '<!doctype html><form method="post" action="/send"><input name="name" aria-label="Name" value="Taro"><button>Send</button></form><form method="post" action="/other"><button>Other</button></form>',
    );
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    operationMode: 'ask',
    allowedOrigins: [origin],
    allowLoopback: true,
    browserTargets: [{ id: 'a', label: 'Fixture', url: origin, classification: 'PUBLIC' }],
  });
  const engine = new Engine(policy, { browser: new BrowserAdapter(policy, url => assertUrlAllowed(url, policy)) });
  const session = await engine.open((await engine.listTargets()).targets[0]!.target_id);
  return {
    engine,
    session,
    state,
    close: async () => {
      await engine.shutdown();
      app.closeAllConnections();
      broker.closeAllConnections();
      await Promise.all([
        new Promise<void>(r => app.close(() => r())),
        new Promise<void>(r => broker.close(() => r())),
      ]);
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

const pendingId = (error: unknown) =>
  error instanceof AdlError && error.code === 'E_APPROVAL_REQUIRED' && typeof error.requestId === 'string'
    ? error.requestId
    : undefined;

test(
  'an approved action may be retried with include_diff without losing the approval',
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      const view = await f.engine.observe(f.session.session_id, { token_budget: 8000 });
      const send = view.elements!.find(e => e.name === 'Send')!;
      let requestId: string | undefined;
      await assert.rejects(
        f.engine.act(f.session.session_id, { action: 'click', element_id: send.id }, view.revision),
        error => !!(requestId = pendingId(error)),
      );
      f.state.approved.add(requestId!);
      const result = await f.engine.act(
        f.session.session_id,
        { action: 'click', element_id: send.id, include_diff: true, timeout_ms: 8000 },
        view.revision,
      );
      assert.equal(result.ok, true);
      assert.ok('observation' in result && result.observation, 'the diff requested on retry is returned');
      assert.equal(f.state.submissions, 1);
    } finally {
      await f.close();
    }
  },
);

test('a different action does not withdraw a pending approval', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const view = await f.engine.observe(f.session.session_id, { token_budget: 8000 });
    const send = view.elements!.find(e => e.name === 'Send')!,
      other = view.elements!.find(e => e.name === 'Other')!;
    let requestId: string | undefined;
    await assert.rejects(
      f.engine.act(f.session.session_id, { action: 'click', element_id: send.id }, view.revision),
      error => !!(requestId = pendingId(error)),
    );
    await assert.rejects(
      f.engine.act(f.session.session_id, { action: 'click', element_id: other.id }, view.revision),
      (error: unknown) =>
        error instanceof AdlError &&
        error.code === 'E_APPROVAL_REQUIRED' &&
        error.reason === 'approval_pending_other_action' &&
        error.requestId === undefined,
    );
    assert.deepEqual(f.state.deleted, [], 'the pending request was not withdrawn');
    assert.equal((await f.engine.approvals()).requests.length, 1);
    f.state.approved.add(requestId!);
    assert.equal(
      (await f.engine.act(f.session.session_id, { action: 'click', element_id: send.id }, view.revision)).ok,
      true,
    );
    assert.equal(f.state.submissions, 1);
  } finally {
    await f.close();
  }
});
