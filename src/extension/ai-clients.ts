// Detect and configure MCP server entries in third-party AI client configs.
// No vscode import: this module runs in plain Node (and in the extension host).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as jsonc from 'jsonc-parser';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

export const AGENT_NAME = 'agentdesklink';
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const LOCK_SUFFIX = '.agentdesklink.lock';

export interface ClientInfo {
  id: string;
  name: string;
  configPath: string;
  format: 'json' | 'toml';
  detected: boolean;
  reason: string;
}

export interface DetectOptions {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  extensionIds?: readonly string[];
}

export interface Registration { command: string; args: string[]; }

export interface ClientResult {
  id: string;
  name: string;
  configPath: string;
  status: 'enabled' | 'disabled' | 'conflict' | 'error';
  message: string;
}

interface Ctx {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

interface Target {
  id: string;
  name: string;
  format: 'json' | 'toml';
  map: string;
  dirSignal?: (ctx: Ctx) => string | null;
  extensionId?: string;
  executable?: string;
  appDirs?: (ctx: Ctx) => string[];
  config: (ctx: Ctx) => string;
}

function join(...parts: string[]): string { return path.join(...parts); }

// Per-platform root for app config folders (Claude Desktop, VS Code, Devin).
function configRoot(ctx: Ctx): string {
  if (ctx.platform === 'win32') return ctx.env.APPDATA || join(ctx.home, 'AppData', 'Roaming');
  if (ctx.platform === 'darwin') return join(ctx.home, 'Library', 'Application Support');
  return ctx.env.XDG_CONFIG_HOME || join(ctx.home, '.config');
}

// XDG-style root used by CLI tools; on Windows the app-data root is the XDG home.
function xdgConfig(ctx: Ctx): string {
  if (ctx.platform === 'win32') return configRoot(ctx);
  return ctx.env.XDG_CONFIG_HOME || join(ctx.home, '.config');
}

function codeUserRoot(ctx: Ctx): string { return join(configRoot(ctx), 'Code', 'User'); }

function globalStorage(ctx: Ctx, ext: string, ...rest: string[]): string {
  return join(codeUserRoot(ctx), 'globalStorage', ext, ...rest);
}

const TARGETS: Target[] = [
  {
    id: 'claude-code', name: 'Claude Code', format: 'json', map: 'mcpServers',
    extensionId: 'anthropic.claude-code', executable: 'claude',
    // dirname of the config is the home itself, so signal on ~/.claude instead.
    dirSignal: (ctx) => ctx.env.CLAUDE_CONFIG_DIR ? ctx.env.CLAUDE_CONFIG_DIR : join(ctx.home, '.claude'),
    config: (ctx) => ctx.env.CLAUDE_CONFIG_DIR
      ? join(ctx.env.CLAUDE_CONFIG_DIR, '.claude.json')
      : join(ctx.home, '.claude.json'),
  },
  {
    id: 'claude-desktop', name: 'Claude Desktop', format: 'json', map: 'mcpServers',
    dirSignal: (ctx) => join(configRoot(ctx), 'Claude'),
    appDirs: (ctx) => ctx.platform === 'darwin'
      ? [join(ctx.home, 'Applications', 'Claude.app')]
      : [join(ctx.home, 'Applications', 'Claude.app'), join(configRoot(ctx), 'Claude')],
    config: (ctx) => join(configRoot(ctx), 'Claude', 'claude_desktop_config.json'),
  },
  {
    id: 'codex', name: 'Codex', format: 'toml', map: 'mcp_servers',
    extensionId: 'openai.chatgpt', executable: 'codex',
    dirSignal: (ctx) => ctx.env.CODEX_HOME || join(ctx.home, '.codex'),
    config: (ctx) => join(ctx.env.CODEX_HOME || join(ctx.home, '.codex'), 'config.toml'),
  },
  {
    id: 'cursor', name: 'Cursor', format: 'json', map: 'mcpServers',
    executable: 'cursor',
    dirSignal: (ctx) => join(ctx.home, '.cursor'),
    appDirs: (ctx) => [join(ctx.home, 'Applications', 'Cursor.app')],
    config: (ctx) => join(ctx.home, '.cursor', 'mcp.json'),
  },
  {
    id: 'windsurf', name: 'Windsurf', format: 'json', map: 'mcpServers',
    executable: 'windsurf',
    dirSignal: (ctx) => join(ctx.home, '.codeium', 'windsurf'),
    appDirs: (ctx) => [join(ctx.home, 'Applications', 'Windsurf.app')],
    config: (ctx) => join(ctx.home, '.codeium', 'windsurf', 'mcp_config.json'),
  },
  {
    id: 'devin', name: 'Devin', format: 'json', map: 'mcpServers',
    dirSignal: (ctx) => join(xdgConfig(ctx), 'devin'),
    config: (ctx) => join(xdgConfig(ctx), 'devin', 'mcp_config.json'),
  },
  {
    id: 'gemini', name: 'Gemini CLI', format: 'json', map: 'mcpServers',
    executable: 'gemini',
    dirSignal: (ctx) => join(ctx.home, '.gemini'),
    config: (ctx) => join(ctx.home, '.gemini', 'settings.json'),
  },
  {
    id: 'cline', name: 'Cline', format: 'json', map: 'mcpServers',
    extensionId: 'saoudrizwan.claude-dev',
    // No directory signal: a VS Code globalStorage folder alone proves nothing.
    config: (ctx) => {
      if (ctx.env.CLINE_MCP_SETTINGS_PATH) return ctx.env.CLINE_MCP_SETTINGS_PATH;
      const modern = join(ctx.home, '.cline', 'data', 'settings', 'cline_mcp_settings.json');
      if (isFile(modern)) return modern;
      const legacy = globalStorage(ctx, 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
      return isFile(legacy) ? legacy : modern;
    },
  },
  {
    id: 'roo-code', name: 'Roo Code', format: 'json', map: 'mcpServers',
    extensionId: 'rooveterinaryinc.roo-cline',
    config: (ctx) => globalStorage(ctx, 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
  },
];

export const CLIENT_IDS: readonly string[] = TARGETS.map((t) => t.id);

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function pathExecutable(ctx: Ctx, name: string): boolean {
  const pathVar = ctx.env.PATH;
  if (!pathVar) return false;
  const exts = ctx.platform === 'win32'
    ? (ctx.env.PATHEXT || '.exe;.cmd;.bat').split(';')
    : [''];
  for (const dir of pathVar.split(ctx.platform === 'win32' ? ';' : path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      if (isFile(join(dir, name + ext))) return true;
    }
  }
  return false;
}

// Injected options never fall back to the real machine: env defaults to {} when
// any of home/platform/env is supplied, so tests cannot leak the developer home.
function resolveCtx(options: DetectOptions | undefined): Ctx {
  const injected = options !== undefined
    && (options.home !== undefined || options.platform !== undefined || options.env !== undefined);
  return {
    platform: options?.platform ?? process.platform,
    home: options?.home ?? os.homedir(),
    env: options?.env ?? (injected ? {} : process.env),
  };
}

export function detectClients(options?: DetectOptions): ClientInfo[] {
  const ctx = resolveCtx(options);
  const systemInstallations = options?.home === undefined && options?.platform === undefined && options?.env === undefined;
  const installed = new Set((options?.extensionIds ?? []).map((s) => String(s).toLowerCase()));
  return TARGETS.map((t) => {
    const configPath = t.config(ctx);
    const reasons: string[] = [];
    if (isFile(configPath)) {
      reasons.push('config file present');
    } else if (t.dirSignal) {
      const dir = t.dirSignal(ctx);
      if (dir && isDirectory(dir)) reasons.push('application directory present');
    }
    if (t.extensionId && installed.has(t.extensionId.toLowerCase())) {
      reasons.push(`extension ${t.extensionId} installed`);
    }
    if (t.executable && pathExecutable(ctx, t.executable)) {
      reasons.push(`executable ${t.executable} on PATH`);
    }
    if (t.appDirs) {
      for (const d of t.appDirs(ctx)) {
        if (isDirectory(d)) { reasons.push('application bundle present'); break; }
      }
    }
    const bundleNames: Record<string,string> = { 'claude-desktop':'Claude',codex:'Codex',cursor:'Cursor',windsurf:'Windsurf',devin:'Devin' };
    const bundle = bundleNames[t.id];
    if (systemInstallations && ctx.platform === 'darwin' && bundle && isDirectory(`/Applications/${bundle}.app`)) reasons.push('installed application bundle');
    if (ctx.platform === 'win32' && bundle && ctx.env.LOCALAPPDATA &&
      [join(ctx.env.LOCALAPPDATA,'Programs',bundle,`${bundle}.exe`),join(ctx.env.LOCALAPPDATA,bundle,`${bundle}.exe`)].some(isFile)) reasons.push('installed application executable');
    return {
      id: t.id, name: t.name, configPath, format: t.format,
      detected: reasons.length > 0,
      reason: reasons.length > 0 ? reasons.join('; ') : 'not detected',
    };
  });
}

// ---------------------------------------------------------------- write engine

interface Loaded {
  text: string;
  root: Record<string, unknown>;
  map: Record<string, unknown> | null;
  existed: boolean;
  mode: number;
}

function targetOf(id: string): Target {
  const t = TARGETS.find((x) => x.id === id);
  if (!t) throw new TypeError(`unknown client id: ${String(id)}`);
  return t;
}

function fail(t: Target, configPath: string, message: string): ClientResult {
  return { id: t.id, name: t.name, configPath, status: 'error', message };
}

function done(t: Target, configPath: string, status: ClientResult['status'], message: string): ClientResult {
  return { id: t.id, name: t.name, configPath, status, message };
}

// Refuses symlink files and symlink ancestors; missing directories are skipped
// so the walk still reaches the filesystem root.
function symlinkProblem(configPath: string): string | null {
  let node = path.resolve(configPath);
  for (;;) {
    let st: fs.Stats | null = null;
    try { st = fs.lstatSync(node); } catch { st = null; }
    if (st && st.isSymbolicLink()) {
      return node === path.resolve(configPath)
        ? 'refusing: config file is a symlink'
        : 'refusing: a parent directory of the config is a symlink';
    }
    const parent = path.dirname(node);
    if (parent === node) break;
    node = parent;
  }
  return null;
}

function duplicateMapKey(text: string, key: string): boolean {
  const tree = jsonc.parseTree(text, [], { disallowComments: false, allowTrailingComma: true });
  if (!tree || tree.type !== 'object') return false;
  let seen = 0;
  for (const prop of tree.children ?? []) {
    const name = prop.type === 'property' ? prop.children?.[0] : undefined;
    if (name && name.type === 'string' && name.value === key) {
      seen += 1;
      const names = new Set<string>();
      for (const entry of prop.children?.[1]?.children ?? []) {
        const entryName = entry.children?.[0]?.value;
        if (typeof entryName !== 'string') continue;
        if (names.has(entryName)) return true;
        names.add(entryName);
      }
    }
  }
  return seen > 1;
}

function loadConfig(t: Target, configPath: string): Loaded | string {
  const link = symlinkProblem(configPath);
  if (link) return link;
  let st: fs.Stats;
  try {
    st = fs.lstatSync(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', root: {}, map: null, existed: false, mode: 0o600 };
    return 'cannot inspect the config file';
  }
  if (!st.isFile()) return 'refusing: config path is not a regular file';
  if (st.size > MAX_CONFIG_BYTES) return 'refusing: config file is larger than 2 MiB';
  let text: string;
  try { text = fs.readFileSync(configPath, 'utf8'); } catch { return 'cannot read config file' }
  const mode = st.mode & 0o777;
  if (t.format === 'json') {
    const errors: jsonc.ParseError[] = [];
    const root = jsonc.parse(text, errors, { disallowComments: false, allowTrailingComma: true });
    if (errors.length > 0 || root === undefined) return 'refusing: config has invalid JSON syntax';
    if (root === null || typeof root !== 'object' || Array.isArray(root)) {
      return 'refusing: config root is not an object';
    }
    if (duplicateMapKey(text, t.map)) return `refusing: config has more than one "${t.map}" section`;
    const raw = (root as Record<string, unknown>)[t.map];
    let map: Record<string, unknown> | null = null;
    if (raw !== undefined) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return `refusing: "${t.map}" is not an object`;
      }
      map = raw as Record<string, unknown>;
    }
    return { text, root: root as Record<string, unknown>, map, existed: true, mode };
  }
  let root: Record<string, unknown>;
  try { root = parseToml(text) as Record<string, unknown>; } catch { return 'refusing: config has invalid TOML syntax' }
  const raw = root[t.map];
  let map: Record<string, unknown> | null = null;
  if (raw !== undefined) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return `refusing: "${t.map}" is not a table`;
    map = raw as Record<string, unknown>;
  }
  return { text, root, map, existed: true, mode };
}

function sameArgs(a: unknown, b: string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
}

function isOwned(entry: unknown, reg: Registration): boolean {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  return e.command === reg.command && sameArgs(e.args, reg.args);
}

const MODIFY_OPTIONS = {
  formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' },
  parse: { disallowComments: false, allowTrailingComma: true },
} as const;

// jsonc modify/applyEdits keeps unrelated text and comments, and creates the
// server map itself when it is missing.
function editJson(text: string, mapName: string, value: unknown): string {
  return jsonc.applyEdits(text, jsonc.modify(text, [mapName, AGENT_NAME], value, MODIFY_OPTIONS));
}

// Mutates the parsed TOML tree in place: a JSON roundtrip would turn TomlDate
// and other typed values into plain strings.
function editToml(loaded: Loaded, mapName: string, value: unknown): string {
  let map = loaded.root[mapName];
  if (map === undefined) {
    if (value === undefined) return loaded.text;
    map = {};
    loaded.root[mapName] = map;
  }
  if (map === null || typeof map !== 'object' || Array.isArray(map)) return loaded.text;
  const target = map as Record<string, unknown>;
  if (value === undefined) delete target[AGENT_NAME];
  else target[AGENT_NAME] = value;
  return stringifyToml(loaded.root);
}

// Exclusive lockfile, refused immediately when held (never blocks the host),
// then a byte-for-byte recheck of the original and a revalidated atomic rename.
function writeConfig(configPath: string, text: string, mode: number, originalText: string | null): string | null {
  const target = path.resolve(configPath);
  const dir = path.dirname(target);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return 'cannot create the config directory' }
  const lockPath = target + LOCK_SUFFIX;
  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    fs.closeSync(fd);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') return 'refusing: config is locked by another writer';
    return 'cannot create the config lock file';
  }
  const tmpPath = `${target}.agentdesklink.tmp-${process.pid}`;
  try {
    const recheck = symlinkProblem(target);
    if (recheck) return recheck;
    let current: string | null;
    try { current = fs.readFileSync(target, 'utf8'); } catch { current = null; }
    if (current !== originalText) return 'refusing: config changed since it was read';
    const fd = fs.openSync(tmpPath, 'wx', 0o600);
    try { fs.writeFileSync(fd, text, 'utf8'); } finally { fs.closeSync(fd); }
    try { fs.chmodSync(tmpPath, mode); } catch { /* keep owner-only default */ }
    const link = symlinkProblem(target);
    if (link) return link;
    let latest: string | null;
    try { latest = fs.readFileSync(target,'utf8'); } catch { latest = null; }
    if (latest !== originalText) return 'refusing: config changed before replacement';
    try { fs.renameSync(tmpPath, target); } catch { return 'cannot replace the config file' }
    return null;
  } catch {
    return 'cannot write the config file';
  } finally {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ }
  }
}

