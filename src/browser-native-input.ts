import type { ElementHandle, Frame, Page } from 'playwright';
import { AdlError } from './types.js';
import { isolatedCollect, hitPointOf } from './browser-approval.js';
import type { BrowserIntegrity } from './browser-integrity.js';

// Playwright's injected actionability code reads properties of the target's
// ancestors (parentElement, getAttribute, matches, ...). A <form> exposes its
// controls as named properties that shadow those APIs in every JS world
// (<input name="parentElement">), which makes click/fill/check/select throw
// inside Playwright. When an ancestor demonstrably shadows an API, input is
// dispatched here instead: the same checks (visible, enabled, stable, hit-test
// identity proof at the click point, verified focus) over prototype reads and
// CDP input events. The choice is made before anything is dispatched and never
// revisited, so there is no fall back after a partial dispatch.
export interface NativeInput {
  page: Page;
  el: ElementHandle;
  frame: Frame;
  integrityKey: string;
  allowedFrameOrigins: readonly string[];
  opts: { timeout: number };
  signal: AbortSignal;
  assertIntegrity: () => Promise<void>;
  onDispatch: () => void;
  onUndone: () => void;
}

// DOM traversal and attribute APIs that Playwright's injected code (actionability, hit-target, focus) reads on the target and its ancestors.
// Form-specific names (action, method, submit, elements, ...) are not read from ancestors and stay on Playwright.
const TRAVERSAL_APIS = [
  'parentElement',
  'parentNode',
  'getAttribute',
  'hasAttribute',
  'matches',
  'closest',
  'getRootNode',
  'tagName',
  'nodeName',
  'nodeType',
  'localName',
  'ownerDocument',
  'children',
  'childNodes',
  'firstChild',
  'lastChild',
  'firstElementChild',
  'nextSibling',
  'previousSibling',
  'nextElementSibling',
  'previousElementSibling',
  'shadowRoot',
  'assignedSlot',
  'attributes',
  'contains',
  'isConnected',
  'querySelector',
  'querySelectorAll',
  'getElementsByTagName',
  'tabIndex',
  'id',
  'getBoundingClientRect',
  'getClientRects',
  'checkVisibility',
  'offsetParent',
  'style',
  'classList',
  'className',
];

