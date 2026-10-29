const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function panel(language = 'ja') {
  const elements = new Map(),
    messages = [],
    listeners = new Map();
  const make = () => ({
    value: '',
    _text: '',
    children: [],
    checked: false,
    disabled: false,
    dataset: {},
    listeners: new Map(),
    set textContent(value) {
      this._text = value;
      this.children = [];
    },
    get textContent() {
      return this._text + this.children.map(c => c.textContent).join('');
    },
    appendChild(child) {
      this.children.push(child);
    },
    click() {
      return this.trigger('click');
    },
    setAttribute(key, value) {
      this[key] = value;
    },
    getAttribute(key) {
      return typeof this[key] === 'string' ? this[key] : null;
    },
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    },
    async trigger(type) {
      await this.listeners.get(type)?.({ target: this, preventDefault() {} });
    },
  });
  const get = id => {
    if (!elements.has(id)) elements.set(id, make());
    return elements.get(id);
  };
  const document = {
    getElementById: get,
    createElement: make,
    activeElement: null,
    documentElement: { lang: language },
    querySelectorAll: () =>
      [...elements.values()].filter(el =>
        ['aria-label', 'title', 'placeholder'].some(key => typeof el[key] === 'string'),
      ),
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../media/settings.js'), 'utf8'), {
    acquireVsCodeApi: () => ({ postMessage: data => messages.push(data), getState: () => ({}), setState() {} }),
    document,
    window: { addEventListener: (type, listener) => listeners.set(type, listener) },
    URL,
    console,
    setTimeout,
    clearTimeout,
  });
  return {
    get,
    messages,
    document,
    state: data => listeners.get('message')({ data: { type: 'state', ...data } }),
    raw: data => listeners.get('message')({ data }),
  };
}

test('permission summary separates target, physical and image grants and displays values as text', () => {
  const p = panel();
  p.state({
    permissions: {
      browserOrigins: [],
      desktopAppId: '',
      allowAllOperations: false,
      allowPhysicalInput: false,
      allowUnredactedImages: false,
      allowLoopback: false,
      allowPrivateNetwork: false,
    },
  });
  assert.equal(p.get('permissions').children.length, 8);
  assert.match(p.get('permissions').textContent, /なし/);
  assert.equal(p.get('permissions-hint').textContent, 'MCP を有効にしても権限は付きません。');
  const value = '<img src=x onerror=alert(1)>';
  p.state({
    permissions: {
      browserOrigins: [value],
      desktopAppId: 'test.app',
      allowAllOperations: true,
      allowPhysicalInput: false,
      allowUnredactedImages: true,
      allowLoopback: false,
      allowPrivateNetwork: false,
    },
  });
  const rows = p.get('permissions').children;
  assert.equal(rows[0].children[1].textContent, value);
  assert.equal(rows[0].children[1].innerHTML, undefined);
  assert.match(rows[3].children[1].textContent, /オフ/);
  assert.match(rows[4].children[1].textContent, /有効/);
});

test('language switch selects the host language, translates dynamic text, and posts no host message', async () => {
  const p = panel('ja');
  p.state({ status: { mcp: 'MCP は無効です。 / MCP is disabled.' } });
  const selector = p.get('ui-language');
  assert.equal(selector.value, 'ja');
  assert.equal(p.get('mcp-status').textContent, 'MCP は無効です。');
  const messages = p.messages.length;
  selector.value = 'en';
  await selector.trigger('change');
  assert.equal(p.document.documentElement.lang, 'en');
  assert.equal(p.get('mcp-status').textContent, 'MCP is disabled.');
  assert.equal(p.messages.length, messages);
  const en = panel('en');
  assert.equal(en.get('ui-language').value, 'en', 'non-Japanese host language defaults to English');
});

test('client counts stay in one language after a local language switch', () => {
  const p = panel('ja');
  p.state({
    clients: {
      busy: false,
      error: '',
      rows: [
        { name: 'Claude', detected: true, status: 'enabled' },
        { name: 'Cursor', detected: true, status: 'disabled' },
      ],
    },
  });
  assert.equal(p.get('clients-status').textContent, '2 件を検出 1 件に登録済み');
  p.get('ui-language').value = 'en';
  p.get('ui-language').listeners.get('change')();
  assert.equal(p.get('clients-status').textContent, '2 detected 1 configured');
});

