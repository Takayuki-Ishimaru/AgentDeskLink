import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdlError, safeError } from '../src/types.js';
import { saveAfterAction, saveAfterApproval } from '../src/save-state.js';

test('held fetch and blocked forms have distinct deterministic recovery after approval', () => {
  assert.deepEqual(safeError(new AdlError('E_APPROVAL_REQUIRED', 'request_requires_approval')).save, {
    state: 'approval_pending',
    next_step: 'wait_for_approval',
    retry_action: false,
  });
  assert.equal(
    safeError(new AdlError('E_APPROVAL_REQUIRED', 'form_submission_requires_approval', { approved: true })).save
      ?.next_step,
    'retry_same_action',
  );
  assert.equal(
    safeError(new AdlError('E_APPROVAL_REQUIRED', 'form_submission_requires_approval')).save?.retry_action,
    false,
  );
});

test('unsaved, sent and uncertain outcomes never invite replaying a dispatched action', () => {
  assert.equal(saveAfterAction(true).state, 'draft_unsaved');
  assert.equal(saveAfterAction(false).state, 'verification_required');
  assert.equal(saveAfterAction(false, true).state, 'submitted');
  assert.equal(saveAfterApproval('consumed', true).state, 'submitted');
  for (const status of ['denied', 'expired', 'invalidated', 'cancelled', 'consumed'])
    assert.equal(saveAfterApproval(status, false).retry_action, false);
  assert.equal(saveAfterApproval('approved', undefined).next_step, 'retry_same_action');
  assert.equal(safeError(new AdlError('E_CANCELLED')).save, undefined);
});
