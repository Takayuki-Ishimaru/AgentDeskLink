import { AliasMap } from './aliases.js';
import { StartupDiagnostics } from './startup-diagnostics.js';
import { saveAfterAction, saveAfterApproval } from './save-state.js';
import { randomUUID, randomBytes, createHmac, createHash } from 'node:crypto';
import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AdlError,
  HeldWritesError,
  MAX_DOM_DEPTH,
  NativeError,
  safeError,
  type Action,
  type Adapter,
  type AdapterActResult,
  type AdapterSession,
  type AdapterWarning,
  type ApprovalGrantedBy,
  type Condition,
  type ErrorReason,
  type GrantedApprovalResult,
  type HeldWriteAbortOutcome,
  type Mode,
  type NetworkWarning,
  type PolicyConfig,
  type RawSnapshot,
  type SiteWriteGrant,
  type Target,
  type BrowserTargetConfig,
} from './types.js';
import { isActionNetworkBlock, isWriteBlock } from './network-warnings.js';
import {
  assertUrlAllowed,
  authorizeAction,
  isNativeConsequential,
  redactElement,
  redactString,
  redactText,
} from './policy.js';
import { SnapshotStore, type ObserveOptions, type ObserveResult } from './snapshot.js';
import { VisualStore } from './visual.js';
import { visualRequestSchema } from './visual-request.js';
import type { VisualRequest, VisualObservation } from './visual-types.js';
import type { VisualViewOptions } from './visual-types.js';
import type { GestureRequest, GestureExecution } from './gesture-types.js';
import type { SequenceOptions, SequenceObservation } from './sequence-types.js';
import { recordSequence } from './sequence.js';
import {
  gestureRequestSchema,
  sequenceRequestSchema,
  expectedTargetSchema,
  prepareInputSchema,
  commitInputSchema,
} from './interaction-request.js';
import { InputProofStore } from './input-proof-store.js';
import { ApprovalClient, type ApprovalReply, type ApprovalStatus, type ApprovalSummary } from './approval-client.js';
import { isMoneyLike, isMoneyLikeUrl } from './action-classifier.js';
import { describeApprovalValue } from './approval-summary.js';
import type {
  PrepareInputRequest,
  PreparedObservation,
  CommitInputRequest,
  InputExecution,
} from './physical-input-types.js';

