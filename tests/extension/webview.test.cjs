const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function panel(language = 'ja', savedWebviewState = {}, timers = {}) {
  const elements = new Map(),
    messages = [],
    listeners = new Map(),
    webview = { state: savedWebviewState };
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
    acquireVsCodeApi: () => ({
      postMessage: data => messages.push(data),
      getState: () => webview.state,
      setState: value => {
        webview.state = value;
      },
    }),
    document,
    window: { addEventListener: (type, listener) => listeners.set(type, listener) },
    URL,
    console,
    setTimeout: timers.setTimeout ?? setTimeout,
    clearTimeout: timers.clearTimeout ?? clearTimeout,
  });
  return {
    get,
    messages,
    document,
    webview,
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

// ---- AI summary, first-run checklist and collapsed groups ----

// A complete host state the way publishState() posts it; `over` tweaks the interesting parts.
function hostState(over = {}) {
  const {
    enabled = true,
    origins = ['https://example.com'],
    mode = 'read_only',
    effectiveMode = mode,
    effectiveOrigins = origins,
    desktopAppId = '',
    flags = {},
    stopped = false,
    trusted = true,
    mcpError = null,
    reasons = [],
    status = {},
    settings = {},
  } = over;
  const eff = {
    browserOrigins: effectiveOrigins,
    desktopAppId,
    allowAllOperations: effectiveMode === 'all',
    operationMode: effectiveMode,
    allowPhysicalInput: false,
    allowUnredactedImages: false,
    allowLoopback: false,
    allowPrivateNetwork: false,
    allowPersonalData: false,
    reasons,
    ...flags,
  };
  return {
    trusted,
    hasFolder: true,
    stopped,
    busy: {},
    settings: { enabled, browserOrigins: origins, operationMode: mode, desktopAppId, ...settings },
    permissions: { requested: { operationMode: mode }, effective: eff },
    status: { mcpError, runtimeError: '', desktopError: '', ...status },
  };
}

test('broad URL and application defaults are shown and can be turned off', async () => {
  const p = panel('en');
  p.state(
    hostState({
      origins: [],
      mode: 'all',
      flags: { allowAllBrowserOrigins: true, allowAllApplications: true },
      settings: { allowAllBrowserOrigins: true, allowAllApplications: true },
    }),
  );
  assert.match(p.get('ai-summary').textContent, /all websites/);
  assert.match(p.get('ai-summary-extra').textContent, /all desktop applications/);
  assert.equal(p.get('setup-checklist').hidden, true);
  assert.equal(p.get('allow-all-browser-origins').checked, true);
  p.get('allow-all-browser-origins').checked = false;
  await p.get('allow-all-browser-origins').trigger('change');
  assert.deepEqual(JSON.parse(JSON.stringify(p.messages.at(-1))), {
    type: 'setAllowAllBrowserOrigins',
    enabled: false,
  });
});
const summaryOf = p => p.get('ai-summary').textContent;

test('the summary states what the AI can do for read only, standard, ask and allow-all, and nothing more', async () => {
  const p = panel('ja');
  p.state(hostState({ mode: 'read_only' }));
  assert.equal(
    summaryOf(p),
    'AI は example.com を閲覧できます。クリックや入力はできません（読み取り専用）。',
    'read only can view but never click or type',
  );
  p.state(hostState({ mode: 'standard' }));
  assert.equal(
    summaryOf(p),
    'ブラウザーでは example.com を閲覧し、通常のクリックや入力ができます。送信などの重要な操作と、ページが保存のために送る通信はブロックされるため、変更を保存できない場合があります。デスクトップでは通常操作を実行でき、保存や自動保存が発生することがあります（標準）。',
  );
  p.state(hostState({ mode: 'ask' }));
  assert.equal(
    summaryOf(p),
    'ブラウザーでは example.com を閲覧し、通常のクリックや入力ができます。送信などの重要な操作と、ページが保存のために送る通信は、VS Code の確認画面で内容を承認した場合のみ実行されます。デスクトップでは通常操作を実行でき、削除や送信などの重要なネイティブ操作の前に確認します。通常操作に伴う保存や自動保存は発生することがあります（都度承認）。',
  );
  p.state(hostState({ mode: 'read_only', effectiveMode: 'all' }));
  assert.match(summaryOf(p), /^AI は example\.com で、確認なしにあらゆる操作.*（全操作）。$/);
  const en = panel('en');
  en.state(hostState({ mode: 'read_only' }));
  assert.equal(summaryOf(en), 'The AI can view example.com. It cannot click or type (read only).');
  en.state(hostState({ mode: 'standard' }));
  assert.match(
    summaryOf(en),
    /^In the browser, the AI can view example\.com and use ordinary controls\..*On desktop, ordinary actions remain available and may save or autosave data \(standard\)\.$/,
  );
  en.state(hostState({ mode: 'ask' }));
  assert.match(
    summaryOf(en),
    /On desktop, ordinary actions remain available; approval is requested before consequential native actions.*\(ask each time\)\.$/,
  );
  const html = await panelHtml();
  assert.match(html, /New trusted workspaces start with all operations/);
  assert.match(html, /confirmation dialog appears when you manually switch from a limited mode to All operations/i);
});

test('the summary covers emergency stop, disabled MCP, missing origins and an untrusted workspace without claiming access', () => {
  const p = panel('ja');
  p.state(hostState({ mode: 'standard' }));
  assert.match(summaryOf(p), /閲覧し/);
  p.state(hostState({ mode: 'standard', stopped: true }));
  assert.equal(summaryOf(p), '緊急停止中です。操作を再開するまで、AI は何も実行できません。');
  assert.equal(p.get('ai-summary-extra').hidden, true);
  p.state(hostState({ mode: 'standard', stopped: false }));
  assert.match(summaryOf(p), /閲覧し/, 'resuming restores the grant description');
  p.state(hostState({ enabled: false, mode: 'ask' }));
  assert.equal(summaryOf(p), 'このワークスペースでは MCP が無効です。AI は何もできません。');
  p.state(hostState({ origins: [], mode: 'ask' }));
  assert.equal(summaryOf(p), 'MCP は有効ですが、許可された Web サイトがないため、AI はブラウザーを操作できません。');
  p.state(hostState({ mode: 'ask', trusted: false }));
  assert.match(summaryOf(p), /^信頼済みのフォルダーを開くまで MCP は使えません。/);
  assert.doesNotMatch(summaryOf(p), /閲覧|クリック/);
  const en = panel('en');
  en.state(hostState({ stopped: true }));
  assert.equal(summaryOf(en), 'Emergency stop is active. The AI cannot do anything until you resume operations.');
  en.state(hostState({ stopped: false, enabled: false }));
  assert.equal(summaryOf(en), 'MCP is off in this workspace, so the AI can do nothing.');
  en.state(hostState({ origins: [] }));
  assert.equal(summaryOf(en), 'MCP is on, but no websites are allowed, so the AI cannot use the browser.');
});

test('the summary follows the effective permissions, not the requested settings', () => {
  const p = panel('ja');
  // Saved settings ask for standard on example.com, but the host's effective grants deny everything (invalid grants).
  p.state(
    hostState({ mode: 'standard', effectiveOrigins: [], effectiveMode: 'read_only', reasons: ['grants denied'] }),
  );
  assert.doesNotMatch(summaryOf(p), /閲覧|クリック/);
  assert.match(summaryOf(p), /許可された Web サイトがない/);
  p.state(hostState({ mode: 'standard', effectiveMode: 'read_only' }));
  assert.match(summaryOf(p), /クリックや入力はできません（読み取り専用）/, 'a lower effective tier wins');
  p.state(hostState({ mode: 'standard', status: { mcpError: '権限設定が無効です。' } }));
  assert.match(summaryOf(p), /^MCP の設定に問題があります。/);
  assert.doesNotMatch(summaryOf(p), /閲覧|クリック/, 'a configuration error claims no capability');
  assert.equal(p.get('ai-summary-extra').hidden, true);
});

test('the summary lists origins as text, abbreviates long lists and names other grants that are on', () => {
  const p = panel('ja');
  p.state(
    hostState({ origins: ['https://example.com', 'http://localhost:3000', 'https://a.example', 'https://b.example'] }),
  );
  assert.match(summaryOf(p), /^AI は example\.com、http:\/\/localhost:3000 ほか 2 件 を閲覧できます。/);
  assert.equal(p.get('ai-summary-extra').hidden, true, 'nothing extra is on');
  p.state(hostState({ origins: ['<img src=x onerror=alert(1)> / x'] }));
  // The " / " separator would split the bilingual text, so it is flattened inside origin names.
  assert.ok(summaryOf(p).includes('<img src=x onerror=alert(1)>/x'), 'hostile text stays literal text');
  assert.equal(p.get('ai-summary').innerHTML, undefined, 'summary text never goes through innerHTML');
  p.state(
    hostState({
      desktopAppId: 'com.example.app',
      flags: {
        allowPhysicalInput: true,
        allowLoopback: true,
        allowPrivateNetwork: true,
        allowPersonalData: true,
        allowUnredactedImages: true,
      },
    }),
  );
  const extra = p.get('ai-summary-extra');
  assert.equal(extra.hidden, false);
  assert.equal(
    extra.textContent,
    'ほかに有効な設定: デスクトップアプリ com.example.app、物理入力、無加工のネイティブ画像、ループバック、プライベートネットワーク、個人データの表示。',
  );
  p.state(hostState({ desktopAppId: '', flags: { allowPhysicalInput: false } }));
  assert.equal(extra.hidden, true);
  assert.equal(extra.textContent, '');
});

test('the summary is re-rendered when the display language changes and posts nothing to the host', async () => {
  const p = panel('ja');
  p.state(hostState({ mode: 'ask', desktopAppId: 'app.id' }));
  const messages = p.messages.length;
  p.get('ui-language').value = 'en';
  await p.get('ui-language').trigger('change');
  assert.match(summaryOf(p), /^In the browser, the AI can view example\.com and use ordinary controls\./);
  assert.equal(p.get('ai-summary-extra').textContent, 'Also on: desktop app app.id.');
  assert.equal(p.messages.length, messages);
});

// ---- Standing site-write grants: listed and revocable in the panel, never created there ----
const GRANT_ID = '0123abcd-0123-4abc-8def-0123456789ab';
const grantRow = (over = {}) => ({
  id: GRANT_ID,
  origin: 'https://example.com',
  scope: 'site_writes',
  created_at: Date.now() - 5 * 60_000,
  expires_at: Date.now() + 25 * 60_000,
  uses: 3,
  ...over,
});
const ASK_SENTENCE =
  'ブラウザーでは example.com を閲覧し、通常のクリックや入力ができます。送信などの重要な操作と、ページが保存のために送る通信は、VS Code の確認画面で内容を承認した場合のみ実行されます。デスクトップでは通常操作を実行でき、削除や送信などの重要なネイティブ操作の前に確認します。通常操作に伴う保存や自動保存は発生することがあります（都度承認）。';
// A webview whose timers only record their callbacks, so the 30-second refresh can be run by hand and nothing stays pending.
function timedPanel(language = 'ja') {
  const scheduled = [];
  const p = panel(
    language,
    {},
    {
      setTimeout: (fn, ms) => {
        scheduled.push({ fn, ms, cancelled: false });
        return scheduled.length;
      },
      clearTimeout: id => {
        if (scheduled[id - 1]) scheduled[id - 1].cancelled = true;
      },
    },
  );
  return { p, scheduled };
}
const grantState = (grants, over = {}) => ({ ...hostState({ mode: 'ask', ...over }), grants });

test('the summary mentions a standing site grant in ask mode, lists it with its remaining time and a revoke button that only posts revokeSiteGrant', async () => {
  const { p, scheduled } = timedPanel('ja');
  p.state(grantState([]));
  assert.equal(summaryOf(p), ASK_SENTENCE, 'without a grant the pinned ask sentence is unchanged');
  assert.equal(p.get('site-grants').hidden, true);
  assert.equal(scheduled.length, 0, 'nothing is scheduled while no grant is listed');
  p.state(grantState([grantRow()]));
  assert.equal(
    summaryOf(p),
    `${ASK_SENTENCE} いま 1 件のサイトで、書き込み通信を確認なしに送る継続許可が有効です（最長 30 分。認証情報を含む通信と購入・支払いに関わる操作は毎回確認）。`,
  );
  assert.ok(summaryOf(p).endsWith('毎回確認）。'));
  const list = p.get('site-grants');
  assert.equal(list.hidden, false);
  assert.equal(list.children.length, 1);
  const [name, state, revoke] = list.children[0].children;
  assert.equal(name.textContent, 'https://example.com');
  assert.equal(state.textContent, '残り 25 分・3 回使用');
  assert.equal(revoke.textContent, '取り消す');
  assert.equal(revoke['aria-label'], '書き込みの継続許可を取り消す');
  assert.equal(scheduled.at(-1).ms, 30_000, 'the remaining minutes are refreshed every 30 seconds');
  // Revoking posts exactly the id and disables the buttons until the host answers.
  const before = p.messages.length;
  await revoke.trigger('click');
  assert.deepEqual(plain(p.messages.slice(before)), [{ type: 'revokeSiteGrant', id: GRANT_ID }]);
  assert.equal(revoke.disabled, true);
  p.state({ ...grantState([grantRow()]), busy: { grants: true } });
  assert.equal(p.get('site-grants').children[0].children[2].disabled, true, 'a busy host keeps the buttons off');
  p.state({ ...grantState([grantRow()]), busy: { grants: false } });
  assert.equal(p.get('site-grants').children[0].children[2].disabled, false);
  // The host drops the grant: the list hides, the sentence returns to the pinned text and the refresh stops.
  p.state(grantState([]));
  assert.equal(p.get('site-grants').hidden, true);
  assert.equal(p.get('site-grants').children.length, 0);
  assert.equal(summaryOf(p), ASK_SENTENCE);
  assert.equal(scheduled.at(-1).cancelled, true);
  // The panel never sends anything but the revoke of a listed grant.
  assert.deepEqual(
    plain(p.messages.map(m => m.type)).filter(type => /grant/i.test(type)),
    ['revokeSiteGrant'],
  );
});

test('standing grants are named only in ask mode, counted per site, filtered when malformed, and shown in both languages', async () => {
  const { p } = timedPanel('ja');
  const second = grantRow({ id: 'fedcba98-0123-4abc-8def-0123456789ab', origin: 'https://other.example', uses: 0 });
  p.state(
    grantState([
      null,
      { id: GRANT_ID },
      { id: 'x', origin: 'https://a.example', expires_at: 'soon', uses: 1 },
      { id: 'y', origin: '', expires_at: Date.now() + 60_000, uses: 1 },
      grantRow(),
      second,
    ]),
  );
  assert.equal(
    p.get('site-grants').children.length,
    2,
    'rows without a usable id, origin, expiry or count are dropped',
  );
  assert.match(summaryOf(p), /いま 2 件のサイトで、書き込み通信を確認なしに送る継続許可が有効です/);
  assert.equal(p.get('site-grants').children[1].children[1].textContent, '残り 25 分・0 回使用');
  for (const mode of ['read_only', 'standard']) {
    p.state(grantState([grantRow()], { mode }));
    assert.doesNotMatch(summaryOf(p), /継続許可/, `${mode} never mentions a grant`);
  }
  p.state(grantState([grantRow()], { stopped: true }));
  assert.match(summaryOf(p), /^緊急停止中です/);
  assert.doesNotMatch(summaryOf(p), /継続許可/);
  p.state(grantState([grantRow()]));
  p.get('ui-language').value = 'en';
  await p.get('ui-language').trigger('change');
  assert.match(
    summaryOf(p),
    /\(ask each time\)\. Standing write permission is active for 1 site \(up to 30 minutes; credential and payment-like requests still ask\)\.$/,
  );
  const [, state, revoke] = p.get('site-grants').children[0].children;
  assert.equal(state.textContent, '25 min left, used 3 times');
  assert.equal(revoke.textContent, 'Revoke');
  assert.equal(revoke['aria-label'], 'Revoke standing write grant https://example.com');
  p.state(grantState([grantRow(), second]));
  assert.match(summaryOf(p), /active for 2 sites/);
  const en = panel('en');
  en.state(grantState([grantRow()]));
  assert.equal(en.get('site-grants').children[0].children[1].textContent, '25 min left, used 3 times');
});

test('hostile origin text in a grant stays text, and a grant that ran out locally disappears at the next refresh', async () => {
  const { p, scheduled } = timedPanel('ja');
  const hostile = '<img src=x onerror=alert(1)> / x';
  p.state(grantState([grantRow({ origin: hostile })]));
  const [name, , revoke] = p.get('site-grants').children[0].children;
  assert.equal(name.textContent, hostile);
  assert.equal(name.innerHTML, undefined, 'the origin never goes through innerHTML');
  assert.equal(p.get('site-grants').innerHTML, undefined);
  assert.ok(revoke['aria-label'].startsWith('書き込みの継続許可を取り消す'));
  assert.equal(p.get('ai-summary').innerHTML, undefined);
  // A grant whose time ran out between two host states is hidden by the 30-second refresh, without a host message.
  p.state(grantState([grantRow({ expires_at: Date.now() + 40 })]));
  assert.equal(p.get('site-grants').hidden, false);
  assert.match(summaryOf(p), /継続許可/);
  await new Promise(resolve => setTimeout(resolve, 80));
  const messages = p.messages.length;
  scheduled.at(-1).fn();
  assert.equal(p.get('site-grants').hidden, true);
  assert.equal(summaryOf(p), ASK_SENTENCE);
  assert.equal(p.messages.length, messages, 'the refresh posts nothing');
});

test('republishing the grant list after a use keeps keyboard focus on the same revoke button', () => {
  const { p } = timedPanel('ja');
  const other = 'fedcba98-0123-4abc-8def-0123456789ab';
  const focused = [];
  const create = p.document.createElement;
  p.document.createElement = tag => {
    const el = create(tag);
    el.focus = () => {
      focused.push(el.dataset.grantId);
      p.document.activeElement = el;
    };
    return el;
  };
  const rows = uses => [grantRow({ uses }), grantRow({ id: other, origin: 'https://other.example' })];
  p.state(grantState(rows(3)));
  assert.deepEqual(focused, [], 'nothing is focused when the user was not on a grant button');
  p.document.activeElement = p.get('site-grants').children[1].children[2];
  p.state(grantState(rows(4)));
  assert.deepEqual(focused, [other], 'the re-created button of the same grant is focused again');
  assert.equal(p.get('site-grants').children[0].children[1].textContent, '残り 25 分・4 回使用');
  p.document.activeElement = p.get('site-grants').children[1].children[2];
  p.state(grantState([grantRow({ uses: 4 })]));
  assert.deepEqual(focused, [other], 'a grant that ended leaves no stale focus target');
});

test('the checklist is shown on a fresh install, states done and to-do in words, and hides itself when setup is complete', () => {
  const p = panel('ja');
  assert.equal(p.get('setup-checklist').hidden, undefined, 'no state yet: the static markup keeps it hidden');
  p.state(hostState({ enabled: false, origins: [], mode: 'read_only' }));
  assert.equal(p.get('setup-checklist').hidden, false);
  assert.equal(p.get('setup-reopen').hidden, true);
  for (const name of ['mcp', 'origin', 'tier']) {
    assert.equal(p.get(`setup-state-${name}`).textContent, '未完了', `${name} states its status in words`);
    assert.equal(p.get(`setup-mark-${name}`).textContent, '○');
    assert.equal(p.get(`setup-go-${name}`).hidden, false, `${name} offers a way to the control`);
    assert.equal(p.get(`setup-step-${name}`).dataset.done, 'false');
  }
  assert.equal(p.get('setup-progress').textContent, '0/3 完了');
  p.state(hostState({ enabled: true, origins: [], mode: 'read_only' }));
  assert.equal(p.get('setup-state-mcp').textContent, '完了');
  assert.equal(p.get('setup-mark-mcp').textContent, '✓');
  assert.equal(p.get('setup-go-mcp').hidden, true, 'a finished step has no button');
  assert.equal(p.get('setup-go-origin').hidden, false);
  assert.equal(p.get('setup-progress').textContent, '1/3 完了');
  p.state(hostState({ enabled: true, origins: ['https://example.com'], mode: 'read_only' }));
  assert.equal(p.get('setup-checklist').hidden, false, 'read only keeps the third step open');
  assert.equal(p.get('setup-state-tier').textContent, '未完了');
  assert.equal(p.get('setup-progress').textContent, '2/3 完了');
  const confirmedReadOnly = hostState({ enabled: true, origins: ['https://example.com'], mode: 'read_only' });
  confirmedReadOnly.settings.operationModeConfirmed = true;
  p.state(confirmedReadOnly);
  assert.equal(p.get('setup-progress').textContent, '3/3 完了');
  assert.equal(p.get('setup-checklist').hidden, true, 'an explicitly configured read-only tier completes setup');
  p.state(hostState({ enabled: true, origins: ['https://example.com'], mode: 'standard' }));
  assert.equal(p.get('setup-checklist').hidden, true, 'complete setup hides the checklist');
  assert.equal(p.get('setup-reopen').hidden, true);
  for (const name of ['mcp', 'origin', 'tier']) assert.equal(p.get(`setup-state-${name}`).textContent, '完了');
  p.state(hostState({ enabled: true, origins: ['https://example.com'], mode: 'ask' }));
  assert.equal(p.get('setup-checklist').hidden, true);
  p.state(hostState({ enabled: true, origins: ['https://example.com'], mode: 'read_only', effectiveMode: 'all' }));
  assert.equal(p.get('setup-checklist').hidden, true, 'the legacy allow-all tier counts as chosen');
  const en = panel('en');
  en.state(hostState({ enabled: false, origins: [], mode: 'read_only' }));
  assert.equal(en.get('setup-state-mcp').textContent, 'To do');
  assert.equal(en.get('setup-progress').textContent, '0 of 3 done');
});

test('the checklist can be dismissed, stays dismissed through the webview state API, and can be shown again', async () => {
  const unfinished = hostState({ enabled: true, origins: ['https://example.com'], mode: 'read_only' });
  const p = panel('ja', { other: 'kept' });
  p.state(unfinished);
  assert.equal(p.get('setup-checklist').hidden, false);
  const focused = [];
  p.get('setup-reopen').focus = () => focused.push('reopen');
  await p.get('setup-dismiss').trigger('click');
  assert.equal(p.get('setup-checklist').hidden, true);
  assert.equal(p.get('setup-reopen').hidden, false, 'a dismissed unfinished setup stays reachable');
  assert.deepEqual(plain(p.webview.state), { other: 'kept', setupDismissed: true }, 'persisted without a new setting');
  assert.deepEqual(focused, ['reopen'], 'focus moves to the reopen control instead of being lost');
  assert.deepEqual(
    p.messages.map(m => m.type),
    ['ready'],
    'dismissing posts nothing to the host',
  );
  p.state(unfinished);
  assert.equal(p.get('setup-checklist').hidden, true, 'later state updates keep it dismissed');
  // A new webview (sidebar reopened) restores the dismissal from the saved state.
  const again = panel('ja', plain(p.webview.state));
  again.state(unfinished);
  assert.equal(again.get('setup-checklist').hidden, true);
  assert.equal(again.get('setup-reopen').hidden, false);
  again.get('setup-go-tier').focus = () => focused.push('tier');
  await again.get('setup-reopen').trigger('click');
  assert.equal(again.get('setup-checklist').hidden, false);
  assert.equal(again.get('setup-reopen').hidden, true);
  assert.equal(again.webview.state.setupDismissed, false);
  assert.deepEqual(focused.slice(1), ['tier'], 'showing it again focuses the first open step');
  // Completing setup while dismissed leaves neither the checklist nor the reopen link.
  again.state(hostState({ enabled: true, origins: ['https://example.com'], mode: 'standard' }));
  assert.equal(again.get('setup-checklist').hidden, true);
  assert.equal(again.get('setup-reopen').hidden, true);
});

test('checklist buttons open any collapsed group, scroll to and focus the right control, and change no setting', async () => {
  const p = panel('ja');
  p.state(hostState({ enabled: false, origins: [], mode: 'read_only' }));
  const calls = [];
  const group = { open: false };
  for (const id of ['enabled', 'origin-input', 'operation-mode']) {
    const el = p.get(id);
    el.closest = selector => (selector === 'details' ? group : null);
    el.scrollIntoView = () => calls.push(`scroll:${id}`);
    el.focus = () => calls.push(`focus:${id}`);
  }
  await p.get('setup-go-mcp').trigger('click');
  await p.get('setup-go-origin').trigger('click');
  await p.get('setup-go-tier').trigger('click');
  assert.deepEqual(calls, [
    'scroll:enabled',
    'focus:enabled',
    'scroll:origin-input',
    'focus:origin-input',
    'scroll:operation-mode',
    'focus:operation-mode',
  ]);
  assert.equal(group.open, true, 'a control inside a collapsed group is revealed first');
  assert.equal(p.get('enabled').checked, false, 'the checklist never flips the setting itself');
  assert.deepEqual(
    p.messages.map(m => m.type),
    ['ready'],
    'and posts nothing to the host',
  );
});

test('collapsed groups open by themselves for problems and elevated grants, once, so the user can close them', () => {
  const p = panel('ja');
  const open = id => p.get(id).open === true;
  p.state(hostState());
  for (const id of ['grants-details', 'permissions-details', 'advanced-details', 'desktop-details', 'clients-details'])
    assert.equal(open(id), false, `${id} starts collapsed`);
  p.state(hostState({ flags: { allowLoopback: true } }));
  assert.equal(open('grants-details'), true, 'an elevated grant reveals its toggle');
  p.get('grants-details').open = false;
  p.state(hostState({ flags: { allowLoopback: true } }));
  assert.equal(open('grants-details'), false, 'a repeated state does not fight the user');
  p.state(hostState({ reasons: ['Native runtime is not ready'] }));
  assert.equal(open('permissions-details'), true, 'effective-permission warnings stay visible');
  p.state(hostState({ status: { runtimeError: '設定値が無効です。' } }));
  assert.equal(open('advanced-details'), true, 'runtime errors are not hidden in the collapsed group');
  p.state(hostState({ settings: { allowPhysicalInput: true } }));
  assert.equal(open('desktop-details'), true, 'physical input shows its warning');
  p.state({
    clients: {
      busy: false,
      error: '',
      rows: [{ name: 'Codex', detected: true, status: 'conflict', message: 'exists' }],
    },
  });
  assert.equal(open('clients-details'), true, 'a client conflict is visible');
  assert.equal(p.get('clients-state').textContent, '0 件に登録済み', 'the collapsed heading carries the client count');
  p.state(hostState({ settings: { desktopAppId: 'com.example.app' } }));
  assert.equal(p.get('desktop-state').textContent, 'com.example.app');
  p.state(hostState({ settings: { desktopAppId: '' } }));
  assert.equal(p.get('desktop-state').textContent, '未設定');
  // The loopback suggestion points at the toggle inside More grants, so it reveals the group.
  const q = panel('ja');
  q.state(hostState({ settings: { allowLoopback: false } }));
  q.get('origin-input').value = 'http://localhost:3000';
  q.get('origin-input').listeners.get('input')();
  assert.equal(q.get('grants-details').open, true);
});

// The real panel HTML, built from src/extension/panel.ts with a stubbed `vscode`.
async function panelHtml(language = 'ja') {
  const esbuild = require('esbuild');
  const stub = `export const Uri={joinPath:(base,...parts)=>({toString:()=>'media/'+parts.join('/')})};
export const ConfigurationTarget={Global:1,Workspace:2,WorkspaceFolder:3};export const env={language:${JSON.stringify(language)}};
export const workspace={};export const window={};`;
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, '../../src/extension/panel.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        name: 'vscode-stub',
        setup(build) {
          build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'vscode-stub' }));
          build.onLoad({ filter: /.*/, namespace: 'vscode-stub' }, () => ({ contents: stub, loader: 'js' }));
        },
      },
    ],
  });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', result.outputFiles[0].text)(mod, mod.exports, require);
  const provider = new mod.exports.SettingsPanelProvider({}, {});
  return provider.html({ cspSource: 'vscode-webview:', asWebviewUri: uri => uri });
}
const detailsBlocks = html => [...html.matchAll(/<details\b[\s\S]*?<\/details>/g)].map(match => match[0]);

