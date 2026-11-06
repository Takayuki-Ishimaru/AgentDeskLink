import { BROWSER_PRIVACY_RULES } from './privacy.js';
import { withPersonalContext, personalContextPageFn } from './personal-context.js';

export type PageTextResult =
  { error: 'missing' | 'protected' } | { text: string; truncated: boolean; hidden?: boolean };

function readTextPage(
  root: Element,
  arg: { rules: typeof BROWSER_PRIVACY_RULES; pattern: string; allowPersonalData?: boolean },
  personalContext: typeof personalContextPageFn,
): PageTextResult {
  const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
    m = (o: object, k: string, ...a: unknown[]): any => Reflect.apply(r(o, k), o, a);
  if (r(root, 'isConnected') !== true) return { error: 'missing' as const };
  const personalContexts = new WeakMap<Element, boolean>();
  const protectedNode = (element: Element) => {
    let n: Element | null = element,
      depth = 0;
    while (n && depth++ < arg.rules.ancestorCap) {
      if (m(n, 'matches', arg.rules.regionSelector)) return true;
      n = (r(n, 'parentElement') as Element | null) ?? (m(n, 'getRootNode') as ShadowRoot).host ?? null;
    }
    return n !== null;
  };
  if (protectedNode(root)) return { error: 'protected' as const };
  const secret = new RegExp(arg.pattern, 'iu');
  const skip = (e: Element) => {
    if (
      m(e, 'matches', 'script,style,input,textarea,select,option,optgroup') ||
      m(e, 'matches', arg.rules.regionSelector)
    )
      return true;
    if (e instanceof HTMLLabelElement) {
      const field = e.control;
      if (field) {
        const hints = [
          field.id,
          field.getAttribute('name'),
          field.getAttribute('autocomplete'),
          field.getAttribute('aria-label'),
        ]
          .filter(Boolean)
          .join(' ');
        if (protectedNode(field) || (field as HTMLInputElement).type === 'password' || secret.test(hints)) return true;
      }
    }
    return false;
  };
  for (
    let ancestor: Element | null = root, depth = 0;
    ancestor && depth++ < arg.rules.ancestorCap;
    ancestor =
      (r(ancestor, 'parentElement') as Element | null) ?? (m(ancestor, 'getRootNode') as ShadowRoot).host ?? null
  )
    if (skip(ancestor)) return { text: '', truncated: false };
  const displayNone = (e: Element) => {
    try {
      return getComputedStyle(e).display === 'none';
    } catch {
      return false;
    }
  };
  const walker = m(r(root, 'ownerDocument'), 'createTreeWalker', root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n: Node) =>
      r(n, 'nodeType') === 1 && (skip(n as Element) || displayNone(n as Element))
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  }) as TreeWalker;
  // Direct reads also omit concealed prose at the root and its ancestors.
  const alphaOf = (color: string): number => {
    const match =
      /^rgba\(\s*[^,]+,[^,]+,[^,]+,\s*([\d.]+)(%?)\s*\)$/.exec(color) ?? /\/\s*([\d.]+)(%?)\s*\)$/.exec(color);
    if (!match) return 1;
    const value = parseFloat(match[1]!);
    return match[2] ? value / 100 : value;
  };
  const looksHidden = (e: Element, withAncestors: boolean): boolean => {
    try {
      const style = getComputedStyle(e);
      if (parseFloat(style.fontSize) <= 2 || parseFloat(style.opacity) < 0.05 || alphaOf(style.color) <= 0.05)
        return true;
      if (withAncestors && !m(e, 'checkVisibility', { opacityProperty: true })) return true;
      if (
        parseFloat(style.textIndent) <= -999 ||
        /^rect\(\s*0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?[\s,]+0(?:px)?\s*\)$/.test(style.clip) ||
        /^inset\(\s*(?:50|100)%/.test(style.clipPath)
      )
        return true;
      const box = m(e, 'getBoundingClientRect') as DOMRect;
      if (box.bottom + scrollY < -20) return true;
      if (style.direction === 'ltr' && (box.right + scrollX < -20 || box.left + scrollX > innerWidth + 10000))
        return true;
      return (box.width <= 1 || box.height <= 1) && (style.overflowX !== 'visible' || style.overflowY !== 'visible');
    } catch {
      return false;
    }
  };
  for (
    let up: Element | null = root, depth = 0;
    up && depth++ < arg.rules.ancestorCap;
    up = (r(up, 'parentElement') as Element | null) ?? (m(up, 'getRootNode') as ShadowRoot).host ?? null
  )
    if (looksHidden(up, true)) return { text: '', truncated: false, hidden: true };
  const hiddenCache = new Map<Element, boolean>();
  const hiddenBelowRoot = (e: Element | null, depth = 0): boolean => {
    if (!e || e === root || depth > 256) return false;
    let value = hiddenCache.get(e);
    if (value === undefined) {
      value = looksHidden(e, false) || hiddenBelowRoot(r(e, 'parentElement') as Element | null, depth + 1);
      hiddenCache.set(e, value);
    }
    return value;
  };
  // Paragraph structure: text is joined per block. A block change gives a new line, or a blank line around paragraphs, headings,
  // lists and tables; cells of one row are joined with " | "; <br> is a new line; whitespace collapses unless the element preserves it.
  const BLOCKS = new Set(
    'DIV P TR UL OL TABLE THEAD TBODY TFOOT SECTION ARTICLE ASIDE HEADER FOOTER NAV MAIN H1 H2 H3 H4 H5 H6 BLOCKQUOTE PRE FIGURE FIGCAPTION FORM FIELDSET LEGEND DL HR ADDRESS DETAILS SUMMARY CAPTION LI DT DD TD TH DIALOG HGROUP MENU'.split(
      ' ',
    ),
  );
  const PARAGRAPHS = new Set(
    'P H1 H2 H3 H4 H5 H6 BLOCKQUOTE PRE FIGURE UL OL DL TABLE ARTICLE SECTION ASIDE MAIN HEADER FOOTER NAV FORM FIELDSET DETAILS ADDRESS HR'.split(
      ' ',
    ),
  );
  const tagOf = (e: Element) => String(r(e, 'tagName'));
  const blocks = new Map<Element, Element>();
  const blockOf = (owner: Element): Element => {
    let found = blocks.get(owner);
    if (found) return found;
    found = root;
    for (
      let up: Element | null = owner, climbed = 0;
      up && up !== root && climbed < 64;
      climbed++, up = r(up, 'parentElement') as Element | null
    )
      if (BLOCKS.has(tagOf(up))) {
        found = up;
        break;
      }
    blocks.set(owner, found);
    return found;
  };
  // The list or table an item or cell belongs to: moving between two of them is one line, leaving it is a paragraph break.
  const groups = new Map<Element, Element>();
  const groupOf = (block: Element): Element => {
    let found = groups.get(block);
    if (!found) {
      const tag = tagOf(block);
      found =
        tag === 'LI' || tag === 'DT' || tag === 'DD'
          ? ((m(block, 'closest', 'ul,ol,dl,menu') as Element | null) ?? block)
          : tag === 'TD' || tag === 'TH'
            ? ((m(block, 'closest', 'table') as Element | null) ?? block)
            : block;
      groups.set(block, found);
    }
    return found;
  };
  const preserved = new Map<Element, boolean>();
  const preserves = (owner: Element): boolean => {
    let value = preserved.get(owner);
    if (value === undefined) {
      try {
        value = /^(pre|break-spaces)/.test(getComputedStyle(owner).whiteSpace);
      } catch {
        value = false;
      }
      preserved.set(owner, value);
    }
    return value;
  };
  const LIMIT = 1048576;
  let text = '',
    visited = 0,
    truncated = false,
    hidden = false,
    last: Element | null = null;
  for (let node: Node | null = walker.nextNode(); node; node = walker.nextNode()) {
    if (++visited > 100000) {
      truncated = true;
      break;
    }
    if (r(node, 'nodeType') === 1) {
      if (tagOf(node as Element) === 'BR') text = text.replace(/ +$/, '') + '\n';
      continue;
    }
    const owner = r(node, 'parentElement') as Element | null;
    // Text that is not rendered (display:none, visibility:hidden, a closed details element) is not read.
    if (!owner || !m(owner, 'checkVisibility', { visibilityProperty: true })) continue;
    if (hiddenBelowRoot(owner)) {
      hidden = true;
      continue;
    }
    const keep = preserves(owner),
      raw = String(r(node, 'nodeValue') ?? '');
    let piece =
      !arg.allowPersonalData &&
      personalContext(owner, arg.rules.personalContextLabelPattern, personalContexts) &&
      raw.trim()
        ? '[redacted]'
        : keep
          ? raw.replace(/\r\n?/g, '\n')
          : raw.replace(/[ \t\n\r\f]+/g, ' ');
    const block = blockOf(owner);
    if (!keep && piece === ' ') {
      if (text !== '' && block === last && !/[ \n]$/.test(text)) text += ' ';
      continue;
    }
    if (piece === '') continue;
    if (last !== null && block !== last) {
      const before = tagOf(last),
        after = tagOf(block);
      text = text.replace(/ +$/, '');
      if (
        (before === 'TD' || before === 'TH') &&
        (after === 'TD' || after === 'TH') &&
        r(last, 'parentElement') === r(block, 'parentElement')
      )
        text += ' | ';
      else {
        const from = groupOf(last),
          to = groupOf(block),
          blank =
            PARAGRAPHS.has(before) ||
            PARAGRAPHS.has(after) ||
            (from !== to && (PARAGRAPHS.has(tagOf(from)) || PARAGRAPHS.has(tagOf(to))));
        text += '\n'.repeat(Math.max(0, (blank ? 2 : 1) - /\n*$/.exec(text)![0].length));
      }
    }
    if (!keep && (text === '' || /[ \n]$/.test(text))) piece = piece.replace(/^ /, '');
    if (piece === '') continue;
    last = block;
    if (text.length + piece.length > LIMIT) {
      text += piece.slice(0, LIMIT - text.length);
      truncated = true;
      break;
    }
    text += piece;
  }
  text = text.trim();
  // Never return the prefix of a token cut at the source cap.
  if (truncated) text = text.replace(/[A-Za-z0-9._%+@-]+$/u, '');
  return { text, truncated, ...(hidden ? { hidden: true } : {}) };
}

export const readTextPageFn = withPersonalContext(readTextPage);
