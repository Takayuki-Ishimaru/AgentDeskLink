import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine } from '../src/core.js';
import { parsePolicy } from '../src/policy.js';

test('isolated compatibility refuses manual handoff before approval or adapter dispatch', async () => {
  const policy = parsePolicy({
    allowAllOperations: true,
    browserHeadless: false,
    allowedOrigins: ['https://example.com'],
    browserTargets: [{ id: 'test', label: 'Test', url: 'https://example.com', classification: 'PUBLIC' }],
  });
  let calls = 0;
  const engine = new Engine(policy, {
    browser: {
      open: async () => ({
        snapshot: async () => ({ elements: [], fingerprint: 'readonly', truncated: false, read_only: true as const }),
        act: async () => {},
        handoff: async () => {
          calls++;
        },
        close: async () => {},
      }),
      close: async () => {},
    },
  });
  try {
    const opened = await engine.open((await engine.listTargets()).targets[0]!.target_id);
    await assert.rejects(engine.handoff(opened.session_id, 'pause'), { reason: 'isolated_read_only' });
    assert.equal(calls, 0);
    assert.equal((await engine.observe(opened.session_id)).read_only, true);
  } finally {
    await engine.shutdown();
  }
});

test('open and text observations report isolated read-only capability', async () => {
  const policy = parsePolicy({
    allowedOrigins: ['https://example.com'],
    browserTargets: [{ id: 'test', label: 'Test', url: 'https://example.com', classification: 'PUBLIC' }],
  });
  const engine = new Engine(policy, {
    browser: {
      open: async () => ({
        capabilities: ['observe', 'navigate'],
        snapshot: async () => ({
          elements: [{ id: 'raw', role: 'region', name: 'Body', enabled: true }],
          fingerprint: 'one',
          truncated: false,
          read_only: true as const,
        }),
        readText: async () => ({ text: 'safe', total_length: 4, next_offset: null, truncated: false }),
        act: async () => {},
        close: async () => {},
      }),
      close: async () => {},
    },
  });
  try {
    const target = (await engine.listTargets()).targets[0]!;
    const opened = await engine.open(target.target_id);
    assert.equal(opened.read_only, true);
    assert.deepEqual(opened.capabilities, ['observe', 'navigate']);
    const observed = await engine.observe(opened.session_id);
    assert.equal(observed.read_only, true);
    const text = await engine.observe(opened.session_id, { text: { element_id: observed.elements![0]!.id } });
    assert.equal(text.read_only, true);
    assert.equal(text.text?.content, 'safe');
  } finally {
    await engine.shutdown();
  }
});