test('every control the panel had before is still present with the same ID', async () => {
  const html = await panelHtml();
  // IDs of the panel before the summary/checklist/collapsed-groups rework (v0.1.6 base).
  const ids =
    `allow-loopback allow-personal-data allow-physical-input allow-private-network allow-unredacted-images auto-update
    browser-compat browser-headless browser-hosts browser-installed browser-installed-empty browser-proxy-connect-hostname browser-proxy-server
    browser-retry browser-setup browser-setup-status browser-use-auto check-now check-updates clients-disable clients-enable clients-error
    clients-list clients-refresh clients-status clients-title desktop-app-id desktop-app-path desktop-browse desktop-clear desktop-error
    desktop-notice desktop-os-hint desktop-save desktop-title emergency-stop enabled enabled-error enabled-hint global-error loopback-suggestion
    mcp-error mcp-status open-logs open-settings operation-mode operation-mode-error origin-add origin-input origins-error origins-list
    permissions permissions-hint private-network-suggestion resource-origin-add resource-origin-input resource-origins-list resume-operations
    runtime-settings-error session-idle-effective session-idle-minutes stopped-status ui-language update-source update-status updates-title
    version workspace-title`.split(/\s+/);
  assert.equal(ids.length, 68);
  for (const id of ids) assert.equal(html.split(`id="${id}"`).length, 2, `${id} appears exactly once`);
  // Every ID the script looks up exists in the markup (a typo would silently disable a control).
  const script = fs.readFileSync(path.join(__dirname, '../../media/settings.js'), 'utf8');
  for (const [, id] of script.matchAll(/\$\('([a-z0-9-]+)'\)/g))
    assert.ok(html.includes(`id="${id}"`), `script id ${id} exists`);
  for (const name of ['mcp', 'origin', 'tier'])
    for (const kind of ['step', 'mark', 'state', 'go'])
      assert.ok(html.includes(`id="setup-${kind}-${name}"`), `setup-${kind}-${name}`);
});

