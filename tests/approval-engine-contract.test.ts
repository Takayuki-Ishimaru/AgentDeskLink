import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/core.js';
import { parsePolicy } from '../src/policy.js';
import {
  AdlError,
  HeldWritesError,
  safeError,
  type Action,
  type ActionAuthorization,
  type Adapter,
  type HeldWrite,
} from '../src/types.js';
import { stubBroker } from './approval-broker-stub.js';

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
    gets: 0,
    consumes: 0,
    fingerprint: 'fixed-revision',
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
      if (req.method === 'GET') state.gets++;
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
        fingerprint: state.fingerprint,
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
    for (let i = 0; i < 3; i++)
      await assert.rejects(f.engine.act(f.session.session_id, f.action, 1), (error: unknown) => {
        assert.ok(error instanceof AdlError);
        assert.equal(error.code, 'E_POLICY_DENIED');
        assert.equal(error.reason, 'approval_denied');
        assert.equal(safeError(error).retryable, false);
        return true;
      });
    assert.equal(f.state.posts, 1);
    assert.equal(f.state.mutations.length, 0);
  } finally {
    await f.close();
  }
});

// What the broker says about a request decides the refusal the caller sees; every non-pending outcome is final for that exact action.
for (const [status, code, reason] of [
  ['expired', 'E_STALE_STATE', 'approval_expired'],
  ['invalidated', 'E_POLICY_DENIED', 'approval_invalidated'],
  ['consumed', 'E_POLICY_DENIED', 'approval_invalidated'],
] as const)
  test(`a request the broker reports as ${status} is refused with ${reason} and never dispatched`, async () => {
    const f = await fixture();
    try {
      const request = await f.request();
      request.status = status;
      for (let i = 0; i < 3; i++)
        await assert.rejects(f.engine.act(f.session.session_id, f.action, 1), (error: unknown) => {
          assert.ok(error instanceof AdlError);
          assert.equal(error.code, code);
          assert.equal(error.reason, reason);
          return true;
        });
      assert.equal(f.state.posts, 1);
      assert.equal(f.state.mutations.length, 0);
    } finally {
      await f.close();
    }
  });

test('operations stopped between approval and consumption refuse with approval_invalidated, not as a denial by a human', async () => {
  const f = await fixture();
  try {
    const request = await f.request();
    request.status = 'approved';
    f.state.beforeConsume = async () => {
      f.state.allowed = false;
    };
    for (let i = 0; i < 2; i++) {
      await assert.rejects(f.engine.act(f.session.session_id, f.action, 1), (error: unknown) => {
        assert.ok(error instanceof AdlError);
        assert.equal(error.code, 'E_POLICY_DENIED');
        assert.equal(error.reason, 'approval_invalidated');
        return true;
      });
      f.state.allowed = true;
    }
    assert.equal(f.state.mutations.length, 0);
  } finally {
    await f.close();
  }
});

test('a withdrawn request (the session was closed or the page moved on) leaves an invalidated tombstone, not a denial', async () => {
  const f = await fixture();
  try {
    const request = await f.request();
    // A caller that acts on an older revision withdraws the pending request; the broker retires it.
    const seen = await f.engine.observe(f.session.session_id);
    f.state.fingerprint = 'moved-on';
    await f.engine.observe(f.session.session_id);
    await assert.rejects(f.engine.act(f.session.session_id, f.action, seen.revision), { code: 'E_STALE_STATE' });
    assert.equal(request.status, 'invalidated');
    assert.equal((await f.engine.approvals()).requests.length, 0);
    const tombstones = (f.engine as unknown as { approvalTerminal: Map<string, { status: string }> }).approvalTerminal;
    assert.deepEqual(
      [...tombstones.values()].map(t => t.status),
      ['invalidated'],
    );
    // Closing the session withdraws a pending request the same way.
    const other = await f.engine.open((await f.engine.listTargets()).targets[0]!.target_id);
    await assert.rejects(f.engine.act(other.session_id, f.action, 1), { code: 'E_APPROVAL_REQUIRED' });
    await f.engine.close(other.session_id);
    assert.deepEqual(
      [...tombstones.values()].map(t => t.status),
      ['invalidated', 'invalidated'],
    );
    assert.equal(f.state.mutations.length, 0);
  } finally {
    await f.close();
  }
});

// Long poll: adl_approvals may wait (bounded) for a decision. It reports; it never decides, consumes or changes a request.
test('approvals waits for a decision, polling every 500 ms', { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const request = await f.request();
    const started = Date.now();
    setTimeout(() => (request.status = 'approved'), 100);
    const result = await f.engine.approvals(request.request_id, 30000);
    const elapsed = Date.now() - started;
    assert.equal(result.requests[0]?.status, 'approved');
    assert.ok(elapsed >= 400 && elapsed < 1500, String(elapsed));
    assert.ok(result.waited_ms >= 400 && result.waited_ms < 1500, String(result.waited_ms));
    assert.equal('timed_out' in result, false);
    // Waiting decided nothing: the approval is still there for the identical retry to consume.
    assert.equal(f.state.consumes, 0);
    await f.engine.act(f.session.session_id, f.action, 1);
    assert.equal(f.state.consumes, 1);
  } finally {
    await f.close();
  }
});

test(
  'approvals times out as timed_out:true while the request stays pending and usable',
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    try {
      const request = await f.request();
      const result = await f.engine.approvals(request.request_id, 1000);
      assert.equal(result.requests.length, 1);
      assert.equal(result.requests[0]?.status, 'pending');
      assert.equal((result as { timed_out?: boolean }).timed_out, true);
      assert.ok(result.waited_ms >= 1000 && result.waited_ms <= 1600, String(result.waited_ms));
      // Not waiting (the default) never reports a timeout.
      const now = await f.engine.approvals(request.request_id);
      assert.equal('timed_out' in now, false);
      assert.equal(now.waited_ms, 0);
      request.status = 'approved';
      await f.engine.act(f.session.session_id, f.action, 1);
      assert.equal(f.state.mutations.length, 1);
    } finally {
      await f.close();
    }
  },
);

test(
  'approvals returns at once for an unknown id, for an empty list and without a broker',
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    try {
      await f.request();
      const started = Date.now();
      const unknown = await f.engine.approvals(randomUUID(), 5000);
      assert.deepEqual(unknown.requests, []);
      assert.ok(unknown.waited_ms < 500 && Date.now() - started < 1000);
      assert.equal('timed_out' in unknown, false);
    } finally {
      await f.close();
    }
    const empty = await fixture();
    try {
      const started = Date.now();
      assert.deepEqual((await empty.engine.approvals(undefined, 5000)).requests, []);
      assert.ok(Date.now() - started < 1000);
    } finally {
      await empty.close();
    }
    const saved = [process.env.ADL_APPROVAL_URL, process.env.ADL_APPROVAL_TOKEN, process.env.ADL_APPROVAL_EPOCH];
    for (const key of ['ADL_APPROVAL_URL', 'ADL_APPROVAL_TOKEN', 'ADL_APPROVAL_EPOCH']) delete process.env[key];
    const engine = new Engine(parsePolicy({ operationMode: 'ask', browserTargets: [] }), {
      browser: { open: async () => assert.fail('unused'), close: async () => {} },
    });
    try {
      const started = Date.now();
      const result = await engine.approvals(undefined, 30000);
      assert.deepEqual({ requests: result.requests, waited_ms: result.waited_ms }, { requests: [], waited_ms: 0 });
      assert.ok(Date.now() - started < 1000);
    } finally {
      await engine.shutdown();
      for (const [key, value] of [
        ['ADL_APPROVAL_URL', saved[0]],
        ['ADL_APPROVAL_TOKEN', saved[1]],
        ['ADL_APPROVAL_EPOCH', saved[2]],
      ] as const)
        if (value !== undefined) process.env[key] = value;
    }
  },
);

