import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { isIP } from 'node:net';
import { z } from 'zod';
import { AdlError, type Action, type ActionName, type Element, type PolicyConfig } from './types.js';
import {
  isSensitiveLabel,
  TEXT_REDACTION_RULES,
  PERSONAL_DATA_REDACTION_RULES,
  BROWSER_PRIVACY_RULES,
} from './privacy.js';

const MAX_BATCH_STEPS = 20;
const MAX_TEXT = 512;
const REDACTED = '[redacted]';
const SUPPORTED_ACTIONS: ActionName[] = [
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
];
const CONSEQUENTIAL =
  /\b(?:delete|remove(?!\s+filters?\b)|upload|send|submit|purchase|checkout|pay|payment|login|log\s*in|sign\s*in|sign\s*up|register|withdraw|transfer)\b|削除|購入|注文|決済|支払|送信|申込|申し込|登録|解約|振込|送金|確定|ログイン/iu;
// The native helpers' own vocabulary (Linux CONSEQUENTIAL, Windows IsConsequentialText, macOS consequentialLabels): the browser terms plus confirm/cancel/order.
const NATIVE_CONSEQUENTIAL =
  /\b(?:delete|remove(?!\s+filters?\b)|upload|send|submit|purchase|checkout|pay|payment|login|log\s*in|sign\s*in|sign\s*up|register|withdraw|transfer|confirm|cancel|order)\b|削除|購入|注文|支払|決済|送信|登録|取消|取り消|キャンセル|振込|送金|転送|申込|申し込|解約|確定|ログイン/iu;

const origin = z
  .string()
  .refine(
    isExactOrigin,
    'allowedOrigins entries must be exact http(s) origins without path, query, fragment or credentials',
  );
const targetUrl = z.string().refine(isHttpUrl, 'browserTargets url must be a full http(s) URL');
const classification = z.enum(['PUBLIC', 'INTERNAL', 'SECRET', 'UNKNOWN']);
const actionName = z.enum([
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
]);

const absolutePath = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    v => (v.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(v) || /^\\\\[^\\]+\\[^\\]+/.test(v)) && !v.includes('\0'),
    'path must be absolute',
  );
const interactiveConfig = z
  .object({
    enabled: z.boolean(),
    surfaces: z
      .array(
        z
          .object({
            id: z
              .string()
              .min(1)
              .max(64)
              .refine(v => Buffer.byteLength(v) <= 64),
            region: z
              .object({
                x: z.number().int().min(0).max(4095),
                y: z.number().int().min(0).max(4095),
                width: z.number().int().min(1).max(4096),
                height: z.number().int().min(1).max(4096),
              })
              .strict(),
            kinds: z
              .array(z.enum(['drag', 'swipe']))
              .min(1)
              .max(2),
            swipe_backend: z.enum(['scroll', 'touch']).optional(),
          })
          .strict(),
      )
      .max(16),
  })
  .strict()
  .refine(
    v =>
      Buffer.byteLength(JSON.stringify(v)) <= 8000 &&
      new Set(v.surfaces.map(s => s.id)).size === v.surfaces.length &&
      v.surfaces.every(
        s =>
          s.region.x + s.region.width <= 4096 &&
          s.region.y + s.region.height <= 4096 &&
          new Set(s.kinds).size === s.kinds.length,
      ),
  );
const desktopConfig = z
  .object({
    allowAllOperations: z.boolean().optional(),
    restrictTargets: z.boolean().optional(),
    helperPath: absolutePath,
    appId: z.string().min(1).max(128),
    appPath: absolutePath,
    controlsPath: absolutePath.optional(),
    classification: z.enum(['PUBLIC', 'INTERNAL']),
    visual: z
      .object({
        enabled: z.boolean(),
        allowUnredacted: z.boolean().default(false),
        maskRegions: z
          .array(
            z
              .object({
                x: z.number().int().min(0).max(4096),
                y: z.number().int().min(0).max(4096),
                width: z.number().int().min(1).max(4096),
                height: z.number().int().min(1).max(4096),
              })
              .strict(),
          )
          .max(64)
          .default([]),
      })
      .strict()
      .optional(),
    interactive: interactiveConfig.optional(),
    lifecycle: z.object({ enabled: z.boolean() }).strict().optional(),
  })
  .strict();