test('the emergency stop, the permission tier and the summary are never inside a collapsed group', async () => {
  const html = await panelHtml();
  const groups = detailsBlocks(html);
  assert.ok(groups.length >= 5, 'the rarely changed controls sit in groups');
  const always = [
    'emergency-stop',
    'resume-operations',
    'stopped-status',
    'operation-mode',
    'operation-mode-error',
    'permissions-hint',
    'enabled',
    'origin-input',
    'origins-error',
    'ai-summary',
    'site-grants',
    'setup-checklist',
    'mcp-error',
    'enabled-error',
  ];
  for (const group of groups) {
    for (const id of always) assert.ok(!group.includes(`id="${id}"`), `${id} stays outside <details>`);
    assert.doesNotMatch(
      group.slice(0, group.indexOf('>') + 1),
      /\sopen\b/,
      'groups start collapsed; the script opens them',
    );
  }
  // The Allow-all warning is not attached to a collapsed control, so it stays in the always-visible part.
  const visible = html.replace(/<details\b[\s\S]*?<\/details>/g, '');
  assert.match(visible, /All operations lets the AI submit forms, delete, buy or pay/);
  // Error lines inside groups are revealed by the script when they have text (see the auto-open test).
  for (const id of ['clients-error', 'desktop-error', 'runtime-settings-error'])
    assert.ok(
      groups.some(group => group.includes(`id="${id}"`)),
      `${id} lives in a group that opens when it has text`,
    );
});