test(
  'approvals stops when the caller cancels or the engine shuts down, leaving the request unchanged',
  { timeout: 20000 },
  async () => {
    const f = await fixture();
    try {
      const request = await f.request();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      const started = Date.now();
      await assert.rejects(f.engine.approvals(request.request_id, 30000, controller.signal), (error: unknown) => {
        assert.ok(error instanceof AdlError);
        assert.equal(error.code, 'E_CANCELLED');
        assert.equal(error.reason, undefined);
        return true;
      });
      assert.ok(Date.now() - started < 700, String(Date.now() - started));
      assert.equal(request.status, 'pending');
      assert.equal((await f.engine.approvals()).requests[0]?.status, 'pending');
      // An already aborted signal does not poll at all.
      const gets = f.state.gets;
      await assert.rejects(f.engine.approvals(request.request_id, 30000, AbortSignal.abort()), { code: 'E_CANCELLED' });
      assert.equal(f.state.gets, gets);
      // Engine shutdown ends a wait in progress as an emergency stop.
      const waiting = f.engine.approvals(request.request_id, 30000);
      const stopping = new Promise(resolve => setTimeout(resolve, 150)).then(() => f.engine.shutdown());
      await assert.rejects(waiting, (error: unknown) => {
        assert.ok(error instanceof AdlError);
        assert.equal(error.code, 'E_CANCELLED');
        assert.equal(error.reason, 'emergency_stop');
        return true;
      });
      await stopping;
    } finally {
      await f.close();
    }
  },
);

test('approvals validates wait_ms: an integer from 0 to 30000', async () => {
  const f = await fixture();
  try {
    await f.request();
    for (const bad of [30001, -1, 1.5, Number.NaN, '5' as unknown as number])
      await assert.rejects(f.engine.approvals(undefined, bad), (error: unknown) => {
        assert.ok(error instanceof AdlError, String(bad));
        assert.equal(error.code, 'E_INVALID_ARGUMENT');
        assert.equal(error.detail.argument, 'wait_ms');
        return true;
      });
    assert.equal((await f.engine.approvals(undefined, 0)).requests.length, 1);
  } finally {
    await f.close();
  }
});

