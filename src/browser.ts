import * as crypto from 'node:crypto';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type JSHandle,
  type ElementHandle,
  type Frame,
  type Page,
  type Route,
  type Request,
} from 'playwright';
import { resolveAllowedAddresses, redactString, redactText, redactUrl } from './policy.js';
import {
  pinnedFetch,
  redirectStylesheet,
  PinnedConnectionPool,
  MAX_BODY,
  HOP_RE,
  type FetchResult,
} from './browser-network.js';
import { BrowserResourceCache } from './browser-cache.js';
import { captureBrowserImage } from './browser-visual.js';
import { runBrowserGesture, captureGestureGeometry, type GestureGeometry } from './browser-gesture.js';
import { preflightBrowserInput, type PreflightResult } from './browser-preflight.js';
import type { ActionAuthorization } from './types.js';
import { ensurePointSelector, pointSelector } from './browser-point.js';
import { inspectBrowserAction, isolatedCollect, offsetPointOf } from './browser-approval.js';
import { LEGACY_CONTROLS_PATTERN, type LabelLists } from './action-classifier.js';
import {
  nativeClick,
  nativeFill,
  nativeSelect,
  nativeSetChecked,
  shadowsDomApi,
  type NativeInput,
} from './browser-native-input.js';
import {
  installIntegrity,
  installBrowserIntegrity,
  registerBrowserPrototypes,
  type BrowserIntegrity,
} from './browser-integrity.js';
import { IsolatedReadStore, MainDocumentIdentity } from './browser-reading.js';
import { SECRET_LABEL_PATTERN, PERSONAL_LABEL_PATTERN, BROWSER_PRIVACY_RULES } from './privacy.js';
import { readTextPageFn, type PageTextResult } from './browser-text.js';
import { withPersonalContext, personalContextPageFn } from './personal-context.js';
import { readOptionsPageFn, type OptionsPageArgs, type OptionsResult } from './browser-options.js';
import { StartupDiagnostics } from './startup-diagnostics.js';
import { TEXT_REDACTION_RULES, PERSONAL_DATA_REDACTION_RULES } from './privacy.js';
import { ensureBrowserPrivacySelectors } from './browser-privacy.js';
import type { GesturePolicy, GesturePlan, GestureReference, GestureExecution } from './gesture-types.js';
import type { CapturedImage, VisualPolicy } from './visual-types.js';
import { networkResourceType, networkMethod, isActionNetworkBlock } from './network-warnings.js';
import { describeHeldRequest, HELD_METHODS } from './approval-summary.js';
import {
  AdlError,
  HeldWritesError,
  MAX_DOM_DEPTH,
  type SnapshotSourceLimit,
  type HeldWriteAbortOutcome,
  type Action,
  type Adapter,
  type AdapterActResult,
  type AdapterSession,
  type AdapterWarning,
  type NetworkWarning,
  type Element as ElementInfo,
  type ErrorReason,
  type Mode,
  type PolicyConfig,
  type RawSnapshot,
  type Target,
  type BrowserTargetConfig,
} from './types.js';

function deny(): never {
  throw new AdlError('E_POLICY_DENIED');
}

/** Whether every request of the session passes the network route installed in BrowserAdapter.open. */
function routesNetwork(policy: PolicyConfig): boolean {
  return (
    !policy.allowAllOperations ||
    (!!policy.restrictTargets && !policy.allowAllBrowserOrigins) ||
    !policy.allowLoopback ||
    !policy.allowPrivateNetwork ||
    !!policy.browserProxyServer
  );
}

/**
 * Headers for a followed hop of a main-frame redirect chain: the original request's, with the Cookie header the browser
 * would send to the hop's own URL (cookies scoped to a path differ between hops). A chain that started cross-site keeps
 * SameSite=Strict cookies out, as the browser does.
 */
async function navigationHopHeaders(
  context: BrowserContext,
  headers: Record<string, string>,
  url: URL,
): Promise<Record<string, string>> {
  const crossSite = headers['sec-fetch-site'] === 'cross-site';
  const cookies = (await context.cookies(url.href))
    .filter(cookie => !(crossSite && cookie.sameSite === 'Strict'))
    .sort((a, b) => b.path.length - a.path.length);
  const hop = { ...headers };
  delete hop.cookie;
  if (cookies.length) hop.cookie = cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  return hop;
}

/** The method of the request that follows a redirect, as the Fetch standard has it: a read of the destination, or the same request again. */
function redirectedMethod(status: number, method: string): string {
  if (status === 303 && method !== 'GET' && method !== 'HEAD') return 'GET';
  return (status === 301 || status === 302) && method === 'POST' ? 'GET' : method;
}

/** The request headers without those that described the body a redirect dropped. */
function withoutBodyHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !/^(content-|origin$)/i.test(name)));
}

// How long a contained action waits for a request that decides its result, counted from its dispatch; a later one is stopped and shows in the next observation.
export const CONTAINMENT_REPORT_MS = 500;
// After an input action the page gets to react before the caller reads it: the action returns once no attributable request is in
// flight and the document has been quiet for SETTLE_QUIET_MS, or SETTLE_MAX_MS after its dispatch. Timing only: no security decision reads it.
export const SETTLE_QUIET_MS = 60;
export const SETTLE_MAX_MS = 400;
const SETTLED_ACTIONS = new Set(['click', 'press', 'fill', 'check', 'select', 'hover']);
// Actions whose page writes may be held for approval (ask mode with an approver). Hover, scroll and navigation never open a hold.
const HOLD_ACTIONS = new Set(['click', 'press', 'fill', 'check', 'select']);
// A held request has to be described to a human completely: larger bodies, other body types and more than 4 requests per action are never held.
const MAX_HELD_BODY = 65536;
const MAX_HELD_PER_ACTION = 4;
const HELD_CONTENT_TYPES = new Set(['application/json', 'application/x-www-form-urlencoded', 'text/plain']);
// A set that nobody released or aborted is aborted by the adapter after this long (the engine's approvals expire within 120 s).
const HELD_SET_LIFETIME_MS = 125000;
const MAX_HELD_OUTCOMES = 16;
// A request the page waits for synchronously (a synchronous XHR) blocks the thread that would return the action's dispatch: a hold
// created while the dispatch has not returned for this long is aborted as not approvable, so that the handler can go on.
const SYNC_GRACE_MS = 280;
// Request headers a server may read as the real method; the human is shown them next to the request.
const METHOD_OVERRIDE_HEADERS = ['x-http-method-override', 'x-method-override', 'x-http-method'];
// The verdict of a held request whose document was replaced: it dies with the document, silently (no block to report for a page that is gone).
const DOCUMENT_REPLACED = 'document_replaced';

/** A request's identity for telling what a page already asks for: the values that vary between polls (those with digits) do not count. */
function requestShape(url: string): string {
  const parsed = new URL(url);
  const query = [...parsed.searchParams].map(([key, value]) => `${key}=${/\d/.test(value) ? '#' : value}`).sort();
  return `${parsed.origin}${parsed.pathname}?${query.join('&')}`;
}
const MAX_KNOWN_REQUESTS = 2000;

// Playwright's own wording when an element handle's node left the document (dom.ts throwElementIsNotAttached); timeouts and other failures never match.
function detachedElementError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === 'Error' &&
    /^(?:\w+\.\w+: )?Element is not attached to the DOM$/.test(error.message.split('\n', 1)[0] ?? '')
  );
}

type Store = {
  ids: WeakMap<object, string>;
  nodes: Map<string, object>;
  seq: number;
  prefix: string;
  seen: Set<string>;
  integrity: BrowserIntegrity;
  /** Counts DOM mutations of the document (page-world MutationObserver); read by the post-action settle, timing only. */
  activity: number;
};

type BlockEntry = NetworkWarning & { seq: number; held?: true };

/** A write request the network route keeps paused until a human decides on it (ask mode); bodies stay in the adapter. */
type PausedWrite = {
  setId: string;
  request: Request;
  method: string;
  url: string;
  contentType: string;
  body: Buffer | undefined;
  bodySha256: string;
  details: string[];
  secret: boolean;
  decision: Promise<string>;
  /** Resolves the route handler with 'release' or the code to block with; the first call wins. */
  decide: (verdict: string) => void;
  decided: boolean;
  /** The page cancelled the request (timeout, abort) before anybody decided. */
  abandoned: boolean;
  releaseExpires?: number;
  /** A released request reached the network fetch (it was not stopped by the guard, DNS or the expiry re-check first). */
  dispatched?: boolean;
};

/** What happens between an action's dispatch and the end of its settle: the writes the page sends are attributed to it. */
type WriteWindow = {
  id: string;
  open: boolean;
  /** Writes sent while it is open may be held (ask mode with an approver, a click/press/fill/check/select). */
  hold: boolean;
  holds: PausedWrite[];
  overflow: boolean;
  /** Blocks recorded while the window lives; the action result carries exactly these. */
  blocked: Map<string, BlockEntry>;
  collected: boolean;
  /** Attributable requests started since the dispatch and not finished yet. */
  inflight: Set<Request>;
  lastActivity: number;
  dispatchedAt: number;
  /** The document's mutation count read at the dispatch, to tell whether it changed since. */
  baseline: Promise<number>;
  /** The document replacements (main-frame navigations that fetched a document) counted when the window opened. */
  replacements: number;
  /** The action's dispatch (the page.click call) has returned; until then a held write may be a synchronous request the page's thread waits for. */
  returned: boolean;
  /** Fires when a hold has waited for the dispatch to return for SYNC_GRACE_MS. */
  syncTimer?: ReturnType<typeof setTimeout>;
  /** No further write of this window is held: one was a request the page waits for synchronously, or the page gave up on one of the set. */
  refused: boolean;
  /** The document was gone (or going) when the post-action settle tried to read it. */
  documentGone: boolean;
};

/** The route's decision for a write: the code to block with (setId: the set whose hold ended, when there was one), or the permit to continue with. */
type HoldWindow = Pick<WriteWindow, 'id' | 'replacements'>;
type HoldVerdict = { block: string; window?: HoldWindow } | { expires: number | undefined; paused: PausedWrite };

/** Request classes that carry an action's own effect: main-frame fetch/XHR/document requests the page was not already making. */
const SETTLE_RESOURCE_TYPES = new Set(['fetch', 'xhr', 'document']);

type PageSnapshot = {
  elements: ElementInfo[];
  sig: string;
  truncated: boolean;
  source_limits: SnapshotSourceLimit[];
  navigation: string;
  actionStates: Record<string, { target: string; form?: string }>;
  forms: Record<string, string>;
};

