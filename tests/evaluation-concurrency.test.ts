import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/core.js';
import { parsePolicy } from '../src/policy.js';
import type { Adapter } from '../src/types.js';

test('an independent session can observe during another session wait and cancellation keeps it usable', async () => {
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => (entered = resolve));
  let reads = 0;
  const adapter: Adapter = {
    open: async () => {
      const own = ++reads;
      let snapshots = 0;
      return {
        snapshot: async () => {
          if (own === 1 && ++snapshots > 1) entered();
          return {
            elements: [{ id: 'e', role: 'status', name: 'Ready', enabled: true }],
            fingerprint: 'same',
            truncated: false,
          };
        },
        act: async () => {},
        close: async () => {},
      };
    },
    close: async () => {},
  };
  const engine = new Engine(
    parsePolicy({
      browserTargets: [{ id: 'fixture', label: 'Fixture', url: 'https://example.com', classification: 'PUBLIC' }],
    }),
    { browser: adapter },
  );
  try {
    const id = (await engine.listTargets()).targets[0]!.target_id;
    const a = await engine.open(id),
      b = await engine.open(id),
      cancel = new AbortController();
    const wait = engine.wait(a.session_id, { name: 'never' }, 5000, cancel.signal);
    const rejection = assert.rejects(wait, { code: 'E_CANCELLED' });
    await waiting;
    const result = await Promise.race([engine.observe(b.session_id), delay(500).then(() => null)]);
    cancel.abort();
    await rejection;
    assert.ok(result, 'independent observe was held behind another session wait');
    assert.equal((await engine.observe(b.session_id)).ok, true);
    await assert.rejects(engine.observe(a.session_id), { code: 'E_TARGET_NOT_FOUND' });
  } finally {
    await engine.shutdown();
  }
});

test('native session workflows and discovery share exclusion while a browser remains independent', async () => {
  let active = 0,
    overlap = false,
    hold = false,
    entered!: () => void,
    release!: () => void;
  const began = new Promise<void>(r => (entered = r)),
    gate = new Promise<void>(r => (release = r));
  const shared = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (++active > 1) overlap = true;
    try {
      return await fn();
    } finally {
      active--;
    }
  };
  const desktop: Adapter = {
    discover: async () =>
      shared(async () => [
        {
          target_id: 't_native',
          surface: 'desktop',
          application_id: 'fixture',
          label: 'Fixture',
          policy_class: 'PUBLIC',
          capabilities: ['observe', 'click'],
        },
      ]),
    open: async () => {
      let revision = 0;
      return {
        snapshot: async () =>
          shared(async () => ({
            elements: [{ id: 'e', role: 'button', name: 'Find', enabled: true }],
            fingerprint: String(revision),
            truncated: false,
          })),
        act: async () =>
          shared(async () => {
            if (hold) {
              entered();
              await gate;
            }
            revision++;
          }),
        close: async () => {},
      };
    },
    close: async () => {},
  };
  const browser: Adapter = {
    open: async () => ({
      snapshot: async () => ({ elements: [], fingerprint: 'same', truncated: false }),
      act: async () => {},
      close: async () => {},
    }),
    close: async () => {},
  };
  const engine = new Engine(
    parsePolicy({
      allowAllOperations: true,
      actionTimeoutMs: 3000,
      browserTargets: [{ id: 'browser', label: 'Browser', url: 'https://example.com', classification: 'PUBLIC' }],
      windows: {
        helperPath: '/helper',
        appId: 'fixture',
        appPath: '/fixture',
        classification: 'PUBLIC',
        allowAllOperations: true,
      },
    }),
    { browser, desktop },
    'win32',
  );
  try {
    await engine.listTargets();
    const a = await engine.open('t_native', 'background_semantic'),
      b = await engine.open('t_native', 'background_semantic');
    const web = await engine.open((await engine.listTargets('browser')).targets[0]!.target_id);
    hold = true;
    const first = engine.act(a.session_id, { action: 'click', element_id: 'e1' }, 1);
    await began;
    const second = engine.act(b.session_id, { action: 'click', element_id: 'e1' }, 1),
      discover = engine.listTargets('desktop');
    const observed = await Promise.race([engine.observe(web.session_id), delay(500).then(() => null)]);
    release();
    await Promise.all([first, second, discover]);
    assert.ok(observed, 'browser was blocked behind native work');
    assert.equal(overlap, false, 'shared native resource calls overlapped');
  } finally {
    release();
    await engine.shutdown();
  }
});

test('expiry waits for an active session workflow before closing its adapter', async () => {
  let acting = false,
    closedDuringAction = false,
    entered!: () => void,
    release!: () => void;
  const began = new Promise<void>(r => (entered = r)),
    gate = new Promise<void>(r => (release = r));
  const adapter: Adapter = {
    open: async () => ({
      snapshot: async () => ({
        elements: [{ id: 'e', role: 'button', name: 'Find', enabled: true }],
        fingerprint: 'same',
        truncated: false,
      }),
      act: async () => {
        acting = true;
        entered();
        await gate;
        acting = false;
      },
      close: async () => {
        if (acting) closedDuringAction = true;
      },
    }),
    close: async () => {},
  };
  const engine = new Engine(
    parsePolicy({
      sessionTtlMs: 1000,
      actionTimeoutMs: 3000,
      browserTargets: [{ id: 'fixture', label: 'Fixture', url: 'https://example.com', classification: 'PUBLIC' }],
    }),
    { browser: adapter },
  );
  try {
    const s = await engine.open((await engine.listTargets()).targets[0]!.target_id);
    const action = engine.act(s.session_id, { action: 'click', element_id: 'e1' }, 1);
    await began;
    await delay(1150);
    release();
    await action;
    assert.equal(closedDuringAction, false);
    await assert.rejects(engine.observe(s.session_id), { code: 'E_TARGET_NOT_FOUND' });
  } finally {
    release();
    await engine.shutdown();
  }
});
