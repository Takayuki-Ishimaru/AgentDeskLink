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
/** DOM acquisition stays below the privacy ancestor bound (128). */
export const MAX_DOM_DEPTH = 64;
export type SnapshotSourceLimit = 'depth_limit' | 'visit_limit' | 'element_limit' | 'frame_limit' | 'frame_unavailable';
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
  /** Internal context-based personal-data label, independently controlled by allowPersonalData. */
  personal?: boolean;
  protected?: boolean;
  /** Internal DOM depth, projected out of public responses. */
  depth?: number;
  /**
   * Internal full shape, used by adapters, the snapshot store and delta comparison. Responses carry the lean public
   * shape `{ label, value?, disabled?: true, selected?: true }`: value only when it differs from label, flags only when true.
   */
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
  /** Concealed prose was omitted. Accessible control names remain untrusted UI data. */
  hidden_text?: true;
  /** Range bounds of a slider or spinbutton (input min/max/step, or aria-valuemin/aria-valuemax); each is omitted when the page declares none. */
  min?: number;
  max?: number;
  /** Step of a native range/number input; the keyword "any" is kept as is. */
  step?: number | 'any';
}
/** Blocked-request summary. code follows ErrorReason (method_requires_approval | request_not_approvable | background_write_blocked | approval_pending_other_action | approval_unavailable | approval_denied | approval_expired | approval_invalidated | contained_request_blocked | form_submission_requires_approval | origin_not_allowed | redirect_origin_not_allowed | request_denied | response_blocked | network_error); resource_type and method are bounded enums and origin is origin-only. A warning whose method is a write method means the page's state was not saved. */
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
  /** Network blocks recorded between this action's dispatch and the end of its window; the engine reports exactly these (other adapters: count diff of the snapshot warnings). */
  blocks?: NetworkWarning[];
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
  /** The browser session can only read and navigate through an isolated realm. */
  read_only?: true;
  /** Source data omitted before response pagination; a cursor cannot recover it. */
  source_limits?: SnapshotSourceLimit[];
  url?: string;
  title?: string;
  warnings?: NetworkWarning[];
  /** Monotonic sequence number of the latest recorded block; acknowledgeWarnings(upToSeq) marks the blocks up to it as reported. */
  warningSeq?: number;
  actionEvidence?: ActionEvidence;
  /** Main-frame document response status of the latest navigation; set only when it is 400 or higher. */
  http_status?: number;
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
  /** Permitted gesture surface ids and their kinds when gestures are allowed for this target; selectors are never reported. */
  gesture_surfaces?: { id: string; kinds: string[] }[];
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
  /** Normalized labels (see normalizeLabel) the trusted workspace declares harmless: they clear label-derived risk only. */
  /** Origins of targets that may not be opened (SECRET, UNKNOWN): a redirect never reaches them. */
  hiddenTargetOrigins?: string[];
  consequentialAllowLabels?: string[];
  /** Normalized labels the trusted workspace always treats as consequential. Deny beats allow. */
  consequentialDenyLabels?: string[];
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
  /** Ask mode with an approver: a main-frame fetch/XHR write the page sends during this action is held unsent (HeldWritesError) instead of blocked. */
  holdWrites?: boolean;
}
/** Why held writes are aborted: the human decision or lifecycle that ended the approval ('denied', 'expired', 'invalidated'), or 'not_approvable' when the engine cannot describe the set to a human. They block the page's requests with approval_denied / approval_expired / approval_invalidated / request_not_approvable. */
export type HeldWriteAbortOutcome = 'denied' | 'expired' | 'invalidated' | 'not_approvable';
/** The scope of a standing site grant (ask mode, VS Code approval modal, third choice): later eligible page writes to `origin` by this AI server are approved without a dialog for a limited time. Only the host broker creates one. */
export interface SiteWriteGrant {
  scope: 'site_writes';
  origin: string;
}
/** How a write approval was decided when no human answered it individually. */
export type ApprovalGrantedBy = 'site_writes';
/** The approval a standing site grant released inside the same action: the request is consumed and already sent. */
export interface GrantedApprovalResult {
  request_id: string;
  status: 'consumed';
  sent: true;
  granted: ApprovalGrantedBy;
  response_status?: number;
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
  ): Promise<{
    text: string;
    total_length: number;
    next_offset: number | null;
    truncated: boolean;
    /** Text a human cannot see was left out of the read. */
    hidden_text?: true;
  }>;
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
    /** Supplemental visible page context captured before dispatch, not request identity. */
    context?: { kind: 'row' | 'listitem' | 'dialog' | 'form'; text: string };
    /** Consequential only because it submits a form; ask mode dispatches it under the adapter's submission guard (risk is then 'ordinary'). */
    submission?: 'plain';
    network?: { url: string; method: string; body: string };
    /** Every label the activation can carry (the control, its form's submitter, its dialog): the engine checks them for money-like words before it offers a standing site grant. */
    labels?: string[];
  }>;
  act(
    action: Action,
    signal: AbortSignal,
    onDispatch?: () => void,
    authorization?: ActionAuthorization,
  ): Promise<void | AdapterActResult>;
  /** Enables holding of page writes during authorized actions (engine: operationMode ask with an approver). */
  setWriteHolding?(enabled: boolean): void;
  /** Sends the held requests of holdId exactly as paused; expiresAt is the approval's expiry, re-checked at dispatch. Throws E_STALE_STATE when holdId is not the pending set. */
  releaseHeldWrites?(holdId: string, expiresAt: number): Promise<void>;
  /** Aborts the held requests of holdId; unknown ids are a no-op. */
  abortHeldWrites?(holdId: string, outcome: HeldWriteAbortOutcome): Promise<void>;
  /** False once the page abandoned every held request (timeout, navigation) or the set is gone. */
  heldWritesAlive?(holdId: string): boolean;
  /**
   * How a released set ended, once every request of it is done with the network route (undefined before that): `dispatched` counts the
   * requests that reached the network fetch, `refused` those that were stopped before it (guard, DNS, expiry re-check), and
   * `response_status` is the highest status answered. Adapters that cannot tell omit dispatched / refused (all counted as sent).
   */
  heldWriteOutcome?(holdId: string): { dispatched?: number; refused?: number; response_status?: number } | undefined;
  /** Marks the blocks recorded up to RawSnapshot.warningSeq as reported. */
  acknowledgeWarnings?(upToSeq: number): void;
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
  | 'approval_denied'
  | 'approval_invalidated'
  | 'read_only_mode'
  | 'proxy_connect_refused'
  | 'proxy_unreachable'
  | 'invalid_scope'
  | 'scope_element_not_found'
  | 'scope_within_unsupported'
  | 'not_scrollable'
  | 'revision_expired'
  | 'form_submission_requires_approval'
  | 'desktop_operation_not_granted'
  | 'linux_accessibility_unavailable'
  | 'desktop_focus_changed'
  | 'platform_unsupported'
  | 'capture_not_enabled'
  | 'browser_sandbox_unavailable'
  | 'request_requires_approval'
  | 'request_not_approvable'
  | 'background_write_blocked'
  | 'contained_request_blocked'
  | 'tls_handshake_failed'
  | 'transport_failure'
  | 'gesture_surface_not_found'
  | 'gesture_kind_not_allowed'
  | 'gesture_disabled'
  | 'isolated_read_only';
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
    'This origin is not granted. Add its exact origin to agentdesklink.browserOrigins for navigation, or browserResourceOrigins for read-only assets. CLI policy file: add the exact origin to allowedOrigins and configure browserTargets to list a target in adl_targets; a browserTargets entry alone does not grant the origin.',
  redirect_origin_not_allowed:
    'A redirect tried to leave for an origin that is not granted, or as something other than a document read. Inspect the destination origin; a page redirected to a granted origin follows it. CLI policy file: grant the destination origin in allowedOrigins; a browserTargets entry alone does not grant it.',
  requires_ask_mode:
    'This action is classified as consequential (its label, link destination or dialog), or it sent a write request. It needs individual human approval: select agentdesklink.operationMode = ask (the control is then dispatched and the human approves the click or the exact request), or list a label that is known to be harmless in this workspace in agentdesklink.consequentialAllowLabels.',
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
    'A write request (POST, PUT, PATCH or DELETE) the page sent during this action was blocked before it left: what the screen shows was not saved. In ask mode (agentdesklink.operationMode = ask, started from the VS Code host) the same request is held inside the browser and shown to a human for approval.',
  request_denied: 'The request was malformed, unsupported, oversized or its grant ended before it was sent.',
  response_blocked: 'A redirect chain or response exceeded the safety limits and was blocked.',
  network_error: 'The request failed the guard, DNS or transport checks and was blocked.',
  approval_pending_other_action:
    'Another approval request for this session is still waiting for a human decision. Retry that exact action, or wait up to 120 seconds for it to expire.',
  approval_target_changed:
    'The page or target changed while approval was pending, so the request was withdrawn. Observe again and repeat the action.',
  approval_expired: 'The approval request expired before it was used. Observe again and repeat the action.',
  approval_denied:
    'A human rejected this approval request. Do not retry the same action; ask the user how to proceed or choose a different action.',
  approval_invalidated:
    'The approval request was withdrawn by the host (settings or trust changed, operations stopped, or the approval was already used). Observe again; a new request needs a new action.',
  read_only_mode:
    'This target is in the read_only permission tier: only observe, navigate, back and scroll are allowed. Select agentdesklink.operationMode = standard for ordinary actions or ask for consequential actions with approval.',
  proxy_connect_refused:
    'The configured proxy refused the tunnel. If it authorizes by hostname, enable agentdesklink.browserProxyConnectByHostname; otherwise check the proxy allow list.',
  proxy_unreachable:
    'The configured proxy could not be reached. Check agentdesklink.browserProxyServer and the network.',
  invalid_scope:
    'The scope expression is malformed. Use up to 8 comma-separated terms: role:button, name:Save, id:<element_id>, within:<element_id>, text:"v1.0: fixed" or plain text; quote a term that contains a comma and keep quotes balanced.',
  scope_element_not_found:
    'The element named by within:<element_id> is not in this observation (the id is unknown or the page changed). Observe again and use an element id from the latest revision.',
  scope_within_unsupported:
    'within:<element_id> needs the page structure of a browser observation; desktop observations are flat. Narrow the search with role:, name: or text: terms instead.',
  not_scrollable:
    'Nothing to scroll: the page (or the element and its ancestors) fits in the viewport and has no scrollable area, so everything is already in view. Use adl_observe to read it; scroll only a region that has more content than it shows.',
  revision_expired:
    'The since_revision baseline is no longer retained (only recent revisions are kept). Omit since_revision for a full observation.',
  form_submission_requires_approval:
    'The page tried to submit a form; the submission was cancelled inside the browser before any request left (page scripts may have run). In ask mode an approval request was created: wait for the decision with adl_approvals (wait_ms) and retry the identical action with the returned revision. approved: true in this error means a standing site grant already approved it: retry the identical action with the returned revision at once. In standard mode form submissions need agentdesklink.operationMode = ask (a GET search form is sent without approval).',
  desktop_operation_not_granted:
    'Native desktop mutations are not granted for this application. Select agentdesklink.operationMode = standard for ordinary controls, grant allowAllOperations, or configure a trusted control allowlist (controlsPath) in the policy.',
  linux_accessibility_unavailable:
    'The Linux accessibility stack is unavailable. Install python3-gi, gir1.2-atspi-2.0 and at-spi2-core, enable toolkit accessibility (gsettings set org.gnome.desktop.interface toolkit-accessibility true), then restart the MCP server.',
  platform_unsupported:
    'This feature is not supported on this platform. Check adl_capabilities.platform_unsupported for the unavailable features.',
  capture_not_enabled:
    'Image capture is not enabled for this target. Desktop apps: enable agentdesklink.allowUnredactedImages in the trusted workspace settings. Policy-file browser targets: set browserTargets[].visual.enabled.',
  browser_sandbox_unavailable:
    'Chromium could not start its sandbox. The MCP server log names the launch error and the remedy.',
  desktop_focus_changed:
    'The desktop target lost focus or its window may have closed, so the session was closed. Check the screen, rediscover the target with adl_targets, then open a new session with adl_open and observe.',
  request_requires_approval:
    "The page sent a write request (POST, PUT, PATCH or DELETE by fetch/XHR) during this action. It is held unsent inside the browser and a human was asked to approve its exact content. Wait with adl_approvals (request_id, wait_ms): status consumed with sent:true means every request was released and dispatched; sent:false (or any other status) means nothing, or not the whole set, was sent. Then observe again. Do not repeat the action: the page's handler has already run. When a standing site grant covers the request, the action instead returns ok with approval.granted = site_writes and the request already sent.",
  request_not_approvable:
    'The page sent a write request that cannot be shown to a human for approval (multipart or file upload, binary, streamed or oversized body, a synchronous XHR the page waits for, a beacon or embedded frame, or more than 4 requests from one action), so it was blocked before it left. There is no automatic way to send it; what the screen shows was not saved.',
  background_write_blocked:
    'A write request that started outside any action (a timer, autosave or beacon) was blocked before it left; only writes the page sends while an action runs can be held for approval. Trigger the save with an explicit control (for example its Save button) so that it belongs to an action.',
  contained_request_blocked:
    'This control ran with the network closed to new requests (Delete/Remove containment) and started a new read request or navigation that cannot be attributed to it, so it was stopped; its handler has run. Writes it sends are held for approval in ask mode. If the control is known to be harmless in this workspace, list its label in agentdesklink.consequentialAllowLabels.',
  tls_handshake_failed:
    'The TLS handshake failed. Verify the destination certificate and proxy configuration (agentdesklink.browserProxyServer or browserProxyServer in the CLI policy). For a trusted corporate CA, configure Node with --use-system-ca or NODE_EXTRA_CA_CERTS, then restart the server.',
  transport_failure:
    'The connection to the destination failed at the transport level (refused, reset or interrupted) before a usable response was returned. Verify the destination is reachable, then retry.',
  gesture_surface_not_found:
    'No gesture surface with this surface_id is configured for this target. List the permitted surface ids and their gesture kinds in the gesture_surfaces field of the target entry from adl_targets, then retry with one of them.',
  gesture_kind_not_allowed:
    'This gesture kind is not allowed on the named surface. Check gesture_surfaces in the target entry from adl_targets for the kinds each surface id supports, and use a supported kind.',
  isolated_read_only:
    'This session uses isolated read-only compatibility mode. Observe, read text, navigate or go back; input, scrolling, capture and handoff are unavailable.',
  gesture_disabled:
    'Gestures are not enabled for this target. Policy-file browser targets: set browserTargets[].gestures.enabled with visual surfaces (visual capture must be enabled); a non-read-only operation mode is also required.',
};
export class AdlError extends Error {
  mayHaveExecuted = false;
  requestId?: string;
  /** detail.argument names a request argument (never page data); detail.limit is a configured numeric limit; detail.revision is the session revision the identical retry must use; detail.page_script_ran says a stopped action's page handler has run; detail.approved says a standing site grant already approved the request, so the identical retry goes through at once. */
  constructor(
    public readonly code: ErrorCode,
    public readonly reason?: ErrorReason,
    public readonly detail: {
      argument?: string;
      limit?: number;
      revision?: number;
      page_script_ran?: boolean;
      approved?: true;
    } = {},
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = 'AdlError';
  }
}
/** One write request the page sent during an action and the adapter holds unsent; the engine describes it to a human. Bodies never leave the adapter: only the description lines and the body hash do. */
export interface HeldWrite {
  method: string;
  url: string;
  content_type: string;
  body_sha256: string;
  body_length: number;
  /** describeHeldRequest lines for the approval dialog. */
  details: string[];
  /** A credential or secret value was masked in details. */
  secret: boolean;
}
/** Thrown by act() when the action left write requests held unsent; the session stays usable (mayHaveExecuted is false) and the engine turns it into an approval. */
export class HeldWritesError extends AdlError {
  constructor(public readonly hold: { id: string; requests: HeldWrite[] }) {
    super('E_APPROVAL_REQUIRED', 'request_requires_approval', { page_script_ran: true });
    this.name = 'HeldWritesError';
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
  requires_ask_mode: { workspace_setting: 'agentdesklink.operationMode', policy_setting: 'consequentialAllowLabels' },
  contained_request_blocked: { policy_setting: 'consequentialAllowLabels' },
  read_only_mode: { workspace_setting: 'agentdesklink.operationMode' },
  approval_unavailable: { workspace_setting: 'agentdesklink.operationMode' },
  consequential_operation: { workspace_setting: 'agentdesklink.operationMode' },
  method_requires_approval: { workspace_setting: 'agentdesklink.operationMode' },
  form_submission_requires_approval: { workspace_setting: 'agentdesklink.operationMode' },
  desktop_operation_not_granted: { workspace_setting: 'agentdesklink.operationMode' },
  origin_not_allowed: {
    workspace_setting: 'agentdesklink.browserOrigins',
    policy_setting: 'allowedOrigins (browserTargets alone does not grant)',
  },
  redirect_origin_not_allowed: {
    workspace_setting: 'agentdesklink.browserOrigins',
    policy_setting: 'allowedOrigins (browserTargets alone does not grant)',
  },
  gesture_disabled: { policy_setting: 'browserTargets[].gestures' },
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
      (code === 'E_STALE_STATE' ||
        (code === 'E_APPROVAL_REQUIRED' &&
          !!(error as AdlError).requestId &&
          reason !== 'request_requires_approval')) &&
      !mayHaveExecuted,
    safe_message: mayHaveExecuted
      ? 'The operation may have executed. Verify the result before retrying; previous session handles may be unavailable.'
      : reason
        ? ERROR_REASON_MESSAGES[reason]
        : ERROR_MESSAGES[code],
    ...(reason ? { reason } : {}),
    ...(detail?.argument ? { argument: detail.argument } : {}),
    ...(detail?.limit !== undefined ? { limit: detail.limit } : {}),
    ...(detail?.revision !== undefined ? { revision: detail.revision } : {}),
    ...(detail?.page_script_ran ? { page_script_ran: true } : {}),
    ...(detail?.approved ? { approved: true } : {}),
    ...(error instanceof AdlError && error.requestId ? { request_id: error.requestId } : {}),
    ...(hints?.policy_setting ? { policy_setting: hints.policy_setting } : {}),
    ...(hints?.workspace_setting ? { workspace_setting: hints.workspace_setting } : {}),
    ...(mayHaveExecuted ? { may_have_executed: true } : {}),
  };
}