// Runs inside the page against the private store kept in the JSHandle
// closure (WeakMap/Map not on window, unreachable from page scripts).
// Bounded TreeWalker traversal: visit cap, depth cap, output cap; only
// bounded text nodes are read (never textContent on huge subtrees).
function snapshotPageFn(
  store: Store,
  cfg: {
    maxOut: number;
    visitCap: number;
    maxDepth: number;
    fieldMax: number;
    isolatedReadOnly?: boolean;
    allowPersonalData?: boolean;
    secretLabelPattern: string;
    personalLabelPattern: string;
    privacyRules: typeof BROWSER_PRIVACY_RULES;
  },
  personalContext: typeof personalContextPageFn,
): PageSnapshot {
  if (!store.integrity.check()) throw new Error('ADL_UNTRUSTED_DOM');
  const personalContexts = new WeakMap<Element, boolean>();
  // Document and form named properties (img name="body", input name="tagName")
  // shadow instance APIs in the page world. Reads on the document or on nodes
  // that may be forms resolve through the verified prototype chain instead.
  const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
    m = (o: object, k: string, ...a: unknown[]): any => Reflect.apply(r(o, k), o, a);
  const attr = (x: Element, k: string) => m(x, 'getAttribute', k) as string | null,
    has = (x: Element, k: string) => m(x, 'hasAttribute', k) as boolean,
    tagOf = (x: Element) => String(r(x, 'tagName'));
  const clip = (s: string): string => (s.length > cfg.fieldMax ? s.slice(0, cfg.fieldMax) : s);
  const idFor = (n: object): string => {
    let id = store.ids.get(n);
    if (!id) {
      id = store.prefix + '-' + (++store.seq).toString(36);
      store.ids.set(n, id);
      store.nodes.set(id, n);
    }
    return id;
  };
  const directText = (el: Element): string => {
    let t = '';
    let visits = 0;
    for (
      let c = r(el, 'firstChild') as ChildNode | null;
      c && t.length < cfg.fieldMax && visits++ < 64;
      c = r(c, 'nextSibling')
    ) {
      if (r(c, 'nodeType') === 3 && c.textContent) t += c.textContent.slice(0, cfg.fieldMax - t.length);
    }
    return t.trim();
  };
  const visible = (el: HTMLElement): boolean => {
    try {
      return m(el, 'checkVisibility', { opacityProperty: false, visibilityProperty: true }) as boolean;
    } catch {
      return r(el, 'offsetParent') !== null || (m(el, 'getClientRects') as DOMRectList).length > 0;
    }
  };
  const secretPattern = new RegExp(cfg.secretLabelPattern, 'iu');
  const sensitiveLabel = (text: string) =>
    secretPattern.test(
      text
        .normalize('NFKC')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Za-z])([0-9])/g, '$1 $2')
        .replace(/([0-9])([A-Za-z])/g, '$1 $2'),
    );
  const inSensitiveRegion = (element: Element): boolean => {
    let node: Element | null = element,
      depth = 0;
    while (node && depth++ < cfg.privacyRules.ancestorCap) {
      if (m(node, 'matches', cfg.privacyRules.regionSelector)) return true;
      node = (r(node, 'parentElement') as Element | null) ?? (m(node, 'getRootNode') as ShadowRoot).host ?? null;
    }
    return node !== null; // Incomplete ancestry cannot establish a public region.
  };
  const alphaOf = (color: string): number => {
    const match =
      /^rgba\(\s*[^,]+,[^,]+,[^,]+,\s*([\d.]+)(%?)\s*\)$/.exec(color) ?? /\/\s*([\d.]+)(%?)\s*\)$/.exec(color);
    if (!match) return 1;
    const value = parseFloat(match[1]!);
    return match[2] ? value / 100 : value;
  };
  // Prompt-injection hint: text a human cannot see. Computed style is read only for collected elements named from rendered text.
  const textHidden = (el: Element): boolean => {
    try {
      const style = getComputedStyle(el);
      if (parseFloat(style.fontSize) <= 2 || parseFloat(style.opacity) < 0.05 || alphaOf(style.color) <= 0.05)
        return true;
      if (!m(el, 'checkVisibility', { opacityProperty: true })) return true;
      if (
        parseFloat(style.textIndent) <= -999 ||
        /^rect\(\s*0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?\s*\)$/.test(style.clip) ||
        /^inset\(\s*(?:50|100)%/.test(style.clipPath)
      )
        return true;
      const box = m(el, 'getBoundingClientRect') as DOMRect;
      if (box.bottom + scrollY < -20) return true;
      if (style.direction === 'ltr' && (box.right + scrollX < -20 || box.left + scrollX > innerWidth + 10000))
        return true;
      return (box.width <= 1 || box.height <= 1) && (style.overflowX !== 'visible' || style.overflowY !== 'visible');
    } catch {
      return false;
    }
  };
  const svgTitle = (el: Element): string => {
    for (const child of Array.from(r(el, 'children') as HTMLCollection))
      if (r(child, 'localName') === 'title') return (child.textContent ?? '').trim();
    return '';
  };
  // Assistive text is exposed only in a control's accessible name. Class names
  // cannot establish intent, and opacity/tiny-font prose is never exempted.
  const assistiveBox = (el: Element): boolean => {
    try {
      const style = getComputedStyle(el);
      if (parseFloat(style.fontSize) <= 2 || parseFloat(style.opacity) < 0.05 || alphaOf(style.color) <= 0.05)
        return false;
      const box = m(el, 'getBoundingClientRect') as DOMRect;
      return (
        /^rect\(\s*0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?\s*\)$/.test(style.clip) ||
        /^inset\(\s*(?:50|100)%/.test(style.clipPath) ||
        ((style.position === 'absolute' || style.position === 'fixed') &&
          ((box.width <= 1 && box.height <= 1 && (style.overflowX !== 'visible' || style.overflowY !== 'visible')) ||
            box.right + scrollX < -20))
      );
    } catch {
      return false;
    }
  };
  const hiddenCaches = [new Map<Element, boolean>(), new Map<Element, boolean>()];
  const concealed = (el: Element, allowAssistive = false, depth = 0): boolean => {
    if (depth >= cfg.privacyRules.ancestorCap) return true;
    const cache = hiddenCaches[allowAssistive ? 1 : 0]!;
    const cached = cache.get(el);
    if (cached !== undefined) return cached;
    const parent = (r(el, 'parentElement') as Element | null) ?? (m(el, 'getRootNode') as ShadowRoot).host;
    const hidden =
      (textHidden(el) && !(allowAssistive && assistiveBox(el))) ||
      !!(parent && concealed(parent, allowAssistive, depth + 1));
    cache.set(el, hidden);
    return hidden;
  };
  let descendantClipped = false,
    descendantHidden = false;
  // Cells, items and blocks inside a composed name stay separable: cells and items are joined with " | ", blocks with a space.
  const CELL_TAGS = new Set(['TD', 'TH', 'LI', 'DT', 'DD']),
    CELL_ROLES = new Set(['cell', 'gridcell', 'columnheader', 'rowheader', 'listitem', 'treeitem', 'tab', 'option']);
  const BLOCK_TAGS = new Set([
    'DIV',
    'P',
    'TR',
    'UL',
    'OL',
    'TABLE',
    'SECTION',
    'ARTICLE',
    'ASIDE',
    'HEADER',
    'FOOTER',
    'NAV',
    'MAIN',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'BR',
    'BLOCKQUOTE',
    'PRE',
    'FIGURE',
    'FIGCAPTION',
    'FORM',
    'FIELDSET',
    'DL',
    'HR',
    'ADDRESS',
    'DETAILS',
    'SUMMARY',
    'CAPTION',
  ]);
  const shownCache = new Map<Element, boolean>();
  // Text under display:none, visibility:hidden or a closed details element is not part of a composed name.
  const shown = (el: Element): boolean => {
    let value = shownCache.get(el);
    if (value === undefined) {
      try {
        value = m(el, 'checkVisibility', { visibilityProperty: true }) as boolean;
      } catch {
        value = true;
      }
      // An svg title or description is never rendered but names its graphic.
      const parentEl = r(el, 'parentElement') as Element | null,
        local = r(el, 'localName');
      if (!value && (local === 'title' || local === 'desc') && parentEl && m(parentEl, 'closest', 'svg'))
        value = shown(parentEl);
      // display:contents has no box of its own, so judge it by its parent.
      if (!value) {
        try {
          if (getComputedStyle(el).display === 'contents') value = parentEl ? shown(parentEl) : true;
        } catch {
          /* keep false */
        }
      }
      shownCache.set(el, value);
    }
    return value;
  };
  const descendantText = (el: Element, includeHidden = false, failClosed = true, allowAssistive = false): string => {
    descendantClipped = false;
    descendantHidden = false;
    if (inSensitiveRegion(el)) return 'x'.repeat(cfg.fieldMax);
    let scanned = 0,
      exhausted = false;
    const walker = m(document, 'createTreeWalker', el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (node: Node) => {
        if (++scanned > 128) {
          exhausted = true;
          return NodeFilter.FILTER_ACCEPT;
        }
        return r(node, 'nodeType') === 1 &&
          m(node, 'matches', cfg.privacyRules.textSkipSelector + ',' + cfg.privacyRules.regionSelector)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    }) as TreeWalker;
    let node: Node | null = walker.nextNode(),
      visits = 0;
    const parts = [''];
    let used = 0,
      gap = false,
      space = false,
      cells = false;
    const add = (raw: string) => {
      const chunk = raw.replace(/\s+/g, ' ');
      if (!chunk.trim()) {
        space = true;
        return;
      }
      const last = parts[parts.length - 1]!;
      const join = last && (gap || space || /\s$/.test(last) || /^\s/.test(chunk)) ? ' ' : '';
      let piece = chunk.trimStart();
      const room = cfg.fieldMax - used - join.length;
      if (room <= 0) {
        descendantClipped = true;
        return;
      }
      if (piece.length > room) {
        descendantClipped = true;
        piece = piece.slice(0, room);
      }
      parts[parts.length - 1] = last.trimEnd() + join + piece;
      used += join.length + piece.length;
      gap = false;
      space = false;
    };
    while (node && !exhausted && visits++ < 128 && used < cfg.fieldMax) {
      if (r(node, 'nodeType') === 3) {
        const parent = r(node, 'parentElement') as Element | null;
        if (
          parent &&
          !m(parent, 'closest', 'script,style') &&
          (includeHidden || (!m(parent, 'closest', '[hidden],[aria-hidden="true"]') && shown(parent)))
        )
          if (
            !includeHidden &&
            concealed(parent, allowAssistive) &&
            !(['title', 'desc'].includes(String(r(parent, 'localName'))) && m(parent, 'closest', 'svg'))
          )
            descendantHidden = true;
          else
            add(
              !cfg.allowPersonalData &&
                personalContext(parent, cfg.privacyRules.personalContextLabelPattern, personalContexts) &&
                (node.textContent ?? '').trim()
                ? '[redacted]'
                : (node.textContent ?? ''),
            );
      } else {
        const child = node as Element,
          tag = tagOf(child);
        const cellRole = CELL_ROLES.has(attr(child, 'role') ?? '');
        if (CELL_TAGS.has(tag) || cellRole) {
          if (cells || parts[parts.length - 1]) {
            parts.push('');
            used += 3;
          }
          cells = true;
          gap = false;
          space = false;
        } else if (BLOCK_TAGS.has(tag)) gap = true;
        else if (tag === 'IMG') {
          const alt = attr(child, 'alt');
          if (
            alt &&
            alt.trim() &&
            (includeHidden || (!m(child, 'closest', '[hidden],[aria-hidden="true"]') && shown(child)))
          )
            add(alt);
        }
      }
      node = walker.nextNode();
    }
    descendantClipped ||= !!node || exhausted;
    // An incomplete naming hint cannot establish that a field is public.
    return node && failClosed
      ? 'x'.repeat(cfg.fieldMax)
      : parts
          .map(part => part.trim())
          .join(' | ')
          .trim();
  };
  let referencedClipped = false;
  const referencedName = (el: Element): string => {
    referencedClipped = false;
    const refs = attr(el, 'aria-labelledby');
    if (!refs) return '';
    if (refs.length > 4096) throw new Error('Snapshot field limit');
    const ids = refs.trim().split(/\s+/);
    if (ids.length > 16) return 'x'.repeat(cfg.fieldMax);
    const text = ids
      .map(id => {
        const label = m(m(el, 'getRootNode'), 'getElementById', id) as Element | null;
        if (!label) return '';
        const value = descendantText(label, true);
        referencedClipped ||= descendantClipped;
        return value;
      })
      .join(' ');
    referencedClipped ||= text.length > cfg.fieldMax;
    return text.slice(0, cfg.fieldMax).trim();
  };
  // A line as a person reads it: the element's own text plus the text of its inline children (links, emphasis, spans), in order.
  // Block and cell children are listed on their own and left out. Controls, scripts, protected regions, subtrees that are not rendered and
  // inline children whose text a human cannot see are never merged (the latter set hidden). text keeps at most fieldMax characters;
  // length counts the whole text up to the 1 MiB cap (absent past it) and block says a block child was left out.
  const INLINE_TEXT_CAP = 1048576,
    INLINE_VISITS = 256,
    INLINE_DEPTH = 8;
  const inlineText = (
    el: Element,
  ): { text: string; length?: number; truncated: boolean; hidden: boolean; block: boolean } => {
    const skip = cfg.privacyRules.textSkipSelector + ',' + cfg.privacyRules.regionSelector;
    let preserve = false;
    try {
      preserve = /^(pre|break-spaces)/.test(getComputedStyle(el).whiteSpace);
    } catch {
      /* collapse whitespace */
    }
    let out = '',
      visits = 0,
      truncated = false,
      hidden = false,
      block = false;
    const walk = (parent: Element, level: number): void => {
      for (let c = r(parent, 'firstChild') as ChildNode | null; c && !truncated; c = r(c, 'nextSibling')) {
        if (++visits > INLINE_VISITS) {
          truncated = true;
          return;
        }
        const type = r(c, 'nodeType');
        if (type === 3) {
          let piece = String(r(c, 'nodeValue') ?? '');
          if (!preserve) {
            piece = piece.replace(/[ \t\n\r\f]+/g, ' ');
            if (out === '' || out.endsWith(' ') || out.endsWith('\n')) piece = piece.replace(/^ /, '');
          }
          if (out.length + piece.length > INLINE_TEXT_CAP) {
            truncated = true;
            return;
          }
          out += piece;
          continue;
        }
        if (type !== 1) continue;
        const child = c as Element,
          childTag = tagOf(child);
        if (childTag === 'BR') {
          out = out.replace(/ +$/, '') + '\n';
          continue;
        }
        if (BLOCK_TAGS.has(childTag) || CELL_TAGS.has(childTag) || CELL_ROLES.has(attr(child, 'role') ?? '')) {
          block = true;
          continue;
        }
        if (m(child, 'matches', skip)) continue;
        if (has(child, 'hidden') || attr(child, 'aria-hidden') === 'true' || !shown(child)) continue;
        if (level >= INLINE_DEPTH) {
          truncated = true;
          continue;
        }
        const before = out.length;
        walk(child, level + 1);
        if (!truncated && out.length > before && out.slice(before).trim() && concealed(child)) {
          out = out.slice(0, before);
          hidden = true;
        }
      }
    };
    walk(el, 0);
    const text = out.trim();
    return {
      text: text.slice(0, cfg.fieldMax),
      ...(truncated ? {} : { length: text.length }),
      truncated: truncated || text.length > cfg.fieldMax,
      hidden,
      block,
    };
  };
  // Regions that hold page text: a long one is named by its first characters, not by a fail-closed placeholder.
  const LANDMARK_ROLES = new Set(['main', 'article', 'region', 'document', 'feed']);
  const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea']);
  const elements: ElementInfo[] = [];
  const sigParts: string[] = [];
  // A plain text cell whose row name already carries its text is not listed twice.
  const completeRows = new Set<Element>(),
    descNamed = new Map<Element, number>(),
    hiddenNodes: Element[] = [];
  // These complete strings are hashed in Node, never included in public elements.
  // Missing/over-budget evidence disables relaxed freshness for that target.
  const actionStates: PageSnapshot['actionStates'] = Object.create(null),
    forms: Record<string, string> = Object.create(null);
  const formCache = new Map<HTMLFormElement, string | null>();
  let evidenceBytes = 0;
  const accountEvidence = (length: number) => {
    if (evidenceBytes + length > 4194304) throw new Error('evidence limit');
    evidenceBytes += length;
  };
  const fullAttrs = (element: Element) => {
    // Pure inline geometry is guarded by the existing input/point preflight.
    // Keeping it out preserves the semantic revision contract for layout drift.
    const attrs = Array.from(r(element, 'attributes') as NamedNodeMap)
      .filter(a => a.name !== 'style')
      .map(a => [a.name, a.value])
      .sort((a, b) => a[0]!.localeCompare(b[0]!));
    const length = JSON.stringify(attrs).length;
    if (attrs.length > 128 || length > 16384) throw new Error('evidence limit');
    accountEvidence(length);
    return attrs;
  };
  const retainedId = (element: Element) => {
    const id = idFor(element);
    store.seen.add(id);
    return id;
  };
  const formEvidence = (form: HTMLFormElement): string => {
    if (formCache.has(form)) {
      const cached = formCache.get(form);
      if (!cached) throw new Error('evidence unavailable');
      return cached;
    }
    formCache.set(form, null);
    const items = r(form, 'elements') as HTMLFormControlsCollection;
    if (items.length > 128) throw new Error('evidence limit');
    const controls = Array.from(items, item => {
      const field = item as HTMLInputElement,
        value = store.integrity.value(item);
      if (value.length > 4096) throw new Error('evidence limit');
      accountEvidence(value.length);
      if (item instanceof HTMLSelectElement && item.options.length > 128) throw new Error('evidence limit');
      const options =
        item instanceof HTMLSelectElement
          ? Array.from(item.options, option => {
              if (option.value.length > 4096 || option.text.length > 4096) throw new Error('evidence limit');
              accountEvidence(option.value.length + option.text.length);
              return [
                retainedId(option),
                fullAttrs(option),
                option.value,
                option.text,
                option.disabled,
                option.selected,
              ];
            })
          : undefined;
      return [
        retainedId(item),
        tagOf(item),
        fullAttrs(item),
        value,
        store.integrity.checked(item),
        Boolean(field.disabled),
        options,
      ];
    });
    const id = retainedId(form),
      serialized = JSON.stringify([
        id,
        fullAttrs(form),
        r(form, 'action'),
        r(form, 'method'),
        r(form, 'enctype'),
        r(form, 'target'),
        controls,
      ]);
    if (serialized.length > 1048576) throw new Error('evidence limit');
    accountEvidence(serialized.length);
    forms[id] = serialized;
    formCache.set(form, id);
    return id;
  };
  // A range bound is a finite number; blank, malformed or oversized attributes count as absent.
  const rangeNumber = (raw: string | null): number | undefined => {
    if (raw === null || raw.length > 64 || !raw.trim()) return undefined;
    const value = Number(raw.trim());
    return Number.isFinite(value) ? value : undefined;
  };
  // An editing host carries its own contenteditable attribute and has no editable parent; the rest of the editable subtree is its content.
  const isEditingHost = (el: Element): boolean => {
    if (!has(el, 'contenteditable') || r(el, 'isContentEditable') !== true) return false;
    const parentEl = r(el, 'parentElement') as Element | null;
    return !(parentEl && r(parentEl, 'isContentEditable') === true);
  };
  // Text of an editing host as one string: line breaks for <br> and block boundaries, whitespace collapsed unless the host preserves it.
  // Protected regions, nested form controls, scripts and styles, hidden subtrees and display:none text are never read. Tiny, transparent or
  // off-screen text is omitted and reported through hidden. At most EDIT_VALUE_CAP characters are kept; total still counts the rest.
  const EDIT_VALUE_CAP = 4096,
    EDIT_NODE_CAP = 4000;
  const readEditable = (host: Element): { text: string; total: number; overflow: boolean; hidden: boolean } => {
    let preserve = false;
    try {
      preserve = /^(pre|break-spaces)/.test(getComputedStyle(host).whiteSpace);
    } catch {
      /* collapse whitespace */
    }
    const skip = `${cfg.privacyRules.textSkipSelector},${cfg.privacyRules.regionSelector},[hidden],[aria-hidden="true"]`;
    const walker = m(document, 'createTreeWalker', host, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (node: Node) =>
        r(node, 'nodeType') === 1 && (m(node, 'matches', skip) || getComputedStyle(node as Element).display === 'none')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    }) as TreeWalker;
    const looksHidden = new Map<Element, boolean>();
    let out = '',
      total = 0,
      last = '',
      hidden = false,
      lastBlock: Element | null = null,
      count = 0,
      node: Node | null = walker.nextNode();
    const append = (piece: string) => {
      if (!piece) return;
      total += piece.length;
      last = piece[piece.length - 1]!;
      if (out.length < EDIT_VALUE_CAP) out += piece.slice(0, EDIT_VALUE_CAP - out.length);
    };
    const blockOf = (text: Node): Element => {
      let up = r(text, 'parentElement') as Element | null;
      for (let climbed = 0; up && up !== host && climbed < 64; climbed++, up = r(up, 'parentElement') as Element | null)
        if (BLOCK_TAGS.has(tagOf(up))) return up;
      return host;
    };
    for (; node && count++ < EDIT_NODE_CAP; node = walker.nextNode()) {
      if (r(node, 'nodeType') === 1) {
        if (tagOf(node as Element) === 'BR' && shown(node as Element)) append('\n');
        continue;
      }
      // Text under visibility:hidden or a closed details element is not rendered either.
      const owner = r(node, 'parentElement') as Element | null;
      if (!owner || !shown(owner)) continue;
      if (concealed(owner)) {
        hidden = true;
        continue;
      }
      let piece = String(r(node, 'nodeValue') ?? '').replace(/\r\n?/g, '\n');
      piece = preserve ? piece.replace(/\xa0/g, ' ') : piece.replace(/\s+/g, ' ');
      if (!preserve && (last === '' || last === '\n' || last === ' ')) piece = piece.replace(/^ /, '');
      if (!piece) continue;
      const block = blockOf(node);
      if (total > 0 && block !== lastBlock && last !== '\n') append('\n');
      lastBlock = block;
      const exposed = out.length < EDIT_VALUE_CAP;
      append(piece);
      if (exposed && !hidden) {
        let flagged = looksHidden.get(owner);
        if (flagged === undefined) looksHidden.set(owner, (flagged = textHidden(owner)));
        if (flagged) hidden = true;
      }
    }
    const text = out
      .replace(/ +\n/g, '\n')
      .replace(/^\n+/, '')
      .replace(/[\n ]+$/, '');
    return { text, total, overflow: total > EDIT_VALUE_CAP || !!node, hidden };
  };
  let visited = 0;
  let truncated = false;
  const sourceLimits = new Set<SnapshotSourceLimit>();
  const root = (r(document, 'body') || r(document, 'documentElement')) as HTMLElement;
  // One sibling cursor per active branch keeps memory bounded even for very wide pages.
  const pending: { node: HTMLElement; depth: number; group?: string; siblings?: boolean }[] = [
    { node: root, depth: 0 },
  ];
  let cur: HTMLElement;
  let depth = 0;
  while (pending.length) {
    if (visited++ >= cfg.visitCap) {
      truncated = true;
      sourceLimits.add('visit_limit');
      break;
    }
    const item = pending.pop()!;
    cur = item.node;
    depth = item.depth;
    if (item.siblings) {
      const next = r(cur, 'nextElementSibling') as HTMLElement | null;
      if (next) pending.push({ ...item, node: next });
    }
    const skipChildren = depth >= cfg.maxDepth;
    const atDepthShadow = skipChildren ? (r(cur, 'shadowRoot') as ShadowRoot | null) : null;
    if (skipChildren && (r(cur, 'firstElementChild') || (atDepthShadow && r(atDepthShadow, 'firstElementChild')))) {
      truncated = true;
      sourceLimits.add('depth_limit');
    }
    const tag = tagOf(cur).toLowerCase();
    const type = tag === 'input' ? ((cur as HTMLInputElement).type || 'text').toLowerCase() : '';
    const roleAttr = attr(cur, 'role'),
      curId = attr(cur, 'id') ?? '';
    if ((roleAttr?.length ?? 0) > 100 || curId.length > 512) throw new Error('Snapshot field limit');
    const isInteractive = INTERACTIVE.has(tag) && (tag !== 'a' || has(cur, 'href')) && type !== 'hidden';
    const isStatus = roleAttr === 'status' || roleAttr === 'alert' || has(cur, 'aria-live');
    const clickable = has(cur, 'onclick') || (r(cur, 'tabIndex') >= 0 && getComputedStyle(cur).cursor === 'pointer');
    const isText =
      /^(div|p|span|legend|h[1-6]|td|th|li|dt|dd|blockquote|code|pre|time|caption|figcaption|summary|strong|em|b|i|small|mark|q|samp|kbd|cite|abbr|address|article|section|main|header|footer|aside|output)$/.test(
        tag,
      ) && !!directText(cur);
    const editable = isEditingHost(cur);
    let hideContent = false;
    const structural = ['table', 'tr', 'ul', 'ol', 'li'].includes(tag);
    // Images, canvases and svg graphics are listed only with a text alternative; decorative or aria-hidden ones stay out.
    const imageTag = tag === 'img' || tag === 'canvas' || tag === 'svg';
    const imageHidden = (imageTag || roleAttr === 'img') && !!m(cur, 'closest', '[aria-hidden="true"]');
    const imageNamed =
      imageTag &&
      !imageHidden &&
      !!(
        referencedName(cur) ||
        attr(cur, 'aria-label')?.trim() ||
        attr(cur, 'alt')?.trim() ||
        attr(cur, 'title')?.trim() ||
        (tag === 'svg' && svgTitle(cur))
      );
    // A page's main region, an article and a labelled section are listed so that their whole text can be read by id.
    const landmarkTag = !roleAttr && /^(nav|header|footer|aside|search)$/.test(tag);
    const containerTag =
      !roleAttr &&
      (landmarkTag ||
        tag === 'main' ||
        tag === 'article' ||
        (tag === 'section' && !!(attr(cur, 'aria-label')?.trim() || attr(cur, 'aria-labelledby')?.trim())));
    const interesting =
      (isInteractive ||
        clickable ||
        isStatus ||
        roleAttr ||
        containerTag ||
        isText ||
        editable ||
        structural ||
        tag === 'td' ||
        tag === 'th' ||
        imageNamed) &&
      !imageHidden &&
      visible(cur);
    let childGroup = item.group;
    if (interesting) {
      if (elements.length >= cfg.maxOut) {
        truncated = true;
        sourceLimits.add('element_limit');
        break;
      }
      let role = roleAttr || '';
      if (!role) {
        if (containerTag)
          role =
            tag === 'section'
              ? 'region'
              : tag === 'nav'
                ? 'navigation'
                : tag === 'header'
                  ? 'banner'
                  : tag === 'footer'
                    ? 'contentinfo'
                    : tag === 'aside'
                      ? 'complementary'
                      : tag;
        else if (tag === 'table') role = 'table';
        else if (tag === 'tr') role = 'row';
        else if (tag === 'ul' || tag === 'ol') role = 'list';
        else if (tag === 'li') role = 'listitem';
        else if (tag === 'td') role = 'cell';
        else if (tag === 'button') role = 'button';
        else if (tag === 'a') role = 'link';
        else if (tag === 'select') role = 'combobox';
        else if (tag === 'textarea') role = 'textbox';
        else if (tag === 'input')
          role =
            type === 'checkbox'
              ? 'checkbox'
              : type === 'radio'
                ? 'radio'
                : type === 'submit'
                  ? 'button'
                  : type === 'file'
                    ? 'file'
                    : type === 'range'
                      ? 'slider'
                      : type === 'number'
                        ? 'spinbutton'
                        : 'textbox';
        else
          role = imageTag
            ? 'img'
            : tag === 'th'
              ? 'columnheader'
              : /^h[1-6]$/.test(tag)
                ? 'heading'
                : clickable
                  ? 'button'
                  : tag === 'blockquote'
                    ? 'blockquote'
                    : tag === 'code' || tag === 'pre'
                      ? 'code'
                      : tag === 'time'
                        ? 'time'
                        : tag === 'caption' || tag === 'figcaption'
                          ? 'caption'
                          : isText
                            ? 'text'
                            : 'generic';
        // A bare editing host (rich-text editor) is a text box; an explicit role or a more specific tag role stays.
        if (editable && (role === 'generic' || role === 'text')) role = 'textbox';
      }
      const bodyText = !isInteractive && !clickable && cfg.privacyRules.textRoles.some(textRole => textRole === role);
      const form = m(cur, 'closest', 'form') as HTMLFormElement | null;
      const labelEl =
        tag === 'input' || tag === 'textarea' || tag === 'select' ? (cur as HTMLInputElement).labels?.[0] : undefined;
      const ownText = directText(cur);
      const labelText = labelEl ? descendantText(labelEl) : '',
        labelClipped = !!labelEl && descendantClipped;
      const referenceText = referencedName(cur),
        referenceClipped = referencedClipped;
      const useOwn = isText && !isInteractive && !clickable && !roleAttr && !editable && !containerTag;
      // A container is named by its label, else by its first visible heading outside protected regions.
      let headingName = '';
      if (containerTag) {
        const heading = m(cur, 'querySelector', 'h1,h2,h3,h4,h5,h6,[role="heading"]') as Element | null;
        if (heading && !inSensitiveRegion(heading) && shown(heading))
          headingName = descendantText(heading, false, false);
      }
      const inline = useOwn ? inlineText(cur) : undefined;
      // Tables and lists name themselves from explicit labels only; their rows and items carry the text. Rows and items may be long without being labels.
      // An editing host is named by its label, never by the text being edited: that text is its value.
      const aggregate =
        role === 'table' ||
        role === 'list' ||
        role === 'grid' ||
        role === 'rowgroup' ||
        role === 'tree' ||
        editable ||
        containerTag;
      const descendant =
          useOwn || aggregate
            ? ''
            : descendantText(
                cur,
                false,
                !bodyText &&
                  !LANDMARK_ROLES.has(role) &&
                  !((role === 'row' || role === 'listitem') && !isInteractive && !clickable),
                isInteractive ||
                  clickable ||
                  ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem'].includes(role),
              ),
        descendantWasClipped = useOwn || aggregate ? false : descendantClipped,
        descendantOmittedHidden = !useOwn && !aggregate && descendantHidden;
      // A live region that is still empty must not be named after its id attribute.
      let rawName =
        referenceText ||
        attr(cur, 'aria-label') ||
        labelText ||
        (useOwn ? inline!.text : descendant) ||
        headingName ||
        (containerTag ? ownText : '') ||
        attr(cur, 'alt') ||
        attr(cur, 'placeholder') ||
        attr(cur, 'title') ||
        (isStatus ? '' : curId) ||
        '';
      const concealedProse = (bodyText || (isText && !isInteractive && !clickable)) && concealed(cur);
      if (concealedProse) rawName = '';
      const fromText = !(referenceText || attr(cur, 'aria-label') || labelText) && !!(useOwn ? ownText : descendant);
      const derived = !(referenceText || attr(cur, 'aria-label') || labelText);
      const nameTruncated =
        (referenceText
          ? referenceClipped
          : attr(cur, 'aria-label')
            ? false
            : labelText
              ? labelClipped
              : useOwn
                ? inline!.truncated
                : descendantWasClipped) || rawName.length > cfg.fieldMax;
      const textLength = derived && useOwn && !inline!.block ? inline!.length : undefined;
      if (rawName.length > 4096) throw new Error('Snapshot field limit');
      const name = clip(rawName);
      const isPassword = tag === 'input' && type === 'password';
      const inRegion = inSensitiveRegion(cur);
      const rawNameAttr = attr(cur, 'name') || '';
      if (rawNameAttr.length > 512) throw new Error('Snapshot field limit');
      const rawHints = [
        ...(bodyText ? [] : [rawName]),
        labelText,
        ...(labelEl ? [descendantText(labelEl, true)] : []),
        referenceText,
        attr(cur, 'aria-label') || '',
        attr(cur, 'placeholder') || '',
        attr(cur, 'title') || '',
        attr(cur, 'autocomplete') || '',
        curId,
        rawNameAttr,
      ];
      // An oversized classification hint cannot establish that an element is
      // public. In isolated read-only sessions, bound it to a sentinel that
      // forces conservative masking without evaluating the unbounded text.
      // Normal interactive sessions keep their existing fail-closed limit.
      const oversizedHint = rawHints.some(hint => hint.length > 4096);
      if (oversizedHint && !cfg.isolatedReadOnly) throw new Error('Snapshot field limit');
      const boundHint = (hint: string) => (hint.length > 4096 ? 'x'.repeat(cfg.fieldMax) : hint);
      const hints = rawHints.map(boundHint);
      const credentialField =
        ['input', 'textarea', 'select'].includes(tag) || role === 'textbox' || role === 'searchbox';
      const semanticHints = [
        referenceText,
        attr(cur, 'aria-label') || '',
        attr(cur, 'title') || '',
        attr(cur, 'autocomplete') || '',
        ...[curId, rawNameAttr].filter(hint => !/^(?:cookie|key|pin|session)$/i.test(hint)),
      ].map(boundHint);
      let sensitive =
        oversizedHint ||
        isPassword ||
        inRegion ||
        (credentialField ? hints : semanticHints).some(hint => hint.length >= cfg.fieldMax || sensitiveLabel(hint));
      const personal =
        personalContext(cur, cfg.privacyRules.personalContextLabelPattern, personalContexts) ||
        (credentialField &&
          (hints.some(hint => new RegExp(cfg.personalLabelPattern, 'iu').test(hint.normalize('NFKC'))) ||
            /(?:^|\s)name(?:$|\s)/i.test(attr(cur, 'autocomplete') ?? '')));
      let rawVal = '';
      if (tag === 'input' || tag === 'textarea') rawVal = store.integrity.value(cur);
      else if (tag === 'select') {
        const sel = cur as HTMLSelectElement;
        rawVal = sel.options[sel.selectedIndex]?.value ?? '';
        if (
          sel.selectedIndex >= 0 &&
          (inSensitiveRegion(sel.options[sel.selectedIndex]!) ||
            sensitiveLabel(sel.options[sel.selectedIndex]?.label ?? ''))
        )
          sensitive = true;
      }
      // Bounds of a slider or spinbutton: native range/number attributes, otherwise aria-valuemin/aria-valuemax; the ARIA current value is aria-valuenow.
      const nativeRange = tag === 'input' && (type === 'range' || type === 'number');
      const ariaRange = role === 'slider' || role === 'spinbutton';
      let min: number | undefined, max: number | undefined, step: number | 'any' | undefined;
      if (nativeRange || ariaRange) {
        min = rangeNumber(nativeRange ? attr(cur, 'min') : null) ?? rangeNumber(attr(cur, 'aria-valuemin'));
        max = rangeNumber(nativeRange ? attr(cur, 'max') : null) ?? rangeNumber(attr(cur, 'aria-valuemax'));
        const stepAttr = nativeRange ? attr(cur, 'step') : null;
        step = stepAttr?.trim().toLowerCase() === 'any' ? 'any' : rangeNumber(stepAttr);
        if (!nativeRange && tag !== 'input') rawVal = (attr(cur, 'aria-valuenow') ?? '').slice(0, 128);
      }
      // The text of an editing host is its value. A protected region is never read.
      let edited: ReturnType<typeof readEditable> | undefined;
      if (editable && !inRegion) {
        edited = readEditable(cur);
        rawVal = edited.text;
      }
      if (rawVal.length > 4096) throw new Error('Snapshot field limit');
      const hidePersonalChoices = tag === 'select' && personal && !cfg.allowPersonalData;
      const value = isPassword ? undefined : hidePersonalChoices && rawVal ? '[redacted]' : clip(rawVal);
      const valueClipped = !isPassword && (rawVal.length > cfg.fieldMax || edited?.overflow === true);
      const hiddenText =
        (!sensitive &&
          !inRegion &&
          (descendantOmittedHidden || (fromText && (concealedProse || inline?.hidden === true)))) ||
        (edited?.hidden === true && !sensitive);
      // The content of a secret-labelled editor is as secret as its value: nothing inside it is listed either.
      if (editable && sensitive) hideContent = true;
      const enabled =
        !r(cur, 'disabled') && !m(cur, 'closest', 'fieldset:disabled') && attr(cur, 'aria-disabled') !== 'true';
      const checked =
        tag === 'input' && (type === 'checkbox' || type === 'radio') ? store.integrity.checked(cur) : undefined;
      const selected = has(cur, 'aria-selected')
        ? attr(cur, 'aria-selected') === 'true'
        : tag === 'select'
          ? (cur as HTMLSelectElement).selectedIndex >= 0
          : undefined;
      const expanded = has(cur, 'aria-expanded') ? attr(cur, 'aria-expanded') === 'true' : undefined;
      let options: ElementInfo['options'];
      let optionsTruncated = false;
      let optionsTotal: number | undefined;
      const optionsTruncation: NonNullable<ElementInfo['options_truncation']> = [];
      if (tag === 'select') {
        const entries = (cur as HTMLSelectElement).options;
        optionsTotal = entries.length;
        if (entries.length > 100) {
          optionsTruncated = true;
          optionsTruncation.push('source_limit');
        }
        options = [];
        for (let i = 0; i < Math.min(entries.length, 100); i++) {
          const option = entries[i]!;
          if (option.label.length > 4096 || option.value.length > 4096) throw new Error('Snapshot field limit');
          const hidden = inSensitiveRegion(option) || sensitiveLabel(option.label);
          if (option.label.length > cfg.fieldMax || option.value.length > cfg.fieldMax) {
            optionsTruncated = true;
            if (!optionsTruncation.includes('field_limit')) optionsTruncation.push('field_limit');
          }
          options.push({
            label: hidden ? '[redacted]' : clip(option.label),
            value: hidden ? '[redacted]' : clip(option.value),
            disabled: option.disabled || option.parentElement?.matches('optgroup:disabled') === true,
            selected: option.selected,
          });
        }
      }
      const isSubmitControl =
        (tag === 'button' && (attr(cur, 'type') || 'submit') === 'submit' && !!form) ||
        (tag === 'input' && type === 'submit');
      const href = tag === 'a' ? attr(cur, 'href') || '' : '';
      const actionAttr = form ? attr(form, 'action') || '' : '';
      if (href.length > 2048 || actionAttr.length > 2048) throw new Error('Snapshot field limit');
      let linkHref = '';
      if (href) {
        try {
          const resolved = r(cur, 'href');
          if (typeof resolved === 'string' && resolved.length <= 4096) linkHref = resolved;
        } catch {
          /* The destination is optional detail. */
        }
      }
      if (tag === 'tr' && !nameTruncated && !sensitive && !inRegion) completeRows.add(cur);
      const dropCell =
        tag === 'td' &&
        !roleAttr &&
        !isInteractive &&
        !clickable &&
        !sensitive &&
        !inRegion &&
        !nameTruncated &&
        !hiddenText &&
        !!r(cur, 'parentElement') &&
        completeRows.has(r(cur, 'parentElement')) &&
        !editable &&
        !m(cur, 'closest', '[aria-hidden="true"]');
      const assistiveProse =
        concealedProse &&
        assistiveBox(cur) &&
        !!m(
          cur,
          'closest',
          'button,a[href],[role="button"],[role="link"],[role="checkbox"],[role="switch"],[role="tab"]',
        );
      if (!dropCell && !assistiveProse) {
        const id = idFor(cur);
        store.seen.add(id);
        if (structural) childGroup = id;
        const signature = JSON.stringify([
          id,
          role,
          rawName,
          enabled,
          checked,
          selected,
          expanded,
          type,
          isSubmitControl,
          href,
          actionAttr,
          rawVal,
          ownText,
          sensitive,
          options,
          optionsTruncated,
          depth,
          min,
          max,
          step,
          edited?.total,
        ]);
        sigParts.push(signature);
        try {
          if (optionsTruncated) throw new Error('evidence limit');
          // Child frames deliberately retain strict revision checks. Their stores
          // are collected separately and not merged into the main action map.
          const owningForm =
            (r(cur, 'form') as HTMLFormElement | null | undefined) ??
            (m(cur, 'closest', 'form') as HTMLFormElement | null) ??
            null;
          const formId = owningForm ? formEvidence(owningForm) : undefined;
          const target = JSON.stringify([
            signature,
            fullAttrs(cur),
            tag === 'a' ? (cur as HTMLAnchorElement).href : null,
            r(cur, 'formAction') ?? null,
            r(cur, 'formMethod') ?? null,
            r(cur, 'formEnctype') ?? null,
            r(cur, 'formTarget') ?? null,
          ]);
          accountEvidence(target.length);
          actionStates[id] = { target, ...(formId ? { form: formId } : {}) };
        } catch {
          /* Observation remains available; incomplete evidence never authorizes freshness fallback. */
        }
        if (!useOwn && fromText) descNamed.set(cur, elements.length);
        if (hiddenText) hiddenNodes.push(cur);
        elements.push({
          id,
          role,
          name,
          depth,
          ...(item.group ? { parent_id: item.group } : {}),
          ...(nameTruncated && !inRegion ? { name_truncated: true } : {}),
          ...(textLength !== undefined && !inRegion && !concealedProse ? { text_length: textLength } : {}),
          ...(linkHref && !sensitive && !inRegion ? { href: linkHref } : {}),
          ...(valueClipped && !sensitive && !inRegion ? { value_truncated: true as const } : {}),
          ...(options
            ? {
                // Keep the private evidence above sensitive to changes in option identities.
                options: hidePersonalChoices
                  ? options.map(option => ({ ...option, label: '[redacted]', value: '[redacted]' }))
                  : options,
                ...(optionsTruncated ? { options_truncated: true } : {}),
              }
            : {}),
          ...(optionsTotal !== undefined ? { options_total: optionsTotal } : {}),
          ...(optionsTruncation.length ? { options_truncation: optionsTruncation } : {}),
          ...(value !== undefined ? { value } : {}),
          ...(!sensitive && !inRegion
            ? {
                ...(min !== undefined ? { min } : {}),
                ...(max !== undefined ? { max } : {}),
                ...(step !== undefined ? { step } : {}),
              }
            : {}),
          enabled,
          ...(checked !== undefined ? { checked } : {}),
          ...(selected !== undefined ? { selected } : {}),
          ...(expanded !== undefined ? { expanded } : {}),
          ...(inRegion ? { protected: true } : {}),
          ...(sensitive ? { sensitive: true } : {}),
          ...(personal ? { personal: true } : {}),
          ...(hiddenText ? { hidden_text: true as const } : {}),
        });
      }
    }
    if (!skipChildren && !hideContent) {
      const shadow = r(cur, 'shadowRoot') as ShadowRoot | null;
      const shadowChild = shadow ? (r(shadow, 'firstElementChild') as HTMLElement | null) : null;
      const child = r(cur, 'firstElementChild') as HTMLElement | null;
      if (shadowChild) pending.push({ node: shadowChild, depth: depth + 1, group: childGroup, siblings: true });
      if (child) pending.push({ node: child, depth: depth + 1, group: childGroup, siblings: true });
    }
  }
  for (const node of hiddenNodes) {
    let ancestor = r(node, 'parentElement') as Element | null;
    for (
      let climbed = 0;
      ancestor && climbed < 16;
      climbed++, ancestor = r(ancestor, 'parentElement') as Element | null
    ) {
      const at = descNamed.get(ancestor);
      if (at !== undefined) elements[at]!.hidden_text = true;
    }
  }
  if (!store.integrity.check()) throw new Error('ADL_UNTRUSTED_DOM');
  return {
    elements,
    sig: JSON.stringify(sigParts),
    truncated,
    source_limits: [...sourceLimits],
    navigation: JSON.stringify([store.prefix, location.href, r(document, 'baseURI')]),
    actionStates,
    forms,
  };
}

