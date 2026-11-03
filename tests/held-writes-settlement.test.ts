// Settlement races of the held-write approval lifecycle (docs/V0_1_8_EVALUATION_DESIGN.md Part A).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core.js';
import { parsePolicy } from '../src/policy.js';
import {
  AdlError,
  HeldWritesError,
  type Action,
  type ActionAuthorization,
  type Adapter,
  type AdapterSession,
  type HeldWrite,
} from '../src/types.js';
import { stubBroker } from './approval-broker-stub.js';

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
    requests?: HeldWrite[];
    /** releaseHeldWrites waits for this before recording the release (models a slow browser). */
    releaseDelayMs?: number;
  } = {},
) {
  const broker = await stubBroker();
  const state = {
    version: 1,
    acts: 0,
    holdsLeft: 1,
    holdNumber: 0,
    requests: options.requests ?? [heldRequest()],
    alive: true,
    allowed: true,
    closes: 0,
    authorizations: [] as (ActionAuthorization | undefined)[],
    released: [] as [string, number][],
    aborted: [] as [string, string][],
    events: [] as string[],
    outcome: undefined as { response_status?: number } | undefined,
  };
  const adapter: Adapter = {
    open: async () => {
      const instance: AdapterSession = {
        tracksDispatch: true,
        setWriteHolding: () => {},
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
          risk: 'ordinary' as const,
          role: 'button',
          name: 'Save',
          origin: 'https://example.com',
        }),
        act: async (_action, _signal, dispatch, authorization) => {
          dispatch?.();
          state.acts++;
          state.authorizations.push(authorization);
          if (state.holdsLeft > 0 && authorization?.holdWrites) {
            state.holdsLeft--;
            throw new HeldWritesError({ id: `h${++state.holdNumber}`, requests: state.requests });
          }
        },
        releaseHeldWrites: async (holdId: string, expiresAt: number) => {
          if (options.releaseDelayMs) await new Promise(resolve => setTimeout(resolve, options.releaseDelayMs));
          state.released.push([holdId, expiresAt]);
          state.events.push('released');
        },
        abortHeldWrites: async (holdId: string, outcome: string) => {
          state.aborted.push([holdId, outcome]);
          state.events.push('aborted');
        },
        heldWritesAlive: () => state.alive,
        heldWriteOutcome: () => state.outcome,
        close: async () => {
          state.closes++;
          state.events.push('closed');
        },
      };
      return instance;
    },
    close: async () => {},
  };
  const policy = parsePolicy({
    operationMode: 'ask',
    allowedOrigins: ['https://example.com'],
    browserTargets: [{ id: 'fixture', label: 'Example', url: 'https://example.com', classification: 'PUBLIC' }],
  });
  const engine = new Engine(policy, { browser: adapter }, process.platform, () => state.allowed);
  const session = await engine.open((await engine.listTargets()).targets[0]!.target_id);
  const action: Action = { action: 'click', element_id: 'e1' };
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
    state,
    broker,
    attempt,
    until: async (condition: () => boolean, ms = 3000) => {
      for (const started = Date.now(); !condition(); await new Promise(resolve => setTimeout(resolve, 20)))
        if (Date.now() - started > ms) assert.fail('condition not reached in ' + ms + ' ms');
    },
    close: async () => {
      await engine.shutdown();
      await broker.close();
    },
  };
}

test('the identical action while a hold is being released is not dispatched again', async () => {
  const f = await heldFixture({ releaseDelayMs: 400 });
  try {
    const error = await f.attempt();
    const id = error.requestId!;
    f.broker.byId(id)!.status = 'approved';
    // A report learns of the approval and starts the release (consume + releaseHeldWrites in flight).
    const report = f.engine.approvals(id);
    await f.until(() => f.state.acts === 1 && f.broker.state.consumes === 1, 1000);
    // While that release is in flight the agent repeats the identical action.
    const again = await f.engine.act(f.session.session_id, f.action, 2).then(
      () => undefined,
      (e: unknown) => e,
    );
    await report;
    assert.equal(f.state.acts, 1, 'the action was dispatched again while its held write was being released');
    assert.ok(again instanceof AdlError);
    assert.equal(again.requestId, id, 'the identical action must return the same request id');
  } finally {
    await f.close();
  }
});

test('closing the session waits for a release in flight', async () => {
  const f = await heldFixture({ releaseDelayMs: 400 });
  try {
    const error = await f.attempt();
    const id = error.requestId!;
    f.broker.byId(id)!.status = 'approved';
    const report = f.engine.approvals(id);
    await f.until(() => f.broker.state.consumes === 1, 1000);
    await f.engine.close(f.session.session_id);
    assert.deepEqual(f.state.events, ['released', 'closed'], 'the adapter was closed before the release completed');
    await report;
  } finally {
    await f.close();
  }
});

test('two concurrent reports never release the same hold twice', async () => {
  const f = await heldFixture({ releaseDelayMs: 300 });
  try {
    const error = await f.attempt();
    const id = error.requestId!;
    f.broker.byId(id)!.status = 'approved';
    const reports = await Promise.all([f.engine.approvals(id), f.engine.approvals(id)]);
    const close = f.engine.close(f.session.session_id);
    await close;
    await Promise.all(reports);
    assert.equal(f.state.released.length + f.state.aborted.length, 1, 'more than one settlement touched the hold');
    assert.equal(f.state.released.length, 1);
  } finally {
    await f.close();
  }
});
