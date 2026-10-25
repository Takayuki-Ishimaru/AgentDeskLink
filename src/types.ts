import type {CapturedImage, VisualPolicy,DesktopVisualPolicy} from './visual-types.js';
import type {GesturePolicy,GesturePlan,GestureReference,GestureExecution} from './gesture-types.js';
import type {InteractivePolicy,PrepareInput,PreparedInput,InputExecution,ExpectedTarget} from './physical-input-types.js';
export type Mode = 'strict_isolated' | 'background_semantic' | 'interactive_desktop';
export type Classification = 'PUBLIC' | 'INTERNAL' | 'SECRET' | 'UNKNOWN';
export type ActionName = 'click' | 'fill' | 'select' | 'check' | 'scroll' | 'navigate' | 'read_state' | 'wait_for';
export interface Element {
  id: string; role: string; name: string; value?: string; enabled: boolean;
  checked?: boolean; selected?: boolean; sensitive?: boolean;
}
export interface RawSnapshot { elements: Element[]; fingerprint: string; truncated: boolean; }
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
  helperPath: string; appId: string; appPath: string; controlsPath?: string;
  classification: 'PUBLIC' | 'INTERNAL';
  visual?:DesktopVisualPolicy;
  interactive?:InteractivePolicy;
  lifecycle?:{enabled:boolean};
}
export interface PolicyConfig {
  allowAllOperations?:boolean;
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
}
export interface Condition { role?: string; name?: string; element_id?: string; state?: 'visible' | 'hidden' | 'enabled'; }
export interface AdapterSession {
  capabilities?: string[];
  capture?(signal: AbortSignal): Promise<CapturedImage>;
  gesture?(plan:GesturePlan,reference:GestureReference,signal:AbortSignal):Promise<GestureExecution>;
  prepareInput?(request:PrepareInput,reference:GestureReference,signal:AbortSignal):Promise<PreparedInput>;
  commitInput?(confirmation_id:string,value:string|undefined,signal:AbortSignal):Promise<InputExecution>;
  snapshot(signal?: AbortSignal): Promise<RawSnapshot>;
  act(action: Action, signal: AbortSignal): Promise<void>;
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
  E_TARGET_NOT_FOUND: 'Target or handle is unavailable or expired.',
  E_UNSUPPORTED_ACTION: 'This action is unsupported.',
  E_APPROVAL_REQUIRED: 'This operation requires independent approval and is disabled in this beta.',
  E_PRIVACY_BLOCKED: 'The requested data cannot be safely disclosed.',
  E_TIMEOUT: 'Operation timed out; the affected session was closed.',
  E_PARTIAL_EXECUTION: 'Execution stopped after partial completion.',
  E_CANCELLED: 'Operation cancelled.',
  E_INVALID_ARGUMENT: 'Invalid request.',
  E_RESOURCE_LIMIT: 'A configured resource limit was reached.',
  E_INTERNAL: 'Operation failed safely.',
  E_BACKEND_UNAVAILABLE: 'The backend could not start. Verify its installation and OS sandbox support.'
} as const;
export type ErrorCode = keyof typeof ERROR_MESSAGES;
export class AdlError extends Error {
  mayHaveExecuted = false;
  constructor(public readonly code: ErrorCode) { super(ERROR_MESSAGES[code]); this.name = 'AdlError'; }
}
/** Native helper error; mayHaveExecuted is the helper's own verdict and must survive to safeError. */
export class NativeError extends AdlError {
  constructor(code: ErrorCode, public readonly nativeMayHaveExecuted: boolean) { super(code); this.name = 'NativeError'; this.mayHaveExecuted = nativeMayHaveExecuted; }
}
export function safeError(error: unknown) {
  const code = error instanceof AdlError ? error.code : 'E_INTERNAL';
  return { code, retryable: code === 'E_STALE_STATE', safe_message: ERROR_MESSAGES[code], ...(error instanceof AdlError&&error.mayHaveExecuted?{may_have_executed:true}:{}) };
}
