import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { Engine } from '../src/core.js';
import { parsePolicy } from '../src/policy.js';
import { AdlError, safeError, type Action, type ActionAuthorization, type Adapter } from '../src/types.js';
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
async function submissionFixture(options: { broker?: boolean } = {}) {
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
