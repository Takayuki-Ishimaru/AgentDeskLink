import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StartupDiagnostics } from '../src/startup-diagnostics.js';
import { parsePolicy } from '../src/policy.js';

test('startup diagnostics record first-attempt success and stage failures without a hidden retry', () => {
  const d = new StartupDiagnostics();
  const first = d.start();
  first.stage('browser_launch');
  first.finish(false);
  first.finish(true);
  const second = d.start();
  second.stage('page_creation');
  second.finish(true);
  assert.equal(d.snapshot().attempts, 2);
  assert.equal(d.snapshot().successful, 1);
  assert.equal(d.snapshot().failed, 1);
  assert.equal(d.snapshot().first_attempt_succeeded, false);
  assert.equal(d.snapshot().last?.outcome, 'succeeded');
  assert.equal(typeof d.snapshot().last?.stages_ms.page_creation, 'number');
});

test('concurrent attempts count only finished failures and preserve the first started attempt', () => {
  const d = new StartupDiagnostics(),
    a = d.start(),
    b = d.start();
  assert.equal(d.snapshot().failed, 0);
  assert.equal(d.snapshot().running, 2);
  b.finish(true);
  assert.equal(d.snapshot().first_attempt_succeeded, undefined);
  a.finish(false);
  assert.equal(d.snapshot().first_attempt_succeeded, false);
  assert.equal(d.snapshot().failed, 1);
});

test('cold startup has a separate default deadline and explicit deadlines remain effective', () => {
  assert.equal(parsePolicy({}).startupTimeoutMs, 30000);
  assert.equal(parsePolicy({ actionTimeoutMs: 1200 }).startupTimeoutMs, 1200);
  assert.equal(parsePolicy({ actionTimeoutMs: 1200, startupTimeoutMs: 25000 }).startupTimeoutMs, 25000);
});
