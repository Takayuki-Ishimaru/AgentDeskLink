import type { ElementHandle, Page } from 'playwright';
import { AdlError, type Action, type ErrorCode, type ErrorReason } from './types.js';
import { SECRET_LABEL_PATTERN, BROWSER_PRIVACY_RULES } from './privacy.js';
import type { BrowserIntegrity } from './browser-integrity.js';
import { hitPointOf } from './browser-approval.js';

export interface PreflightResult {
  target: { role: string; name: string; enabled: boolean };
  pointer_on_target: true;
  focus_matches_target: boolean;
}

interface Probe {
  ok: boolean;
  code?: ErrorCode;
  reason?: ErrorReason;
  role?: string;
  name?: string;
  enabled?: boolean;
  unique?: boolean;
  visible?: boolean;
  inViewport?: boolean;
  hit?: boolean;
}

interface ProbeArgs {
  secretLabelPattern: string;
  privacyRules: typeof BROWSER_PRIVACY_RULES;
  allowAllOperations?: boolean;
  selector: string;
  action: 'click' | 'fill' | 'press' | 'hover';
  expectRole?: string;
  expectName?: string;
  requireHit: boolean;
  key?: string;
  integrityKey?: string;
}

function guard(signal: AbortSignal, assertCurrent: () => void): void {
  if (signal.aborted) throw new AdlError('E_CANCELLED');
  assertCurrent();
}

