import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import {isIP} from 'node:net';
import { z } from 'zod';
import { AdlError, type Action, type ActionName, type Element, type PolicyConfig } from './types.js';

const MAX_BATCH_STEPS = 20;
const MAX_TEXT = 512;
const REDACTED = '[redacted]';
const SUPPORTED_ACTIONS: ActionName[] = ['click', 'fill', 'select', 'check', 'scroll', 'navigate', 'read_state', 'wait_for'];
const CONSEQUENTIAL = /(?:delete|remove|upload|send|submit|purchase|checkout|pay|payment|login|log\s*in|sign\s*in|sign\s*up|register|withdraw|transfer)/i;

const origin = z.string().refine(isExactOrigin, 'allowedOrigins entries must be exact http(s) origins without path, query, fragment or credentials');
const targetUrl = z.string().refine(isHttpUrl, 'browserTargets url must be a full http(s) URL');
const classification = z.enum(['PUBLIC', 'INTERNAL', 'SECRET', 'UNKNOWN']);
const actionName = z.enum(['click', 'fill', 'select', 'check', 'scroll', 'navigate', 'read_state', 'wait_for']);

const absolutePath = z.string().min(1).max(4_096).refine(v => (v.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(v) || /^\\\\[^\\]+\\[^\\]+/.test(v)) && !v.includes('\0'), 'path must be absolute');
const interactiveConfig=z.object({
  enabled:z.boolean(),surfaces:z.array(z.object({id:z.string().min(1).max(64).refine(v=>Buffer.byteLength(v)<=64),region:z.object({x:z.number().int().min(0).max(4095),y:z.number().int().min(0).max(4095),width:z.number().int().min(1).max(4096),height:z.number().int().min(1).max(4096)}).strict(),kinds:z.array(z.enum(['drag','swipe'])).min(1).max(2),swipe_backend:z.enum(['scroll','touch']).optional()}).strict()).max(16),
}).strict().refine(v=>Buffer.byteLength(JSON.stringify(v))<=8000&&new Set(v.surfaces.map(s=>s.id)).size===v.surfaces.length&&v.surfaces.every(s=>s.region.x+s.region.width<=4096&&s.region.y+s.region.height<=4096&&new Set(s.kinds).size===s.kinds.length));
const desktopConfig = z.object({
  allowAllOperations:z.boolean().optional(),
  helperPath: absolutePath,
  appId: z.string().min(1).max(128),
  appPath: absolutePath,
  controlsPath: absolutePath.optional(),
  classification: z.enum(['PUBLIC', 'INTERNAL']),
  visual:z.object({enabled:z.boolean(),allowUnredacted:z.boolean().default(false),maskRegions:z.array(z.object({x:z.number().int().min(0).max(4096),y:z.number().int().min(0).max(4096),width:z.number().int().min(1).max(4096),height:z.number().int().min(1).max(4096)}).strict()).max(64).default([])}).strict().optional(),
  interactive:interactiveConfig.optional(),
  lifecycle:z.object({enabled:z.boolean()}).strict().optional(),
}).strict();

const policySchema = z.object({
  allowAllOperations:z.boolean().optional(),
  allowedOrigins: z.array(origin).max(64).default([]),
  browserTargets: z.array(z.object({
    id: z.string().min(1).max(128),
    label: z.string().min(1).max(200),
    url: targetUrl,
    classification,
    visual: z.object({
      enabled: z.boolean(),
      maskSelectors: z.array(z.string().min(1).max(512)).max(64).default([]),
    }).strict().optional(),
    gestures:z.object({enabled:z.boolean(),surfaces:z.array(z.object({id:z.string().min(1).max(100),selector:z.string().min(1).max(512),kinds:z.array(z.enum(['drag','swipe'])).min(1).max(2)}).strict()).min(1).max(32)}).strict().optional(),
    controls: z.array(z.object({
      selector: z.string().min(1).max(512),
      actions: z.array(actionName).min(1).max(8),
    }).strict()).max(64).optional(),
  }).strict()).max(64).default([]),
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
}).strict();