test('browser origins can be added and removed using text-only rows', async () => {
  const p = panel();
  p.state({ trusted: true, hasFolder: true, settings: { browserOrigins: ['https://example.com'] } });
  const list = p.get('origins-list');
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[0].textContent, 'https://example.com');
  assert.equal(list.children[0].children[0].innerHTML, undefined);
  await list.children[0].children[1].trigger('click');
  assert.equal(p.messages.at(-1).type, 'setBrowserOrigins');
  assert.deepEqual(Array.from(p.messages.at(-1).origins), []);
  p.get('origin-input').value = 'https://second.example';
  await p.get('origin-add').trigger('click');
  assert.equal(p.messages.at(-1).type, 'setBrowserOrigins');
  assert.deepEqual(Array.from(p.messages.at(-1).origins), ['https://example.com', 'https://second.example']);
});

test('loopback input only suggests an explicit grant and grant controls stay workspace locked', async () => {
  const p = panel();
  p.state({
    trusted: true,
    hasFolder: true,
    settings: { allowLoopback: false, allowPrivateNetwork: false, allowPersonalData: false },
  });
  const input = p.get('origin-input'),
    hint = p.get('loopback-suggestion'),
    grant = p.get('allow-loopback');
  input.value = 'http://localhost:3000';
  await input.trigger('input');
  assert.equal(hint.hidden, false);
  assert.equal(grant.checked, false, 'suggestion does not grant loopback');
  input.value = 'http://127.0.0.1:3000/';
  await input.trigger('input');
  assert.equal(hint.hidden, false);
  input.value = 'http://[::1]:3000';
  await input.trigger('input');
  assert.equal(hint.hidden, false);
  input.value = 'http://localhost:3000/path';
  await input.trigger('input');
  assert.equal(hint.hidden, true, 'non-origin URLs do not trigger the loopback hint');
  input.value = 'https://example.com';
  await input.trigger('input');
  assert.equal(hint.hidden, true);
  grant.checked = true;
  await grant.trigger('change');
  assert.equal(p.messages.at(-1).type, 'setAllowLoopback');
  assert.equal(p.messages.at(-1).enabled, true);
  p.state({
    trusted: false,
    hasFolder: true,
    settings: { allowLoopback: false, allowPrivateNetwork: false, allowPersonalData: false },
  });
  assert.equal(grant.disabled, true);
  assert.equal(p.get('allow-private-network').disabled, true);
  assert.equal(p.get('allow-personal-data').disabled, true);
});
test('resource origins use a separate text-only list and a distinct message', async () => {
  const p = panel();
  p.state({ trusted: true, hasFolder: true, settings: { browserResourceOrigins: ['https://cdn.example'] } });
  assert.equal(p.get('resource-origins-list').children[0].children[0].textContent, 'https://cdn.example');
  p.get('resource-origin-input').value = 'https://other.example';
  await p.get('resource-origin-add').trigger('click');
  assert.equal(p.messages.at(-1).type, 'setBrowserResourceOrigins');
  assert.deepEqual(Array.from(p.messages.at(-1).origins), ['https://cdn.example', 'https://other.example']);
});
test('session idle timeout control sends whole minutes and stays locked without trust', async () => {
  const p = panel();
  p.state({ trusted: true, hasFolder: true, settings: { sessionIdleMinutes: 15 } });
  const input = p.get('session-idle-minutes');
  assert.equal(input.value, '15');
  input.value = '30';
  await input.trigger('change');
  assert.equal(p.messages.at(-1).type, 'setSessionIdleMinutes');
  assert.equal(p.messages.at(-1).minutes, 30);
  p.state({ trusted: false, hasFolder: true, settings: { sessionIdleMinutes: 15 } });
  assert.equal(input.disabled, true);
});

