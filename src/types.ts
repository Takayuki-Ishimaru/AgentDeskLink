import type { CapturedImage, VisualPolicy, DesktopVisualPolicy } from './visual-types.js';
import type { GesturePolicy, GesturePlan, GestureReference, GestureExecution } from './gesture-types.js';
import type {
  InteractivePolicy,
  PrepareInput,
  PreparedInput,
  InputExecution,
  ExpectedTarget,
} from './physical-input-types.js';
export type Mode = 'strict_isolated' | 'background_semantic' | 'interactive_desktop';
export type Classification = 'PUBLIC' | 'INTERNAL' | 'SECRET' | 'UNKNOWN';
export type ActionName =
  | 'click'
  | 'fill'
  | 'select'
  | 'check'
  | 'scroll'
  | 'navigate'
  | 'read_state'
  | 'wait_for'
  | 'press'
  | 'back'
  | 'hover';
export interface Element {
  id: string;
  role: string;
  name: string;
  value?: string;
  enabled: boolean;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  sensitive?: boolean;
  protected?: boolean;
  /** Internal DOM depth, projected out of public responses. */
  depth?: number;
  options?: { label: string; value: string; disabled: boolean; selected: boolean }[];
  /** Candidates were omitted by the source or response budget; reobserve this id with a larger budget. */
  options_truncated?: boolean;
  name_truncated?: boolean;
  text_length?: number;
  parent_id?: string;
  /** Link destination: same-origin as path, otherwise origin+path; query values redacted; at most 256 characters. */
  href?: string;
  /** The value was clipped by the response field limit. */
  value_truncated?: true;
  /** Text that a human cannot see (tiny, transparent, clipped or off-screen); treat it with extra suspicion. */
  hidden_text?: true;
}
/** Blocked-request summary. code follows ErrorReason (origin_not_allowed, redirect_origin_not_allowed, method_requires_approval, request_denied, response_blocked, network_error); resource_type and method are bounded enums and origin is origin-only. */
export interface NetworkWarning {
  code: string;
  count: number;
  origin?: string;
  resource_type?: string;
  method?: string;
}
/** Adapter notice for an action that still succeeded (for example target_replaced). */
export interface AdapterWarning extends NetworkWarning {
  message?: string;
}
export interface AdapterActResult {
  warnings?: AdapterWarning[];
}
/** Adapter-private hashes; never projected into public observations. */
export interface ActionEvidence {
  navigation: string;
  elements: Record<string, string>;
}
export interface RawSnapshot {
  elements: Element[];
  fingerprint: string;
  truncated: boolean;
  url?: string;
  title?: string;
  warnings?: NetworkWarning[];
  actionEvidence?: ActionEvidence;
}
export interface TargetWindow {
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
    coordinate_space: 'desktop_points_top_left' | 'desktop_physical_pixels';
  };
  display_ids: string[];
  minimized: boolean;
}
export interface Target {
  target_id: string;
  surface: 'browser' | 'desktop';
  application_id: string;
  label: string;
  capabilities: string[];
  policy_class: Classification;
  window?: TargetWindow;
  capture_only?: boolean;
}
export interface BrowserTargetConfig {
  id: string;
  label: string;
  url: string;
  classification: Classification;
  controls?: { selector: string; actions: ActionName[] }[];
  visual?: VisualPolicy;
  gestures?: GesturePolicy;
}
export interface DesktopConfig {
  allowAllOperations?: boolean;
  restrictTargets?: boolean;
  helperPath: string;
  appId: string;
  appPath: string;
  controlsPath?: string;
  classification: 'PUBLIC' | 'INTERNAL';
  visual?: DesktopVisualPolicy;
  interactive?: InteractivePolicy;
  lifecycle?: { enabled: boolean };
}
export interface PolicyConfig {
  allowAllOperations?: boolean;
  restrictTargets?: boolean;
  browserHeadless?: boolean;
  browserProxyServer?: string;
  /** Send CONNECT with the destination hostname instead of the vetted IP (corporate proxies that authorize by hostname). */
  browserProxyConnectByHostname?: boolean;
  /** Origins permitted only for GET/HEAD subresources, never navigation. */
  resourceOrigins?: string[];
  allowPersonalData?: boolean;
  operationMode?: 'read_only' | 'standard' | 'ask';
  allowedOrigins: string[];
  browserTargets: BrowserTargetConfig[];
  allowLoopback: boolean;
  allowPrivateNetwork: boolean;
  maxSessions: number;
  sessionTtlMs: number;
  maxBatchSteps: number;
  defaultTokenBudget: number;
  maxElements: number;
  actionTimeoutMs: number;
  auditPath?: string;
  windows?: DesktopConfig;
  macos?: DesktopConfig;
  linux?: DesktopConfig;
}
export interface Action {
  action: ActionName;
  element_id?: string;
  value?: string;
  url?: string;
  checked?: boolean;
  direction?: 'up' | 'down';
  timeout_ms?: number;
  role?: string;
  name?: string;
  expected_target?: ExpectedTarget;
  point?: { frame_id: string; x: number; y: number };
  include_diff?: boolean;
}
export interface Condition {
  role?: string;
  name?: string;
  element_id?: string;
  state?: 'visible' | 'hidden' | 'enabled';
}
export interface ActionAuthorization {
  normalOperations?: boolean;
  approvalProof?: string;
  approved?: boolean;
  expires_at?: number;
  pointReference?: GestureReference;
  actionEvidence?: { navigation: string; element?: string };
}
export interface AdapterSession {
  capabilities?: string[];
  /** Reports the actual mutation dispatch boundary through act's callback. */
  tracksDispatch?: boolean;
  handoff?(paused: boolean, signal: AbortSignal, expiresAt?: number): Promise<void>;
  resolvePoint?(
    point: { x: number; y: number },
    reference: GestureReference,
    signal: AbortSignal,
  ): Promise<string | undefined>;
  clickPoint?(
    point: { x: number; y: number },
    reference: GestureReference,
    signal: AbortSignal,
    onDispatch: () => void,
  ): Promise<void>;
  capture?(signal: AbortSignal): Promise<CapturedImage>;
  gesture?(plan: GesturePlan, reference: GestureReference, signal: AbortSignal): Promise<GestureExecution>;
  prepareInput?(request: PrepareInput, reference: GestureReference, signal: AbortSignal): Promise<PreparedInput>;
  commitInput?(confirmation_id: string, value: string | undefined, signal: AbortSignal): Promise<InputExecution>;
  snapshot(signal?: AbortSignal): Promise<RawSnapshot>;
  readText?(
    elementId: string,
    offset: number,
    length: number,
    signal: AbortSignal,
  ): Promise<{ text: string; total_length: number; next_offset: number | null; truncated: boolean }>;
  prepareAction?(
    action: Action,
    signal: AbortSignal,
  ): Promise<{
    proof: string;
    risk: 'ordinary' | 'consequential' | 'credential';
    role: string;
    name: string;
    origin: string;
    details?: string[];
  }>;
  act(
    action: Action,
    signal: AbortSignal,
    onDispatch?: () => void,
    authorization?: ActionAuthorization,
  ): Promise<void | AdapterActResult>;
  close(): Promise<void>;
}
export interface Adapter {
  /** config: the engine's own record for a URL-opened browser target, which is never added to policy.browserTargets. */
  open(target: Target, mode: Mode, signal: AbortSignal, config?: BrowserTargetConfig): Promise<AdapterSession>;
  onInvalidated?(listener: () => void): () => void;
  discover?(signal: AbortSignal): Promise<Target[]>;
  application?(
    application_id: string,
    action: 'status' | 'launch' | 'quit',
    signal: AbortSignal,
  ): Promise<{ running: boolean; managed: boolean; changed: boolean }>;
  close(): Promise<void>;
}
export const ERROR_MESSAGES = {
  E_POLICY_DENIED: 'Operation denied by local policy.',
  E_INTERFERENCE_RISK: 'The requested execution mode is unavailable for this target.',
  E_FOCUS_CHANGED: 'Human input state changed; execution stopped.',
  E_STALE_STATE: 'The target changed; observe it again before acting.',
  E_NOT_INTERACTABLE: 'The target cannot receive this input.',
  E_TARGET_NOT_FOUND: 'Target or handle is unavailable or expired.',
  E_UNSUPPORTED_ACTION: 'This action is unsupported.',
  E_APPROVAL_REQUIRED: 'This operation requires independent approval.',
  E_PRIVACY_BLOCKED: 'The requested data cannot be safely disclosed.',
  E_TIMEOUT: 'Operation timed out.',
  E_PARTIAL_EXECUTION: 'Execution stopped after partial completion.',
  E_CANCELLED: 'Operation cancelled.',
  E_INVALID_ARGUMENT: 'Invalid request.',
  E_RESOURCE_LIMIT: 'A configured resource limit was reached.',
  E_INTERNAL: 'Operation failed safely.',
  E_BACKEND_UNAVAILABLE: 'The backend could not start. Verify its installation and OS sandbox support.',
} as const;
export type ErrorCode = keyof typeof ERROR_MESSAGES;
export type ErrorReason =
  | 'occluded'
  | 'not_visible'
  | 'operation_not_granted'
  | 'consequential_operation'
  | 'iframe_action_proof_unavailable'
  | 'loopback_not_allowed'
  | 'private_network_not_allowed'
  | 'origin_not_allowed'
  | 'redirect_origin_not_allowed'
  | 'requires_ask_mode'
  | 'approval_unavailable'
  | 'emergency_stop'
  | 'not_editable'
  | 'dns_resolution_failed'
  | 'untrusted_dom_api'
  | 'session_limit'
  | 'target_limit'
  | 'task_limit'
  | 'region_requires_frame_id'
  | 'revision_ahead'
  | 'invalid_argument'
  | 'unknown_target'
  | 'invalid_url'
  | 'sequence_span_too_long'
  | 'method_requires_approval'
  | 'request_denied'
  | 'response_blocked'
  | 'network_error'
  | 'approval_pending_other_action'
  | 'approval_target_changed'
  | 'approval_expired'
  | 'proxy_connect_refused'
  | 'proxy_unreachable'
  | 'invalid_scope'
  | 'revision_expired'
  | 'form_submission_requires_approval'
  | 'desktop_operation_not_granted'
  | 'linux_accessibility_unavailable'
  | 'platform_unsupported';