/** Stands in for an unknown alias: matches no element, so stale-revision checks still come first and the action ends in E_TARGET_NOT_FOUND. */
const UNKNOWN_ELEMENT = '\u0000unknown';
type EvidenceRecord = { epoch: number; evidence: NonNullable<RawSnapshot['actionEvidence']> };
type Session = {
  id: string;
  target: Target;
  adapter: AdapterSession;
  mode: Mode;
  revision: number;
  raw: RawSnapshot;
  expires: number;
  /** The session is kept alive until then whatever its idle time-to-live says (held writes wait for a human decision). */
  keepUntil?: number;
  latestFrame?: string;
  paused?: boolean;
  actionEpoch: number;
  actionHistory: Map<number, EvidenceRecord>;
};
export type Step = Action & { session_id: string; expected_revision?: number; condition?: Condition };
type Task = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  controller: AbortController;
  results: Record<string, unknown>[];
  error?: ReturnType<typeof safeError>;
  created: number;
};
type ApprovalProof = {
  proof: string;
  risk: 'ordinary' | 'credential' | 'consequential';
  role: string;
  name: string;
  origin?: string;
  application?: string;
  details?: string[];
  context?: { kind: 'row' | 'listitem' | 'dialog' | 'form'; text: string };
  /** Every label the activation can carry, as the adapter reports them (siteGrantFor checks them for money-like words). */
  labels?: string[];
  /** The standing site grant a human may give with this request (siteGrantFor); never set for credentials, label-gated clicks or desktop controls. */
  grant?: SiteWriteGrant;
};
type TerminalApproval = 'denied' | 'consumed' | 'invalidated' | 'expired';
/** A human's rejection is final (approval_denied); an expiry asks to observe again; everything else was withdrawn or already used. */
function approvalRefusal(status: TerminalApproval) {
  return status === 'expired'
    ? new AdlError('E_STALE_STATE', 'approval_expired')
    : new AdlError('E_POLICY_DENIED', status === 'denied' ? 'approval_denied' : 'approval_invalidated');
}
/** The write requests the page's action left held unsent in the adapter: the approval releases or aborts exactly this set, once. */
type HeldWriteSet = {
  id: string;
  adapter: AdapterSession;
  settling?: Promise<void>;
  /** The action that left the set held, by its dispatch-relevant fields only (requestKeyFor with dispatchOnly): the identical action is not dispatched again. */
  dispatchKey: string;
};
type PendingApproval = {
  request_id: string;
  binding: string;
  requestKey: string;
  expires_at: number;
  session_id: string;
  summary: ApprovalSummary;
  baselineRevision?: number;
  hold?: HeldWriteSet;
  /** The broker approved the request through a standing site grant (summary.grant): it is consumed like any approval, never twice. */
  granted?: ApprovalGrantedBy;
};
/** How a request ended, by request id (until it would have expired): what adl_approvals reports for an explicit request_id. */
type EndedApproval = {
  expires: number;
  status: TerminalApproval;
  summary: ApprovalSummary;
  /** Held writes only: true when the requests were released into the network. */
  sent?: boolean;
  sentAt?: number;
  response_status?: number;
  hold?: { id: string; adapter: AdapterSession };
  /** The adapter reported how the released set ended: sent is final (true only when every request reached the network fetch). */
  outcomeKnown?: boolean;
  granted?: ApprovalGrantedBy;
};
type ApprovalRow = {
  request_id: string;
  status: ApprovalStatus;
  expires_at: number;
  summary: ApprovalSummary;
  sent?: boolean;
  response_status?: number;
  /** Decided by a standing site grant instead of an individual answer. */
  granted?: ApprovalGrantedBy;
};
/** The agent's error for write requests held for a human: the handler has run, the request id is the way forward (never an identical retry). */
function heldRequestError(requestId: string) {
  const error = new AdlError('E_APPROVAL_REQUIRED', 'request_requires_approval', { page_script_ran: true });
  error.requestId = requestId;
  return error;
}
const HELD_DETAIL_LINES = 25;
const HELD_DETAIL_BYTES = 8192;
/** Context is supplemental: never discard complete form/request details to fit it. */
function contextualDetails(proof: ApprovalProof): string[] | undefined {
  const context = proof.context;
  if (
    !context ||
    !['row', 'listitem', 'dialog', 'form'].includes(context.kind) ||
    typeof context.text !== 'string' ||
    context.text.length > 512 ||
    context.text.includes('\0')
  )
    return proof.details;
  const text = redactText(context.text);
  if (text.length > 512) return proof.details;
  const line = `Page context (${context.kind}; untrusted page text, not request identity): ${JSON.stringify(text)}`;
  const details = [line, ...(proof.details ?? [])];
  return details.length <= HELD_DETAIL_LINES &&
    Buffer.byteLength(JSON.stringify({ details }), 'utf8') <= HELD_DETAIL_BYTES
    ? details
    : proof.details;
}
/** adl_approvals waits at most this long for a released request's answer, so that the observation that follows sees the page's reaction. */
const HELD_RESPONSE_WAIT_MS = 1500;
const HELD_WATCH_MS = 500;
/** After a site grant released an action's writes, the act waits this long (the adapter's settle quiet window) before it observes the page's reaction. */
const HELD_SETTLE_MS = 60;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
function invalid(argument: string, reason: ErrorReason = 'invalid_argument') {
  return new AdlError('E_INVALID_ARGUMENT', reason, { argument });
}
/** A browser scroll without element_id scrolls the page itself (the main frame's scrolling element). */
function isPageScroll(action: Action, surface: 'browser' | 'desktop'): boolean {
  return action.action === 'scroll' && surface === 'browser' && action.element_id === undefined && !action.point;
}
/** An approval request error for a form submission: the request id stays, the response names the revision the identical retry must use. */
function submissionRequest(error: AdlError, revision: number) {
  const next = new AdlError(error.code, error.reason ?? 'form_submission_requires_approval', {
    ...error.detail,
    revision,
  });
  if (error.requestId) next.requestId = error.requestId;
  return next;
}
/** The origin of an http(s) URL, or undefined when it does not parse. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
function badArgument(error: { issues: readonly { path: readonly PropertyKey[] }[] }, known: readonly string[]) {
  const key = error.issues[0]?.path[0];
  return invalid(typeof key === 'string' && known.includes(key) ? key : 'request');
}
// Adapters that do not scope blocks to the action (no AdapterActResult.blocks) are reported by the growth of their snapshot warnings: the counts
// that are new since before the action, per warning class.
function newBlocks(before: NetworkWarning[] | undefined, after: NetworkWarning[] | undefined): NetworkWarning[] {
  const keyOf = (w: NetworkWarning) => JSON.stringify([w.code, w.resource_type, w.method, w.origin]);
  const seen = new Map<string, number>();
  for (const w of before ?? []) seen.set(keyOf(w), (seen.get(keyOf(w)) ?? 0) + w.count);
  const fresh: NetworkWarning[] = [];
  for (const w of after ?? []) {
    const grown = w.count - (seen.get(keyOf(w)) ?? 0);
    if (grown > 0) fresh.push({ ...w, count: grown });
  }
  return fresh;
}
// URL-opened targets live in a bounded per-process registry; policy.browserTargets (trusted configuration) is never mutated by them.
const URL_TARGET_LIMIT = 64;
type UrlTarget = { config: BrowserTargetConfig; target: Target };
export class Engine {
  private readonly startup = new StartupDiagnostics();
  /** Public element ids are per-session aliases (e1, e2, ...); see aliases.ts. */
  private readonly aliasMaps = new Map<string, AliasMap>();
  private sessions = new Map<string, Session>();
  private targets = new Map<string, Target>();
  /** Keyed by exact URL; Map order is recency (oldest first). */
  private readonly urlTargets = new Map<string, UrlTarget>();
  private tasks = new Map<string, Task>();
  private snapshots: SnapshotStore;
  private visuals = new VisualStore();
  private inputProofs = new InputProofStore();
  private readonly approval = ApprovalClient.fromEnv();
  private readonly approvalKey = randomBytes(32);
  private readonly approvalServerId = randomUUID();
  private readonly approvalPending = new Map<string, PendingApproval>();
  /** Bindings whose request ended (until it would have expired): what ended it decides the refusal an identical retry gets. */
  private readonly approvalTerminal = new Map<string, { expires: number; status: TerminalApproval }>();
  /** The same endings by request id, with the summary and (held writes) whether the requests were sent: adl_approvals reports them for an explicit request_id. */
  private readonly approvalEnded = new Map<string, EndedApproval>();
  /** Held-writes settlements in progress, by request id: a report of the request waits for its ending to be complete. */
  private readonly heldSettlements = new Map<string, Promise<void>>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly sessionQueues = new Map<string, Promise<unknown>>();
  private desktopLane: Promise<unknown> | undefined;
  private readonly expiring = new Set<string>();
  private stopped = false;
  private shutdownPromise: Promise<void> | undefined;
  private queued = 0;
  private closures = new WeakMap<AdapterSession, Promise<void>>();
  private master = new AbortController();
  private timer: NodeJS.Timeout;
  constructor(
    readonly policy: PolicyConfig,
    private adapters: { browser: Adapter; desktop?: Adapter },
    private readonly platform: string = process.platform,
    private readonly operationAllowed: () => boolean = () => true,
  ) {
    this.snapshots = new SnapshotStore(policy.allowPersonalData);
    for (const config of policy.browserTargets) {
      if (config.classification === 'SECRET' || config.classification === 'UNKNOWN') continue;
      const target: Target = {
        target_id: `t_${randomUUID()}`,
        surface: 'browser',
        application_id: config.id,
        label: redactString(config.label),
        policy_class: config.classification,
        capabilities: this.browserCapabilities(config),
        ...(this.gestureSurfaces(config) ? { gesture_surfaces: this.gestureSurfaces(config) } : {}),
      };
      this.targets.set(target.target_id, target);
    }
    adapters.desktop?.onInvalidated?.(() => {
      void this.enqueueDesktop(async () => {
        this.replaceDesktopTargets([]);
        for (const s of [...this.sessions.values()]) if (s.target.surface === 'desktop') await this.destroy(s);
      }).catch(() => {});
    });
    this.timer = setInterval(() => {
      this.visuals.prune();
      this.inputProofs.prune();
      for (const s of this.sessions.values())
        if (s.expires <= Date.now() && !this.expiring.has(s.id)) {
          this.expiring.add(s.id);
          void this.sessionLane(s.id, async () => {
            if (this.sessions.get(s.id) === s && s.expires <= Date.now()) await this.destroy(s);
          })
            .catch(() => {})
            .finally(() => this.expiring.delete(s.id));
        }
    }, 1000);
    this.timer.unref();
  }
  private browserCapabilities(config: BrowserTargetConfig): string[] {
    const actions =
      this.policy.allowAllOperations || this.policy.operationMode === 'standard' || this.policy.operationMode === 'ask'
        ? ['click', 'fill', 'select', 'check', 'press', 'hover']
        : this.policy.operationMode === 'read_only'
          ? []
          : [...new Set((config.controls ?? []).flatMap(control => control.actions))];
    return [
      ...new Set([
        'observe',
        'scroll',
        'navigate',
        'back',
        'read_state',
        'wait_for',
        ...actions,
        ...(this.policy.browserHeadless === false &&
        (this.policy.allowAllOperations || (this.policy.operationMode === 'ask' && !!this.approval))
          ? ['handoff']
          : []),
        ...(config.visual?.enabled ? ['capture', 'crop', 'record'] : []),
        ...(config.gestures?.enabled && (this.policy.allowAllOperations || this.policy.operationMode !== 'read_only')
          ? ['gesture']
          : []),
      ]),
    ];
  }
  /** Permitted gesture surface ids and kinds, reported only when the gesture capability is actually in force; selectors never are. */
  private gestureSurfaces(config?: BrowserTargetConfig): { id: string; kinds: string[] }[] | undefined {
    if (!config?.gestures?.enabled) return undefined;
    if (!(this.policy.allowAllOperations || this.policy.operationMode !== 'read_only')) return undefined;
    return config.gestures.surfaces.map(surface => ({
      id: surface.id,
      kinds: (['drag', 'swipe'] as const).filter(kind => surface.kinds.includes(kind)),
    }));
  }
  private replaceDesktopTargets(targets: Target[]) {
    for (const [id, target] of this.targets) if (target.surface === 'desktop') this.targets.delete(id);
    for (const target of targets) this.targets.set(target.target_id, target);
  }
  capabilities() {
    const probe = (
      this.adapters.desktop as
        | {
            desktopCapabilities?: () => {
              available: boolean;
              mutations: boolean;
              focus_control?: string;
              interactive_input?: boolean;
              gesture_backends?: string[];
              lifecycle?: boolean;
            };
          }
        | undefined
    )?.desktopCapabilities?.();
    const interactive = this.desktopConfig()?.interactive?.enabled === true;
    const p = this.policy,
      blanket = p.allowAllOperations === true,
      app =
        this.platform === 'darwin'
          ? p.macos
          : this.platform === 'win32'
            ? p.windows
            : this.platform === 'linux'
              ? p.linux
              : undefined;
    const linux = this.platform === 'linux';
    return {
      ok: true,
      permissions: {
        all_operations: blanket,
        operation_mode: blanket ? 'all' : (p.operationMode ?? 'legacy_controls'),
        restricted_targets: p.restrictTargets === true,
        origins: p.allowAllBrowserOrigins || (blanket && !p.restrictTargets) ? 'all_allowed' : p.allowedOrigins.slice(),
        resource_origins: (p.resourceOrigins ?? []).slice(),
        personal_data: p.allowPersonalData === true,
        targets:
          p.allowAllBrowserOrigins || (blanket && !p.restrictTargets)
            ? 'all_allowed'
            : p.browserTargets.map(t => ({ application_id: t.id, origin: new URL(t.url).origin })),
        desktop_app: app?.allowAllApplications ? 'all_allowed' : (app?.appId ?? ''),
        physical_input: app?.interactive?.enabled === true,
        unredacted_images: app?.visual?.allowUnredacted === true,
        loopback: p.allowLoopback,
        private_network: p.allowPrivateNetwork,
      },
      approvals: {
        available: !!this.approval && p.operationMode === 'ask' && !blanket,
        surface: 'browser_and_desktop',
        surfaces: ['browser', 'desktop'],
        desktop_sensitive_controls: 'refused',
        max_pending: 8,
        expires_ms: 120000,
        requires_visible_main_document_control: false,
        requires_visible_control: true,
        iframe_and_shadow: false,
        open_shadow: true,
        same_origin_iframe: true,
        cross_origin_iframe_approval: false,
      },
      startup: {
        sessions: this.startup.snapshot(),
        ...(this.adapters.browser.startupDiagnostics ? { browser: this.adapters.browser.startupDiagnostics() } : {}),
      },
      version: '0.1.11',
      transport: 'stdio',
      observation_budget: {
        unit: 'utf8_json_bytes',
        default_bytes: this.policy.defaultTokenBudget * 4,
        byte_budget: { min: 1024, max: 32000 },
        legacy_token_multiplier: 4,
        tokenizer_limit: false,
      },
      modes: [
        'strict_isolated',
        ...(this.adapters.desktop ? ['background_semantic', ...(interactive ? ['interactive_desktop'] : [])] : []),
      ],
      adapters: {
        browser: this.policy.browserHeadless === false ? 'chromium_headful' : 'chromium_headless',
        desktop: this.adapters.desktop
          ? linux
            ? 'linux_atspi_probe_required'
            : probe?.focus_control === 'probe_guarded_semantic'
              ? 'macos_ax_probe_required'
              : 'windows_uia_probe_required'
          : 'unavailable',
        ...(probe ? { desktop_mutations: probe.mutations } : {}),
      },
      lifecycle: {
        configured:
          this.policy.macos?.lifecycle?.enabled === true ||
          this.policy.windows?.lifecycle?.enabled === true ||
          this.policy.linux?.lifecycle?.enabled === true,
        available: probe?.lifecycle === true && this.lifecyclePlatformSupported(),
        platform_supported: this.lifecyclePlatformSupported(),
        mode: 'background_semantic',
      },
      // Features this platform's native path cannot offer; clients must not retry them on another target.
      platform_unsupported: linux ? ['physical_input', 'interactive_desktop', 'desktop_capture', 'lifecycle'] : [],
      limits: {
        max_sessions: this.policy.maxSessions,
        max_batch_steps: this.policy.maxBatchSteps,
        max_elements: this.policy.maxElements,
        retained_elements: 20000,
      },
      visual: {
        browser: true,
        desktop: !!(this.policy.macos?.visual?.enabled || this.policy.windows?.visual?.enabled),
        formats: ['image/png'],
        sources: ['viewport', 'exact_window'],
        max_source_pixels: 4194304,
        max_source_bytes: 8388608,
        max_frames: 16,
        max_retained_bytes: 33554432,
        frame_ttl_ms: 60000,
        max_output_dimension: 2048,
        max_output_pixels: 4194304,
        max_output_bytes: 6291456,
        video: 'timestamped_png_sequence',
        audio: false,
        gestures: 'isolated_browser_and_opt_in_desktop',
        max_sequence_frames: 16,
        max_sequence_span_ms: 6000,
        gesture_frame_max_age_ms: 5000,
        browser_gesture_frame_max_age_ms: 30000,
      },
      physical_input: {
        configured: interactive,
        available: probe?.interactive_input === true,
        backends: probe?.gesture_backends ?? [],
        requires_foreground: true,
        exclusive_lease: true,
        confirmation_ttl_ms: 30000,
        pre_dispatch_target_check: true,
      },
      limitations: [
        p.allowAllBrowserOrigins || (blanket && !p.restrictTargets)
          ? 'Broad policy supplies default browser visuals; native images follow the native visual policy. Sequences sample discrete frames without audio.'
          : 'Visuals require trusted per-target opt-in. Native images may need explicit unredacted-pixel permission. Sequences sample discrete frames without audio.',
        'interactive_desktop shares the human desktop and moves the real pointer. Human input or focus changes stop execution; partial input cannot be rolled back.',
        'Native scroll_swipe is wheel/scroll input, distinct from genuine touch_swipe. Check each target backend capability.',
        ...(blanket
          ? []
          : [
              p.operationMode === 'ask'
                ? 'Browser credentials and consequential operations, and consequential native desktop controls, require a matching one-shot host approval. Sensitive native controls and unsupported payloads remain denied.'
                : 'Credentials, uploads and consequential operations are disabled.',
            ]),
        ...(p.restrictTargets && !p.allowAllBrowserOrigins
          ? ['Configured browser origin grants remain enforced even with broad operation permission.']
          : []),
        'Arbitrary code execution is unavailable. Desktop strict isolation requires a separate isolated runner.',
        linux
          ? 'Linux desktop control uses AT-SPI2 semantic actions only. operationMode standard/ask permits ordinary actions on non-sensitive, non-consequential controls; ask approves consequential controls one at a time; allowAllOperations or a trusted control allowlist widens this. Physical input, window capture and lifecycle are platform_unsupported.'
          : app?.allowAllOperations
            ? 'background_semantic preserves native focus probes; the explicit native operation grant replaces the control allowlist.'
            : !app?.controlsPath && (p.operationMode === 'standard' || p.operationMode === 'ask')
              ? 'background_semantic preserves native focus probes. operationMode standard/ask permits ordinary actions on non-sensitive, non-consequential controls; ask approves consequential controls one at a time; allowAllOperations or a trusted control allowlist widens this.'
              : 'background_semantic preserves native focus probes and requires a trusted control allowlist.',
        'Application lifecycle is noninterfering background launch/status/quit for the one configured opted-in application only; it never sends input or focus changes and never falls back to interactive control automatically.',
      ],
    };
  }
  listSessions() {
    return {
      ok: true,
      sessions: [...this.sessions.values()]
        .filter(s => s.expires > Date.now())
        .map(s => ({
          session_id: s.id,
          target_id: s.target.target_id,
          surface: s.target.surface,
          mode: s.mode,
          revision: s.revision,
          paused: s.paused === true,
          expires_at: new Date(s.expires).toISOString(),
        })),
    };
  }
  handoff(sessionId: string, command: 'pause' | 'resume', cancel?: AbortSignal) {
    return this.sessionLane(sessionId, async () => {
      const s = this.get(sessionId);
      if (!['pause', 'resume'].includes(command)) throw invalid('command');
      if (s.raw.read_only) throw new AdlError('E_UNSUPPORTED_ACTION', 'isolated_read_only');
      if (s.target.surface !== 'browser' || this.policy.browserHeadless !== false || !s.adapter.handoff)
        throw new AdlError('E_UNSUPPORTED_ACTION');
      let expires = Date.now() + 120000;
      if (command === 'pause' && !this.policy.allowAllOperations) {
        if (this.policy.operationMode !== 'ask') throw new AdlError('E_APPROVAL_REQUIRED');
        await this.refresh(s, cancel, true);
        if (s.raw.read_only) throw new AdlError('E_UNSUPPORTED_ACTION', 'isolated_read_only');
        const configured = this.browserConfig(s.target.application_id);
        const origin = new URL(s.raw.url ?? configured?.url ?? '').origin;
        expires = (await this.approvalFor(s, { action: 'handoff' }, s.revision, {
          proof: 'manual-network:' + s.raw.fingerprint,
          risk: 'consequential',
          role: 'browser',
          name: 'Manual browsing: temporary same-origin network access',
          origin,
          details: [
            'Automation stays paused. Website scripts may send, change or delete before any human click, until resume or expiry.',
            'Maximum duration: 120 seconds. This is a temporary manual-session grant, not approval of only one form request.',
          ],
        }))!;
      }
      await this.invalidateApproval(s.id);
      this.inputProofs.invalidateSession(s.id);
      delete s.latestFrame;
      if (command === 'pause') s.paused = true;
      try {
        await this.deadline(
          sig => {
            if (!this.operationAllowed() || cancel?.aborted || (command === 'pause' && expires <= Date.now()))
              throw new AdlError('E_POLICY_DENIED');
            return s.adapter.handoff!(command === 'pause', sig, command === 'pause' ? expires : undefined);
          },
          this.policy.actionTimeoutMs,
          cancel,
          s,
        );
        await this.refresh(s, cancel);
        s.revision++;
        this.recordSnapshot(s.id, s.revision, s.raw);
        this.recordActionEvidence(s);
      } catch (error) {
        await s.adapter.handoff(false, new AbortController().signal).catch(() => undefined);
        throw error;
      }
      s.paused = command === 'pause';
      return {
        ok: true,
        session_id: s.id,
        paused: s.paused,
        revision: s.revision,
        ...(s.paused ? { manual_network_expires_at: new Date(expires).toISOString() } : {}),
        instructions: s.paused
          ? 'Use the visible isolated browser to sign in or finish the manual step. This origin may send requests during the approved manual interval. Resume afterward and observe again.'
          : 'Observe again and use the new revision before acting.',
      };
    });
  }
  listTargets(surface?: string, cancel?: AbortSignal) {
    return this.enqueue(async () => {
      if (surface !== 'browser' && this.adapters.desktop?.discover) {
        try {
          this.replaceDesktopTargets(
            await this.enqueueDesktop(() =>
              this.deadline(signal => this.adapters.desktop!.discover!(signal), this.policy.actionTimeoutMs, cancel),
            ),
          );
        } catch (error) {
          this.replaceDesktopTargets([]);
          throw error;
        }
      }
      // URL-opened targets are listed only while a session uses them; idle ones stay reopenable by URL until evicted.
      const live = new Set([...this.sessions.values()].map(x => x.target.target_id));
      return {
        ok: true,
        targets: [
          ...this.targets.values(),
          ...[...this.urlTargets.values()].map(entry => entry.target).filter(t => live.has(t.target_id)),
        ].filter(t => !surface || t.surface === surface),
      };
    });
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return this.runQueued(
      this.queue,
      p => {
        this.queue = p;
      },
      fn,
    );
  }
  private enqueueSession<T>(session_id: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.sessionQueues.get(session_id) ?? Promise.resolve();
    let tail: Promise<unknown> | undefined;
    return this.runQueued(
      prior,
      p => {
        tail = p;
        this.sessionQueues.set(session_id, p);
      },
      fn,
    ).finally(() => {
      if (tail && this.sessionQueues.get(session_id) === tail) this.sessionQueues.delete(session_id);
    });
  }
  private enqueueDesktop<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.desktopLane ?? Promise.resolve();
    let tail: Promise<unknown> | undefined;
    return this.runQueued(
      prior,
      p => {
        tail = p;
        this.desktopLane = p;
      },
      fn,
    ).finally(() => {
      if (tail && this.desktopLane === tail) this.desktopLane = undefined;
    });
  }
  private runQueued<T>(
    chain: Promise<unknown>,
    bind: (tail: Promise<unknown>) => void,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.stopped || !this.operationAllowed())
      return Promise.reject(
        new AdlError('E_CANCELLED', this.stopped || !this.operationAllowed() ? 'emergency_stop' : undefined),
      );
    if (this.queued >= 64) return Promise.reject(new AdlError('E_RESOURCE_LIMIT'));
    this.queued++;
    const run = chain.then(() => {
      if (this.stopped || !this.operationAllowed())
        throw new AdlError('E_CANCELLED', this.stopped || !this.operationAllowed() ? 'emergency_stop' : undefined);
      return fn();
    });
    bind(run.catch(() => {}));
    return run.finally(() => {
      this.queued--;
    });
  }
  private sessionLane<T>(session_id: string, fn: () => Promise<T>): Promise<T> {
    const s = this.sessions.get(session_id);
    const run = async () => {
      try {
        return await fn();
      } catch (error) {
        if (s && error instanceof AdlError && error.code === 'E_STALE_STATE') error.detail.revision ??= s.revision;
        throw error;
      }
    };
    if (s?.target.surface === 'desktop') return this.enqueueDesktop(run);
    return this.enqueueSession(session_id, run);
  }
  private get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s || s.expires <= Date.now()) throw new AdlError('E_TARGET_NOT_FOUND');
    // An access renews the idle time-to-live, but never takes back the time a pending hold needs the session for.
    s.expires = Math.max(Date.now() + this.policy.sessionTtlMs, s.keepUntil ?? 0);
    return s;
  }
  private async audit(
    event: string,
    fields: {
      session_id?: string;
      task_id?: string;
      action?: string;
      code?: string;
      request_id?: string;
      origin?: string;
    } = {},
  ) {
    const audit_id = `a_${randomUUID()}`;
    if (this.policy.auditPath) {
      await mkdir(dirname(this.policy.auditPath), { recursive: true, mode: 0o700 });
      await appendFile(
        this.policy.auditPath,
        JSON.stringify({ audit_id, time: new Date().toISOString(), event, ...fields }) + '\n',
        { mode: 0o600 },
      );
      await chmod(this.policy.auditPath, 0o600);
    }
    return audit_id;
  }
  private async destroy(s: Session) {
    this.sessions.delete(s.id);
    this.snapshots.close(s.id);
    this.aliasMaps.delete(s.id);
    this.visuals.dropSession(s.id);
    this.inputProofs.invalidateSession(s.id);
    await this.invalidateApproval(s.id);
    await this.stopAdapter(s.adapter);
  }
  private async invalidateApproval(sessionId: string) {
    const entry = this.approvalPending.get(sessionId);
    if (!entry) return;
    // Held writes are aborted with the approval (and a decision already being carried out is awaited, not raced).
    if (entry.hold) return this.settleHold(entry, 'invalidated', true);
    this.approvalPending.delete(sessionId);
    this.approvalTerminal.set(entry.binding, { expires: entry.expires_at, status: 'invalidated' });
    this.recordEnded(entry, 'invalidated');
    await this.approval?.request('DELETE', `/v1/requests/${entry.request_id}`, entry).catch(() => undefined);
  }
  /** Remembers how a request ended, by request id, until it would have expired (bounded; the oldest endings go first). */
  private recordEnded(
    entry: PendingApproval,
    status: TerminalApproval,
    extra: {
      sent?: boolean;
      sentAt?: number;
      hold?: { id: string; adapter: AdapterSession };
      granted?: ApprovalGrantedBy;
    } = {},
  ) {
    for (const [id, ended] of this.approvalEnded) if (ended.expires <= Date.now()) this.approvalEnded.delete(id);
    while (this.approvalEnded.size >= 128) this.approvalEnded.delete(this.approvalEnded.keys().next().value!);
    this.approvalEnded.set(entry.request_id, { expires: entry.expires_at, status, summary: entry.summary, ...extra });
  }
  /** Whether the broker approved this request through a standing site grant: only a request the engine itself offered the grant for (summary.grant) can be. */
  private grantedBy(entry: PendingApproval, reply: ApprovalReply): ApprovalGrantedBy | undefined {
    return reply.granted === 'site_writes' && reply.status !== 'pending' && entry.summary.grant
      ? 'site_writes'
      : undefined;
  }
  /**
   * The standing-grant scope a human may give for a write to `origin`, or undefined when it must be asked every time: credentials, money-like
   * labels or URLs, origins outside the grants, anything but ask mode with a broker. Page text can only remove eligibility, never add it.
   */
  private siteGrantFor(origin: string, labels: string[], urls: string[], secret: boolean): SiteWriteGrant | undefined {
    if (secret || !this.approval || this.policy.operationMode !== 'ask' || this.policy.allowAllOperations)
      return undefined;
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return undefined;
    } catch {
      return undefined;
    }
    if (!this.policy.allowedOrigins.includes(origin)) return undefined;
    if (labels.some(isMoneyLike) || urls.some(isMoneyLikeUrl)) return undefined;
    return { scope: 'site_writes', origin };
  }
  /**
   * Ends the approval of held writes exactly once (concurrent callers share the same settlement): an approved request is consumed at the broker and
   * its requests released only if the consumption was ours, the operation is still allowed and it has not expired; every other ending aborts them.
   * withdraw=true also withdraws the request at the broker (the ending did not come from the broker).
   */
  private settleHold(entry: PendingApproval, status: ApprovalStatus | 'abandoned', withdraw = false): Promise<void> {
    const hold = entry.hold!;
    if (!hold.settling) {
      const settling = this.performSettle(entry, hold, status, withdraw);
      hold.settling = settling;
      this.heldSettlements.set(entry.request_id, settling);
      const done = () => {
        if (this.heldSettlements.get(entry.request_id) === settling) this.heldSettlements.delete(entry.request_id);
      };
      settling.then(done, done);
    }
    return hold.settling;
  }
  private async performSettle(
    entry: PendingApproval,
    hold: HeldWriteSet,
    status: ApprovalStatus | 'abandoned',
    withdraw: boolean,
  ) {
    // The entry stays pending until the ending is complete: the identical action keeps getting this request, and closing the session awaits a release in flight.
    try {
      await this.endHold(entry, hold, status, withdraw);
    } finally {
      if (this.approvalPending.get(entry.session_id) === entry) this.approvalPending.delete(entry.session_id);
      // The session no longer has to outlive the request: its idle time-to-live applies again from now.
      const s = this.sessions.get(entry.session_id);
      if (s?.keepUntil !== undefined && s.keepUntil === entry.expires_at + 30000) {
        s.keepUntil = undefined;
        s.expires = Math.min(s.expires, Date.now() + this.policy.sessionTtlMs);
      }
    }
  }
  private async endHold(
    entry: PendingApproval,
    hold: HeldWriteSet,
    status: ApprovalStatus | 'abandoned',
    withdraw: boolean,
  ) {
    let abort: HeldWriteAbortOutcome =
      status === 'denied'
        ? 'denied'
        : status === 'expired' || entry.expires_at <= Date.now()
          ? 'expired'
          : 'invalidated';
    let release = false;
    if (status === 'approved') {
      try {
        const consumed = await this.approval!.request('DELETE', `/v1/requests/${entry.request_id}`, entry);
        release =
          consumed.status === 'consumed' &&
          consumed.consumed_now === true &&
          this.operationAllowed() &&
          !this.stopped &&
          entry.expires_at > Date.now();
      } catch {
        release = false;
      }
      abort = entry.expires_at <= Date.now() ? 'expired' : 'invalidated';
    }
    let sent = false;
    if (release) {
      try {
        await hold.adapter.releaseHeldWrites!(hold.id, entry.expires_at);
        sent = true;
      } catch {
        // The page abandoned its requests (or the set is gone) before they could leave: nothing was sent, and a spent approval is not restored.
        abort = 'invalidated';
      }
    }
    if (!sent) await Promise.resolve(hold.adapter.abortHeldWrites?.(hold.id, abort)).catch(() => undefined);
    const ended: TerminalApproval = sent
      ? 'consumed'
      : abort === 'denied'
        ? 'denied'
        : abort === 'expired'
          ? 'expired'
          : 'invalidated';
    this.approvalTerminal.set(entry.binding, { expires: entry.expires_at, status: ended });
    this.recordEnded(entry, ended, {
      sent,
      ...(sent ? { sentAt: Date.now() } : {}),
      hold: { id: hold.id, adapter: hold.adapter },
      ...(entry.granted ? { granted: entry.granted } : {}),
    });
    if (withdraw && !sent && status !== 'approved')
      await this.approval?.request('DELETE', `/v1/requests/${entry.request_id}`, entry).catch(() => undefined);
    await this.audit(sent ? 'held_request_released' : 'held_request_aborted', {
      session_id: entry.session_id,
      ...(sent ? {} : { code: abort }),
    }).catch(() => undefined);
  }
  /** One look at a pending held-writes request: settles it when the page abandoned the requests, the request expired or the broker decided it. */
  private async checkHold(entry: PendingApproval) {
    const hold = entry.hold!;
    if (hold.settling) return hold.settling;
    if (!this.operationAllowed() || this.stopped) return this.settleHold(entry, 'invalidated', true);
    if (hold.adapter.heldWritesAlive?.(hold.id) === false) return this.settleHold(entry, 'abandoned', true);
    if (entry.expires_at <= Date.now()) return this.settleHold(entry, 'expired', true);
    let reply: ApprovalReply;
    try {
      reply = await this.approval!.request('GET', `/v1/requests/${entry.request_id}`, entry);
    } catch {
      return this.settleHold(entry, 'invalidated', true);
    }
    if (reply.status === 'pending') return;
    // A site grant approved a request that was queued behind the modal: the same release as after an individual approval.
    entry.granted ??= this.grantedBy(entry, reply);
    return this.settleHold(entry, reply.status);
  }
  /** Learns of the human's decision on held writes without anyone polling adl_approvals, and notices requests the page abandoned. Never takes a session lane. */
  private async watchHold(entry: PendingApproval) {
    try {
      while (this.approvalPending.get(entry.session_id) === entry && !entry.hold!.settling) {
        await delay(HELD_WATCH_MS, undefined, { signal: this.master.signal, ref: false });
        if (this.approvalPending.get(entry.session_id) !== entry) return;
        await this.checkHold(entry);
      }
    } catch {
      // The engine is shutting down: destroying the session aborts the held requests.
    }
  }
  private stopAdapter(adapter: AdapterSession): Promise<void> {
    const current = this.closures.get(adapter);
    if (current) return current;
    const closing = this.performStop(adapter);
    this.closures.set(adapter, closing);
    return closing;
  }
  private async performStop(adapter: AdapterSession) {
    let timer: NodeJS.Timeout | undefined;
    const cleanupMs = adapter.capabilities?.includes('interactive_desktop') ? 8000 : 1000;
    const closed = await Promise.race([
      adapter.close().then(
        () => true,
        () => false,
      ),
      new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), cleanupMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!closed) {
      this.stopped = true;
      clearInterval(this.timer);
      this.master.abort();
      for (const task of this.tasks.values()) task.controller.abort();
    }
  }
  private async deadline<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeout: number,
    cancel?: AbortSignal,
    session?: Session,
  ): Promise<T> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.master.signal, ...(cancel ? [cancel] : [])]);
    let timedOut = false;
    const interruption = () =>
      new AdlError(
        timedOut ? 'E_TIMEOUT' : 'E_CANCELLED',
        !timedOut && (this.stopped || !this.operationAllowed()) ? 'emergency_stop' : undefined,
      );
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    let listener: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      listener = () => reject(interruption());
      signal.addEventListener('abort', listener, { once: true });
      if (signal.aborted) listener();
    });
    try {
      return await Promise.race([signal.aborted ? aborted : operation(signal), aborted]);
    } catch (error) {
      if (signal.aborted && session) await this.destroy(session);
      if (signal.aborted) throw interruption();
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', listener);
    }
  }
  private async refresh(s: Session, signal?: AbortSignal, preserve = false) {
    const raw = this.boundSnapshot(
      await this.deadline(
        sig => s.adapter.snapshot(sig),
        this.policy.actionTimeoutMs,
        signal,
        preserve ? undefined : s,
      ),
    );
    if (
      raw.fingerprint !== s.raw.fingerprint ||
      (raw.actionEvidence && s.actionHistory.get(s.revision)?.epoch !== s.actionEpoch)
    ) {
      s.revision++;
      s.raw = raw;
      this.recordSnapshot(s.id, s.revision, raw);
      this.recordActionEvidence(s);
    }
    return s.revision;
  }
  private recordActionEvidence(s: Session) {
    if (s.target.surface !== 'browser' || !s.raw.actionEvidence) return;
    s.actionHistory.set(s.revision, { epoch: s.actionEpoch, evidence: s.raw.actionEvidence });
    const pinned = this.approvalPending.get(s.id)?.baselineRevision;
    while (s.actionHistory.size > 32) {
      const oldest = [...s.actionHistory.keys()].find(revision => revision !== pinned)!;
      s.actionHistory.delete(oldest);
    }
  }
  private boundSnapshot(raw: RawSnapshot): RawSnapshot {
    return {
      ...raw,
      elements: raw.elements.slice(0, 20000),
      truncated: raw.truncated || raw.elements.length > 20000,
      ...(raw.actionEvidence
        ? {
            actionEvidence: { navigation: raw.actionEvidence.navigation, elements: { ...raw.actionEvidence.elements } },
          }
        : {}),
    };
  }
  openUrl(url: string, mode: Mode = 'strict_isolated', cancel?: AbortSignal) {
    if (this.stopped || !this.operationAllowed() || cancel?.aborted)
      return Promise.reject(
        new AdlError('E_CANCELLED', this.stopped || !this.operationAllowed() ? 'emergency_stop' : undefined),
      );
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return Promise.reject(invalid('url', 'invalid_url'));
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || url.length > 2048)
      return Promise.reject(invalid('url', 'invalid_url'));
    // Origin and network grants are both checked before any catalogue mutation or open; the
    // extension profile sets restrictTargets so allowAllOperations cannot bypass them.
    return this.deadline(() => assertUrlAllowed(url, this.policy), this.policy.actionTimeoutMs, cancel).then(() =>
      this.enqueue(async () => {
        if (cancel?.aborted)
          throw new AdlError('E_CANCELLED', this.stopped || !this.operationAllowed() ? 'emergency_stop' : undefined);
        return this.openInternal(this.openGranted(parsed), mode, cancel);
      }),
    );
  }
  private browserConfig(applicationId: string): BrowserTargetConfig | undefined {
    return (
      this.policy.browserTargets.find(t => t.id === applicationId) ??
      [...this.urlTargets.values()].find(entry => entry.config.id === applicationId)?.config
    );
  }
  private findTarget(targetId: string): Target | undefined {
    const known = this.targets.get(targetId);
    if (known) return known;
    for (const [key, entry] of this.urlTargets)
      if (entry.target.target_id === targetId) {
        this.urlTargets.delete(key);
        this.urlTargets.set(key, entry);
        return entry.target;
      }
    return undefined;
  }
  // A configured target id (application_id) also resolves as an alias while exactly one listed
  // target uses it. Desktop ids resolve only after listTargets refreshed the catalogue, so
  // resolution never calls discover and never creates targets; a resolved alias goes through the
  // same openInternal checks as a generated id.
  private resolveConfiguredAlias(alias: string): Target | undefined {
    const live = new Set([...this.sessions.values()].map(x => x.target.target_id));
    const matches = [
      ...this.targets.values(),
      ...[...this.urlTargets.values()].map(entry => entry.target).filter(t => live.has(t.target_id)),
    ].filter(t => t.application_id === alias);
    return matches.length === 1 ? matches[0] : undefined;
  }
  private openGranted(parsed: URL): Target {
    const origin = parsed.origin;
    // A bounded per-process target catalogue lets clients open a URL without a policy file.
    const configured = this.policy.browserTargets.find(t => new URL(t.url).href === parsed.href);
    if (configured) {
      const target = [...this.targets.values()].find(t => t.application_id === configured.id);
      if (!target) throw new AdlError('E_TARGET_NOT_FOUND');
      return target;
    }
    const known = this.urlTargets.get(parsed.href);
    if (known) {
      this.urlTargets.delete(parsed.href);
      this.urlTargets.set(parsed.href, known);
      return known.target;
    }
    const granted = this.policy.browserTargets.find(t => new URL(t.url).origin === origin);
    if (
      !granted &&
      !this.policy.allowAllBrowserOrigins &&
      (!this.policy.allowAllOperations || this.policy.restrictTargets)
    )
      throw new AdlError('E_POLICY_DENIED', 'origin_not_allowed');
    // Make room: evict the least recently used entry that has no live session. Targets with sessions are never evicted.
    const live = new Set([...this.sessions.values()].map(x => x.target.target_id));
    while (this.urlTargets.size >= URL_TARGET_LIMIT) {
      const idle = [...this.urlTargets].find(([, entry]) => !live.has(entry.target.target_id));
      if (!idle) throw new AdlError('E_RESOURCE_LIMIT', 'target_limit', { limit: URL_TARGET_LIMIT });
      this.urlTargets.delete(idle[0]);
    }
    // Preserve the exact requested path without mutating another live target's
    // configuration; inherit only permissions already granted to this origin.
    const config: BrowserTargetConfig = {
      ...(granted ?? {
        label: origin,
        classification: 'PUBLIC' as const,
        visual: { enabled: true, maskSelectors: [] },
        gestures: {
          enabled: true,
          surfaces: [{ id: 'page', selector: 'body', kinds: ['drag' as const, 'swipe' as const] }],
        },
      }),
      id: `browser_${randomUUID()}`,
      url: parsed.href,
    };
    const target: Target = {
      target_id: `t_${randomUUID()}`,
      surface: 'browser',
      application_id: config.id,
      label: redactString(config.label),
      policy_class: config.classification,
      capabilities: this.browserCapabilities(config),
      ...(this.gestureSurfaces(config) ? { gesture_surfaces: this.gestureSurfaces(config) } : {}),
    };
    this.urlTargets.set(parsed.href, { config, target });
    return target;
  }
  open(target_id: string, mode: Mode = 'strict_isolated', cancel?: AbortSignal) {
    return this.enqueue(async () => {
      const target = this.findTarget(target_id) ?? this.resolveConfiguredAlias(target_id);
      if (!target) throw new AdlError('E_TARGET_NOT_FOUND', 'unknown_target', { argument: 'target_id' });
      return target.surface === 'desktop'
        ? this.enqueueDesktop(() => this.openInternal(target, mode, cancel))
        : this.openInternal(target, mode, cancel);
    });
  }
  private async openInternal(target: Target, mode: Mode, cancel?: AbortSignal) {
    if (this.sessions.size >= this.policy.maxSessions)
      throw new AdlError('E_RESOURCE_LIMIT', 'session_limit', { limit: this.policy.maxSessions });
    if (target.surface === 'desktop' && mode === 'strict_isolated') throw new AdlError('E_INTERFERENCE_RISK');
    if (mode === 'interactive_desktop') {
      if (target.surface !== 'desktop') throw new AdlError('E_INTERFERENCE_RISK');
      if (!this.desktopConfig()?.interactive?.enabled) throw new AdlError('E_POLICY_DENIED');
      if (!target.capabilities.includes('interactive_desktop')) throw new AdlError('E_UNSUPPORTED_ACTION');
      if ([...this.sessions.values()].some(s => s.mode === 'interactive_desktop'))
        throw new AdlError('E_INTERFERENCE_RISK');
    }
    const adapter = target.surface === 'browser' ? this.adapters.browser : this.adapters.desktop;
    if (!adapter) throw new AdlError('E_TARGET_NOT_FOUND');
    const startup = this.startup.start();
    startup.stage('adapter_open');
    const startupTimeout = this.policy.startupTimeoutMs ?? this.policy.actionTimeoutMs;
    let instance: AdapterSession | undefined;
    try {
      instance = await this.deadline(
        async signal => {
          const opened = await adapter.open(
            target,
            mode,
            signal,
            target.surface === 'browser' ? this.browserConfig(target.application_id) : undefined,
          );
          if (signal.aborted) {
            void this.stopAdapter(opened);
            throw new AdlError('E_CANCELLED', this.stopped || !this.operationAllowed() ? 'emergency_stop' : undefined);
          }
          return opened;
        },
        startupTimeout,
        cancel,
      );
      // Ask mode with an approver: writes the page sends during an action are held for a human instead of blocked (adapters without holding ignore it).
      instance.setWriteHolding?.(
        this.policy.operationMode === 'ask' && !!this.approval && !this.policy.allowAllOperations,
      );
      startup.stage('first_observation');
      const raw = this.boundSnapshot(await this.deadline(sig => instance!.snapshot(sig), startupTimeout, cancel));
      const s: Session = {
        id: `s_${randomUUID()}`,
        target,
        adapter: instance,
        mode,
        revision: 1,
        raw,
        expires: Date.now() + this.policy.sessionTtlMs,
        actionEpoch: 0,
        actionHistory: new Map(),
      };
      await this.audit('open', { session_id: s.id });
      if (this.stopped || this.master.signal.aborted || cancel?.aborted)
        throw new AdlError('E_CANCELLED', this.stopped || !this.operationAllowed() ? 'emergency_stop' : undefined);
      this.sessions.set(s.id, s);
      this.recordSnapshot(s.id, 1, raw);
      this.recordActionEvidence(s);
      startup.finish(true);
      return {
        ok: true,
        session_id: s.id,
        revision: 1,
        capabilities: instance.capabilities ?? target.capabilities,
        ...(raw.read_only ? { read_only: true as const } : {}),
        mode,
        // Reported only for an error response (400 or higher), so an opened 404 page is not mistaken for a real one.
        ...(raw.http_status !== undefined ? { http_status: raw.http_status } : {}),
      };
    } catch (error) {
      startup.finish(false);
      if (instance) await this.stopAdapter(instance);
      throw error;
    }
  }
  capture(session_id: string, options: VisualRequest = {}, cancel?: AbortSignal): Promise<VisualObservation> {
    return this.sessionLane(session_id, async () => {
      const s = this.get(session_id);
      const parsed = visualRequestSchema.safeParse(options);
      if (!parsed.success)
        throw options && typeof options === 'object' && options.region && !options.frame_id
          ? invalid('region', 'region_requires_frame_id')
          : badArgument(parsed.error, ['frame_id', 'region', 'max_dimension', 'max_pixels']);
      this.assertCaptureAllowed(s);
      return this.deadline(
        async signal => {
          if (signal.aborted)
            throw new AdlError('E_CANCELLED', this.stopped || !this.operationAllowed() ? 'emergency_stop' : undefined);
          const { frame_id, ...view } = parsed.data;
          if (frame_id) return this.visuals.view(s.id, frame_id, view, signal);
          return this.captureFrame(s, view, signal);
        },
        this.policy.actionTimeoutMs,
        cancel,
        s,
      ).catch(async error => {
        if (error instanceof AdlError && ['E_TIMEOUT', 'E_CANCELLED'].includes(error.code)) await this.destroy(s);
        throw error;
      });
    });
  }
  private assertCaptureAllowed(s: Session): void {
    if (!s.adapter.capture)
      throw new AdlError(
        'E_UNSUPPORTED_ACTION',
        s.target.surface === 'desktop' && this.platform === 'linux' ? 'platform_unsupported' : undefined,
      );
    const config = s.target.surface === 'browser' ? this.browserConfig(s.target.application_id) : this.desktopConfig();
    if (!config?.visual?.enabled) throw new AdlError('E_PRIVACY_BLOCKED', 'capture_not_enabled');
  }
  private desktopConfig() {
    return this.platform === 'darwin'
      ? this.policy.macos
      : this.platform === 'linux'
        ? this.policy.linux
        : this.policy.windows;
  }
  private async captureFrame(s: Session, view: VisualViewOptions, signal: AbortSignal): Promise<VisualObservation> {
    await this.refresh(s, signal);
    const image = await s.adapter.capture!(signal);
    if (signal.aborted || this.stopped || !this.sessions.has(s.id))
      throw new AdlError('E_CANCELLED', this.stopped || !this.operationAllowed() ? 'emergency_stop' : undefined);
    const id = await this.visuals.record(
      { session_id: s.id, target_id: s.target.target_id, revision: s.revision },
      image,
      signal,
    );
    try {
      if (signal.aborted || this.stopped || !this.sessions.has(s.id))
        throw new AdlError('E_CANCELLED', this.stopped || !this.operationAllowed() ? 'emergency_stop' : undefined);
      await this.audit('capture', { session_id: s.id });
      if (signal.aborted)
        throw new AdlError('E_CANCELLED', this.stopped || !this.operationAllowed() ? 'emergency_stop' : undefined);
      const observation = await this.visuals.view(s.id, id, view, signal);
      s.latestFrame = id;
      return observation;
    } catch (error) {
      this.visuals.discard(s.id, id);
      throw error;
    }
  }
  record(session_id: string, options: SequenceOptions = {}, cancel?: AbortSignal): Promise<SequenceObservation> {
    return this.sessionLane(session_id, async () => {
      const s = this.get(session_id);
      const parsed = sequenceRequestSchema.safeParse(options);
      if (!parsed.success) {
        const count = options.frame_count ?? 8,
          gap = options.interval_ms ?? 250;
        throw Number.isInteger(count) &&
          count >= 2 &&
          count <= 16 &&
          Number.isInteger(gap) &&
          gap >= 50 &&
          gap <= 2000 &&
          (count - 1) * gap > 6000
          ? invalid('frame_count', 'sequence_span_too_long')
          : badArgument(parsed.error, ['frame_count', 'interval_ms', 'max_dimension', 'max_pixels']);
      }
      this.assertCaptureAllowed(s);
      return this.deadline(
        signal =>
          recordSequence(
            {
              capture: (view, sig) => this.captureFrame(s, view, sig),
              assertRetained: async id => {
                this.visuals.assertRetained(s.id, id);
              },
              discard: ids => {
                for (const id of ids) this.visuals.discard(s.id, id);
                if (s.latestFrame && ids.includes(s.latestFrame)) delete s.latestFrame;
              },
            },
            parsed.data,
            signal,
          ),
        Math.min(30000, this.policy.actionTimeoutMs + 6000),
        cancel,
        s,
      ).catch(async error => {
        if (error instanceof AdlError && ['E_TIMEOUT', 'E_CANCELLED'].includes(error.code)) await this.destroy(s);
        throw error;
      });
    });
  }
  gesture(
    session_id: string,
    request: GestureRequest,
    cancel?: AbortSignal,
  ): Promise<VisualObservation & { metadata: VisualObservation['metadata'] & { gesture: GestureExecution } }> {
    return this.sessionLane(session_id, async () => {
      const s = this.get(session_id);
      const parsed = gestureRequestSchema.safeParse(request);
      if (!parsed.success) throw badArgument(parsed.error, Object.keys(gestureRequestSchema.shape));
      if (s.paused) throw new AdlError('E_POLICY_DENIED');
      if (
        s.target.surface === 'browser' &&
        this.policy.operationMode === 'read_only' &&
        !this.policy.allowAllOperations
      )
        throw new AdlError('E_POLICY_DENIED');
      this.assertCaptureAllowed(s);
      if (!s.adapter.gesture) throw new AdlError('E_UNSUPPORTED_ACTION');
      if (s.target.surface === 'browser') {
        const config = this.browserConfig(s.target.application_id);
        if (!config?.gestures?.enabled) throw new AdlError('E_POLICY_DENIED');
        if (parsed.data.swipe_backend === 'scroll' || (parsed.data.kind === 'drag' && parsed.data.swipe_backend))
          throw new AdlError('E_UNSUPPORTED_ACTION');
      } else {
        if (s.mode !== 'interactive_desktop' || !this.desktopConfig()?.interactive?.enabled)
          throw new AdlError('E_INTERFERENCE_RISK');
      }
      const { frame_id, expected_revision, ...plan } = parsed.data;
      this.visuals.assertRetained(s.id, frame_id, s.target.surface === 'browser' ? 30000 : 5000);
      if (frame_id !== s.latestFrame) throw new AdlError('E_STALE_STATE');
      let dispatched = false;
      return this.deadline(
        async signal => {
          await this.refresh(s, signal);
          if (s.revision !== expected_revision)
            throw new AdlError('E_STALE_STATE', undefined, { revision: s.revision });
          const { metadata: reference } = await this.visuals.view(
            s.id,
            frame_id,
            { max_dimension: 64, max_pixels: 4096 },
            signal,
          );
          if (reference.revision !== s.revision) throw new AdlError('E_STALE_STATE');
          await this.audit('gesture_started', { session_id: s.id, action: plan.kind });
          this.visuals.assertRetained(s.id, frame_id, s.target.surface === 'browser' ? 30000 : 5000);
          let completed = false;
          try {
            this.inputProofs.invalidateSession(s.id);
            dispatched = true;
            const execution = await s.adapter.gesture!(plan, reference, signal);
            completed = true;
            delete s.latestFrame;
            const image = await this.captureFrame(s, {}, signal);
            await this.audit('gesture_completed', { session_id: s.id, action: plan.kind });
            return { ...image, metadata: { ...image.metadata, gesture: execution } };
          } catch (error) {
            const safe = error instanceof AdlError ? error : new AdlError('E_INTERNAL');
            if (completed) safe.mayHaveExecuted = true;
            if (safe.mayHaveExecuted) await this.destroy(s);
            throw safe;
          }
        },
        this.policy.actionTimeoutMs + 5000,
        cancel,
        s,
      ).catch(error => {
        if (dispatched && error instanceof AdlError && ['E_CANCELLED', 'E_TIMEOUT'].includes(error.code))
          error.mayHaveExecuted = true;
        throw error;
      });
    });
  }
  prepareInput(session_id: string, request: PrepareInputRequest, cancel?: AbortSignal): Promise<PreparedObservation> {
    return this.sessionLane(session_id, async () => {
      const s = this.get(session_id),
        parsed = prepareInputSchema.safeParse(request);
      if (!parsed.success) throw badArgument(parsed.error, Object.keys(prepareInputSchema.shape));
      if (s.target.surface !== 'desktop' || s.mode !== 'interactive_desktop' || !s.adapter.prepareInput)
        throw new AdlError('E_UNSUPPORTED_ACTION');
      this.assertCaptureAllowed(s);
      const { frame_id, expected_revision, include_image, ...plan } = parsed.data;
      this.visuals.assertRetained(s.id, frame_id, 5000);
      if (s.latestFrame !== frame_id) throw new AdlError('E_STALE_STATE');
      this.inputProofs.invalidateSession(s.id);
      let dispatched = false;
      return this.deadline(
        async signal => {
          await this.refresh(s, signal);
          if (s.revision !== expected_revision)
            throw new AdlError('E_STALE_STATE', undefined, { revision: s.revision });
          const reference = (await this.visuals.view(s.id, frame_id, { max_dimension: 64, max_pixels: 4096 }, signal))
            .metadata;
          if (
            reference.revision !== s.revision ||
            plan.point.x >= reference.viewport.width ||
            plan.point.y >= reference.viewport.height
          )
            throw new AdlError('E_STALE_STATE');
          this.visuals.assertRetained(s.id, frame_id, 5000);
          const started_at = performance.now();
          dispatched = true;
          const prepared = await s.adapter.prepareInput!(plan, reference, signal);
          if (signal.aborted || !this.sessions.has(s.id))
            throw new AdlError('E_CANCELLED', this.stopped || !this.operationAllowed() ? 'emergency_stop' : undefined);
          if (
            prepared.action !== plan.action ||
            prepared.pointer_on_target !== true ||
            !prepared.target.enabled ||
            (plan.action === 'fill' && !prepared.target.editable) ||
            (plan.expected_target?.role !== undefined && plan.expected_target.role !== prepared.target.role) ||
            (plan.expected_target?.name !== undefined && plan.expected_target.name !== prepared.target.name)
          )
            throw new AdlError('E_STALE_STATE');
          await this.refresh(s, signal);
          let image: VisualObservation | undefined;
          if (include_image) {
            const full = await this.captureFrame(s, { max_dimension: 64, max_pixels: 4096 }, signal);
            if (full.metadata.surface_epoch !== reference.surface_epoch) throw new AdlError('E_STALE_STATE');
            const w = Math.min(256, full.metadata.source.width),
              h = Math.min(192, full.metadata.source.height);
            const x = Math.max(0, Math.min(full.metadata.source.width - w, Math.floor(plan.point.x - w / 2))),
              y = Math.max(0, Math.min(full.metadata.source.height - h, Math.floor(plan.point.y - h / 2)));
            image = await this.visuals.view(
              s.id,
              full.metadata.frame_id,
              { region: { x, y, width: w, height: h }, max_dimension: 256, max_pixels: 49152 },
              signal,
            );
          }
          const proof = this.inputProofs.issue({
            session_id: s.id,
            native_id: prepared.confirmation_id,
            action: prepared.action,
            revision: s.revision,
            target: { role: prepared.target.role, name: prepared.target.name },
            ttl_ms: Math.min(30000, prepared.expires_in_ms),
            started_at,
          });
          await this.audit('input_prepared', { session_id: s.id, action: prepared.action });
          if (signal.aborted) {
            this.inputProofs.invalidateSession(s.id);
            throw new AdlError('E_CANCELLED', this.stopped || !this.operationAllowed() ? 'emergency_stop' : undefined);
          }
          return {
            metadata: { ...prepared, ...proof, ok: true as const, session_id: s.id, revision: s.revision },
            ...(image ? { image } : {}),
          };
        },
        this.policy.actionTimeoutMs,
        cancel,
        s,
      ).catch(async error => {
        this.inputProofs.invalidateSession(s.id);
        if (dispatched && error instanceof AdlError && ['E_TIMEOUT', 'E_CANCELLED'].includes(error.code))
          error.mayHaveExecuted = true;
        if (error instanceof AdlError && (error.mayHaveExecuted || ['E_TIMEOUT', 'E_CANCELLED'].includes(error.code)))
          await this.destroy(s);
        throw error;
      });
    });
  }
  commitInput(
    session_id: string,
    request: CommitInputRequest,
    cancel?: AbortSignal,
  ): Promise<VisualObservation & { metadata: VisualObservation['metadata'] & { input: InputExecution } }> {
    return this.sessionLane(session_id, async () => {
      const s = this.get(session_id),
        parsed = commitInputSchema.safeParse(request);
      if (!parsed.success) throw badArgument(parsed.error, Object.keys(commitInputSchema.shape));
      if (s.mode !== 'interactive_desktop' || !s.adapter.commitInput) throw new AdlError('E_UNSUPPORTED_ACTION');
      const proof = this.inputProofs.consume(s.id, parsed.data.confirmation_id);
      if (
        (proof.action === 'click' && parsed.data.value !== undefined) ||
        (proof.action === 'fill' &&
          (parsed.data.value === undefined ||
            Buffer.byteLength(parsed.data.value) > 4096 ||
            /[\u0000-\u001f\u007f-\u009f]/u.test(parsed.data.value)))
      )
        throw invalid('value');
      authorizeAction(
        { action: proof.action, ...(parsed.data.value !== undefined ? { value: parsed.data.value } : {}) },
        { id: 'confirmed-target', ...proof.target, enabled: true },
        this.policy.allowAllOperations,
      );
      let dispatched = false,
        completed = false;
      return this.deadline(
        async signal => {
          await this.refresh(s, signal);
          if (s.revision !== proof.revision) throw new AdlError('E_STALE_STATE');
          await this.audit('input_started', { session_id: s.id, action: proof.action });
          if (performance.now() >= proof.expires_at_ms) throw new AdlError('E_STALE_STATE');
          dispatched = true;
          const execution = await s.adapter.commitInput!(proof.native_id, parsed.data.value, signal);
          completed = true;
          if (
            execution.action !== proof.action ||
            execution.released_input !== true ||
            execution.verified !== 'input_sequence_completed'
          )
            throw new AdlError('E_BACKEND_UNAVAILABLE');
          delete s.latestFrame;
          const image = await this.captureFrame(s, {}, signal);
          await this.audit('input_completed', { session_id: s.id, action: proof.action });
          return { ...image, metadata: { ...image.metadata, input: execution } };
        },
        this.policy.actionTimeoutMs,
        cancel,
        s,
      ).catch(async error => {
        const safe = error instanceof AdlError ? error : new AdlError('E_INTERNAL');
        if (completed || (dispatched && ['E_TIMEOUT', 'E_CANCELLED'].includes(safe.code))) safe.mayHaveExecuted = true;
        if (safe.mayHaveExecuted || ['E_TIMEOUT', 'E_CANCELLED'].includes(safe.code)) await this.destroy(s);
        throw safe;
      });
    });
  }
  private recordSnapshot(sessionId: string, revision: number, raw: RawSnapshot) {
    let map = this.aliasMaps.get(sessionId);
    if (!map) {
      map = new AliasMap();
      this.aliasMaps.set(sessionId, map);
    }
    this.snapshots.record(
      sessionId,
      revision,
      map.project(raw, () => this.snapshots.retainedIds(sessionId)),
    );
  }
  /** Public alias to internal id; unknown or evicted aliases are not found. */
  private internalId(sessionId: string, alias: string): string {
    const id = this.aliasMaps.get(sessionId)?.resolve(alias);
    if (id === undefined) throw new AdlError('E_TARGET_NOT_FOUND');
    return id;
  }
  observe(
    session_id: string,
    options: Omit<ObserveOptions, 'element_limit'> = {},
    cancel?: AbortSignal,
  ): Promise<ObserveResult> {
    return this.sessionLane(session_id, async () => {
      const s = this.get(session_id);
      if (options.byte_budget !== undefined && options.token_budget !== undefined) throw invalid('byte_budget');
      const budgetBytes = options.byte_budget ?? (options.token_budget ?? this.policy.defaultTokenBudget) * 4;
      if (options.byte_budget !== undefined) {
        if (!Number.isInteger(options.byte_budget) || options.byte_budget < 1024 || options.byte_budget > 32000)
          throw invalid('byte_budget');
      } else if (
        options.token_budget !== undefined &&
        (!Number.isInteger(options.token_budget) || options.token_budget < 256 || options.token_budget > 8000)
      )
        throw invalid('token_budget');
      if (options.depth !== undefined) {
        if (s.target.surface !== 'browser') throw new AdlError('E_UNSUPPORTED_ACTION');
        if (!Number.isSafeInteger(options.depth) || options.depth < 1 || options.depth > MAX_DOM_DEPTH)
          throw invalid('depth');
      }
      if (options.options) {
        const q = options.options;
        if (
          options.text ||
          options.cursor !== undefined ||
          options.since_revision !== undefined ||
          options.scope !== undefined ||
          options.include !== undefined ||
          options.depth !== undefined ||
          options.format !== undefined ||
          options.representation !== undefined
        )
          throw invalid('options');
        if (
          typeof q.element_id !== 'string' ||
          typeof (q.query ?? '') !== 'string' ||
          (q.query?.length ?? 0) > 512 ||
          !Number.isSafeInteger(q.offset ?? 0) ||
          (q.offset ?? 0) < 0 ||
          !Number.isSafeInteger(q.limit ?? 50) ||
          (q.limit ?? 50) < 1 ||
          (q.limit ?? 50) > 100
        )
          throw invalid('options');
      }
      await this.refresh(s, cancel);
      if (options.options) {
        if (s.target.surface !== 'browser' || !s.adapter.readOptions) throw new AdlError('E_UNSUPPORTED_ACTION');
        const { element_id, query = '', offset = 0, limit = 50 } = options.options;
        const internal = this.internalId(s.id, element_id);
        if (!s.raw.elements.some(e => e.id === internal)) throw new AdlError('E_TARGET_NOT_FOUND');
        const read = await this.deadline(
          sig => s.adapter.readOptions!(internal, query, offset, limit, sig),
          this.policy.actionTimeoutMs,
          cancel,
        );
        const make = (count: number): ObserveResult => {
          const next = offset + count < read.matched ? offset + count : null;
          return {
            ok: true,
            revision: s.revision,
            ...(s.raw.read_only ? { read_only: true as const } : {}),
            truncated: read.source_limited === true || next !== null,
            options: {
              element_id,
              offset,
              total: read.total,
              matched: read.matched,
              items: read.options.slice(0, count),
              next_offset: next,
              ...(read.source_limited ? { source_limited: true as const } : {}),
            },
          };
        };
        let lo = 0,
          hi = read.options.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (Buffer.byteLength(JSON.stringify(make(mid)), 'utf8') <= budgetBytes) lo = mid;
          else hi = mid - 1;
        }
        if ((!lo && read.options.length) || Buffer.byteLength(JSON.stringify(make(lo)), 'utf8') > budgetBytes)
          throw new AdlError('E_RESOURCE_LIMIT');
        return make(lo);
      }
      if (options.text) {
        if (s.target.surface !== 'browser' || !s.adapter.readText) throw new AdlError('E_UNSUPPORTED_ACTION');
        if (
          options.cursor !== undefined ||
          options.since_revision !== undefined ||
          options.scope !== undefined ||
          options.include !== undefined ||
          options.depth !== undefined ||
          options.format !== undefined ||
          options.representation !== undefined
        )
          throw invalid('text');
        const { element_id, offset = 0, length = 4096 } = options.text;
        if (!Number.isInteger(offset) || offset < 0 || offset > 1048576) throw invalid('text.offset');
        if (!Number.isInteger(length) || length < 1 || length > 8192) throw invalid('text.length');
        const internal = this.internalId(s.id, element_id);
        if (!s.raw.elements.some(e => e.id === internal)) throw new AdlError('E_TARGET_NOT_FOUND');
        const read = await this.deadline(
          sig => s.adapter.readText!(internal, offset, length, sig),
          this.policy.actionTimeoutMs,
          cancel,
        );
        const chars = Array.from(read.text);
        const make = (count: number): ObserveResult => {
          const content = chars.slice(0, count).join(''),
            next = offset + content.length < read.total_length ? offset + content.length : null;
          const redactions = (content.match(/\[redacted\]/g) ?? []).length;
          return {
            ok: true,
            revision: s.revision,
            ...(s.raw.read_only ? { read_only: true as const } : {}),
            ...(redactions > 0 ? { redactions } : {}),
            truncated: read.truncated || next !== null,
            text: {
              element_id,
              offset,
              content,
              total_length: read.total_length,
              next_offset: next,
              ...(read.hidden_text ? { hidden_text: true as const } : {}),
            },
          };
        };
        let lo = 0,
          hi = chars.length;
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          if (Buffer.byteLength(JSON.stringify(make(mid)), 'utf8') <= budgetBytes) lo = mid;
          else hi = mid - 1;
        }
        if (!lo && chars.length) throw new AdlError('E_RESOURCE_LIMIT');
        return make(lo);
      }
      const result = this.snapshots.observe(s.id, s.revision, {
        ...options,
        token_budget: undefined,
        byte_budget: budgetBytes,
        element_limit: this.policy.maxElements,
      });
      // Warnings are reported once: the first page of an observation delivers them, later pages and observations of the same revision do not repeat
      // them, and the adapter forgets the blocks up to this snapshot (a block that happens later still makes a new revision).
      if (options.cursor === undefined && result.warnings?.length) {
        this.snapshots.markWarningsDelivered(s.id, s.revision);
        s.adapter.acknowledgeWarnings?.(s.raw.warningSeq ?? Number.MAX_SAFE_INTEGER);
      }
      return result;
    });
  }
  /**
   * Reports this engine's own approval requests. With waitMs (0-30000) it polls the broker every 500 ms until a request is decided, withdrawn or
   * expired, the wait ends, or the caller / engine cancels: timed_out:true means every request it reported is still pending. For ordinary requests
   * it only reads: it never decides, consumes or withdraws one, and it holds no session lane. Held writes are the exception: learning of their
   * decision (or that the page abandoned them) carries it out, as the engine's own watcher does, and the settled row is reported at once.
   * Requests that already ended are listed only for an explicit request_id (with sent / response_status for held writes); without one only pending
   * requests are listed.
   */
  async approvals(requestId?: string, waitMs = 0, cancel?: AbortSignal) {
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) throw invalid('wait_ms');
    const started = Date.now(),
      deadline = started + waitMs;
    const signal = AbortSignal.any([this.master.signal, ...(cancel ? [cancel] : [])]);
    const cancelled = () =>
      new AdlError('E_CANCELLED', this.stopped || !this.operationAllowed() ? 'emergency_stop' : undefined);
    let waited = false;
    for (;;) {
      if (signal.aborted) throw cancelled();
      const requests: ApprovalRow[] = [];
      if (this.approval) {
        // A request that is being settled (by the watcher, another report or the session closing) is reported when its ending is complete.
        for (const [id, settling] of [...this.heldSettlements])
          if (!requestId || id === requestId) await settling.catch(() => undefined);
        for (const entry of [...this.approvalPending.values()].filter(p => !requestId || p.request_id === requestId)) {
          if (entry.hold) {
            await this.checkHold(entry);
            const ended = this.approvalEnded.get(entry.request_id);
            requests.push(
              ended && entry.hold.settling
                ? await this.endedRow(entry.request_id, ended, signal)
                : {
                    request_id: entry.request_id,
                    status: 'pending',
                    expires_at: entry.expires_at,
                    summary: entry.summary,
                  },
            );
            continue;
          }
          // The broker forgets a request once it has expired, so one past its expiry is reported without asking.
          const reply =
            entry.expires_at <= Date.now()
              ? undefined
              : await this.approval.request('GET', `/v1/requests/${entry.request_id}`, entry);
          const granted = entry.granted ?? (reply && this.grantedBy(entry, reply));
          requests.push({
            request_id: entry.request_id,
            status: reply?.status ?? 'expired',
            expires_at: entry.expires_at,
            summary: entry.summary,
            ...(granted ? { granted } : {}),
          });
        }
        const ended = requestId ? this.approvalEnded.get(requestId) : undefined;
        if (requestId && ended && ended.expires > Date.now() && !requests.some(r => r.request_id === requestId))
          requests.push(await this.endedRow(requestId, ended, signal));
      }
      const pending = requests.length > 0 && requests.every(r => r.status === 'pending');
      if (!pending || Date.now() >= deadline)
        return {
          ok: true,
          requests: requests.map(row => ({ ...row, save: saveAfterApproval(row.status, row.sent) })),
          waited_ms: waited ? Date.now() - started : 0,
          ...(pending && waitMs > 0 ? { timed_out: true } : {}),
        };
      waited = true;
      try {
        await delay(Math.min(500, Math.max(0, deadline - Date.now())), undefined, { signal });
      } catch {
        throw cancelled();
      }
    }
  }
  /** The row of a request that ended. Released held writes also report the page request's answer, waiting briefly for one that is still on its way. */
  private async endedRow(requestId: string, ended: EndedApproval, signal?: AbortSignal): Promise<ApprovalRow> {
    const adapter = ended.hold?.adapter;
    const outcome = () => (ended.hold ? adapter?.heldWriteOutcome?.(ended.hold.id) : undefined);
    if (ended.sent && !ended.outcomeKnown && adapter?.heldWriteOutcome) {
      // Only for a short while after the release: a request that is never answered does not slow every later report.
      const until = (ended.sentAt ?? 0) + HELD_RESPONSE_WAIT_MS;
      while (!outcome() && Date.now() < until && !signal?.aborted)
        await delay(25, undefined, signal ? { signal } : undefined).catch(() => undefined);
      const result = outcome();
      if (result) {
        ended.outcomeKnown = true;
        if (result.response_status !== undefined) ended.response_status = result.response_status;
        // Released is not sent: a request refused at dispatch (guard, DNS, the expiry re-check) never left, and a set is sent whole or not at all.
        if ((result.refused ?? 0) > 0) ended.sent = false;
      }
    }
    return {
      request_id: requestId,
      status: ended.status,
      expires_at: ended.expires,
      summary: ended.summary,
      ...(ended.sent !== undefined ? { sent: ended.sent } : {}),
      ...(ended.response_status !== undefined ? { response_status: ended.response_status } : {}),
      ...(ended.granted ? { granted: ended.granted } : {}),
    };
  }
  /** Creates (or resolves) the approval for an action: always throws E_APPROVAL_REQUIRED with the new request id, or returns the expiry of the approval it consumed. */
  private async approvalFor(
    s: Session,
    action: Omit<Action, 'action'> & { action: string },
    expected: number,
    proof: ApprovalProof,
    actionEvidence?: { navigation: string; element?: string },
    holdId?: string,
  ): Promise<number> {
    return (await this.resolveApproval(s, action, expected, proof, actionEvidence, true, holdId))!;
  }
  /**
   * Identifies the request a human approves independent of response shaping: the same action on the same session and target.
   * dispatchOnly also leaves out expected_target, an extra check that changes nothing about what is dispatched: the key of "this is the same click".
   */
  private requestKeyFor(s: Session, action: Omit<Action, 'action'> & { action: string }, dispatchOnly = false): string {
    const { include_diff: _format, timeout_ms: _deadline, expected_target: check, ...rest } = action as Action;
    const request = dispatchOnly ? rest : { ...rest, ...(check !== undefined ? { expected_target: check } : {}) };
    return createHmac('sha256', this.approvalKey)
      .update(JSON.stringify(canonical({ request, session: s.id, target: s.target.target_id })))
      .digest('hex');
  }
  /**
   * Resolves the pending approval for this session's identical action: pending -> E_APPROVAL_REQUIRED with the same request id, denied, expired or
   * withdrawn -> refusal, approved -> consumed (the expiry is returned). Without an entry, create=true opens a new request (and throws
   * E_APPROVAL_REQUIRED with its id) while create=false returns undefined and neither contacts the broker nor changes any state.
   */
  private async resolveApproval(
    s: Session,
    action: Omit<Action, 'action'> & { action: string },
    expected: number,
    proof: ApprovalProof,
    actionEvidence: { navigation: string; element?: string } | undefined,
    create: boolean,
    holdId?: string,
  ): Promise<number | undefined> {
    if (!this.operationAllowed()) throw new AdlError('E_CANCELLED', 'emergency_stop');
    if (!this.approval) {
      if (!create) return undefined;
      throw new AdlError('E_APPROVAL_REQUIRED', 'approval_unavailable');
    }
    let existing = this.approvalPending.get(s.id);
    // Held writes of an expired request must be aborted, not forgotten.
    if (existing?.hold && existing.expires_at <= Date.now()) {
      await this.settleHold(existing, 'expired', true);
      existing = undefined;
    }
    const freshness = actionEvidence
      ? { actionEvidence, actionEpoch: s.actionEpoch }
      : { revision: expected, fingerprint: s.raw.fingerprint };
    // Response shaping and client deadlines do not change what a human approves.
    const { include_diff: _format, timeout_ms: _deadline, ...request } = action as Action;
    const requestKey = this.requestKeyFor(s, action);
    const binding = createHmac('sha256', this.approvalKey)
      .update(
        JSON.stringify(
          canonical({
            action: request,
            session: s.id,
            target: s.target.target_id,
            ...freshness,
            proof: proof.proof,
            epoch: this.approval.epoch,
            server: this.approvalServerId,
          }),
        ),
      )
      .digest('hex');
    for (const [key, tombstone] of this.approvalTerminal)
      if (tombstone.expires <= Date.now()) this.approvalTerminal.delete(key);
    const ended = this.approvalTerminal.get(binding);
    if (ended) throw approvalRefusal(ended.status);
    if (existing) {
      // A different request must not discard a human decision in progress.
      if (existing.binding !== binding && existing.requestKey !== requestKey && existing.expires_at > Date.now())
        throw new AdlError('E_APPROVAL_REQUIRED', 'approval_pending_other_action');
      if (existing.binding !== binding || existing.expires_at <= Date.now()) {
        const expired = existing.expires_at <= Date.now();
        if (existing.hold) await this.settleHold(existing, expired ? 'expired' : 'invalidated', true);
        else {
          this.approvalPending.delete(s.id);
          this.recordEnded(existing, expired ? 'expired' : 'invalidated');
          await this.approval.request('DELETE', `/v1/requests/${existing.request_id}`, existing).catch(() => undefined);
        }
        throw new AdlError('E_STALE_STATE', expired ? 'approval_expired' : 'approval_target_changed');
      }
      const reply = await this.approval.request('GET', `/v1/requests/${existing.request_id}`, existing);
      if (reply.status === 'pending') {
        const error = new AdlError('E_APPROVAL_REQUIRED');
        error.requestId = existing.request_id;
        throw error;
      }
      this.approvalPending.delete(s.id);
      // Whatever the broker decided is final for this exact action: remember how it ended (an approval is spent once it is looked at).
      this.approvalTerminal.set(binding, {
        expires: existing.expires_at,
        status: reply.status === 'approved' ? 'consumed' : (reply.status as TerminalApproval),
      });
      const granted = existing.granted ?? this.grantedBy(existing, reply);
      this.recordEnded(
        existing,
        reply.status === 'approved' ? 'consumed' : (reply.status as TerminalApproval),
        granted ? { granted } : {},
      );
      if (reply.status === 'denied' || reply.status === 'expired') throw approvalRefusal(reply.status);
      if (reply.status !== 'approved' || !this.operationAllowed()) throw approvalRefusal('invalidated');
      const consumed = await this.approval.request('DELETE', `/v1/requests/${existing.request_id}`, existing);
      if (
        consumed.status !== 'consumed' ||
        consumed.consumed_now !== true ||
        !this.operationAllowed() ||
        existing.expires_at <= Date.now()
      )
        throw approvalRefusal('invalidated');
      return existing.expires_at;
    }
    if (!create) return undefined;
    for (const entry of [...this.approvalPending.values()])
      if (entry.expires_at <= Date.now()) {
        if (entry.hold) await this.settleHold(entry, 'expired', true);
        else this.approvalPending.delete(entry.session_id);
      }
    if (this.approvalPending.size >= 8 || this.approvalTerminal.size + this.approvalPending.size >= 128)
      throw new AdlError('E_RESOURCE_LIMIT');
    const raw = action.value,
      value = typeof raw === 'string' ? describeApprovalValue(raw, proof.risk === 'credential') : undefined,
      details = contextualDetails(proof);
    // Browser summaries name the http origin; desktop summaries name the configured application (the window title is the untrusted target label).
    const summary: ApprovalSummary = {
      // Held writes: the control already ran; what the human approves is the request it left waiting.
      action: holdId ? 'send_request' : action.action,
      surface: s.target.surface,
      target: redactString(s.target.label).slice(0, 128),
      ...(proof.origin !== undefined ? { origin: proof.origin } : {}),
      ...(proof.application !== undefined ? { application: proof.application.slice(0, 128) } : {}),
      role: redactString(proof.role).slice(0, 100),
      name: redactString(proof.name).slice(0, 128),
      risk: value?.kind === 'secret' || proof.risk === 'credential' ? 'credential' : 'consequential',
      ...(details ? { details } : {}),
      ...(value ? { value } : {}),
      // Only a request that carries no credential can offer the human the standing site grant.
      ...(proof.grant && value?.kind !== 'secret' && proof.risk !== 'credential' ? { grant: proof.grant } : {}),
    };
    const entry: PendingApproval = {
      request_id: randomUUID(),
      binding,
      requestKey,
      expires_at: Date.now() + 120000,
      session_id: s.id,
      summary,
      ...(actionEvidence ? { baselineRevision: expected } : {}),
      ...(holdId !== undefined
        ? { hold: { id: holdId, adapter: s.adapter, dispatchKey: this.requestKeyFor(s, action, true) } }
        : {}),
    };
    this.approvalPending.set(s.id, entry);
    try {
      const request = {
        v: 1,
        request_id: entry.request_id,
        server_id: this.approvalServerId,
        control_epoch: this.approval.epoch,
        binding,
        expires_at: entry.expires_at,
        summary,
      };
      // The transport also caps the entire envelope. Optional context must not make an otherwise valid request fail.
      if (details !== proof.details && Buffer.byteLength(JSON.stringify(request), 'utf8') > HELD_DETAIL_BYTES) {
        if (proof.details) summary.details = proof.details;
        else delete summary.details;
      }
      const reply = await this.approval.request('POST', '/v1/requests', entry, request);
      // Nothing but a standing site grant (offered in summary.grant) may approve a request before a human has seen it.
      if (reply.status === 'approved' && reply.granted === 'site_writes' && summary.grant)
        entry.granted = 'site_writes';
      else if (reply.status !== 'pending')
        throw approvalRefusal(reply.status === 'approved' ? 'invalidated' : reply.status);
    } catch (error) {
      this.approvalPending.delete(s.id);
      throw error;
    }
    if (entry.granted)
      await this.audit('approval_granted_by_site', {
        session_id: s.id,
        action: summary.action,
        request_id: entry.request_id,
        origin: summary.grant!.origin,
      }).catch(() => undefined);
    // Granted: a form retries at once and consumes it; held writes are released inside the same act (requestHeldWrites).
    const error = new AdlError('E_APPROVAL_REQUIRED', undefined, entry.granted ? { approved: true } : {});
    error.requestId = entry.request_id;
    throw error;
  }
  /** The action-scoped freshness evidence for a browser action at the expected revision: the page proved unchanged for this target since then, or undefined. */
  private freshnessFor(
    s: Session,
    expected: number,
    action: Omit<Action, 'action'> & { action: string },
  ): { navigation: string; element?: string } | undefined {
    if (
      s.target.surface !== 'browser' ||
      action.point ||
      !['click', 'fill', 'select', 'check', 'press', 'scroll', 'navigate', 'back', 'hover'].includes(action.action)
    )
      return undefined;
    const prior = s.actionHistory.get(expected),
      current = s.raw.actionEvidence;
    // Navigation and page scroll depend on the document, not on one element.
    const navigationOnly =
      action.action === 'navigate' || action.action === 'back' || isPageScroll(action as Action, s.target.surface);
    if (
      prior &&
      current &&
      prior.epoch === s.actionEpoch &&
      prior.evidence.navigation === current.navigation &&
      (navigationOnly ||
        (action.element_id &&
          prior.evidence.elements[action.element_id] !== undefined &&
          prior.evidence.elements[action.element_id] === current.elements[action.element_id]))
    )
      return {
        navigation: current.navigation,
        ...(!navigationOnly ? { element: current.elements[action.element_id!] } : {}),
      };
    return undefined;
  }
  /**
   * Ask mode dispatches a submit that is consequential only because it submits under the adapter's submission guard. When the guard has stopped a
   * real submission, nothing has left the browser: refresh, inspect the post-attempt form and open the approval request from that state and revision.
   * Always throws (the request, or the reason none can be made); the identical retry at the returned revision consumes the approval.
   */
  private async requestBlockedSubmission(
    s: Session,
    action: Action,
    blocked: AdlError,
    signal?: AbortSignal,
  ): Promise<never> {
    await this.refresh(s, signal);
    const revision = s.revision;
    const element = action.element_id ? s.raw.elements.find(e => e.id === action.element_id) : undefined;
    // A target the retry could not dispatch on (gone, disabled, protected, now sensitive) is a changed page, not a request to approve.
    if (!element || element.sensitive) throw new AdlError('E_STALE_STATE');
    try {
      authorizeAction(action, element, true);
    } catch {
      throw new AdlError('E_STALE_STATE');
    }
    const again = await s.adapter.prepareAction!(action, signal ?? this.master.signal);
    if (again.submission !== 'plain') throw new AdlError('E_STALE_STATE');
    // A urlencoded same-origin POST is a write the human may grant for the site; a GET form (no network facts) is asked every time.
    const grant =
      again.network && originOf(again.network.url) === again.origin
        ? this.siteGrantFor(again.origin, again.labels ?? [again.name], [again.network.url], false)
        : undefined;
    try {
      await this.approvalFor(
        s,
        action,
        revision,
        { ...again, risk: 'consequential', ...(grant ? { grant } : {}) },
        this.freshnessFor(s, revision, action),
      );
    } catch (created) {
      if (created instanceof AdlError && created.code === 'E_APPROVAL_REQUIRED' && created.requestId)
        throw submissionRequest(created, revision);
      throw created;
    }
    // approvalFor consumed an approval instead of opening one: the form has not been sent, so report the cancelled submission.
    throw blocked;
  }
  /**
   * Ask mode: the action's handler sent write requests (fetch/XHR POST, PUT, PATCH, DELETE) and the adapter holds them unsent. Open one approval
   * for the whole set from the exact request descriptions (the bodies never leave the adapter), bound to the hold: approving releases exactly those
   * requests, once (settleHold). Throws: the request id for the agent to wait on, or the reason none could be made (the requests are aborted
   * then). The dispatched action has run its handler, so the identical action is not the way to finish and is never dispatched again.
   * Returns only when a standing site grant approved the set at the broker: it is then consumed and released inside this call (releaseGranted).
   */
  private async requestHeldWrites(
    s: Session,
    action: Action,
    liveProof: ApprovalProof | undefined,
    error: HeldWritesError,
    signal?: AbortSignal,
  ): Promise<GrantedApprovalResult> {
    const { id, requests } = error.hold;
    const abort = (outcome: HeldWriteAbortOutcome) =>
      Promise.resolve(s.adapter.abortHeldWrites?.(id, outcome)).catch(() => undefined);
    try {
      // The dispatched action moved the page on: the revision the agent observes next already includes its reaction.
      await this.refresh(s, signal);
    } catch (refreshError) {
      await abort('invalidated');
      throw refreshError;
    }
    const details = requests.flatMap(request => request.details);
    if (
      !requests.length ||
      details.length > HELD_DETAIL_LINES ||
      details.some(line => typeof line !== 'string' || line.length > 8192 || line.includes('\0')) ||
      Buffer.byteLength(JSON.stringify({ details }), 'utf8') > HELD_DETAIL_BYTES
    ) {
      // The broker shows at most 25 lines in all: a set that cannot be described completely is never approved on a shortened description.
      await abort('not_approvable');
      throw new AdlError('E_APPROVAL_REQUIRED', 'request_not_approvable', { page_script_ran: true });
    }
    // One destination origin for the whole set, no credential, no money-like control or URL: the human may grant further writes to that site.
    const origins = new Set(requests.map(request => originOf(request.url)));
    const destination = origins.size === 1 ? [...origins][0] : undefined;
    const secret = requests.some(request => request.secret);
    const grant =
      destination !== undefined
        ? this.siteGrantFor(
            destination,
            liveProof?.labels ?? [liveProof?.name ?? ''],
            requests.map(request => request.url),
            secret || liveProof?.risk === 'credential',
          )
        : undefined;
    const proof: ApprovalProof = {
      proof: createHash('sha256')
        .update(
          JSON.stringify(
            canonical({
              element: liveProof?.proof ?? null,
              hold: id,
              requests: requests.map(r => [r.method, r.url, r.content_type, r.body_sha256, r.body_length]),
            }),
          ),
        )
        .digest('hex'),
      risk: secret ? 'credential' : 'consequential',
      role: liveProof?.role ?? 'page',
      name: liveProof?.name ?? '',
      ...(liveProof?.origin !== undefined ? { origin: liveProof.origin } : {}),
      details,
      ...(liveProof?.context ? { context: liveProof.context } : {}),
      ...(grant ? { grant } : {}),
    };
    try {
      await this.approvalFor(s, action, s.revision, proof, undefined, id);
    } catch (created) {
      const entry = this.approvalPending.get(s.id);
      if (
        created instanceof AdlError &&
        created.code === 'E_APPROVAL_REQUIRED' &&
        created.requestId &&
        entry?.request_id === created.requestId &&
        entry.hold?.id === id
      ) {
        // A standing site grant approved it at the broker: consume and release inside this act (the same settlement as after an individual approval).
        if (entry.granted) return this.releaseGranted(entry, signal);
        try {
          // The requests stay held up to the approval's expiry, so the session must outlive it.
          s.keepUntil = entry.expires_at + 30000;
          s.expires = Math.max(s.expires, s.keepUntil);
          void this.watchHold(entry);
          await this.audit('held_request_pending', { session_id: s.id, action: action.action }).catch(() => undefined);
        } catch (unexpected) {
          await this.settleHold(entry, 'invalidated', true);
          throw unexpected;
        }
        throw heldRequestError(entry.request_id);
      }
      await abort('invalidated');
      // The handler has run even though no request could be opened (another approval is pending, a limit, the broker): say so.
      if (created instanceof AdlError) created.detail.page_script_ran = true;
      throw created;
    }
    // Unreachable: the hold id makes the binding unique, so approvalFor always opens a request. Never leave requests held without one.
    await abort('invalidated');
    throw new AdlError('E_INTERNAL');
  }
  /**
   * The broker approved held writes through a standing site grant: consume the approval and release exactly those requests now, by the same
   * settlement as an individual approval (consumed once, operations still allowed, not expired). Returns the sent set with the page's answer, or
   * throws the refusal when nothing (or not the whole set) left: the handler has run either way.
   */
  private async releaseGranted(entry: PendingApproval, signal?: AbortSignal): Promise<GrantedApprovalResult> {
    await this.settleHold(entry, 'approved');
    const ended = this.approvalEnded.get(entry.request_id);
    if (ended?.sent) {
      // Waits briefly for the page request's answer, and learns whether a request was refused at dispatch (then the set was not sent).
      await this.endedRow(entry.request_id, ended, signal);
      if (ended.sent)
        return {
          request_id: entry.request_id,
          status: 'consumed',
          sent: true,
          granted: 'site_writes',
          ...(ended.response_status !== undefined ? { response_status: ended.response_status } : {}),
        };
    }
    const refusal = approvalRefusal(ended && ended.status !== 'consumed' ? ended.status : 'invalidated');
    refusal.detail.page_script_ran = true;
    throw refusal;
  }
  private async action(s: Session, action: Action, expected: number, signal?: AbortSignal) {
    action = {
      ...action,
      ...(action.expected_target ? { expected_target: { ...action.expected_target } } : {}),
      ...(action.point ? { point: { ...action.point } } : {}),
    };
    this.validateAction(action, s.target.surface);
    if (action.element_id !== undefined)
      action = {
        ...action,
        element_id:
          action.action === 'wait_for'
            ? this.internalId(s.id, action.element_id)
            : (this.aliasMaps.get(s.id)?.resolve(action.element_id) ?? UNKNOWN_ELEMENT),
      };
    if (!Number.isSafeInteger(expected) || expected < 1) throw invalid('expected_revision');
    // A page whose DOM APIs cannot be verified cannot be observed, but leaving it
    // reads nothing from it; the adapter re-checks that only navigation proceeds.
    try {
      await this.refresh(s, signal, s.target.surface === 'browser');
    } catch (error) {
      if (!(
        s.target.surface === 'browser' &&
        (action.action === 'navigate' || action.action === 'back') &&
        error instanceof AdlError &&
        error.reason === 'untrusted_dom_api'
      ))
        throw error;
    }
    const pageScroll = isPageScroll(action, s.target.surface);
    const actionEvidence = this.freshnessFor(s, expected, action);
    if (!['read_state', 'wait_for'].includes(action.action) && expected > s.revision)
      throw new AdlError('E_STALE_STATE', 'revision_ahead', {
        argument: 'expected_revision',
        revision: s.revision,
      });
    if (!['read_state', 'wait_for'].includes(action.action) && s.revision !== expected && !actionEvidence) {
      // Held writes are bound to the exact bytes of the page's requests, not to the DOM revision: an agent that acts on an old revision must not
      // abort the save a human is looking at.
      if (!this.approvalPending.get(s.id)?.hold) await this.invalidateApproval(s.id);
      throw new AdlError('E_STALE_STATE', undefined, { revision: s.revision });
    }
    if (action.action === 'read_state') return { ok: true, revision: s.revision };
    if (action.action === 'wait_for')
      return this.waitInternal(
        s,
        { role: action.role, name: action.name, element_id: action.element_id },
        action.timeout_ms ?? this.policy.actionTimeoutMs,
        signal,
      );
    if (s.paused) throw new AdlError('E_POLICY_DENIED');
    if (
      s.target.surface === 'browser' &&
      this.policy.operationMode === 'read_only' &&
      !this.policy.allowAllOperations &&
      !['navigate', 'back', 'scroll'].includes(action.action)
    )
      throw new AdlError('E_POLICY_DENIED', 'read_only_mode');
    if (s.mode === 'interactive_desktop') throw new AdlError('E_UNSUPPORTED_ACTION');
    let pointReference: import('./gesture-types.js').GestureReference | undefined,
      directPoint = false;
    if (action.point) {
      if (s.target.surface !== 'browser' || !s.adapter.resolvePoint) throw new AdlError('E_UNSUPPORTED_ACTION');
      this.visuals.assertRetained(s.id, action.point.frame_id, 30000);
      if (s.latestFrame !== action.point.frame_id) throw new AdlError('E_STALE_STATE');
      const { metadata } = await this.visuals.view(
        s.id,
        action.point.frame_id,
        { max_dimension: 64, max_pixels: 4096 },
        signal ?? this.master.signal,
      );
      if (metadata.revision !== s.revision) throw new AdlError('E_STALE_STATE');
      pointReference = metadata;
      const id = await s.adapter.resolvePoint(action.point, metadata, signal ?? this.master.signal);
      if (id) action = { ...action, element_id: id };
      else {
        if (!this.policy.allowAllOperations || !s.adapter.clickPoint)
          throw new AdlError('E_APPROVAL_REQUIRED', 'operation_not_granted');
        directPoint = true;
      }
    }
    const element = action.element_id ? s.raw.elements.find(e => e.id === action.element_id) : undefined;
    if (!directPoint && !pageScroll && !['navigate', 'back'].includes(action.action) && !element)
      throw new AdlError('E_TARGET_NOT_FOUND');
    if (
      action.expected_target &&
      (!element ||
        (action.expected_target.role !== undefined && action.expected_target.role !== element.role) ||
        (action.expected_target.name !== undefined &&
          action.expected_target.name !== redactElement(element, this.policy.allowPersonalData).name))
    )
      throw new AdlError('E_STALE_STATE');
    const tiered =
      !this.policy.allowAllOperations && ['standard', 'ask'].includes(this.policy.operationMode ?? 'read_only');
    const modern = tiered && s.target.surface === 'browser' && !['navigate', 'back', 'scroll'].includes(action.action);
    // Native tiers: the same vocabulary gates desktop controls; ask routes consequential controls through the one-shot approval, sensitive controls stay refused.
    const nativeTier = tiered && s.target.surface === 'desktop' && !this.desktopConfig()?.controlsPath;
    let liveProof: (ApprovalProof & { submission?: 'plain'; contained?: boolean }) | undefined;
    let approved = false,
      approvalExpires: number | undefined,
      plainAsk = false;
    // A desktop target whose helper grants no mutation at all (read_only) refuses every mutation with the setting to change,
    // before a vocabulary check could suggest an approval. The adapter's advertised capabilities are the grant actually in force.
    const nativeMutations = ['click', 'fill', 'select', 'check', 'scroll'];
    if (
      s.target.surface === 'desktop' &&
      nativeMutations.includes(action.action) &&
      !s.target.capabilities.some(capability => nativeMutations.includes(capability))
    )
      throw new AdlError('E_POLICY_DENIED', 'desktop_operation_not_granted');
    if (modern) {
      if (!s.adapter.prepareAction) throw new AdlError('E_POLICY_DENIED');
      authorizeAction(action, element, true);
      // The identical action while its writes are held for a human: the same request, nothing is dispatched again (the page's handler has run).
      const holding = this.approvalPending.get(s.id);
      if (holding?.hold && holding.hold.dispatchKey === this.requestKeyFor(s, action, true))
        throw heldRequestError(holding.request_id);
      liveProof = await s.adapter.prepareAction(action, signal ?? this.master.signal);
      if (element?.sensitive) liveProof = { ...liveProof, risk: 'credential' };
      const sensitiveValue = typeof action.value === 'string' && describeApprovalValue(action.value).kind === 'secret';
      // A verb that may stay in the session ("Delete") is dispatched with the network closed to new requests (see armContainment): standard mode
      // has nobody to ask, and in ask mode (with an adapter that can hold writes) the only effect that can leave, a write request, is held for the
      // human with its exact content; an adapter that cannot hold them keeps the approval before dispatch.
      const contained =
        liveProof.contained &&
        liveProof.risk === 'consequential' &&
        (this.policy.operationMode === 'standard' ||
          (this.policy.operationMode === 'ask' && !!this.approval && typeof s.adapter.setWriteHolding === 'function'));
      if (sensitiveValue || (liveProof.risk !== 'ordinary' && !contained)) {
        if (this.policy.operationMode !== 'ask') throw new AdlError('E_APPROVAL_REQUIRED', 'requires_ask_mode');
        approvalExpires = await this.approvalFor(s, action, expected, liveProof, actionEvidence);
        approved = true;
      } else if (this.policy.operationMode === 'ask' && liveProof.submission === 'plain') {
        // Consequential only because it submits: dispatch under the adapter's submission guard like standard mode, and open the request only if
        // the guard stops a real submission (see requestBlockedSubmission). An identical retry resolves the request made then: pending returns
        // the same request id without dispatching again, denied is final, approved is consumed here and dispatched with the body-bound permit.
        plainAsk = true;
        try {
          const decided = await this.resolveApproval(
            s,
            action,
            expected,
            { ...liveProof, risk: 'consequential' },
            actionEvidence,
            false,
          );
          if (decided !== undefined) {
            approvalExpires = decided;
            approved = true;
          }
        } catch (error) {
          if (error instanceof AdlError && error.code === 'E_APPROVAL_REQUIRED' && error.requestId)
            throw submissionRequest(error, expected);
          throw error;
        }
      }
    } else if (nativeTier) {
      // The helpers also treat confirm/cancel/order as consequential: decide them here so ask mode can still route them through the approval.
      try {
        authorizeAction(action, element, false);
        if (action.action !== 'scroll' && isNativeConsequential(element?.name ?? ''))
          throw new AdlError('E_APPROVAL_REQUIRED', 'consequential_operation');
      } catch (error) {
        if (
          !(
            error instanceof AdlError &&
            error.code === 'E_APPROVAL_REQUIRED' &&
            error.reason === 'consequential_operation'
          ) ||
          this.policy.operationMode !== 'ask' ||
          !element
        )
          throw error;
        // A secret-looking value is never shown to or approved by the host; the native proof binds the exact element identity within the observed revision.
        if (
          typeof action.value === 'string' &&
          (action.value.includes('[redacted]') || redactString(action.value) !== action.value)
        )
          throw new AdlError('E_PRIVACY_BLOCKED');
        const identity = createHash('sha256')
          .update(
            JSON.stringify(
              canonical({
                application: s.target.application_id,
                element: element.id,
                role: element.role,
                name: element.name,
                value: element.value,
                checked: element.checked,
                selected: element.selected,
              }),
            ),
          )
          .digest('hex');
        liveProof = {
          proof: 'native-element:' + identity,
          risk: 'consequential',
          role: element.role,
          name: redactElement(element, this.policy.allowPersonalData).name,
          application: s.target.application_id,
        };
        approvalExpires = await this.approvalFor(s, action, expected, liveProof);
        approved = true;
      }
    } else if (!directPoint) authorizeAction(action, element, this.policy.allowAllOperations);
    this.inputProofs.invalidateSession(s.id);
    await this.audit('action_started', { session_id: s.id, action: action.action });
    let acknowledged = false,
      dispatched = false;
    const beforeRevision = s.revision,
      beforeWarnings = s.raw.warnings;
    // Ask mode with an approver: a write the page sends during this action is held for a human instead of blocked.
    const holdWrites = modern && this.policy.operationMode === 'ask' && !!this.approval;
    try {
      const outcome = await this.deadline(
        sig => {
          const dispatch = () => {
            if (
              sig.aborted ||
              !this.operationAllowed() ||
              (approvalExpires !== undefined && approvalExpires <= Date.now())
            )
              throw new AdlError('E_POLICY_DENIED');
            if (!dispatched) s.actionEpoch++;
            dispatched = true;
          };
          if (!s.adapter.tracksDispatch) dispatch();
          if (directPoint) return s.adapter.clickPoint!(action.point!, pointReference!, sig, dispatch);
          return s.adapter.act(
            action,
            sig,
            dispatch,
            liveProof || pointReference || actionEvidence
              ? {
                  ...(liveProof
                    ? {
                        normalOperations: true,
                        approvalProof: liveProof.proof,
                        approved,
                        ...(approvalExpires !== undefined ? { expires_at: approvalExpires } : {}),
                        ...(holdWrites ? { holdWrites: true } : {}),
                      }
                    : {}),
                  ...(pointReference ? { pointReference } : {}),
                  ...(actionEvidence ? { actionEvidence } : {}),
                }
              : undefined,
          );
        },
        Math.min(action.timeout_ms ?? this.policy.actionTimeoutMs, this.policy.actionTimeoutMs),
        signal,
      );
      acknowledged = true;
      return await this.completeAction(
        s,
        action,
        outcome as AdapterActResult | undefined,
        beforeRevision,
        beforeWarnings,
        signal,
      );
    } catch (error) {
      const safe = error instanceof AdlError ? error : new AdlError('E_INTERNAL');
      if (
        acknowledged ||
        (dispatched &&
          !(error instanceof NativeError) &&
          (safe.code === 'E_TIMEOUT' || safe.code === 'E_CANCELLED' || !(error instanceof AdlError)))
      )
        safe.mayHaveExecuted = true;
      if (safe.mayHaveExecuted) await this.destroy(s);
      // The action left write requests held unsent in the browser: a human is asked for their exact content (throws), unless a standing site grant
      // already approved them, in which case they have been sent and the action completes like any other.
      if (error instanceof HeldWritesError && !safe.mayHaveExecuted) {
        const released = await this.requestHeldWrites(s, action, liveProof, error, signal);
        try {
          return await this.completeAction(s, action, undefined, beforeRevision, beforeWarnings, signal, released);
        } catch (completion) {
          // The writes are out: failing to observe their effect may not be reported as a clean refusal.
          const failed = completion instanceof AdlError ? completion : new AdlError('E_INTERNAL');
          failed.mayHaveExecuted = true;
          await this.destroy(s);
          throw failed;
        }
      }
      if (
        plainAsk &&
        !approved &&
        !safe.mayHaveExecuted &&
        safe.code === 'E_APPROVAL_REQUIRED' &&
        safe.reason === 'form_submission_requires_approval'
      )
        await this.requestBlockedSubmission(s, action, safe, signal);
      throw safe;
    }
  }
  /**
   * The result of an action that was carried out: the page refreshed, the audit written, the blocks of its window and (include_diff) what changed.
   * released is set when a standing site grant sent the action's held writes inside the act (the result then carries the approval and no blocks).
   */
  private async completeAction(
    s: Session,
    action: Action,
    adapterResult: AdapterActResult | undefined,
    beforeRevision: number,
    beforeWarnings: NetworkWarning[] | undefined,
    signal?: AbortSignal,
    released?: GrantedApprovalResult,
  ) {
    // The page reacts to the answer of a released write after it was handed over: give it the adapter's quiet window before looking (timing only).
    if (released) await delay(HELD_SETTLE_MS, undefined, signal ? { signal } : undefined).catch(() => undefined);
    delete s.latestFrame;
    await this.refresh(s, signal);
    const audit_id = await this.audit('action_completed', { session_id: s.id, action: action.action });
    // An action result carries exactly the blocks recorded between its dispatch and the end of its window (adapters without them: what is new in the
    // snapshot warnings); anything older or later is reported once by the next observation. network_blocked reports only blocks the action itself
    // caused (navigation, fetch/XHR, writes); unrelated blocked subresources are counted apart; write_blocked says a write (POST, PUT, PATCH, DELETE)
    // was blocked, so the page's state was not saved. Adapter notices (target_replaced) lead the list.
    // A set a site grant released had its window blocks adopted by the document when the act ended: the next observation reports them once.
    const blocks = released ? [] : (adapterResult?.blocks ?? newBlocks(beforeWarnings, s.raw.warnings)),
      networkBlocked = blocks.some(isActionNetworkBlock),
      writeBlocked = blocks.some(isWriteBlock),
      subresourcesBlocked = blocks
        .filter(block => !isActionNetworkBlock(block))
        .reduce((total, block) => total + block.count, 0);
    const warnings: (AdapterWarning | NetworkWarning)[] = [...(adapterResult?.warnings ?? []), ...blocks];
    let observation: Omit<ObserveResult, 'ok' | 'revision' | 'warnings'> | undefined,
      observation_error: ReturnType<typeof safeError> | undefined;
    if (action.include_diff) {
      try {
        // The outer result already carries ok, revision and warnings.
        const {
          ok: _ok,
          revision: _revision,
          warnings: _warnings,
          ...nested
        } = this.snapshots.observe(s.id, s.revision, {
          token_budget: this.policy.defaultTokenBudget,
          since_revision: beforeRevision,
          element_limit: this.policy.maxElements,
          representation: 'auto',
        });
        observation = nested;
      } catch (error) {
        observation_error = safeError(error);
      }
    }
    return {
      ok: true,
      revision: s.revision,
      audit_id,
      // The held writes of this action were sent by a standing site grant: nothing is left to wait for (adl_approvals only reports it).
      ...(released ? { approval: released } : {}),
      // A navigation that landed on an error page (400 or higher) says so; observations carry the same field.
      ...((action.action === 'navigate' || action.action === 'back') && s.raw.http_status !== undefined
        ? { http_status: s.raw.http_status }
        : {}),
      ...(networkBlocked ? { network_blocked: true } : {}),
      ...(subresourcesBlocked > 0 ? { subresources_blocked: subresourcesBlocked } : {}),
      ...(writeBlocked ? { write_blocked: true } : {}),
      ...(s.target.surface === 'browser' && ['click', 'fill', 'select', 'check', 'press'].includes(action.action)
        ? { save: saveAfterAction(writeBlocked, released?.sent === true) }
        : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(observation ? { observation } : {}),
      ...(observation_error ? { observation_error } : {}),
    };
  }
  act(session_id: string, action: Action, expected_revision: number, cancel?: AbortSignal) {
    const captured = {
      ...action,
      ...(action.expected_target ? { expected_target: { ...action.expected_target } } : {}),
      ...(action.point ? { point: { ...action.point } } : {}),
    };
    return this.sessionLane(session_id, () => this.action(this.get(session_id), captured, expected_revision, cancel));
  }
  private async waitInternal(s: Session, condition: Condition, timeout: number, cancel?: AbortSignal) {
    if (!condition.role && !condition.name && !condition.element_id) throw invalid('condition');
    return this.deadline(
      async signal => {
        while (true) {
          await this.refresh(s, signal, true);
          const element = s.raw.elements
            .map(e => redactElement(e, this.policy.allowPersonalData))
            .find(
              e =>
                (!condition.element_id || e.id === condition.element_id) &&
                (!condition.role || e.role === condition.role) &&
                (!condition.name || e.name.includes(condition.name)),
            );
          const matched =
            condition.state === 'hidden' ? !element : condition.state === 'enabled' ? !!element?.enabled : !!element;
          if (matched) return { ok: true, revision: s.revision, matched: true };
          await delay(50, undefined, { signal });
        }
      },
      Math.min(timeout, 30000),
      cancel,
    ).catch(async error => {
      if (error instanceof AdlError && error.code === 'E_CANCELLED') await this.destroy(s);
      throw error;
    });
  }
  wait(session_id: string, condition: Condition, timeout_ms: number, cancel?: AbortSignal) {
    return this.sessionLane(session_id, () => {
      const s = this.get(session_id);
      return this.waitInternal(
        s,
        condition.element_id !== undefined
          ? { ...condition, element_id: this.internalId(s.id, condition.element_id) }
          : condition,
        timeout_ms,
        cancel,
      );
    });
  }
  private validateAction(action: Action, surface: 'browser' | 'desktop') {
    if (action.include_diff !== undefined && typeof action.include_diff !== 'boolean') throw invalid('include_diff');
    if (
      ![
        'click',
        'fill',
        'select',
        'check',
        'scroll',
        'navigate',
        'read_state',
        'wait_for',
        'press',
        'back',
        'hover',
      ].includes(action.action)
    )
      throw invalid('action');
    if (['press', 'back', 'hover'].includes(action.action) && surface !== 'browser')
      throw new AdlError('E_UNSUPPORTED_ACTION');
    if (
      action.action === 'press' &&
      ![
        'Enter',
        'Escape',
        'Tab',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Home',
        'End',
        'PageUp',
        'PageDown',
        'Space',
      ].includes(action.value ?? '')
    )
      throw invalid('value');
    if (action.action === 'navigate') {
      try {
        const url = new URL(action.url!);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
      } catch {
        throw invalid('url');
      }
    }
    if (
      (action.action === 'fill' || (action.action === 'select' && surface === 'browser')) &&
      typeof action.value !== 'string'
    )
      throw invalid('value');
    if (action.action === 'scroll' && surface === 'desktop' && !action.direction) throw invalid('direction');
    if (action.action === 'check' && typeof action.checked !== 'boolean') throw invalid('checked');
    if (
      action.point &&
      (action.action !== 'click' ||
        surface !== 'browser' ||
        typeof action.point.frame_id !== 'string' ||
        !action.point.frame_id ||
        ![action.point.x, action.point.y].every(v => Number.isFinite(v) && v >= 0 && v < 4096) ||
        action.element_id)
    )
      throw invalid('point');
    // A browser scroll without element_id scrolls the page itself and needs the direction.
    const pageScroll = isPageScroll(action, surface);
    if (
      ['click', 'fill', 'select', 'check', 'scroll', 'press', 'hover'].includes(action.action) &&
      !action.element_id &&
      !action.point &&
      !pageScroll
    )
      throw invalid('element_id');
    if (pageScroll && (action.direction === undefined || action.expected_target !== undefined))
      throw invalid(action.direction === undefined ? 'direction' : 'expected_target');
    if (action.direction !== undefined && !['up', 'down'].includes(action.direction)) throw invalid('direction');
    if (action.timeout_ms !== undefined && (!Number.isSafeInteger(action.timeout_ms) || action.timeout_ms < 1))
      throw invalid('timeout_ms');
    if (action.action === 'wait_for' && !action.role && !action.name && !action.element_id) throw invalid('condition');
    if (action.expected_target && !expectedTargetSchema.safeParse(action.expected_target).success)
      throw invalid('expected_target');
  }
  execute(steps: Step[], expected_revisions: Record<string, number>) {
    if (this.stopped || !this.operationAllowed())
      throw new AdlError('E_CANCELLED', this.stopped || !this.operationAllowed() ? 'emergency_stop' : undefined);
    if (!steps.length || steps.length > this.policy.maxBatchSteps) throw invalid('steps');
    // Validation and asynchronous execution must use the same caller-independent plan.
    steps = steps.map(step => ({
      ...step,
      ...(step.expected_target ? { expected_target: { ...step.expected_target } } : {}),
      ...(step.point ? { point: { ...step.point } } : {}),
      ...(step.condition ? { condition: { ...step.condition } } : {}),
    }));
    expected_revisions = { ...expected_revisions };
    for (const step of steps) {
      this.get(step.session_id);
      const expected = expected_revisions[step.session_id];
      if (!Number.isSafeInteger(expected) || (expected ?? 0) < 1) throw invalid('expected_revisions');
      if (
        step.expected_revision !== undefined &&
        (!Number.isSafeInteger(step.expected_revision) || step.expected_revision < 1)
      )
        throw invalid('expected_revision');
      if (expected! > this.get(step.session_id).revision)
        throw new AdlError('E_STALE_STATE', 'revision_ahead', {
          argument: 'expected_revisions',
          revision: this.get(step.session_id).revision,
        });
      this.validateAction(step, this.get(step.session_id).target.surface);
    }
    if (this.tasks.size >= 128) {
      const done = [...this.tasks.values()].find(t => !['queued', 'running'].includes(t.status));
      if (done) this.tasks.delete(done.id);
      else throw new AdlError('E_RESOURCE_LIMIT', 'task_limit', { limit: 128 });
    }
    const task: Task = {
      id: `task_${randomUUID()}`,
      status: 'queued',
      controller: new AbortController(),
      results: [],
      created: Date.now(),
    };
    this.tasks.set(task.id, task);
    void Promise.resolve()
      .then(async () => {
        if (task.controller.signal.aborted)
          throw new AdlError('E_CANCELLED', this.stopped || !this.operationAllowed() ? 'emergency_stop' : undefined);
        task.status = 'running';
        const expected = { ...expected_revisions };
        for (const [step_index, step] of steps.entries()) {
          if (task.controller.signal.aborted)
            throw new AdlError('E_CANCELLED', this.stopped || !this.operationAllowed() ? 'emergency_stop' : undefined);
          try {
            const result = await this.sessionLane(step.session_id, async () => {
              const s = this.get(step.session_id);
              const outcome = await this.action(
                s,
                step,
                step.expected_revision ?? expected[s.id]!,
                task.controller.signal,
              );
              expected[s.id] = s.revision;
              return outcome;
            });
            task.results.push({ step_index, status: 'completed', ...result });
          } catch (error) {
            task.results.push({ step_index, status: 'failed', error: safeError(error) });
            throw error;
          }
        }
        task.status = 'completed';
      })
      .catch(error => {
        task.error = safeError(error);
        task.status = task.controller.signal.aborted ? 'cancelled' : 'failed';
        for (let i = task.results.length; i < steps.length; i++)
          task.results.push({ step_index: i, status: 'not_executed' });
      });
    return { ok: true, task_id: task.id, status: task.status };
  }
  task(task_id: string, command: 'status' | 'cancel' = 'status') {
    const t = this.tasks.get(task_id);
    if (!t || (!['queued', 'running'].includes(t.status) && Date.now() - t.created > this.policy.sessionTtlMs)) {
      this.tasks.delete(task_id);
      throw new AdlError('E_TARGET_NOT_FOUND');
    }
    if (command === 'cancel' && ['queued', 'running'].includes(t.status)) t.controller.abort();
    return {
      ok: true,
      task_id: t.id,
      status: t.status,
      results: t.results.map(r => ({ ...r })),
      ...(t.error ? { error: t.error } : {}),
    };
  }
  close(session_id: string) {
    return this.sessionLane(session_id, async () => {
      const s = this.get(session_id);
      await this.destroy(s);
      return { ok: true, closed: true };
    });
  }
  private lifecyclePlatformSupported() {
    return this.platform === 'darwin' || this.platform === 'win32';
  }
  private lifecycleAdapter(): Adapter | undefined {
    const config = this.desktopConfig();
    const adapter = this.adapters.desktop;
    return config?.lifecycle?.enabled === true && typeof adapter?.application === 'function' ? adapter : undefined;
  }
  applications() {
    return this.enqueue(async () => {
      const adapter = this.lifecycleAdapter();
      if (!adapter || !this.lifecyclePlatformSupported())
        return { ok: true, applications: [] as { application_id: string; capabilities: string[]; mode: string }[] };
      const config = this.desktopConfig()!;
      return {
        ok: true,
        applications: [
          { application_id: config.appId, capabilities: ['status', 'launch', 'quit'], mode: 'background_semantic' },
        ],
      };
    });
  }
  application(application_id: string, action: 'status' | 'launch' | 'quit', cancel?: AbortSignal) {
    return this.enqueue(() =>
      this.enqueueDesktop(async () => {
        if (this.stopped || !this.operationAllowed())
          throw new AdlError('E_CANCELLED', this.stopped || !this.operationAllowed() ? 'emergency_stop' : undefined);
        if (!this.lifecyclePlatformSupported())
          throw new AdlError('E_UNSUPPORTED_ACTION', this.platform === 'linux' ? 'platform_unsupported' : undefined);
        const adapter = this.lifecycleAdapter();
        if (!adapter || (action !== 'status' && action !== 'launch' && action !== 'quit'))
          throw new AdlError('E_POLICY_DENIED');
        const config = this.desktopConfig()!;
        if (application_id !== config.appId) throw new AdlError('E_POLICY_DENIED');
        let dispatched = false;
        const state = await this.deadline(
          async signal => {
            dispatched = true;
            return adapter.application!(application_id, action, signal);
          },
          this.policy.actionTimeoutMs,
          cancel,
        ).catch((error: unknown) => {
          if (
            action !== 'status' &&
            dispatched &&
            error instanceof AdlError &&
            (cancel?.aborted ||
              this.master.signal.aborted ||
              error.code === 'E_TIMEOUT' ||
              error.code === 'E_CANCELLED')
          )
            error.mayHaveExecuted = true;
          throw error;
        });
        try {
          // An acknowledged quit has already changed native state. Retire its
          // handles even if the subsequent audit write fails.
          if (action === 'quit' && state.changed) {
            for (const s of [...this.sessions.values()])
              if (s.target.surface === 'desktop' && s.target.application_id === config.appId) await this.destroy(s);
            this.replaceDesktopTargets([]);
          }
          await this.audit('application_lifecycle', { action });
          return { ok: true, application_id, ...state };
        } catch (error) {
          const safe = error instanceof AdlError ? error : new AdlError('E_INTERNAL');
          if (action !== 'status' && state.changed) safe.mayHaveExecuted = true;
          throw safe;
        }
      }),
    );
  }
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopped = true;
    // Publish the shared completion before abort listeners or adapter callbacks
    // can reenter shutdown. Every caller waits for all cleanup attempts.
    this.shutdownPromise = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.sessions.values()].map(s => this.destroy(s)));
      await Promise.allSettled(
        [this.adapters.browser, this.adapters.desktop].map(adapter => Promise.resolve().then(() => adapter?.close())),
      );
      this.snapshots.clear();
    });
    clearInterval(this.timer);
    this.master.abort();
    this.visuals.clear();
    this.inputProofs.clear();
    for (const t of this.tasks.values()) t.controller.abort();
    return this.shutdownPromise;
  }
}
