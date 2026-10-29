const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cleanups = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});
const registration = { command: '/managed/node', args: ['/managed/launcher.cjs', '/managed/launch.json'] };
async function setup(platform = process.platform) {
  const api = await import('../../dist/src/extension/ai-clients.js');
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'adl-clients-contract-'));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = {
    PATH: '',
    APPDATA: path.join(home, 'Roaming'),
    LOCALAPPDATA: path.join(home, 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
  };
  const options = { home, platform, env, extensionIds: [] };
  const rows = api.detectClients(options);
  return {
    ...api,
    home,
    env,
    options,
    rows,
    get: id => rows.find(c => c.id === id),
    put(id, text) {
      const c = rows.find(c => c.id === id);
      fs.mkdirSync(path.dirname(c.configPath), { recursive: true });
      fs.writeFileSync(c.configPath, text);
      return c;
    },
  };
}
test('a fresh home detects no clients, including Claude Code whose config is directly in home', async () => {
  const f = await setup();
  assert.deepEqual(
    f.rows.filter(c => c.detected).map(c => c.id),
    [],
  );
});
test('macOS Claude Desktop uses Application Support, while env overrides and injected PATH detection work', async () => {
  const f = await setup('darwin');
  assert.equal(
    f.get('claude-desktop').configPath,
    path.join(f.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  );
  const bin = path.join(f.home, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n');
  fs.chmodSync(path.join(bin, 'claude'), 0o700);
  const rows = f.detectClients({
    ...f.options,
    env: {
      ...f.env,
      PATH: bin,
      CODEX_HOME: path.join(f.home, 'alternate-codex'),
      CLAUDE_CONFIG_DIR: path.join(f.home, 'alternate-claude'),
    },
  });
  assert.equal(rows.find(c => c.id === 'claude-code').detected, true);
  assert.equal(rows.find(c => c.id === 'codex').configPath, path.join(f.home, 'alternate-codex', 'config.toml'));
  assert.equal(
    rows.find(c => c.id === 'claude-code').configPath,
    path.join(f.home, 'alternate-claude', '.claude.json'),
  );
});
test('enable/disable changes an existing JSONC map and preserves comments and unknown settings', async () => {
  const f = await setup();
  const c = f.put(
    'cursor',
    '{\n// keep comment\n"secret":"preserve","mcpServers":{"existing":{"command":"keep"}},\n}\n',
  );
  assert.equal(f.configureClient(c, registration, true).status, 'enabled');
  const first = fs.readFileSync(c.configPath, 'utf8');
  const { parse } = require('jsonc-parser');
  assert.deepEqual(parse(first).mcpServers.agentdesklink, registration);
  assert.match(first, /keep comment/);
  assert.equal(parse(first).secret, 'preserve');
  assert.equal(f.configureClient(c, registration, true).status, 'enabled');
  assert.equal(fs.readFileSync(c.configPath, 'utf8'), first);
  assert.equal(f.configureClient(c, registration, false).status, 'disabled');
  const last = fs.readFileSync(c.configPath, 'utf8');
  assert.equal(parse(last).mcpServers.agentdesklink, undefined);
  assert.equal(parse(last).mcpServers.existing.command, 'keep');
  assert.match(last, /keep comment/);
});
test('adding a missing server map preserves JSONC comments and disable absent creates nothing', async () => {
  const f = await setup();
  const c = f.put('gemini', '{\n// retain me\n"theme":"dark"\n}\n');
  assert.equal(f.configureClient(c, registration, true).status, 'enabled');
  assert.match(fs.readFileSync(c.configPath, 'utf8'), /retain me/);
  const missing = f.get('roo-code');
  assert.equal(f.configureClient(missing, registration, false).status, 'disabled');
  assert.equal(fs.existsSync(path.dirname(missing.configPath)), false);
});
test('TOML retains datetime types, quoted tables, arrays and multiline string values', async () => {
  const f = await setup();
  const original =
    'stamp = 1979-05-27T07:32:00Z\nnote = """hello\nworld"""\n["quoted.table"]\nitems=[1,2]\n[mcp_servers.other]\ncommand="keep"\n';
  const c = f.put('codex', original);
  const { parse } = await import('smol-toml');
  assert.equal(f.configureClient(c, registration, true).status, 'enabled');
  const value = parse(fs.readFileSync(c.configPath, 'utf8'));
  assert.deepEqual(value.stamp, parse(original).stamp);
  assert.equal(value.note, 'hello\nworld');
  assert.deepEqual(value['quoted.table'].items, [1, 2]);
  assert.equal(value.mcp_servers.other.command, 'keep');
  assert.equal(f.configureClient(c, registration, false).status, 'disabled');
  assert.equal(parse(fs.readFileSync(c.configPath, 'utf8')).mcp_servers.agentdesklink, undefined);
});
test('Codex edits only its TOML table, preserves CRLF and quoted/special keys, and backs up each change', async () => {
  const f = await setup();
  const reg = { command: '/old', args: ['old'] };
  const original =
    '# keep heading\r\nroot = "keep # [text]"\r\nnote = """line one\r\nescaped \\""" marker\r\n[mcp_servers.agentdesklink]\r\nline three"""\r\n["quoted.table"]\r\n"key.with.dot" = "keep"\r\n[mcp_servers]\r\n"other.server" = { command = "leave", args = ["x"] }\r\n[mcp_servers."agentdesklink"]\r\ncommand = "/old" # managed command\r\nargs = ["old"]\r\ndisabled = true\r\n[mcp_servers."agentdesklink".policy]\r\nmode = "keep?"\r\n[[models]]\r\nid = "first"\r\n[[models]]\r\nid = "second"\r\n[other]\r\n# untouched comment\r\nvalue = 3\r\n';
  const c = f.put('codex', original);
  assert.equal(f.configureClient(c, reg, true).status, 'enabled');
  let updated = fs.readFileSync(c.configPath, 'utf8');
  const { parse } = await import('smol-toml');
  const expectedEnabled = parse(original);
  expectedEnabled.mcp_servers.agentdesklink.disabled = false;
  assert.deepEqual(parse(updated), expectedEnabled, 'enabling changes only the managed table values');
  assert.equal(parse(updated).root, 'keep # [text]');
  assert.match(parse(updated).note, /\[mcp_servers\.agentdesklink\]/);
  assert.equal(parse(updated)['quoted.table']['key.with.dot'], 'keep');
  assert.deepEqual(
    parse(updated).models.map(row => row.id),
    ['first', 'second'],
  );
  assert.equal(parse(updated).mcp_servers['other.server'].command, 'leave');
  assert.equal(parse(updated).other.value, 3);
  assert.deepEqual(parse(updated).mcp_servers.agentdesklink.args, reg.args);
  assert.equal(parse(updated).mcp_servers.agentdesklink.policy.mode, 'keep?');
  assert.ok(updated.includes('# keep heading\r\n'));
  assert.ok(updated.includes('# untouched comment\r\n'));
  assert.ok(!updated.includes('\n') || updated.replace(/\r\n/g, '').indexOf('\n') === -1, 'line endings remain CRLF');
  let backups = fs
    .readdirSync(path.dirname(c.configPath))
    .filter(name => name.startsWith('config.toml.agentdesklink.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(c.configPath), backups[0]), 'utf8'), original);
  assert.equal(f.configureClient(c, reg, false).status, 'disabled');
  updated = fs.readFileSync(c.configPath, 'utf8');
  const expectedDisabled = parse(original);
  delete expectedDisabled.mcp_servers.agentdesklink;
  assert.deepEqual(parse(updated), expectedDisabled, 'disabling removes only the managed table');
  assert.equal(parse(updated).mcp_servers.agentdesklink, undefined);
  assert.equal(parse(updated).mcp_servers['other.server'].command, 'leave');
  assert.deepEqual(
    parse(updated).models.map(row => row.id),
    ['first', 'second'],
  );
  assert.ok(updated.includes('# untouched comment\r\n'));
  backups = fs
    .readdirSync(path.dirname(c.configPath))
    .filter(name => name.startsWith('config.toml.agentdesklink.bak-'));
  assert.equal(backups.length, 2);
  assert.ok(
    backups.some(name =>
      fs.readFileSync(path.join(path.dirname(c.configPath), name), 'utf8').includes('[mcp_servers."agentdesklink"]'),
    ),
  );
});
test('foreign names, malformed JSON, duplicate server names, symlinks and held locks preserve bytes', async () => {
  const f = await setup();
  for (const body of [
    '{"mcpServers":{"agentdesklink":{"command":"foreign"}}}',
    '{"mcpServers":[]}',
    '[1]',
    '{bad',
    '{"mcpServers":{},"mcpServers":{}}',
    '{"mcpServers":{"agentdesklink":{},"agentdesklink":{}}}',
  ]) {
    const c = f.put('cursor', body);
    assert.ok(['conflict', 'error'].includes(f.configureClient(c, registration, true).status));
    assert.equal(fs.readFileSync(c.configPath, 'utf8'), body);
  }
  const c = f.put('cursor', '{}');
  const lock = c.configPath + '.agentdesklink.lock';
  fs.writeFileSync(lock, 'held');
  const start = Date.now();
  assert.equal(f.configureClient(c, registration, true).status, 'error');
  assert.ok(Date.now() - start < 250, 'lock refusal must not block the extension host');
  assert.equal(fs.readFileSync(c.configPath, 'utf8'), '{}');
  fs.unlinkSync(lock);
  fs.unlinkSync(c.configPath);
  const target = path.join(f.home, 'target.json');
  fs.writeFileSync(target, '{}');
  fs.symlinkSync(target, c.configPath);
  assert.equal(f.configureClient(c, registration, true).status, 'error');
  assert.equal(fs.readFileSync(target, 'utf8'), '{}');
});

test('Codex config stays intact if creating its backup fails', async () => {
  const f = await setup();
  const original = '[mcp_servers.other]\r\ncommand="keep"\r\n';
  const c = f.put('codex', original);
  const copy = fs.copyFileSync;
  const { syncBuiltinESMExports } = require('node:module');
  fs.copyFileSync = function () {
    throw new Error('injected backup failure');
  };
  syncBuiltinESMExports();
  try {
    const result = f.configureClient(c, registration, true);
    assert.equal(result.status, 'error');
    assert.equal(fs.readFileSync(c.configPath, 'utf8'), original);
  } finally {
    fs.copyFileSync = copy;
    syncBuiltinESMExports();
  }
  assert.equal(
    fs.readdirSync(path.dirname(c.configPath)).some(name => name.startsWith('config.toml.agentdesklink.bak-')),
    false,
  );
});

test('bulk enable restores an owned server disabled inside a client without discarding tool policy', async () => {
  const f = await setup();
  for (const [id, extra] of [
    ['cline', { disabled: true, alwaysAllow: ['read'] }],
    ['codex', { enabled: false, disabled_tools: ['write'] }],
  ]) {
    const c = f.get(id);
    fs.mkdirSync(path.dirname(c.configPath), { recursive: true });
    const { stringify, parse } = await import('smol-toml');
    const value = { ...registration, ...extra };
    fs.writeFileSync(
      c.configPath,
      id === 'codex'
        ? stringify({ mcp_servers: { agentdesklink: value } })
        : JSON.stringify({ mcpServers: { agentdesklink: value } }),
    );
    assert.equal(f.inspectClient(c, registration).status, 'disabled');
    assert.equal(f.configureClient(c, registration, true).status, 'enabled');
    const parsed =
      id === 'codex'
        ? parse(fs.readFileSync(c.configPath, 'utf8')).mcp_servers.agentdesklink
        : JSON.parse(fs.readFileSync(c.configPath, 'utf8')).mcpServers.agentdesklink;
    assert.notEqual(parsed.disabled, true);
    assert.notEqual(parsed.enabled, false);
    assert.deepEqual(parsed.disabled_tools ?? parsed.alwaysAllow, extra.disabled_tools ?? extra.alwaysAllow);
  }
});

test('a concurrent editor changing the file during temporary write wins without data loss', async () => {
  const f = await setup();
  const c = f.put('cursor', '{}');
  const write = fs.writeFileSync;
  const { syncBuiltinESMExports } = require('node:module');
  let injected = false;
  fs.writeFileSync = function (file, ...args) {
    const value = write.call(fs, file, ...args);
    if (!injected && typeof file === 'number') {
      injected = true;
      write.call(fs, c.configPath, '{"concurrent":true}');
    }
    return value;
  };
  syncBuiltinESMExports();
  try {
    assert.equal(f.configureClient(c, registration, true).status, 'error');
    assert.equal(fs.readFileSync(c.configPath, 'utf8'), '{"concurrent":true}');
  } finally {
    fs.writeFileSync = write;
    syncBuiltinESMExports();
  }
});

test('Claude config over 2 MiB stays editable up to the 16 MiB bound and keeps JSONC comments', async () => {
  const f = await setup();
  const body =
    '{\n// preserve large config\n\"payload\":\"' + 'x'.repeat(3 * 1024 * 1024) + '\",\n\"mcpServers\":{}\n}';
  const c = f.put('claude-code', body);
  assert.equal(f.configureClient(c, registration, true).status, 'enabled');
  const updated = fs.readFileSync(c.configPath, 'utf8');
  assert.ok(updated.length > 2 * 1024 * 1024);
  assert.match(updated, /preserve large config/);
  assert.match(updated, /agentdesklink/);
  assert.equal(f.configureClient(c, registration, false).status, 'disabled');
  assert.match(fs.readFileSync(c.configPath, 'utf8'), /preserve large config/);
});