function isExactOrigin(value: string): boolean {
  let u: URL;
  try { u = new URL(value); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.username !== '' || u.password !== '') return false;
  if (u.hostname === '') return false;
  if (u.pathname !== '' && u.pathname !== '/') return false;
  return u.search === '' && u.hash === '';
}

function isHttpUrl(value: string): boolean {
  let u: URL;
  try { u = new URL(value); } catch { return false; }
  return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname !== '' && u.username === '' && u.password === '';
}

function originKey(u: URL): string {
  const host = u.hostname.includes(':') && !u.hostname.startsWith('[') ? `[${u.hostname}]` : u.hostname;
  const port = u.port !== '' ? `:${u.port}` : (u.protocol === 'https:' ? ':443' : ':80');
  return `${u.protocol}//${host.toLowerCase()}${port}`;
}

export function parsePolicy(input: unknown): PolicyConfig {
  const parsed = policySchema.safeParse(input ?? {});
  if (!parsed.success) throw new AdlError('E_INVALID_ARGUMENT');
  const value = parsed.data as PolicyConfig;
  for(const [platform,desktop] of [['macos',value.macos],['windows',value.windows]] as const){if(desktop?.interactive?.enabled&&(!desktop.visual?.enabled||platform==='macos'&&!desktop.visual.allowUnredacted))throw new AdlError('E_INVALID_ARGUMENT');}
  const ids = new Set<string>();
  for (const target of value.browserTargets) {
    if (ids.has(target.id)) throw new AdlError('E_INVALID_ARGUMENT');
    ids.add(target.id);
    if(target.gestures){const surfaces=new Set<string>();for(const surface of target.gestures.surfaces){if(surfaces.has(surface.id)||new Set(surface.kinds).size!==surface.kinds.length)throw new AdlError('E_INVALID_ARGUMENT');surfaces.add(surface.id);}if(target.gestures.enabled&&!target.visual?.enabled)throw new AdlError('E_INVALID_ARGUMENT');}
  }
  return {
    ...value,
    browserTargets: value.browserTargets.filter((t) => t.classification === 'PUBLIC' || t.classification === 'INTERNAL'),
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
  try { addr = ipaddr.parse(value); } catch { return null; }
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
  return records.map((r) => r.address);
}

function deny(): never { throw new AdlError('E_POLICY_DENIED'); }

export async function resolveAllowedAddresses(url: string, policy: PolicyConfig, resolver?: Resolver): Promise<string[]> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { deny(); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') deny();
  if (parsed.username !== '' || parsed.password !== '') deny();
  let hostname = parsed.hostname;
  if (hostname.endsWith('.') && hostname.slice(0, -1) !== '') hostname = hostname.slice(0, -1);
  if (hostname === '') deny();
  const allowed = new Set(policy.allowedOrigins.map((o) => originKey(new URL(o))));
  if (!policy.allowAllOperations&&!allowed.has(originKey(parsed))) deny();

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
        Promise.resolve(active(hostname)).then((found) => (Array.isArray(found) ? found : [])),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AdlError('E_POLICY_DENIED')), DNS_TIMEOUT_MS); }),
      ]);
    } catch { deny(); } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  if (resolved.length === 0) deny();
  const addresses: string[] = [];
  for (const raw of resolved) {
    const address = normalizeAddress(raw);
    if (address === null) deny();
    if (!isAddressAllowed(address, policy)) deny();
    addresses.push(address);
  }
  return addresses;
}

export async function assertUrlAllowed(url: string, policy: PolicyConfig, resolver?: Resolver): Promise<void> {
  await resolveAllowedAddresses(url, policy, resolver);
}

const SECRET_LABEL = /(?:password|passwd|pwd|passcode|secret|token|api[_ -]?key|access[_ -]?key|private[_ -]?key|key|credential|authorization|auth|bearer|otp|cvv|session|cookie|pin)/i;
const NAME_IS_SECRET = /^(?:password|passwd|pwd|passcode|secret|token|apikey|api_key|access_token|refresh_token|authorization|auth|bearer|otp|cvv|session|sessionid|session_id|cookie|pin)$/i;
const SAFE_ROLES=new Set(['alert','button','checkbox','combobox','dialog','generic','heading','img','link','list','listbox','listitem','menu','menuitem','option','progressbar','radio','region','searchbox','slider','spinbutton','status','switch','tab','table','tabpanel','text','textbox','toolbar','tree','treeitem','window']);

