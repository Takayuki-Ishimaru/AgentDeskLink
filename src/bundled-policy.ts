import {parsePolicy} from './policy.js';
import {AdlError,type PolicyConfig} from './types.js';
import {dirname,resolve} from 'node:path';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The host supplies an installed helper; the policy still supplies every permission.
// Standalone launches retain the existing requirement for an explicit helperPath.
export function parseStartupPolicy(input: unknown, helperPath?: string, platform: string = process.platform, configPath?: string): PolicyConfig {
  const key = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : undefined;
  let source=input;
  if (helperPath && key && object(input) && object(input[key]) && !Object.hasOwn(input[key], 'helperPath')) {
    source={...input, [key]: {...input[key], helperPath}};
  }
  const policy=parsePolicy(source);
  if(configPath&&policy.auditPath)policy.auditPath=resolve(dirname(resolve(configPath)),policy.auditPath);
  return policy;
}

// Extension-managed grants. Every field defaults to deny; enabling MCP grants nothing.
export type OperationMode = 'read_only' | 'standard' | 'ask';
export interface ExtensionPermissions {
  browserOrigins: string[];
  browserResourceOrigins?:string[];
  allowPersonalData?:boolean;
  desktopAppId: string;
  desktopAppPath: string;
  allowAllOperations: boolean;
  operationMode: OperationMode;
  allowPhysicalInput: boolean;
  allowUnredactedImages: boolean;
  allowLoopback: boolean;
  allowPrivateNetwork: boolean;
}

const GRANT_KEYS = ['browserOrigins', 'browserResourceOrigins','allowPersonalData','desktopAppId', 'desktopAppPath', 'allowAllOperations', 'operationMode', 'allowPhysicalInput',
  'allowUnredactedImages', 'allowLoopback', 'allowPrivateNetwork'] as const;

const MAX_ORIGINS = 64;
const MAX_ORIGIN_LENGTH = 2048;

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
}

// Origins are accepted only as exact origins and normalized to URL.origin.
function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || value.length > MAX_ORIGIN_LENGTH || value.includes('\0')) return null;
  let u: URL;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username !== '' || u.password !== '' || u.hostname === '') return null;
  if (u.pathname !== '' && u.pathname !== '/') return null;
  if (u.search !== '' || u.hash !== '') return null;
  return u.origin;
}

class PermissionSettingError extends AdlError {
  constructor(readonly setting: string, readonly expected: string) { super('E_INVALID_ARGUMENT'); }
}
function invalidGrant(setting: string, expected: string): never { throw new PermissionSettingError(setting, expected); }
export function describePermissionError(error: unknown): string {
  const detail = error instanceof PermissionSettingError
    ? `agentdesklink.${error.setting}: expected format / 期待する形式: ${error.expected}. `
    : 'agentdesklink: invalid permission settings / 権限設定の形式が不正です。 ';
  return detail + 'All grants are denied until corrected. / 修正するまですべての権限を拒否します。';
}

