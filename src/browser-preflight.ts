import type {ElementHandle, Page} from 'playwright';
import {AdlError, type Action, type ErrorCode} from './types.js';
import {SECRET_LABEL_PATTERN, BROWSER_PRIVACY_RULES} from './privacy.js';

export interface PreflightResult {
  target: {role: string; name: string; enabled: boolean};
  pointer_on_target: true;
  focus_matches_target: boolean;
}

interface Probe {
  ok: boolean; code?: ErrorCode;
  role?: string; name?: string; enabled?: boolean;
  unique?: boolean; visible?: boolean; inViewport?: boolean; hit?: boolean;
}

interface ProbeArgs {
  secretLabelPattern:string; privacyRules:typeof BROWSER_PRIVACY_RULES;
  allowAllOperations?:boolean;selector: string; action: 'click' | 'fill';
  expectRole?: string; expectName?: string; requireHit: boolean;
}

function guard(signal: AbortSignal, assertCurrent: () => void): void {
  if (signal.aborted) throw new AdlError('E_CANCELLED');
  assertCurrent();
}

// Serialized by Playwright (String(fn)) and executed in the page: must not close over module scope.
function probe(el: Element, a: ProbeArgs): Probe {
  const deny = (code: ErrorCode): Probe => ({ok: false, code});
  try {
    const CONSEQUENTIAL = /(delete|remove|upload|send|submit|purchase|checkout|pay|payment|login|log in|sign in|sign up|register|withdraw|transfer)/i;
    const sensitiveLabel=(text:string)=>new RegExp(a.secretLabelPattern,'iu').test(text.normalize('NFKC').replace(/([A-Z])([A-Z][a-z])/g,'$1 $2').replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/([A-Za-z])([0-9])/g,'$1 $2').replace(/([0-9])([A-Za-z])/g,'$1 $2'));
    if (!el || typeof el !== 'object' || el.isConnected !== true) return deny('E_STALE_STATE');
    const doc = el.ownerDocument ?? document;
    let list: NodeListOf<Element>;
    try { list = doc.querySelectorAll(a.selector); } catch { return deny('E_STALE_STATE'); }
    if (list.length !== 1 || list[0] !== el) return deny('E_STALE_STATE');
    const e = el as HTMLElement;
    const named = e as unknown as {type?: unknown; readOnly?: unknown; disabled?: unknown; labels?: ArrayLike<Element>; placeholder?: unknown; isContentEditable?: unknown};
    const tag = String(e.tagName).toUpperCase();
    const type = typeof named.type === 'string' ? named.type.toLowerCase() : '';
    // Match snapshotPageFn with bounded text-node traversal, never subtree textContent.
    const directText = (node: Element): string => {
      let text = '', visits = 0;
      for (let child = node.firstChild; child && text.length < 512 && visits++ < 64; child = child.nextSibling) {
        if (child.nodeType === 3 && child.textContent) text += child.textContent.slice(0, 512 - text.length);
      }
      return text.trim();
    };
    const isText = /^(P|SPAN|LEGEND|H[1-6]|TD|LI)$/.test(tag) && !!directText(e);
    const roleAttr = e.getAttribute('role');
    if ((roleAttr?.length ?? 0) > 100 || e.id.length > 512) return deny('E_RESOURCE_LIMIT');
    let role = roleAttr || '';
    if (!role) {
      if (tag === 'BUTTON') role = 'button';
      else if (tag === 'A') role = 'link';
      else if (tag === 'INPUT') role = type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'submit' ? 'button' : type === 'file' ? 'file' : 'textbox';
      else if (tag === 'TEXTAREA') role = 'textbox';
      else if (tag === 'SELECT') role = 'combobox';
      else role = /^H[1-6]$/.test(tag) ? 'heading' : isText ? 'text' : 'generic';
    }
    const label = (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') ? named.labels?.[0] : undefined;
    const inSensitiveRegion=(element:Element):boolean=>{
      let node:Element|null=element,depth=0;
      while(node&&depth++<a.privacyRules.ancestorCap){if(node.matches(a.privacyRules.regionSelector))return true;node=node.parentElement;}
      return node!==null;
    };
    const descendantText=(el:Element,includeHidden=false):string=>{
      if(inSensitiveRegion(el))return "x".repeat(512);
      let scanned=0, exhausted=false;
      const walker=doc.createTreeWalker(el,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT,{acceptNode:node=>{if(++scanned>128){exhausted=true;return NodeFilter.FILTER_ACCEPT;}return node.nodeType===1&&(node as Element).matches(a.privacyRules.textSkipSelector+","+a.privacyRules.regionSelector)?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT;}});
      let node:Node|null=walker.nextNode(),text='',visits=0;
      while(node&&!exhausted&&visits++<128&&text.length<512){
        if(node.nodeType===3&&!node.parentElement?.closest('script,style')&&(includeHidden||!node.parentElement?.closest('[hidden],[aria-hidden="true"]')))text+=node.textContent?.slice(0,512-text.length)??'';
        node=walker.nextNode();
      }
      return node?'x'.repeat(512):text.trim();
    };
    const refs=e.getAttribute('aria-labelledby')||'';
    if(refs.length>4096)return deny('E_RESOURCE_LIMIT');
    const ids=refs.trim()?refs.trim().split(/\s+/):[];
    const referenceText=ids.length>16?'x'.repeat(512):ids.map(id=>{const item=doc.getElementById(id);return item?descendantText(item,true):'';}).join(' ').slice(0,512).trim();
    const labelText=label?descendantText(label):'';
    const rawName = referenceText || e.getAttribute('aria-label') || labelText
      || (role === 'button' || role === 'link' || role === 'status' || role === 'alert' || isText ? descendantText(e) : '')
      || e.getAttribute('placeholder') || e.getAttribute('title') || e.id || '';
    const nameAttr = e.getAttribute('name') || '';
    if (rawName.length > 4096 || nameAttr.length > 512) return deny('E_RESOURCE_LIMIT');
    const name = rawName.slice(0, 512);
    const enabled = named.disabled !== true && !e.closest('fieldset:disabled') && e.getAttribute('aria-disabled') !== 'true';
    const rect = e.getBoundingClientRect();
    let visible = rect.width > 0 && rect.height > 0;
    if (visible) {
      if (typeof e.checkVisibility === 'function') {
        try { visible = e.checkVisibility({opacityProperty: true, visibilityProperty: true} as never); } catch { visible = e.checkVisibility(); }
      } else {
        try {
          const cs = getComputedStyle(e);
          visible = cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && cs.pointerEvents !== 'none';
        } catch { visible = true; }
      }
    }
    const win = doc.defaultView ?? window;
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    const inViewport = visible && rect.bottom > 0 && rect.right > 0 && rect.top < win.innerHeight && rect.left < win.innerWidth
      && cx >= 0 && cy >= 0 && cx < win.innerWidth && cy < win.innerHeight;
    let hit = false;
    if (inViewport) {
      // Only the topmost element at the center counts: an underlying target beneath a foreign overlay is stale.
      const deep = doc as Document & {elementsFromPoint?: (x: number, y: number) => Element[] | null};
      let stack: Element[] | null = null;
      try { stack = typeof deep.elementsFromPoint === 'function' ? deep.elementsFromPoint(cx, cy) : null; } catch { stack = null; }
      if (!stack || stack.length === 0) { const one = doc.elementFromPoint(cx, cy); stack = one ? [one] : []; }
      const top = stack[0];
      hit = !!top && (top === el || el.contains(top));
    }
    const autocomplete = e.getAttribute('autocomplete') || '';
    if (autocomplete.length > 512) return deny('E_RESOURCE_LIMIT');
    const haystack = (name + ' ' + type + ' ' + autocomplete + ' ' + nameAttr).toLowerCase();
    const hints=[rawName,labelText,...(label?[descendantText(label,true)]:[]),referenceText,e.getAttribute('aria-label')||'',e.getAttribute('placeholder')||'',e.getAttribute('title')||'',autocomplete,e.id,nameAttr];
    if(hints.some(hint=>hint.length>4096))return deny('E_RESOURCE_LIMIT');
    const sensitive = type === 'password' || type === 'file' || inSensitiveRegion(e) || hints.some(hint=>hint.length>=512||sensitiveLabel(hint));
    const editable = tag === 'INPUT' || tag === 'TEXTAREA' || named.isContentEditable === true;
    const readonly = named.readOnly === true || e.hasAttribute('readonly') || e.getAttribute('aria-readonly') === 'true';
    let form: Element | null = null;
    try { form = e.closest('form'); } catch { form = null; }
    const submitsForm = !!form && (type === 'submit' || tag === 'BUTTON' && (e.getAttribute('type') || 'submit') === 'submit');
    const consequential = CONSEQUENTIAL.test(haystack);
    if (a.expectRole !== undefined && role !== a.expectRole) return deny('E_STALE_STATE');
    if (a.expectName !== undefined && name !== a.expectName) return deny('E_STALE_STATE');
    if (!a.allowAllOperations&&sensitive) return deny('E_PRIVACY_BLOCKED');
    if (!a.allowAllOperations&&consequential) return deny('E_APPROVAL_REQUIRED');
    if (!a.allowAllOperations&&submitsForm) return deny('E_POLICY_DENIED');
    if (a.action === 'fill' && (!editable || readonly)) return deny('E_POLICY_DENIED');
    if (!enabled) return deny('E_STALE_STATE');
    if (!visible || a.requireHit && (!inViewport || !hit)) return deny('E_STALE_STATE');
    return {ok: true, role, name, enabled, unique: true, visible, inViewport, hit};
  } catch { return deny('E_STALE_STATE'); }
}