const policySchema = z
  .object({
    allowAllOperations: z.boolean().optional(),
    restrictTargets: z.boolean().optional(),
    browserHeadless: z.boolean().default(true),
    browserProxyServer: z
      .string()
      .max(2048)
      .refine(v => v === '' || (!/[?#]/.test(v) && isExactOrigin(v)))
      .default(''),
    browserProxyConnectByHostname: z.boolean().default(false),
    operationMode: z.enum(['read_only', 'standard', 'ask']).optional(),
    allowedOrigins: z.array(origin).max(64).default([]),
    resourceOrigins: z.array(origin).max(64).default([]),
    allowPersonalData: z.boolean().default(false),
    browserTargets: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            label: z.string().min(1).max(200),
            url: targetUrl,
            classification,
            visual: z
              .object({
                enabled: z.boolean(),
                maskSelectors: z.array(z.string().min(1).max(512)).max(64).default([]),
              })
              .strict()
              .optional(),
            gestures: z
              .object({
                enabled: z.boolean(),
                surfaces: z
                  .array(
                    z
                      .object({
                        id: z.string().min(1).max(100),
                        selector: z.string().min(1).max(512),
                        kinds: z
                          .array(z.enum(['drag', 'swipe']))
                          .min(1)
                          .max(2),
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(32),
              })
              .strict()
              .optional(),
            controls: z
              .array(
                z
                  .object({
                    selector: z.string().min(1).max(512),
                    actions: z.array(actionName).min(1).max(11),
                  })
                  .strict(),
              )
              .max(64)
              .optional(),
          })
          .strict(),
      )
      .max(64)
      .default([]),
    allowLoopback: z.boolean().default(false),
    allowPrivateNetwork: z.boolean().default(false),
    maxSessions: z.number().int().min(1).max(32).default(4),
    sessionTtlMs: z.number().int().min(1_000).max(3_600_000).default(900_000),
    maxBatchSteps: z.number().int().min(1).max(MAX_BATCH_STEPS).default(20),
    defaultTokenBudget: z.number().int().min(256).max(8_000).default(1_800),
    maxElements: z.number().int().min(1).max(1_000).default(500),
    actionTimeoutMs: z.number().int().min(100).max(120_000).default(10_000),
    auditPath: z.string().min(1).max(4_096).optional(),
    windows: desktopConfig.optional(),
    macos: desktopConfig.optional(),
    linux: desktopConfig.optional(),
  })
  .strict();

function isExactOrigin(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username !== '' || u.password !== '') return false;
  if (u.hostname === '') return false;
  if (u.pathname !== '' && u.pathname !== '/') return false;
  return u.search === '' && u.hash === '';
}

function isHttpUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return (
    (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname !== '' && u.username === '' && u.password === ''
  );
}

function originKey(u: URL): string {
  const host = u.hostname.includes(':') && !u.hostname.startsWith('[') ? `[${u.hostname}]` : u.hostname;
  const port = u.port !== '' ? `:${u.port}` : u.protocol === 'https:' ? ':443' : ':80';
  return `${u.protocol}//${host.toLowerCase()}${port}`;
}

export function parsePolicy(input: unknown): PolicyConfig {
  const parsed = policySchema.safeParse(input ?? {});
  if (!parsed.success) throw new AdlError('E_INVALID_ARGUMENT');
  const value = parsed.data as PolicyConfig;
  for (const [platform, desktop] of [
    ['macos', value.macos],
    ['windows', value.windows],
  ] as const) {
    if (
      desktop?.interactive?.enabled &&
      (!desktop.visual?.enabled || (platform === 'macos' && !desktop.visual.allowUnredacted))
    )
      throw new AdlError('E_INVALID_ARGUMENT');
  }
  // Linux has no physical-input path: fail closed at startup instead of advertising interactive_desktop.
  if (value.linux?.interactive?.enabled) throw new AdlError('E_INVALID_ARGUMENT');
  const ids = new Set<string>();
  for (const target of value.browserTargets) {
    if (ids.has(target.id)) throw new AdlError('E_INVALID_ARGUMENT');
    ids.add(target.id);
    if (target.gestures) {
      const surfaces = new Set<string>();
      for (const surface of target.gestures.surfaces) {
        if (surfaces.has(surface.id) || new Set(surface.kinds).size !== surface.kinds.length)
          throw new AdlError('E_INVALID_ARGUMENT');
        surfaces.add(surface.id);
      }
      if (target.gestures.enabled && !target.visual?.enabled) throw new AdlError('E_INVALID_ARGUMENT');
    }
  }
  return {
    ...value,
    allowedOrigins: [...new Set(value.allowedOrigins.map(o => new URL(o).origin))],
    resourceOrigins: [...new Set((value.resourceOrigins ?? []).map(o => new URL(o).origin))],
    browserTargets: value.browserTargets.filter(t => t.classification === 'PUBLIC' || t.classification === 'INTERNAL'),
  };
}

export type Resolver = (hostname: string) => Promise<string[]>;

const DNS_TIMEOUT_MS = 3_000;
const PRIVATE_RANGES = new Set(['private', 'uniqueLocal', 'carrierGradeNat']);

function normalizeAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().replace(/^\[(.*)\]$/, '$1');
  if (value === '' || value.includes('%') || !/^[0-9a-fA-F:.]+$/.test(value)) return null;
  if (!isIP(value)) return null;
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(value);
  } catch {
    return null;
  }
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) addr = v6.toIPv4Address();
  }
  return addr.toString();
}

