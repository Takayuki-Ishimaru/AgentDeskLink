import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { Engine } from '../src/core.js';
import { parsePolicy } from '../src/policy.js';
import { AdlError, type Action, type Adapter } from '../src/types.js';

async function fixture(protectedRegion = false, visible = false) {
  const saved = {
    url: process.env.ADL_APPROVAL_URL,
    token: process.env.ADL_APPROVAL_TOKEN,
    epoch: process.env.ADL_APPROVAL_EPOCH,
  };
  const token = randomBytes(32).toString('base64url'),
    epoch = randomUUID();
  type Entry = { request_id: string; binding: string; expires_at: number; status: string; [key: string]: unknown };
  const entries = new Map<string, Entry>();
  const state = {
    posts: 0,
    consumes: 0,
    mutations: [] as Action[],
    allowed: true,
    closed: 0,
    handoffs: 0,
    beforeConsume: async () => {},
  };
  const broker = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      let entry: Entry | undefined;
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Entry;
        state.posts++;
        entry = { ...body, status: 'pending' };
        entries.set(entry.request_id, entry);
      } else entry = entries.get(req.url!.split('/').at(-1)!);
      if (!entry) {
        res.writeHead(404);
        res.end();
        return;
      }
      let consumed = false;
      if (req.method === 'DELETE') {
        await state.beforeConsume();
        if (entry.status === 'approved' && entry.expires_at > Date.now()) {
          entry.status = 'consumed';
          state.consumes++;
          consumed = true;
        } else if (entry.status === 'pending') entry.status = 'invalidated';
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          v: 1,
          request_id: entry.request_id,
          binding: entry.binding,
          expires_at: entry.expires_at,
          status: entry.status,
          ...(req.method === 'DELETE' ? { consumed_now: consumed } : {}),
        }),
      );
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>(resolve => broker.listen(0, '127.0.0.1', resolve));
  process.env.ADL_APPROVAL_URL = `http://127.0.0.1:${(broker.address() as { port: number }).port}`;
  process.env.ADL_APPROVAL_TOKEN = token;
  process.env.ADL_APPROVAL_EPOCH = epoch;
  const adapter: Adapter = {
    open: async () => ({
      tracksDispatch: true,
      handoff: async () => {
        state.handoffs++;
      },
      snapshot: async () => ({
        fingerprint: 'fixed-revision',
        truncated: false,
        elements: [
          {
            id: 'credential',
            role: 'textbox',
            name: 'Password',
            enabled: true,
            sensitive: true,
            ...(protectedRegion ? { protected: true } : {}),
          },
        ],
      }),
      prepareAction: async () => ({
        proof: 'trusted-target-proof',
        risk: 'credential',
        role: 'textbox',
        name: 'Password',
        origin: 'https://example.com',
      }),
      act: async (action, _signal, dispatch) => {
        dispatch?.();
        state.mutations.push({ ...action });
      },
      close: async () => {
        state.closed++;
      },
    }),
    close: async () => {},
  };
  const policy = parsePolicy({
    operationMode: 'ask',
    browserHeadless: !visible,
    allowedOrigins: ['https://example.com'],
    browserTargets: [{ id: 'fixture', label: 'Example', url: 'https://example.com', classification: 'PUBLIC' }],
  });
  const engine = new Engine(policy, { browser: adapter }, process.platform, () => state.allowed);
  const session = await engine.open((await engine.listTargets()).targets[0]!.target_id);
  const action: Action = { action: 'fill', element_id: 'e1', value: 'FIRST_SECRET' };
  const request = async () => {
    await assert.rejects(
      engine.act(session.session_id, action, 1),
      (error: unknown) =>
        error instanceof AdlError && error.code === 'E_APPROVAL_REQUIRED' && typeof error.requestId === 'string',
    );
    return [...entries.values()].at(-1)!;
  };
  return {
    engine,
    session,
    action,
    state,
    entries,
    request,
    close: async () => {
      await engine.shutdown();
      broker.closeAllConnections();
      await new Promise<void>(resolve => broker.close(() => resolve()));
      for (const [key, value] of [
        ['ADL_APPROVAL_URL', saved.url],
        ['ADL_APPROVAL_TOKEN', saved.token],
        ['ADL_APPROVAL_EPOCH', saved.epoch],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

test('denial remains a tombstone and identical retries do not reopen approval', async () => {
  const f = await fixture();
  try {
    const request = await f.request();
    request.status = 'denied';
    for (let i = 0; i < 3; i++) await assert.rejects(f.engine.act(f.session.session_id, f.action, 1));
    assert.equal(f.state.posts, 1);
    assert.equal(f.state.mutations.length, 0);
  } finally {
    await f.close();
  }
});

test('visible manual network handoff cannot be entered without independent local approval', async () => {
  const f = await fixture(false, true);
  try {
    await assert.rejects(
      f.engine.handoff(f.session.session_id, 'pause'),
      (error: unknown) => error instanceof AdlError && error.code === 'E_APPROVAL_REQUIRED' && !!error.requestId,
    );
    assert.equal(f.state.handoffs, 0);
    const request = [...f.entries.values()].at(-1)!;
    assert.equal((request.summary as { action: string }).action, 'handoff');
    request.status = 'approved';
    const result = await f.engine.handoff(f.session.session_id, 'pause');
    assert.equal(result.paused, true);
    assert.equal(f.state.handoffs, 1);
    await assert.rejects(f.engine.act(f.session.session_id, f.action, result.revision), { code: 'E_POLICY_DENIED' });
    await f.engine.handoff(f.session.session_id, 'resume');
    assert.equal(f.state.posts, 1);
    assert.equal(f.state.handoffs, 2);
  } finally {
    await f.close();
  }
});

test('unexpired denials are never evicted to make room for prompt spam', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 128; i++) {
      f.action.value = 'SECRET_' + i;
      const request = await f.request();
      request.status = 'denied';
      await assert.rejects(f.engine.act(f.session.session_id, f.action, 1), { code: 'E_POLICY_DENIED' });
    }
    const posts = f.state.posts;
    f.action.value = 'SECRET_NEW';
    await assert.rejects(f.engine.act(f.session.session_id, f.action, 1), { code: 'E_RESOURCE_LIMIT' });
    f.action.value = 'SECRET_0';
    await assert.rejects(f.engine.act(f.session.session_id, f.action, 1), { code: 'E_POLICY_DENIED' });
    assert.equal(f.state.posts, posts);
  } finally {
    await f.close();
  }
});

test('one approved operation is consumed at most once under concurrent identical retries', async () => {
  const f = await fixture();
  try {
    const request = await f.request();
    request.status = 'approved';
    const results = await Promise.allSettled([
      f.engine.act(f.session.session_id, f.action, 1),
      f.engine.act(f.session.session_id, f.action, 1),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(f.state.consumes, 1);
    assert.equal(f.state.mutations.length, 1);
    assert.equal(f.state.posts, 1);
  } finally {
    await f.close();
  }
});

test('approval cannot be reused for a different input value', async () => {
  const f = await fixture();
  try {
    const request = await f.request();
    request.status = 'approved';
    await assert.rejects(f.engine.act(f.session.session_id, { ...f.action, value: 'SECOND_SECRET' }, 1));
    assert.equal(f.state.mutations.length, 0);
  } finally {
    await f.close();
  }
});

test('the caller cannot mutate an action object while its approval is consumed', async () => {
  const f = await fixture();
  try {
    const request = await f.request();
    request.status = 'approved';
    let reached!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => {
        reached = resolve;
      }),
      gate = new Promise<void>(resolve => {
        release = resolve;
      });
    f.state.beforeConsume = async () => {
      reached();
      await gate;
    };
    const retry = f.engine.act(f.session.session_id, f.action, 1);
    await ready;
    f.action.value = 'MUTATED_AFTER_APPROVAL';
    release();
    await retry;
    assert.equal(f.state.mutations.length, 1);
    assert.equal(f.state.mutations[0]!.value, 'FIRST_SECRET');
  } finally {
    await f.close();
  }
});

test('expiry and revocation between status and consumption cannot dispatch', async () => {
  const f = await fixture();
  try {
    const request = await f.request();
    request.status = 'approved';
    f.state.beforeConsume = async () => {
      f.state.allowed = false;
    };
    await assert.rejects(f.engine.act(f.session.session_id, f.action, 1));
    assert.equal(f.state.mutations.length, 0);
  } finally {
    await f.close();
  }
  const expired = await fixture(),
    clock = Date.now;
  try {
    const request = await expired.request();
    request.status = 'approved';
    Date.now = () => request.expires_at + 1;
    await assert.rejects(expired.engine.act(expired.session.session_id, expired.action, 1));
    assert.equal(expired.state.mutations.length, 0);
  } finally {
    Date.now = clock;
    await expired.close();
  }
});

test('explicitly protected fields never create an approval request', async () => {
  const f = await fixture(true);
  try {
    await assert.rejects(f.engine.act(f.session.session_id, f.action, 1), { code: 'E_PRIVACY_BLOCKED' });
    assert.equal(f.state.posts, 0);
    assert.equal(f.state.mutations.length, 0);
  } finally {
    await f.close();
  }
});
