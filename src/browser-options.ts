import { BROWSER_PRIVACY_RULES } from './privacy.js';
import { personalContextPageFn, withPersonalContext } from './personal-context.js';
import type { Element as ElementInfo } from './types.js';

export interface OptionsResult {
  options: NonNullable<ElementInfo['options']>;
  total: number;
  matched: number;
  next_offset: number | null;
  source_limited?: true;
}
export interface OptionsPageArgs {
  query: string;
  offset: number;
  limit: number;
  allowPersonalData: boolean;
  secretPattern: string;
  personalPattern: string;
  rules: typeof BROWSER_PRIVACY_RULES;
  textRules: ReadonlyArray<readonly [string, string]>;
  personalRules: ReadonlyArray<readonly [string, string]>;
}

function optionsPage(
  root: Element,
  arg: OptionsPageArgs,
  personalContext: typeof personalContextPageFn,
): OptionsResult | { error: 'missing' | 'protected' | 'unsupported' | 'limit' } {
  const r = (o: object, k: string): any => Reflect.get(Object.getPrototypeOf(o), k, o),
    m = (o: object, k: string, ...a: unknown[]): any => Reflect.apply(r(o, k), o, a);
  if (!r(root, 'isConnected')) return { error: 'missing' };
  if (String(r(root, 'tagName')).toLowerCase() !== 'select') return { error: 'unsupported' };
  const protectedNode = (element: Element): boolean => {
    let node: Element | null = element;
    for (let depth = 0; node && depth < arg.rules.ancestorCap; depth++) {
      if (m(node, 'matches', arg.rules.regionSelector)) return true;
      node = r(node, 'parentElement') ?? (m(node, 'getRootNode') as ShadowRoot).host ?? null;
    }
    return node !== null;
  };
  if (protectedNode(root)) return { error: 'protected' };
  const attr = (key: string) => String(m(root, 'getAttribute', key) ?? '');
  const hints = ['aria-label', 'autocomplete', 'title', 'name', 'id'].map(attr);
  const references = attr('aria-labelledby').trim().split(/\s+/).filter(Boolean);
  if (references.length > 16) return { error: 'limit' };
  for (const id of references) {
    const label = m(m(root, 'getRootNode'), 'getElementById', id);
    if (label) hints.push(String(r(label, 'textContent') ?? ''));
  }
  const labels = r(root, 'labels') as NodeListOf<HTMLLabelElement> | undefined;
  if ((labels?.length ?? 0) > 16) return { error: 'limit' };
  for (const label of Array.from(labels ?? [])) {
    const walker = m(
      r(root, 'ownerDocument'),
      'createTreeWalker',
      label,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node: Node) =>
          r(node, 'nodeType') === 1 && m(node, 'matches', arg.rules.textSkipSelector)
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT,
      },
    ) as TreeWalker;
    let text = '',
      visits = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (++visits > 128) return { error: 'limit' };
      if (r(node, 'nodeType') === 3) text += String(r(node, 'textContent') ?? '');
    }
    hints.push(text);
  }
  if (hints.some(h => h.length > 4096)) return { error: 'limit' };
  const secret = new RegExp(arg.secretPattern, 'iu'),
    personal = new RegExp(arg.personalPattern, 'iu');
  const hidden =
    hints.some(h => secret.test(h.normalize('NFKC'))) ||
    (!arg.allowPersonalData &&
      (hints.some(h => personal.test(h.normalize('NFKC'))) ||
        personalContext(root, arg.rules.personalContextLabelPattern)));
  const redact = (text: string): string => {
    for (const [source, replacement] of [...arg.textRules, ...(arg.allowPersonalData ? [] : arg.personalRules)])
      text = text.replace(new RegExp(source, 'gi'), replacement);
    return text.slice(0, 512);
  };
  const entries = r(root, 'options') as HTMLOptionsCollection;
  const options: OptionsResult['options'] = [];
  let matched = 0;
  const query = arg.query.toLowerCase();
  for (let i = 0; i < Math.min(entries.length, 10000); i++) {
    const option = entries[i]!,
      label = String(r(option, 'label')),
      value = String(r(option, 'value'));
    if (label.length > 4096 || value.length > 4096) return { error: 'limit' };
    const hide = hidden || protectedNode(option) || secret.test(label.normalize('NFKC'));
    const safe = {
      label: hide ? '[redacted]' : redact(label),
      value: hide ? '[redacted]' : redact(value),
      disabled: r(option, 'disabled') === true || m(option, 'matches', 'optgroup:disabled option'),
      selected: r(option, 'selected') === true,
    };
    // Search exclusively the visible, masked output. Secret values cannot be probed by query.
    if (query && !safe.label.toLowerCase().includes(query) && !safe.value.toLowerCase().includes(query)) continue;
    if (matched >= arg.offset && options.length < arg.limit) options.push(safe);
    matched++;
  }
  return {
    options,
    total: entries.length,
    matched,
    next_offset: arg.offset + options.length < matched ? arg.offset + options.length : null,
    ...(entries.length > 10000 ? { source_limited: true as const } : {}),
  };
}

export const readOptionsPageFn = withPersonalContext(optionsPage);