function isAddressAllowed(address: string, policy: PolicyConfig): boolean {
  const addr = ipaddr.parse(address);
  const range = addr.range();
  if (range === 'unicast') return true;
  if (range === 'loopback') return policy.allowLoopback;
  return PRIVATE_RANGES.has(range) && policy.allowPrivateNetwork;
}

async function defaultResolver(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map(r => r.address);
}

function deny(): never {
  throw new AdlError('E_POLICY_DENIED');
}

export async function resolveAllowedAddresses(
  url: string,
  policy: PolicyConfig,
  resolver?: Resolver,
  purpose: 'navigation' | 'resource' = 'navigation',
): Promise<string[]> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    deny();
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') deny();
  if (parsed.username !== '' || parsed.password !== '') deny();
  let hostname = parsed.hostname;
  if (hostname.endsWith('.') && hostname.slice(0, -1) !== '') hostname = hostname.slice(0, -1);
  if (hostname === '') deny();
  const allowed = new Set(
    [...policy.allowedOrigins, ...(purpose === 'resource' ? (policy.resourceOrigins ?? []) : [])].map(o =>
      originKey(new URL(o)),
    ),
  );
  if ((!policy.allowAllOperations || policy.restrictTargets) && !allowed.has(originKey(parsed)))
    throw new AdlError('E_POLICY_DENIED', 'origin_not_allowed');

  const literal = normalizeAddress(hostname);
  if (hostname.startsWith('[') && literal === null) deny();
  let resolved: string[];
  if (literal !== null) {
    resolved = [literal];
  } else {
    const active = resolver ?? defaultResolver;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      resolved = await Promise.race([
        Promise.resolve(active(hostname)).then(found => (Array.isArray(found) ? found : [])),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AdlError('E_POLICY_DENIED')), DNS_TIMEOUT_MS);
        }),
      ]);
    } catch {
      throw new AdlError('E_POLICY_DENIED', 'dns_resolution_failed');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  if (resolved.length === 0) deny();
  const addresses: string[] = [];
  for (const raw of resolved) {
    const address = normalizeAddress(raw);
    if (address === null) deny();
    if (!isAddressAllowed(address, policy)) {
      const range = ipaddr.parse(address).range();
      throw new AdlError(
        'E_POLICY_DENIED',
        range === 'loopback'
          ? 'loopback_not_allowed'
          : PRIVATE_RANGES.has(range)
            ? 'private_network_not_allowed'
            : undefined,
      );
    }
    addresses.push(address);
  }
  return addresses;
}