// Runs inside the page: scrolls an element (or the document's scrolling element) by 80% of its height and reports whether it moved.
const snapshotWithPrivacy = withPersonalContext(snapshotPageFn);

function scrollByViewport(node: Element, args: { direction: 'up' | 'down'; key: string }): boolean {
  if (!(window as unknown as Record<string, BrowserIntegrity>)[args.key]?.check()) throw new Error('ADL_UNTRUSTED_DOM');
  const element = node as HTMLElement,
    proto = Object.getPrototypeOf(element),
    height = Reflect.get(proto, 'clientHeight', element) as number,
    before = Reflect.get(proto, 'scrollTop', element) as number;
  Reflect.apply(Reflect.get(proto, 'scrollBy', element), element, [
    { top: (args.direction === 'down' ? 1 : -1) * Math.max(1, height * 0.8), behavior: 'instant' },
  ]);
  return Reflect.get(proto, 'scrollTop', element) !== before;
}
// A scroll that could not move is a notice, not an error: the page or region was already at that end.
function scrollEdgeNotice(direction: 'up' | 'down', what: 'page' | 'region'): AdapterWarning {
  return {
    code: 'scroll_at_edge',
    count: 1,
    message: `Nothing scrolled: the ${what} is already at the ${direction === 'down' ? 'bottom' : 'top'}. Scroll the other way or observe.`,
  };
}