// Serialized by Playwright (String(fn)) and executed in the page: must not close over module scope.
function probe(el: Element, a: ProbeArgs): Probe {
  const deny = (code: ErrorCode, reason?: ErrorReason): Probe => ({ ok: false, code, ...(reason ? { reason } : {}) });
  try {
    if (a.integrityKey && !(window as unknown as Record<string, BrowserIntegrity>)[a.integrityKey]?.check())
      return deny('E_PRIVACY_BLOCKED', 'untrusted_dom_api');
    // Document and form named properties (img name="activeElement", input
    // name="matches") shadow instance APIs; every read on the target, its
    // ancestors and the document resolves through the verified prototype chain.
    const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
      m = (o: object, k: string, ...args: unknown[]): any => Reflect.apply(r(o, k), o, args);
    const attr = (x: Element, k: string) => m(x, 'getAttribute', k) as string | null,
      has = (x: Element, k: string) => m(x, 'hasAttribute', k) as boolean;
    const CONSEQUENTIAL =
      /(delete|remove|upload|send|submit|purchase|checkout|pay|payment|login|log in|sign in|sign up|register|withdraw|transfer)/i;
    const sensitiveLabel = (text: string) =>
      new RegExp(a.secretLabelPattern, 'iu').test(
        text
          .normalize('NFKC')
          .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
          .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
          .replace(/([A-Za-z])([0-9])/g, '$1 $2')
          .replace(/([0-9])([A-Za-z])/g, '$1 $2'),
      );
    if (!el || typeof el !== 'object' || r(el, 'isConnected') !== true) return deny('E_STALE_STATE');
    const doc = (r(el, 'ownerDocument') as Document | null) ?? document;
    let list: NodeListOf<Element>;
    try {
      list = m(m(el, 'getRootNode'), 'querySelectorAll', a.selector) as NodeListOf<Element>;
    } catch {
      return deny('E_STALE_STATE');
    }
    if (list.length !== 1 || list[0] !== el) return deny('E_STALE_STATE');
    const e = el as HTMLElement;
    const tag = String(r(e, 'tagName')).toUpperCase();
    const typeValue = r(e, 'type');
    const type = typeof typeValue === 'string' ? typeValue.toLowerCase() : '';
    // Match snapshotPageFn with bounded text-node traversal, never subtree textContent.
    const directText = (node: Element): string => {
      let text = '',
        visits = 0;
      for (
        let child = r(node, 'firstChild') as ChildNode | null;
        child && text.length < 512 && visits++ < 64;
        child = r(child, 'nextSibling')
      ) {
        if (r(child, 'nodeType') === 3 && child.textContent) text += child.textContent.slice(0, 512 - text.length);
      }
      return text.trim();
    };
    const clickable = has(e, 'onclick') || (r(e, 'tabIndex') >= 0 && getComputedStyle(e).cursor === 'pointer');
    const isText =
      /^(DIV|P|SPAN|LEGEND|H[1-6]|TD|TH|LI|DT|DD|BLOCKQUOTE|CODE|PRE|TIME|CAPTION|FIGCAPTION|SUMMARY|STRONG|EM|B|I|SMALL|MARK|Q|SAMP|KBD|CITE|ABBR|ADDRESS|ARTICLE|SECTION|MAIN|HEADER|FOOTER|ASIDE|OUTPUT)$/.test(
        tag,
      ) && !!directText(e);
    const roleAttr = attr(e, 'role'),
      id = attr(e, 'id') || '';
    if ((roleAttr?.length ?? 0) > 100 || id.length > 512) return deny('E_RESOURCE_LIMIT');
    let role = roleAttr || '';
    if (!role) {
      if (tag === 'BUTTON') role = 'button';
      else if (tag === 'A') role = 'link';
      else if (tag === 'INPUT')
        role =
          type === 'checkbox'
            ? 'checkbox'
            : type === 'radio'
              ? 'radio'
              : type === 'submit'
                ? 'button'
                : type === 'file'
                  ? 'file'
                  : 'textbox';
      else if (tag === 'TEXTAREA') role = 'textbox';
      else if (tag === 'SELECT') role = 'combobox';
      else
        role =
          tag === 'IMG'
            ? 'img'
            : tag === 'TH'
              ? 'columnheader'
              : /^H[1-6]$/.test(tag)
                ? 'heading'
                : clickable
                  ? 'button'
                  : tag === 'BLOCKQUOTE'
                    ? 'blockquote'
                    : tag === 'CODE' || tag === 'PRE'
                      ? 'code'
                      : tag === 'TIME'
                        ? 'time'
                        : tag === 'CAPTION' || tag === 'FIGCAPTION'
                          ? 'caption'
                          : isText
                            ? 'text'
                            : 'generic';
    }
    const label =
      tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
        ? ((r(e, 'labels') as NodeList | undefined)?.[0] as Element | undefined)
        : undefined;
    const inSensitiveRegion = (element: Element): boolean => {
      let node: Element | null = element,
        depth = 0;
      while (node && depth++ < a.privacyRules.ancestorCap) {
        if (m(node, 'matches', a.privacyRules.regionSelector)) return true;
        node = (r(node, 'parentElement') as Element | null) ?? (m(node, 'getRootNode') as ShadowRoot).host ?? null;
      }
      return node !== null;
    };
    const descendantText = (el: Element, includeHidden = false): string => {
      if (inSensitiveRegion(el)) return 'x'.repeat(512);
      let scanned = 0,
        exhausted = false;
      const walker = m(doc, 'createTreeWalker', el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: (node: Node) => {
          if (++scanned > 128) {
            exhausted = true;
            return NodeFilter.FILTER_ACCEPT;
          }
          return r(node, 'nodeType') === 1 &&
            m(node, 'matches', a.privacyRules.textSkipSelector + ',' + a.privacyRules.regionSelector)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        },
      }) as TreeWalker;
      let node: Node | null = walker.nextNode(),
        text = '',
        visits = 0;
      while (node && !exhausted && visits++ < 128 && text.length < 512) {
        const parent = node.parentElement;
        if (
          r(node, 'nodeType') === 3 &&
          !(parent && m(parent, 'closest', 'script,style')) &&
          (includeHidden || !(parent && m(parent, 'closest', '[hidden],[aria-hidden="true"]')))
        )
          text += node.textContent?.slice(0, 512 - text.length) ?? '';
        node = walker.nextNode();
      }
      return node ? 'x'.repeat(512) : text.trim();
    };
    const refs = attr(e, 'aria-labelledby') || '';
    if (refs.length > 4096) return deny('E_RESOURCE_LIMIT');
    const ids = refs.trim() ? refs.trim().split(/\s+/) : [];
    const referenceText =
      ids.length > 16
        ? 'x'.repeat(512)
        : ids
            .map(id => {
              const item = m(m(e, 'getRootNode'), 'getElementById', id) as Element | null;
              return item ? descendantText(item, true) : '';
            })
            .join(' ')
            .slice(0, 512)
            .trim();
    const labelText = label ? descendantText(label) : '';
    const rawName =
      referenceText ||
      attr(e, 'aria-label') ||
      labelText ||
      (isText && !['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT'].includes(tag) && !clickable && !roleAttr
        ? directText(e)
        : descendantText(e)) ||
      attr(e, 'alt') ||
      attr(e, 'placeholder') ||
      attr(e, 'title') ||
      id ||
      '';
    const nameAttr = attr(e, 'name') || '';
    if (rawName.length > 4096 || nameAttr.length > 512) return deny('E_RESOURCE_LIMIT');
    const name = rawName.slice(0, 512);
    const enabled =
      r(e, 'disabled') !== true && !m(e, 'closest', 'fieldset:disabled') && attr(e, 'aria-disabled') !== 'true';
    const rect = m(e, 'getBoundingClientRect') as DOMRect;
    let visible = rect.width > 0 && rect.height > 0;
    if (visible) {
      if (typeof r(e, 'checkVisibility') === 'function') {
        try {
          visible = m(e, 'checkVisibility', { opacityProperty: true, visibilityProperty: true }) as boolean;
        } catch {
          visible = m(e, 'checkVisibility') as boolean;
        }
      } else {
        try {
          const cs = getComputedStyle(e);
          visible =
            cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && cs.pointerEvents !== 'none';
        } catch {
          visible = true;
        }
      }
    }
    const win = (r(doc, 'defaultView') as Window | null) ?? window;
    const cx = rect.left + rect.width / 2,
      cy = rect.top + rect.height / 2;
    const inViewport =
      visible &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < win.innerHeight &&
      rect.left < win.innerWidth &&
      cx >= 0 &&
      cy >= 0 &&
      cx < win.innerWidth &&
      cy < win.innerHeight;
    let hit = false;
    if (inViewport) {
      // Every shadow host must itself be the topmost hit in its parent root.
      // Checking only the inner root misses overlays covering the host.
      let current: Element = el;
      for (let depth = 0; depth < 128; depth++) {
        const root = m(current, 'getRootNode') as Document | ShadowRoot;
        const stack =
          typeof r(root, 'elementsFromPoint') === 'function' ? (m(root, 'elementsFromPoint', cx, cy) as Element[]) : [];
        const top = stack[0] ?? (m(root, 'elementFromPoint', cx, cy) as Element | null);
        if (!top || !(top === current || m(current, 'contains', top))) {
          hit = false;
          break;
        }
        if (root === doc) {
          hit = true;
          break;
        }
        if (!(root instanceof ShadowRoot) || root.mode !== 'open') {
          hit = false;
          break;
        }
        current = root.host;
      }
    }
    const autocomplete = attr(e, 'autocomplete') || '';
    if (autocomplete.length > 512) return deny('E_RESOURCE_LIMIT');
    const haystack = (name + ' ' + type + ' ' + autocomplete + ' ' + nameAttr).toLowerCase();
    const hints = [
      rawName,
      labelText,
      ...(label ? [descendantText(label, true)] : []),
      referenceText,
      attr(e, 'aria-label') || '',
      attr(e, 'placeholder') || '',
      attr(e, 'title') || '',
      autocomplete,
      id,
      nameAttr,
    ];
    if (hints.some(hint => hint.length > 4096)) return deny('E_RESOURCE_LIMIT');
    const sensitive =
      type === 'password' ||
      type === 'file' ||
      inSensitiveRegion(e) ||
      hints.some(hint => hint.length >= 512 || sensitiveLabel(hint));
    const editable = tag === 'INPUT' || tag === 'TEXTAREA' || r(e, 'isContentEditable') === true;
    const readonly = r(e, 'readOnly') === true || has(e, 'readonly') || attr(e, 'aria-readonly') === 'true';
    let form: Element | null = null;
    try {
      form = m(e, 'closest', 'form') as Element | null;
    } catch {
      form = null;
    }
    const submitsForm =
      !!form && (type === 'submit' || (tag === 'BUTTON' && (attr(e, 'type') || 'submit') === 'submit'));
    const consequential = CONSEQUENTIAL.test(haystack);
    if (a.expectRole !== undefined && role !== a.expectRole) return deny('E_STALE_STATE');
    if (a.expectName !== undefined && name !== a.expectName) return deny('E_STALE_STATE');
    if (inSensitiveRegion(e)) return deny('E_PRIVACY_BLOCKED');
    if (!a.allowAllOperations && sensitive) return deny('E_PRIVACY_BLOCKED');
    if (!a.allowAllOperations && consequential) return deny('E_APPROVAL_REQUIRED', 'consequential_operation');
    if (!a.allowAllOperations && a.action === 'press' && a.key === 'Enter' && form)
      return deny('E_APPROVAL_REQUIRED', 'consequential_operation');
    if (!a.allowAllOperations && submitsForm) return deny('E_POLICY_DENIED');
    if (a.action === 'fill' && (!editable || readonly)) return deny('E_NOT_INTERACTABLE', 'not_editable');
    if (!enabled) return deny('E_STALE_STATE');
    if (!visible || (a.requireHit && !inViewport)) return deny('E_STALE_STATE', 'not_visible');
    if (a.requireHit && !hit) return deny('E_NOT_INTERACTABLE', 'occluded');
    if (a.integrityKey && !(window as unknown as Record<string, BrowserIntegrity>)[a.integrityKey]?.check())
      return deny('E_PRIVACY_BLOCKED', 'untrusted_dom_api');
    return { ok: true, role, name, enabled, unique: true, visible, inViewport, hit };
  } catch {
    return deny('E_STALE_STATE');
  }
}