function validateRegistration(reg: Registration): string | null {
  if (reg === null || typeof reg !== 'object') return 'registration must be an object';
  if (typeof reg.command !== 'string' || reg.command.length === 0) return 'registration.command must be a non-empty string';
  if (!Array.isArray(reg.args) || reg.args.some((a) => typeof a !== 'string')) {
    return 'registration.args must be an array of strings';
  }
  return null;
}

export function inspectClient(client: ClientInfo, registration: Registration): ClientResult {
  const t = targetOf(client.id);
  const bad = validateRegistration(registration);
  if (bad) throw new TypeError(bad);
  const loaded = loadConfig(t, client.configPath);
  if (typeof loaded === 'string') return fail(t, client.configPath, loaded);
  const entry = loaded.map ? loaded.map[AGENT_NAME] : undefined;
  if (entry === undefined) return done(t, client.configPath, 'disabled', 'AgentDeskLink MCP entry is not configured');
  if (isOwned(entry, registration)) {
    const value = entry as Record<string, unknown>;
    return done(t, client.configPath, value.disabled === true || value.enabled === false ? 'disabled' : 'enabled', 'AgentDeskLink managed registration');
  }
  return done(t, client.configPath, 'conflict',
    `an entry named "${AGENT_NAME}" already exists with a different command or args`);
}