test('the summary is a polite status region and the checklist is real text with keyboard-focusable buttons', async () => {
  const html = await panelHtml();
  const region =
    /<div id="ai-summary-box" role="status" aria-live="polite" aria-atomic="true" aria-labelledby="ai-summary-label">/;
  assert.match(html, region, 'screen readers hear the summary when the state changes');
  assert.match(html, /<p class="summary-label" id="ai-summary-label">/);
  assert.match(
    html,
    /<div class="checklist" id="setup-checklist" role="group" aria-labelledby="setup-checklist-title" hidden>/,
  );
  assert.match(html, /<h4 class="checklist-title" id="setup-checklist-title">/);
  assert.match(html, /<ol class="checklist-items">/, 'the steps are a real ordered list');
  const checklist = html.slice(html.indexOf('id="setup-checklist"'), html.indexOf('id="enabled"'));
  const buttons = [...checklist.matchAll(/<button\b[^>]*>/g)].map(match => match[0]);
  assert.equal(buttons.length, 4, 'dismiss plus one button per step');
  for (const button of buttons) {
    assert.match(button, /\btype="button"/);
    assert.match(button, /aria-label="[^"]* \/ [^"]*"/, 'each button has a bilingual accessible name');
    assert.doesNotMatch(button, /tabindex="-1"/, 'buttons stay keyboard focusable');
  }
  // Status never relies on colour alone: each step carries a mark and a text label element.
  for (const name of ['mcp', 'origin', 'tier'])
    assert.ok(checklist.includes(`id="setup-state-${name}"`) && checklist.includes(`id="setup-mark-${name}"`));
  assert.match(html, /id="setup-reopen" class="link-button" hidden/);
});

test('every new Japanese string has an English twin in the data-i18n pattern', async () => {
  for (const language of ['ja', 'en']) {
    const html = (await panelHtml(language)).replace(/<p class="hint"><span data-i18n-ja>更新元[\s\S]*?<\/p>/, '');
    const text = html
      .replace(/<option\b[\s\S]*?<\/option>/g, '')
      .replace(/<span data-i18n-ja>[^<]*<\/span>/g, '')
      .replace(/<[^>]*>/g, '>');
    assert.doesNotMatch(text, /[぀-ヿ一-鿿]/, 'Japanese text only appears inside data-i18n-ja spans');
    assert.equal((html.match(/data-i18n-ja/g) ?? []).length, (html.match(/data-i18n-en/g) ?? []).length);
  }
  const html = await panelHtml();
  assert.match(html, /<span data-i18n-ja>いまの AI の権限<\/span><span data-i18n-en>What the AI can do now<\/span>/);
  assert.match(
    html,
    /<ul class="client-list" id="site-grants" aria-label="書き込みの継続許可 \/ Standing write grants" hidden><\/ul>/,
  );
  assert.match(html, /<span data-i18n-ja>はじめの設定<\/span><span data-i18n-en>First-time setup<\/span>/);
});
