export type SaveState = {
  state: 'draft_unsaved' | 'approval_pending' | 'submitted' | 'verification_required';
  /** explicit_save asks the caller to use the page's Save control in a new action. */
  next_step: 'wait_for_approval' | 'retry_same_action' | 'observe' | 'change_mode' | 'explicit_save';
  retry_action: boolean;
};

/** A dispatched request is not proof that the application persisted it. Always observe the result. */
export function saveAfterAction(writeBlocked: boolean, sent = false): SaveState {
  return writeBlocked
    ? { state: 'draft_unsaved', next_step: 'change_mode', retry_action: false }
    : { state: sent ? 'submitted' : 'verification_required', next_step: 'observe', retry_action: false };
}

export function saveAfterError(reason?: string, approved = false): SaveState | undefined {
  if (reason === 'request_requires_approval')
    return { state: 'approval_pending', next_step: 'wait_for_approval', retry_action: false };
  if (reason === 'form_submission_requires_approval')
    return {
      state: 'approval_pending',
      next_step: approved ? 'retry_same_action' : 'wait_for_approval',
      retry_action: approved,
    };
  if (reason === 'background_write_blocked')
    return { state: 'draft_unsaved', next_step: 'explicit_save', retry_action: false };
  if (reason === 'method_requires_approval')
    return { state: 'draft_unsaved', next_step: 'change_mode', retry_action: false };
  return undefined;
}

export function saveAfterApproval(status: string, sent: boolean | undefined): SaveState {
  if (status === 'pending') return { state: 'approval_pending', next_step: 'wait_for_approval', retry_action: false };
  if (sent === true) return { state: 'submitted', next_step: 'observe', retry_action: false };
  if (status === 'approved' && sent === undefined)
    return { state: 'approval_pending', next_step: 'retry_same_action', retry_action: true };
  return { state: 'verification_required', next_step: 'observe', retry_action: false };
}