export function configureClient(client: ClientInfo, registration: Registration, enabled: boolean): ClientResult {
  const t = targetOf(client.id);
  const bad = validateRegistration(registration);
  if (bad) throw new TypeError(bad);
  const configPath = client.configPath;
  const loaded = loadConfig(t, configPath);
  if (typeof loaded === 'string') return fail(t, configPath, loaded);

  const existing = loaded.map ? loaded.map[AGENT_NAME] : undefined;
  if (existing !== undefined && !isOwned(existing, registration)) {
    return done(t, configPath, 'conflict',
      `refusing to overwrite the foreign entry named "${AGENT_NAME}"`);
  }
  if (!enabled && existing === undefined) {
    return done(t, configPath, 'disabled', 'nothing to remove: no AgentDeskLink entry is configured');
  }
  const old = existing as Record<string,unknown> | undefined;
  if (enabled && old !== undefined && old.disabled !== true && old.enabled !== false) {
    return done(t, configPath, 'enabled', 'AgentDeskLink MCP entry is already configured');
  }

  const value = enabled ? { ...old, command: registration.command, args: [...registration.args],
    ...(old?.disabled === true ? {disabled:false} : {}), ...(old?.enabled === false ? {enabled:true} : {}) } : undefined;
  let text: string;
  try {
    text = t.format === 'json' ? editJson(loaded.text, t.map, value) : editToml(loaded, t.map, value);
  } catch { return fail(t, configPath, 'cannot build the updated config') }
  if (Buffer.byteLength(text,'utf8') > MAX_CONFIG_BYTES) return fail(t,configPath,'updated config would exceed 2 MiB');
  if (text === loaded.text) {
    return done(t, configPath, enabled ? 'enabled' : 'disabled', 'config already in the requested state');
  }
  const err = writeConfig(configPath, text, loaded.mode, loaded.existed ? loaded.text : null);
  if (err) return fail(t, configPath, err);
  return done(t, configPath, enabled ? 'enabled' : 'disabled',
    enabled ? `enabled AgentDeskLink MCP entry in ${configPath}` : `removed AgentDeskLink MCP entry from ${configPath}`);
}
