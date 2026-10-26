const {test, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cleanups = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });

const REG = {command: '/managed/node', args: ['/managed/launcher.cjs', '/managed/launch.json']};

async function api() { return await import('../../dist/src/extension/ai-clients.js'); }

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-clients-'));
  cleanups.push(() => fs.rmSync(home, {recursive: true, force: true}));
  return home;
}

function fixture(platform, extra = {}) {
  const home = tmpHome();
  const env = {PATH: '', APPDATA: path.join(home, 'Roaming'), XDG_CONFIG_HOME: path.join(home, '.config'), ...extra};
  return {home, env, options: {home, platform, env, extensionIds: []}};
}

async function rowsFor(platform, extra) {
  const a = await api();
  const f = fixture(platform, extra);
  return {a, f, rows: a.detectClients(f.options), get: (id) => f.rows?.find?.(c => c.id === id)};
}

function find(rows, id) { const c = rows.find(x => x.id === id); assert.ok(c, `missing client ${id}`); return c; }

test('CLIENT_IDS lists every supported target and detectClients returns all of them', async () => {
  const a = await api();
  assert.deepEqual([...a.CLIENT_IDS].sort(), ['claude-code', 'claude-desktop', 'cline', 'codex', 'cursor',
    'devin', 'gemini', 'roo-code', 'windsurf'].sort());
  const {a: api2, f} = await rowsFor('linux');
  const rows = api2.detectClients(f.options);
  assert.deepEqual(rows.map(r => r.id).sort(), [...api2.CLIENT_IDS].sort());
  for (const r of rows) {
    assert.equal(typeof r.name, 'string');
    assert.equal(typeof r.reason, 'string');
    assert.ok(['json', 'toml'].includes(r.format));
    assert.equal(typeof r.detected, 'boolean');
  }
});

test('per-target config paths on macOS, Linux and Windows', async () => {
  const mac = (await rowsFor('darwin'));
  const lin = (await rowsFor('linux'));
  const win = (await rowsFor('win32'));
  const expect = {
    'claude-code': (h, p) => path.join(h, '.claude.json'),
    'claude-desktop': (h, p) => p === 'darwin'
      ? path.join(h, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : p === 'win32'
        ? path.join(h, 'Roaming', 'Claude', 'claude_desktop_config.json')
        : path.join(h, '.config', 'Claude', 'claude_desktop_config.json'),
    'codex': (h) => path.join(h, '.codex', 'config.toml'),
    'cursor': (h) => path.join(h, '.cursor', 'mcp.json'),
    'windsurf': (h) => path.join(h, '.codeium', 'windsurf', 'mcp_config.json'),
    'devin': (h, p) => p === 'win32'
      ? path.join(h, 'Roaming', 'devin', 'mcp_config.json')
      : path.join(h, '.config', 'devin', 'mcp_config.json'),
    'gemini': (h) => path.join(h, '.gemini', 'settings.json'),
    'cline': (h) => path.join(h, '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
    'roo-code': (h, p) => p === 'darwin'
      ? path.join(h, 'Library', 'Application Support', 'Code', 'User', 'globalStorage',
        'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json')
      : p === 'win32'
        ? path.join(h, 'Roaming', 'Code', 'User', 'globalStorage',
          'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json')
        : path.join(h, '.config', 'Code', 'User', 'globalStorage',
          'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
  };
  for (const [id, fn] of Object.entries(expect)) {
    assert.equal(find(mac.rows, id).configPath, fn(mac.f.home, 'darwin'), `darwin ${id}`);
    assert.equal(find(lin.rows, id).configPath, fn(lin.f.home, 'linux'), `linux ${id}`);
    assert.equal(find(win.rows, id).configPath, fn(win.f.home, 'win32'), `win32 ${id}`);
  }
  assert.equal(find(lin.rows, 'codex').format, 'toml');
});