test('headless and public proxy controls keep their runtime values in the webview only', async () => {
  const p = panel();
  p.state({ trusted: true, hasFolder: true, settings: { browserHeadless: true, browserProxyServer: '' } });
  const headless = p.get('browser-headless');
  headless.checked = false;
  await headless.trigger('change');
  assert.equal(p.messages.at(-1).type, 'setBrowserHeadless');
  assert.equal(p.messages.at(-1).enabled, false);
  const proxy = p.get('browser-proxy-server');
  proxy.value = 'https://proxy.example:8443';
  await proxy.trigger('change');
  assert.equal(p.messages.at(-1).type, 'setBrowserProxyServer');
  assert.equal(p.messages.at(-1).proxy, 'https://proxy.example:8443');
  p.state({ trusted: false, hasFolder: true, settings: { browserHeadless: true, browserProxyServer: '' } });
  assert.equal(headless.disabled, true);
  assert.equal(proxy.disabled, true);
});

test('webview synchronizes saved toggles and locks only workspace settings without trust', async () => {
  const p = panel();
  p.state({ trusted: false, hasFolder: true, settings: { enabled: false, autoUpdate: true, checkForUpdates: true } });
  assert.equal(p.get('enabled').disabled, true);
  assert.equal(p.get('auto-update').disabled, false);
  p.state({ trusted: true, hasFolder: true, settings: { enabled: false } });
  const enabled = p.get('enabled');
  enabled.checked = true;
  await enabled.trigger('change');
  assert.equal(enabled.disabled, true);
  assert.ok(p.messages.some(x => x.type === 'setEnabled' && x.enabled === true));
  p.state({ trusted: true, hasFolder: true, busy: { enabled: false }, settings: { enabled: false } });
  assert.equal(enabled.disabled, false);
  assert.equal(enabled.checked, false, 'failed saves restore persisted state');
});

test('manual update button becomes usable again after the host finishes a check', async () => {
  const p = panel();
  await p.get('check-now').trigger('click');
  assert.equal(p.get('check-now').disabled, true);
  assert.ok(p.messages.some(x => x.type === 'checkForUpdates'));
  p.state({ busy: { checkNow: false }, status: { update: '最新のバージョンです。' } });
  assert.equal(p.get('check-now').disabled, false);
});

