import type {CapturedImage, VisualPolicy,DesktopVisualPolicy} from './visual-types.js';
import type {GesturePolicy,GesturePlan,GestureReference,GestureExecution} from './gesture-types.js';
import type {InteractivePolicy,PrepareInput,PreparedInput,InputExecution,ExpectedTarget} from './physical-input-types.js';
export type Mode = 'strict_isolated' | 'background_semantic' | 'interactive_desktop';
export type Classification = 'PUBLIC' | 'INTERNAL' | 'SECRET' | 'UNKNOWN';
export type ActionName = 'click' | 'fill' | 'select' | 'check' | 'scroll' | 'navigate' | 'read_state' | 'wait_for' | 'press' | 'back' | 'hover';
export interface Element {
  id: string; role: string; name: string; value?: string; enabled: boolean;
  checked?: boolean; selected?: boolean; expanded?: boolean; sensitive?: boolean; protected?: boolean;
  /** Internal DOM depth, projected out of public responses. */
  depth?: number;
  options?: {label:string;value:string;disabled:boolean;selected:boolean}[];
  /** Candidates were omitted by the source or response budget; reobserve this id with a larger budget. */
  options_truncated?: boolean;
  name_truncated?: boolean;
  text_length?: number;
  parent_id?: string;
}
/** Adapter-private hashes; never projected into public observations. */
export interface ActionEvidence {navigation:string;elements:Record<string,string>}
export interface RawSnapshot { elements: Element[]; fingerprint: string; truncated: boolean; url?:string; title?:string; warnings?:{code:string;count:number;origin?:string}[];actionEvidence?:ActionEvidence; }
export interface TargetWindow {
  bounds: { x: number; y: number; width: number; height: number; coordinate_space: 'desktop_points_top_left' | 'desktop_physical_pixels' };
  display_ids: string[]; minimized: boolean;
}
export interface Target {
  target_id: string; surface: 'browser' | 'desktop'; application_id: string;
  label: string; capabilities: string[]; policy_class: Classification;
  window?: TargetWindow;
  capture_only?:boolean;
}
export interface BrowserTargetConfig {
  id: string; label: string; url: string; classification: Classification;
  controls?: { selector: string; actions: ActionName[] }[];
  visual?: VisualPolicy;
  gestures?:GesturePolicy;
}
export interface DesktopConfig {
  allowAllOperations?:boolean;
  restrictTargets?:boolean;
  helperPath: string; appId: string; appPath: string; controlsPath?: string;
  classification: 'PUBLIC' | 'INTERNAL';
  visual?:DesktopVisualPolicy;
  interactive?:InteractivePolicy;
  lifecycle?:{enabled:boolean};
}
export interface PolicyConfig {
  allowAllOperations?:boolean;
  restrictTargets?:boolean;
  browserHeadless?:boolean;
  browserProxyServer?:string;
  /** Origins permitted only for GET/HEAD subresources, never navigation. */
  resourceOrigins?:string[];
  allowPersonalData?:boolean;
  operationMode?:'read_only'|'standard'|'ask';
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
}
export interface Action {
  action: ActionName; element_id?: string; value?: string; url?: string;
  checked?: boolean; direction?: 'up' | 'down'; timeout_ms?: number;
  role?: string; name?: string;
  expected_target?:ExpectedTarget;
  point?:{frame_id:string;x:number;y:number};
  include_diff?:boolean;
}
export interface Condition { role?: string; name?: string; element_id?: string; state?: 'visible' | 'hidden' | 'enabled'; }
export interface ActionAuthorization{normalOperations?:boolean;approvalProof?:string;approved?:boolean;expires_at?:number;pointReference?:GestureReference;actionEvidence?:{navigation:string;element?:string}}
export interface AdapterSession {
  capabilities?: string[];
  /** Reports the actual mutation dispatch boundary through act's callback. */
  tracksDispatch?: boolean;
  handoff?(paused:boolean,signal:AbortSignal,expiresAt?:number):Promise<void>;
  resolvePoint?(point:{x:number;y:number},reference:GestureReference,signal:AbortSignal):Promise<string|undefined>;
  clickPoint?(point:{x:number;y:number},reference:GestureReference,signal:AbortSignal,onDispatch:()=>void):Promise<void>;
  capture?(signal: AbortSignal): Promise<CapturedImage>;
  gesture?(plan:GesturePlan,reference:GestureReference,signal:AbortSignal):Promise<GestureExecution>;
  prepareInput?(request:PrepareInput,reference:GestureReference,signal:AbortSignal):Promise<PreparedInput>;
  commitInput?(confirmation_id:string,value:string|undefined,signal:AbortSignal):Promise<InputExecution>;
  snapshot(signal?: AbortSignal): Promise<RawSnapshot>;
  readText?(elementId:string,offset:number,length:number,signal:AbortSignal):Promise<{text:string;total_length:number;next_offset:number|null;truncated:boolean}>;
  prepareAction?(action:Action,signal:AbortSignal):Promise<{proof:string;risk:'ordinary'|'consequential'|'credential';role:string;name:string;origin:string;details?:string[]}>;
  act(action: Action, signal: AbortSignal, onDispatch?:()=>void, authorization?:ActionAuthorization): Promise<void>;
  close(): Promise<void>;
}
export interface Adapter {
  open(target: Target, mode: Mode, signal: AbortSignal): Promise<AdapterSession>;
  onInvalidated?(listener: () => void): () => void;
  discover?(signal: AbortSignal): Promise<Target[]>;
  application?(application_id:string,action:'status'|'launch'|'quit',signal:AbortSignal):Promise<{running:boolean;managed:boolean;changed:boolean}>;
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
  E_BACKEND_UNAVAILABLE: 'The backend could not start. Verify its installation and OS sandbox support.'
} as const;
export type ErrorCode = keyof typeof ERROR_MESSAGES;
export type ErrorReason = 'occluded' | 'not_visible' | 'operation_not_granted' | 'consequential_operation' | 'iframe_action_proof_unavailable' | 'loopback_not_allowed' | 'private_network_not_allowed' | 'origin_not_allowed' | 'redirect_origin_not_allowed' | 'requires_ask_mode' | 'approval_unavailable' | 'emergency_stop' | 'not_editable' | 'dns_resolution_failed' | 'untrusted_dom_api';
const ERROR_REASON_MESSAGES:Record<ErrorReason,string>={
  occluded:'The target is covered by another element. Remove the obstruction and observe again.',
  not_visible:'The target is not visible at the intended input point. Observe again before acting.',
  operation_not_granted:'No trusted operation grant matches this control. Review the policy controls or workspace operation permissions.',
  consequential_operation:'This consequential operation requires an explicit operation grant.',
  iframe_action_proof_unavailable:'Semantic actions inside iframes require a frame-scoped isolated proof, which is currently unavailable. Open the allowed frame URL as a separate target.',
  loopback_not_allowed:'Loopback access is disabled. Enable agentdesklink.allowLoopback in trusted workspace settings and retain the exact origin grant.',
  private_network_not_allowed:'Private network access is disabled. Enable agentdesklink.allowPrivateNetwork in trusted workspace settings and retain the exact origin grant.',
  origin_not_allowed:'This origin is not granted. Add its exact origin to agentdesklink.browserOrigins for navigation, or browserResourceOrigins for read-only assets.',
  redirect_origin_not_allowed:'A redirect tried to leave the permitted origin. Inspect the destination origin and grant/open it separately.',
  requires_ask_mode:'This action needs individual human approval. Select agentdesklink.operationMode = ask in the trusted host settings.',
  approval_unavailable:'Individual approval is unavailable. Start this MCP server through the trusted VS Code host with operationMode = ask.',
  emergency_stop:'Operations are stopped or their permission generation was revoked. Resume operations in AgentDeskLink and reconnect the client.',
  not_editable:'This element is not an editable text control. Observe again and select an input, textarea or supported editable control.',
  untrusted_dom_api:'The page overrides DOM APIs that AgentDeskLink cannot verify safely. Use a page without these overrides or a manual handoff.',
  dns_resolution_failed:'Local DNS resolution failed. Verify local DNS and proxy settings; proxy-only DNS is unsupported because destination IP validation is required.',
};
export class AdlError extends Error {
  mayHaveExecuted = false;
  requestId?:string;
  constructor(public readonly code: ErrorCode,public readonly reason?:ErrorReason) { super(ERROR_MESSAGES[code]); this.name = 'AdlError'; }
}
/** Native helper error; mayHaveExecuted is the helper's own verdict and must survive to safeError. */
export class NativeError extends AdlError {
  constructor(code: ErrorCode, public readonly nativeMayHaveExecuted: boolean) { super(code); this.name = 'NativeError'; this.mayHaveExecuted = nativeMayHaveExecuted; }
}
export function safeError(error: unknown) {
  const code = error instanceof AdlError ? error.code : 'E_INTERNAL';
  const reason=error instanceof AdlError?error.reason:undefined;
  const mayHaveExecuted=error instanceof AdlError&&error.mayHaveExecuted;
  const setting=reason==='loopback_not_allowed'?'allowLoopback':reason==='private_network_not_allowed'?'allowPrivateNetwork':reason==='requires_ask_mode'||reason==='approval_unavailable'?'operationMode':reason==='origin_not_allowed'||reason==='redirect_origin_not_allowed'?'browserOrigins':undefined;
  return { code, retryable: (code === 'E_STALE_STATE'||code==='E_APPROVAL_REQUIRED'&&!!(error as AdlError).requestId) && !mayHaveExecuted, safe_message:mayHaveExecuted?'The operation may have executed. Verify the result before retrying; previous session handles may be unavailable.':reason?ERROR_REASON_MESSAGES[reason]:ERROR_MESSAGES[code],...(reason?{reason}:{}),...(error instanceof AdlError&&error.requestId?{request_id:error.requestId}:{}),...(reason==='operation_not_granted'?{policy_setting:'browserTargets[].controls',workspace_setting:'agentdesklink.operationMode'}:{}),...(setting?{workspace_setting:'agentdesklink.'+setting}:{}), ...(mayHaveExecuted?{may_have_executed:true}:{}) };
}