export function redactString(text: string): string {
  let out = typeof text === 'string' ? text.slice(0, MAX_TEXT) : '';
  out = out.replace(/([?&][a-z0-9_]*(?:token|key|secret|password|passwd|pwd|signature|sig|code|auth|session|api|access)[a-z0-9_]*)=[^&\s"'<>]*/gi, `$1=${REDACTED}`);
  out = out.replace(/\b([a-z0-9_.-]*(?:password|passwd|pwd|passcode|secret|token|key|credential|authorization|auth|bearer|session|cookie|otp|cvv|pin)[a-z0-9_.-]*)(\s*[=:]\s*)([^\s,;&]{2,})/gi, `$1$2${REDACTED}`);
  out = out.replace(/\b(bearer|basic|digest|token)\s+([a-z0-9._~+/=-]{4,})/gi, `$1 ${REDACTED}`);
  out = out.replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, REDACTED);
  out = out.replace(/\b(?:employee|emp|staff|user|member)[_-]?(?:id|no|number)\s*[:=]\s*[^\s,;&]+/gi, REDACTED);
  out = out.replace(/\b(?:sk|pk|rk|ak|ghp|gho|ghu|ghs|xox[baps])[-_][a-z0-9_-]{12,}\b/gi, REDACTED);
  out = out.replace(/\b[a-z0-9+/_-]{28,}={0,2}\b/gi, REDACTED);
  return out.slice(0, MAX_TEXT);
}

function isSecretName(...names: (string | undefined)[]): boolean {
  return names.some((n) => typeof n === 'string' && n.length > 0 && (NAME_IS_SECRET.test(n) || SECRET_LABEL.test(n)));
}

export function redactElement(element: Element): Omit<Element, 'sensitive'> {
  const { sensitive, ...safe } = element;
  safe.role=SAFE_ROLES.has(safe.role)?safe.role:'generic';
  const secret = sensitive === true || isSecretName(safe.name, safe.role, safe.id);
  if (secret) {
    if (safe.name) safe.name = REDACTED;
    if (safe.value !== undefined) safe.value = REDACTED;
  } else {
    safe.name = redactString(safe.name);
    if (safe.value !== undefined) safe.value = redactString(safe.value);
  }
  return safe;
}

function assertNoRedacted(value: string): void {
  if (value.includes(REDACTED) || value.includes('[filtered]')) throw new AdlError('E_PRIVACY_BLOCKED');
}

export function authorizeAction(action: Action, element?: Element, allowAllOperations=false): void {
  if (!action || typeof action !== 'object' || !SUPPORTED_ACTIONS.includes(action.action)) throw new AdlError('E_UNSUPPORTED_ACTION');
  if (action.action === 'navigate') {
    if (typeof action.url !== 'string' || action.url.length === 0) throw new AdlError('E_INVALID_ARGUMENT');
    return;
  }
  if (!element) throw new AdlError('E_TARGET_NOT_FOUND');
  if(allowAllOperations){if(element.enabled===false)throw new AdlError('E_POLICY_DENIED');return;}
  if (element.sensitive === true) throw new AdlError('E_PRIVACY_BLOCKED');
  if (element.enabled === false) throw new AdlError('E_POLICY_DENIED');
  if (isSecretName(element.name, element.role, element.id)) throw new AdlError('E_PRIVACY_BLOCKED');
  if (typeof element.value === 'string' && isSecretName(element.value)) throw new AdlError('E_PRIVACY_BLOCKED');
  if (CONSEQUENTIAL.test(element.name ?? '') || CONSEQUENTIAL.test(element.role ?? '')) throw new AdlError('E_APPROVAL_REQUIRED');
  if (typeof action.value === 'string') {
    assertNoRedacted(action.value);
    if (redactString(action.value) !== action.value) throw new AdlError('E_PRIVACY_BLOCKED');
  }
}