const STORE_INIT = (key: string) => {
  const integrity = (window as unknown as Record<string, BrowserIntegrity>)[key];
  if (!integrity || !integrity.check()) throw new Error('ADL_UNTRUSTED_DOM');
  const store = {
    ids: new WeakMap<object, string>(),
    nodes: new Map<string, object>(),
    seq: 0,
    prefix: '',
    seen: new Set<string>(),
    integrity,
    activity: 0,
  };
  // The post-action settle waits for the document to go quiet. A page that replaces MutationObserver only changes that timing.
  try {
    new MutationObserver(() => {
      store.activity++;
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch {
    /* timing only */
  }
  return store;
};

class BrowserSession implements AdapterSession {
  readonly tracksDispatch = true;
  private readonly frameStores = new Map<Frame, JSHandle<Store>>();
  private frameSeq = 0;
  // Blocks of the current document that no observation has reported yet; seq is the latest occurrence (blockSeq at that time).
  private readonly networkBlocks = new Map<string, BlockEntry>();
  private blockSeq = 0;
  /** A main-frame navigation whose request started when blockSeq was seq; its commit discards the blocks of the document it replaces. */
  private navigationPending: { request: Request; seq: number; at: number } | undefined;
  /** Main-frame navigations that replaced the document (not same-document ones): a write window opened before one cannot hand its holds over. */
  private documentReplacements = 0;
  /**
   * window: the write window a hold's verdict belongs to; a verdict ending an earlier action's hold (a denial arriving while a later
   * action runs) is not that action's block, so it goes to the document when the current window is another one.
   */
  recordNetworkBlock(code: string, origin?: string, resource_type = 'other', method = 'GET', window?: HoldWindow) {
    if (window && window.replacements !== this.documentReplacements) return;
    if (origin) {
      try {
        origin = new URL(origin).origin;
      } catch {
        origin = undefined;
      }
    }
    const key = [code, origin ?? '', resource_type, method].join('|');
    const seq = ++this.blockSeq;
    // While an action's window lives its blocks belong to that action's result; any other block belongs to the document and is reported once by an observation.
    const ww = this.writeWindow;
    this.addBlock(ww && !ww.collected && (!window || ww.id === window.id) ? ww.blocked : this.networkBlocks, key, {
      code,
      count: 1,
      ...(origin ? { origin } : {}),
      resource_type,
      method,
      seq,
      ...(window ? { held: true } : {}),
    });
  }
  /** Adds a block to a sink: the same block merges into its entry (count, latest occurrence); each class keeps up to 8 distinct entries, further ones only raise an existing entry's count, so action attribution never loses a block. */
  private addBlock(sink: Map<string, BlockEntry>, key: string, entry: BlockEntry): void {
    const old = sink.get(key);
    if (old) {
      old.count = Math.min(old.count + entry.count, 999999);
      old.seq = Math.max(old.seq, entry.seq);
      if (entry.held) old.held = true;
      return;
    }
    const action = isActionNetworkBlock(entry),
      peers = [...sink.values()].filter(w => isActionNetworkBlock(w) === action);
    if (peers.length < 8) sink.set(key, entry);
    else {
      const last = peers[peers.length - 1]!;
      last.count = Math.min(last.count + entry.count, 999999);
      last.seq = Math.max(last.seq, entry.seq);
    }
  }
  /** An action that ended with an error reports nothing itself: what it caused shows once in the next observation. */
  private adoptBlocks(blocks: Map<string, BlockEntry>): void {
    for (const [key, entry] of blocks) this.addBlock(this.networkBlocks, key, { ...entry });
  }
  /** Marks the blocks recorded up to RawSnapshot.warningSeq as reported. */
  acknowledgeWarnings(upToSeq: number): void {
    for (const [key, warning] of this.networkBlocks) if (warning.seq <= upToSeq) this.networkBlocks.delete(key);
  }
  pendingDocumentRedirect: string | undefined;
  // The answer at the end of a main-frame redirect chain, fetched with the chain so that a chain ending in 204/205 never
  // replaces the document. The redirect stub's refresh to that URL takes it once instead of fetching the URL again.
  private redirectedDocument: { url: string; response: FetchResult } | undefined;
  holdRedirectedDocument(url: string, response: FetchResult): void {
    this.redirectedDocument = { url, response };
  }
  /** Any main-frame navigation clears the held answer; only a GET of its URL receives it. */
  takeRedirectedDocument(url: string, method: string): FetchResult | undefined {
    const held = this.redirectedDocument;
    this.redirectedDocument = undefined;
    return held && held.url === url && method === 'GET' ? held.response : undefined;
  }
  private navigationFailure: { url: string; reason: ErrorReason } | undefined;
  /** A main-frame transport or proxy failure, surfaced without raw socket/certificate details. */
  recordNavigationFailure(request: Request, reason: ErrorReason) {
    if (request.isNavigationRequest() && request.frame() === this.page.mainFrame())
      this.navigationFailure = { url: request.url(), reason };
  }
  takeNavigationFailure(url: string): ErrorReason | undefined {
    const failure = this.navigationFailure;
    let href = url;
    try {
      href = new URL(url).href;
    } catch {}
    if (failure && failure.url === href) {
      this.navigationFailure = undefined;
      return failure.reason;
    }
    return undefined;
  }
  documentRedirects = 0;
  stylesheetRedirects = 0;
  approvedRequest?: { url: string; method: string; body: string; expires: number; frame: Frame };
  // Standard- and ask-mode submission guard: armed around the dispatch of a submit that
  // is consequential only because it submits. Chromium reports every form
  // submission (including script form.submit()) as a formSubmission navigation
  // before its request; the route then cancels that navigation in place, so no
  // form-submission navigation or non-GET request leaves without approval.
  private navigationProtocol: Promise<CDPSession> | undefined;
  private submissionGuard: { requested: number; blocked: number } | undefined;
  guardedSubmission(request: Request): boolean {
    const guard = this.submissionGuard;
    if (!guard || !request.isNavigationRequest() || request.resourceType() !== 'document') return false;
    if (request.method().toUpperCase() === 'GET' && guard.requested <= 0) return false;
    guard.blocked++;
    return true;
  }
  // The trusted per-workspace label lists; they only ever relax or add label-derived risk.
  private get labelLists(): LabelLists {
    return { allow: this.policy.consequentialAllowLabels ?? [], deny: this.policy.consequentialDenyLabels ?? [] };
  }
  private async armSubmissionGuard(): Promise<void> {
    if (!this.navigationProtocol)
      this.navigationProtocol = (async () => {
        const cdp = await this.context.newCDPSession(this.page);
        cdp.on('Page.frameRequestedNavigation', event => {
          if (this.submissionGuard && (event.reason === 'formSubmissionGet' || event.reason === 'formSubmissionPost'))
            this.submissionGuard.requested++;
        });
        await cdp.send('Page.enable');
        return cdp;
      })();
    await this.navigationProtocol;
    this.submissionGuard = { requested: 0, blocked: 0 };
  }
  // Containment (standard mode, and ask mode with an approver): a control consequential only through a verb that may stay in the
  // session ("Delete") is dispatched with the network closed to reads until the next action. The session's storage ends with it,
  // so what happens in the page stays there. Requests cannot be told apart by cause, so what passes is what the document was
  // already asking for before the click, such as its polling. A new read or navigation is the sign that the control reaches
  // further and stops the action, while a new image, style, font or media load is only left out, as a redraw may ask for one.
  // Writes are not decided here: they fall through to the method branch of the route, where ask mode holds them for approval and
  // standard mode blocks them (holdableWrites counts those a human could have been asked about).
  private containment: { blockedReads: number; blockedWrites: number; holdableWrites: number } | undefined;
  private readonly knownRequests = new Set<string>();
  containedRequest(request: Request): boolean {
    const read = ['GET', 'HEAD'].includes(request.method().toUpperCase());
    const navigation = request.isNavigationRequest();
    if (navigation) {
      if (!this.containment && request.frame() === this.pageValue?.mainFrame()) this.knownRequests.clear();
    } else if (read && !this.containment && this.knownRequests.size < MAX_KNOWN_REQUESTS)
      this.knownRequests.add(requestShape(request.url()));
    const containment = this.containment;
    if (!containment) return false;
    if (!read && !navigation) return false;
    if (read && !navigation && this.knownRequests.has(requestShape(request.url()))) return false;
    const passive = read && !navigation && ['image', 'stylesheet', 'font', 'media'].includes(request.resourceType());
    if (!passive) containment.blockedReads++;
    return true;
  }

  // Ask mode with an approver (set by the engine after open): a write the page sends during a click/press/fill/check/select is
  // paused inside the route instead of blocked, and act() reports it as HeldWritesError once the action's window has closed.
  private holdWritesEnabled = false;
  private writeWindow: WriteWindow | undefined;
  // The paused set an action left behind; at most one per session, until the engine releases or aborts it.
  private heldSet: { id: string; holds: PausedWrite[]; timer: ReturnType<typeof setTimeout> } | undefined;
  // Per released set: how many of its requests are still in flight, how many reached the network fetch or were refused before it, and
  // the statuses of those answered (heldWriteOutcome).
  private readonly heldOutcomes = new Map<
    string,
    { inflight: number; dispatched: number; refused: number; statuses: number[] }
  >();

  setWriteHolding(enabled: boolean): void {
    this.holdWritesEnabled = enabled;
  }
  /** Whether a write to an origin the workspace granted could be held right now (the route lets it past the origin check to decide). */
  canHoldNow(): boolean {
    const ww = this.writeWindow;
    return this.holdWritesEnabled && !!ww && ww.open && ww.hold;
  }
  private openWriteWindow(action: Action, authorization: ActionAuthorization | undefined): void {
    const now = Date.now();
    this.writeWindow = {
      id: crypto.randomUUID(),
      open: true,
      hold:
        this.holdWritesEnabled &&
        authorization?.holdWrites === true &&
        !this.policy.allowAllOperations &&
        HOLD_ACTIONS.has(action.action),
      holds: [],
      overflow: false,
      blocked: new Map(),
      collected: false,
      inflight: new Set(),
      lastActivity: now,
      dispatchedAt: now,
      baseline: SETTLED_ACTIONS.has(action.action) ? this.readActivity() : Promise.resolve(-1),
      replacements: this.documentReplacements,
      returned: false,
      refused: false,
      documentGone: false,
    };
  }
  /** The page's own thread waits for a request it sent (a synchronous XHR): nobody can be asked, so what is held fails closed and the page goes on. */
  private abortSynchronousHolds(ww: WriteWindow): void {
    ww.refused = true;
    const waiting = ww.holds.filter(paused => !paused.decided);
    if (!waiting.length) return;
    if (this.containment) this.containment.blockedWrites += waiting.length;
    this.abortHolds(waiting, 'request_not_approvable');
  }
  /** Whether the document the window opened on was replaced (or is being replaced) since: its holds belong to a page that is gone. */
  private windowDocumentReplaced(ww: WriteWindow): boolean {
    const pending = this.navigationPending;
    return (
      ww.documentGone || this.documentReplacements !== ww.replacements || (!!pending && pending.at >= ww.dispatchedAt)
    );
  }
  /** The document's mutation count (see STORE_INIT); -1 when it cannot be read (no store, the document went away). */
  private async readActivity(): Promise<number> {
    return (await this.store?.evaluate(store => store.activity).catch(() => -1)) ?? -1;
  }
  /** The write window's blocks as the action result carries them; later blocks belong to the document. */
  private collectWindowBlocks(): NetworkWarning[] {
    const ww = this.writeWindow;
    if (!ww) return [];
    ww.collected = true;
    // The same order as the observation's list: what the action itself set in motion first.
    return [...ww.blocked.values()]
      .map(({ seq: _seq, held: _held, ...warning }) => warning)
      .sort((a, b) => Number(isActionNetworkBlock(b)) - Number(isActionNetworkBlock(a)));
  }
  /** The request as a human could be asked about it, or undefined when it cannot be described completely (or is not holdable at all). */
  private holdShape(
    request: Request,
    url: URL,
    body: Buffer | undefined,
  ): { contentType: string; details: string[]; secret: boolean } | undefined {
    const page = this.pageValue;
    const method = request.method().toUpperCase();
    if (
      !page ||
      request.frame() !== page.mainFrame() ||
      request.isNavigationRequest() ||
      !['fetch', 'xhr'].includes(request.resourceType()) ||
      !HELD_METHODS.has(method) ||
      (url.origin !== this.origin &&
        !this.policy.allowAllBrowserOrigins &&
        !this.policy.allowedOrigins.includes(url.origin))
    )
      return undefined;
    const headers = request.headers();
    const contentType = headers['content-type'] ?? '';
    const base = contentType.split(';')[0]!.trim().toLowerCase();
    if ((base && !HELD_CONTENT_TYPES.has(base)) || (body && body.length > MAX_HELD_BODY)) return undefined;
    // Chromium exposes no bytes for a streamed (ReadableStream) upload, and an empty body is not told apart from it: a request that
    // describes a body in its headers but has none here is never shown as bodiless, so it is not approvable.
    if (!body && (contentType || (headers['content-length'] ?? '0') !== '0' || headers['transfer-encoding']))
      return undefined;
    // A header a server may read as the real method (X-HTTP-Method-Override: DELETE) is part of what the human approves.
    const overrides: string[] = [];
    for (const name of METHOD_OVERRIDE_HEADERS) {
      const value = headers[name];
      if (value === undefined) continue;
      if (value.length > 64) return undefined;
      overrides.push(`Method override header ${name}: ${JSON.stringify(value)}`);
    }
    let text: string | undefined;
    if (body && body.length) {
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
      } catch {
        return undefined;
      }
    }
    try {
      const described = describeHeldRequest({
        method,
        url: request.url(),
        contentType,
        ...(text !== undefined ? { body: text } : {}),
      });
      return { contentType, details: [...described.lines, ...overrides], secret: described.secret };
    } catch {
      return undefined;
    }
  }
  /**
   * The route's decision for a write that matches no permit: pause it until the engine releases or aborts it, or the code to
   * block it with. Only a main-frame fetch/XHR the page sends while a click/press/fill/check/select runs is ever held; whatever
   * else it sends (timers, beacons, sub-frames, uploads, a fifth request) is blocked, and the codes say why.
   */
  async holdWrite(request: Request, url: URL, body: Buffer | undefined): Promise<HoldVerdict> {
    const shape = this.holdShape(request, url, body);
    const refuse = (code: string): HoldVerdict => {
      const containment = this.containment;
      if (containment) {
        containment.blockedWrites++;
        if (shape) containment.holdableWrites++;
      }
      return { block: code };
    };
    if (!this.holdWritesEnabled) {
      // Nothing can approve it here: read_only has no actions, so every write is background traffic; otherwise the code says whether ask mode could have asked.
      if (this.policy.operationMode === 'read_only') return refuse('background_write_blocked');
      if (!shape) return refuse('request_not_approvable');
      return refuse(this.policy.operationMode === 'ask' ? 'approval_unavailable' : 'method_requires_approval');
    }
    if (this.heldSet) return refuse('approval_pending_other_action');
    const ww = this.writeWindow;
    if (!ww || !ww.open || !ww.hold) return refuse('background_write_blocked');
    if (!shape || ww.overflow || ww.refused) return refuse('request_not_approvable');
    if (ww.holds.length >= MAX_HELD_PER_ACTION) {
      // A partially approved save is worse than none: the whole set fails closed.
      ww.overflow = true;
      this.abortHolds(ww.holds, 'request_not_approvable');
      return refuse('request_not_approvable');
    }
    let resolve!: (verdict: string) => void;
    const decision = new Promise<string>(done => {
      resolve = done;
    });
    const paused: PausedWrite = {
      setId: ww.id,
      request,
      method: request.method().toUpperCase(),
      url: request.url(),
      contentType: shape.contentType,
      body,
      bodySha256: crypto
        .createHash('sha256')
        .update(body ?? Buffer.alloc(0))
        .digest('hex'),
      details: shape.details,
      secret: shape.secret,
      decision,
      decide: verdict => {
        if (paused.decided) return;
        paused.decided = true;
        resolve(verdict);
      },
      decided: false,
      abandoned: false,
    };
    ww.holds.push(paused);
    // The page's thread may be blocked in this very request (a synchronous XHR), which also blocks the dispatch that would end the
    // window. A request the page waits for cannot be shown to a human: if the dispatch has not returned within the grace, abort.
    if (!ww.returned && !ww.syncTimer) {
      ww.syncTimer = setTimeout(() => {
        ww.syncTimer = undefined;
        if (!ww.returned) this.abortSynchronousHolds(ww);
      }, SYNC_GRACE_MS);
      ww.syncTimer.unref();
    }
    const verdict = await decision;
    // Not counted as a containment block: a hold that ended is the human's or the page's doing. The block belongs to this set's window.
    if (verdict !== 'release') return { block: verdict, window: ww };
    return { expires: paused.releaseExpires, paused };
  }
  /** A released request is about to be sent: it passed the guard, DNS and the expiry re-check. */
  noteHeldDispatch(paused: PausedWrite): void {
    if (paused.dispatched) return;
    paused.dispatched = true;
    const outcome = this.heldOutcomes.get(paused.setId);
    if (outcome) outcome.dispatched++;
  }
  /** A released request's answer arrived (whatever the route does with it afterwards). */
  noteHeldResponse(paused: PausedWrite, status: number): void {
    this.heldOutcomes.get(paused.setId)?.statuses.push(status);
  }
  /** A released request is done with the route: answered, or failed or refused without an answer. */
  finishHeldWrite(paused: PausedWrite): void {
    const outcome = this.heldOutcomes.get(paused.setId);
    if (!outcome || outcome.inflight <= 0) return;
    outcome.inflight--;
    if (!paused.dispatched) outcome.refused++;
  }
  private abortHolds(holds: PausedWrite[], code: string): void {
    for (const paused of holds) paused.decide(code);
  }
  private abortAllHolds(code: string): void {
    const set = this.heldSet;
    this.heldSet = undefined;
    if (set) {
      clearTimeout(set.timer);
      this.abortHolds(set.holds, code);
    }
    if (this.writeWindow) this.abortHolds(this.writeWindow.holds, code);
  }
  /**
   * The page gave up on a request the route still holds (its own timeout or abort): nothing can be sent for it any more, and what was
   * approved (or is being asked) was the set as a whole, so the rest of the set goes with it: a save is sent complete or not at all.
   */
  private abandonHeld(request: Request): void {
    const ww = this.writeWindow;
    for (const holds of [this.heldSet?.holds, ww?.holds]) {
      const paused = holds?.find(candidate => candidate.request === request && !candidate.decided);
      if (!holds || !paused) continue;
      paused.abandoned = true;
      paused.decide('request_denied');
      const inWindow = holds === ww?.holds;
      if (inWindow) ww!.refused = true;
      this.abortHolds(holds, inWindow ? 'request_denied' : 'approval_invalidated');
    }
  }
  async releaseHeldWrites(holdId: string, expiresAt: number): Promise<void> {
    const set = this.heldSet;
    if (!set || set.id !== holdId) throw new AdlError('E_STALE_STATE');
    this.heldSet = undefined;
    clearTimeout(set.timer);
    // The set goes out whole: every request of it must still be pending (a request the page gave up on ends the whole set).
    if (!set.holds.length || set.holds.some(paused => paused.decided) || this.closed) {
      this.abortHolds(set.holds, 'approval_invalidated');
      throw new AdlError('E_STALE_STATE');
    }
    this.heldOutcomes.set(holdId, { inflight: set.holds.length, dispatched: 0, refused: 0, statuses: [] });
    while (this.heldOutcomes.size > MAX_HELD_OUTCOMES) this.heldOutcomes.delete(this.heldOutcomes.keys().next().value!);
    for (const paused of set.holds) {
      paused.releaseExpires = expiresAt;
      paused.decide('release');
    }
  }
  async abortHeldWrites(holdId: string, outcome: HeldWriteAbortOutcome): Promise<void> {
    const set = this.heldSet;
    if (!set || set.id !== holdId) return;
    this.heldSet = undefined;
    clearTimeout(set.timer);
    const code = {
      denied: 'approval_denied',
      expired: 'approval_expired',
      invalidated: 'approval_invalidated',
      not_approvable: 'request_not_approvable',
    }[outcome];
    this.abortHolds(set.holds, code);
  }
  heldWritesAlive(holdId: string): boolean {
    return this.heldSet?.id === holdId && this.heldSet.holds.every(paused => !paused.decided);
  }
  /**
   * Undefined while a released request is still in flight (or the set was never released); then how many requests reached the network
   * fetch and how many were refused before it, and the highest status answered when any was.
   */
  heldWriteOutcome(holdId: string): { dispatched: number; refused: number; response_status?: number } | undefined {
    const outcome = this.heldOutcomes.get(holdId);
    if (!outcome || outcome.inflight > 0) return undefined;
    return {
      dispatched: outcome.dispatched,
      refused: outcome.refused,
      ...(outcome.statuses.length ? { response_status: Math.max(...outcome.statuses) } : {}),
    };
  }
  private manualNetworkExpires = 0;
  // The origin the human approved, which a later redirect does not widen.
  private manualNetworkOrigin: string | undefined;
  private manualNetworkGeneration = 0;
  manualRequestGeneration(request: Request): number | undefined {
    return this.consumeManualRequest(request) ? this.manualNetworkGeneration : undefined;
  }
  manualRequestCurrent(request: Request, generation: number): boolean {
    return generation === this.manualNetworkGeneration && this.consumeManualRequest(request);
  }
  consumeManualRequest(request: Request): boolean {
    return (
      this.manualNetworkExpires > Date.now() &&
      request.frame() === this.page.mainFrame() &&
      new URL(request.url()).origin === this.manualNetworkOrigin
    );
  }

  private endRedirectWait: (() => void) | undefined;
  private async settleRedirect(): Promise<void> {
    const deadline = Date.now() + Math.min(5000, this.policy.actionTimeoutMs);
    while (this.pendingDocumentRedirect) {
      if (Date.now() >= deadline) throw new AdlError('E_POLICY_DENIED');
      const destination = this.pendingDocumentRedirect;
      try {
        // A destination answered with 204/205 never commits: the route ends the wait instead.
        await Promise.race([
          this.page.waitForURL(destination, {
            waitUntil: 'domcontentloaded',
            timeout: Math.max(1, deadline - Date.now()),
          }),
          new Promise<void>(resolve => {
            this.endRedirectWait = resolve;
          }),
        ]);
      } catch {
        throw new AdlError('E_POLICY_DENIED');
      }
      // A self-redirect can already match the current URL. Yield to the route
      // handler rather than spinning on immediately fulfilled promises.
      await new Promise<void>(resolve => setImmediate(resolve));
      this.checkAlive();
    }
  }

  /** Whether a request counts toward the post-action settle: the page's own data requests and navigations, not what it was already polling. */
  private attributable(request: Request): boolean {
    try {
      const page = this.pageValue;
      if (!page || request.frame() !== page.mainFrame() || !SETTLE_RESOURCE_TYPES.has(request.resourceType()))
        return false;
      if (request.isNavigationRequest() || !['GET', 'HEAD'].includes(request.method().toUpperCase())) return true;
      return !this.knownRequests.has(requestShape(request.url()));
    } catch {
      return false; // a request without a frame or a URL that does not parse is not the page's own data request
    }
  }
  private noteRequestStart(request: Request): void {
    const ww = this.writeWindow;
    if (!ww || !this.attributable(request)) return;
    ww.inflight.add(request);
    ww.lastActivity = Date.now();
  }
  private noteRequestEnd(request: Request): void {
    const ww = this.writeWindow;
    if (ww?.inflight.delete(request)) ww.lastActivity = Date.now();
  }
  /**
   * Waits until the page has reacted to an input action: no attributable request in flight and SETTLE_QUIET_MS without activity
   * (a request starting or ending, a DOM mutation), at the latest SETTLE_MAX_MS after the dispatch, and never so late that the
   * action's own time limit is at risk. A document that goes away or fails to answer ends the wait quietly.
   */
  private async settle(ww: WriteWindow, signal: AbortSignal, budgetEnd: number): Promise<void> {
    const deadline = Math.min(Math.max(ww.dispatchedAt + SETTLE_MAX_MS, Date.now() + SETTLE_QUIET_MS), budgetEnd);
    if (signal.aborted || Date.now() >= deadline) return;
    // A read that does not come back while a write is held means the page's thread is blocked in that request (a synchronous XHR
    // sent after the dispatch returned): it cannot be asked about, so it is aborted and the read then completes.
    const read = async (): Promise<number> => {
      const reading = this.readActivity();
      let grace: ReturnType<typeof setTimeout> | undefined;
      const stuck = new Promise<undefined>(resolve => {
        grace = setTimeout(() => resolve(undefined), SYNC_GRACE_MS);
        grace.unref();
      });
      try {
        const value = await Promise.race([reading, stuck]);
        if (value !== undefined) return value;
        if (ww.holds.some(paused => !paused.decided)) this.abortSynchronousHolds(ww);
        return await reading;
      } finally {
        clearTimeout(grace);
      }
    };
    let seen = await read();
    // The document is gone (it is being replaced): whatever it held belongs to a page that no longer exists, which act() checks.
    if (seen < 0) {
      ww.documentGone = true;
      return;
    }
    // The document changed between the dispatch and now (the handler's own render): it only counts as quiet from here on.
    const base = await ww.baseline;
    if (base >= 0 && base !== seen) ww.lastActivity = Date.now();
    for (;;) {
      const now = Date.now();
      if (signal.aborted || now >= deadline) return;
      const current = await read();
      if (current < 0) {
        ww.documentGone = true;
        return;
      }
      if (current !== seen) {
        seen = current;
        ww.lastActivity = Date.now();
      }
      if (ww.inflight.size === 0 && Date.now() - ww.lastActivity >= SETTLE_QUIET_MS) return;
      await new Promise(resolve => setTimeout(resolve, Math.max(1, Math.min(25, deadline - Date.now()))));
    }
  }

  capabilities?: string[];
  private isolatedReadOnly = false;
  private isolatedReader: IsolatedReadStore | null = null;
  private isolatedGeneration = -1;
  private documentIdentity: MainDocumentIdentity | undefined;
  private storeDocumentIdentity: string | undefined;
  // Remember documents that can return through BFCache. Once the bounded
  // history fills, disable compatibility fallback instead of forgetting trust.
  private readonly publishedDocuments = new Set<string>();
  private publicationTrackingFull = false;
  private closed = false;
  private closing: Promise<void> | undefined;
  private store: JSHandle<Store> | null = null;
  private pageValue: Page | null = null;
  private documentGeneration = 0;
  /** Status of the latest main-frame document response; undefined before the first one. */
  private documentStatus: number | undefined;
  private noteDocumentResponse(status: number): void {
    if (status !== 204 && status !== 205) this.documentStatus = status;
  }
  // A 204/205 answer ends a navigation without a document: Chromium aborts it and keeps the current one. When that response
  // reaches Chromium, Playwright reads the abort as a finished request and keeps waiting for the navigation (click and press, then
  // every later action) until it times out. So such an answer is aborted before Chromium reads it: by the network route, or
  // without one by the document interception in attach(). The count covers answers to the latest main-frame navigation.
  private noContentNavigations = 0;
  // Those that followed a stub: a hop that set cookies had to replace the document before the chain's end was known.
  private noContentAfterStub = 0;
  private latestMainNavigation: Request | undefined;
  /** Called by the network route when it aborts a navigation answered with 204/205. */
  noteNoContentNavigation(request: Request, afterStub = false): void {
    if (afterStub) {
      this.noContentAfterStub++;
      this.endRedirectWait?.();
    } else if (request === this.latestMainNavigation) this.noContentNavigations++;
  }
  private storeGeneration = 0;
  private readonly visualEpoch = crypto.randomUUID();
  private readonly captureGeometry = new Map<
    string,
    { generation: number; geometry: GestureGeometry; pointNonce?: string }
  >();
  openAbortCleanup: (() => void) | undefined;
  prefix = crypto.randomBytes(9).toString('base64url');
  readonly controller = new AbortController();
  readonly transportPool = new PinnedConnectionPool();
  readonly resourceCache = new BrowserResourceCache();

  constructor(
    private readonly owner: BrowserAdapter,
    private readonly policy: PolicyConfig,
    readonly context: BrowserContext,
    private readonly initialOrigin: string,
    private readonly controls: { selector: string; actions: string[] }[],
    private readonly visual?: VisualPolicy,
    private readonly gestures?: GesturePolicy,
    private readonly integrityKey = '',
    private readonly registrationSecret = '',
  ) {}

  get origin(): string {
    if (!this.pageValue) return this.initialOrigin;
    const current = new URL(this.pageValue.url()).origin;
    return this.policy.allowAllBrowserOrigins || this.policy.allowAllOperations || this.redirectOrigins.has(current)
      ? current
      : this.initialOrigin;
  }

  // Granted origins a server redirect took the session to (a sign-in that passes through an identity provider): the session
  // works there and may return, while links and navigate still cannot open a new origin by themselves.
  private readonly redirectOrigins = new Set<string>();
  reachByRedirect(origin: string): void {
    this.redirectOrigins.add(origin);
  }
  reachable(origin: string): boolean {
    return (
      this.policy.allowAllBrowserOrigins === true || origin === this.initialOrigin || this.redirectOrigins.has(origin)
    );
  }
  // A target's controls, visual masks and gestures describe its own origin, not one a redirect reached.
  private get onTargetOrigin(): boolean {
    return this.policy.allowAllOperations || this.origin === this.initialOrigin;
  }
  private get grantedControls() {
    return this.onTargetOrigin ? this.controls : [];
  }
  private get grantedVisual() {
    return this.onTargetOrigin ? this.visual : undefined;
  }
  private get grantedGestures() {
    return this.onTargetOrigin ? this.gestures : undefined;
  }

  private get page(): Page {
    if (!this.pageValue || (!this.store && !this.isolatedReadOnly)) throw new AdlError('E_TARGET_NOT_FOUND');
    return this.pageValue;
  }

  async attach(page: Page): Promise<void> {
    this.pageValue = page;
    page.on('framenavigated', frame => {
      if (frame !== page.mainFrame()) return;
      this.documentGeneration++;
      // A document replaced by a navigation takes its unreported blocks and the requests still held for it along; blocks recorded
      // during the navigation itself (its own redirect refusals) belong to the new document. Same-document navigations (hash,
      // pushState) start no request and keep both.
      const pending = this.navigationPending;
      this.navigationPending = undefined;
      if (!pending) return;
      this.documentReplacements++;
      // Chromium can cancel an old held request after the navigation starts but before it commits.
      for (const [key, warning] of this.networkBlocks)
        if (warning.held || warning.seq <= pending.seq) this.networkBlocks.delete(key);
      this.abortAllHolds(DOCUMENT_REPLACED);
    });
    page.on('request', request => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        this.latestMainNavigation = request;
        this.navigationPending = { request, seq: this.blockSeq, at: Date.now() };
      }
      this.noteRequestStart(request);
    });
    page.on('requestfinished', request => this.noteRequestEnd(request));
    page.on('requestfailed', request => {
      if (this.navigationPending?.request === request) this.navigationPending = undefined;
      // A request the route still holds is gone once the page cancels it. This may arrive before framenavigated.
      this.abandonHeld(request);
      this.noteRequestEnd(request);
    });
    // Same-document navigations (hash, pushState) fetch no document and so keep the last status. 204/205 leave the current document in place.
    page.on('response', response => {
      const request = response.request();
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
      this.noteDocumentResponse(response.status());
    });
    if (!routesNetwork(this.policy)) {
      // Without the network route, document responses pause here so a 204/205 answer is aborted as the route aborts it.
      const protocol = await this.context.newCDPSession(page);
      const mainFrameId = (await protocol.send('Page.getFrameTree')).frameTree.frame.id;
      protocol.on('Fetch.requestPaused', event => {
        const requestId = event.requestId;
        if (event.responseStatusCode !== 204 && event.responseStatusCode !== 205) {
          void protocol.send('Fetch.continueRequest', { requestId }).catch(() => undefined);
          return;
        }
        if (event.frameId === mainFrameId) this.noContentNavigations++;
        void protocol.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(() => undefined);
      });
      await protocol.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Response' }] });
    }
    this.store = await this.freshStore();
    this.storeGeneration = this.documentGeneration;
  }

  async sessionReady(): Promise<void> {
    await this.settleRedirect();
    await this.freshStoreAssign();
  }

  private async freshStore(): Promise<JSHandle<Store>> {
    if (!this.pageValue) throw new AdlError('E_TARGET_NOT_FOUND');
    this.prefix = crypto.randomBytes(9).toString('base64url');
    const handle = await this.initializeStore(this.pageValue);
    await handle.evaluate((s: Store, prefix: string) => {
      s.prefix = prefix;
    }, this.prefix);
    return handle as JSHandle<Store>;
  }

  private checkAlive(): void {
    if (this.closed) throw new AdlError('E_TARGET_NOT_FOUND');
  }
  private async registerPrototypes(signal?: AbortSignal): Promise<void> {
    if (!this.pageValue) throw new AdlError('E_TARGET_NOT_FOUND');
    try {
      await registerBrowserPrototypes(
        this.pageValue,
        { key: this.integrityKey, registrationSecret: this.registrationSecret },
        AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]),
      );
    } catch (error) {
      if (error instanceof AdlError && error.code === 'E_PRIVACY_BLOCKED' && !error.reason)
        throw new AdlError('E_PRIVACY_BLOCKED', 'untrusted_dom_api');
      throw error;
    }
  }
  private async initializeStore(frame: Page | Frame, signal?: AbortSignal): Promise<JSHandle<Store>> {
    try {
      return await frame.evaluateHandle(STORE_INIT, this.integrityKey);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('ADL_UNTRUSTED_DOM'))) throw error;
      await this.registerPrototypes(signal);
      try {
        return await frame.evaluateHandle(STORE_INIT, this.integrityKey);
      } catch (error) {
        if (error instanceof Error && error.message.includes('ADL_UNTRUSTED_DOM'))
          throw new AdlError('E_PRIVACY_BLOCKED', 'untrusted_dom_api');
        throw error;
      }
    }
  }
  private async collectSnapshot(
    store: JSHandle<Store>,
    cfg: Parameters<typeof snapshotPageFn>[1],
    signal?: AbortSignal,
  ): Promise<PageSnapshot> {
    try {
      return await store.evaluate(snapshotWithPrivacy, cfg);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('ADL_UNTRUSTED_DOM'))) throw error;
      await this.registerPrototypes(signal);
      try {
        return await store.evaluate(snapshotWithPrivacy, cfg);
      } catch (error) {
        if (error instanceof Error && error.message.includes('ADL_UNTRUSTED_DOM'))
          throw new AdlError('E_PRIVACY_BLOCKED', 'untrusted_dom_api');
        throw error;
      }
    }
  }
  private async assertIntegrity(signal?: AbortSignal): Promise<void> {
    this.checkAlive();
    for (const store of [this.store, ...this.frameStores.values()]) {
      if (!store) throw new AdlError('E_TARGET_NOT_FOUND');
      let intact = false;
      try {
        intact = await store.evaluate(value => value.integrity.check());
      } catch {
        throw new AdlError('E_STALE_STATE');
      }
      if (!intact) {
        await this.registerPrototypes(signal);
        if (!(await store.evaluate(value => value.integrity.check())))
          throw new AdlError('E_PRIVACY_BLOCKED', 'untrusted_dom_api');
      }
    }
  }

  private requireInteractivePage(): void {
    if (this.isolatedReadOnly) throw new AdlError('E_UNSUPPORTED_ACTION', 'isolated_read_only');
  }

  private async currentDocumentIdentity(signal?: AbortSignal): Promise<string> {
    this.checkAlive();
    if (!this.pageValue) throw new AdlError('E_TARGET_NOT_FOUND');
    this.documentIdentity ??= new MainDocumentIdentity(this.pageValue);
    const combined = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
    const identity = await this.documentIdentity.read(combined);
    this.checkAlive();
    if (combined.aborted) throw new AdlError('E_CANCELLED');
    return identity;
  }

  private canPublishIsolated(identity: string): boolean {
    return !this.publicationTrackingFull && !this.publishedDocuments.has(identity);
  }

  private notePublishedDocument(identity: string): void {
    if (this.publishedDocuments.has(identity)) return;
    if (this.publishedDocuments.size >= 4096) this.publicationTrackingFull = true;
    else this.publishedDocuments.add(identity);
  }

  private async isolatedStore(signal?: AbortSignal): Promise<IsolatedReadStore> {
    this.checkAlive();
    if (this.isolatedReader && this.isolatedGeneration === this.documentReplacements) return this.isolatedReader;
    const old = this.isolatedReader;
    this.isolatedReader = null;
    await old?.dispose();
    const page = this.page;
    const generation = this.documentGeneration,
      replacement = this.documentReplacements,
      url = page.url();
    if (new URL(url).origin !== this.origin) throw new AdlError('E_POLICY_DENIED');
    await this.owner.callGuard(url);
    const combined = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
    if (combined.aborted) throw new AdlError('E_CANCELLED');
    this.prefix = crypto.randomBytes(9).toString('base64url');
    const reader = await IsolatedReadStore.create(
      page,
      undefined,
      {
        installIntegrityFn: installIntegrity,
        storeInitFn: STORE_INIT,
        prefix: this.prefix,
      },
      combined,
    );
    if (
      combined.aborted ||
      this.closed ||
      generation !== this.documentGeneration ||
      replacement !== this.documentReplacements ||
      page.url() !== url
    ) {
      await reader.dispose();
      throw new AdlError(combined.aborted ? 'E_CANCELLED' : 'E_STALE_STATE');
    }
    this.isolatedReader = reader;
    this.isolatedGeneration = replacement;
    return reader;
  }

  private async activateIsolatedRead(expectedDocument: string, signal?: AbortSignal): Promise<void> {
    // Build the isolated store before committing the sticky downgrade. A
    // navigation may occur during setup, including return to a published page.
    await this.isolatedStore(signal);
    const currentDocument = await this.currentDocumentIdentity(signal);
    if (currentDocument !== expectedDocument || !this.canPublishIsolated(currentDocument)) {
      await this.isolatedReader?.dispose();
      this.isolatedReader = null;
      throw new AdlError('E_STALE_STATE');
    }
    this.isolatedReadOnly = true;
    this.capabilities = ['observe', 'read_state', 'wait_for', 'navigate', 'back'];
    const old = this.store;
    this.store = null;
    await old?.dispose().catch(() => undefined);
    for (const child of this.frameStores.values()) await child.dispose().catch(() => undefined);
    this.frameStores.clear();
  }

  private async freshStoreAssign(signal?: AbortSignal): Promise<void> {
    this.checkAlive();
    if (this.isolatedReadOnly) {
      await this.isolatedStore(signal);
      return;
    }
    const gen = this.documentGeneration;
    const expectedDocument = await this.currentDocumentIdentity(signal);
    let candidate: JSHandle<Store>;
    try {
      candidate = await this.freshStore();
    } catch (error) {
      if (
        error instanceof AdlError &&
        error.code === 'E_PRIVACY_BLOCKED' &&
        error.reason === 'untrusted_dom_api' &&
        this.canPublishIsolated(expectedDocument) &&
        gen === this.documentGeneration &&
        (await this.currentDocumentIdentity(signal)) === expectedDocument
      ) {
        await this.activateIsolatedRead(expectedDocument, signal);
        return;
      }
      throw error;
    }
    // Recheck lifetime and origin before publishing; never leave a handle
    // installed on a closed session, and dispose the candidate on failure.
    try {
      this.checkAlive();
      if ((await this.currentDocumentIdentity(signal)) !== expectedDocument) throw new AdlError('E_STALE_STATE');
      if (new URL(this.page.url()).origin !== this.origin) {
        await this.close();
        throw new AdlError('E_POLICY_DENIED');
      }
    } catch (e) {
      await candidate.dispose().catch(() => undefined);
      throw e;
    }
    const old = this.store;
    this.store = candidate;
    this.storeDocumentIdentity = expectedDocument;
    // A navigation committed while the handle was being created leaves
    // storeGeneration behind, so snapshot() recovers lazily next time.
    this.storeGeneration = gen;
    if (old) await old.dispose().catch(() => undefined);
  }

  // True only when a main-frame document navigation was observed (generation
  // advanced past the store's) and the old handle's context is confirmed
  // destroyed. Without a generation change it returns false so unrelated
  // evaluate errors are never masked and same-document hash/pushState keep
  // stable IDs.
  private async storeContextGone(): Promise<boolean> {
    const store = this.store;
    if (!store || this.closed) return false;
    const page = this.pageValue;
    if (!page || page.isClosed()) return false;
    try {
      await store.evaluate(() => undefined);
      return false;
    } catch {
      // Context destruction can arrive just before the main-frame commit event.
      // Confirm that event with a bounded read-only wait instead of turning this
      // short navigation race into E_INTERNAL. A live store or unrelated error
      // still cannot trigger recovery, and same-document changes keep their IDs.
      if (this.documentGeneration === this.storeGeneration) {
        await page
          .waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame(), timeout: 150 })
          .catch(() => undefined);
      }
      return !this.closed && !page.isClosed() && this.documentGeneration !== this.storeGeneration;
    }
  }

  // One recovery budget is shared by both recovery points of a single
  // observation call: the collection catch below and the final integrity
  // validation. A confirmed same-origin document replacement (main generation
  // advanced with the old store context destroyed) rebuilds the store and lets
  // the whole result be recollected once; a second race fails closed instead
  // of restarting again.
  async snapshot(signal?: AbortSignal): Promise<RawSnapshot> {
    let spent = false;
    const recover = async (): Promise<boolean> => {
      if (spent) return false;
      if (!(await this.storeContextGone())) return false;
      spent = true;
      this.checkAlive();
      if (signal?.aborted) throw new AdlError('E_CANCELLED');
      if (new URL(this.page.url()).origin !== this.origin) {
        await this.close();
        throw new AdlError('E_POLICY_DENIED');
      }
      await this.freshStoreAssign(signal);
      return true;
    };
    for (let attempt = 0; ; attempt++) {
      if (this.isolatedReadOnly) return this.isolatedSnapshot(signal);
      const attemptDocument = await this.currentDocumentIdentity(signal);
      try {
        const result = await this.snapshotAttempt(signal, recover);
        if (this.isolatedReadOnly) return result;
        // Recovery can replace the store inside snapshotAttempt. Bind publication
        // to that store's browser-owned document identity, never a navigation
        // event counter (pushState also emits framenavigated).
        const currentDocument = await this.currentDocumentIdentity(signal);
        if (currentDocument !== this.storeDocumentIdentity) throw new AdlError('E_STALE_STATE');
        this.notePublishedDocument(currentDocument);
        return result;
      } catch (error) {
        if (
          !this.isolatedReadOnly &&
          error instanceof AdlError &&
          error.code === 'E_PRIVACY_BLOCKED' &&
          error.reason === 'untrusted_dom_api' &&
          this.canPublishIsolated(attemptDocument) &&
          (await this.currentDocumentIdentity(signal)) === attemptDocument
        ) {
          await this.activateIsolatedRead(attemptDocument, signal);
          return this.isolatedSnapshot(signal);
        }
        if (attempt > 0 || !(error instanceof AdlError) || error.code !== 'E_STALE_STATE') throw error;
        if (!(await recover())) throw error;
      }
    }
  }

  private async isolatedSnapshot(signal?: AbortSignal): Promise<RawSnapshot> {
    this.checkAlive();
    await this.settleRedirect();
    const page = this.page,
      generation = this.documentGeneration,
      urlBefore = page.url();
    const combined = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
    if (combined.aborted) throw new AdlError('E_CANCELLED');
    if (new URL(urlBefore).origin !== this.origin) throw new AdlError('E_POLICY_DENIED');
    await this.owner.callGuard(urlBefore);
    const reader = await this.isolatedStore(combined);
    const cfg = {
      maxOut: 20000,
      visitCap: 100000,
      maxDepth: MAX_DOM_DEPTH,
      fieldMax: 512,
      isolatedReadOnly: true,
      secretLabelPattern: SECRET_LABEL_PATTERN,
      allowPersonalData: this.policy.allowPersonalData,
      personalLabelPattern: PERSONAL_LABEL_PATTERN,
      privacyRules: BROWSER_PRIVACY_RULES,
    };
    const res = await reader.evaluate<PageSnapshot, typeof cfg>(snapshotWithPrivacy, cfg, combined);
    const rawTitle = await reader.evaluate(
      (_store: Store) => {
        const title = Reflect.get(Object.getPrototypeOf(document), 'title', document);
        return typeof title === 'string' && title.length <= 4096 ? title : '';
      },
      null,
      combined,
    );
    await reader.evaluate(
      (store: Store) => {
        for (const id of Array.from(store.nodes.keys()))
          if (!store.seen.has(id)) {
            const n = store.nodes.get(id);
            if (n) store.ids.delete(n);
            store.nodes.delete(id);
          }
        store.seen.clear();
      },
      null,
      combined,
    );
    this.checkAlive();
    if (combined.aborted) throw new AdlError('E_CANCELLED');
    if (generation !== this.documentGeneration || page.url() !== urlBefore) throw new AdlError('E_STALE_STATE');
    await this.owner.callGuard(urlBefore);
    this.checkAlive();
    if (combined.aborted) throw new AdlError('E_CANCELLED');
    if (generation !== this.documentGeneration || page.url() !== urlBefore) throw new AdlError('E_STALE_STATE');
    if (page.frames().length > 1) {
      res.truncated = true;
      res.source_limits.push('frame_unavailable');
    }
    const url = redactUrl(urlBefore, this.policy.allowPersonalData),
      title = redactString(rawTitle, this.policy.allowPersonalData);
    const warnings = [...this.networkBlocks.values()]
      .map(({ seq: _seq, held: _held, ...warning }) => warning)
      .sort((a, b) => Number(isActionNetworkBlock(b)) - Number(isActionNetworkBlock(a)));
    const warningSeq = this.blockSeq;
    const httpStatus =
      this.documentStatus !== undefined && this.documentStatus >= 400 ? this.documentStatus : undefined;
    const fingerprint = crypto
      .createHash('sha256')
      .update(
        res.sig +
          JSON.stringify([
            url,
            title,
            warningSeq,
            httpStatus ?? null,
            res.truncated,
            [...new Set(res.source_limits)].sort(),
          ]),
      )
      .digest('hex');
    return {
      elements: res.elements,
      fingerprint,
      truncated: res.truncated,
      read_only: true,
      ...(res.source_limits.length ? { source_limits: [...new Set(res.source_limits)] } : {}),
      url,
      title,
      warningSeq,
      ...(warnings.length ? { warnings } : {}),
      ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
    };
  }

  private async snapshotAttempt(
    signal: AbortSignal | undefined,
    recover: () => Promise<boolean>,
  ): Promise<RawSnapshot> {
    this.checkAlive();
    await this.settleRedirect();
    if (new URL(this.page.url()).origin !== this.origin) {
      await this.close();
      throw new AdlError('E_POLICY_DENIED');
    }
    const maxOut = 20000;
    const cfg = {
      maxOut,
      visitCap: 100000,
      maxDepth: MAX_DOM_DEPTH,
      fieldMax: 512,
      secretLabelPattern: SECRET_LABEL_PATTERN,
      allowPersonalData: this.policy.allowPersonalData,
      personalLabelPattern: PERSONAL_LABEL_PATTERN,
      privacyRules: BROWSER_PRIVACY_RULES,
    };
    let res: PageSnapshot;
    try {
      res = await this.collectSnapshot(this.store!, cfg, signal);
    } catch (e) {
      if (e instanceof AdlError) throw e;
      if (e instanceof Error && e.message.includes('ADL_UNTRUSTED_DOM'))
        throw new AdlError('E_PRIVACY_BLOCKED', 'untrusted_dom_api');
      if (e instanceof Error && e.message.includes('Snapshot field limit')) throw new AdlError('E_RESOURCE_LIMIT');
      this.checkAlive();
      // Bounded lazy recovery: a same-origin document replacement (link click)
      // destroys the store handle's context; rebuild once, only when confirmed.
      if (!(await recover())) {
        this.checkAlive();
        throw new AdlError('E_INTERNAL');
      }
      this.checkAlive();
      if (this.isolatedReadOnly) return this.isolatedSnapshot(signal);
      try {
        res = await this.collectSnapshot(this.store!, cfg, signal);
      } catch (e2) {
        if (e2 instanceof AdlError) throw e2;
        if (e2 instanceof Error && e2.message.includes('ADL_UNTRUSTED_DOM'))
          throw new AdlError('E_PRIVACY_BLOCKED', 'untrusted_dom_api');
        if (e2 instanceof Error && e2.message.includes('Snapshot field limit')) throw new AdlError('E_RESOURCE_LIMIT');
        this.checkAlive();
        throw new AdlError('E_INTERNAL');
      }
    }
    this.checkAlive();
    if (new URL(this.page.url()).origin !== this.origin) {
      await this.close();
      throw new AdlError('E_POLICY_DENIED');
    }
    // Each allowed frame has a private store in its own realm. Cross-origin DOM
    // access is never used; the same network/origin guard gates frame observation.
    for (const [frame, store] of this.frameStores)
      if (frame.isDetached()) {
        this.frameStores.delete(frame);
        await store.dispose().catch(() => undefined);
      }
    const frames = this.page.frames().filter(frame => frame !== this.page.mainFrame());
    if (frames.length > 32) {
      res.truncated = true;
      res.source_limits.push('frame_limit');
    }
    for (const frame of frames.slice(0, 32)) {
      if (res.elements.length >= maxOut) {
        res.truncated = true;
        res.source_limits.push('element_limit');
        break;
      }
      try {
        let frameUrl = frame.url();
        if (frameUrl === 'about:blank' || frameUrl === 'about:srcdoc') frameUrl = frame.parentFrame()?.url() ?? '';
        await this.owner.callGuard(frameUrl);
        let parent: Frame | null = frame,
          protectedFrame = false;
        while (parent?.parentFrame()) {
          const host = await parent.frameElement();
          if (!(await host.isVisible())) {
            await host.dispose();
            protectedFrame = true;
            break;
          }
          protectedFrame = await host.evaluate((element, rule) => {
            const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
              m = (o: object, k: string, ...a: unknown[]): any => Reflect.apply(r(o, k), o, a);
            let node: Element | null = element as Element;
            let depth = 0;
            while (node && depth++ < rule.ancestorCap) {
              if (m(node, 'matches', rule.regionSelector)) return true;
              node =
                (r(node, 'parentElement') as Element | null) ?? (m(node, 'getRootNode') as ShadowRoot).host ?? null;
            }
            return node !== null;
          }, BROWSER_PRIVACY_RULES);
          await host.dispose();
          if (protectedFrame) break;
          parent = parent.parentFrame();
        }
        if (protectedFrame) continue;
        let store = this.frameStores.get(frame);
        if (store) {
          try {
            await store.evaluate(() => undefined);
          } catch {
            await store.dispose().catch(() => undefined);
            this.frameStores.delete(frame);
            store = undefined;
          }
        }
        if (!store) {
          store = await this.initializeStore(frame, signal);
          await store.evaluate((value, prefix) => {
            value.prefix = prefix;
          }, `${this.prefix}_f${++this.frameSeq}`);
          this.frameStores.set(frame, store);
        }
        const child = await this.collectSnapshot(store, { ...cfg, maxOut: maxOut - res.elements.length }, signal);
        res.elements.push(...child.elements);
        res.sig += child.sig;
        res.truncated ||= child.truncated;
        res.source_limits.push(...child.source_limits);
        await store.evaluate(value => {
          for (const [id, node] of value.nodes)
            if (!value.seen.has(id)) {
              value.ids.delete(node);
              value.nodes.delete(id);
            }
          value.seen.clear();
        });
      } catch {
        res.truncated = true;
        res.source_limits.push('frame_unavailable');
      }
    }
    // Prune the private handle table to the current observation (bounds memory).
    await this.store!.evaluate((s: Store) => {
      for (const id of Array.from(s.nodes.keys())) {
        if (!s.seen.has(id)) {
          const n = s.nodes.get(id);
          if (n) s.ids.delete(n);
          s.nodes.delete(id);
        }
      }
      s.seen.clear();
    }, undefined).catch(() => undefined);
    this.checkAlive();
    if (new URL(this.page.url()).origin !== this.origin) {
      await this.close();
      throw new AdlError('E_POLICY_DENIED');
    }
    await this.owner.callGuard(this.page.url());
    const url = redactUrl(this.page.url(), this.policy.allowPersonalData),
      title = redactString(await this.page.title(), this.policy.allowPersonalData);
    // The blocks no observation has reported yet, those of an action first. Reporting never changes the revision (the fingerprint
    // hashes blockSeq), a new block does.
    const warnings = [...this.networkBlocks.values()]
      .map(({ seq: _seq, held: _held, ...warning }) => warning)
      .sort((a, b) => Number(isActionNetworkBlock(b)) - Number(isActionNetworkBlock(a)));
    const warningSeq = this.blockSeq;
    const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
    const formDigests = Object.fromEntries(Object.entries(res.forms).map(([id, value]) => [id, digest(value)]));
    const actionEvidence = {
      navigation: digest(JSON.stringify([res.navigation, this.documentGeneration])),
      elements: Object.fromEntries(
        Object.entries(res.actionStates).map(([id, state]) => [
          id,
          digest(JSON.stringify([state.target, state.form ? formDigests[state.form] : null])),
        ]),
      ),
    };
    // Only an error status is reported; a change of status (for example a reload) is a new revision.
    const httpStatus =
      this.documentStatus !== undefined && this.documentStatus >= 400 ? this.documentStatus : undefined;
    const fingerprint = digest(
      res.sig +
        JSON.stringify([
          url,
          title,
          warningSeq,
          actionEvidence,
          httpStatus ?? null,
          res.truncated,
          [...new Set(res.source_limits)].sort(),
        ]),
    );
    await this.assertIntegrity(signal);
    return {
      elements: res.elements,
      fingerprint,
      truncated: res.truncated,
      ...(res.source_limits.length ? { source_limits: [...new Set(res.source_limits)] } : {}),
      url,
      title,
      actionEvidence,
      warningSeq,
      ...(warnings.length ? { warnings } : {}),
      ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
    };
  }

  async readText(
    elementId: string,
    offset: number,
    length: number,
    signal: AbortSignal,
  ): Promise<{
    text: string;
    total_length: number;
    next_offset: number | null;
    truncated: boolean;
    hidden_text?: true;
  }> {
    this.checkAlive();
    if (signal.aborted) throw new AdlError('E_CANCELLED');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 1048576)
      throw new AdlError('E_INVALID_ARGUMENT');
    if (this.isolatedReadOnly) {
      const page = this.page,
        generation = this.documentGeneration,
        url = page.url();
      if (new URL(url).origin !== this.origin) throw new AdlError('E_POLICY_DENIED');
      await this.owner.callGuard(url);
      const combined = AbortSignal.any([this.controller.signal, signal]);
      const reader = await this.isolatedStore(combined);
      const result = await reader.evaluateElement(
        elementId,
        readTextPageFn,
        {
          rules: BROWSER_PRIVACY_RULES,
          pattern: SECRET_LABEL_PATTERN,
          allowPersonalData: this.policy.allowPersonalData,
        },
        combined,
      );
      this.checkAlive();
      if (combined.aborted) throw new AdlError('E_CANCELLED');
      if (generation !== this.documentGeneration || page.url() !== url) throw new AdlError('E_STALE_STATE');
      await this.owner.callGuard(url);
      this.checkAlive();
      if (combined.aborted) throw new AdlError('E_CANCELLED');
      if (generation !== this.documentGeneration || page.url() !== url) throw new AdlError('E_STALE_STATE');
      return this.finishReadText(result, offset, length);
    }
    let store = this.store!,
      frame: Frame | undefined;
    if (!elementId.startsWith(this.prefix + '-')) {
      store = null as unknown as JSHandle<Store>;
      for (const [candidate, value] of this.frameStores) {
        if (await value.evaluate((s, id) => s.nodes.has(id), elementId)) {
          store = value;
          frame = candidate;
          break;
        }
      }
      if (!store || !frame) throw new AdlError('E_TARGET_NOT_FOUND');
      for (let current: Frame | null = frame; current?.parentFrame(); current = current.parentFrame()) {
        const url = current.url().startsWith('about:') ? current.parentFrame()!.url() : current.url();
        await this.owner.callGuard(url);
        const host = await current.frameElement();
        try {
          if (
            await host.evaluate((element, rules) => {
              const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
                m = (o: object, k: string, ...a: unknown[]): any => Reflect.apply(r(o, k), o, a);
              let node: Element | null = element as Element,
                depth = 0;
              while (node && depth++ < rules.ancestorCap) {
                if (m(node, 'matches', rules.regionSelector)) return true;
                node =
                  (r(node, 'parentElement') as Element | null) ?? (m(node, 'getRootNode') as ShadowRoot).host ?? null;
              }
              return node !== null;
            }, BROWSER_PRIVACY_RULES)
          )
            throw new AdlError('E_PRIVACY_BLOCKED');
        } finally {
          await host.dispose();
        }
      }
    }
    const generation = this.documentGeneration;
    const handle = await store.evaluateHandle((s, id) => s.nodes.get(id) ?? null, elementId);
    const element = handle.asElement() as ElementHandle | null;
    if (!element) {
      await handle.dispose();
      throw new AdlError('E_TARGET_NOT_FOUND');
    }
    let result: { error: 'missing' | 'protected' } | { text: string; truncated: boolean; hidden?: boolean };
    try {
      await element.scrollIntoViewIfNeeded({ timeout: this.policy.actionTimeoutMs });
      result = await isolatedCollect(
        element,
        readTextPageFn,
        {
          rules: BROWSER_PRIVACY_RULES,
          pattern: SECRET_LABEL_PATTERN,
          allowPersonalData: this.policy.allowPersonalData,
        },
        [],
        frame ?? this.page.mainFrame(),
      );
    } finally {
      await handle.dispose().catch(() => undefined);
    }
    this.checkAlive();
    if (signal.aborted) throw new AdlError('E_CANCELLED');
    if (generation !== this.documentGeneration) throw new AdlError('E_STALE_STATE');
    return this.finishReadText(result, offset, length);
  }

  async readOptions(
    elementId: string,
    query: string,
    offset: number,
    limit: number,
    signal: AbortSignal,
  ): Promise<OptionsResult> {
    if (
      query.length > 512 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new AdlError('E_INVALID_ARGUMENT');
    // Reuse the origin, frame ancestry, privacy and document checks of direct text reads.
    await this.readText(elementId, 0, 1, signal);
    const generation = this.documentGeneration;
    const arg: OptionsPageArgs = {
      query,
      offset,
      limit,
      allowPersonalData: this.policy.allowPersonalData === true,
      secretPattern: SECRET_LABEL_PATTERN,
      personalPattern: PERSONAL_LABEL_PATTERN,
      rules: BROWSER_PRIVACY_RULES,
      textRules: TEXT_REDACTION_RULES,
      personalRules: PERSONAL_DATA_REDACTION_RULES,
    };
    let result: OptionsResult | { error: 'missing' | 'protected' | 'unsupported' | 'limit' };
    if (this.isolatedReadOnly) {
      result = await (await this.isolatedStore(signal)).evaluateElement(elementId, readOptionsPageFn, arg, signal);
    } else {
      let store = this.store!,
        frame = this.page.mainFrame();
      if (!elementId.startsWith(this.prefix + '-')) {
        let found = false;
        for (const [candidate, value] of this.frameStores) {
          if (await value.evaluate((s, id) => s.nodes.has(id), elementId)) {
            store = value;
            frame = candidate;
            found = true;
            break;
          }
        }
        if (!found) throw new AdlError('E_TARGET_NOT_FOUND');
      }
      const handle = await store.evaluateHandle((s, id) => s.nodes.get(id) ?? null, elementId);
      try {
        const element = handle.asElement() as ElementHandle | null;
        if (!element) throw new AdlError('E_TARGET_NOT_FOUND');
        result = await isolatedCollect(element, readOptionsPageFn, arg, [], frame);
      } finally {
        await handle.dispose().catch(() => undefined);
      }
    }
    this.checkAlive();
    if (signal.aborted) throw new AdlError('E_CANCELLED');
    if (generation !== this.documentGeneration) throw new AdlError('E_STALE_STATE');
    if ('error' in result)
      throw new AdlError(
        result.error === 'protected'
          ? 'E_PRIVACY_BLOCKED'
          : result.error === 'limit'
            ? 'E_RESOURCE_LIMIT'
            : result.error === 'unsupported'
              ? 'E_UNSUPPORTED_ACTION'
              : 'E_TARGET_NOT_FOUND',
      );
    return result;
  }

  private finishReadText(result: PageTextResult, offset: number, length: number) {
    if ('error' in result)
      throw new AdlError(result.error === 'protected' ? 'E_PRIVACY_BLOCKED' : 'E_TARGET_NOT_FOUND');
    const text = redactText(result.text, this.policy.allowPersonalData === true);
    const high = (code: number) => code >= 0xd800 && code <= 0xdbff,
      low = (code: number) => code >= 0xdc00 && code <= 0xdfff;
    if (offset > text.length || (offset > 0 && low(text.charCodeAt(offset)) && high(text.charCodeAt(offset - 1))))
      throw new AdlError('E_INVALID_ARGUMENT');
    let end = Math.min(text.length, offset + length);
    if (end < text.length && high(text.charCodeAt(end - 1)) && low(text.charCodeAt(end))) end++;
    return {
      text: text.slice(offset, end),
      total_length: text.length,
      next_offset: end < text.length ? end : null,
      truncated: result.truncated,
      ...(result.hidden ? { hidden_text: true as const } : {}),
    };
  }

  async capture(signal: AbortSignal): Promise<CapturedImage> {
    this.requireInteractivePage();
    this.checkAlive();
    await this.assertIntegrity(signal);
    if (signal.aborted) {
      await this.close();
      throw new AdlError('E_CANCELLED');
    }
    const onAbort = () => {
      void this.close();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    const generation = this.documentGeneration;
    try {
      return await Promise.race([
        (async () => {
          await ensurePointSelector();
          const pointNonce = crypto.randomBytes(12).toString('base64url');
          const pointReady = (await this.page.locator(pointSelector('capture', pointNonce)).count()) === 1;
          const geometry = await captureGestureGeometry(
            this.page,
            this.grantedGestures ?? { enabled: false, surfaces: [] },
            signal,
          );
          const image = await captureBrowserImage(
            this.page,
            this.origin,
            this.grantedVisual,
            signal,
            this.policy.allowPersonalData,
          );
          const after = await captureGestureGeometry(
            this.page,
            this.grantedGestures ?? { enabled: false, surfaces: [] },
            signal,
          );
          this.checkAlive();
          if (signal.aborted) throw new AdlError('E_CANCELLED');
          if (JSON.stringify(geometry) !== JSON.stringify(after) || generation !== this.documentGeneration)
            throw new AdlError('E_STALE_STATE');
          if (pointReady && (await this.page.locator(pointSelector('validate', pointNonce)).count()) !== 1)
            throw new AdlError('E_STALE_STATE');
          const epoch = `${this.visualEpoch}:${generation}:${crypto.randomBytes(9).toString('base64url')}`;
          this.captureGeometry.set(epoch, { generation, geometry, ...(pointReady ? { pointNonce } : {}) });
          while (this.captureGeometry.size > 16) this.captureGeometry.delete(this.captureGeometry.keys().next().value!);
          await this.assertIntegrity(signal);
          return { ...image, surface_epoch: epoch };
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            void this.close();
            reject(new AdlError('E_TIMEOUT'));
          }, this.policy.actionTimeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof AdlError && ['E_TIMEOUT', 'E_CANCELLED'].includes(error.code)) await this.close();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async gesture(plan: GesturePlan, reference: GestureReference, signal: AbortSignal): Promise<GestureExecution> {
    this.requireInteractivePage();
    await this.assertIntegrity(signal);
    this.checkAlive();
    this.containment = undefined;
    const proof = reference.surface_epoch ? this.captureGeometry.get(reference.surface_epoch) : undefined;
    const assertCurrent = () => {
      this.checkAlive();
      if (!proof || proof.generation !== this.documentGeneration) throw new AdlError('E_STALE_STATE');
      if (new URL(this.page.url()).origin !== this.origin) throw new AdlError('E_POLICY_DENIED');
    };
    assertCurrent();
    try {
      return await runBrowserGesture(
        this.page,
        plan,
        this.grantedGestures ?? { enabled: false, surfaces: [] },
        reference,
        signal,
        assertCurrent,
        this.policy.allowAllOperations,
        proof!.geometry,
      );
    } catch (error) {
      if (signal.aborted || (error instanceof AdlError && error.mayHaveExecuted)) await this.close();
      throw error;
    }
  }

  private async pointTarget(point: { x: number; y: number }, reference: GestureReference, signal: AbortSignal) {
    this.checkAlive();
    if (signal.aborted) throw new AdlError('E_CANCELLED');
    const proof = reference.surface_epoch ? this.captureGeometry.get(reference.surface_epoch) : undefined;
    if (
      !proof?.pointNonce ||
      proof.generation !== this.documentGeneration ||
      reference.coordinate_space !== 'viewport_css_pixels'
    )
      throw new AdlError('E_STALE_STATE');
    const cdp = await this.context.newCDPSession(this.page);
    try {
      // Viewport CSS pixels to the document coordinates DOM.getNodeForLocation expects.
      const scroll = (await cdp.send('Page.getLayoutMetrics')).cssVisualViewport;
      const hit = await cdp.send('DOM.getNodeForLocation', {
        x: Math.floor(point.x + scroll.pageX),
        y: Math.floor(point.y + scroll.pageY),
        includeUserAgentShadowDOM: true,
      });
      const tree = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
      const pending = [{ node: tree.root, closed: false }];
      let visited = 0,
        found = false;
      while (pending.length) {
        const item = pending.pop()!;
        if (++visited > 10000) throw new AdlError('E_RESOURCE_LIMIT');
        const closed = item.closed || item.node.shadowRootType === 'closed';
        if (item.node.backendNodeId === hit.backendNodeId) {
          found = true;
          if (closed) throw new AdlError('E_PRIVACY_BLOCKED');
          break;
        }
        for (const node of [...(item.node.children ?? []), ...(item.node.shadowRoots ?? [])])
          pending.push({ node, closed });
      }
      if (!found) throw new AdlError('E_STALE_STATE');
    } catch (error) {
      if (error instanceof AdlError) throw error;
      throw new AdlError('E_STALE_STATE');
    } finally {
      await cdp.detach().catch(() => undefined);
    }
    if (signal.aborted) throw new AdlError('E_CANCELLED');
    return this.page.locator(pointSelector('point', proof.pointNonce, point.x, point.y));
  }
  async resolvePoint(point: { x: number; y: number }, reference: GestureReference, signal: AbortSignal) {
    this.requireInteractivePage();
    const locator = await this.pointTarget(point, reference, signal);
    if ((await locator.count()) !== 1) throw new AdlError('E_STALE_STATE');
    const node = await locator.elementHandle();
    if (!node) throw new AdlError('E_STALE_STATE');
    try {
      return await this.store!.evaluate(
        (store, args) => {
          let e: Element | null = args.node as Element,
            depth = 0;
          while (e && depth++ < 128) {
            for (const [id, node] of store.nodes) if (node === e) return id;
            e =
              (Reflect.get(Object.getPrototypeOf(e), 'parentElement', e) as Element | null) ??
              (Reflect.apply(Reflect.get(Object.getPrototypeOf(e), 'getRootNode', e), e, []) as ShadowRoot).host ??
              null;
          }
          return undefined;
        },
        { node },
      );
    } finally {
      await node.dispose();
    }
  }
  async clickPoint(
    point: { x: number; y: number },
    reference: GestureReference,
    signal: AbortSignal,
    onDispatch: () => void,
  ) {
    this.requireInteractivePage();
    await this.assertIntegrity(signal);
    if (!this.policy.allowAllOperations) throw new AdlError('E_APPROVAL_REQUIRED', 'operation_not_granted');
    const locator = await this.pointTarget(point, reference, signal);
    if ((await locator.count()) !== 1) throw new AdlError('E_STALE_STATE');
    if (signal.aborted) throw new AdlError('E_CANCELLED');
    await this.page.mouse.move(point.x, point.y);
    if ((await locator.count()) !== 1) throw new AdlError('E_STALE_STATE');
    await this.assertIntegrity(signal);
    let sent = false;
    try {
      onDispatch();
      sent = true;
      await this.page.mouse.click(point.x, point.y);
      await this.settleRedirect();
    } catch (error) {
      const safe = error instanceof AdlError ? error : new AdlError('E_INTERNAL');
      safe.mayHaveExecuted = sent;
      throw safe;
    }
  }

  async prepareAction(action: Action, signal: AbortSignal) {
    this.requireInteractivePage();
    this.checkAlive();
    if (signal.aborted) throw new AdlError('E_CANCELLED');
    await this.assertIntegrity(signal);
    const id = action.element_id;
    if (!id) throw new AdlError('E_TARGET_NOT_FOUND');
    let target = this.store;
    if (!id.startsWith(this.prefix + '-')) {
      target = null;
      for (const store of this.frameStores.values())
        if (await store.evaluate((value, key) => value.nodes.has(key), id)) {
          target = store;
          break;
        }
    }
    if (!target) throw new AdlError('E_TARGET_NOT_FOUND');
    const handle = await target.evaluateHandle((store: Store, key: string) => {
      const node = store.nodes.get(key);
      return node && (node as Node).isConnected ? (node as Element) : null;
    }, id);
    try {
      const element = handle.asElement();
      if (!element) throw new AdlError('E_TARGET_NOT_FOUND');
      await element.scrollIntoViewIfNeeded({ timeout: this.policy.actionTimeoutMs });
      if (signal.aborted) throw new AdlError('E_CANCELLED');
      const proof = await inspectBrowserAction(
        element,
        action,
        [...this.frameStores].find(([, store]) => store === target)?.[0] ?? this.page.mainFrame(),
        this.labelLists,
      );
      // Standard and ask modes dispatch a submit that is consequential only
      // because it submits under the submission guard (runAction). In ask mode
      // the engine requests approval only once the guard has stopped a real
      // submission, and an approved retry is sent with the body-bound permit.
      return proof.submission === 'plain' &&
        (this.policy.operationMode === 'standard' || this.policy.operationMode === 'ask') &&
        !this.policy.allowAllOperations
        ? { ...proof, risk: 'ordinary' as const }
        : proof;
    } catch (error) {
      if (error instanceof AdlError) throw error;
      throw new AdlError('E_STALE_STATE');
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  async handoff(paused: boolean, signal: AbortSignal, expiresAt?: number) {
    this.requireInteractivePage();
    this.checkAlive();
    if (this.policy.browserHeadless !== false) throw new AdlError('E_UNSUPPORTED_ACTION');
    if (signal.aborted) throw new AdlError('E_CANCELLED');
    this.containment = undefined;
    // A human working in the window may change what a held request was about: it fails closed.
    this.abortAllHolds('approval_invalidated');
    this.manualNetworkGeneration++;
    this.manualNetworkExpires = 0;
    try {
      if (paused) {
        if (!expiresAt || expiresAt <= Date.now() || expiresAt > Date.now() + 120000)
          throw new AdlError('E_POLICY_DENIED');
        this.manualNetworkExpires = expiresAt;
        this.manualNetworkOrigin = this.origin;
        await this.page.bringToFront();
      }
      if (signal.aborted) throw new AdlError('E_CANCELLED');
    } catch (error) {
      this.manualNetworkGeneration++;
      this.manualNetworkExpires = 0;
      throw error;
    }
  }

  async act(
    action: Action,
    signal: AbortSignal,
    onDispatch?: () => void,
    authorization?: ActionAuthorization,
  ): Promise<void | AdapterActResult> {
    if (action.action !== 'navigate' && action.action !== 'back') this.requireInteractivePage();
    this.checkAlive();
    if (signal.aborted) throw new AdlError('E_CANCELLED');
    this.containment = undefined;
    let dispatched = false,
      completed = false;
    const local = new AbortController();
    const combined = AbortSignal.any([signal, local.signal]);
    const startedAt = Date.now();
    const mark = () => {
      if (combined.aborted) throw new AdlError('E_CANCELLED');
      if (authorization?.approved && (!authorization.expires_at || authorization.expires_at <= Date.now()))
        throw new AdlError('E_POLICY_DENIED');
      onDispatch?.();
      // From here on what the page sends belongs to this action: its blocks go into the result, its writes may be held.
      if (!this.writeWindow) this.openWriteWindow(action, authorization);
      dispatched = true;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: () => void = () => {};
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(new AdlError('E_CANCELLED'));
      combined.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => {
        local.abort();
        reject(new AdlError('E_TIMEOUT'));
      }, this.policy.actionTimeoutMs);
    });
    // complete() marks a dispatched action whose outcome is known (the document
    // navigated, or a guarded submission was cancelled in place): such failures
    // are reported without may_have_executed and keep the session.
    const complete = () => {
      completed = true;
    };
    const noContent = this.noContentNavigations,
      noContentAfterStub = this.noContentAfterStub,
      generation = this.documentGeneration;
    try {
      const notices = await Promise.race([
        (async () => {
          const found = await this.runAction(action, combined, mark, authorization, complete);
          // The dispatch is back, so the page's thread was not stuck in a request it sent: holds are no longer suspected of being synchronous.
          const dispatchedWindow = this.writeWindow;
          if (dispatchedWindow) {
            dispatchedWindow.returned = true;
            clearTimeout(dispatchedWindow.syncTimer);
            dispatchedWindow.syncTimer = undefined;
          }
          await this.settleRedirect();
          const ww = this.writeWindow;
          // Let the page react (a message after a rejected request, a render after an answer) before the caller reads it.
          if (ww && dispatched && SETTLED_ACTIONS.has(action.action))
            await this.settle(
              ww,
              combined,
              startedAt + Math.min(action.timeout_ms ?? Infinity, this.policy.actionTimeoutMs) - 150,
            );
          const containment = this.containment;
          if (containment) {
            // A handler may start its request after the click returns. The network stays closed until the next action. The wait
            // is counted from the dispatch, so a settled action takes CONTAINMENT_REPORT_MS in total, not the sum.
            const remaining = CONTAINMENT_REPORT_MS - (Date.now() - (ww?.dispatchedAt ?? Date.now()));
            if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
          }
          // Writes the page sends from now on are background traffic, not this action's.
          if (ww) ww.open = false;
          // Writes of a document that is being replaced (the handler navigated away, or the settle found the document gone) die with
          // it: they are not handed to a human for a page that no longer exists.
          if (ww && this.windowDocumentReplaced(ww)) this.abortHolds(ww.holds, DOCUMENT_REPLACED);
          if (containment?.blockedReads) {
            if (ww) this.abortHolds(ww.holds, 'contained_request_blocked');
            complete();
            throw new AdlError('E_APPROVAL_REQUIRED', 'contained_request_blocked', { page_script_ran: true });
          }
          if (ww?.overflow) {
            complete();
            throw new AdlError('E_APPROVAL_REQUIRED', 'request_not_approvable', { page_script_ran: true });
          }
          const guard = this.submissionGuard;
          this.submissionGuard = undefined;
          if (guard?.blocked) {
            complete();
            throw new AdlError('E_APPROVAL_REQUIRED', 'form_submission_requires_approval');
          }
          let alive = ww?.holds.filter(paused => !paused.decided) ?? [];
          // A set is handed over whole: if any request of it already ended (the page gave up on it), the rest ends too.
          if (ww && alive.length !== ww.holds.length) {
            this.abortHolds(alive, 'request_denied');
            alive = [];
          }
          // A contained control that sent a write nobody could approve. A write that cannot be shown to a human cannot be sent in
          // any tier; one that ask mode would hold is what standard mode tells the caller to select ask for. (In ask mode a
          // write that could be asked about was held above, or reported by its warning.)
          if (containment?.blockedWrites && !alive.length) {
            if (containment.holdableWrites < containment.blockedWrites) {
              complete();
              throw new AdlError('E_APPROVAL_REQUIRED', 'request_not_approvable', { page_script_ran: true });
            }
            if (!ww?.hold) {
              complete();
              throw new AdlError('E_APPROVAL_REQUIRED', 'requires_ask_mode', { page_script_ran: true });
            }
          }
          if (ww && alive.length) {
            // The writes stay paused inside the browser; the engine asks a human about their exact content and releases or aborts them.
            const id = ww.id;
            const expiry = setTimeout(() => void this.abortHeldWrites(id, 'expired'), HELD_SET_LIFETIME_MS);
            expiry.unref();
            this.heldSet = { id, holds: alive, timer: expiry };
            complete();
            throw new HeldWritesError({
              id,
              requests: alive.map(paused => ({
                method: paused.method,
                url: paused.url,
                content_type: paused.contentType,
                body_sha256: paused.bodySha256,
                body_length: paused.body?.length ?? 0,
                details: paused.details,
                secret: paused.secret,
              })),
            });
          }
          if (this.noContentAfterStub > noContentAfterStub)
            return [
              ...(found ?? []),
              {
                code: 'no_content',
                count: 1,
                message:
                  'A redirect stored its cookies and then ended with no content (HTTP 204/205): the page before it is gone and an empty one stays. Navigate to continue.',
              },
            ];
          if (containment)
            return [
              ...(found ?? []),
              {
                code: 'contained_action',
                count: 1,
                message:
                  'This control is classified as consequential, so it ran with the network closed until the next action: only requests this page was already making go on, and anything new is left out. Nothing it asked for has left so far; a later attempt shows in the next observation.',
              },
            ];
          // Nothing on screen tells that the action's navigation was answered without content: say so.
          if (this.noContentNavigations > noContent && this.documentGeneration === generation)
            return [
              ...(found ?? []),
              {
                code: 'no_content',
                count: 1,
                message: 'The navigation was answered with no content (HTTP 204/205): the current page stays.',
              },
            ];
          return found;
        })(),
        stopped,
      ]);
      // The result carries exactly the blocks of this action's window (the engine falls back to a count difference only for adapters
      // that report none); anything blocked from here on belongs to the document and shows once in the next observation.
      return dispatched
        ? { ...(notices?.length ? { warnings: notices } : {}), blocks: this.collectWindowBlocks() }
        : notices?.length
          ? { warnings: notices }
          : undefined;
    } catch (error) {
      const safe =
        error instanceof AdlError
          ? error
          : new AdlError(
              error instanceof Error && error.message.includes('ADL_UNTRUSTED_DOM')
                ? 'E_PRIVACY_BLOCKED'
                : 'E_INTERNAL',
              error instanceof Error && error.message.includes('ADL_UNTRUSTED_DOM') ? 'untrusted_dom_api' : undefined,
            );
      safe.mayHaveExecuted = dispatched && !completed;
      if (dispatched && !completed) await this.close();
      throw safe;
    } finally {
      this.approvedRequest = undefined;
      this.submissionGuard = undefined;
      if (!dispatched) this.containment = undefined;
      // Requests this action held that were not handed over as a set (it timed out, was cancelled or failed otherwise) fail closed.
      const ww = this.writeWindow;
      if (ww) {
        ww.open = false;
        clearTimeout(ww.syncTimer);
        ww.syncTimer = undefined;
        if (this.heldSet?.id !== ww.id) this.abortHolds(ww.holds, 'request_denied');
        this.writeWindow = undefined;
        if (!ww.collected) this.adoptBlocks(ww.blocked);
      }
      if (timer) clearTimeout(timer);
      combined.removeEventListener('abort', onAbort);
    }
  }

  private async runAction(
    action: Action,
    signal: AbortSignal,
    onDispatch: () => void,
    authorization?: ActionAuthorization,
    complete: () => void = () => {},
  ): Promise<void | AdapterWarning[]> {
    // Leaving a document whose DOM APIs fail verification reads nothing from
    // it: navigate/back stay available on such a page, everything else fails.
    const navigationOnly = action.action === 'navigate' || action.action === 'back';
    const assertIntegrityOrLeaving = async () => {
      if (navigationOnly && this.isolatedReadOnly) return;
      try {
        await this.assertIntegrity(signal);
      } catch (error) {
        if (!(
          navigationOnly &&
          error instanceof AdlError &&
          (error.reason === 'untrusted_dom_api' || error.code === 'E_STALE_STATE')
        ))
          throw error;
      }
    };
    await assertIntegrityOrLeaving();
    if (new URL(this.page.url()).origin !== this.origin) {
      await this.close();
      throw new AdlError('E_POLICY_DENIED');
    }
    const assertEvidence = async () => {
      if (!authorization?.actionEvidence) return;
      if (signal.aborted) throw new AdlError('E_CANCELLED');
      const current = (await this.snapshot(signal)).actionEvidence,
        expected = authorization.actionEvidence;
      if (
        !current ||
        current.navigation !== expected.navigation ||
        (expected.element !== undefined &&
          (!action.element_id || current.elements[action.element_id] !== expected.element))
      )
        throw new AdlError('E_STALE_STATE');
    };
    if (action.action === 'back') {
      const protocol = await this.context.newCDPSession(this.page);
      try {
        const history = await protocol.send('Page.getNavigationHistory');
        const previous = history.entries[history.currentIndex - 1];
        if (!previous) throw new AdlError('E_TARGET_NOT_FOUND');
        if (!this.policy.allowAllOperations && !this.reachable(new URL(previous.url).origin))
          throw new AdlError('E_POLICY_DENIED', 'origin_not_allowed');
        await this.owner.callGuard(previous.url);
        await resolveAllowedAddresses(previous.url, this.policy);
        await assertEvidence();
        await assertIntegrityOrLeaving();
        onDispatch();
        try {
          await this.page.goBack({ waitUntil: 'domcontentloaded' });
        } catch (error) {
          this.checkAlive();
          const failure = this.takeNavigationFailure(previous.url);
          if (failure) throw new AdlError('E_POLICY_DENIED', failure);
          throw error;
        }
        await this.settleRedirect();
        complete();
        await this.freshStoreAssign(signal);
        return;
      } finally {
        await protocol.detach().catch(() => undefined);
      }
    }
    if (action.action === 'navigate') {
      let u: URL;
      try {
        u = new URL(String(action.url));
      } catch {
        deny();
      }
      if (!this.policy.allowAllOperations && !this.reachable(u.origin))
        throw new AdlError('E_POLICY_DENIED', 'origin_not_allowed');
      try {
        await this.owner.callGuard(u.href);
        await resolveAllowedAddresses(u.href, this.policy);
      } catch (e) {
        if (e instanceof AdlError && e.code === 'E_POLICY_DENIED') throw e;
        deny();
      }
      await assertEvidence();
      await assertIntegrityOrLeaving();
      const noContent = this.noContentNavigations,
        generation = this.documentGeneration;
      try {
        onDispatch();
        await this.page.goto(u.href, { waitUntil: 'domcontentloaded' });
      } catch {
        this.checkAlive();
        // A 204/205 answer aborts the navigation (goto reports net::ERR_ABORTED) and keeps the document, whose store and ids stay valid.
        if (this.noContentNavigations > noContent && this.documentGeneration === generation) {
          complete();
          return;
        }
        const proxyFailure = this.takeNavigationFailure(u.href);
        if (proxyFailure) throw new AdlError('E_POLICY_DENIED', proxyFailure);
        deny();
      }
      await this.settleRedirect();
      complete();
      await this.freshStoreAssign(signal);
      return;
    }
    if (action.action === 'read_state' || action.action === 'wait_for') throw new AdlError('E_UNSUPPORTED_ACTION');
    if (action.action === 'scroll' && action.element_id === undefined) {
      // Page scroll: the main frame's scrolling element moves by the same amount an element scroll uses. No element data is read.
      if (action.direction !== 'up' && action.direction !== 'down')
        throw new AdlError('E_INVALID_ARGUMENT', 'invalid_argument', { argument: 'direction' });
      await assertEvidence();
      await this.assertIntegrity(signal);
      const scroller = await this.page.mainFrame().evaluateHandle(key => {
        if (!(window as unknown as Record<string, BrowserIntegrity>)[key]?.check())
          throw new Error('ADL_UNTRUSTED_DOM');
        const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o);
        const scrolling = r(document, 'scrollingElement') as Element | null;
        return scrolling &&
          r(scrolling, 'clientHeight') > 0 &&
          r(scrolling, 'scrollHeight') > r(scrolling, 'clientHeight')
          ? scrolling
          : null;
      }, this.integrityKey);
      try {
        const element = scroller.asElement();
        if (!element) throw new AdlError('E_UNSUPPORTED_ACTION', 'not_scrollable');
        onDispatch();
        const moved = await element.evaluate(scrollByViewport, { direction: action.direction, key: this.integrityKey });
        return moved ? undefined : [scrollEdgeNotice(action.direction, 'page')];
      } finally {
        await scroller.dispose();
      }
    }
    const id = action.element_id;
    if (!id || !(id.startsWith(this.prefix + '-') || id.startsWith(this.prefix + '_f')))
      throw new AdlError('E_TARGET_NOT_FOUND');
    let targetStore = this.store!;
    let targetFrame: Frame | undefined;
    if (!id.startsWith(this.prefix + '-')) {
      const found = [...this.frameStores.values()];
      let match: JSHandle<Store> | undefined;
      for (const store of found)
        if (await store.evaluate((value, key) => value.nodes.has(key), id)) {
          match = store;
          break;
        }
      if (!match) throw new AdlError('E_TARGET_NOT_FOUND');
      targetStore = match;
      targetFrame = [...this.frameStores].find(([, store]) => store === match)?.[0];
    }
    const handle = await targetStore.evaluateHandle((store: Store, id: string) => {
      if (!store.integrity.check()) throw new Error('ADL_UNTRUSTED_DOM');
      const n = store.nodes.get(id);
      if (!n || !(n as Node).isConnected) return null;
      return n as Element;
    }, id);
    const el = handle.asElement();
    if (!el) {
      await handle.dispose().catch(() => undefined);
      throw new AdlError('E_TARGET_NOT_FOUND');
    }
    try {
      const permitted = this.policy.allowAllOperations === true || authorization?.normalOperations === true;
      const proofFrame = targetFrame ?? this.page.mainFrame();
      // Cross-origin descendant frames are proven only for explicitly configured origins (compatibility permission).
      const frameOrigins =
        this.policy.allowAllOperations === true || this.policy.operationMode === undefined
          ? this.policy.allowedOrigins
          : [];
      // All modes must protect the iframe host and target through the isolated
      // world; page-world preflight getters are not privacy evidence.
      const assertFramePublic = async () => {
        if (!targetFrame || authorization?.normalOperations) return;
        // The compatibility permission is limited to configured origins and
        // requires every ancestor frame to pass the network policy guard.
        const crossAllowed = this.policy.allowAllOperations === true || this.policy.operationMode === undefined;
        const allowedFrameOrigins = crossAllowed ? this.policy.allowedOrigins : [];
        const priorFrames: { frame: Frame; url: string }[] = [];
        for (let frame: Frame | null = targetFrame; frame?.parentFrame(); frame = frame.parentFrame()) {
          let effective = frame;
          while (effective.url().startsWith('about:') && effective.parentFrame()) effective = effective.parentFrame()!;
          const url = effective.url();
          if (new URL(url).origin !== this.origin && !allowedFrameOrigins.includes(new URL(url).origin))
            throw new AdlError('E_POLICY_DENIED', 'iframe_action_proof_unavailable');
          await this.owner.callGuard(url);
          priorFrames.push({ frame, url: frame.url() });
        }
        const publicTarget = await isolatedCollect(
          el,
          (node, rules: typeof BROWSER_PRIVACY_RULES) => {
            const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
              m = (o: object, k: string, ...a: unknown[]): any => Reflect.apply(r(o, k), o, a);
            let current: Element | null = node,
              depth = 0;
            while (current && depth++ < rules.ancestorCap) {
              if (m(current, 'matches', rules.regionSelector)) return { allowed: false };
              current =
                (r(current, 'parentElement') as Element | null) ??
                (m(current, 'getRootNode') as ShadowRoot).host ??
                null;
            }
            return { allowed: current === null && r(node, 'isConnected') === true };
          },
          BROWSER_PRIVACY_RULES,
          allowedFrameOrigins,
          targetFrame,
        );
        if (priorFrames.some(item => item.frame.isDetached() || item.frame.url() !== item.url))
          throw new AdlError('E_STALE_STATE');
        if (!publicTarget.allowed) throw new AdlError('E_PRIVACY_BLOCKED');
      };
      await assertFramePublic();
      if (authorization?.normalOperations) {
        const fresh = await inspectBrowserAction(el, action, proofFrame, this.labelLists);
        if (!authorization.approvalProof || fresh.proof !== authorization.approvalProof)
          throw new AdlError('E_STALE_STATE');
      }
      const info = await el.evaluate(
        (
          node,
          {
            secretLabelPattern,
            legacyPattern,
            privacyRules,
            integrityKey,
          }: {
            secretLabelPattern: string;
            legacyPattern: string;
            privacyRules: typeof BROWSER_PRIVACY_RULES;
            integrityKey: string;
          },
        ) => {
          if (!(window as unknown as Record<string, BrowserIntegrity>)[integrityKey]?.check())
            throw new Error('ADL_UNTRUSTED_DOM');
          const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
            m = (o: object, k: string, ...a: unknown[]): any => Reflect.apply(r(o, k), o, a);
          const attr = (x: Element, k: string) => m(x, 'getAttribute', k) as string | null;
          const e = node as HTMLElement;
          const tag = String(r(e, 'tagName')).toLowerCase();
          const type = tag === 'input' ? ((e as HTMLInputElement).type || 'text').toLowerCase() : '';
          const words = (text: string) =>
            text
              .normalize('NFKC')
              .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
              .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
              .replace(/([A-Za-z])([0-9])/g, '$1 $2')
              .replace(/([0-9])([A-Za-z])/g, '$1 $2');
          const sensitiveLabel = (text: string) =>
            text.length >= 512 || new RegExp(secretLabelPattern, 'iu').test(words(text));
          // Legacy allowlist classifier: whole keywords only ("Payload viewer" and
          // "Remove filter" are ordinary), matched on identifier words as well.
          const CONSEQUENTIAL_RE = new RegExp(legacyPattern, 'i');
          const keyword = (text: string) => CONSEQUENTIAL_RE.test(words(text).replace(/[_-]+/g, ' '));
          const form = m(e, 'closest', 'form') as HTMLFormElement | null;
          const name = attr(e, 'aria-label') || attr(e, 'id') || '';
          const nameAttr = attr(e, 'name') || '';
          const inSensitiveRegion = (element: Element): boolean => {
            let node: Element | null = element,
              depth = 0;
            while (node && depth++ < privacyRules.ancestorCap) {
              if (m(node, 'matches', privacyRules.regionSelector)) return true;
              node =
                (r(node, 'parentElement') as Element | null) ?? (m(node, 'getRootNode') as ShadowRoot).host ?? null;
            }
            return node !== null;
          };
          const textOf = (element: Element): string => {
            if (inSensitiveRegion(element)) return 'x'.repeat(512);
            let scanned = 0,
              exhausted = false;
            const walker = m(document, 'createTreeWalker', element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
              acceptNode: (node: Node) => {
                if (++scanned > 128) {
                  exhausted = true;
                  return NodeFilter.FILTER_ACCEPT;
                }
                return r(node, 'nodeType') === 1 &&
                  m(node, 'matches', privacyRules.textSkipSelector + ',' + privacyRules.regionSelector)
                  ? NodeFilter.FILTER_REJECT
                  : NodeFilter.FILTER_ACCEPT;
              },
            }) as TreeWalker;
            let node = walker.nextNode(),
              text = '',
              visits = 0;
            while (node && !exhausted && visits++ < 128 && text.length < 512) {
              const parent = node.parentElement;
              if (r(node, 'nodeType') === 3 && !(parent && m(parent, 'closest', 'script,style')))
                text += (node.textContent ?? '').slice(0, 512 - text.length);
              node = walker.nextNode();
            }
            return node ? 'x'.repeat(512) : text.trim();
          };
          const hints = [
            name,
            attr(e, 'id') || '',
            nameAttr,
            attr(e, 'placeholder') || '',
            attr(e, 'title') || '',
            attr(e, 'autocomplete') || '',
          ];
          const label = (r(e, 'labels') as NodeList | undefined)?.[0] as Element | undefined;
          if (label) hints.push(textOf(label));
          const refs = attr(e, 'aria-labelledby') || '';
          if (refs.length > 4096 || refs.trim().split(/\s+/).length > 16) hints.push('x'.repeat(512));
          else
            for (const id of refs.trim().split(/\s+/).filter(Boolean).slice(0, 16)) {
              const reference = m(m(e, 'getRootNode'), 'getElementById', id) as Element | null;
              if (reference) hints.push(textOf(reference));
            }
          return {
            tag,
            type,
            protected: inSensitiveRegion(e),
            sensitive: (tag === 'input' && type === 'password') || inSensitiveRegion(e) || hints.some(sensitiveLabel),
            consequential:
              keyword(name) ||
              keyword(nameAttr) ||
              (tag === 'button' && (attr(e, 'type') || 'submit') === 'submit' && !!form) ||
              (tag === 'input' && type === 'submit'),
          };
        },
        {
          secretLabelPattern: SECRET_LABEL_PATTERN,
          legacyPattern: LEGACY_CONTROLS_PATTERN,
          privacyRules: BROWSER_PRIVACY_RULES,
          integrityKey: this.integrityKey,
        },
      );
      const authorized =
        permitted || action.action === 'scroll'
          ? await el.evaluate((node, key) => {
              if (!(window as unknown as Record<string, BrowserIntegrity>)[key]?.check())
                throw new Error('ADL_UNTRUSTED_DOM');
              // Derive an exact selector from the retained element without modifying the page.
              const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
                m = (o: object, k: string, ...a: unknown[]): any => Reflect.apply(r(o, k), o, a);
              const parts: string[] = [];
              let current: Element | null = node;
              while (current) {
                const parent: Element | null = r(current, 'parentElement');
                const root = m(current, 'getRootNode');
                const siblings = parent
                  ? (r(parent, 'children') as HTMLCollection)
                  : root instanceof ShadowRoot
                    ? root.children
                    : undefined;
                const index = siblings ? Array.from(siblings).indexOf(current) + 1 : 1;
                parts.unshift(`${String(r(current, 'tagName')).toLowerCase()}:nth-child(${index})`);
                current = parent;
              }
              return parts.join(' > ');
            }, this.integrityKey)
          : await el.evaluate(
              (
                node,
                arg: { rules: { selector: string; actions: string[] }[]; action: string; integrityKey: string },
              ) => {
                if (!(window as unknown as Record<string, BrowserIntegrity>)[arg.integrityKey]?.check())
                  throw new Error('ADL_UNTRUSTED_DOM');
                const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
                  m = (o: object, k: string, ...a: unknown[]): any => Reflect.apply(r(o, k), o, a);
                const e = node as HTMLElement;
                // Rule order must not decide the outcome: a rule authorizes only when
                // its selector resolves to exactly this element and lists the requested
                // action. Ambiguous or unrelated rules are skipped, never fatal, and
                // duplicates never authorize.
                for (const rule of arg.rules) {
                  const sel = rule.selector;
                  try {
                    if (!m(e, 'matches', sel) || !rule.actions.includes(arg.action)) continue;
                    const walker = m(
                      document,
                      'createTreeWalker',
                      m(e, 'getRootNode'),
                      NodeFilter.SHOW_ELEMENT,
                    ) as TreeWalker;
                    let n: Node | null = walker.nextNode();
                    let visits = 0;
                    let found = 0;
                    while (n && visits++ < 5000) {
                      if (m(n, 'matches', sel) && ++found > 1) break;
                      n = walker.nextNode();
                    }
                    // Uniqueness is proven only by exhausting the tree: a visit-cap exit
                    // leaves n non-null, so unseen duplicates can never authorize.
                    if (found === 1 && !n && m(m(e, 'getRootNode'), 'querySelector', sel) === e) return sel;
                  } catch {
                    /* invalid selector: never authorizes */
                  }
                }
                return '';
              },
              { rules: this.grantedControls, action: action.action, integrityKey: this.integrityKey },
            );
      if (!authorized) throw new AdlError('E_APPROVAL_REQUIRED', 'operation_not_granted');
      // The page side already required the rule to allow this action; select the
      // matching rule (not merely the first rule with that selector) so duplicate
      // selectors with different action lists resolve per action.
      const rule = this.grantedControls.find(c => c.selector === authorized && c.actions.includes(action.action));
      if (!permitted && action.action !== 'scroll' && !rule)
        throw new AdlError('E_APPROVAL_REQUIRED', 'operation_not_granted');
      if (info.protected) throw new AdlError('E_PRIVACY_BLOCKED');
      if (info.type === 'file') throw new AdlError('E_PRIVACY_BLOCKED');
      if (!permitted && info.sensitive) throw new AdlError('E_PRIVACY_BLOCKED');
      if (!permitted && action.action !== 'scroll' && info.consequential)
        throw new AdlError('E_APPROVAL_REQUIRED', 'consequential_operation');
      // Form named properties shadow the DOM APIs Playwright's injected actionability code reads on ancestors. Decided here, before anything is
      // dispatched: then input goes through the CDP equivalent in browser-native-input.ts; otherwise Playwright dispatches as before.
      const clobbered =
        ['click', 'fill', 'press', 'hover', 'check', 'select'].includes(action.action) &&
        !(action.action === 'click' && action.point) &&
        (await shadowsDomApi(el, this.integrityKey));
      // The click point the preflight verified; a pointer click below is dispatched at exactly this point.
      let verified: PreflightResult | undefined;
      if (['click', 'fill', 'press', 'hover'].includes(action.action)) {
        const generation = this.documentGeneration;
        const assertCurrent = () => {
          this.checkAlive();
          if (generation !== this.documentGeneration) throw new AdlError('E_STALE_STATE');
          if (new URL(this.page.url()).origin !== this.origin) throw new AdlError('E_POLICY_DENIED');
        };
        verified = await preflightBrowserInput(
          this.page,
          el,
          action,
          authorized,
          signal,
          assertCurrent,
          permitted,
          action.action === 'hover' ? onDispatch : undefined,
          this.integrityKey,
          clobbered,
        );
        assertCurrent();
        if (signal.aborted) throw new AdlError('E_CANCELLED');
      }
      await assertFramePublic();
      if (authorization?.normalOperations) {
        // A pointer click goes to the point the preflight verified: the CDP identity proof is made at that same viewport point.
        let clickAt: { x: number; y: number } | undefined;
        if (action.action === 'click' && !action.point && verified) {
          const box = await el.boundingBox();
          clickAt = box ? offsetPointOf(box, verified.click.offset, this.page.viewportSize()) : undefined;
          if (!clickAt) throw new AdlError('E_STALE_STATE', 'not_visible');
        }
        const fresh = await inspectBrowserAction(el, action, proofFrame, this.labelLists, clickAt);
        if (fresh.proof !== authorization.approvalProof) throw new AdlError('E_STALE_STATE');
        if (authorization.approved && fresh.network)
          this.approvedRequest = {
            ...fresh.network,
            frame: targetFrame ?? this.page.mainFrame(),
            expires: Math.min(Date.now() + 5000, authorization.expires_at ?? 0),
          };
        if (fresh.submission === 'plain' && !authorization.approved) {
          if (
            (this.policy.operationMode !== 'standard' && this.policy.operationMode !== 'ask') ||
            this.policy.allowAllOperations
          )
            throw new AdlError('E_APPROVAL_REQUIRED', 'requires_ask_mode');
          await this.armSubmissionGuard();
        }
        if (fresh.contained && !authorization.approved) {
          // Standard mode has nobody to ask; ask mode contains it too when the engine lets the writes it sends be held for approval.
          if (
            this.policy.allowAllOperations ||
            !(
              this.policy.operationMode === 'standard' ||
              (this.policy.operationMode === 'ask' && authorization.holdWrites === true)
            )
          )
            throw new AdlError('E_APPROVAL_REQUIRED', 'requires_ask_mode');
          this.containment = { blockedReads: 0, blockedWrites: 0, holdableWrites: 0 };
        }
      }
      if (targetFrame) {
        await this.owner.callGuard(
          targetFrame.url().startsWith('about:') ? (targetFrame.parentFrame()?.url() ?? '') : targetFrame.url(),
        );
        for (let frame: Frame | null = targetFrame; frame?.parentFrame(); frame = frame.parentFrame()) {
          const host = await frame.frameElement();
          try {
            if (
              await host.evaluate((element, rules) => {
                const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
                  m = (o: object, k: string, ...a: unknown[]): any => Reflect.apply(r(o, k), o, a);
                let node: Element | null = element as Element,
                  depth = 0;
                while (node && depth++ < rules.ancestorCap) {
                  if (m(node, 'matches', rules.regionSelector)) return true;
                  node =
                    (r(node, 'parentElement') as Element | null) ?? (m(node, 'getRootNode') as ShadowRoot).host ?? null;
                }
                return node !== null;
              }, BROWSER_PRIVACY_RULES)
            )
              throw new AdlError('E_PRIVACY_BLOCKED');
          } finally {
            await host.dispose();
          }
        }
      }
      const opts = { timeout: Math.max(1000, this.policy.actionTimeoutMs - 500) };
      if (action.action === 'hover') return;
      await assertEvidence();
      await this.assertIntegrity(signal);
      const nativeInput = (): NativeInput => ({
        page: this.page,
        el,
        frame: proofFrame,
        integrityKey: this.integrityKey,
        allowedFrameOrigins: frameOrigins,
        opts,
        signal,
        assertIntegrity: () => this.assertIntegrity(signal),
        onDispatch,
        onUndone: complete,
      });
      if (action.action === 'press') {
        if (
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
          throw new AdlError('E_INVALID_ARGUMENT');
        onDispatch();
        await el.press(action.value!, opts);
      } else if (action.action === 'fill') {
        if (typeof action.value !== 'string') throw new AdlError('E_INVALID_ARGUMENT');
        const text = action.value.slice(0, 4096);
        if (!(clobbered && (await nativeFill(nativeInput(), text)))) {
          onDispatch();
          await el.fill(text, opts);
        }
      } else if (action.action === 'click') {
        if (action.point) {
          if (!authorization?.pointReference) throw new AdlError('E_STALE_STATE');
          await this.page.mouse.move(action.point.x, action.point.y);
          const hit = await (
            await this.pointTarget(action.point, authorization.pointReference, signal)
          ).elementHandle({ timeout: 1000 });
          try {
            if (!hit || !(await el.evaluate((e, actual) => e === actual, hit))) throw new AdlError('E_STALE_STATE');
          } finally {
            await hit?.dispose();
          }
          if (
            authorization.normalOperations &&
            (await inspectBrowserAction(el, action, proofFrame, this.labelLists)).proof !== authorization.approvalProof
          )
            throw new AdlError('E_STALE_STATE');
          await this.assertIntegrity(signal);
          onDispatch();
          await this.page.mouse.click(action.point.x, action.point.y);
        } else {
          // Dispatch at the verified fragment point, not at Playwright's own choice (the first fragment): that point may be covered
          // while another fragment is not, and the point the preflight proved unobstructed is the only one that may receive the click.
          if (!verified) throw new AdlError('E_INTERNAL');
          if (clobbered) await nativeClick(nativeInput(), verified.click.offset);
          else {
            onDispatch();
            await el.click({ ...opts, position: verified.click.position });
          }
        }
      } else if (action.action === 'check') {
        const wanted = !!action.checked;
        // Native, integrity-checked checkbox state (INPUT only; anything else reads false and can never confirm a toggle below).
        const checkedState = () =>
          el.evaluate((node, key) => {
            const guard = (window as unknown as Record<string, BrowserIntegrity>)[key];
            if (!guard?.check()) throw new Error('ADL_UNTRUSTED_DOM');
            return guard.checked(node as Element);
          }, this.integrityKey);
        const was = await checkedState();
        onDispatch();
        try {
          if (clobbered) await nativeSetChecked(nativeInput(), wanted, checkedState);
          else await el.setChecked(wanted, opts);
        } catch (error) {
          // setChecked clicks and then re-reads the state, so an app that re-renders the node on click fails only on the re-read. If the page is intact and the detached node itself holds the requested state, the click demonstrably landed: report success and keep the session. A node that vanished before the click still holds the old state and keeps the safe failure path.
          if (was === wanted || !detachedElementError(error)) throw error;
          this.checkAlive();
          if (signal.aborted) throw new AdlError('E_CANCELLED');
          if (new URL(this.page.url()).origin !== this.origin) throw error;
          await this.assertIntegrity(signal);
          if ((await checkedState().catch(() => undefined)) !== wanted) throw error;
          return [
            {
              code: 'target_replaced',
              count: 1,
              message:
                'The target was re-rendered right after the action took effect. Observe again; element ids may have changed.',
            },
          ];
        }
      } else if (action.action === 'select') {
        if (clobbered) await nativeSelect(nativeInput(), String(action.value ?? ''));
        else {
          onDispatch();
          await el.selectOption(String(action.value ?? ''), opts);
        }
      } else if (action.action === 'scroll') {
        if (action.direction) {
          const scrollTarget = await el.evaluateHandle((node, key) => {
            if (!(window as unknown as Record<string, BrowserIntegrity>)[key]?.check())
              throw new Error('ADL_UNTRUSTED_DOM');
            const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
              m = (o: object, k: string, ...a: unknown[]): any => Reflect.apply(r(o, k), o, a);
            let current: Element | null = node;
            while (current) {
              const element = current as HTMLElement,
                style = getComputedStyle(element);
              if (
                r(element, 'clientHeight') > 0 &&
                r(element, 'scrollHeight') > r(element, 'clientHeight') &&
                /(auto|scroll|overlay)/.test(style.overflowY)
              )
                return element;
              current =
                (r(current, 'parentElement') as Element | null) ??
                (m(current, 'getRootNode') as ShadowRoot).host ??
                null;
            }
            const doc = r(node, 'ownerDocument') as Document,
              scrolling = r(doc, 'scrollingElement') as Element | null;
            return scrolling && r(scrolling, 'scrollHeight') > r(scrolling, 'clientHeight') ? scrolling : null;
          }, this.integrityKey);
          try {
            const element = scrollTarget.asElement();
            if (!element) throw new AdlError('E_UNSUPPORTED_ACTION', 'not_scrollable');
            onDispatch();
            const moved = await element.evaluate(scrollByViewport, {
              direction: action.direction,
              key: this.integrityKey,
            });
            if (!moved) return [scrollEdgeNotice(action.direction, 'region')];
          } finally {
            await scrollTarget.dispose();
          }
        } else {
          onDispatch();
          await el.scrollIntoViewIfNeeded(opts);
        }
      } else {
        throw new AdlError('E_UNSUPPORTED_ACTION');
      }
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  markClosed(): void {
    this.closed = true;
    this.abortAllHolds('approval_invalidated');
    this.controller.abort();
    this.transportPool.destroy();
    this.resourceCache.clear();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    // Requests the route still holds must not stay pending, or leave if the context is torn down in between.
    this.abortAllHolds('approval_invalidated');
    this.openAbortCleanup?.();
    this.openAbortCleanup = undefined;
    this.controller.abort();
    this.transportPool.destroy();
    this.resourceCache.clear();
    const store = this.store;
    this.store = null;
    this.closing = (async () => {
      this.manualNetworkGeneration++;
      this.manualNetworkExpires = 0;
      await this.navigationProtocol?.then(cdp => cdp.detach()).catch(() => undefined);
      await this.documentIdentity?.dispose();
      await this.isolatedReader?.dispose();
      this.isolatedReader = null;
      await this.context.close();
      await store?.dispose().catch(() => {});
      for (const child of this.frameStores.values()) await child.dispose().catch(() => {});
      this.frameStores.clear();
      this.captureGeometry.clear();
      this.owner.forget(this);
    })();
    return this.closing;
  }
}

/** Maps a failed Chromium launch to an ErrorReason and one bounded stderr line; stdout is the MCP protocol and stays untouched. */
export function browserLaunchFailure(error: unknown): {
  reason?: 'browser_sandbox_unavailable' | 'browser_executable_missing';
  log: string;
} {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const head = message
    .split('\n')
    .slice(0, 8)
    .map(line => line.trim())
    .filter(Boolean)
    .join(' | ')
    .slice(0, 1024);
  const sandbox =
    message.includes('No usable sandbox') ||
    message.includes('Running as root without --no-sandbox') ||
    message.includes('namespace') ||
    message.includes('setuid sandbox');
  return sandbox
    ? {
        reason: 'browser_sandbox_unavailable',
        log: `adl: Chromium launch failed: ${head} | The Chromium sandbox could not start: run the MCP server as a non-root user, or on Ubuntu 24.04 allow unprivileged user namespaces for the AppArmor profile (sysctl kernel.apparmor_restrict_unprivileged_userns=0).`,
      }
    : {
        ...(/executable does not exist|failed to launch[^\n]*\bENOENT\b/i.test(message)
          ? { reason: 'browser_executable_missing' as const }
          : {}),
        log: `adl: Chromium launch failed: ${head}`,
      };
}

export class BrowserAdapter implements Adapter {
  private readonly startup = new StartupDiagnostics();
  startupDiagnostics() {
    return this.startup.snapshot();
  }
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private closed = false;
  private readonly sessions = new Set<BrowserSession>();

  constructor(
    private readonly policy: PolicyConfig,
    private readonly guard: (url: string, purpose?: 'navigation' | 'resource') => Promise<void>,
  ) {}

  /** Whether a redirect may take a document to another origin: one the workspace granted, and the guard accepts. */
  private async redirectMayLeave(next: URL): Promise<boolean> {
    if (
      !this.policy.allowAllBrowserOrigins &&
      !this.policy.allowAllOperations &&
      (!this.policy.allowedOrigins.includes(next.origin) || this.policy.hiddenTargetOrigins?.includes(next.origin))
    )
      return false;
    return this.callGuard(next.href).then(
      () => true,
      () => false,
    );
  }

  async callGuard(url: string, purpose: 'navigation' | 'resource' = 'navigation'): Promise<void> {
    try {
      await this.guard(url, purpose);
    } catch (e) {
      if (e instanceof AdlError) throw e;
      deny();
    }
  }

  forget(session: BrowserSession): void {
    this.sessions.delete(session);
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.closed) throw new AdlError('E_CANCELLED');
    if (this.browser) return this.browser;
    if (!this.launching) {
      this.launching = chromium
        .launch({
          headless: this.policy.browserHeadless !== false,
          chromiumSandbox: true,
          ...(process.env.ADL_BROWSER_EXECUTABLE ? { executablePath: process.env.ADL_BROWSER_EXECUTABLE } : {}),
        })
        .then(async b => {
          if (this.closed) {
            await b.close();
            throw new AdlError('E_CANCELLED');
          }
          b.on('disconnected', () => {
            this.browser = null;
            this.launching = null;
            for (const s of Array.from(this.sessions)) s.markClosed();
            this.sessions.clear();
          });
          this.browser = b;
          return b;
        })
        .catch((e: unknown) => {
          this.launching = null;
          if (e instanceof AdlError) throw e;
          const failure = browserLaunchFailure(e);
          process.stderr.write(failure.log + '\n');
          throw new AdlError('E_BACKEND_UNAVAILABLE', failure.reason);
        });
    }
    return this.launching;
  }

  async open(target: Target, mode: Mode, signal: AbortSignal, supplied?: BrowserTargetConfig): Promise<AdapterSession> {
    if (this.closed) throw new AdlError('E_CANCELLED');
    if (mode !== 'strict_isolated') throw new AdlError('E_INTERFERENCE_RISK');
    if (signal.aborted) throw new AdlError('E_CANCELLED');
    const config =
      this.policy.browserTargets.find(t => t.id === target.application_id) ??
      (supplied?.id === target.application_id ? supplied : undefined);
    if (!config) throw new AdlError('E_TARGET_NOT_FOUND');
    if (config.classification !== 'PUBLIC' && config.classification !== 'INTERNAL') deny();
    if (target.policy_class !== 'PUBLIC' && target.policy_class !== 'INTERNAL') deny();
    let origin: string;
    try {
      origin = new URL(config.url).origin;
    } catch {
      deny();
    }
    if (
      !this.policy.allowAllBrowserOrigins &&
      (!this.policy.allowAllOperations || this.policy.restrictTargets) &&
      !this.policy.allowedOrigins.includes(origin)
    )
      deny();
    if (this.sessions.size >= this.policy.maxSessions) throw new AdlError('E_RESOURCE_LIMIT');
    // Vet the configured origin (guard + DNS + IP ranges) before launch.
    await this.callGuard(origin + '/');
    await resolveAllowedAddresses(config.url, this.policy);
    let context: BrowserContext;
    let page: Page;
    let session: BrowserSession | null = null;
    const startup = this.startup.start();
    try {
      await ensureBrowserPrivacySelectors();
      // Register before the first page can initialize Playwright's injected
      // selector engine (e.g. during fill). Late registration misses that cache.
      await ensurePointSelector();
      startup.stage('browser_launch');
      const browser = await this.ensureBrowser();
      if (signal.aborted || this.closed) throw new AdlError('E_CANCELLED');
      startup.stage('context_creation');
      context = await browser.newContext({
        serviceWorkers: 'block',
        acceptDownloads: this.policy.allowAllOperations === true,
        hasTouch: config.gestures?.enabled === true,
      });
      const installation = await installBrowserIntegrity(context);
      session = new BrowserSession(
        this,
        this.policy,
        context,
        origin,
        config.controls ?? [],
        config.visual,
        config.gestures,
        installation.key,
        installation.registrationSecret,
      );
      this.sessions.add(session);
      const active = session;
      const onAbort = () => void active.close();
      signal.addEventListener('abort', onAbort, { once: true });
      active.openAbortCleanup = () => signal.removeEventListener('abort', onAbort);
      // Hard network boundary, installed before the first page exists.
      if (routesNetwork(this.policy)) {
        await context.route('**/*', async (route: Route) => {
          const block = async (code: string, origin?: string, window?: HoldWindow) => {
            let kind = 'other',
              verb = 'GET';
            try {
              const blocked = route.request();
              kind = networkResourceType(blocked);
              verb = networkMethod(blocked.method());
            } catch {}
            active.recordNetworkBlock(code, origin, kind, verb, window);
            await route.abort().catch(() => undefined);
          };
          // The write a human released: however this handler ends, the request is done with the route (heldWriteOutcome).
          let releasedWrite: PausedWrite | undefined;
          try {
            const req = route.request();
            if (active.controller.signal.aborted || req.frame().page() !== page) return route.abort();
            const rawUrl = req.url();
            let u: URL;
            try {
              u = new URL(rawUrl);
            } catch {
              return block('request_denied');
            }
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return block('request_denied');
            const mainNavigation = req.isNavigationRequest() && req.frame() === page.mainFrame();
            const held = mainNavigation ? active.takeRedirectedDocument(u.href, req.method().toUpperCase()) : undefined;
            // net::ERR_ABORTED cancels the navigation without an error page, so the
            // current document (and the session) survive the blocked submission.
            if (active.guardedSubmission(req)) {
              active.recordNetworkBlock(
                'form_submission_requires_approval',
                undefined,
                'document',
                networkMethod(req.method()),
              );
              return route.abort('aborted').catch(() => undefined);
            }
            if (active.containedRequest(req)) {
              active.recordNetworkBlock(
                'contained_request_blocked',
                undefined,
                networkResourceType(req),
                networkMethod(req.method()),
              );
              return route.abort('aborted').catch(() => undefined);
            }
            const method = req.method().toUpperCase();
            const resource = !req.isNavigationRequest() && req.resourceType() !== 'document';
            if (!this.policy.allowAllBrowserOrigins && !this.policy.allowAllOperations && u.origin !== active.origin) {
              const permitted =
                (mainNavigation && active.reachable(u.origin)) ||
                (resource &&
                  ['GET', 'HEAD'].includes(method) &&
                  [...this.policy.allowedOrigins, ...(this.policy.resourceOrigins ?? [])].includes(u.origin)) ||
                // A write to a granted origin is decided below: held for approval while an action runs, blocked otherwise.
                (resource &&
                  HELD_METHODS.has(method) &&
                  this.policy.allowedOrigins.includes(u.origin) &&
                  active.canHoldNow());
              if (!permitted) return block('origin_not_allowed', u.origin);
            }
            const body = req.postDataBuffer() ?? undefined;
            let manualGeneration: number | undefined, approvedExpires: number | undefined;
            if (!this.policy.allowAllOperations && method !== 'GET' && method !== 'HEAD') {
              const permit = active.approvedRequest;
              manualGeneration = active.manualRequestGeneration(req);
              if (manualGeneration === undefined) {
                if (
                  !permit ||
                  permit.expires < Date.now() ||
                  permit.frame !== req.frame() ||
                  !req.isNavigationRequest() ||
                  req.resourceType() !== 'document' ||
                  permit.method !== method ||
                  permit.url !== rawUrl ||
                  !body ||
                  !body.equals(Buffer.from(permit.body)) ||
                  (req.headers()['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() !==
                    'application/x-www-form-urlencoded'
                ) {
                  // Not the one-shot form permit: a page write is paused here for a human's decision (ask mode, during an action),
                  // or blocked with the code that says why. A released one continues below like the permitted form POST:
                  // guard, DNS pinning and the expiry re-check apply to its exact bytes.
                  const verdict = await active.holdWrite(req, u, body);
                  if ('block' in verdict)
                    return verdict.block === DOCUMENT_REPLACED
                      ? route.abort('aborted').catch(() => undefined)
                      : block(verdict.block, undefined, verdict.window);
                  approvedExpires = verdict.expires ?? 0; // no expiry on a release fails closed at dispatch
                  releasedWrite = verdict.paused;
                } else {
                  approvedExpires = permit.expires;
                  active.approvedRequest = undefined;
                }
              }
            }
            if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method))
              return block('request_denied');
            if (body && body.length > MAX_BODY) return block('request_denied');
            const headers = await req.allHeaders().catch(() => ({}) as Record<string, string>);
            // Playwright does not route requests followed internally from a
            // fulfilled redirect. Follow read-only redirects here so each hop is
            // vetted and DNS-pinned, instead of letting Chromium bypass the route.
            let current = u;
            let res: FetchResult;
            let hopMethod = method;
            let hopBody = body;
            let hopBase = headers;
            let hopHeaders = headers;
            // Cookies of the hops followed here: only a response to Chromium stores them, under Chromium's own rules.
            const hopCookies: string[] = [];
            let stubRedirect: URL | undefined;
            for (let hops = 0; ; hops++) {
              if (held && hops === 0) res = held;
              else {
                await this.callGuard(current.href, resource ? 'resource' : 'navigation');
                const ips = await resolveAllowedAddresses(
                  current.href,
                  this.policy,
                  undefined,
                  resource ? 'resource' : 'navigation',
                );
                // A grant checked before headers, guard or DNS may be revoked while
                // those awaits run. Recheck the exact generation at network dispatch.
                if (
                  active.controller.signal.aborted ||
                  (manualGeneration !== undefined && !active.manualRequestCurrent(req, manualGeneration)) ||
                  (approvedExpires !== undefined && approvedExpires <= Date.now())
                )
                  return block('request_denied');
                // From here the released write is on its way to the network (the guard, DNS and the expiry re-check passed).
                if (releasedWrite && hops === 0) active.noteHeldDispatch(releasedWrite);
                const cacheKey = active.resourceCache.key(current, ips[0]!, hopMethod, req.resourceType(), hopHeaders);
                const cached = active.resourceCache.get(cacheKey);
                res =
                  cached ??
                  (await pinnedFetch(
                    current,
                    ips[0]!,
                    hopMethod,
                    hopHeaders,
                    active.controller.signal,
                    hopBody,
                    this.policy.browserProxyServer,
                    {
                      resourceType: req.resourceType(),
                      pool: active.transportPool,
                      proxyConnectByHostname: this.policy.browserProxyConnectByHostname === true,
                    },
                  ));
                if (!cached) active.resourceCache.put(cacheKey, res);
              }
              // The released write was answered, whatever becomes of the answer below.
              if (releasedWrite && hops === 0) active.noteHeldResponse(releasedWrite, res.status);
              if (res.status < 300 || res.status >= 400 || !res.headers.location) break;
              const nextMethod = redirectedMethod(res.status, hopMethod);
              // A grant covers one write to one URL: repeating the write elsewhere takes the permission for every operation.
              if (hops >= 9 || (!['GET', 'HEAD'].includes(nextMethod) && !this.policy.allowAllOperations))
                return block('response_blocked');
              let next: URL;
              try {
                next = new URL(res.headers.location, current);
              } catch {
                return block('response_blocked');
              }
              if (next.username || next.password) return block('redirect_origin_not_allowed', next.origin);
              // Only a document may leave the origin, and only by reading a granted destination: Chromium requests it from a
              // stub, with its own cookies and headers for that origin.
              const leaving = next.origin !== current.origin;
              if (
                leaving &&
                (!mainNavigation ||
                  !['GET', 'HEAD'].includes(nextMethod) ||
                  (!active.reachable(next.origin) && !(await this.redirectMayLeave(next))))
              )
                return block('redirect_origin_not_allowed', next.origin);
              if (req.resourceType() === 'stylesheet' && method === 'GET') {
                if (++active.stylesheetRedirects > 64) return block('response_blocked');
                return route.fulfill({
                  status: 200,
                  contentType: 'text/css',
                  headers: { 'cache-control': 'no-store' },
                  body: redirectStylesheet(next),
                });
              }
              // A stub document carries a hop's cookies to Chromium at that hop's URL, before the next hop is requested.
              const setCookie = res.headers['set-cookie'] ?? [];
              if (leaving || (mainNavigation && setCookie.length && ['GET', 'HEAD'].includes(nextMethod))) {
                stubRedirect = next;
                break;
              }
              hopCookies.push(...setCookie);
              if (nextMethod !== hopMethod) {
                hopMethod = nextMethod;
                hopBody = undefined;
                hopBase = withoutBodyHeaders(headers);
                // The granted write has left; what follows only reads its destination.
                manualGeneration = approvedExpires = undefined;
              }
              current = next;
              hopHeaders = mainNavigation ? await navigationHopHeaders(context, hopBase, current) : hopBase;
            }
            const afterStub = mainNavigation && active.pendingDocumentRedirect === u.href;
            if (mainNavigation && current === u && !stubRedirect) {
              active.pendingDocumentRedirect = undefined;
              active.documentRedirects = 0;
            }
            // Chromium aborts a navigation answered with 204/205 and keeps the document. Abort it here, after the vetted request
            // was sent, so Playwright sees the navigation end instead of waiting for a document that never comes.
            if (req.isNavigationRequest() && (res.status === 204 || res.status === 205)) {
              active.noteNoContentNavigation(req, afterStub);
              return route.abort('aborted').catch(() => undefined);
            }
            // A redirected main-frame document has to commit at its final URL: a stub moves there, and its refresh is answered
            // with the response held here, so no hop is requested twice. A hop that sets cookies gets a stub at its own URL,
            // so that Chromium stores them under that URL's rules and sends them with the next hop.
            if (mainNavigation && (stubRedirect || current !== u)) {
              if (++active.documentRedirects > 10) return block('response_blocked');
              const destination = current === u ? stubRedirect! : current;
              if (destination.origin !== u.origin) active.reachByRedirect(destination.origin);
              active.pendingDocumentRedirect = destination.href;
              if (current === u) hopCookies.push(...(res.headers['set-cookie'] ?? []));
              else active.holdRedirectedDocument(current.href, res);
              const escaped = destination.href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
              return route.fulfill({
                status: 200,
                contentType: 'text/html',
                headers: hopCookies.length ? { 'set-cookie': hopCookies.join('\n') } : {},
                body: `<!doctype html><meta http-equiv="refresh" content="0;url=${escaped}">`,
              });
            }
            const outHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (HOP_RE.test(k) || v === undefined) continue;
              outHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
            }
            const setCookie = [...hopCookies, ...(res.headers['set-cookie'] ?? [])];
            if (setCookie.length) outHeaders['set-cookie'] = setCookie.join('\n');
            return route.fulfill({ status: res.status || 599, headers: outHeaders, body: res.body });
          } catch (error) {
            if (
              error instanceof AdlError &&
              error.reason &&
              (error.reason.startsWith('proxy_') ||
                error.reason === 'tls_handshake_failed' ||
                error.reason === 'transport_failure')
            )
              active.recordNavigationFailure(route.request(), error.reason as ErrorReason);
            await block(
              error instanceof AdlError
                ? (error.reason ?? (error.code === 'E_RESOURCE_LIMIT' ? 'response_blocked' : 'network_error'))
                : 'network_error',
            );
          } finally {
            if (releasedWrite) active.finishHeldWrite(releasedWrite);
          }
        });
        await context.routeWebSocket('**/*', ws => {
          active.recordNetworkBlock('request_denied', undefined, 'websocket', 'GET');
          ws.close({ code: 1008, reason: 'policy' });
        });
      }
      startup.stage('page_creation');
      page = await context.newPage();
      context.on('page', p => {
        if (p !== page) void p.close().catch(() => undefined);
      });
      page.on('popup', p => void p.close().catch(() => undefined));
      page.on('download', d => void d.cancel().catch(() => undefined));
      page.on('dialog', d => void d.dismiss().catch(() => undefined));
      await session.attach(page);
      startup.stage('navigation');
      await page.goto(config.url, { waitUntil: 'domcontentloaded' });
      startup.stage('session_initialization');
      await session.sessionReady();
      if (signal.aborted) throw new AdlError('E_CANCELLED');
      startup.finish(true);
      process.stderr.write(`adl: browser startup ${JSON.stringify(this.startup.snapshot())}\n`);
      return active;
    } catch (e) {
      startup.finish(false);
      process.stderr.write(`adl: browser startup ${JSON.stringify(this.startup.snapshot())}\n`);
      if (session) await session.close().catch(() => undefined);
      const proxyFailure = session?.takeNavigationFailure(config.url);
      if (proxyFailure) throw new AdlError('E_POLICY_DENIED', proxyFailure);
      if (e instanceof AdlError) throw e;
      throw new AdlError('E_POLICY_DENIED');
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const s of Array.from(this.sessions)) {
      await s.close().catch(() => undefined);
    }
    this.sessions.clear();
    const b = this.browser ?? (await this.launching?.catch(() => null));
    this.browser = null;
    this.launching = null;
    if (b) await b.close().catch(() => undefined);
  }
}