// True when the element or an ancestor has an own property (a form's named property or a page expando) that shadows one of those APIs.
// Named properties are not listed by ownKeys, but each is an own property whose descriptor can be read.
export function shadowsDomApi(el: ElementHandle, integrityKey: string): Promise<boolean> {
  return el.evaluate(
    (node, args) => {
      if (!(window as unknown as Record<string, BrowserIntegrity>)[args.key]?.check())
        throw new Error('ADL_UNTRUSTED_DOM');
      const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
        m = (o: object, k: string, ...a: unknown[]): any => Reflect.apply(r(o, k), o, a);
      let current: Element | null = node as Element,
        depth = 0;
      for (
        ;
        current && depth++ < 256;
        current =
          (r(current, 'parentElement') as Element | null) ?? (m(current, 'getRootNode') as ShadowRoot).host ?? null
      )
        for (const name of args.names) if (Reflect.getOwnPropertyDescriptor(current, name) !== undefined) return true;
      return false;
    },
    { key: integrityKey, names: TRAVERSAL_APIS },
  );
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const sameBox = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

// Visible, enabled and stable (same box on consecutive reads), scrolled into view; returns the click point.
async function settle(c: NativeInput): Promise<{ x: number; y: number }> {
  await c.el.scrollIntoViewIfNeeded(c.opts);
  const state = await c.el.evaluate((node, key) => {
    if (!(window as unknown as Record<string, BrowserIntegrity>)[key]?.check()) throw new Error('ADL_UNTRUSTED_DOM');
    const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
      m = (o: object, k: string, ...a: unknown[]): any => Reflect.apply(r(o, k), o, a);
    if (r(node, 'isConnected') !== true) return 'detached';
    if (m(node, 'matches', ':disabled')) return 'disabled';
    const rect = m(node, 'getBoundingClientRect') as DOMRect;
    return rect.width > 0 &&
      rect.height > 0 &&
      m(node, 'checkVisibility', { opacityProperty: true, visibilityProperty: true }) === true
      ? 'ok'
      : 'hidden';
  }, c.integrityKey);
  if (state === 'detached' || state === 'disabled') throw new AdlError('E_STALE_STATE');
  if (state === 'hidden') throw new AdlError('E_STALE_STATE', 'not_visible');
  let box = await c.el.boundingBox(),
    stable = false;
  for (let attempt = 0; attempt < 10 && !stable; attempt++) {
    if (c.signal.aborted) throw new AdlError('E_CANCELLED');
    await sleep(50);
    const next = await c.el.boundingBox();
    if (!box || !next) throw new AdlError('E_STALE_STATE');
    stable = sameBox(box, next);
    box = next;
  }
  if (!stable || !box) throw new AdlError('E_STALE_STATE');
  const point = hitPointOf(box, c.page.viewportSize());
  if (!point) throw new AdlError('E_STALE_STATE', 'not_visible');
  return point;
}

// The CDP hit-test identity proof of isolatedCollect, pinned to the exact point that is about to be clicked.
const proveHit = (c: NativeInput, point: { x: number; y: number }) =>
  isolatedCollect(c.el, () => true, null, c.allowedFrameOrigins, c.frame, point);

export async function nativeClick(c: NativeInput): Promise<void> {
  const point = await settle(c);
  await proveHit(c, point);
  if (c.signal.aborted) throw new AdlError('E_CANCELLED');
  await c.page.mouse.move(point.x, point.y);
  // Hover handlers may move or replace the target: prove it again at the same point.
  await proveHit(c, point);
  await c.assertIntegrity();
  if (c.signal.aborted) throw new AdlError('E_CANCELLED');
  // Like Playwright's click, return only once a navigation the click started has been requested and handled (its request has passed the
  // network route, where approvals and the submission guard apply), so the caller's guards are still armed when it is decided.
  const cdp = await c.page.context().newCDPSession(c.page);
  let requested = false;
  try {
    cdp.on('Page.frameRequestedNavigation', () => {
      requested = true;
    });
    await cdp.send('Page.enable');
    const navigated = c.page.waitForEvent('framenavigated', { timeout: 1500 }).catch(() => undefined);
    c.onDispatch();
    await c.page.mouse.click(point.x, point.y);
    await sleep(25);
    if (requested) await navigated;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

// Returns false, having changed nothing, for controls that are not filled (file, checkbox, ...).
export async function nativeFill(c: NativeInput, value: string): Promise<boolean> {
  const kind = await c.el.evaluate((node, key) => {
    if (!(window as unknown as Record<string, BrowserIntegrity>)[key]?.check()) throw new Error('ADL_UNTRUSTED_DOM');
    const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o);
    const tag = String(r(node, 'tagName')).toLowerCase();
    if (tag === 'textarea') return 'text';
    if (tag === 'input') {
      const type = String(r(node, 'type')).toLowerCase();
      return ['text', 'search', 'email', 'url', 'tel', 'number', 'password'].includes(type)
        ? 'text'
        : ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'].includes(type)
          ? 'value'
          : '';
    }
    return r(node, 'isContentEditable') === true ? 'editable' : '';
  }, c.integrityKey);
  if (!kind) return false;
  await c.el.scrollIntoViewIfNeeded(c.opts);
  await c.el.focus();
  // Focus may redirect, and the control may have become disabled or read-only: select its content only if it is still the focused, writable target.
  const ready = await c.el.evaluate(
    (node, args) => {
      if (!(window as unknown as Record<string, BrowserIntegrity>)[args.key]?.check())
        throw new Error('ADL_UNTRUSTED_DOM');
      const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
        m = (o: object, k: string, ...a: unknown[]): any => Reflect.apply(r(o, k), o, a);
      if (r(node, 'isConnected') !== true || m(node, 'matches', ':disabled')) return 'stale';
      if (r(m(node, 'getRootNode'), 'activeElement') !== node) return 'focus';
      if (args.kind === 'text' || args.kind === 'value') {
        if (r(node, 'readOnly') === true) return 'stale';
        if (args.kind === 'text') m(node, 'select');
      } else m(m(r(node, 'ownerDocument'), 'getSelection'), 'selectAllChildren', node);
      return 'ok';
    },
    { key: c.integrityKey, kind },
  );
  if (ready === 'focus') throw new AdlError('E_FOCUS_CHANGED');
  if (ready !== 'ok') throw new AdlError('E_STALE_STATE');
  await c.assertIntegrity();
  if (c.signal.aborted) throw new AdlError('E_CANCELLED');
  c.onDispatch();
  if (kind === 'value') {
    // Like Playwright: these types take their value from the setter, not from typing; a value the type does not accept is read back different and restored.
    const accepted = await c.el.evaluate(
      (node, args) => {
        if (!(window as unknown as Record<string, BrowserIntegrity>)[args.key]?.check())
          throw new Error('ADL_UNTRUSTED_DOM');
        const previous = Reflect.get(HTMLInputElement.prototype, 'value', node) as string;
        Reflect.set(HTMLInputElement.prototype, 'value', args.value, node);
        if (Reflect.get(HTMLInputElement.prototype, 'value', node) !== args.value) {
          Reflect.set(HTMLInputElement.prototype, 'value', previous, node);
          return false;
        }
        for (const type of ['input', 'change'])
          Reflect.apply(EventTarget.prototype.dispatchEvent, node, [
            new Event(type, { bubbles: true, composed: true }),
          ]);
        return true;
      },
      { key: c.integrityKey, value },
    );
    if (!accepted) {
      c.onUndone();
      throw new AdlError('E_INVALID_ARGUMENT');
    }
  } else if (value) await c.page.keyboard.insertText(value);
  else await c.page.keyboard.press('Delete');
  return true;
}

export async function nativeSetChecked(
  c: NativeInput,
  wanted: boolean,
  checkedState: () => Promise<boolean>,
): Promise<void> {
  const kind = await c.el.evaluate((node, key) => {
    if (!(window as unknown as Record<string, BrowserIntegrity>)[key]?.check()) throw new Error('ADL_UNTRUSTED_DOM');
    const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o);
    return String(r(node, 'tagName')).toLowerCase() === 'input' ? String(r(node, 'type')).toLowerCase() : '';
  }, c.integrityKey);
  if (kind !== 'checkbox' && kind !== 'radio') throw new AdlError('E_NOT_INTERACTABLE');
  const was = await checkedState();
  if (was === wanted) return;
  if (kind === 'radio' && !wanted) throw new AdlError('E_NOT_INTERACTABLE');
  await nativeClick(c);
  // Like Playwright: a click that did not produce the requested state is a failure, not a success.
  if ((await checkedState()) !== wanted) throw new AdlError('E_NOT_INTERACTABLE');
}

export async function nativeSelect(c: NativeInput, value: string): Promise<void> {
  await c.el.scrollIntoViewIfNeeded(c.opts);
  const index = await c.el.evaluate(
    (node, args) => {
      if (!(window as unknown as Record<string, BrowserIntegrity>)[args.key]?.check())
        throw new Error('ADL_UNTRUSTED_DOM');
      const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
        m = (o: object, k: string, ...a: unknown[]): any => Reflect.apply(r(o, k), o, a);
      if (String(r(node, 'tagName')).toLowerCase() !== 'select') return -3;
      if (r(node, 'isConnected') !== true || m(node, 'matches', ':disabled')) return -2;
      const rect = m(node, 'getBoundingClientRect') as DOMRect;
      if (!(
        rect.width > 0 &&
        rect.height > 0 &&
        m(node, 'checkVisibility', { opacityProperty: true, visibilityProperty: true }) === true
      ))
        return -4;
      const options = r(node, 'options') as HTMLOptionsCollection,
        count = r(options, 'length') as number;
      for (let i = 0; i < count && i < 4096; i++) {
        const option = Reflect.apply(HTMLCollection.prototype.item, options, [i]) as HTMLOptionElement;
        if (r(option, 'value') === args.value || r(option, 'label') === args.value) return i;
      }
      return -1;
    },
    { key: c.integrityKey, value },
  );
  if (index === -3) throw new AdlError('E_NOT_INTERACTABLE');
  if (index === -2) throw new AdlError('E_STALE_STATE');
  if (index === -4) throw new AdlError('E_STALE_STATE', 'not_visible');
  if (index < 0) throw new AdlError('E_INVALID_ARGUMENT');
  await c.assertIntegrity();
  if (c.signal.aborted) throw new AdlError('E_CANCELLED');
  c.onDispatch();
  const applied = await c.el.evaluate(
    (node, args) => {
      if (!(window as unknown as Record<string, BrowserIntegrity>)[args.key]?.check())
        throw new Error('ADL_UNTRUSTED_DOM');
      const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o);
      const options = r(node, 'options') as HTMLOptionsCollection,
        target = Reflect.apply(HTMLCollection.prototype.item, options, [args.index]) as HTMLOptionElement | null;
      if (!target || (r(target, 'value') !== args.value && r(target, 'label') !== args.value)) return false;
      if (r(node, 'multiple') === true) {
        const count = r(options, 'length') as number;
        for (let i = 0; i < count && i < 4096; i++) {
          const option = Reflect.apply(HTMLCollection.prototype.item, options, [i]) as HTMLOptionElement;
          Reflect.set(HTMLOptionElement.prototype, 'selected', option === target, option);
        }
      } else Reflect.set(HTMLOptionElement.prototype, 'selected', true, target);
      for (const type of ['input', 'change'])
        Reflect.apply(EventTarget.prototype.dispatchEvent, node, [new Event(type, { bubbles: true, composed: true })]);
      return true;
    },
    { key: c.integrityKey, index, value },
  );
  if (!applied) throw new AdlError('E_STALE_STATE');
}