export async function assertUrlAllowed(
  url: string,
  policy: PolicyConfig,
  resolver?: Resolver,
  purpose: 'navigation' | 'resource' = 'navigation',
): Promise<void> {
  await resolveAllowedAddresses(url, policy, resolver, purpose);
}

const SAFE_ROLES = new Set([
  'alert',
  'article',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'dialog',
  'figure',
  'generic',
  'grid',
  'gridcell',
  'heading',
  'img',
  'link',
  'list',
  'listbox',
  'listitem',
  'menu',
  'menuitem',
  'navigation',
  'option',
  'paragraph',
  'progressbar',
  'radio',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'searchbox',
  'slider',
  'spinbutton',
  'status',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'text',
  'textbox',
  'time',
  'toolbar',
  'tree',
  'treeitem',
  'window',
]);

export function redactText(text: string, allowPersonalData = false): string {
  let out = typeof text === 'string' ? text : '';
  for (const [source, replacement] of TEXT_REDACTION_RULES) out = out.replace(new RegExp(source, 'gi'), replacement);
  if (!allowPersonalData)
    for (const [source, replacement] of PERSONAL_DATA_REDACTION_RULES)
      out = out.replace(new RegExp(source, 'gi'), replacement);
  return out;
}
export function redactString(text: string, allowPersonalData = false): string {
  // Redact before clipping: a credential crossing the field boundary must not leak a prefix.
  return redactText(text, allowPersonalData).slice(0, MAX_TEXT);
}

/** Preserve known public navigation parameters while withholding opaque query payloads. */
export function redactUrl(value: string, allowPersonalData = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return redactString(value, allowPersonalData);
  }
  url.hash = '';
  const publicKeys = /^(?:q|query|search|page|limit|offset|sort|order|category|filter|lang|locale)$/i;
  for (const key of [...url.searchParams.keys()]) {
    const values = url.searchParams.getAll(key);
    url.searchParams.delete(key);
    for (const entry of values)
      url.searchParams.append(key, publicKeys.test(key) ? redactText(entry, allowPersonalData) : '[redacted]');
  }
  return redactString(url.href, allowPersonalData);
}

/** 3+ parts split on - or _, each only letters or only digits: a readable name (annual_report_2025_final), not a token with mixed parts. */
const wordsAndNumbers = (raw: string) => {
  const parts = raw.split(/[-_]/);
  return parts.length >= 3 && parts.every(part => /^(?:[A-Za-z]+|[0-9]+)$/.test(part));
};

/**
 * Link destination for observations: same-origin links as path+query, other origins as origin+path+query,
 * other schemes as the scheme alone. Query values follow redactUrl (known public keys visible, the rest masked);
 * fragments survive only when they are a plain identifier or path. Bounded to 256 characters.
 */
export function redactLink(value: string, pageUrl?: string, allowPersonalData = false): string {
  if (typeof value !== 'string' || !value) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return url.protocol === 'mailto:' || url.protocol === 'tel:'
      ? redactString(url.protocol + url.pathname, allowPersonalData).slice(0, 256)
      : url.protocol;
  let page: URL | undefined;
  try {
    page = pageUrl ? new URL(pageUrl) : undefined;
  } catch {
    page = undefined;
  }
  const fragment = /^#[A-Za-z0-9_./-]{1,64}$/.test(url.hash) ? redactText(url.hash, allowPersonalData) : '';
  url.username = '';
  url.password = '';
  // Opaque path tokens (reset, invite or magic links) are masked like secret query values;
  // slugs (3+ hyphens), file names (dots), hex hashes and names of 3+ words and numbers joined by - or _ stay readable.
  url.pathname = url.pathname
    .split('/')
    .map(segment => {
      let raw = segment;
      try {
        raw = decodeURIComponent(segment);
      } catch {}
      return raw.length >= 24 &&
        /^[A-Za-z0-9_~-]+$/.test(raw) &&
        /[0-9]/.test(raw) &&
        /[g-zG-Z]/.test(raw) &&
        (raw.match(/-/g) ?? []).length < 3 &&
        !wordsAndNumbers(raw)
        ? '[redacted]'
        : segment;
    })
    .join('/');
  const sameOrigin = page?.origin === url.origin;
  let out = redactUrl(url.href, allowPersonalData);
  if (sameOrigin && out.startsWith(url.origin)) {
    out = out.slice(url.origin.length) || '/';
    // A same-document anchor keeps its fragment as the whole destination.
    if (fragment && page && page.pathname === url.pathname && page.search === url.search) return fragment;
  }
  out = (out + fragment).replace(/%5Bredacted%5D/gi, '[redacted]');
  return out.length > 256 ? out.slice(0, 253) + '...' : out;
}