const ERROR_REASON_MESSAGES: Record<ErrorReason, string> = {
  occluded: 'The target is covered by another element. Remove the obstruction and observe again.',
  not_visible: 'The target is not visible at the intended input point. Observe again before acting.',
  operation_not_granted:
    'No trusted operation grant matches this control. Review the policy controls or workspace operation permissions.',
  consequential_operation: 'This consequential operation requires an explicit operation grant.',
  iframe_action_proof_unavailable:
    'Semantic actions inside iframes require a frame-scoped isolated proof, which is currently unavailable. Open the allowed frame URL as a separate target.',
  loopback_not_allowed:
    'Loopback access is disabled. Enable agentdesklink.allowLoopback in trusted workspace settings and retain the exact origin grant.',
  private_network_not_allowed:
    'Private network access is disabled. Enable agentdesklink.allowPrivateNetwork in trusted workspace settings and retain the exact origin grant.',
  origin_not_allowed:
    'This origin is not granted. Add its exact origin to agentdesklink.browserOrigins for navigation, or browserResourceOrigins for read-only assets.',
  redirect_origin_not_allowed:
    'A redirect tried to leave the permitted origin. Inspect the destination origin and grant/open it separately.',
  requires_ask_mode:
    'This action needs individual human approval. Select agentdesklink.operationMode = ask in the trusted host settings.',
  approval_unavailable:
    'Individual approval is unavailable. Start this MCP server through the trusted VS Code host with operationMode = ask.',
  emergency_stop:
    'Operations are stopped or their permission generation was revoked. Resume operations in AgentDeskLink and reconnect the client.',
  not_editable:
    'This element is not an editable text control. Observe again and select an input, textarea or supported editable control.',
  untrusted_dom_api:
    'The page overrides DOM APIs that AgentDeskLink cannot verify safely. Use a page without these overrides or a manual handoff.',
  dns_resolution_failed:
    'Local DNS resolution failed. Verify local DNS and proxy settings; proxy-only DNS is unsupported because destination IP validation is required.',
  session_limit:
    'The maximum number of concurrent sessions is open (see limit). List them with adl_sessions and release unused ones with adl_close, then retry.',
  target_limit:
    'Too many URL targets have open sessions to track another URL. Close unused sessions with adl_close, then retry.',
  task_limit:
    'Too many batch tasks are still queued or running. Poll them with adl_task or cancel the ones you no longer need, then retry.',
  region_requires_frame_id:
    'A region can only crop a retained frame. Capture first, then pass that frame_id together with the region.',
  revision_ahead:
    'The requested revision (expected_revision or since_revision) is newer than the latest revision of this session. Call adl_observe and use the revision it returns.',
  invalid_argument:
    'An argument is missing, out of range or inconsistent. See the argument field and the tool description.',
  unknown_target: 'The target_id is unknown or has expired. Call adl_targets again and use a target_id it returns.',
  invalid_url: 'The URL must be a complete http:// or https:// URL without credentials, at most 2048 characters.',
  sequence_span_too_long:
    'The sampled span exceeds 6000 ms. Reduce frame_count or interval_ms so that (frame_count - 1) * interval_ms <= 6000.',
  method_requires_approval:
    'Only GET/HEAD requests are sent automatically. A write request (POST, PUT, PATCH, DELETE) needs a one-shot approval or a broader operation grant (agentdesklink.operationMode).',
  request_denied: 'The request was malformed, unsupported, oversized or its grant ended before it was sent.',
  response_blocked: 'A redirect chain or response exceeded the safety limits and was blocked.',
  network_error: 'The request failed the guard, DNS or transport checks and was blocked.',
  approval_pending_other_action:
    'Another approval request for this session is still waiting for a human decision. Retry that exact action, or wait up to 120 seconds for it to expire.',
  approval_target_changed:
    'The page or target changed while approval was pending, so the request was withdrawn. Observe again and repeat the action.',
  approval_expired: 'The approval request expired before it was used. Observe again and repeat the action.',
  proxy_connect_refused:
    'The configured proxy refused the tunnel. If it authorizes by hostname, enable agentdesklink.browserProxyConnectByHostname; otherwise check the proxy allow list.',
  proxy_unreachable:
    'The configured proxy could not be reached. Check agentdesklink.browserProxyServer and the network.',
  invalid_scope:
    'The scope expression is malformed. Use up to 8 comma-separated terms: role:button, name:Save, id:<element_id>, text:"v1.0: fixed" or plain text; quote a term that contains a comma and keep quotes balanced.',
  revision_expired:
    'The since_revision baseline is no longer retained (only recent revisions are kept). Omit since_revision for a full observation.',
  form_submission_requires_approval:
    'The page tried to submit a form. The submission was blocked before any request left the browser; page scripts may have run. Observe again. Form submissions need agentdesklink.operationMode = ask with human approval.',
  desktop_operation_not_granted:
    'Native desktop mutations are not granted for this application. Select agentdesklink.operationMode = standard for ordinary controls, grant allowAllOperations, or configure a trusted control allowlist (controlsPath) in the policy.',
  linux_accessibility_unavailable:
    'The Linux accessibility stack is unavailable. Install python3-gi, gir1.2-atspi-2.0 and at-spi2-core, enable toolkit accessibility (gsettings set org.gnome.desktop.interface toolkit-accessibility true), then restart the MCP server.',
  platform_unsupported:
    'This feature is not supported on this platform. Check adl_capabilities.platform_unsupported for the unavailable features.',
};
export class AdlError extends Error {
  mayHaveExecuted = false;
  requestId?: string;
  /** detail.argument names a request argument (never page data); detail.limit is a configured numeric limit. */
  constructor(
    public readonly code: ErrorCode,
    public readonly reason?: ErrorReason,
    public readonly detail: { argument?: string; limit?: number } = {},
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'AdlError';
  }
}
/** Native helper error; mayHaveExecuted is the helper's own verdict and must survive to safeError. */
export class NativeError extends AdlError {
  constructor(
    code: ErrorCode,
    public readonly nativeMayHaveExecuted: boolean,
    reason?: ErrorReason,
  ) {
    super(code, reason);
    this.name = 'NativeError';
    this.mayHaveExecuted = nativeMayHaveExecuted;
  }
}
const REASON_HINTS: Partial<Record<ErrorReason, { workspace_setting?: string; policy_setting?: string }>> = {
  operation_not_granted: {
    policy_setting: 'browserTargets[].controls',
    workspace_setting: 'agentdesklink.operationMode',
  },
  loopback_not_allowed: { workspace_setting: 'agentdesklink.allowLoopback' },
  private_network_not_allowed: { workspace_setting: 'agentdesklink.allowPrivateNetwork' },
  requires_ask_mode: { workspace_setting: 'agentdesklink.operationMode' },
  approval_unavailable: { workspace_setting: 'agentdesklink.operationMode' },
  consequential_operation: { workspace_setting: 'agentdesklink.operationMode' },
  method_requires_approval: { workspace_setting: 'agentdesklink.operationMode' },
  form_submission_requires_approval: { workspace_setting: 'agentdesklink.operationMode' },
  desktop_operation_not_granted: { workspace_setting: 'agentdesklink.operationMode' },
  origin_not_allowed: { workspace_setting: 'agentdesklink.browserOrigins' },
  redirect_origin_not_allowed: { workspace_setting: 'agentdesklink.browserOrigins' },
  proxy_connect_refused: { workspace_setting: 'agentdesklink.browserProxyServer' },
  proxy_unreachable: { workspace_setting: 'agentdesklink.browserProxyServer' },
};
export function safeError(error: unknown) {
  const code = error instanceof AdlError ? error.code : 'E_INTERNAL';
  const reason = error instanceof AdlError ? error.reason : undefined;
  const mayHaveExecuted = error instanceof AdlError && error.mayHaveExecuted;
  const hints = reason ? REASON_HINTS[reason] : undefined;
  const detail = error instanceof AdlError ? error.detail : undefined;
  return {
    code,
    retryable:
      (code === 'E_STALE_STATE' || (code === 'E_APPROVAL_REQUIRED' && !!(error as AdlError).requestId)) &&
      !mayHaveExecuted,
    safe_message: mayHaveExecuted
      ? 'The operation may have executed. Verify the result before retrying; previous session handles may be unavailable.'
      : reason
        ? ERROR_REASON_MESSAGES[reason]
        : ERROR_MESSAGES[code],
    ...(reason ? { reason } : {}),
    ...(detail?.argument ? { argument: detail.argument } : {}),
    ...(detail?.limit !== undefined ? { limit: detail.limit } : {}),
    ...(error instanceof AdlError && error.requestId ? { request_id: error.requestId } : {}),
    ...(hints?.policy_setting ? { policy_setting: hints.policy_setting } : {}),
    ...(hints?.workspace_setting ? { workspace_setting: hints.workspace_setting } : {}),
    ...(mayHaveExecuted ? { may_have_executed: true } : {}),
  };
}