test('removed update source controls post nothing and errors are displayed as text', async () => {
  const p = panel();
  for (const id of ['manifest-url', 'manifest-save']) {
    assert.equal(p.get(id).listeners.size, 0, `${id} has no listeners`);
    await p.get(id).trigger('click');
    await p.get(id).trigger('change');
  }
  p.state({
    settings: { updateManifestUrl: 'https://saved.example/update.json' },
    status: { mcpError: '<img src=x onerror=alert(1)>' },
  });
  assert.equal(p.get('manifest-url').value, '', 'legacy source state is ignored');
  assert.deepEqual(
    p.messages.map(x => x.type),
    ['ready'],
  );
  assert.equal(p.get('mcp-error').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(p.get('mcp-error').innerHTML, undefined);
});

test('removed node and policy controls post no webview messages', async () => {
  const p = panel();
  p.state({ trusted: true, hasFolder: true, settings: { enabled: false } });
  for (const id of ['node-path', 'node-save', 'config-path', 'config-save', 'config-select', 'config-open']) {
    const el = p.get(id);
    assert.equal(el.listeners.size, 0, `${id} has no listeners`);
    await el.trigger('click');
  }
  assert.deepEqual(
    p.messages.map(x => x.type),
    ['ready'],
  );
});

test('emergency stop posts immediately and stays enabled despite trust lock and unrelated busy flags', async () => {
  const p = panel();
  p.state({ trusted: false, hasFolder: false, stopped: false, busy: { enabled: true, check: true, checkNow: true } });
  const stop = p.get('emergency-stop');
  assert.equal(stop.disabled, false, 'stop stays accessible when untrusted and other operations are busy');
  await stop.trigger('click');
  await stop.trigger('click');
  assert.deepEqual(
    p.messages.filter(x => x.type === 'emergencyStop').map(x => x.type),
    ['emergencyStop', 'emergencyStop'],
  );
});

test('resume button appears only while stopped and posts resumeOperations', async () => {
  const p = panel();
  p.state({ stopped: false });
  assert.equal(p.get('resume-operations').hidden, true);
  p.state({ stopped: true });
  const resume = p.get('resume-operations');
  assert.equal(resume.hidden, false);
  assert.equal(p.get('stopped-status').hidden, false);
  await resume.trigger('click');
  assert.ok(p.messages.some(x => x.type === 'resumeOperations'));
  assert.equal(resume.disabled, true, 'resume shows busy feedback until the host answers');
  p.state({ stopped: true, busy: { resume: false } });
  assert.equal(resume.disabled, false);
  p.state({ stopped: false, busy: { resume: false } });
  assert.equal(resume.hidden, true);
  assert.equal(p.get('stopped-status').hidden, true);
});

test('emergency stop remains clickable while stop itself is busy; hidden controls stay hidden', () => {
  const p = panel();
  p.state({ stopped: false, busy: { stop: true } });
  assert.equal(p.get('emergency-stop').disabled, false);
  const css = fs.readFileSync(path.join(__dirname, '../../media/settings.css'), 'utf8');
  assert.match(css, /\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/);
});

test('bulk client controls show detection and per-client errors as text, and disabling stays available', async () => {
  const p = panel();
  p.state({
    trusted: false,
    hasFolder: false,
    busy: { clients: true },
    clients: {
      busy: true,
      error: '',
      rows: [
        { id: 'claude-code', name: 'Claude Code', detected: true, status: 'enabled', message: '' },
        { id: 'cursor', name: 'Cursor', detected: false, status: 'not-detected', message: '' },
        { id: 'codex', name: 'Codex', detected: true, status: 'conflict', message: '<img src=x onerror=alert(1)>' },
      ],
    },
  });
  assert.equal(p.get('clients-list').children.length, 3);
  assert.match(p.get('clients-list').textContent, /Claude Code登録済み/);
  assert.match(p.get('clients-error').textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(p.get('clients-error').innerHTML, undefined);
  assert.equal(p.get('clients-enable').disabled, true);
  assert.equal(p.get('clients-disable').disabled, false);
  await p.get('clients-disable').trigger('click');
  assert.ok(p.messages.some(m => m.type === 'disableAllClients'));
  p.state({ trusted: true, hasFolder: true, busy: { clients: false }, clients: { busy: false, error: '', rows: [] } });
  assert.equal(p.get('clients-enable').disabled, false);
  await p.get('clients-enable').trigger('click');
  assert.ok(p.messages.some(m => m.type === 'enableAllClients'));
  await p.get('clients-refresh').trigger('click');
  assert.ok(p.messages.some(m => m.type === 'refreshClients'));
});

test('permission summary renders effective physical denial and missing prerequisites as safe text', () => {
  const p = panel();
  const reason = '画像許可が必要 <img src=x onerror=alert(1)>';
  p.state({
    permissions: {
      requested: { allowPhysicalInput: true },
      effective: {
        browserOrigins: [],
        desktopAppId: '',
        allowAllOperations: false,
        allowPhysicalInput: false,
        allowUnredactedImages: false,
        allowLoopback: false,
        allowPrivateNetwork: false,
        reasons: [reason],
      },
    },
  });
  const row = p.get('permissions').children[3];
  assert.match(row.children[1].textContent, /off|オフ/);
  assert.doesNotMatch(row.children[1].textContent, /^on$/);
  assert.ok(p.get('permissions-hint').textContent.includes(reason));
  assert.equal(p.get('permissions-hint').innerHTML, undefined);
  const physical = p.get('permissions').children[3].children[1];
  assert.equal(physical.textContent, 'オフ（要求 on）');
  p.get('ui-language').value = 'en';
  p.get('ui-language').listeners.get('change')();
  assert.equal(physical.textContent, 'off (requested on)');
});

test('a successful origin add clears the input and a rejected add keeps it for correction', async () => {
  const p = panel();
  p.state({
    trusted: true,
    hasFolder: true,
    busy: { origins: false },
    settings: { browserOrigins: [], browserResourceOrigins: [] },
  });
  const input = p.get('origin-input');
  input.value = 'https://New.example/';
  await p.get('origin-add').trigger('click');
  assert.equal(p.messages.at(-1).type, 'setBrowserOrigins');
  assert.equal(input.value, 'https://New.example/', 'the text stays while the host is still saving');
  p.state({ busy: { origins: true }, settings: { browserOrigins: [] } });
  assert.equal(input.value, 'https://New.example/');
  p.state({
    busy: { origins: false },
    settings: { browserOrigins: ['https://new.example'], browserResourceOrigins: [] },
  });
  assert.equal(input.value, '', 'the saved origin clears the input');
  input.value = 'https://bad.example/path';
  await p.get('origin-add').trigger('click');
  p.state({
    busy: { origins: false },
    status: { originsError: 'invalid' },
    settings: { browserOrigins: ['https://new.example'], browserResourceOrigins: [] },
  });
  assert.equal(input.value, 'https://bad.example/path', 'a rejected value is kept');
  input.value = 'https://new.example/path';
  await p.get('origin-add').trigger('click');
  p.state({
    busy: { origins: false },
    settings: { browserOrigins: ['https://new.example'], browserResourceOrigins: [] },
  });
  assert.equal(
    input.value,
    'https://new.example/path',
    'an existing origin never makes a path-bearing value look accepted',
  );
  const resource = p.get('resource-origin-input');
  resource.value = 'https://cdn.example';
  await p.get('resource-origin-add').trigger('click');
  assert.equal(p.messages.at(-1).type, 'setBrowserResourceOrigins');
  p.state({
    busy: { origins: false },
    settings: { browserOrigins: ['https://new.example'], browserResourceOrigins: ['https://cdn.example'] },
  });
  assert.equal(resource.value, '');
  assert.equal(input.value, 'https://new.example/path');
});

test('loopback and private-network hints disappear once their grant is enabled', async () => {
  const p = panel();
  p.state({ trusted: true, hasFolder: true, settings: { allowLoopback: false, allowPrivateNetwork: false } });
  const input = p.get('origin-input'),
    loopback = p.get('loopback-suggestion'),
    priv = p.get('private-network-suggestion');
  input.value = 'http://localhost:3000';
  await input.trigger('input');
  assert.equal(loopback.hidden, false);
  assert.equal(priv.hidden, true);
  p.state({ settings: { allowLoopback: true, allowPrivateNetwork: false } });
  assert.equal(loopback.hidden, true, 'the saved loopback grant hides the loopback hint');
  p.state({ settings: { allowLoopback: false, allowPrivateNetwork: false } });
  assert.equal(loopback.hidden, false);
  const grant = p.get('allow-loopback');
  grant.checked = true;
  await grant.trigger('change');
  assert.equal(loopback.hidden, true, 'the hint hides at once, before the host answers');
  for (const host of [
    'http://192.168.1.10:8080',
    'https://10.0.0.5',
    'http://172.16.0.1',
    'http://172.31.255.255',
    'http://100.64.0.1',
    'http://[fd12::1]',
  ]) {
    p.state({ settings: { allowLoopback: false, allowPrivateNetwork: false } });
    input.value = host;
    await input.trigger('input');
    assert.equal(priv.hidden, false, host);
    assert.equal(loopback.hidden, true, host);
  }
  for (const host of [
    'http://172.32.0.1',
    'http://192.169.0.1',
    'https://example.com',
    'http://192.168.1.10/path',
    'http://8.8.8.8',
  ]) {
    input.value = host;
    await input.trigger('input');
    assert.equal(priv.hidden, true, host);
  }
  input.value = 'http://192.168.1.10';
  await input.trigger('input');
  assert.equal(priv.hidden, false);
  const net = p.get('allow-private-network');
  net.checked = true;
  await net.trigger('change');
  assert.equal(priv.hidden, true);
  assert.equal(p.messages.at(-1).type, 'setAllowPrivateNetwork');
  p.state({ settings: { allowLoopback: false, allowPrivateNetwork: false } });
  assert.equal(priv.hidden, false);
  p.state({ settings: { allowLoopback: false, allowPrivateNetwork: true } });
  assert.equal(priv.hidden, true);
});

const plain = value => JSON.parse(JSON.stringify(value));
test('desktop app inputs, browse and save post only typed values and keep unsaved edits', async () => {
  const mac = '/System/Applications/Calculator.app/Contents/MacOS/Calculator';
  const p = panel();
  p.state({
    trusted: true,
    hasFolder: true,
    platform: 'darwin',
    settings: {
      desktopAppId: 'com.apple.calculator',
      desktopAppPath: mac,
      allowPhysicalInput: false,
      allowUnredactedImages: true,
    },
  });
  const id = p.get('desktop-app-id'),
    file = p.get('desktop-app-path');
  assert.equal(id.value, 'com.apple.calculator');
  assert.equal(file.value, mac);
  assert.equal(p.get('allow-physical-input').checked, false);
  assert.equal(p.get('allow-unredacted-images').checked, true);
  await p.get('desktop-browse').trigger('click');
  assert.deepEqual(plain(p.messages.at(-1)), { type: 'browseDesktopApp' });
  // A picked app fills the inputs (and replaces the ID on macOS) but saves nothing.
  const before = p.messages.length;
  p.raw({
    type: 'desktopAppPicked',
    appPath: '/Applications/Notes.app/Contents/MacOS/Notes',
    appId: 'com.apple.Notes',
    replaceId: true,
    notes: ['手入力 / <b>x</b>'],
  });
  assert.equal(id.value, 'com.apple.Notes');
  assert.equal(file.value, '/Applications/Notes.app/Contents/MacOS/Notes');
  assert.equal(p.messages.length, before, 'browsing alone posts nothing');
  assert.equal(p.get('desktop-notice').textContent, '手入力');
  assert.equal(p.get('desktop-notice').innerHTML, undefined);
  p.state({ settings: { desktopAppId: 'com.apple.calculator', desktopAppPath: mac } });
  assert.equal(id.value, 'com.apple.Notes', 'an unsaved pick survives a state refresh');
  id.value = ' com.apple.Notes ';
  file.value = ' /Applications/Notes.app/Contents/MacOS/Notes ';
  await id.trigger('input');
  await p.get('desktop-save').trigger('click');
  assert.deepEqual(plain(p.messages.at(-1)), {
    type: 'setDesktopApp',
    appId: 'com.apple.Notes',
    appPath: '/Applications/Notes.app/Contents/MacOS/Notes',
  });
  assert.equal(p.get('desktop-save').disabled, true, 'saving shows busy feedback');
  p.state({
    busy: { desktop: false },
    settings: { desktopAppId: 'com.apple.Notes', desktopAppPath: '/Applications/Notes.app/Contents/MacOS/Notes' },
  });
  assert.equal(p.get('desktop-save').disabled, false);
  p.state({ settings: { desktopAppId: 'other', desktopAppPath: '/other' } });
  assert.equal(id.value, 'other', 'once saved, state is authoritative again');
  await p.get('desktop-clear').trigger('click');
  assert.deepEqual(plain(p.messages.at(-1)), { type: 'setDesktopApp', appId: '', appPath: '' });
  assert.equal(id.value, '');
  assert.equal(file.value, '');
  id.value = 'a';
  file.value = '/a';
  await file.listeners.get('keydown')({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(
    plain(p.messages.at(-1)),
    { type: 'setDesktopApp', appId: 'a', appPath: '/a' },
    'Enter in a field saves',
  );
});

test('browse keeps an existing ID on Windows and Linux unless it is empty', () => {
  const p = panel();
  p.state({
    trusted: true,
    hasFolder: true,
    platform: 'win32',
    settings: { desktopAppId: 'mine', desktopAppPath: '' },
  });
  p.raw({
    type: 'desktopAppPicked',
    appPath: 'C:\\Windows\\System32\\charmap.exe',
    appId: 'charmap',
    replaceId: false,
    notes: [],
  });
  assert.equal(p.get('desktop-app-id').value, 'mine');
  assert.equal(p.get('desktop-app-path').value, 'C:\\Windows\\System32\\charmap.exe');
  p.get('desktop-app-id').value = '';
  p.raw({ type: 'desktopAppPicked', appPath: 'C:\\x.exe', appId: 'x', replaceId: false, notes: [] });
  assert.equal(p.get('desktop-app-id').value, 'x');
  p.raw({ type: 'desktopAppPicked', appPath: 7, appId: null, notes: 'bad' });
  assert.equal(p.get('desktop-app-path').value, 'C:\\x.exe');
});

test('desktop hints explain the ID and path for each operating system', () => {
  const hint = platform => {
    const p = panel('en');
    p.state({ platform });
    return p.get('desktop-os-hint').textContent;
  };
  assert.match(hint('darwin'), /bundle identifier.*Contents\/MacOS\/<executable>.*\.app/s);
  assert.match(hint('win32'), /label shown to the AI.*\.exe/s);
  assert.match(hint('linux'), /AT-SPI application name.*absolute path/s);
  assert.match(hint('freebsd'), /absolute path/);
  const ja = panel('ja');
  ja.state({ platform: 'darwin' });
  assert.match(ja.get('desktop-os-hint').textContent, /Bundle Identifier.*Contents\/MacOS/s);
  ja.get('ui-language').value = 'en';
  ja.get('ui-language').listeners.get('change')();
  assert.match(ja.get('desktop-os-hint').textContent, /^macOS: the app ID is the bundle identifier/);
});

test('physical input and unredacted image toggles post their own messages and stay workspace locked', async () => {
  const p = panel();
  p.state({ trusted: true, hasFolder: true, settings: { allowPhysicalInput: false, allowUnredactedImages: false } });
  const physical = p.get('allow-physical-input'),
    images = p.get('allow-unredacted-images');
  physical.checked = true;
  await physical.trigger('change');
  assert.deepEqual(plain(p.messages.at(-1)), { type: 'setAllowPhysicalInput', enabled: true });
  images.checked = true;
  await images.trigger('change');
  assert.deepEqual(plain(p.messages.at(-1)), { type: 'setAllowUnredactedImages', enabled: true });
  p.state({ busy: { desktop: false }, settings: { allowPhysicalInput: false, allowUnredactedImages: false } });
  assert.equal(physical.checked, false, 'a failed save restores the saved state');
  assert.equal(images.checked, false);
  p.state({ trusted: false, hasFolder: true, busy: { desktop: false } });
  for (const id of [
    'allow-physical-input',
    'allow-unredacted-images',
    'desktop-app-id',
    'desktop-app-path',
    'desktop-save',
    'desktop-clear',
  ])
    assert.equal(p.get(id).disabled, true, id);
  p.state({ busy: { desktop: false }, status: { desktopError: '<img src=x onerror=alert(1)>' } });
  assert.equal(p.get('desktop-error').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(p.get('desktop-error').innerHTML, undefined);
});

test('browser setup failure lists hosts, retries, offers installed browsers by ID and renders as text', async () => {
  const p = panel('en');
  const hidden = { failed: false, preparing: false, hosts: [], expected: {}, installed: [], using: null };
  p.state({ browser: hidden });
  assert.equal(p.get('browser-setup').hidden, true);
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const failed = {
    failed: true,
    preparing: false,
    hosts: ['cdn.playwright.dev', 'playwright.download.prss.microsoft.com', '<img src=x onerror=1>'],
    expected: { playwright: '1.64.1', chromium: '156.0.8078.4', revision: '1248' },
    installed: [
      { id: 'msedge', label: 'Microsoft Edge', path: edge, version: '130.0.2849.80', usable: true },
      {
        id: 'chromium',
        label: 'Chromium (snap)',
        path: '/snap/bin/chromium',
        usable: false,
        note: 'snap の説明 / Snap-packaged Chromium is not offered.',
      },
    ],
    using: null,
  };
  p.state({ browser: failed });
  assert.equal(p.get('browser-setup').hidden, false);
  assert.match(p.get('browser-setup-status').textContent, /could not be prepared automatically/);
  const hosts = p.get('browser-hosts').children;
  assert.equal(hosts.length, 3);
  assert.equal(hosts[0].children[0].textContent, 'cdn.playwright.dev');
  assert.match(hosts[0].children[1].textContent, /Chromium and helpers/);
  assert.match(hosts[1].children[1].textContent, /mirror/);
  assert.equal(hosts[2].children[0].textContent, '<img src=x onerror=1>');
  assert.equal(hosts[2].children[0].innerHTML, undefined);
  assert.match(hosts[2].children[1].textContent, /custom download host/);
  await p.get('browser-retry').trigger('click');
  assert.deepEqual(plain(p.messages.at(-1)), { type: 'retryBrowserSetup' });
  assert.equal(p.get('browser-retry').disabled, true, 'retry shows busy feedback');
  p.state({ busy: { browser: false }, browser: failed });
  assert.equal(p.get('browser-retry').disabled, false);
  const rows = p.get('browser-installed').children;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].children[0].textContent, 'Microsoft Edge 130.0.2849.80');
  assert.equal(rows[0].children[1].textContent, edge);
  assert.match(rows[0].textContent, /major version differs from the tested 156/);
  await rows[0].children.at(-1).trigger('click');
  assert.deepEqual(
    plain(p.messages.at(-1)),
    { type: 'useInstalledBrowser', id: 'msedge' },
    'only the ID is posted, never a path',
  );
  assert.equal(rows[1].children.length, 3, 'a browser that is not usable gets a note instead of a button');
  assert.equal(rows[1].children.at(-1).textContent, 'Snap-packaged Chromium is not offered.');
  const compat = p.get('browser-compat').textContent;
  assert.match(compat, /Playwright 1\.64\.1/);
  assert.match(compat, /Chromium 156\.0\.8078\.4 \(revision 1248\)/);
  assert.match(compat, /not guaranteed/);
  assert.equal(p.get('browser-installed-empty').hidden, true);
  p.state({ browser: { ...failed, installed: [] } });
  assert.equal(p.get('browser-installed-empty').hidden, false);
  p.state({ browser: { ...failed, preparing: true } });
  assert.equal(p.get('browser-retry').disabled, true);
  assert.match(p.get('browser-setup-status').textContent, /Preparing the browser/);
  const using = {
    ...failed,
    failed: false,
    using: { id: 'msedge', label: 'Microsoft Edge', path: 'C:\\edge.exe', version: '130.0.2849.80' },
  };
  p.state({ browser: using });
  assert.equal(p.get('browser-setup').hidden, false);
  assert.equal(p.get('browser-use-auto').hidden, false);
  assert.match(
    p.get('browser-setup-status').textContent,
    /Using the installed browser: Microsoft Edge 130\.0\.2849\.80 C:\\edge\.exe/,
  );
  await p.get('browser-use-auto').trigger('click');
  assert.deepEqual(plain(p.messages.at(-1)), { type: 'clearInstalledBrowser' });
  p.get('ui-language').value = 'ja';
  p.get('ui-language').listeners.get('change')();
  assert.match(p.get('browser-compat').textContent, /検証/);
  p.state({ browser: failed });
  assert.equal(p.get('browser-use-auto').hidden, true);
});

test('the proxy hostname toggle posts its own message, mirrors saved state and stays workspace locked', async () => {
  const saved = connect => ({
    browserProxyServer: 'https://proxy.example:8443',
    browserProxyConnectByHostname: connect,
    sessionIdleMinutes: 15,
    browserHeadless: true,
  });
  const p = panel('en');
  p.state({ trusted: true, hasFolder: true, settings: saved(false) });
  const toggle = p.get('browser-proxy-connect-hostname');
  assert.equal(toggle.checked, false);
  toggle.checked = true;
  await toggle.trigger('change');
  assert.deepEqual(plain(p.messages.at(-1)), { type: 'setBrowserProxyConnectByHostname', enabled: true });
  assert.equal(toggle.disabled, true, 'busy feedback while saving');
  p.state({ busy: { runtime: false }, settings: saved(true) });
  assert.equal(toggle.checked, true);
  assert.equal(toggle.disabled, false);
  assert.match(p.get('session-idle-effective').textContent, /CONNECT by hostname/);
  p.state({ trusted: false, hasFolder: true, busy: { runtime: false } });
  assert.equal(toggle.disabled, true);
});