function assertProbe(p: Probe, requireHit = true): void {
  if (!p.ok) throw new AdlError(p.code ?? 'E_STALE_STATE', p.reason);
  if (p.unique !== true || p.visible !== true || (requireHit && (p.inViewport !== true || p.hit !== true)))
    throw new AdlError('E_STALE_STATE');
}

export async function preflightBrowserInput(
  page: Page,
  el: ElementHandle,
  action: Action,
  selector: string,
  signal: AbortSignal,
  assertCurrent: () => void,
  allowAllOperations = false,
  onHover?: () => void,
  integrityKey?: string,
  nativeInput = false,
): Promise<PreflightResult> {
  guard(signal, assertCurrent);
  if (!['click', 'fill', 'press', 'hover'].includes(action.action)) throw new AdlError('E_UNSUPPORTED_ACTION');
  if (typeof selector !== 'string' || selector.length === 0) throw new AdlError('E_INVALID_ARGUMENT');
  const explicit = { ...action.expected_target };
  if (allowAllOperations && explicit.name?.includes('[redacted]')) delete explicit.name;
  if (page.isClosed()) throw new AdlError('E_STALE_STATE');
  const args = (expectRole?: string, expectName?: string, requireHit = true): ProbeArgs => ({
    secretLabelPattern: SECRET_LABEL_PATTERN,
    privacyRules: BROWSER_PRIVACY_RULES,
    allowAllOperations,
    selector,
    action: action.action as 'click' | 'fill' | 'press' | 'hover',
    expectRole,
    expectName,
    requireHit,
    key: action.value,
    integrityKey,
  });
  const runProbe = async (expectRole?: string, expectName?: string, requireHit = true): Promise<Probe> => {
    guard(signal, assertCurrent);
    const p = (await el.evaluate(probe as never, args(expectRole, expectName, requireHit))) as unknown as Probe;
    guard(signal, assertCurrent);
    return p;
  };

  // Pre-hover: validate the live exact element; legacy clients may omit expected_target.
  let first = await runProbe(explicit.role, explicit.name, false);
  assertProbe(first, false);
  // Anchor identity for later probes: explicit expectation wins, else the validated live element.
  const anchorRole = explicit.role ?? String(first.role);
  const anchorName = explicit.name ?? String(first.name);

  // Legitimate offscreen controls may need scrolling before geometry checks.
  guard(signal, assertCurrent);
  await el.scrollIntoViewIfNeeded();
  guard(signal, assertCurrent);
  first = await runProbe(anchorRole, anchorName);
  assertProbe(first);

  // hover() is a virtual mouse move and may trigger overlays or replacement.
  // nativeInput: an ancestor form shadows DOM APIs Playwright's hover/focus read (see browser-native-input.ts); use the CDP/prototype equivalents.
  onHover?.();
  if (nativeInput) {
    const box = await el.boundingBox(),
      point = box && hitPointOf(box, page.viewportSize());
    if (!point) throw new AdlError('E_STALE_STATE', 'not_visible');
    await page.mouse.move(point.x, point.y);
  } else await el.hover();
  guard(signal, assertCurrent);
  assertProbe(await runProbe(anchorRole, anchorName));

  let focusMatchesTarget = false;
  if (action.action === 'fill' || action.action === 'press') {
    if (nativeInput)
      await el.evaluate((e, key) => {
        if (key && !(window as unknown as Record<string, BrowserIntegrity>)[key]?.check())
          throw new Error('ADL_UNTRUSTED_DOM');
        Reflect.apply(Reflect.get(Object.getPrototypeOf(e), 'focus', e), e, []);
      }, integrityKey);
    else await el.focus();
    guard(signal, assertCurrent);
    // Focus may redirect: activeElement must be exactly the intended target before any input.
    guard(signal, assertCurrent);
    const active = (await el.evaluate((e, key) => {
      if (key && !(window as unknown as Record<string, BrowserIntegrity>)[key]?.check())
        throw new Error('ADL_UNTRUSTED_DOM');
      const root = Reflect.apply(Reflect.get(Object.getPrototypeOf(e), 'getRootNode', e), e, []) as
        Document | ShadowRoot;
      return Reflect.get(Object.getPrototypeOf(root), 'activeElement', root) === e;
    }, integrityKey)) as boolean;
    guard(signal, assertCurrent);
    if (!active) throw new AdlError('E_FOCUS_CHANGED');
    assertProbe(await runProbe(anchorRole, anchorName));
    focusMatchesTarget = true;
  }
  const final = await runProbe(anchorRole, anchorName);
  assertProbe(final);
  return {
    target: { role: String(final.role), name: String(final.name), enabled: final.enabled === true },
    pointer_on_target: true,
    focus_matches_target: focusMatchesTarget,
  };
}