// Strict: any malformed grant throws instead of yielding a partial broad grant.
export function normalizePermissions(value: unknown): ExtensionPermissions {
  const p: Record<string, unknown> = object(value) ? value : {};
  if (!object(value)) invalidGrant('browserOrigins', 'a permissions object / 権限設定のオブジェクト');
  for (const key of Object.keys(p)) if (!GRANT_KEYS.includes(key as typeof GRANT_KEYS[number])) invalidGrant('browserOrigins', 'supported permission keys only / 対応する権限設定キーのみ');
  const flag = (key: typeof GRANT_KEYS[number]): boolean => {
    const v = p[key];
    if (v === undefined) return false;
    if (typeof v !== 'boolean') invalidGrant(key, 'true or false');
    return v;
  };
  const text = (key: typeof GRANT_KEYS[number], max: number): string => {
    const v = p[key];
    if (v === undefined) return '';
    if (typeof v !== 'string' || v.length > max || v.includes('\0')) invalidGrant(key, `a string of at most ${max} characters without NUL / NULを含まない文字列`);
    return v;
  };
  const rawOrigins = p.browserOrigins;
  if (rawOrigins !== undefined && (!Array.isArray(rawOrigins) || rawOrigins.length > MAX_ORIGINS)) invalidGrant('browserOrigins', `an array of at most ${MAX_ORIGINS} exact http(s) origins / 完全なオリジンの配列`);
  const origins: string[] = [];
  for (const entry of rawOrigins ?? []) {
    const origin = normalizeOrigin(entry);
    if (origin === null) invalidGrant('browserOrigins', 'exact http(s) origins without path, query, fragment or credentials, e.g. https://example.com / パス・クエリ・認証情報なしの完全なオリジン');
    if (!origins.includes(origin)) origins.push(origin);
  }
  const resourceOrigins:string[]=[];
  const rawResources=p.browserResourceOrigins;
  if(rawResources!==undefined&&(!Array.isArray(rawResources)||rawResources.length>MAX_ORIGINS))invalidGrant('browserResourceOrigins','an array of at most 64 exact http(s) origins');
  for(const entry of rawResources??[]){const origin=normalizeOrigin(entry);if(origin===null)invalidGrant('browserResourceOrigins','exact http(s) origins without path, query, fragment or credentials');if(!resourceOrigins.includes(origin))resourceOrigins.push(origin);}
  const appId = text('desktopAppId', 128);
  const appPath = text('desktopAppPath', 4096);
  const rawMode=p.operationMode??'read_only';
  if(!['read_only','standard','ask'].includes(String(rawMode)))invalidGrant('operationMode','read_only, standard, or ask');
  if (appPath !== '' && !isAbsolutePath(appPath)) invalidGrant('desktopAppPath', 'an absolute application path / アプリの絶対パス');
  if (appId !== '' && !isAbsolutePath(appPath)) invalidGrant('desktopAppPath', 'an absolute path paired with desktopAppId / desktopAppIdに対応するアプリの絶対パス');
  return {
    browserOrigins: origins,
    browserResourceOrigins:resourceOrigins,
    allowPersonalData:flag('allowPersonalData'),
    // A wildcard application is never a grant: it cannot name one trusted app.
    desktopAppId: appId === '*' ? '' : appId,
    desktopAppPath: appPath,
    allowAllOperations: flag('allowAllOperations'),
    operationMode: rawMode as ExtensionPermissions['operationMode'],
    allowPhysicalInput: flag('allowPhysicalInput'),
    allowUnredactedImages: flag('allowUnredactedImages'),
    allowLoopback: flag('allowLoopback'),
    allowPrivateNetwork: flag('allowPrivateNetwork'),
  };
}

const DENY_ALL: ExtensionPermissions = {browserOrigins: [], desktopAppId: '', desktopAppPath: '', allowAllOperations: false,operationMode:'read_only',
  browserResourceOrigins:[],allowPersonalData:false,allowPhysicalInput: false, allowUnredactedImages: false, allowLoopback: false, allowPrivateNetwork: false};

// Decodes the MCP environment. Missing, oversized or malformed input denies everything.
export function parsePermissionsEnv(value: string | undefined): ExtensionPermissions {
  if (typeof value !== 'string' || value === '') return {...DENY_ALL,browserOrigins:[]};
  if (Buffer.byteLength(value,'utf8') > 65_536) return {...DENY_ALL,browserOrigins:[]};
  let decoded: unknown;
  try { decoded = JSON.parse(value); } catch { return {...DENY_ALL,browserOrigins:[]}; }
  try { return normalizePermissions(decoded); } catch { return {...DENY_ALL,browserOrigins:[]}; }
}