export function redactElement(
  element: Element,
  allowPersonalData = false,
  pageUrl?: string,
): Omit<Element, 'sensitive'> {
  const { sensitive, ...safe } = element;
  safe.role = SAFE_ROLES.has(safe.role) ? safe.role : 'generic';
  const isText = BROWSER_PRIVACY_RULES.textRoles.some(role => role === safe.role);
  const secret = sensitive === true || isSensitiveLabel(safe.id) || (!isText && isSensitiveLabel(safe.name));
  if (secret) {
    safe.name = safe.protected || isText ? REDACTED : redactString(safe.name, allowPersonalData);
    if (safe.value !== undefined && safe.value !== '') safe.value = REDACTED;
  } else {
    safe.name = redactString(safe.name, allowPersonalData);
    if (safe.value !== undefined) safe.value = redactString(safe.value, allowPersonalData);
  }
  if (safe.href !== undefined) {
    // A masked or protected control never exposes where it leads.
    const href = sensitive === true || safe.protected ? '' : redactLink(safe.href, pageUrl, allowPersonalData);
    if (href) safe.href = href;
    else delete safe.href;
  }
  if (safe.options)
    safe.options = safe.options.map(option => {
      const hidden = secret || isSensitiveLabel(option.label);
      return {
        ...option,
        label: hidden ? REDACTED : redactString(option.label, allowPersonalData),
        value: hidden && option.value !== '' ? REDACTED : redactString(option.value, allowPersonalData),
      };
    });
  return safe;
}

function assertNoRedacted(value: string): void {
  if (value.includes(REDACTED) || value.includes('[filtered]')) throw new AdlError('E_PRIVACY_BLOCKED');
}

/** A label a native helper refuses without the one-shot approval; width-folded and split at camelCase, digits, `_` and `-` like the helpers. */
export function isNativeConsequential(label: string): boolean {
  const words = label
    .normalize('NFKC')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ');
  return NATIVE_CONSEQUENTIAL.test(words);
}

export function authorizeAction(action: Action, element?: Element, allowAllOperations = false): void {
  if (!action || typeof action !== 'object' || !SUPPORTED_ACTIONS.includes(action.action))
    throw new AdlError('E_UNSUPPORTED_ACTION');
  if (action.action === 'navigate') {
    if (typeof action.url !== 'string' || action.url.length === 0) throw new AdlError('E_INVALID_ARGUMENT');
    return;
  }
  if (action.action === 'back') return;
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
    throw new AdlError('E_INVALID_ARGUMENT');
  if (!element) throw new AdlError('E_TARGET_NOT_FOUND');
  if (element.protected === true) throw new AdlError('E_PRIVACY_BLOCKED');
  if (allowAllOperations) {
    if (element.enabled === false) throw new AdlError('E_POLICY_DENIED');
    return;
  }
  if (element.sensitive === true) throw new AdlError('E_PRIVACY_BLOCKED');
  if (element.enabled === false) throw new AdlError('E_POLICY_DENIED');
  if (isSensitiveLabel(element.name, element.id)) throw new AdlError('E_PRIVACY_BLOCKED');
  if (typeof element.value === 'string' && isSensitiveLabel(element.value)) throw new AdlError('E_PRIVACY_BLOCKED');
  if (action.action !== 'scroll' && (CONSEQUENTIAL.test(element.name ?? '') || CONSEQUENTIAL.test(element.role ?? '')))
    throw new AdlError('E_APPROVAL_REQUIRED', 'consequential_operation');
  if (typeof action.value === 'string') {
    assertNoRedacted(action.value);
    if (redactString(action.value) !== action.value) throw new AdlError('E_PRIVACY_BLOCKED');
  }
}
