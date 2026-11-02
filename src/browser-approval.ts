import { createHash, randomUUID } from 'node:crypto';
import type { ElementHandle, Frame } from 'playwright';
import { AdlError, type Action } from './types.js';
import { BROWSER_PRIVACY_RULES, SECRET_LABEL_PATTERN } from './privacy.js';
import { describeApprovalForm } from './approval-summary.js';
import {
  classifyLabel,
  isContainable,
  type ActionFacts,
  type LabelLists,
  type LabelVerdict,
} from './action-classifier.js';

export type ActionRisk = 'ordinary' | 'credential' | 'consequential';
export interface ActionProof {
  proof: string;
  risk: ActionRisk;
  role: string;
  name: string;
  origin: string;
  details?: string[];
  network?: { url: string; method: string; body: string };
  /** Consequential only because it submits a form: dispatchable in standard mode under the submission guard. */ submission?: 'plain';
  /** Consequential only through a verb that may stay in the session: dispatchable in standard mode with the network closed. */ contained?: boolean;
  /** Why the label classifier decided as it did (internal; never sent to the approval broker). */
  classification?: LabelVerdict['reason'];
}

// CDP supplies a backend node identity from the hit-test. We compare candidate
// ancestors to the retained Playwright handle with JavaScript identity only;
// no DOM attributes or page-controlled getters are used for that comparison.
// CDP then resolves that exact backend node in a fresh isolated world.
// Candidate ancestors are located by their CDP child-index path, walked in the
// page through prototype reads: Playwright's CSS engine calls element.matches
// and parentElement, which form named properties (<input name="matches">) shadow.
// frameHint is the frame the caller already knows owns the element;
// ElementHandle.ownerFrame() reads document.documentElement, which document
// named properties (<img id="documentElement" name=...>) shadow.
type PathStep = number; // 0 = open shadow root of the current element, n>0 = n-th element child
const walkPath = (path: number[]) => {
  const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o);
  let current: Node | null = document;
  for (const step of path) {
    if (!current) return null;
    if (step === 0) current = r(current, 'shadowRoot') as ShadowRoot | null;
    else {
      const kids = r(current, 'children') as HTMLCollection | undefined;
      if (!kids) return null;
      current = Reflect.apply(HTMLCollection.prototype.item, kids, [step - 1]) as Node | null;
    }
  }
  return current instanceof Element ? current : null;
};
async function resolvePath(frame: Frame, path: PathStep[]): Promise<ElementHandle | null> {
  const handle = await frame.evaluateHandle(walkPath, path);
  const element = handle.asElement();
  if (!element) await handle.dispose().catch(() => undefined);
  return element;
}
// The point a click at this element would use: the centre of its visible box.
export function hitPointOf(
  box: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number } | null,
): { x: number; y: number } | undefined {
  const left = Math.max(0, box.x),
    top = Math.max(0, box.y),
    right = Math.min(viewport?.width ?? box.x + box.width, box.x + box.width),
    bottom = Math.min(viewport?.height ?? box.y + box.height, box.y + box.height);
  if (right <= left || bottom <= top) return undefined;
  const x = Math.floor((left + right) / 2),
    y = Math.floor((top + bottom) / 2);
  if (x < 0 || y < 0 || (viewport && (x >= viewport.width || y >= viewport.height))) return undefined;
  return { x, y };
}
// The click point a preflight verified, as an offset from the border-box origin that boundingBox() reports, in viewport coordinates.
// The offset is relative so it stays valid for elements inside iframes (boundingBox() already includes the frame origin).
export function offsetPointOf(
  box: { x: number; y: number },
  offset: { x: number; y: number },
  viewport: { width: number; height: number } | null,
): { x: number; y: number } | undefined {
  const x = box.x + offset.x,
    y = box.y + offset.y;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return undefined;
  if (viewport && (x >= viewport.width || y >= viewport.height)) return undefined;
  return { x, y };
}
// Click points on a clipped span: the centre of the pixel containing its midpoint (so CDP's integer hit-test, Playwright's rounding of
// positions and the mouse event all name the same pixel); the exact midpoint when that pixel centre lies outside a sub-pixel span.
// browser-preflight.ts carries an identical copy inside the page-side probe.
function pixelCentre(low: number, high: number): number {
  const middle = (low + high) / 2,
    pixel = Math.floor(middle) + 0.5;
  return pixel > low && pixel < high ? pixel : middle;
}
// Layout fragments of an element in its frame's viewport coordinates, read through prototype accessors (form named properties
// and page expandos cannot substitute them). Serialized into the page: must not close over module scope.
function pageFragments(node: Element) {
  const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
    m = (o: object, k: string, ...a: unknown[]): any => Reflect.apply(r(o, k), o, a);
  const rect = m(node, 'getBoundingClientRect') as DOMRect,
    list = m(node, 'getClientRects') as ArrayLike<DOMRect>,
    fragments: number[][] = [];
  for (let i = 0; i < list.length && i < 64; i++) {
    const f = list[i]!;
    fragments.push([f.left, f.top, f.right, f.bottom]);
  }
  return { left: rect.left, top: rect.top, fragments };
}
// The centre of every non-empty layout fragment inside the viewport, in the coordinates of boundingBox(). An inline element wrapped
// over several lines has one fragment per line box; the centre of its bounding box can lie on whitespace or another element.
async function fragmentPointsOf(
  el: ElementHandle,
  box: { x: number; y: number },
  viewport: { width: number; height: number } | null,
): Promise<{ x: number; y: number }[]> {
  const info = await el.evaluate(pageFragments).catch(() => undefined);
  if (!info) return [];
  const dx = box.x - info.left,
    dy = box.y - info.top,
    points: { x: number; y: number }[] = [];
  for (const [fl, ft, fr, fb] of info.fragments as [number, number, number, number][]) {
    const left = Math.max(0, fl + dx),
      top = Math.max(0, ft + dy),
      right = Math.min(viewport?.width ?? fr + dx, fr + dx),
      bottom = Math.min(viewport?.height ?? fb + dy, fb + dy);
    if (fr > fl && fb > ft && right > left && bottom > top)
      points.push({ x: pixelCentre(left, right), y: pixelCentre(top, bottom) });
  }
  return points;
}
export async function isolatedCollect<T>(
  el: ElementHandle,
  collect: (node: Element, args: any) => T,
  args: unknown,
  allowedFrameOrigins: readonly string[] = [],
  frameHint?: Frame,
  expectPoint?: { x: number; y: number },
): Promise<T> {
  const frame = frameHint ?? (await el.ownerFrame().catch(() => null));
  if (!frame) throw new AdlError('E_STALE_STATE');
  const page = frame.page();
  const permittedOrigins = new Set([
    new URL(page.url()).origin,
    ...allowedFrameOrigins.map(origin => new URL(origin).origin),
  ]);
  if (
    frame !== page.mainFrame() &&
    !frame.url().startsWith('about:') &&
    !permittedOrigins.has(new URL(frame.url()).origin)
  )
    throw new AdlError('E_POLICY_DENIED', 'iframe_action_proof_unavailable');
  const box = await el.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new AdlError('E_STALE_STATE');
  const viewport = page.viewportSize();
  // expectPoint is the exact point about to be clicked: the proof is made at that point and no other. Without it the proof accepts the
  // element when any ordinary click point of it resolves to it: the centre of its box, then the centre of each layout fragment.
  let points: { x: number; y: number }[];
  if (expectPoint) {
    if (!offsetPointOf(expectPoint, { x: 0, y: 0 }, viewport)) throw new AdlError('E_STALE_STATE');
    points = [expectPoint];
  } else {
    const centre = hitPointOf(box, viewport);
    points = [
      ...(centre ? [centre] : []),
      ...(await fragmentPointsOf(el, box, viewport)).filter(p => !centre || p.x !== centre.x || p.y !== centre.y),
    ];
  }
  if (points.length === 0) throw new AdlError('E_STALE_STATE');
  const cdp = await page.context().newCDPSession(page),
    objectGroup = 'adl-proof-' + randomUUID();
  type Host = { backend: number; frameId: string; path: PathStep[] };
  type Candidate = {
    backend: number;
    parent?: Candidate;
    path: PathStep[];
    frameId: string;
    hosts: Host[];
    unavailableFrame: boolean;
  };
  try {
    // Resolves the element under one viewport point to the candidate that is, or contains, the retained element.
    const locate = async (x: number, y: number): Promise<Candidate> => {
      // boundingBox() is viewport-relative; DOM.getNodeForLocation takes document
      // coordinates. A wrong offset only fails closed through the identity proof.
      const scroll = (await cdp.send('Page.getLayoutMetrics')).cssVisualViewport;
      const hit = await cdp.send('DOM.getNodeForLocation', {
        x: Math.floor(x + scroll.pageX),
        y: Math.floor(y + scroll.pageY),
        includeUserAgentShadowDOM: false,
        ignorePointerEventsNone: false,
      });
      const tree = await cdp.send('Page.getFrameTree');
      const frameInfo = new Map<string, typeof tree.frameTree.frame>();
      const framePending = [tree.frameTree];
      while (framePending.length) {
        const item = framePending.pop()!;
        frameInfo.set(item.frame.id, item.frame);
        framePending.push(...(item.childFrames ?? []));
      }
      const mainInfo = tree.frameTree.frame,
        hitInfo = frameInfo.get(hit.frameId);
      // Descendants require explicit exact-origin authorization and an in-process
      // CDP document. Opaque origins and OOPIFs fail closed.
      if (
        frame !== page.mainFrame() &&
        (!hitInfo ||
          mainInfo.securityOrigin !== new URL(page.url()).origin ||
          !permittedOrigins.has(hitInfo.securityOrigin))
      )
        throw new AdlError('E_POLICY_DENIED', 'iframe_action_proof_unavailable');
      const dom = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
      const pending: { node: typeof dom.root; parent?: Candidate; path: PathStep[]; frameId: string; hosts: Host[] }[] =
        [{ node: dom.root, path: [], frameId: mainInfo.id, hosts: [] }];
      let found: Candidate | undefined,
        visited = 0;
      while (pending.length) {
        const item = pending.pop()!;
        if (++visited > 10000) throw new AdlError('E_RESOURCE_LIMIT');
        if (item.node.shadowRootType === 'closed' || item.node.shadowRootType === 'user-agent') continue;
        const current: Candidate = {
          backend: item.node.backendNodeId,
          parent: item.parent,
          path: item.path,
          frameId: item.frameId,
          hosts: item.hosts,
          unavailableFrame: !!item.node.frameId && !item.node.contentDocument,
        };
        if (current.backend === hit.backendNodeId && item.frameId === hit.frameId) {
          found = current;
          break;
        }
        let index = 0;
        for (const child of item.node.children ?? []) {
          if (child.nodeType !== 1) continue;
          index++;
          pending.push({
            node: child,
            parent: current,
            frameId: item.frameId,
            hosts: item.hosts,
            path: item.node.nodeType === 11 ? [...item.path, 0, index] : [...item.path, index],
          });
        }
        for (const shadow of item.node.shadowRoots ?? [])
          pending.push({ node: shadow, parent: current, path: item.path, frameId: item.frameId, hosts: item.hosts });
        if (item.node.contentDocument && item.node.frameId) {
          const childInfo = frameInfo.get(item.node.frameId);
          if (childInfo && permittedOrigins.has(childInfo.securityOrigin))
            pending.push({
              node: item.node.contentDocument,
              path: [],
              frameId: item.node.frameId,
              hosts: [...item.hosts, { backend: current.backend, frameId: item.frameId, path: current.path }],
            });
        }
      }
      // A selector is meaningful only in its original frame. Prove every CDP
      // iframe owner is the exact Playwright owner before using frame.locator.
      const chain: (typeof frame)[] = [];
      for (let f: typeof frame | null = frame; f?.parentFrame(); f = f.parentFrame()) chain.unshift(f);
      let frameMatches = !!found && found.hosts.length === chain.length;
      if (frameMatches && found) {
        for (let i = 0; i < chain.length; i++) {
          const child = chain[i]!,
            host = found.hosts[i]!,
            parent = child.parentFrame();
          if (!parent) {
            frameMatches = false;
            break;
          }
          const actual = await child.frameElement(),
            candidate = await resolvePath(parent, host.path);
          try {
            if (!candidate || !(await actual.evaluate((node, other) => node === other, candidate)))
              frameMatches = false;
          } finally {
            await actual.dispose();
            await candidate?.dispose();
          }
          if (!frameMatches) break;
        }
      }
      let selected: Candidate | undefined;
      for (
        let candidate = frameMatches ? found : undefined, depth = 0;
        candidate?.path.length && depth++ < 128;
        candidate = candidate.parent
      ) {
        const other = await resolvePath(frame, candidate.path);
        if (!other) continue;
        try {
          if (await el.evaluate((node, otherNode) => node === otherNode, other)) {
            selected = candidate;
            break;
          }
        } finally {
          await other.dispose().catch(() => undefined);
        }
      }
      if (!selected) {
        if (!(await el.evaluate(node => node.isConnected))) throw new AdlError('E_STALE_STATE');
        // When the hit is the actual frame owner but CDP has no child document,
        // Chromium has not exposed an in-process identity proof (typically OOPIF).
        if (found?.unavailableFrame)
          for (const child of chain) {
            const parent = child.parentFrame();
            if (!parent) continue;
            const actual = await child.frameElement(),
              other = await resolvePath(parent, found.path);
            try {
              if (other && (await actual.evaluate((node, candidate) => node === candidate, other)))
                throw new AdlError('E_POLICY_DENIED', 'iframe_action_proof_unavailable');
            } finally {
              await actual.dispose();
              await other?.dispose();
            }
          }
        throw new AdlError('E_NOT_INTERACTABLE', 'occluded');
      }
      return selected;
    };
    // The first point that resolves to the element decides; when none does, the first point's refusal is the answer.
    let selected: Candidate | undefined, refusal: unknown;
    for (const point of points) {
      try {
        selected = await locate(point.x, point.y);
        break;
      } catch (error) {
        if (!(error instanceof AdlError) || error.code === 'E_RESOURCE_LIMIT') throw error;
        refusal ??= error;
      }
    }
    if (!selected) throw refusal;
    const contexts = new Map<string, number>();
    const isolatedWorld = async (frameId: string) => {
      let id = contexts.get(frameId);
      if (id === undefined) {
        id = (await cdp.send('Page.createIsolatedWorld', { frameId, worldName: 'adl-approval-proof' }))
          .executionContextId;
        contexts.set(frameId, id);
      }
      return id;
    };
    // Each iframe owner and its composed ancestors are checked in the parent's
    // isolated world, not through page-provided DOM getters.
    for (const host of selected.hosts) {
      const owner = await cdp.send('DOM.resolveNode', {
        backendNodeId: host.backend,
        objectGroup,
        executionContextId: await isolatedWorld(host.frameId),
      });
      if (!owner.object.objectId) throw new AdlError('E_PRIVACY_BLOCKED');
      const check = await cdp.send('Runtime.callFunctionOn', {
        objectId: owner.object.objectId,
        functionDeclaration: `function(rules){let n=this,depth=0;while(n&&depth++<rules.ancestorCap){if(n.matches(rules.regionSelector))return 'protected';n=n.parentElement??n.getRootNode().host??null;}if(n!==null||!this.isConnected)return 'protected';if(this.hasAttribute('sandbox')&&!this.sandbox.contains('allow-same-origin'))return 'opaque';return 'ok';}`,
        arguments: [{ value: BROWSER_PRIVACY_RULES }],
        returnByValue: true,
      });
      if (check.result.value === 'opaque') throw new AdlError('E_POLICY_DENIED', 'iframe_action_proof_unavailable');
      if (check.exceptionDetails || check.result.value !== 'ok') throw new AdlError('E_PRIVACY_BLOCKED');
    }
    const world = { executionContextId: await isolatedWorld(selected.frameId) };
    const object = await cdp.send('DOM.resolveNode', {
      backendNodeId: selected.backend,
      objectGroup,
      executionContextId: world.executionContextId,
    });
    if (!object.object.objectId) throw new AdlError('E_STALE_STATE');
    const response = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.object.objectId,
      functionDeclaration: `function(args){return (${collect.toString()})(this,args)}`,
      arguments: [{ value: args }],
      returnByValue: true,
    });
    if (response.exceptionDetails || !response.result.value) throw new AdlError('E_PRIVACY_BLOCKED');
    return response.result.value as T;
  } catch (error) {
    if (error instanceof AdlError) throw error;
    throw new AdlError('E_STALE_STATE');
  } finally {
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => undefined);
    await cdp.detach().catch(() => undefined);
  }
}
// The raw form values remain inside the adapter and are hashed before return. `point` pins the CDP hit-test identity proof to the exact
// viewport point about to be clicked; without it any ordinary click point of the element (box centre, then each fragment) may prove it.
export async function inspectBrowserAction(
  el: ElementHandle,
  action: Action,
  frameHint?: Frame,
  lists: LabelLists = { allow: [], deny: [] },
  point?: { x: number; y: number },
): Promise<ActionProof> {
  const collect = (node: Element, args: { rules: typeof BROWSER_PRIVACY_RULES; pattern: string; action: Action }) => {
    // Isolated-world prototypes are pristine, but form named properties (input
    // name="action") shadow instance APIs in every world. Reads on nodes that may
    // be forms therefore resolve through the prototype chain, never the instance.
    const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
      m = (o: object, k: string, ...a: unknown[]): any => Reflect.apply(r(o, k), o, a);
    const tagOf = (x: Node) => String(r(x, 'tagName')),
      attr = (x: Element, k: string) => m(x, 'getAttribute', k) as string | null,
      str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
    const e = node as HTMLElement,
      doc = r(e, 'ownerDocument') as Document;
    const fail = () => {
      throw new Error('unavailable');
    };
    if (r(e, 'isConnected') !== true) fail();
    const protectedNode = (element: Element) => {
      let n: Element | null = element,
        depth = 0;
      while (n && depth++ < args.rules.ancestorCap) {
        if (m(n, 'matches', args.rules.regionSelector)) return true;
        n = (r(n, 'parentElement') as Element | null) ?? (m(n, 'getRootNode') as ShadowRoot).host ?? null;
      }
      return n !== null;
    };
    if (protectedNode(e)) fail();
    // Option text never names its select: a choice list containing "Order" is not an order control.
    const text = (el: Element) => {
      let s = '',
        count = 0;
      const walker = m(doc, 'createTreeWalker', el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: (n: Node) =>
          r(n, 'nodeType') === 1 && /^(?:OPTION|OPTGROUP|DATALIST)$/.test(tagOf(n))
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
      }) as TreeWalker;
      let n: Node | null;
      while ((n = walker.nextNode())) {
        if (++count > 512) fail();
        if (r(n, 'nodeType') === 3) {
          const part = str(r(n, 'nodeValue'));
          if (s.length + part.length > 4096) fail();
          s += part;
        }
      }
      return s.trim();
    };
    const attrs = (el: Element) => {
      const entries = Array.from(r(el, 'attributes') as NamedNodeMap, a => [a.name, a.value]).sort((a, b) =>
        a[0]!.localeCompare(b[0]!),
      );
      if (entries.length > 128 || JSON.stringify(entries).length > 16384) fail();
      return entries;
    };
    const tag = tagOf(e).toLowerCase(),
      type = str(r(e, 'type')).toLowerCase();
    if (type === 'file') fail();
    const targetValue = str(r(e, 'value'));
    if (targetValue.length > 4096) fail();
    const labelList = Array.from((r(e, 'labels') as NodeListOf<HTMLLabelElement> | null | undefined) ?? []);
    if (labelList.length > 16) fail();
    const refs = (attr(e, 'aria-labelledby') ?? '').trim().split(/\s+/).filter(Boolean);
    if (refs.length > 16) fail();
    const root = m(e, 'getRootNode') as Document | ShadowRoot;
    const labels = [
      ...labelList,
      ...refs.map(id => m(root, 'getElementById', id) as Element | null).filter((x): x is HTMLElement => !!x),
    ];
    if (labels.some(protectedNode)) fail();
    const name = [attr(e, 'aria-label'), ...labels.map(text), attr(e, 'title'), attr(e, 'placeholder'), text(e)]
      .filter(Boolean)
      .join(' ')
      .slice(0, 4096);
    const normalize = (value: string) =>
      value
        .normalize('NFKC')
        .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Za-z])([0-9])/g, '$1 $2')
        .replace(/([0-9])([A-Za-z])/g, '$1 $2');
    const normalized = normalize(
      name + ' ' + (attr(e, 'id') ?? '') + ' ' + (attr(e, 'name') ?? '') + ' ' + (attr(e, 'autocomplete') ?? ''),
    );
    const credentialHints = ['input', 'textarea', 'select'].includes(tag) ? normalized : normalize(name);
    const secret = new RegExp(args.pattern, 'iu').test(credentialHints) || type === 'password';
    const form =
      (r(e, 'form') as HTMLFormElement | null | undefined) ??
      (m(e, 'closest', 'form') as HTMLFormElement | null) ??
      null;
    const formElements = form ? Array.from(r(form, 'elements') as HTMLFormControlsCollection) : [];
    if (formElements.length > 128) fail();
    const isSubmitter = (item: Element) => {
      const t = tagOf(item).toLowerCase(),
        ty = str(r(item, 'type')).toLowerCase();
      return t === 'button' ? !ty || ty === 'submit' : t === 'input' && (ty === 'submit' || ty === 'image');
    };
    const submit =
      !!form &&
      (type === 'submit' ||
        type === 'image' ||
        (tag === 'button' && (!type || type === 'submit')) ||
        (args.action.action === 'press' && args.action.value === 'Enter'));
    // Implicit submission (Enter) activates the form's default button; the submitter's own name/value is submitted.
    const defaultButton = formElements.find(isSubmitter);
    const submitter: Element | null = !submit
      ? null
      : isSubmitter(e)
        ? e
        : defaultButton && !m(defaultButton, 'matches', ':disabled')
          ? defaultButton
          : null;
    const formControls: unknown[] = [],
      formDetails: { name: string; value: string; secret: boolean }[] = [];
    let formCredential = false;
    // Consent details follow the successful-control rules of FormData: disabled,
    // unchecked, unnamed and non-submitter button controls are not submitted.
    for (const item of formElements) {
      if (!(item instanceof Element) || protectedNode(item)) fail();
      const fieldTag = tagOf(item).toLowerCase(),
        fieldType = str(r(item, 'type')).toLowerCase(),
        fieldName = str(r(item, 'name')),
        checked = r(item, 'checked') === true;
      const value = str(r(item, 'value'));
      if (value.length > 4096 || fieldName.length > 128) fail();
      const selected =
        fieldTag === 'select'
          ? (Array.from(r(item, 'selectedOptions') as HTMLCollection) as HTMLOptionElement[])
          : null;
      formControls.push([
        tagOf(item),
        attrs(item),
        value,
        checked,
        selected ? selected.map(o => [o.value, o.text]) : null,
      ]);
      const fieldHints = [
        fieldName,
        attr(item, 'id'),
        attr(item, 'aria-label'),
        attr(item, 'autocomplete'),
        ...Array.from((r(item, 'labels') as NodeListOf<HTMLLabelElement> | null | undefined) ?? []).map(text),
      ]
        .filter(Boolean)
        .join(' ');
      const credential = fieldType === 'password' || new RegExp(args.pattern, 'iu').test(normalize(fieldHints));
      formCredential ||= credential;
      const detail = (v: string) => {
        if (formDetails.length >= 24) {
          if (submit) fail();
          return;
        }
        formDetails.push({ name: fieldName, value: v, secret: fieldType === 'hidden' || credential });
      };
      if (!['input', 'select', 'textarea', 'button', 'fieldset', 'output', 'object'].includes(fieldTag)) {
        if (submit) fail();
        continue;
      }
      if (!fieldName || m(item, 'matches', ':disabled') || ['fieldset', 'output', 'object'].includes(fieldTag))
        continue;
      if (fieldTag === 'button' || ['submit', 'image', 'button', 'reset'].includes(fieldType)) {
        if (item === submitter && fieldType !== 'image') detail(value);
        continue;
      }
      if (fieldType === 'file') fail();
      if ((fieldType === 'checkbox' || fieldType === 'radio') && !checked) continue;
      if (selected) {
        for (const option of selected) {
          if (!option.disabled && !option.closest('optgroup:disabled')) detail(option.value);
        }
        continue;
      }
      detail(value);
    }
    let network: { url: string; method: string; body: string } | undefined;
    // Enter in a field is the default button's click (implicit submission): that button's own attributes and name/value shape the request.
    const owner: Element | null = args.action.action === 'press' ? submitter : e;
    if (
      submit &&
      str(owner && r(owner, 'type')).toLowerCase() !== 'image' &&
      form &&
      (args.action.action === 'click' || args.action.action === 'press') &&
      ((owner && attr(owner, 'formenctype')) || r(form, 'enctype')) === 'application/x-www-form-urlencoded'
    ) {
      const method = ((owner && attr(owner, 'formmethod')) || str(r(form, 'method')) || 'get').toUpperCase();
      const url = new URL((owner && attr(owner, 'formaction')) || str(r(form, 'action')), doc.location.href);
      if (method === 'POST' && url.origin === doc.location.origin && !url.username && !url.password) {
        const params = new URLSearchParams();
        const append = (key: string, value: string) =>
          params.append(key.replace(/\r?\n/g, '\r\n'), value.replace(/\r?\n/g, '\r\n'));
        for (const item of formElements) {
          if (!(item instanceof HTMLElement)) fail();
          const field = item as HTMLInputElement,
            fieldTag = tagOf(item).toLowerCase(),
            fieldType = (field.type || '').toLowerCase();
          if (!['input', 'select', 'textarea', 'button', 'fieldset', 'output'].includes(fieldTag)) fail();
          if (field.matches(':disabled') || !field.name || ['fieldset', 'output'].includes(fieldTag)) continue;
          if (fieldTag === 'button' || ['submit', 'image', 'button', 'reset'].includes(fieldType)) {
            if (item === owner) append(field.name, field.value);
            continue;
          }
          if (fieldType === 'file') fail();
          if ((fieldType === 'checkbox' || fieldType === 'radio') && !field.checked) continue;
          if (fieldTag === 'select') {
            for (const option of Array.from((field as unknown as HTMLSelectElement).selectedOptions)) {
              if (!option.disabled && !option.closest('optgroup:disabled')) append(field.name, option.value);
            }
            continue;
          }
          append(field.name, field.value);
        }
        network = { url: url.href, method, body: params.toString() };
      }
    }
    const method =
      submit && form ? ((owner && attr(owner, 'formmethod')) || str(r(form, 'method')) || 'get').toUpperCase() : '';
    const humanName = normalize(name),
      submitterName =
        submitter && submitter !== e
          ? normalize(
              [attr(submitter, 'aria-label'), attr(submitter, 'title'), str(r(submitter, 'value')), text(submitter)]
                .filter(Boolean)
                .join(' ')
                .slice(0, 4096),
            )
          : '';
    const searchForm =
      !!form &&
      (attr(form, 'role') === 'search' ||
        type === 'search' ||
        /\bsearch\b|検索/iu.test(normalize(name)) ||
        formElements.some(
          item =>
            item instanceof HTMLInputElement && (item.type === 'search' || /^(?:q|query|search)$/i.test(item.name)),
        ));
    // Label risk is decided in Node by classifyLabel from these facts; only the form-submission and credential parts stay here.
    const submitRisk = submit && (method !== 'GET' || !searchForm);
    const role =
      attr(e, 'role') ||
      (tag === 'input'
        ? 'textbox'
        : tag === 'button'
          ? 'button'
          : tag === 'a'
            ? 'link'
            : tag === 'select'
              ? 'combobox'
              : 'generic');
    const details =
      submit && form
        ? {
            method: ((owner && attr(owner, 'formmethod')) || str(r(form, 'method')) || 'get').toUpperCase(),
            url: new URL((owner && attr(owner, 'formaction')) || str(r(form, 'action')), doc.location.href).href,
            fields: formDetails,
          }
        : undefined;
    // Navigation facts of a link, resolved like a click would (document base URL included) and bounded.
    let link: ActionFacts['link'] = null;
    if ((tag === 'a' || tag === 'area') && attr(e, 'href') !== null) {
      try {
        const resolved = r(e, 'href');
        if (typeof resolved !== 'string' || resolved.length > 8192) throw new Error('href');
        const u = new URL(resolved);
        const segments = u.pathname
          .split('/')
          .filter(Boolean)
          .map(part => {
            try {
              part = decodeURIComponent(part);
            } catch {
              /* keep the raw segment */
            }
            return part
              .toLowerCase()
              .replace(/\.[a-z0-9]{1,8}$/, '')
              .slice(0, 64);
          });
        link = {
          protocol: u.protocol,
          sameOrigin: u.origin === doc.location.origin,
          download: m(e, 'hasAttribute', 'download') === true,
          // A long path keeps both ends: an action word cannot hide behind padding segments.
          segments: segments.length > 32 ? [...segments.slice(0, 16), ...segments.slice(-16)] : segments,
          actionValues: [...u.searchParams]
            .filter(([key]) => /^(?:action|act|cmd|op|do|_method|method|task)$/i.test(key))
            .slice(0, 8)
            .map(([, value]) => value.toLowerCase().slice(0, 64)),
        };
      } catch {
        link = { protocol: 'invalid', sameOrigin: false, download: false, segments: [], actionValues: [] };
      }
    }
    // The accessible name of the enclosing dialog, if any: an affirmative button inherits its verdict.
    let dialog: ActionFacts['dialog'] = null;
    for (
      let n: Element | null =
          (r(e, 'parentElement') as Element | null) ?? (m(e, 'getRootNode') as ShadowRoot).host ?? null,
        depth = 0;
      n && depth++ < args.rules.ancestorCap;
      n = (r(n, 'parentElement') as Element | null) ?? (m(n, 'getRootNode') as ShadowRoot).host ?? null
    ) {
      if (!m(n, 'matches', 'dialog,[role="dialog" i],[role="alertdialog" i]')) continue;
      const dialogRoot = m(n, 'getRootNode') as Document | ShadowRoot;
      const ids = (attr(n, 'aria-labelledby') ?? '').trim().split(/\s+/).filter(Boolean);
      if (ids.length > 16) fail();
      const named = ids
        .map(id => m(dialogRoot, 'getElementById', id) as Element | null)
        .filter((x): x is Element => !!x);
      const heading = m(n, 'querySelector', 'h1,h2,h3,h4,h5,h6,[role="heading"]') as Element | null;
      if ([...named, ...(heading ? [heading] : [])].some(protectedNode)) fail();
      dialog = {
        name: normalize(
          (attr(n, 'aria-label') || named.map(text).filter(Boolean).join(' ') || (heading ? text(heading) : '')).slice(
            0,
            512,
          ),
        ),
      };
      break;
    }
    const facts: ActionFacts = {
      tag,
      type,
      role,
      name: humanName,
      submitterName,
      submit,
      method,
      searchForm,
      inForm: !!form,
      link,
      dialog,
    };
    return {
      credential: secret || (submit && formCredential),
      submitRisk,
      facts,
      role,
      name,
      origin: doc.location.origin,
      network,
      details,
      proof: JSON.stringify([
        doc.location.href,
        tag,
        type,
        attrs(e),
        name,
        targetValue,
        r(e, 'checked') === true,
        form ? [str(r(form, 'action')), str(r(form, 'method')), attrs(form), formControls] : null,
        link,
        dialog,
      ]),
    };
  };
  const data = await isolatedCollect(
    el,
    collect,
    { rules: BROWSER_PRIVACY_RULES, pattern: SECRET_LABEL_PATTERN, action },
    [],
    frameHint,
    point,
  );
  if (data.proof.length > 1048576) throw new AdlError('E_RESOURCE_LIMIT');
  const details = data.details ? describeApprovalForm(data.details) : undefined;
  // Label risk comes from the shared classifier; a real submission, credentials and every other
  // protection above never consult the allow list.
  const verdict = classifyLabel(data.facts, action, lists);
  const labelRisk = verdict.consequential;
  const risk: ActionRisk = data.credential ? 'credential' : data.submitRisk || labelRisk ? 'consequential' : 'ordinary';
  return {
    proof: createHash('sha256').update(data.proof).digest('hex'),
    risk,
    role: data.role,
    name: data.name,
    origin: data.origin,
    ...(details ? { details } : {}),
    ...(data.network ? { network: data.network } : {}),
    // A submit that is consequential only because it submits may be dispatched under the adapter's
    // submission guard; labelled, credential or secret submits never are.
    ...(risk === 'consequential' && data.submitRisk && !labelRisk ? { submission: 'plain' as const } : {}),
    ...(risk === 'consequential' && !data.submitRisk && isContainable(data.facts, action, verdict)
      ? { contained: true }
      : {}),
    classification: verdict.reason,
  };
}