// Operational settings are passed separately from permission grants so adding
// headful/proxy options never changes the permission schema or widens access.
export interface ExtensionRuntimeSettings { sessionTtlMs: number; browserHeadless: boolean; browserProxyServer: string }
const DEFAULT_RUNTIME_SETTINGS: ExtensionRuntimeSettings = { sessionTtlMs: 900_000, browserHeadless: true, browserProxyServer: '' };
export function normalizeRuntimeSettings(value: unknown): ExtensionRuntimeSettings {
  if (!object(value) || Object.keys(value).some(key => !['sessionTtlMs', 'browserHeadless', 'browserProxyServer'].includes(key))) throw new AdlError('E_INVALID_ARGUMENT');
  const sessionTtlMs = value.sessionTtlMs ?? DEFAULT_RUNTIME_SETTINGS.sessionTtlMs;
  if (typeof sessionTtlMs !== 'number' || !Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 1_000 || sessionTtlMs > 3_600_000) {
    throw new AdlError('E_INVALID_ARGUMENT');
  }
  const browserHeadless=value.browserHeadless??DEFAULT_RUNTIME_SETTINGS.browserHeadless;
  if(typeof browserHeadless!=='boolean')throw new AdlError('E_INVALID_ARGUMENT');
  const rawProxy=value.browserProxyServer??DEFAULT_RUNTIME_SETTINGS.browserProxyServer;
  if(typeof rawProxy!=='string'||rawProxy.length>2_048||rawProxy.includes('\0'))throw new AdlError('E_INVALID_ARGUMENT');
  let browserProxyServer='';
  if(rawProxy!==''){
    let proxy:URL;try{proxy=new URL(rawProxy);}catch{throw new AdlError('E_INVALID_ARGUMENT');}
    if(!['http:','https:'].includes(proxy.protocol)||!proxy.hostname||proxy.username||proxy.password||proxy.pathname!=='/'||proxy.search||proxy.hash||/[?#]/.test(rawProxy))throw new AdlError('E_INVALID_ARGUMENT');
    browserProxyServer=proxy.origin;
  }
  return { sessionTtlMs, browserHeadless, browserProxyServer };
}
export function runtimeSettingsFromIdleMinutes(minutes: unknown): ExtensionRuntimeSettings {
  if (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 60) throw new AdlError('E_INVALID_ARGUMENT');
  return normalizeRuntimeSettings({ sessionTtlMs: minutes * 60_000 });
}
export function parseRuntimeSettingsEnv(value: string | undefined): ExtensionRuntimeSettings {
  if (value === undefined || value === '') return { ...DEFAULT_RUNTIME_SETTINGS };
  if (Buffer.byteLength(value, 'utf8') > 4_096) throw new AdlError('E_RESOURCE_LIMIT');
  let decoded: unknown;
  try { decoded = JSON.parse(value); } catch { throw new AdlError('E_INVALID_ARGUMENT'); }
  return normalizeRuntimeSettings(decoded);
}
export function applyRuntimeSettings(policy: PolicyConfig, settings: unknown): PolicyConfig {
  return { ...policy, ...normalizeRuntimeSettings(settings) };
}
export function runtimeSettingsEnvJson(settings: unknown): string {
  return JSON.stringify(normalizeRuntimeSettings(settings));
}

// Only extension-managed launches opt into this profile. Standalone CLI policy stays explicit.
// No grants means default deny. restrictTargets keeps origin and application checks in force even
// when allowAllOperations is granted, so operations never widen the target or network surface.
export function extensionPolicy(helperPath?: string, platform: string = process.platform, permissions?: unknown, runtimeSettings?: unknown): PolicyConfig {
  const grants = normalizePermissions(permissions ?? {});
  const hasApp = grants.desktopAppId !== '' && grants.desktopAppPath !== '' && isAbsolutePath(helperPath ?? '');
  // Physical input needs a valid application plus the desktop visual opt-in, which is only
  // possible once unredacted native images are explicitly granted (mask regions are not configured here).
  const interactive = grants.allowPhysicalInput && grants.allowUnredactedImages
    ? {enabled: true, surfaces: [{id: 'desktop', region: {x: 0, y: 0, width: 4096, height: 4096}, kinds: ['drag' as const, 'swipe' as const]}]}
    : undefined;
  const desktop = hasApp
    ? {restrictTargets: true, helperPath: helperPath as string, appId: grants.desktopAppId, appPath: grants.desktopAppPath,
        classification: 'PUBLIC' as const, allowAllOperations: grants.allowAllOperations,
        ...(grants.allowUnredactedImages ? {visual: {enabled: true, allowUnredacted: true, maskRegions: []}} : {}),
        ...(interactive ? {interactive} : {})}
    : undefined;
  const targets = grants.browserOrigins.map((url, index) => ({
    id: `granted_${index + 1}`, label: url, url, classification: 'PUBLIC' as const,
    visual: {enabled: true, maskSelectors: []},
    gestures: {enabled: true, surfaces: [{id: 'page', selector: 'body', kinds: ['drag' as const, 'swipe' as const]}]},
  }));
  const policy=parsePolicy({
    restrictTargets: true,
    allowAllOperations: grants.allowAllOperations,
    operationMode: grants.operationMode,
    allowedOrigins: grants.browserOrigins,
    resourceOrigins:grants.browserResourceOrigins??[],
    allowPersonalData:grants.allowPersonalData===true,
    allowLoopback: grants.allowLoopback,
    allowPrivateNetwork: grants.allowPrivateNetwork,
    browserTargets: targets,
    ...(desktop && platform === 'darwin' ? {macos: desktop} : desktop && platform === 'win32' ? {windows: desktop} : {}),
  });
  return runtimeSettings===undefined?policy:applyRuntimeSettings(policy,runtimeSettings);
}
export interface EffectivePermissions extends Omit<ExtensionPermissions, 'desktopAppPath'|'operationMode'> { operationMode:OperationMode|'all'; reasons: string[] }

// Derive these values from the same policy used by the server.
export function effectivePermissions(permissions: unknown, helperPath?: string, platform: string = process.platform): EffectivePermissions {
  const grants = normalizePermissions(permissions);
  const policy = extensionPolicy(helperPath, platform, grants);
  const native = platform === 'darwin' ? policy.macos : platform === 'win32' ? policy.windows : undefined;
  const reasons: string[] = [];
  if (grants.allowPhysicalInput || grants.allowUnredactedImages || grants.desktopAppId) {
    if (platform !== 'darwin' && platform !== 'win32') reasons.push('Native control requires macOS or Windows / ネイティブ操作はmacOS・Windowsのみ対応です。');
    else {
      if (!grants.desktopAppId || !grants.desktopAppPath) reasons.push('Configure an application ID and absolute path / アプリIDと絶対パスが必要です。');
      if (!isAbsolutePath(helperPath ?? '')) reasons.push('The native runtime is not ready / ネイティブの実行環境がまだ準備されていません。');
      if (grants.allowPhysicalInput && !grants.allowUnredactedImages) reasons.push('Physical input needs unredacted native images / 物理入力には無加工ネイティブ画像の許可が必要です。');
    }
  }
  return {
    browserOrigins: policy.allowedOrigins ?? [], desktopAppId: native?.appId ?? '',
    browserResourceOrigins:policy.resourceOrigins??[],allowPersonalData:policy.allowPersonalData===true,
    allowAllOperations: policy.allowAllOperations === true,
    operationMode:policy.allowAllOperations===true?'all':policy.operationMode??grants.operationMode,
    allowPhysicalInput: native?.interactive?.enabled === true,
    allowUnredactedImages: native?.visual?.enabled === true,
    allowLoopback: policy.allowLoopback === true, allowPrivateNetwork: policy.allowPrivateNetwork === true,
    reasons,
  };
}