function assertProbe(p: Probe, requireHit = true): void {
  if (!p.ok) throw new AdlError(p.code ?? 'E_STALE_STATE');
  if (p.unique !== true || p.visible !== true || requireHit && (p.inViewport !== true || p.hit !== true)) throw new AdlError('E_STALE_STATE');
}

export async function preflightBrowserInput(
  page: Page, el: ElementHandle, action: Action, selector: string,
  signal: AbortSignal, assertCurrent: () => void, allowAllOperations=false,
): Promise<PreflightResult> {
  guard(signal, assertCurrent);
  if (action.action !== 'click' && action.action !== 'fill') throw new AdlError('E_UNSUPPORTED_ACTION');
  if (typeof selector !== 'string' || selector.length === 0) throw new AdlError('E_INVALID_ARGUMENT');
  const explicit = {...action.expected_target};
  if(allowAllOperations&&explicit.name?.includes('[redacted]'))delete explicit.name;
  if (page.isClosed()) throw new AdlError('E_STALE_STATE');
  const args = (expectRole?: string, expectName?: string, requireHit = true): ProbeArgs => ({secretLabelPattern:SECRET_LABEL_PATTERN,privacyRules:BROWSER_PRIVACY_RULES,allowAllOperations,selector, action: action.action as 'click' | 'fill', expectRole, expectName, requireHit});
  const runProbe = async (expectRole?: string, expectName?: string, requireHit = true): Promise<Probe> => {
    guard(signal, assertCurrent);
    const p = await el.evaluate(probe as never, args(expectRole, expectName, requireHit)) as unknown as Probe;
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
  await el.hover();
  guard(signal, assertCurrent);
  assertProbe(await runProbe(anchorRole, anchorName));

  let focusMatchesTarget = false;
  if (action.action === 'fill') {
    await el.focus();
    guard(signal, assertCurrent);
    // Focus may redirect: activeElement must be exactly the intended target before any input.
    guard(signal, assertCurrent);
    const active = await el.evaluate((e) => document.activeElement === e) as boolean;
    guard(signal, assertCurrent);
    if (!active) throw new AdlError('E_FOCUS_CHANGED');
    assertProbe(await runProbe(anchorRole, anchorName));
    focusMatchesTarget = true;
  }
  const final = await runProbe(anchorRole, anchorName);
  assertProbe(final);
  return {
    target: {role: String(final.role), name: String(final.name), enabled: final.enabled === true},
    pointer_on_target: true,
    focus_matches_target: focusMatchesTarget,
  };
}
