/** Self-contained for serialization into an isolated browser realm. Never reads a field's value. */
export function personalContextPageFn(element: Element, pattern: string, cache?: WeakMap<Element, boolean>): boolean {
  const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
    m = (o: object, k: string, ...a: unknown[]): any => Reflect.apply(r(o, k), o, a);
  const matches = new RegExp(pattern, 'iu');
  const label = (node: Element | null): boolean => {
    if (!node) return false;
    const text = String(r(node, 'textContent') ?? '');
    return text.length <= 256 && matches.test(text.normalize('NFKC').trim());
  };
  const cell = m(element, 'closest', 'td,dd,[role="cell"],[role="gridcell"]') as Element | null;
  if (!cell) return false;
  const cached = cache?.get(cell);
  if (cached !== undefined) return cached;
  const remember = (value: boolean) => {
    cache?.set(cell, value);
    return value;
  };
  if (String(r(cell, 'tagName')).toLowerCase() === 'dd') {
    let prior = r(cell, 'previousElementSibling') as Element | null;
    for (let count = 0; prior && count < 64; count++, prior = r(prior, 'previousElementSibling')) {
      if (String(r(prior, 'tagName')).toLowerCase() === 'dt') return remember(label(prior));
      if (String(r(prior, 'tagName')).toLowerCase() !== 'dd') break;
    }
    return remember(false);
  }
  const headers = String(m(cell, 'getAttribute', 'headers') ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (headers.length > 32) return remember(true);
  const root = m(cell, 'getRootNode');
  if (headers.some(id => label(m(root, 'getElementById', id)))) return remember(true);
  const row = m(cell, 'closest', 'tr,[role="row"]') as Element | null;
  const table = m(cell, 'closest', 'table,[role="table"],[role="grid"]') as Element | null;
  if (!row || !table) return remember(false);
  const cells = (item: Element): Element[] =>
    Array.from(
      m(
        item,
        'querySelectorAll',
        ':scope > th,:scope > td,:scope > [role="cell"],:scope > [role="gridcell"],:scope > [role="columnheader"],:scope > [role="rowheader"]',
      ),
    );
  const own = cells(row);
  if (own.length > 256) return remember(true);
  const index = own.indexOf(cell);
  if (index < 0) return remember(false);
  // A preceding row heading or key/value cell names the value, without hiding the heading itself.
  if (own.slice(0, index).some(label)) return remember(true);
  const rows = r(table, 'rows') as HTMLCollectionOf<HTMLTableRowElement> | undefined;
  const candidates = rows ?? m(table, 'querySelectorAll', '[role="row"]');
  for (let i = 0; i < Math.min(candidates.length, 32); i++) {
    const candidate = candidates[i] as Element;
    if (candidate === row) break;
    const preceding = cells(candidate);
    if (preceding.length > 256) return remember(true);
    const header = preceding[index];
    if (
      header &&
      (String(r(header, 'tagName')).toLowerCase() === 'th' || m(header, 'getAttribute', 'role') === 'columnheader') &&
      m(header, 'getAttribute', 'scope') !== 'row' &&
      label(header)
    )
      return remember(true);
  }
  return remember(false);
}

/** Embed only our own function sources; page content is always passed as a serialized argument. */
export function withPersonalContext<R, A, T>(
  fn: (root: R, arg: A, context: typeof personalContextPageFn) => T,
): (root: R, arg: A) => T {
  return new Function(
    `return function(root,arg){return (${fn.toString()})(root,arg,(${personalContextPageFn.toString()}));}`,
  )() as (root: R, arg: A) => T;
}
