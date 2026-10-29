import { selectors } from 'playwright';
import { BROWSER_PRIVACY_RULES } from './privacy.js';

// This engine lives in Playwright's isolated content-script world. Page
// prototypes cannot alter the captured node identities, geometry or privacy walk.
function pointEngine() {
  let current:
    | { nonce: string; viewport: string; nodes: Map<Element, { x: number; y: number; width: number; height: number }> }
    | undefined;
  const viewport = () => JSON.stringify([innerWidth, innerHeight, scrollX, scrollY, devicePixelRatio]);
  // Form named properties (input name="matches") shadow instance APIs in this
  // world too; reads on arbitrary elements resolve through the prototype chain.
  const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
    m = (o: object, k: string, ...a: unknown[]): any => Reflect.apply(r(o, k), o, a);
  const box = (e: Element) => {
    const rect = m(e, 'getBoundingClientRect') as DOMRect;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const same = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  const queryAll = (root: Document | Element, source: string): Element[] => {
    const a = JSON.parse(source) as {
      op: 'capture' | 'validate' | 'point';
      nonce: string;
      x?: number;
      y?: number;
      rules: typeof BROWSER_PRIVACY_RULES;
    };
    const doc = root.ownerDocument ?? (root as Document);
    if (a.op === 'capture') {
      current = undefined;
      const nodes = new Map<Element, ReturnType<typeof box>>(),
        pending: Element[] = [doc.documentElement];
      let visited = 0;
      while (pending.length) {
        const e = pending.pop()!;
        if (++visited > 20000 || nodes.size >= 5000) return [];
        const rect = box(e);
        if (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.x < innerWidth &&
          rect.y < innerHeight &&
          rect.x + rect.width > 0 &&
          rect.y + rect.height > 0 &&
          m(e, 'checkVisibility', { visibilityProperty: true })
        )
          nodes.set(e, rect);
        pending.push(...Array.from(r(e, 'children') as HTMLCollection));
        const shadow = r(e, 'shadowRoot') as ShadowRoot | null;
        if (shadow) pending.push(...Array.from(shadow.children));
      }
      current = { nonce: a.nonce, viewport: viewport(), nodes };
      return [doc.documentElement];
    }
    if (!current || current.nonce !== a.nonce || current.viewport !== viewport()) return [];
    if (a.op === 'validate') {
      for (const [node, rect] of current.nodes)
        if (r(node, 'isConnected') !== true || !same(rect, box(node))) return [];
      return [doc.documentElement];
    }
    if (
      !Number.isFinite(a.x) ||
      !Number.isFinite(a.y) ||
      a.x! < 0 ||
      a.y! < 0 ||
      a.x! >= innerWidth ||
      a.y! >= innerHeight
    )
      return [];
    let e = doc.elementFromPoint(a.x!, a.y!);
    let depth = 0;
    while (e && (r(e, 'shadowRoot') as ShadowRoot | null) && depth++ < 32) {
      const inside = (r(e, 'shadowRoot') as ShadowRoot).elementFromPoint(a.x!, a.y!);
      if (!inside || inside === e) break;
      e = inside;
    }
    if (!e || /^(iframe|frame)$/i.test(String(r(e, 'tagName')))) return [];
    const captured = current.nodes.get(e);
    if (!captured || !same(captured, box(e))) return [];
    let ancestor: Element | null = e,
      target: Element | undefined;
    depth = 0;
    while (ancestor && depth++ < a.rules.ancestorCap) {
      if (
        m(ancestor, 'matches', a.rules.regionSelector) ||
        m(ancestor, 'getAttribute', 'aria-disabled') === 'true' ||
        m(ancestor, 'matches', ':disabled')
      )
        return [];
      if (
        !target &&
        m(ancestor, 'matches', 'a[href],button,input,select,textarea,[role="button"],[role="link"],[onclick]')
      )
        target = ancestor;
      ancestor =
        (r(ancestor, 'parentElement') as Element | null) ?? (m(ancestor, 'getRootNode') as ShadowRoot).host ?? null;
    }
    if (ancestor) return [];
    target ??= e;
    const targetBox = current.nodes.get(target);
    if (!targetBox || !same(targetBox, box(target))) return [];
    return [target];
  };
  return { queryAll, query: (root: Document | Element, source: string) => queryAll(root, source)[0] ?? null };
}
let registration: Promise<void> | undefined;
export function ensurePointSelector() {
  return (registration ??= selectors.register('adlpoint', pointEngine, { contentScript: true }));
}
export function pointSelector(op: 'capture' | 'validate' | 'point', nonce: string, x?: number, y?: number) {
  return 'adlpoint=' + JSON.stringify({ op, nonce, x, y, rules: BROWSER_PRIVACY_RULES });
}