test('approvals reports an expired request as expired without asking a broker that has already forgotten it', async () => {
  const f = await fixture();
  const clock = Date.now;
  try {
    const request = await f.request();
    const gets = f.state.gets;
    f.entries.delete(request.request_id);
    Date.now = () => request.expires_at + 1;
    const result = await f.engine.approvals(request.request_id);
    assert.deepEqual(
      result.requests.map(r => [r.request_id, r.status]),
      [[request.request_id, 'expired']],
    );
    assert.equal(f.state.gets, gets);
    assert.equal('timed_out' in result, false);
    await assert.rejects(f.engine.act(f.session.session_id, f.action, 1), {
      code: 'E_STALE_STATE',
      reason: 'approval_expired',
    });
  } finally {
    Date.now = clock;
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

// A browser-shaped adapter for ask-mode plain submissions: the first act dispatches and the submission guard stops it, as BrowserSession.act does.
// The snapshot carries action evidence, so a dispatched action moves the session to a new revision exactly as it does in a real browser.
async function submissionFixture(
  options: {
    broker?: boolean;
    /** A same-origin urlencoded POST form: the adapter reports the network facts of the request the guard stops. */
    urlencoded?: boolean;
    /** The URL of that request (default https://example.com/save). */
    networkUrl?: string;
    /** The labels the activation can carry (default: the control's own name). */
    labels?: string[];
  } = {},
) {
  const broker = options.broker === false ? undefined : await stubBroker();
  const state = {
    version: 1,
    acts: 0,
    blocksLeft: 1,
    authorizations: [] as (ActionAuthorization | undefined)[],
    plainAfterAttempt: true,
    failWith: undefined as AdlError | undefined,
  };
  const adapter: Adapter = {
    open: async () => ({
      tracksDispatch: true,
      snapshot: async () => ({
        fingerprint: `form-v${state.version}`,
        truncated: false,
        elements: [{ id: 'save', role: 'button', name: 'Save', enabled: true }],
        actionEvidence: { navigation: 'document-1', elements: { save: `save-v${state.version}` } },
      }),
      prepareAction: async () => ({
        proof: `plain-submit-v${state.version}${state.acts > 0 && !state.plainAfterAttempt ? '-changed' : ''}`,
        risk: 'ordinary',
        role: 'button',
        name: 'Save',
        origin: 'https://example.com',
        details: ['Form POST https://example.com/save', '"title": "t"'],
        ...(options.labels ? { labels: options.labels } : {}),
        ...(options.urlencoded
          ? { network: { url: options.networkUrl ?? 'https://example.com/save', method: 'POST', body: 'title=t' } }
          : {}),
        ...(state.acts > 0 && !state.plainAfterAttempt ? {} : { submission: 'plain' as const }),
      }),
      act: async (_action, _signal, dispatch, authorization) => {
        dispatch?.();
        state.acts++;
        state.authorizations.push(authorization);
        if (state.failWith) throw state.failWith;
        if (state.blocksLeft > 0 && !authorization?.approved) {
          state.blocksLeft--;
          throw new AdlError('E_APPROVAL_REQUIRED', 'form_submission_requires_approval');
        }
      },
      close: async () => {},
    }),
    close: async () => {},
  };
  const policy = parsePolicy({
    operationMode: 'ask',
    allowedOrigins: ['https://example.com'],
    browserTargets: [{ id: 'fixture', label: 'Example', url: 'https://example.com', classification: 'PUBLIC' }],
  });
  const engine = new Engine(policy, { browser: adapter });
  const session = await engine.open((await engine.listTargets()).targets[0]!.target_id);
  const action: Action = { action: 'click', element_id: 'e1' };
  return {
    engine,
    session,
    action,
    state,
    broker,
    /** The first act, which the guard stops: returns the error the caller sees. */
    attempt: async () => {
      const error = await engine.act(session.session_id, action, 1).then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(error instanceof AdlError, String(error));
      return error;
    },
    close: async () => {
      await engine.shutdown();
      await broker?.close();
    },
  };
}

test('ask mode: a submission stopped by the guard opens one request from the post-attempt revision, and retries do not dispatch again', async () => {
  const f = await submissionFixture();
  try {
    const error = await f.attempt();
    assert.equal(error.code, 'E_APPROVAL_REQUIRED');
    assert.equal(error.reason, 'form_submission_requires_approval');
    assert.ok(error.requestId);
    const safe = safeError(error);
    assert.equal(safe.request_id, error.requestId);
    assert.equal(safe.retryable, true);
    assert.equal(safe.may_have_executed, undefined);
    assert.equal(safe.revision, 2, 'the revision after the dispatched attempt');
    assert.equal(f.broker!.state.posts, 1);
    assert.equal(f.state.acts, 1);
    const request = f.broker!.byId(error.requestId!)!;
    assert.equal(request.summary.risk, 'consequential');
    assert.deepEqual(request.summary.details, ['Form POST https://example.com/save', '"title": "t"']);
    // The identical retry at the returned revision: same request, no second dispatch, no second broker request.
    for (let i = 0; i < 2; i++) {
      const again: unknown = await f.engine.act(f.session.session_id, f.action, safe.revision!).then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(again instanceof AdlError);
      assert.equal(again.requestId, error.requestId);
      assert.equal(safeError(again).revision, safe.revision);
    }
    assert.equal(f.state.acts, 1);
    assert.equal(f.broker!.state.posts, 1);
    // Approved: consumed once and dispatched with the approval so the adapter can arm the body-bound permit.
    request.status = 'approved';
    const result = await f.engine.act(f.session.session_id, f.action, safe.revision!);
    assert.equal(result.ok, true);
    assert.equal(f.state.acts, 2);
    assert.equal(f.broker!.state.consumes, 1);
    assert.equal(f.state.authorizations[0]?.approved, false);
    assert.equal(f.state.authorizations[1]?.approved, true);
    assert.equal(f.state.authorizations[1]?.approvalProof, 'plain-submit-v1');
    assert.ok((f.state.authorizations[1]?.expires_at ?? 0) > Date.now());
    assert.equal((await f.engine.approvals()).requests.length, 0);
  } finally {
    await f.close();
  }
});

test('ask mode: a retry at the pre-attempt revision is stale and withdraws the request; the same submission is not asked again at once', async () => {
  const f = await submissionFixture();
  try {
    const error = await f.attempt();
    const revision = safeError(error).revision!;
    f.broker!.byId(error.requestId!)!.status = 'approved';
    await assert.rejects(f.engine.act(f.session.session_id, f.action, 1), { code: 'E_STALE_STATE' });
    assert.equal(f.broker!.state.deletes, 1, 'the pending request was withdrawn at the broker');
    assert.equal(
      f.broker!.state.consumes,
      1,
      'the broker retires an approved request on withdrawal; nothing was dispatched',
    );
    // The withdrawn binding is a tombstone until it expires: the identical retry is refused before any dispatch.
    await assert.rejects(f.engine.act(f.session.session_id, f.action, revision), { code: 'E_POLICY_DENIED' });
    assert.equal(f.state.acts, 1);
    assert.equal(f.broker!.state.posts, 1);
  } finally {
    await f.close();
  }
});

test('ask mode: without a broker the guarded attempt reports approval_unavailable and no revision', async () => {
  const saved = [process.env.ADL_APPROVAL_URL, process.env.ADL_APPROVAL_TOKEN, process.env.ADL_APPROVAL_EPOCH];
  for (const key of ['ADL_APPROVAL_URL', 'ADL_APPROVAL_TOKEN', 'ADL_APPROVAL_EPOCH']) delete process.env[key];
  const f = await submissionFixture({ broker: false });
  try {
    const error = await f.attempt();
    assert.equal(error.code, 'E_APPROVAL_REQUIRED');
    assert.equal(error.reason, 'approval_unavailable');
    assert.equal(safeError(error).revision, undefined);
    assert.equal(f.state.acts, 1, 'dispatched once under the guard, like standard mode');
  } finally {
    await f.close();
    for (const [key, value] of [
      ['ADL_APPROVAL_URL', saved[0]],
      ['ADL_APPROVAL_TOKEN', saved[1]],
      ['ADL_APPROVAL_EPOCH', saved[2]],
    ] as const)
      if (value !== undefined) process.env[key] = value;
  }
});

test('ask mode: no request is made when the attempt did not stop on a submission, or the form changed into something else', async () => {
  const other = await submissionFixture();
  try {
    other.state.failWith = new AdlError('E_NOT_INTERACTABLE');
    await assert.rejects(other.engine.act(other.session.session_id, other.action, 1), { code: 'E_NOT_INTERACTABLE' });
    assert.equal(other.broker!.state.posts, 0);
  } finally {
    await other.close();
  }
  const changed = await submissionFixture();
  try {
    changed.state.plainAfterAttempt = false;
    await assert.rejects(changed.engine.act(changed.session.session_id, changed.action, 1), {
      code: 'E_STALE_STATE',
    });
    assert.equal(
      changed.broker!.state.posts,
      0,
      'a form that is no longer a plain submission is not approved on its old proof',
    );
    assert.equal(changed.state.acts, 1);
  } finally {
    await changed.close();
  }
});

test('ask mode: a denied submission request is final and never dispatches again', async () => {
  const f = await submissionFixture();
  try {
    const error = await f.attempt();
    f.broker!.byId(error.requestId!)!.status = 'denied';
    for (let i = 0; i < 3; i++)
      await assert.rejects(f.engine.act(f.session.session_id, f.action, safeError(error).revision!), {
        code: 'E_POLICY_DENIED',
      });
    assert.equal(f.state.acts, 1);
    assert.equal(f.broker!.state.posts, 1);
  } finally {
    await f.close();
  }
});

// Held writes (ask mode): the page's action sent write requests, the adapter holds them unsent and throws HeldWritesError. The fake adapter
// records what the engine asks of it; the snapshot carries action evidence, so a dispatched action moves the session to a new revision.
const heldRequest = (over: Partial<HeldWrite> = {}): HeldWrite => ({
  method: 'POST',
  url: 'https://example.com/api',
  content_type: 'application/json',
  body_sha256: 'a'.repeat(64),
  body_length: 12,
  details: ['Request POST https://example.com/api', '"title": "t"'],
  secret: false,
  ...over,
});
async function heldFixture(
  options: {
    broker?: boolean;
    operationMode?: 'ask' | 'standard';
    requests?: HeldWrite[];
    /** The Buy control is a verb that may stay in the session (Delete): contained instead of approved before dispatch. */
    containable?: boolean;
    /** An adapter that cannot hold writes. */
    noHolding?: boolean;
    /** The name of the dialog the control sits in (one more label of the activation). */
    dialog?: string;
    /** The label of the ordinary control the tests click (default Save). */
    saveName?: string;
    /** Origins the policy allows besides https://example.com. */
    allowedOrigins?: string[];
    /** A policy audit file. */
    auditPath?: string;
  } = {},
) {
  const broker = options.broker === false ? undefined : await stubBroker();
  const state = {
    version: 1,
    acts: 0,
    holdsLeft: 1,
    holdNumber: 0,
    requests: options.requests ?? [heldRequest()],
    alive: true,
    releaseFails: false,
    allowed: true,
    writeHolding: [] as boolean[],
    authorizations: [] as (ActionAuthorization | undefined)[],
    released: [] as [string, number][],
    aborted: [] as [string, string][],
    outcome: undefined as { dispatched?: number; refused?: number; response_status?: number } | undefined,
  };
  const adapter: Adapter = {
    open: async () => ({
      tracksDispatch: true,
      ...(options.noHolding
        ? {}
        : {
            setWriteHolding: (enabled: boolean) => {
              state.writeHolding.push(enabled);
            },
          }),
      snapshot: async () => ({
        fingerprint: `held-v${state.version}`,
        truncated: false,
        elements: [
          { id: 'save', role: 'button', name: 'Save', enabled: true },
          { id: 'buy', role: 'button', name: 'Buy', enabled: true },
        ],
        actionEvidence: { navigation: 'document-1', elements: { save: `save-v${state.version}`, buy: 'buy' } },
      }),
      prepareAction: async (action: Action) => ({
        proof: `proof-${action.element_id}`,
        risk: action.element_id === 'buy' ? ('consequential' as const) : ('ordinary' as const),
        role: 'button',
        name: action.element_id === 'buy' ? 'Buy' : (options.saveName ?? 'Save'),
        labels: [
          action.element_id === 'buy' ? 'Buy' : (options.saveName ?? 'Save'),
          ...(options.dialog ? [options.dialog] : []),
        ],
        origin: 'https://example.com',
        ...(options.containable && action.element_id === 'buy' ? { contained: true } : {}),
      }),
      act: async (_action, _signal, dispatch, authorization) => {
        dispatch?.();
        state.acts++;
        state.authorizations.push(authorization);
        if (state.holdsLeft > 0 && authorization?.holdWrites) {
          state.holdsLeft--;
          state.alive = true;
          throw new HeldWritesError({ id: `h${++state.holdNumber}`, requests: state.requests });
        }
      },
      releaseHeldWrites: async (holdId: string, expiresAt: number) => {
        if (state.releaseFails) throw new AdlError('E_STALE_STATE');
        state.released.push([holdId, expiresAt]);
      },
      abortHeldWrites: async (holdId: string, outcome: string) => {
        state.aborted.push([holdId, outcome]);
      },
      heldWritesAlive: () => state.alive,
      heldWriteOutcome: () => state.outcome,
      close: async () => {},
    }),
    close: async () => {},
  };
  const policy = parsePolicy({
    operationMode: options.operationMode ?? 'ask',
    allowedOrigins: ['https://example.com', ...(options.allowedOrigins ?? [])],
    browserTargets: [{ id: 'fixture', label: 'Example', url: 'https://example.com', classification: 'PUBLIC' }],
    ...(options.auditPath ? { auditPath: options.auditPath } : {}),
  });
  const engine = new Engine(policy, { browser: adapter }, process.platform, () => state.allowed);
  const session = await engine.open((await engine.listTargets()).targets[0]!.target_id);
  const action: Action = { action: 'click', element_id: 'e1' };
  const other: Action = { action: 'click', element_id: 'e2' };
  /** The first act, which the page's handler answers with held writes: returns the error the caller sees. */
  const attempt = async (revision = 1) => {
    const error = await engine.act(session.session_id, action, revision).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(error instanceof AdlError, String(error));
    return error;
  };
  return {
    engine,
    session,
    action,
    other,
    state,
    broker,
    attempt,
    /** Polls until the condition holds (the engine's watcher acts on its own clock). */
    until: async (condition: () => boolean, ms = 3000) => {
      for (const started = Date.now(); !condition(); await new Promise(resolve => setTimeout(resolve, 20)))
        if (Date.now() - started > ms) assert.fail('condition not reached in ' + ms + ' ms');
    },
    close: async () => {
      await engine.shutdown();
      await broker?.close();
    },
  };
}
const rows = (result: { requests: { request_id: string; status: string; sent?: boolean }[] }) =>
  result.requests.map(r => [r.status, r.sent]);

test('held writes: the first act opens one approval from the described requests; the agent gets a request id and is told not to retry', async () => {
  const f = await heldFixture();
  try {
    const error = await f.attempt();
    assert.equal(error.code, 'E_APPROVAL_REQUIRED');
    assert.equal(error.reason, 'request_requires_approval');
    assert.ok(error.requestId);
    const safe = safeError(error);
    assert.equal(safe.request_id, error.requestId);
    assert.equal(safe.retryable, false);
    assert.equal(safe.page_script_ran, true);
    assert.equal(safe.may_have_executed, undefined);
    assert.equal(safe.revision, undefined);
    assert.equal(f.broker!.state.posts, 1);
    const request = f.broker!.byId(error.requestId!)!;
    assert.equal(request.summary.risk, 'consequential');
    assert.equal(
      request.summary.action,
      'send_request',
      'the control already ran: the human approves the request it left waiting',
    );
    assert.equal(request.summary.name, 'Save');
    assert.deepEqual(request.summary.details, ['Request POST https://example.com/api', '"title": "t"']);
    assert.equal(f.state.authorizations[0]?.holdWrites, true);
    assert.equal(f.state.authorizations[0]?.approved, false);
    assert.deepEqual(f.state.released, []);
    assert.deepEqual(f.state.aborted, []);
    // The session survives and sits on the revision after the dispatched action.
    assert.equal((await f.engine.observe(f.session.session_id)).revision, 2);
    const pending = await f.engine.approvals(error.requestId);
    assert.deepEqual(rows(pending), [['pending', undefined]]);
  } finally {
    await f.close();
  }
});

test('held writes: approval releases the requests once; adl_approvals reports sent and the answer, and keeps the row only for its request id', async () => {
  const f = await heldFixture();
  try {
    const error = await f.attempt();
    const id = error.requestId!;
    // The answer arrives after the release: adl_approvals waits briefly for it.
    setTimeout(() => (f.state.outcome = { response_status: 200 }), 300);
    f.broker!.byId(id)!.status = 'approved';
    const started = Date.now();
    const result = await f.engine.approvals(id, 30000);
    assert.ok(Date.now() - started < 2500, String(Date.now() - started));
    assert.equal(result.requests.length, 1);
    assert.deepEqual(
      { ...result.requests[0], summary: undefined, expires_at: undefined },
      {
        request_id: id,
        status: 'consumed',
        expires_at: undefined,
        summary: undefined,
        sent: true,
        response_status: 200,
        save: { state: 'submitted', next_step: 'observe', retry_action: false },
      },
    );
    assert.equal(f.state.released.length, 1);
    assert.equal(f.state.released[0]![0], 'h1');
    assert.equal(f.state.released[0]![1], f.broker!.byId(id)!.expires_at);
    assert.deepEqual(f.state.aborted, []);
    assert.equal(f.broker!.state.consumes, 1);
    assert.equal(f.state.acts, 1);
    // Only pending requests are listed without an id; the explicit id still finds the ended one (with the same answer).
    assert.deepEqual((await f.engine.approvals()).requests, []);
    const again = await f.engine.approvals(id);
    assert.deepEqual(
      again.requests.map(r => [r.request_id, r.status, r.sent, r.response_status]),
      [[id, 'consumed', true, 200]],
    );
    assert.deepEqual((await f.engine.approvals(randomUUID())).requests, []);
    assert.equal(f.state.released.length, 1, 'looking again releases nothing');
  } finally {
    await f.close();
  }
});

test('held writes: the engine learns of the approval by itself, within one poll, when nobody calls adl_approvals', async () => {
  const f = await heldFixture();
  try {
    const error = await f.attempt();
    f.broker!.byId(error.requestId!)!.status = 'approved';
    const started = Date.now();
    await f.until(() => f.state.released.length === 1, 1200);
    assert.ok(Date.now() - started < 1200);
    assert.equal(f.broker!.state.consumes, 1);
    const [row] = (await f.engine.approvals(error.requestId)).requests;
    assert.deepEqual([row?.status, row?.sent], ['consumed', true]);
    assert.equal(row?.response_status, undefined);
  } finally {
    await f.close();
  }
});

// Whatever ends the request ends the held writes with the matching outcome, and nothing is sent.
for (const status of ['denied', 'expired', 'invalidated'] as const)
  test(`held writes: a request the broker reports as ${status} aborts the requests as ${status} and sends nothing`, async () => {
    const f = await heldFixture();
    try {
      const error = await f.attempt();
      f.broker!.byId(error.requestId!)!.status = status;
      const result = await f.engine.approvals(error.requestId, 30000);
      assert.deepEqual(rows(result), [[status, false]]);
      assert.deepEqual(f.state.aborted, [['h1', status]]);
      assert.deepEqual(f.state.released, []);
      assert.equal(f.broker!.state.consumes, 0);
      assert.deepEqual((await f.engine.approvals()).requests, []);
    } finally {
      await f.close();
    }
  });

test('held writes: expiry by the clock is expired, and an approval that arrives afterwards sends nothing', async () => {
  const f = await heldFixture();
  const clock = Date.now;
  try {
    const error = await f.attempt();
    const request = f.broker!.byId(error.requestId!)!;
    request.status = 'approved';
    Date.now = () => request.expires_at + 1;
    const result = await f.engine.approvals(error.requestId);
    assert.deepEqual(rows(result), [['expired', false]]);
    assert.deepEqual(f.state.aborted, [['h1', 'expired']]);
    assert.deepEqual(f.state.released, []);
  } finally {
    Date.now = clock;
    await f.close();
  }
});

test('held writes: the identical action returns the same request without dispatching; other actions and stale revisions leave the hold alone', async () => {
  const f = await heldFixture();
  try {
    const error = await f.attempt();
    const id = error.requestId!;
    for (let i = 0; i < 2; i++) {
      const again: unknown = await f.engine.act(f.session.session_id, f.action, 2).then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(again instanceof AdlError);
      assert.equal(again.reason, 'request_requires_approval');
      assert.equal(again.requestId, id);
      assert.equal(safeError(again).retryable, false);
    }
    assert.equal(f.state.acts, 1);
    assert.equal(f.broker!.state.posts, 1);
    // A different consequential action must not replace a decision in progress.
    await assert.rejects(f.engine.act(f.session.session_id, f.other, 2), {
      code: 'E_APPROVAL_REQUIRED',
      reason: 'approval_pending_other_action',
    });
    // An agent on an old revision is stale, but a hold is bound to the page's request, not to the revision.
    await assert.rejects(f.engine.act(f.session.session_id, f.action, 1), { code: 'E_STALE_STATE' });
    await assert.rejects(f.engine.act(f.session.session_id, f.other, 1), { code: 'E_STALE_STATE' });
    assert.equal(f.broker!.byId(id)!.status, 'pending');
    assert.equal(f.broker!.state.deletes, 0);
    assert.deepEqual(f.state.aborted, []);
    assert.deepEqual(rows(await f.engine.approvals(id)), [['pending', undefined]]);
    // Still approvable afterwards.
    f.broker!.byId(id)!.status = 'approved';
    assert.deepEqual(rows(await f.engine.approvals(id, 30000)), [['consumed', true]]);
    assert.equal(f.state.released.length, 1);
    // The hold is over: the same action runs again (a new handler run) instead of returning the old request.
    f.state.holdsLeft = 1;
    const second = await f.attempt(2);
    assert.notEqual(second.requestId, id);
    assert.equal(f.state.acts, 2);
  } finally {
    await f.close();
  }
});

test('held writes: closing the session withdraws the request at the broker and aborts the requests', async () => {
  const f = await heldFixture();
  try {
    const error = await f.attempt();
    await f.engine.close(f.session.session_id);
    assert.equal(f.broker!.state.deletes, 1);
    assert.equal(f.broker!.byId(error.requestId!)!.status, 'invalidated');
    assert.deepEqual(f.state.aborted, [['h1', 'invalidated']]);
    assert.deepEqual(f.state.released, []);
    assert.deepEqual(rows(await f.engine.approvals(error.requestId)), [['invalidated', false]]);
    assert.deepEqual((await f.engine.approvals()).requests, []);
  } finally {
    await f.close();
  }
});

test('held writes: requests the page abandoned are withdrawn within one poll', async () => {
  const f = await heldFixture();
  try {
    const error = await f.attempt();
    f.state.alive = false;
    await f.until(() => f.state.aborted.length === 1, 1500);
    assert.deepEqual(f.state.aborted, [['h1', 'invalidated']]);
    // A report of the request waits for its settlement to complete, including the withdrawal at the broker.
    assert.deepEqual(rows(await f.engine.approvals(error.requestId)), [['invalidated', false]]);
    assert.equal(f.broker!.byId(error.requestId!)!.status, 'invalidated');
    assert.deepEqual(f.state.released, []);
  } finally {
    await f.close();
  }
});

test('held writes: write holding is enabled only for ask mode with an approver', async () => {
  const f = await heldFixture();
  const standard = await heldFixture({ operationMode: 'standard' });
  try {
    assert.deepEqual(f.state.writeHolding, [true]);
    assert.deepEqual(standard.state.writeHolding, [false]);
    assert.equal(standard.state.authorizations.length, 0);
    await standard.engine.act(standard.session.session_id, standard.action, 1);
    assert.equal(standard.state.authorizations[0]?.holdWrites, undefined);
  } finally {
    // Each stub broker restores the environment it found: close them in reverse order.
    await standard.close();
    await f.close();
  }
  const saved = [process.env.ADL_APPROVAL_URL, process.env.ADL_APPROVAL_TOKEN, process.env.ADL_APPROVAL_EPOCH];
  for (const key of ['ADL_APPROVAL_URL', 'ADL_APPROVAL_TOKEN', 'ADL_APPROVAL_EPOCH']) delete process.env[key];
  const bare = await heldFixture({ broker: false });
  try {
    assert.deepEqual(bare.state.writeHolding, [false]);
    await bare.engine.act(bare.session.session_id, bare.action, 1);
    assert.equal(bare.state.authorizations[0]?.holdWrites, undefined, 'no approver, nothing to hold for');
  } finally {
    await bare.close();
    for (const [key, value] of [
      ['ADL_APPROVAL_URL', saved[0]],
      ['ADL_APPROVAL_TOKEN', saved[1]],
      ['ADL_APPROVAL_EPOCH', saved[2]],
    ] as const)
      if (value !== undefined) process.env[key] = value;
  }
});

test('held writes: in ask mode a containable verb is dispatched contained when the adapter can hold writes, and approved first when it cannot', async () => {
  const f = await heldFixture({ containable: true });
  try {
    f.state.holdsLeft = 0;
    const result = await f.engine.act(f.session.session_id, f.other, 1);
    assert.equal(result.ok, true);
    assert.equal(f.broker!.state.posts, 0, 'no click approval: the request it may send is what a human approves');
    assert.equal(f.state.acts, 1);
    assert.equal(f.state.authorizations[0]?.approved, false);
    assert.equal(f.state.authorizations[0]?.holdWrites, true);
  } finally {
    await f.close();
  }
  const bare = await heldFixture({ containable: true, noHolding: true });
  try {
    await assert.rejects(bare.engine.act(bare.session.session_id, bare.other, 1), { code: 'E_APPROVAL_REQUIRED' });
    assert.equal(bare.broker!.state.posts, 1, 'an adapter that cannot hold writes keeps the approval before dispatch');
    assert.equal(bare.state.acts, 0);
  } finally {
    await bare.close();
  }
  // Standard mode has nobody to ask and always contains.
  const standard = await heldFixture({ containable: true, operationMode: 'standard' });
  try {
    standard.state.holdsLeft = 0;
    assert.equal((await standard.engine.act(standard.session.session_id, standard.other, 1)).ok, true);
    assert.equal(standard.state.acts, 1);
  } finally {
    await standard.close();
  }
});

test('held writes: a set that cannot be shown completely is aborted as not approvable and never asked', async () => {
  const lines = Array.from({ length: 26 }, (_, i) => `"field${i}": "v"`);
  const f = await heldFixture({ requests: [heldRequest({ details: lines })] });
  try {
    const error = await f.attempt();
    assert.equal(error.code, 'E_APPROVAL_REQUIRED');
    assert.equal(error.reason, 'request_not_approvable');
    assert.equal(error.requestId, undefined);
    assert.equal(safeError(error).page_script_ran, true);
    assert.equal(safeError(error).retryable, false);
    assert.equal(f.broker!.state.posts, 0);
    assert.deepEqual(f.state.aborted, [['h1', 'not_approvable']]);
  } finally {
    await f.close();
  }
  // Two requests of 13 lines each do not fit one dialog either, nor do details above 8192 bytes in all.
  const two = await heldFixture({
    requests: [heldRequest({ details: lines.slice(0, 13) }), heldRequest({ details: lines.slice(0, 13) })],
  });
  try {
    assert.equal((await two.attempt()).reason, 'request_not_approvable');
    assert.equal(two.broker!.state.posts, 0);
  } finally {
    await two.close();
  }
  const big = await heldFixture({
    requests: [heldRequest({ details: Array.from({ length: 3 }, () => 'x'.repeat(3000)) })],
  });
  try {
    assert.equal((await big.attempt()).reason, 'request_not_approvable');
    assert.equal(big.broker!.state.posts, 0);
    assert.deepEqual(big.state.aborted, [['h1', 'not_approvable']]);
  } finally {
    await big.close();
  }
});

test('held writes: a secret value in any request makes the approval a credential request; several requests are one approval', async () => {
  const f = await heldFixture({
    requests: [
      heldRequest({ details: ['Request POST https://example.com/a'] }),
      heldRequest({
        url: 'https://example.com/b',
        details: ['Request POST https://example.com/b', '"password": [secret, 8 characters]'],
        secret: true,
      }),
    ],
  });
  try {
    const error = await f.attempt();
    assert.equal(f.broker!.state.posts, 1);
    const request = f.broker!.byId(error.requestId!)!;
    assert.equal(request.summary.risk, 'credential');
    assert.deepEqual(request.summary.details, [
      'Request POST https://example.com/a',
      'Request POST https://example.com/b',
      '"password": [secret, 8 characters]',
    ]);
    request.status = 'approved';
    assert.deepEqual(rows(await f.engine.approvals(error.requestId, 30000)), [['consumed', true]]);
    assert.equal(f.broker!.state.consumes, 1, 'one approval for the whole set');
    assert.equal(f.state.released.length, 1);
  } finally {
    await f.close();
  }
});

test('held writes: the request cannot be opened while another approval is pending; the requests are aborted and the reason is reported', async () => {
  const f = await heldFixture();
  try {
    // The Buy click needs its own approval first (a pending decision of another action).
    await assert.rejects(f.engine.act(f.session.session_id, f.other, 1), {
      code: 'E_APPROVAL_REQUIRED',
      reason: undefined,
    });
    assert.equal(f.broker!.state.posts, 1);
    const error = await f.attempt();
    assert.equal(error.code, 'E_APPROVAL_REQUIRED');
    assert.equal(error.reason, 'approval_pending_other_action');
    assert.equal(error.requestId, undefined);
    assert.equal(safeError(error).page_script_ran, true);
    assert.deepEqual(f.state.aborted, [['h1', 'invalidated']]);
    assert.equal(f.broker!.state.posts, 1);
  } finally {
    await f.close();
  }
});

test('held writes: a release that fails (the page abandoned the requests meanwhile) reports sent:false, not a send', async () => {
  const f = await heldFixture();
  try {
    const error = await f.attempt();
    f.state.releaseFails = true;
    f.broker!.byId(error.requestId!)!.status = 'approved';
    assert.deepEqual(rows(await f.engine.approvals(error.requestId, 30000)), [['invalidated', false]]);
    assert.deepEqual(f.state.released, []);
    assert.deepEqual(f.state.aborted, [['h1', 'invalidated']]);
  } finally {
    await f.close();
  }
});

test('held writes: an emergency stop between approval and release sends nothing', async () => {
  const f = await heldFixture();
  try {
    const error = await f.attempt();
    f.broker!.byId(error.requestId!)!.status = 'approved';
    f.state.allowed = false;
    await f.until(() => f.state.aborted.length === 1, 2000);
    assert.deepEqual(f.state.aborted, [['h1', 'invalidated']]);
    assert.deepEqual(f.state.released, []);
  } finally {
    f.state.allowed = true;
    await f.close();
  }
});

test('held writes: a batch reports approval progress and a resume point without replaying the write', async () => {
  const f = await heldFixture();
  try {
    const started = f.engine.execute(
      [
        { session_id: f.session.session_id, ...f.action },
        { session_id: f.session.session_id, ...f.other },
      ],
      { [f.session.session_id]: 1 },
    );
    const read = () => f.engine.task(started.task_id);
    await f.until(() => read().status === 'blocked_on_approval');
    const task = read();
    assert.deepEqual(
      task.results.map(r => r.status),
      ['blocked_on_approval', 'not_executed'],
    );
    const request = f.broker!.latest()!;
    assert.equal(task.pending_request_id, request.request_id);
    assert.equal(task.next_step_index, 1);
    assert.deepEqual(task.approval, { request_id: request.request_id, status: 'pending' });
    f.state.outcome = { dispatched: 1, refused: 0 };
    request.status = 'approved';
    const [a, b] = await Promise.all([f.engine.approvals(request.request_id), f.engine.approvals(request.request_id)]);
    assert.deepEqual(rows(a), [['consumed', true]]);
    assert.deepEqual(rows(b), [['consumed', true]]);
    const ready = read();
    assert.equal(ready.status, 'ready_to_resume');
    assert.equal(ready.pending_request_id, undefined);
    assert.equal(ready.next_step_index, 1);
    assert.deepEqual(ready.approval, { request_id: request.request_id, status: 'consumed', sent: true });
    assert.deepEqual(
      ready.results.map(r => r.status),
      ['completed', 'not_executed'],
    );
    assert.deepEqual(ready.results[0]?.save, { state: 'submitted', next_step: 'observe', retry_action: false });
    assert.equal(f.state.acts, 1);
    assert.equal(f.state.released.length, 1);
  } finally {
    await f.close();
  }
});

for (const decision of ['denied', 'expired', 'refused_at_dispatch', 'cancelled', 'completed'] as const)
  test(`held writes: single-step batch handles ${decision}`, async () => {
    const f = await heldFixture();
    try {
      const session_id = f.session.session_id;
      const { task_id } = f.engine.execute([{ session_id, ...f.action }], { [session_id]: 1 });
      const read = () => f.engine.task(task_id);
      await f.until(() => read().status === 'blocked_on_approval');
      const request = f.broker!.latest()!;
      if (decision === 'cancelled') assert.equal(f.engine.task(task_id, 'cancel').status, 'cancelled');
      else {
        request.status = decision === 'denied' || decision === 'expired' ? decision : 'approved';
        f.state.outcome = decision === 'refused_at_dispatch' ? { dispatched: 0, refused: 1 } : { dispatched: 1 };
      }
      await f.engine.approvals(request.request_id);
      const end = read();
      assert.equal(end.next_step_index, undefined);
      assert.equal(end.pending_request_id, undefined);
      assert.equal(end.status, decision === 'completed' || decision === 'cancelled' ? decision : 'failed');
      assert.equal(end.approval?.sent, decision === 'completed');
      if (decision === 'denied') assert.equal(end.error?.reason, 'approval_denied');
      if (decision === 'expired') {
        assert.equal(end.error?.reason, 'approval_expired');
        assert.equal(end.error?.retryable, false);
        assert.equal(end.error?.page_script_ran, true);
      }
      if (decision === 'refused_at_dispatch') assert.equal(end.error?.reason, 'approval_invalidated');
      assert.equal(f.state.acts, 1);
      assert.equal(f.state.released.length, decision === 'completed' || decision === 'refused_at_dispatch' ? 1 : 0);
    } finally {
      await f.close();
    }
  });

// Concurrency crossings: the engine's watcher, adl_approvals and the session lifecycle all act on the same hold.
test(
  'held writes: an approval seen by the watcher and by several adl_approvals waits is released exactly once',
  { timeout: 20000 },
  async () => {
    const f = await heldFixture();
    try {
      const error = await f.attempt();
      const id = error.requestId!;
      const waiting = [
        f.engine.approvals(id, 30000),
        f.engine.approvals(id, 30000),
        f.engine.approvals(undefined, 30000),
      ];
      await new Promise(resolve => setTimeout(resolve, 150));
      f.broker!.byId(id)!.status = 'approved';
      const results = await Promise.all(waiting);
      for (const result of results.slice(0, 2)) assert.deepEqual(rows(result), [['consumed', true]]);
      // Without request_id only pending requests are listed: a wait that looks again after the ending completed sees none.
      assert.ok([0, 1].includes(rows(results[2]!).length), JSON.stringify(rows(results[2]!)));
      if (rows(results[2]!).length) assert.deepEqual(rows(results[2]!), [['consumed', true]]);
      assert.equal(f.state.released.length, 1);
      assert.equal(f.broker!.state.consumes, 1);
      assert.equal(f.broker!.state.deletes, 1);
      assert.deepEqual(f.state.aborted, []);
      await new Promise(resolve => setTimeout(resolve, 700));
      assert.equal(f.state.released.length, 1, 'the watcher does not release again');
      assert.equal(f.broker!.state.consumes, 1);
    } finally {
      await f.close();
    }
  },
);

test('held writes: a denial racing with the session closing ends once and sends nothing', async () => {
  const f = await heldFixture();
  try {
    const error = await f.attempt();
    const id = error.requestId!;
    f.broker!.byId(id)!.status = 'denied';
    const waiting = f.engine.approvals(id, 30000);
    await Promise.all([f.engine.close(f.session.session_id), waiting]);
    assert.equal(f.state.aborted.length, 1);
    assert.ok(['denied', 'invalidated'].includes(f.state.aborted[0]![1]), f.state.aborted[0]![1]);
    assert.deepEqual(f.state.released, []);
    const [row] = (await f.engine.approvals(id)).requests;
    assert.equal(row?.sent, false);
    assert.ok(['denied', 'invalidated'].includes(row!.status), row!.status);
  } finally {
    await f.close();
  }
});

test('held writes: an approval racing with the session closing is released at most once and settled exactly once', async () => {
  const f = await heldFixture();
  try {
    const error = await f.attempt();
    const id = error.requestId!;
    f.broker!.byId(id)!.status = 'approved';
    await Promise.all([f.engine.close(f.session.session_id), f.engine.approvals(id, 30000)]);
    assert.equal(f.state.released.length + f.state.aborted.length, 1, JSON.stringify(f.state));
    assert.ok(f.broker!.state.consumes <= 1);
    const [row] = (await f.engine.approvals(id)).requests;
    assert.equal(row?.sent, f.state.released.length === 1);
  } finally {
    await f.close();
  }
});

test('held writes: the clock passing the expiry while the approval is consumed sends nothing', async () => {
  const f = await heldFixture();
  const clock = Date.now;
  try {
    const error = await f.attempt();
    const request = f.broker!.byId(error.requestId!)!;
    request.status = 'approved';
    // The broker consumed the approval in time; by the time the engine checks the expiry it has passed.
    Date.now = () => (f.broker!.state.consumes > 0 ? request.expires_at + 1 : clock());
    assert.deepEqual(rows(await f.engine.approvals(error.requestId, 30000)), [['expired', false]]);
    assert.equal(f.broker!.state.consumes, 1, 'the approval was spent');
    assert.deepEqual(f.state.released, []);
    assert.deepEqual(f.state.aborted, [['h1', 'expired']]);
  } finally {
    Date.now = clock;
    await f.close();
  }
});

test(
  'held writes: requests the page abandons while adl_approvals waits end the wait at once',
  { timeout: 20000 },
  async () => {
    const f = await heldFixture();
    try {
      const error = await f.attempt();
      const started = Date.now();
      setTimeout(() => (f.state.alive = false), 200);
      const result = await f.engine.approvals(error.requestId, 30000);
      assert.deepEqual(rows(result), [['invalidated', false]]);
      assert.ok(Date.now() - started < 1500, String(Date.now() - started));
      assert.equal(f.broker!.byId(error.requestId!)!.status, 'invalidated');
      assert.deepEqual(f.state.aborted, [['h1', 'invalidated']]);
      assert.equal('timed_out' in result, false);
    } finally {
      await f.close();
    }
  },
);

test('ended ordinary approvals are listed by request id only, and never as sent', async () => {
  const f = await fixture();
  try {
    const request = await f.request();
    request.status = 'approved';
    await f.engine.act(f.session.session_id, f.action, 1);
    assert.equal(f.state.consumes, 1);
    assert.deepEqual((await f.engine.approvals()).requests, []);
    const [row] = (await f.engine.approvals(request.request_id)).requests;
    assert.deepEqual([row?.request_id, row?.status], [request.request_id, 'consumed']);
    assert.equal('sent' in row!, false);
  } finally {
    await f.close();
  }
});

// Standing site grants (ask mode): the broker approves an eligible request at POST time and says so with granted: 'site_writes'. The engine only
// offers the grant for writes without credentials or money-like controls and URLs, and only ever speeds up what the broker approved.
const GRANT = { scope: 'site_writes', origin: 'https://example.com' } as const;
type ActResult = { ok: boolean; revision: number; approval?: Record<string, unknown> };
const events = async (path: string) =>
  (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map(line => (JSON.parse(line) as { event: string }).event);

test('held writes: a set the broker approves by a site grant is consumed and released inside the act, and the act returns ok with approval.granted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adl-grant-'));
  const auditPath = join(dir, 'audit.jsonl');
  const f = await heldFixture({ auditPath });
  try {
    f.broker!.grant('https://example.com');
    f.state.outcome = { response_status: 201 };
    const result = (await f.engine.act(f.session.session_id, f.action, 1)) as ActResult;
    const id = f.broker!.latest()!.request_id;
    assert.equal(result.ok, true);
    assert.deepEqual(result.approval, {
      request_id: id,
      status: 'consumed',
      sent: true,
      granted: 'site_writes',
      response_status: 201,
    });
    assert.equal(result.revision, 2, 'the page was observed again after the requests were sent');
    assert.equal(f.state.acts, 1);
    assert.equal(f.state.released.length, 1);
    assert.equal(f.state.released[0]![0], 'h1');
    assert.deepEqual(f.state.aborted, []);
    assert.deepEqual(
      [f.broker!.state.posts, f.broker!.state.consumes, f.broker!.state.autoApproved],
      [1, 1, 1],
      'one request, consumed exactly once',
    );
    assert.deepEqual(f.broker!.latest()!.summary.grant, GRANT);
    // Nothing is left to wait for; the explicit id still reports how it was decided.
    assert.deepEqual((await f.engine.approvals()).requests, []);
    const [row] = (await f.engine.approvals(id)).requests;
    assert.deepEqual(
      { status: row?.status, sent: row?.sent, response_status: row?.response_status, granted: row?.granted },
      { status: 'consumed', sent: true, response_status: 201, granted: 'site_writes' },
    );
    const log = await events(auditPath);
    assert.ok(log.indexOf('approval_granted_by_site') > log.indexOf('action_started'), log.join());
    assert.ok(log.indexOf('held_request_released') > log.indexOf('approval_granted_by_site'), log.join());
    assert.ok(log.indexOf('action_completed') > log.indexOf('held_request_released'), log.join());
    assert.equal(log.includes('held_request_pending'), false);
    // The next held write under the grant is released the same way (a new request, consumed once again).
    f.state.holdsLeft = 1;
    const second = (await f.engine.act(f.session.session_id, f.action, result.revision)) as ActResult;
    assert.equal(second.approval?.granted, 'site_writes');
    assert.notEqual(second.approval?.request_id, id);
    assert.deepEqual([f.broker!.state.posts, f.broker!.state.consumes, f.state.released.length], [2, 2, 2]);
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('held writes: the grant field names the destination origin and is omitted for secrets, mixed origins, money-like labels or paths, and origins outside the grants', async () => {
  const grantOf = async (options: Parameters<typeof heldFixture>[0]) => {
    const f = await heldFixture(options);
    try {
      const error = await f.attempt();
      assert.equal(error.reason, 'request_requires_approval');
      assert.deepEqual(f.state.aborted, [], 'the hold itself is the same with or without the grant field');
      const summary = f.broker!.latest()!.summary;
      return { grant: summary.grant, risk: summary.risk };
    } finally {
      await f.close();
    }
  };
  const api = 'https://api.example.com';
  const to = (url: string, extra: Partial<HeldWrite> = {}) =>
    heldRequest({ url, details: [`Request POST ${url}`], ...extra });
  assert.deepEqual(await grantOf({}), { grant: GRANT, risk: 'consequential' });
  // A credential in the body: asked every time, as a credential request.
  assert.deepEqual(await grantOf({ requests: [to('https://example.com/a', { secret: true })] }), {
    grant: undefined,
    risk: 'credential',
  });
  // The write goes to another allowed origin: the grant is keyed on the destination, never on the page.
  assert.deepEqual(await grantOf({ allowedOrigins: [api], requests: [to(`${api}/b`)] }), {
    grant: { scope: 'site_writes', origin: api },
    risk: 'consequential',
  });
  // Two origins in one set, an origin the policy does not allow, and a path that names a purchase.
  assert.equal(
    (await grantOf({ allowedOrigins: [api], requests: [to('https://example.com/a'), to(`${api}/b`)] })).grant,
    undefined,
  );
  assert.equal((await grantOf({ requests: [to('https://other.example/a')] })).grant, undefined);
  assert.equal((await grantOf({ requests: [to('https://example.com/api/orders')] })).grant, undefined);
  assert.equal((await grantOf({ requests: [to('https://example.com/pay?x=1')] })).grant, undefined);
  assert.equal((await grantOf({ requests: [to('https://example.com/api?action=purchase')] })).grant, undefined);
  // A money-like control, or a dialog it confirms, even though its write looks ordinary.
  assert.equal((await grantOf({ saveName: 'Checkout' })).grant, undefined);
  assert.equal((await grantOf({ saveName: '注文を確定' })).grant, undefined);
  assert.equal((await grantOf({ dialog: 'Place your order' })).grant, undefined);
  // Harmless words stay eligible.
  assert.deepEqual((await grantOf({ saveName: 'Sort order', dialog: 'Order history' })).grant, GRANT);
});

test('held writes: no grant is offered outside ask mode with a broker, and a money-like set under a live grant still waits for a human', async () => {
  const standard = await heldFixture({ operationMode: 'standard' });
  try {
    standard.state.holdsLeft = 0;
    assert.equal((await standard.engine.act(standard.session.session_id, standard.action, 1)).ok, true);
    assert.equal(standard.broker!.state.posts, 0);
  } finally {
    await standard.close();
  }
  const f = await heldFixture({ saveName: 'Checkout' });
  try {
    f.broker!.grant('https://example.com');
    const error = await f.attempt();
    assert.equal(error.reason, 'request_requires_approval', 'a live grant does not cover a money-like control');
    assert.equal(f.broker!.state.autoApproved, 0);
    assert.deepEqual(rows(await f.engine.approvals(error.requestId)), [['pending', undefined]]);
    assert.deepEqual(f.state.released, []);
  } finally {
    await f.close();
  }
});

test('held writes: the grant can only speed up what the broker approved: approval without granted is invalidated, and a stop or a failed release between the reply and the consume sends nothing', async () => {
  // An approval the broker did not attribute to a grant is not an approval the engine accepts at POST time.
  const silent = await heldFixture();
  try {
    silent.broker!.grant('https://example.com', { reportGranted: false });
    const error = await silent.attempt();
    assert.equal(error.code, 'E_POLICY_DENIED');
    assert.equal(error.reason, 'approval_invalidated');
    assert.equal(safeError(error).page_script_ran, true);
    assert.deepEqual(silent.state.aborted, [['h1', 'invalidated']]);
    assert.deepEqual(silent.state.released, []);
    assert.equal(silent.broker!.state.consumes, 0);
    assert.deepEqual((await silent.engine.approvals()).requests, []);
  } finally {
    await silent.close();
  }
  // Operations already stopped: the act itself is refused before anything happens.
  const stopped = await heldFixture();
  try {
    stopped.broker!.grant('https://example.com');
    stopped.state.allowed = false;
    await assert.rejects(stopped.engine.act(stopped.session.session_id, stopped.action, 1), {
      code: 'E_CANCELLED',
      reason: 'emergency_stop',
    });
    assert.equal(stopped.broker!.state.posts, 0);
  } finally {
    stopped.state.allowed = true;
    await stopped.close();
  }
  // A stop that arrives after the broker approved (before the consume): approval_invalidated, nothing released, the row says not sent.
  const between = await heldFixture();
  try {
    between.broker!.grant('https://example.com');
    Object.defineProperty(between.state, 'allowed', { get: () => between.broker!.state.autoApproved === 0 });
    const error = await between.attempt();
    assert.equal(error.reason, 'approval_invalidated');
    assert.equal(safeError(error).page_script_ran, true);
    assert.deepEqual(between.state.released, []);
    assert.deepEqual(between.state.aborted, [['h1', 'invalidated']]);
    assert.deepEqual(rows(await between.engine.approvals(between.broker!.latest()!.request_id)), [
      ['invalidated', false],
    ]);
  } finally {
    await between.close();
  }
  // The page abandoned its requests meanwhile: the release fails, nothing was sent.
  const abandoned = await heldFixture();
  try {
    abandoned.broker!.grant('https://example.com');
    abandoned.state.releaseFails = true;
    const error = await abandoned.attempt();
    assert.equal(error.reason, 'approval_invalidated');
    assert.deepEqual(abandoned.state.released, []);
    assert.deepEqual(abandoned.state.aborted, [['h1', 'invalidated']]);
    const [row] = (await abandoned.engine.approvals(abandoned.broker!.latest()!.request_id)).requests;
    assert.deepEqual([row?.status, row?.sent, row?.granted], ['invalidated', false, 'site_writes']);
  } finally {
    await abandoned.close();
  }
  // The set was released but a request was refused at dispatch (guard, DNS): not sent, reported as such.
  const refused = await heldFixture();
  try {
    refused.broker!.grant('https://example.com');
    refused.state.outcome = { dispatched: 0, refused: 1 };
    const error = await refused.attempt();
    assert.equal(error.reason, 'approval_invalidated');
    assert.equal(safeError(error).page_script_ran, true);
    assert.equal(refused.state.released.length, 1);
    assert.equal((await refused.engine.approvals(refused.broker!.latest()!.request_id)).requests[0]?.sent, false);
  } finally {
    await refused.close();
  }
});

test('held writes: an expiry that passes between the grant and the consume sends nothing', async () => {
  const f = await heldFixture();
  const clock = Date.now;
  try {
    f.broker!.grant('https://example.com');
    // The broker consumed the approval in time; by the time the engine checks the expiry it has passed.
    Date.now = () => (f.broker!.state.consumes > 0 ? clock() + 121000 : clock());
    const error = await f.attempt();
    assert.equal(error.code, 'E_STALE_STATE');
    assert.equal(error.reason, 'approval_expired');
    assert.deepEqual(f.state.released, []);
    assert.deepEqual(f.state.aborted, [['h1', 'expired']]);
  } finally {
    Date.now = clock;
    await f.close();
  }
});

test('ask mode: a submission the broker approves by a site grant is reported with approved:true and the identical retry consumes it and dispatches', async () => {
  const f = await submissionFixture({ urlencoded: true });
  try {
    f.broker!.grant('https://example.com');
    const error = await f.attempt();
    const id = error.requestId!;
    assert.equal(error.reason, 'form_submission_requires_approval');
    const safe = safeError(error);
    assert.equal(safe.approved, true);
    assert.equal(safe.retryable, true);
    assert.equal(safe.revision, 2);
    assert.equal(safe.request_id, id);
    const entry = f.broker!.latest()!;
    assert.equal(entry.status, 'approved', 'approved at POST time, not consumed');
    assert.deepEqual(entry.summary.grant, GRANT);
    assert.equal(f.broker!.state.consumes, 0);
    assert.equal(f.state.acts, 1);
    // adl_approvals is optional: it reports the decision and who made it.
    const [row] = (await f.engine.approvals(id)).requests;
    assert.deepEqual([row?.status, row?.granted], ['approved', 'site_writes']);
    // The identical retry consumes it, once, and dispatches with the body-bound approval.
    const result = await f.engine.act(f.session.session_id, f.action, safe.revision!);
    assert.equal(result.ok, true);
    assert.equal(f.state.acts, 2);
    assert.equal(f.broker!.state.consumes, 1);
    assert.equal(f.state.authorizations[1]?.approved, true);
    assert.equal(f.state.authorizations[1]?.approvalProof, 'plain-submit-v1');
    const [ended] = (await f.engine.approvals(id)).requests;
    assert.deepEqual([ended?.status, ended?.granted], ['consumed', 'site_writes']);
    // The approval is spent: the same revision is not dispatched a second time.
    await assert.rejects(f.engine.act(f.session.session_id, f.action, safe.revision!));
    assert.equal(f.state.acts, 2);
    assert.equal(f.broker!.state.consumes, 1);
    assert.equal(f.broker!.state.posts, 1);
  } finally {
    await f.close();
  }
});

test('ask mode: a form without network facts (a GET form), a money-like submitter or action URL, and a label-gated click never carry the grant field', async () => {
  const get = await submissionFixture();
  try {
    get.broker!.grant('https://example.com');
    const error = await get.attempt();
    assert.equal(safeError(error).approved, undefined);
    assert.equal(get.broker!.latest()!.summary.grant, undefined, 'no urlencoded POST facts: asked every time');
    assert.equal(get.broker!.latest()!.status, 'pending');
  } finally {
    await get.close();
  }
  for (const options of [
    { labels: ['Save', '注文を確定'] },
    { labels: ['Place order'] },
    { networkUrl: 'https://example.com/checkout' },
    { networkUrl: 'https://example.com/save?action=purchase' },
  ]) {
    const f = await submissionFixture({ urlencoded: true, ...options });
    try {
      f.broker!.grant('https://example.com');
      const error = await f.attempt();
      assert.equal(safeError(error).approved, undefined, JSON.stringify(options));
      assert.equal(f.broker!.latest()!.summary.grant, undefined, JSON.stringify(options));
      assert.equal(f.broker!.latest()!.status, 'pending', JSON.stringify(options));
    } finally {
      await f.close();
    }
  }
  // A cross-origin form action is not a same-origin urlencoded POST: the adapter reports no network facts for it, and the grant names the page's origin only.
  const foreign = await submissionFixture({ urlencoded: true, networkUrl: 'https://other.example/save' });
  try {
    foreign.broker!.grant('https://example.com');
    await foreign.attempt();
    assert.equal(foreign.broker!.latest()!.summary.grant, undefined);
  } finally {
    await foreign.close();
  }
  // A click the label vocabulary gates is approved before dispatch, per action: never covered by a grant.
  const f = await heldFixture();
  try {
    f.broker!.grant('https://example.com');
    await assert.rejects(f.engine.act(f.session.session_id, f.other, 1), { code: 'E_APPROVAL_REQUIRED' });
    assert.equal(f.broker!.latest()!.summary.grant, undefined);
    assert.equal(f.broker!.latest()!.status, 'pending');
    assert.equal(f.state.acts, 0);
  } finally {
    await f.close();
  }
});

test('held writes: adl_execute continues past a step whose write a site grant released', async () => {
  const f = await heldFixture();
  try {
    f.broker!.grant('https://example.com');
    f.state.outcome = { response_status: 200 };
    const started = f.engine.execute(
      [
        { session_id: f.session.session_id, ...f.action },
        { session_id: f.session.session_id, ...f.action },
      ],
      { [f.session.session_id]: 1 },
    );
    let task = f.engine.task(started.task_id);
    for (; task.status === 'queued' || task.status === 'running'; task = f.engine.task(started.task_id))
      await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(task.status, 'completed', JSON.stringify(task));
    assert.deepEqual(
      task.results.map(r => r.status),
      ['completed', 'completed'],
    );
    assert.equal((task.results[0]!.approval as { granted?: string }).granted, 'site_writes');
    assert.equal(task.results[1]!.approval, undefined, 'the second step sent nothing');
    assert.equal(f.state.released.length, 1);
  } finally {
    await f.close();
  }
});

test('held writes: a pending request that the broker approves by a grant afterwards is released by the watcher and reported as granted', async () => {
  const f = await heldFixture();
  try {
    f.state.outcome = { response_status: 200 };
    const error = await f.attempt();
    const id = error.requestId!;
    assert.deepEqual(f.broker!.byId(id)!.summary.grant, GRANT);
    // The request was queued behind another modal; the human then granted the site on that one.
    const entry = f.broker!.byId(id)!;
    entry.status = 'approved';
    entry.granted = 'site_writes';
    await f.until(() => f.state.released.length === 1, 1200);
    assert.equal(f.broker!.state.consumes, 1);
    const [row] = (await f.engine.approvals(id)).requests;
    assert.deepEqual([row?.status, row?.sent, row?.granted], ['consumed', true, 'site_writes']);
  } finally {
    await f.close();
  }
  // A request that was never offered the grant (a credential) takes the broker's word for nothing: an ordinary approval, no granted row.
  const secret = await heldFixture({ requests: [heldRequest({ secret: true })] });
  try {
    secret.state.outcome = { response_status: 200 };
    const error = await secret.attempt();
    assert.equal(secret.broker!.byId(error.requestId!)!.summary.grant, undefined);
    const entry = secret.broker!.byId(error.requestId!)!;
    entry.status = 'approved';
    entry.granted = 'site_writes';
    await secret.until(() => secret.state.released.length === 1, 1200);
    const [row] = (await secret.engine.approvals(error.requestId)).requests;
    assert.deepEqual([row?.status, row?.sent, row?.granted], ['consumed', true, undefined]);
  } finally {
    await secret.close();
  }
});
