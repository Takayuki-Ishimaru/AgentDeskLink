const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '../..');
const currentVersion = require('../../package.json').version;
const nextVersion = require('semver').inc(currentVersion, 'patch');
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
class Emitter {
  listeners = [];
  event = fn => {
    this.listeners.push(fn);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter(x => x !== fn);
      },
    };
  };
  fire(value) {
    for (const fn of [...this.listeners]) fn(value);
  }
  dispose() {
    this.listeners = [];
  }
}
function makeBundle(root, options = {}) {
  const rt = path.join(root, 'runtime');
  fs.mkdirSync(path.join(rt, 'helper'), { recursive: true });
  const isWin = process.platform === 'win32';
  const helperRel =
    process.platform === 'darwin'
      ? 'helper/adl-macos-ax-helper'
      : isWin
        ? 'helper/adl-windows-uia-helper.exe'
        : 'helper/adl-linux-atspi-helper';
  const manifest = {
    schemaVersion: 2,
    target: `${process.platform}-${process.arch}`,
    nodeVersion: 'v24.22.1',
    playwrightVersion: '1.64.1',
    node: isWin ? 'node.exe' : 'node',
    browserMode: 'auto',
    helper: helperRel,
    ...options.manifest,
  };
  const entries = Object.entries({
    [manifest.node]: '#!/bin/sh\n',
    ...(typeof manifest.helper === 'string' && manifest.helper ? { [manifest.helper]: 'x' } : {}),
  });
  for (const [rel, data] of entries) {
    const file = path.join(rt, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    if (!isWin) fs.chmodSync(file, 0o755);
  }
  fs.writeFileSync(path.join(rt, 'manifest.json'), JSON.stringify({ ...manifest }));
  if (options.dropNode) fs.rmSync(path.join(rt, manifest.node), { force: true });
  if (options.dropHelper && manifest.helper) fs.rmSync(path.join(rt, ...manifest.helper.split('/')), { force: true });
  return rt;
}

function harness(initial = {}, options = {}) {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'adl-extension-')));
  const extensionRoot = path.join(temp, 'extension');
  fs.mkdirSync(extensionRoot, { recursive: true });
  if (options.bundle !== false) makeBundle(extensionRoot, options);
  const targetName = `${process.platform}-${process.arch}`;
  const browserSentinels = {};
  for (const [mode, dir] of [
    ['headless', `1.64.1-${targetName}`],
    ['headful', `1.64.1-${targetName}-headful`],
  ]) {
    const cache = path.join(temp, 'storage', 'browsers', dir);
    fs.mkdirSync(cache, { recursive: true });
    const sentinel = `${mode}-browser`;
    fs.writeFileSync(path.join(cache, sentinel), 'browser');
    fs.chmodSync(path.join(cache, sentinel), 0o755);
    fs.writeFileSync(
      path.join(cache, 'ready.json'),
      JSON.stringify({ schemaVersion: 1, version: '1.64.1', target: targetName, executable: sentinel }),
    );
    browserSentinels[mode] = path.join(cache, sentinel);
  }
  const uri = value => ({ fsPath: value, path: value, scheme: 'file', toString: () => `file://${value}` });
  const config = {
    enabled: false,
    nodePath: '',
    configPath: '',
    autoUpdate: true,
    checkForUpdates: true,
    updateManifestUrl: '',
    ...initial,
  };
  const changes = new Emitter(),
    folders = new Emitter(),
    trust = new Emitter();
  const commands = new Map(),
    providers = new Map(),
    views = new Map(),
    writes = [],
    executions = [],
    notifications = [],
    posts = [],
    warnings = [],
    dialogs = [];
  const state = new Map();
  const subscriptions = [];
  const vscode = {
    EventEmitter: Emitter,
    Disposable: class {
      constructor(fn) {
        this.dispose = fn;
      }
      static from(...xs) {
        return {
          dispose() {
            xs.forEach(x => x.dispose());
          },
        };
      }
    },
    Uri: {
      file: uri,
      parse: value => ({ ...uri(value), scheme: value.split(':')[0] }),
      joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)),
    },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    McpStdioServerDefinition: class {
      constructor(label, command, args, env, version) {
        Object.assign(this, { label, command, args, env, version });
      }
    },
    RelativePattern: class {
      constructor(base, pattern) {
        Object.assign(this, { base, pattern });
      }
    },
    env: {
      language: options.language ?? 'ja',
      machineId: options.machineId,
      openExternal: async () => true,
      clipboard: { writeText: async () => {} },
    },
    workspace: {
      isTrusted: options.trusted !== false,
      workspaceFolders: options.empty ? undefined : [{ name: 'Example', uri: uri(temp), index: 0 }],
      workspaceFile: undefined,
      getConfiguration: () => ({
        get: (key, fallback) => config[key] ?? fallback,
        inspect: key => ({ workspaceValue: config[key] }),
        update: async (key, value, target) => {
          if (options.failSave) throw new Error('read-only settings');
          writes.push({ key, value, target });
          config[key] = value;
          changes.fire({
            affectsConfiguration: section => section === 'agentdesklink' || section === `agentdesklink.${key}`,
          });
        },
      }),
      onDidChangeConfiguration: changes.event,
      onDidChangeWorkspaceFolders: folders.event,
      onDidGrantWorkspaceTrust: trust.event,
      createFileSystemWatcher: () => ({
        onDidChange: new Emitter().event,
        onDidCreate: new Emitter().event,
        onDidDelete: new Emitter().event,
        dispose() {},
      }),
      openTextDocument: async value => value,
      fs: {
        stat: async u => fs.promises.stat(u.fsPath),
        readFile: async u => fs.promises.readFile(u.fsPath),
        writeFile: async (u, data) => fs.promises.writeFile(u.fsPath, data),
        createDirectory: async u => fs.promises.mkdir(u.fsPath, { recursive: true }),
      },
    },
    window: {
      registerWebviewViewProvider: (id, provider) => {
        views.set(id, provider);
        return { dispose() {} };
      },
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      showErrorMessage: async text => {
        notifications.push(text);
      },
      showWarningMessage: async (...args) => {
        notifications.push(args[0]);
        warnings.push(args);
        return typeof options.confirmWarning === 'function' ? options.confirmWarning(args) : options.confirmWarning;
      },
      showInformationMessage: async text => {
        notifications.push(text);
      },
      showOpenDialog: async (...args) => {
        dialogs.push(args);
        return options.openDialog;
      },
      showTextDocument: async () => {},
      withProgress: async (_opts, fn) =>
        fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: new Emitter().event }),
    },
    ProgressLocation: { Notification: 15 },
    commands: {
      registerCommand: (id, fn) => {
        commands.set(id, fn);
        return { dispose() {} };
      },
      executeCommand: async (id, ...args) => {
        executions.push({ id, args });
        return commands.get(id)?.(...args);
      },
    },
    lm: {
      registerMcpServerDefinitionProvider: (id, provider) => {
        providers.set(id, provider);
        return { dispose() {} };
      },
    },
  };
  const context = {
    subscriptions,
    extensionUri: uri(extensionRoot),
    extensionPath: extensionRoot,
    globalStorageUri: uri(path.join(temp, 'storage')),
    storageUri: uri(path.join(temp, 'workspace-storage')),
    extension: { id: 'agentdesklink.agentdesklink', packageJSON: require('../../package.json') },
    globalState: {
      get: (key, fallback) => state.get(key) ?? fallback,
      update: async (key, value) => {
        state.set(key, value);
      },
    },
    workspaceState: { get: (_key, fallback) => fallback, update: async () => {} },
  };
  const module = { exports: {} };
  // Deterministic installed-browser probe: candidates outside the private storage dir never resolve,
  // so the published executable always comes from the selected mode's cache on every test host.
  const noInstalledBrowser = Object.assign(Object.create(fs.promises), {
    realpath: async file => {
      const resolved = path.resolve(String(file));
      if (resolved !== path.resolve(temp) && !resolved.startsWith(path.resolve(temp) + path.sep))
        throw new Error('no installed browser');
      return fs.promises.realpath(file);
    },
  });
  vm.runInNewContext(fs.readFileSync(path.join(root, 'dist/extension/extension.cjs'), 'utf8'), {
    module,
    exports: module.exports,
    require: name =>
      name === 'vscode'
        ? vscode
        : name === 'node:fs'
          ? fs
          : name === 'node:fs/promises'
            ? noInstalledBrowser
            : require(name),
    __dirname: path.join(root, 'dist/extension'),
    __filename: path.join(root, 'dist/extension/extension.cjs'),
    process,
    console,
    Buffer,
    URL,
    AbortController,
    AbortSignal,
    TextDecoder,
    TextEncoder,
    fetch: (...args) =>
      options.fetch ? options.fetch(...args) : Promise.reject(new Error('unexpected network request')),
    setTimeout: options.setTimeout ?? setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
  });
  const ready = Promise.resolve(module.exports.activate(context));
  cleanups.push(async () => {
    subscriptions
      .slice()
      .reverse()
      .forEach(x => x.dispose?.());
    await module.exports.deactivate?.();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  return {
    ready,
    vscode,
    config,
    temp,
    extensionRoot,
    writes,
    commands,
    providers,
    executions,
    notifications,
    posts,
    warnings,
    dialogs,
    state,
    changes,
    browserSentinels,
    deactivate: async () => {
      await module.exports.deactivate?.();
    },
    async panel() {
      await ready;
      const provider = views.get('agentdesklink.settings');
      assert.ok(provider, 'settings view provider registered');
      let receive;
      const view = {
        visible: true,
        show() {},
        onDidDispose: new Emitter().event,
        onDidChangeVisibility: new Emitter().event,
        webview: {
          options: {},
          cspSource: 'vscode-webview:',
          asWebviewUri: x => x,
          html: '',
          postMessage: async x => {
            posts.push(x);
            return true;
          },
          onDidReceiveMessage: fn => {
            receive = fn;
            return { dispose() {} };
          },
        },
      };
      await provider.resolveWebviewView(view, {}, { isCancellationRequested: false });
      return {
        view,
        send: async message => {
          await receive(message);
          await new Promise(resolve => setImmediate(resolve));
        },
      };
    },
  };
}

test('manifest contributes the sidebar, workspace switch and application update settings', () => {
  const pkg = require('../../package.json');
  assert.equal(pkg.main, './dist/extension/extension.cjs');
  assert.ok(
    pkg.contributes.viewsContainers.activitybar.some(
      x => x.id === 'agentdesklink' && fs.existsSync(path.join(root, x.icon)),
    ),
  );
  assert.ok(pkg.contributes.views.agentdesklink.some(x => x.id === 'agentdesklink.settings' && x.type === 'webview'));
  assert.ok(
    pkg.contributes.mcpServerDefinitionProviders.some(x => x.id === 'agentdesklink.mcp' && x.label === 'AgentDeskLink'),
  );
  assert.equal(pkg.galleryBanner.color, '#191827');
  const props = pkg.contributes.configuration.properties;
  assert.equal(props['agentdesklink.enabled'].default, false);
  assert.equal(props['agentdesklink.enabled'].scope, 'window');
  for (const key of [
    'allowAllOperations',
    'allowPhysicalInput',
    'allowUnredactedImages',
    'allowLoopback',
    'allowPrivateNetwork',
    'allowPersonalData',
  ]) {
    assert.equal(props[`agentdesklink.${key}`].default, false);
    assert.equal(props[`agentdesklink.${key}`].scope, 'window');
  }
  assert.deepEqual(props['agentdesklink.browserOrigins'].default, []);
  assert.deepEqual(props['agentdesklink.browserResourceOrigins'].default, []);
  assert.equal(props['agentdesklink.browserResourceOrigins'].scope, 'window');
  assert.equal(props['agentdesklink.allowPersonalData'].default, false);
  assert.equal(props['agentdesklink.allowPersonalData'].scope, 'window');
  assert.equal(props['agentdesklink.sessionIdleMinutes'].default, 15);
  assert.equal(props['agentdesklink.sessionIdleMinutes'].scope, 'window');
  assert.equal(props['agentdesklink.sessionIdleMinutes'].minimum, 1);
  assert.equal(props['agentdesklink.sessionIdleMinutes'].maximum, 60);
  assert.equal(props['agentdesklink.browserHeadless'].default, true);
  assert.equal(props['agentdesklink.browserHeadless'].scope, 'window');
  assert.equal(props['agentdesklink.browserProxyServer'].default, '');
  assert.equal(props['agentdesklink.browserProxyServer'].scope, 'window');
  for (const key of ['desktopAppId', 'desktopAppPath']) assert.equal(props[`agentdesklink.${key}`].default, '');
  for (const key of ['autoUpdate', 'checkForUpdates']) assert.equal(props[`agentdesklink.${key}`].scope, 'application');
  assert.equal(props['agentdesklink.updateManifestUrl'], undefined, 'the update source is fixed to GitHub');
  const css = fs.readFileSync(path.join(root, 'media/settings.css'), 'utf8').toLowerCase();
  for (const hex of ['#ff6b1a', '#c6a7e8', '#4057d6', '#191827', '#f2eef5']) assert.ok(css.includes(hex));
  assert.ok(css.includes('--vscode-foreground'));
  assert.ok(css.includes('--vscode-focusborder'));
  assert.ok(
    !(pkg.files?.length && fs.existsSync(path.join(root, '.vscodeignore'))),
    'VSCE forbids combining files with .vscodeignore',
  );
});
test('MCP is opt-in and absent in empty and untrusted windows', async () => {
  for (const options of [{}, { empty: true }, { trusted: false }]) {
    const h = harness({ enabled: !!options.empty || options.trusted === false }, options);
    await h.ready;
    const p = h.providers.get('agentdesklink.mcp');
    assert.ok(p);
    assert.equal((await p.provideMcpServerDefinitions()).length, 0);
  }
});
test('enabled MCP uses bundled Node with default-deny permissions and no legacy policy inputs', async () => {
  const h = harness({ enabled: true, nodePath: '/invalid/old/node', configPath: 'missing-policy.json' });
  await h.ready;
  const p = h.providers.get('agentdesklink.mcp'),
    [definition] = await p.provideMcpServerDefinitions();
  assert.equal(
    definition.command,
    path.join(h.extensionRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
  );
  assert.deepEqual(Array.from(definition.args), ['--use-system-ca', path.join(h.extensionRoot, 'dist/src/server.js')]);
  assert.equal(definition.env.ADL_ALLOW_ALL_OPERATIONS, undefined);
  assert.deepEqual(JSON.parse(definition.env.ADL_MCP_PERMISSIONS), {
    browserOrigins: [],
    browserResourceOrigins: [],
    allowPersonalData: false,
    desktopAppId: '',
    desktopAppPath: '',
    allowAllOperations: false,
    operationMode: 'read_only',
    allowPhysicalInput: false,
    allowUnredactedImages: false,
    allowLoopback: false,
    allowPrivateNetwork: false,
  });
  assert.ok(definition.env.ADL_OPERATION_CONTROL);
  assert.ok(definition.env.ADL_OPERATION_EPOCH);
  assert.match(definition.env.ADL_APPROVAL_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(definition.env.ADL_APPROVAL_TOKEN, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(definition.env.ADL_APPROVAL_EPOCH, definition.env.ADL_OPERATION_EPOCH);
  let refreshed = 0;
  p.onDidChangeMcpServerDefinitions(() => refreshed++);
  h.config.enabled = false;
  h.changes.fire({ affectsConfiguration: name => name.startsWith('agentdesklink') });
  assert.ok(refreshed > 0);
  assert.equal((await p.provideMcpServerDefinitions()).length, 0);
});
test('approval broker requires a host modal and consumes a one-shot decision atomically', async () => {
  const h = harness(
    { enabled: true, operationMode: 'ask', browserOrigins: ['https://example.com'] },
    { confirmWarning: 'Approve once / 今回のみ許可' },
  );
  await h.ready;
  const [definition] = await h.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
  const request_id = crypto.randomUUID(),
    server_id = crypto.randomUUID(),
    binding = 'b'.repeat(64),
    expires_at = Date.now() + 60_000;
  const post = await fetch(`${definition.env.ADL_APPROVAL_URL}/v1/requests`, {
    method: 'POST',
    headers: { authorization: `Bearer ${definition.env.ADL_APPROVAL_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      v: 1,
      request_id,
      server_id,
      control_epoch: definition.env.ADL_APPROVAL_EPOCH,
      binding,
      expires_at,
      summary: {
        action: 'fill',
        surface: 'browser',
        target: 'Example',
        origin: 'https://example.com',
        risk: 'consequential',
        value: { kind: 'public', length: 23, preview: 'line one\nsecond\t"quote"' },
      },
    }),
  });
  assert.equal(post.status, 201);
  assert.equal((await post.json()).status, 'pending');
  let reply;
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    const response = await fetch(`${definition.env.ADL_APPROVAL_URL}/v1/requests/${request_id}`, {
      headers: { authorization: `Bearer ${definition.env.ADL_APPROVAL_TOKEN}` },
    });
    reply = await response.json();
    if (reply.status !== 'pending') break;
  }
  assert.equal(reply.status, 'approved');
  assert.ok(
    h.notifications.some(message => String(message).includes('"line one\\nsecond\\t\\"quote\\""')),
    'multiline preview is visibly escaped in the native modal',
  );
  const consumed = await fetch(`${definition.env.ADL_APPROVAL_URL}/v1/requests/${request_id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${definition.env.ADL_APPROVAL_TOKEN}` },
  });
  assert.equal((await consumed.json()).consumed_now, true);
  const replay = await fetch(`${definition.env.ADL_APPROVAL_URL}/v1/requests/${request_id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${definition.env.ADL_APPROVAL_TOKEN}` },
  });
  assert.equal((await replay.json()).consumed_now, false);
  assert.ok(h.notifications.some(message => String(message).includes('asks to approve this browser action once')));
});
test('Ask broker is withheld when physical native control targets the VS Code host', async () => {
  const h = harness({
    enabled: true,
    operationMode: 'ask',
    browserOrigins: ['https://example.com'],
    desktopAppId: 'host-app',
    desktopAppPath: process.execPath,
    allowPhysicalInput: true,
    allowUnredactedImages: true,
  });
  const panel = await h.panel();
  const [definition] = await h.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
  assert.equal(
    definition.env.ADL_APPROVAL_URL,
    undefined,
    'the one-shot capability is not given to a host-controlling native target',
  );
  assert.match(h.posts.at(-1).status.mcp, /native target can control the VS Code host/);
  assert.ok(h.posts.at(-1).permissions.effective.reasons.some(reason => reason.includes('click its approval dialog')));
  assert.ok(panel.view.webview.html.includes('operation-mode'));
  const remote = harness({
    enabled: true,
    operationMode: 'ask',
    browserOrigins: ['https://example.com'],
    desktopAppId: 'remote-app',
    desktopAppPath: path.join(h.temp, 'remote-app'),
    allowPhysicalInput: true,
    allowUnredactedImages: true,
  });
  remote.vscode.env.remoteName = 'ssh-remote+example';
  await remote.ready;
  const [remoteDefinition] = await remote.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
  assert.equal(remoteDefinition.env.ADL_APPROVAL_URL, undefined, 'remote target identity is treated as unknown');
  const remotePanel = await remote.panel();
  assert.match(remote.posts.at(-1).status.mcp, /remote extension host cannot safely identify/);
});
test('stop command and sidebar revoke definitions and explicit resume creates a fresh generation', async () => {
  const h = harness({ enabled: true }),
    panel = await h.panel(),
    p = h.providers.get('agentdesklink.mcp');
  const [before] = await p.provideMcpServerDefinitions();
  assert.doesNotMatch(panel.view.webview.html, /id="(?:node-path|config-path|config-select|config-open)"/);
  assert.match(panel.view.webview.html, /id="emergency-stop"/);
  assert.equal(h.commands.has('agentdesklink.selectPolicy'), false);
  const props = require('../../package.json').contributes.configuration.properties;
  assert.equal(props['agentdesklink.nodePath'], undefined);
  assert.equal(props['agentdesklink.configPath'], undefined);
  await panel.send({ type: 'emergencyStop' });
  assert.equal((await p.provideMcpServerDefinitions()).length, 0);
  assert.equal(JSON.parse(fs.readFileSync(before.env.ADL_OPERATION_CONTROL, 'utf8')).stopped, true);
  assert.equal(h.posts.at(-1).stopped, true);
  await h.commands.get('agentdesklink.resumeOperations')();
  const [after] = await p.provideMcpServerDefinitions();
  assert.notEqual(before.env.ADL_OPERATION_EPOCH, after.env.ADL_OPERATION_EPOCH);
  assert.notEqual(before.version, after.version);
});
test('stop stays available in untrusted and empty windows and ignores removed UI messages', async () => {
  for (const options of [{ trusted: false }, { empty: true }]) {
    const h = harness({}, options),
      panel = await h.panel();
    await panel.send({ type: 'emergencyStop' });
    assert.equal(h.posts.at(-1).stopped, true);
    await h.commands.get('agentdesklink.emergencyStop')();
    for (const type of ['setNodePath', 'setConfigPath', 'selectPolicy', 'openPolicy'])
      await panel.send({ type, value: 'ignored' });
    assert.equal(h.writes.length, 0);
    await panel.send({ type: 'resumeOperations' });
    assert.equal(h.posts.at(-1).stopped, false);
  }
});
test('panel saves workspace and user scopes, validates messages and provides CSP', async () => {
  const h = harness();
  const panel = await h.panel();
  assert.match(panel.view.webview.html, /Content-Security-Policy/);
  assert.match(panel.view.webview.html, /default-src 'none'/);
  assert.equal(panel.view.webview.options.enableScripts, true);
  await panel.send({ type: 'setEnabled', enabled: true });
  assert.ok(h.writes.some(x => x.key === 'enabled' && x.value === true && x.target === 2));
  await panel.send({ type: 'setAutoUpdate', enabled: false });
  assert.ok(h.writes.some(x => x.key === 'autoUpdate' && x.value === false && x.target === 1));
  await panel.send({ type: 'setCheckForUpdates', enabled: false });
  assert.ok(h.writes.some(x => x.key === 'checkForUpdates' && x.value === false && x.target === 1));
  assert.equal(h.posts.at(-1).busy.check, false);
  await panel.send({ type: 'checkForUpdates' });
  assert.equal(h.posts.at(-1).busy.checkNow, false);
  const count = h.writes.length;
  for (const value of [
    null,
    [],
    { type: 'setEnabled', enabled: 'false' },
    { type: 'setAutoUpdate', enabled: 1 },
    { type: 'setAllowLoopback', enabled: 'true' },
    { type: 'setBrowserResourceOrigins', origins: [null] },
    { type: 'unknown' },
  ])
    await panel.send(value);
  assert.equal(h.writes.length, count);
});
test('language picker starts from vscode.env.language and keeps the nonce CSP', async () => {
  for (const [language, expected] of [
    ['ja-JP', 'ja'],
    ['en-US', 'en'],
  ]) {
    const h = harness({}, { language }),
      panel = await h.panel();
    assert.match(panel.view.webview.html, new RegExp(`<html lang=\"${expected}\">`));
    assert.match(panel.view.webview.html, /id=\"ui-language\"/);
    assert.match(panel.view.webview.html, /data-i18n-ja/);
    assert.match(panel.view.webview.html, /data-i18n-en/);
    assert.ok(
      [...panel.view.webview.html.matchAll(/<option[^>]*>(.*?)<\/option>/gs)].every(
        ([, body]) => !body.includes('<span'),
      ),
    );
    assert.match(panel.view.webview.html, /script-src 'nonce-[^']+'/);
  }
});
test('panel saves normalized browser origins through workspace permission validation', async () => {
  const h = harness({ browserOrigins: [] }),
    panel = await h.panel();
  await panel.send({ type: 'setBrowserOrigins', origins: ['https://Example.com/', 'https://example.com'] });
  const write = h.writes.find(x => x.key === 'browserOrigins');
  assert.deepEqual(Array.from(write.value), ['https://example.com']);
  assert.equal(write.target, 2);
  assert.deepEqual(Array.from(h.posts.at(-1).settings.browserOrigins), ['https://example.com']);
  const count = h.writes.length;
  await panel.send({ type: 'setBrowserOrigins', origins: ['https://example.com/path'] });
  assert.equal(h.writes.length, count, 'invalid origin is rejected before persistence');
  assert.match(h.posts.at(-1).status.originsError, /browserOrigins|Browser origins/);
});
test('panel saves exact resource origins and trusted boolean grants with default-deny env transport', async () => {
  const h = harness({
      enabled: true,
      browserOrigins: [],
      browserResourceOrigins: [],
      allowLoopback: false,
      allowPrivateNetwork: false,
      allowPersonalData: false,
    }),
    panel = await h.panel();
  await panel.send({ type: 'setBrowserResourceOrigins', origins: ['https://CDN.example/', 'https://cdn.example'] });
  assert.deepEqual(Array.from(h.writes.find(x => x.key === 'browserResourceOrigins').value), ['https://cdn.example']);
  const writes = h.writes.length;
  await panel.send({ type: 'setBrowserResourceOrigins', origins: ['https://cdn.example/path'] });
  assert.equal(h.writes.length, writes, 'paths are rejected before persistence');
  await panel.send({ type: 'setAllowLoopback', enabled: true });
  await panel.send({ type: 'setAllowPrivateNetwork', enabled: true });
  await panel.send({ type: 'setAllowPersonalData', enabled: true });
  assert.ok(h.writes.some(x => x.key === 'allowLoopback' && x.value === true && x.target === 2));
  assert.ok(h.writes.some(x => x.key === 'allowPrivateNetwork' && x.value === true && x.target === 2));
  assert.ok(h.writes.some(x => x.key === 'allowPersonalData' && x.value === true && x.target === 2));
  const [definition] = await h.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
  const permissions = JSON.parse(definition.env.ADL_MCP_PERMISSIONS);
  assert.deepEqual(permissions.browserResourceOrigins, ['https://cdn.example']);
  assert.equal(permissions.allowLoopback, true);
  assert.equal(permissions.allowPrivateNetwork, true);
  assert.equal(permissions.allowPersonalData, true);
});
test('panel saves the bounded session idle timeout as a workspace runtime setting', async () => {
  const h = harness({ sessionIdleMinutes: 15 }),
    panel = await h.panel();
  await panel.send({ type: 'setSessionIdleMinutes', minutes: 30 });
  const write = h.writes.find(x => x.key === 'sessionIdleMinutes');
  assert.equal(write.value, 30);
  assert.equal(write.target, 2);
  assert.equal(h.posts.at(-1).settings.sessionIdleMinutes, 30);
  const count = h.writes.length;
  await panel.send({ type: 'setSessionIdleMinutes', minutes: 60.5 });
  assert.equal(h.writes.length, count, 'fractional minutes are rejected before persistence');
  assert.match(h.posts.at(-1).status.runtimeError, /1〜60|whole number/);
});
test('panel validates and normalizes headless/proxy runtime settings without exposing proxy credentials', async () => {
  const h = harness({ browserHeadless: true, browserProxyServer: '' }),
    panel = await h.panel();
  await panel.send({ type: 'setBrowserHeadless', enabled: false });
  assert.ok(h.writes.some(x => x.key === 'browserHeadless' && x.value === false && x.target === 2));
  await panel.send({ type: 'setBrowserProxyServer', proxy: 'https://Proxy.Example:8443/' });
  assert.ok(
    h.writes.some(x => x.key === 'browserProxyServer' && x.value === 'https://proxy.example:8443' && x.target === 2),
  );
  const count = h.writes.length;
  await panel.send({ type: 'setBrowserProxyServer', proxy: 'http://user:secret@proxy.example:8080' });
  assert.equal(h.writes.length, count, 'credential-bearing proxy URLs are rejected');
  assert.doesNotMatch(JSON.stringify(h.posts.at(-1)), /secret/, 'proxy credentials are never posted to the webview');
  assert.match(h.posts.at(-1).status.runtimeError, /Invalid runtime setting/);
});
test('permission tier can move directly from legacy all to standard and confirms all in the native host', async () => {
  const h = harness({ allowAllOperations: true, operationMode: 'read_only' }),
    panel = await h.panel();
  await panel.send({ type: 'setOperationMode', mode: 'standard' });
  assert.ok(h.writes.some(x => x.key === 'allowAllOperations' && x.value === false && x.target === 2));
  assert.ok(h.writes.some(x => x.key === 'operationMode' && x.value === 'standard' && x.target === 2));
  assert.equal(h.posts.at(-1).permissions.effective.operationMode, 'standard');
  const all = harness(
      { allowAllOperations: false, operationMode: 'standard' },
      { confirmWarning: 'すべて許可 / Allow all' },
    ),
    allPanel = await all.panel();
  await allPanel.send({ type: 'setOperationMode', mode: 'all' });
  assert.ok(all.writes.some(x => x.key === 'allowAllOperations' && x.value === true && x.target === 2));
  assert.ok(!all.writes.some(x => x.key === 'operationMode' && x.value === 'all'));
});
test('untrusted or empty panel refuses workspace writes and saving failure is surfaced', async () => {
  for (const opts of [{ trusted: false }, { empty: true }]) {
    const h = harness({}, opts),
      panel = await h.panel();
    await panel.send({ type: 'setEnabled', enabled: true });
    assert.ok(!h.writes.some(x => x.key === 'enabled'));
  }
  const h = harness({}, { failSave: true }),
    panel = await h.panel();
  await panel.send({ type: 'setEnabled', enabled: true });
  assert.ok(h.notifications.length || h.posts.some(x => JSON.stringify(x).includes('error')));
});
const githubRepo = 'https://github.com/Takayuki-Ishimaru/AgentDeskLink';
const githubApi = 'https://api.github.com/repos/Takayuki-Ishimaru/AgentDeskLink/releases?per_page=100';
const assetName = (version, target = `${process.platform}-${process.arch}`) =>
  `agentdesklink-${target}-${version}.vsix`;
function githubReleases(version, options = {}) {
  const name = assetName(version, options.target);
  return [
    {
      tag_name: `v${version}`,
      draft: options.draft ?? false,
      prerelease: true,
      assets: [
        {
          name,
          state: options.state ?? 'uploaded',
          digest: `sha256:${options.digest ?? 'a'.repeat(64)}`,
          browser_download_url: options.url ?? `${githubRepo}/releases/download/v${version}/${name}`,
        },
      ],
    },
  ];
}
// Mocks the fixed GitHub endpoints only: metadata is the Releases API, the asset is the canonical download URL.
function updateServer(body, options = {}) {
  const bytes = options.bytes ?? Buffer.from('test-vsix');
  const requests = [];
  const fetch = (url, init) => {
    const target = String(url);
    requests.push(target);
    if (options.hang && options.hang(target))
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    if (options.fail && options.fail(target)) return Promise.reject(new Error('network down'));
    if (target === githubApi)
      return Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 }));
    if (target === `${githubRepo}/releases/download/v${options.version}/${assetName(options.version)}`)
      return Promise.resolve(new Response(bytes));
    return Promise.reject(new Error(`unexpected request: ${target}`));
  };
  const counts = () => ({
    metadata: requests.filter(x => x === githubApi).length,
    downloads: requests.filter(x => x !== githubApi).length,
  });
  return { fetch, requests, counts };
}
const installs = h => h.executions.filter(x => x.id === 'workbench.extensions.installExtension').length;
const updateStatus = h => h.posts.at(-1)?.status?.update ?? '';
test('disabled checks make no request while defaults and legacy URL settings use the fixed endpoint', async () => {
  for (const config of [
    { checkForUpdates: false },
    { checkForUpdates: false, updateManifestUrl: 'https://updates.example/manifest.json' },
  ]) {
    const server = updateServer(githubReleases(nextVersion, { digest: 'a'.repeat(64) }));
    const h = harness(config, server);
    await h.ready;
    await h.commands.get('agentdesklink.checkForUpdates')();
    assert.deepEqual(server.requests, [], JSON.stringify(config));
  }
  for (const config of [
    {},
    { updateManifestUrl: '' },
    { updateManifestUrl: 'https://updates.example/manifest.json' },
  ]) {
    const server = updateServer([]);
    const h = harness(config, server);
    await h.ready;
    await h.commands.get('agentdesklink.checkForUpdates')();
    assert.deepEqual(server.requests, [githubApi], JSON.stringify(config));
  }
});
test('auto update installs the fixed GitHub asset once and ignores legacy URLs on the download too', async () => {
  const releases = githubReleases(nextVersion);
  const bytes = Buffer.from('test-vsix');
  releases[0].assets[0].digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  const api = updateServer(releases, { version: nextVersion, bytes });
  const h = harness({ updateManifestUrl: 'https://updates.example/evil.vsix' }, api);
  await h.ready;
  await Promise.all([
    h.commands.get('agentdesklink.checkForUpdates')(),
    h.commands.get('agentdesklink.checkForUpdates')(),
  ]);
  assert.equal(api.counts().metadata, 1, 'concurrent checks coalesce into one metadata request');
  assert.equal(api.counts().downloads, 1, 'one download for the canonical GitHub asset');
  assert.equal(installs(h), 1, 'a single install');
  assert.equal(api.requests[1], `${githubRepo}/releases/download/v${nextVersion}/${assetName(nextVersion)}`);
  await h.commands.get('agentdesklink.checkForUpdates')();
  assert.equal(installs(h), 1, 'never installs twice');
  // Turning autoUpdate off during the metadata request must prevent installation.
  const slow = updateServer(githubReleases(nextVersion), {
    version: nextVersion,
    bytes,
    hang: url => url === githubApi,
  });
  const r = harness({}, slow);
  await r.ready;
  const check = r.commands.get('agentdesklink.checkForUpdates')();
  r.config.autoUpdate = false;
  r.changes.fire({ affectsConfiguration: name => name.startsWith('agentdesklink') });
  await check;
  assert.equal(installs(r), 0);
});
test('notification-only mode never downloads and a digest mismatch never installs', async () => {
  const releases = githubReleases(nextVersion);
  const notify = updateServer(releases, { version: nextVersion });
  const h = harness({ autoUpdate: false }, notify);
  await h.ready;
  await h.commands.get('agentdesklink.checkForUpdates')();
  assert.equal(notify.counts().downloads, 0, 'notification-only mode makes no VSIX request');
  assert.ok(h.notifications.some(text => text.includes(nextVersion)));
  assert.equal(installs(h), 0);
  const wrong = githubReleases(nextVersion, { digest: 'a'.repeat(64) });
  const gserver = updateServer(wrong, { version: nextVersion, bytes: Buffer.from('real bytes') });
  const g = harness({}, gserver);
  await g.ready;
  await g.panel();
  await g.commands.get('agentdesklink.checkForUpdates')();
  assert.equal(gserver.counts().downloads, 1, 'the canonical asset is downloaded before hashing');
  assert.equal(installs(g), 0, 'a mismatched SHA-256 never installs');
  assert.match(updateStatus(g), /確認できませんでした/);
});
test('equal, older, incompatible and malformed releases never download or install', async () => {
  for (const version of [currentVersion, '0.0.0']) {
    const server = updateServer(githubReleases(version), { version });
    const h = harness({}, server);
    await h.ready;
    await h.panel();
    await h.commands.get('agentdesklink.checkForUpdates')();
    assert.deepEqual(server.requests, [githubApi]);
    assert.equal(installs(h), 0);
    assert.match(updateStatus(h), /最新のバージョンです/);
  }
  const none = updateServer(githubReleases(nextVersion, { target: 'plan9-mips' }), { version: nextVersion });
  const n = harness({}, none);
  await n.ready;
  await n.panel();
  await n.commands.get('agentdesklink.checkForUpdates')();
  assert.deepEqual(none.requests, [githubApi], 'no asset request for an incompatible target');
  assert.equal(installs(n), 0);
  assert.match(updateStatus(n), /OS・CPU に対応する更新/);
  for (const body of [{ message: 'rate limited' }, 'not json']) {
    const server = updateServer(body, { version: nextVersion });
    const h = harness({}, server);
    await h.ready;
    await h.panel();
    await h.commands.get('agentdesklink.checkForUpdates')();
    assert.equal(installs(h), 0);
    assert.match(updateStatus(h), /確認できませんでした/);
  }
});
const rolloutBucket = (id, version) =>
  crypto.createHash('sha256').update(`${id}\n${version}`).digest().readUInt32BE(0) % 100;
const machineWithBucket = (version, accept) => {
  for (let i = 0; ; i++) if (accept(rolloutBucket(`machine-${i}`, version))) return `machine-${i}`;
};
// The startup timer is captured instead of waited for. A manual request issued while that automatic run is in flight joins it, so the run can be awaited.
async function updateOffered(body, { manual, machineId = 'machine-0' }) {
  const startup = [];
  const server = updateServer(
    githubReleases(nextVersion).map(x => ({ ...x, body })),
    { version: nextVersion },
  );
  const h = harness(
    { autoUpdate: false },
    {
      ...server,
      machineId,
      setTimeout: (fn, ms, ...rest) =>
        ms === 5_000 ? (startup.push(fn), { unref() {} }) : setTimeout(fn, ms, ...rest),
    },
  );
  await h.ready;
  await h.panel();
  if (!manual) {
    assert.equal(startup.length, 1, 'one automatic startup check is scheduled');
    startup[0]();
  }
  await h.commands.get('agentdesklink.checkForUpdates')();
  assert.deepEqual(server.requests, [githubApi]);
  return h.notifications.some(text => text.includes(nextVersion)) && /利用可能/.test(updateStatus(h));
}
const rolloutNotes = percent => `Notes\n<!-- adl-rollout: ${percent} -->\n`;
test('automatic update checks follow the staged rollout share for the VS Code machine id', async () => {
  const below = machineWithBucket(nextVersion, bucket => bucket < 50),
    above = machineWithBucket(nextVersion, bucket => bucket >= 50);
  for (const body of [undefined, rolloutNotes(100)])
    assert.equal(await updateOffered(body, { manual: false }), true, String(body));
  for (const body of [rolloutNotes(0), rolloutNotes('abc')])
    assert.equal(await updateOffered(body, { manual: false }), false, body);
  assert.equal(
    await updateOffered(rolloutNotes(50), { manual: false, machineId: below }),
    true,
    'bucket below the share',
  );
  assert.equal(
    await updateOffered(rolloutNotes(50), { manual: false, machineId: above }),
    false,
    'bucket above the share',
  );
});
test('manual update checks ignore the staged rollout marker', async () => {
  const above = machineWithBucket(nextVersion, bucket => bucket >= 50);
  for (const body of [rolloutNotes(0), rolloutNotes('abc')])
    assert.equal(await updateOffered(body, { manual: true }), true, body);
  assert.equal(await updateOffered(rolloutNotes(50), { manual: true, machineId: above }), true);
});
test('cancelling or disposing during metadata or the VSIX download never installs', async t => {
  for (const phase of ['metadata', 'vsix']) {
    for (const action of ['disableChecks', 'disableAutoUpdate', 'dispose'])
      await t.test(`${phase}: ${action}`, { timeout: 2000 }, async () => {
        const releases = githubReleases(nextVersion);
        const bytes = Buffer.from('test-vsix');
        releases[0].assets[0].digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
        const asset = `${githubRepo}/releases/download/v${nextVersion}/${assetName(nextVersion)}`;
        const server = updateServer(releases, {
          version: nextVersion,
          bytes,
          hang: url => (phase === 'metadata') === (url === githubApi),
        });
        const h = harness({}, server);
        await h.ready;
        await h.panel();
        const check = h.commands.get('agentdesklink.checkForUpdates')();
        const wanted = phase === 'metadata' ? githubApi : asset;
        for (let i = 0; i < 100 && !server.requests.includes(wanted); i++)
          await new Promise(resolve => setTimeout(resolve, 5));
        assert.ok(server.requests.includes(wanted), `the ${phase} request started`);
        // The host listener bails out unless the section itself matches, so mimic a real VS Code event.
        if (action !== 'dispose') {
          const key = action === 'disableChecks' ? 'checkForUpdates' : 'autoUpdate';
          h.config[key] = false;
          h.changes.fire({ affectsConfiguration: name => name === 'agentdesklink' || name === `agentdesklink.${key}` });
        } else await h.deactivate();
        await check;
        assert.equal(installs(h), 0, phase);
        assert.equal(updateStatus(h).includes('更新しました'), false, phase);
      });
  }
});

test('provider versions stay stable across reads and change only when MCP settings refresh', async () => {
  const h = harness({ enabled: true });
  await h.ready;
  const p = h.providers.get('agentdesklink.mcp');
  const first = (await p.provideMcpServerDefinitions())[0];
  assert.equal((await p.provideMcpServerDefinitions())[0].version, first.version);
  h.config.nodePath = '/opt/another-node';
  h.changes.fire({ affectsConfiguration: name => name === 'agentdesklink' || name === 'agentdesklink.nodePath' });
  assert.equal((await p.provideMcpServerDefinitions())[0].version, first.version, 'removed Node setting is ignored');
  await h.commands.get('agentdesklink.resumeOperations')();
  assert.notEqual((await p.provideMcpServerDefinitions())[0].version, first.version);
});

test('removed policy command and stale update source messages save nothing and raise no error', async () => {
  const h = harness();
  const p = await h.panel();
  assert.equal(h.commands.has('agentdesklink.selectPolicy'), false);
  assert.equal(h.writes.length, 0);
  assert.ok(!p.view.webview.html.includes('manifest-url'));
  assert.ok(!p.view.webview.html.includes('setUpdateManifestUrl'));
  await p.send({ type: 'setUpdateManifestUrl', value: 'http://unsafe.example/update.json' });
  assert.equal(h.writes.length, 0, 'a stale message cannot save an update source');
  assert.equal(h.posts.at(-1).status.globalError, '', 'removed messages are ignored silently');
});

test('default empty nodePath uses the bundled node with browser and GC env', async () => {
  const h = harness({ enabled: true });
  await h.ready;
  const [definition] = await h.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
  const rt = path.join(h.extensionRoot, 'runtime');
  assert.equal(definition.command, path.join(rt, process.platform === 'win32' ? 'node.exe' : 'node'));
  assert.ok(definition.env.ADL_BROWSER_EXECUTABLE);
  assert.equal(definition.env.PLAYWRIGHT_SKIP_BROWSER_GC, '1');
  assert.equal(
    definition.env.ADL_BUNDLED_HELPER_PATH,
    path.join(
      rt,
      process.platform === 'darwin'
        ? 'helper/adl-macos-ax-helper'
        : process.platform === 'win32'
          ? 'helper/adl-windows-uia-helper.exe'
          : 'helper/adl-linux-atspi-helper',
    ),
  );
});

test('missing runtime or node and mismatched targets fail closed even with a custom nodePath; repair retries', async () => {
  const cases = [{ bundle: false }, { dropNode: true }, { manifest: { target: 'linux-ia32' } }, { dropHelper: true }];
  for (const options of cases) {
    const h = harness({ enabled: true, nodePath: '/opt/custom node' }, options);
    await h.ready;
    const p = h.providers.get('agentdesklink.mcp');
    assert.equal((await p.provideMcpServerDefinitions()).length, 0, JSON.stringify(options));
    assert.ok(p.lastError, `error surfaced for ${JSON.stringify(options)}`);
  }
  const h = harness({ enabled: true }, { bundle: false });
  await h.ready;
  const p = h.providers.get('agentdesklink.mcp');
  assert.equal((await p.provideMcpServerDefinitions()).length, 0);
  makeBundle(h.extensionRoot);
  const [definition] = await p.provideMcpServerDefinitions();
  assert.equal(
    definition.command,
    path.join(h.extensionRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
  );
  assert.equal(p.lastError, null);
});

test('disabled, untrusted and empty windows never touch the runtime bundle', async () => {
  for (const options of [{ bundle: false }, { bundle: false, trusted: false }, { bundle: false, empty: true }]) {
    const h = harness({ enabled: options.trusted === false || !!options.empty }, options);
    await h.ready;
    const p = h.providers.get('agentdesklink.mcp');
    assert.equal((await p.provideMcpServerDefinitions()).length, 0);
    assert.ok(
      !p.lastError || !p.lastError.includes('Bundled runtime'),
      `bundle touched for ${JSON.stringify(options)}`,
    );
  }
});

test('concurrent provider calls coalesce and cancellation or races during async setup publish nothing', async () => {
  const h = harness({ enabled: true });
  await h.ready;
  const p = h.providers.get('agentdesklink.mcp');
  const [a, b] = await Promise.all([p.provideMcpServerDefinitions(), p.provideMcpServerDefinitions()]);
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  const token = { isCancellationRequested: false };
  const cancelled = p.provideMcpServerDefinitions(token);
  token.isCancellationRequested = true;
  assert.equal((await cancelled).length, 0);
  const disabled = p.provideMcpServerDefinitions();
  h.config.enabled = false;
  assert.equal((await disabled).length, 0);
  const h2 = harness({ enabled: true });
  await h2.ready;
  const p2 = h2.providers.get('agentdesklink.mcp');
  const stopping = p2.provideMcpServerDefinitions();
  await h2.commands.get('agentdesklink.emergencyStop')();
  assert.equal((await stopping).length, 0);
  const h3 = harness({ enabled: true });
  await h3.ready;
  const p3 = h3.providers.get('agentdesklink.mcp');
  const trustChange = p3.provideMcpServerDefinitions();
  h3.vscode.workspace.isTrusted = false;
  assert.equal((await trustChange).length, 0);
  const h4 = harness({ enabled: true });
  await h4.ready;
  const p4 = h4.providers.get('agentdesklink.mcp');
  const folderChange = p4.provideMcpServerDefinitions();
  h4.vscode.workspace.workspaceFolders = [];
  assert.equal((await folderChange).length, 0);
  const h5 = harness({ enabled: true });
  await h5.ready;
  const p5 = h5.providers.get('agentdesklink.mcp');
  const disposed = p5.provideMcpServerDefinitions();
  p5.dispose();
  assert.equal((await disposed).length, 0);
  const h6 = harness({ enabled: true });
  await h6.ready;
  const policyChange = h6.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
  h6.config.configPath = 'other-policy.json';
  assert.equal((await policyChange).length, 1, 'obsolete policy setting no longer affects setup');
  const h7 = harness({ enabled: true });
  await h7.ready;
  const mutatedFolders = h7.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
  h7.vscode.workspace.workspaceFolders.push({
    name: 'New',
    uri: h7.vscode.Uri.file(path.join(h7.temp, 'new')),
    index: 1,
  });
  assert.equal((await mutatedFolders).length, 0);
});

test('browser preparation does not block disabling MCP or overwrite newer panel settings', async () => {
  const h = harness({ enabled: true });
  await h.ready;
  const original = fs.promises.stat;
  let release;
  const blocked = new Promise(resolve => {
    release = resolve;
  });
  fs.promises.stat = async (file, ...args) => {
    if (String(file) === path.join(h.extensionRoot, 'runtime', 'manifest.json')) await blocked;
    return original(file, ...args);
  };
  try {
    const panel = await h.panel();
    await Promise.race([
      panel.send({ type: 'setEnabled', enabled: false }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('settings blocked by setup')), 500);
        timer.unref();
      }),
    ]);
    assert.equal(h.config.enabled, false);
    release();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(h.posts.at(-1).settings.enabled, false);
  } finally {
    release();
    fs.promises.stat = original;
  }
});

test('saved invalid permission settings deny grants, report the key and clear after repair', async () => {
  for (const bad of [
    { desktopAppId: 'test.app', desktopAppPath: '' },
    { browserOrigins: ['https://example.com/path'] },
  ]) {
    const h = harness({ enabled: true, browserOrigins: ['https://example.com'], ...bad });
    await h.ready;
    const panel = await h.panel();
    await panel.send({ type: 'ready' });
    assert.match(h.posts.at(-1).status.mcpError, /agentdesklink\.(desktopAppId|desktopAppPath|browserOrigins)/);
    assert.match(h.posts.at(-1).status.mcpError, /expected|形式/);
    assert.match(h.posts.at(-1).status.mcpError, /All grants|すべての権限/);
    const defs = await h.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
    if (defs.length) {
      const grants = JSON.parse(defs[0].env.ADL_MCP_PERMISSIONS);
      assert.deepEqual(grants.browserOrigins, []);
      assert.equal(grants.allowAllOperations, false);
    }
    h.config.desktopAppId = '';
    h.config.desktopAppPath = '';
    h.config.browserOrigins = ['https://example.com'];
    h.changes.fire({ affectsConfiguration: name => name.startsWith('agentdesklink') });
    await panel.send({ type: 'ready' });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(!h.posts.at(-1).status.mcpError, JSON.stringify(h.posts.at(-1).status));
  }
});

test('production panel reports requested physical input separately from effective denial', async () => {
  const h = harness({
    enabled: true,
    desktopAppId: 'test.app',
    desktopAppPath: '/app',
    allowPhysicalInput: true,
    allowUnredactedImages: false,
  });
  await h.ready;
  const panel = await h.panel();
  await h.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
  await panel.send({ type: 'ready' });
  const permissions = h.posts.at(-1).permissions;
  assert.equal(permissions.requested.allowPhysicalInput, true);
  assert.equal(permissions.effective.allowPhysicalInput, false);
  assert.ok(permissions.effective.reasons.length > 0);
});

test('manual update retry waits for a cancelled check and then uses the new settings', async () => {
  let requests = 0;
  const api = {
    fetch: async (url, init) => {
      assert.equal(String(url), githubApi);
      requests++;
      if (requests === 1)
        return new Promise((_, reject) =>
          init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
        );
      return new Response(JSON.stringify(githubReleases(nextVersion)), { status: 200 });
    },
  };
  const h = harness({ autoUpdate: true }, api);
  await h.ready;
  await h.panel();
  const first = h.commands.get('agentdesklink.checkForUpdates')();
  assert.equal(requests, 1);
  h.config.autoUpdate = false;
  h.changes.fire({ affectsConfiguration: name => name === 'agentdesklink' || name === 'agentdesklink.autoUpdate' });
  const second = h.commands.get('agentdesklink.checkForUpdates')();
  await Promise.all([first, second]);
  assert.equal(requests, 2, 'the new explicit check must not be swallowed by the cancelled promise');
  assert.equal(installs(h), 0);
  assert.match(updateStatus(h), /利用可能/);
});

for (const mode of ['concurrent', 'disabled', 'disposed'])
  test(`cancelled update retry handles ${mode} state without overlapping checks`, async () => {
    let requests = 0;
    const h = harness(
      { autoUpdate: true },
      {
        fetch: async (url, init) => {
          assert.equal(String(url), githubApi);
          requests++;
          if (requests === 1)
            return new Promise((_, reject) =>
              init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
            );
          return new Response(JSON.stringify(githubReleases(nextVersion)), { status: 200 });
        },
      },
    );
    await h.ready;
    const first = h.commands.get('agentdesklink.checkForUpdates')();
    assert.equal(requests, 1);
    h.config.autoUpdate = false;
    h.changes.fire({ affectsConfiguration: name => name === 'agentdesklink' || name === 'agentdesklink.autoUpdate' });
    const retries = Array.from({ length: 3 }, () => h.commands.get('agentdesklink.checkForUpdates')());
    if (mode === 'disabled') {
      h.config.checkForUpdates = false;
      h.changes.fire({
        affectsConfiguration: name => name === 'agentdesklink' || name === 'agentdesklink.checkForUpdates',
      });
    }
    if (mode === 'disposed') await h.deactivate();
    await Promise.all([first, ...retries]);
    assert.equal(requests, mode === 'concurrent' ? 2 : 1);
    assert.equal(installs(h), 0);
  });
test('the browserHeadless setting selects the browser cache published to the MCP server', async () => {
  const h = harness({ enabled: true, browserHeadless: false, sessionIdleMinutes: 7 });
  await h.ready;
  const [headful] = await h.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
  assert.ok(headful, 'a headful window still publishes the server');
  assert.equal(fs.realpathSync(headful.env.ADL_BROWSER_EXECUTABLE), fs.realpathSync(h.browserSentinels.headful));
  assert.notEqual(fs.realpathSync(headful.env.ADL_BROWSER_EXECUTABLE), fs.realpathSync(h.browserSentinels.headless));
  assert.match(headful.env.PLAYWRIGHT_BROWSERS_PATH, /-headful$/);
  const headfulRuntime = JSON.parse(headful.env.ADL_MCP_RUNTIME_SETTINGS);
  assert.equal(headfulRuntime.browserHeadless, false);
  assert.equal(headfulRuntime.sessionTtlMs, 420000, 'the same runtime read carries the other runtime setting');
  const d = harness({ enabled: true, sessionIdleMinutes: 7 });
  await d.ready;
  const [headless] = await d.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
  assert.equal(fs.realpathSync(headless.env.ADL_BROWSER_EXECUTABLE), fs.realpathSync(d.browserSentinels.headless));
  assert.equal(JSON.parse(headless.env.ADL_MCP_RUNTIME_SETTINGS).browserHeadless, true);
});

// ---- Approval dialog (requirement 5) ----
const APPROVE = 'Approve once / 今回のみ許可';
async function askApproval(h, details, extra = {}) {
  const [definition] = await h.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
  const headers = { authorization: `Bearer ${definition.env.ADL_APPROVAL_TOKEN}`, 'content-type': 'application/json' };
  const request_id = crypto.randomUUID();
  const post = await fetch(`${definition.env.ADL_APPROVAL_URL}/v1/requests`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      v: 1,
      request_id,
      server_id: crypto.randomUUID(),
      control_epoch: definition.env.ADL_APPROVAL_EPOCH,
      binding: 'b'.repeat(64),
      expires_at: Date.now() + 60_000,
      summary: {
        action: 'click',
        surface: 'browser',
        target: 'Submit order',
        origin: 'https://example.com',
        risk: 'consequential',
        ...(details ? { details } : {}),
        ...extra,
      },
    }),
  });
  assert.equal(post.status, 201);
  let reply;
  for (let i = 0; i < 40; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    reply = await (await fetch(`${definition.env.ADL_APPROVAL_URL}/v1/requests/${request_id}`, { headers })).json();
    if (reply.status !== 'pending') break;
  }
  return reply.status;
}
const askHarness = confirmWarning =>
  harness({ enabled: true, operationMode: 'ask', browserOrigins: ['https://example.com'] }, { confirmWarning });
test('approval details are shown once-escaped and untrusted characters cannot fake dialog structure', async () => {
  const h = askHarness(APPROVE);
  await h.ready;
  const details = [
    'Form POST https://example.com/order',
    '"name": "Taro Test"',
    '"agree": "on"',
    '"note": "a\u2028FAKE\u202e\u2066\u0085\u009b\u200f\u061c end"',
    'line\nbreak\rx\ty\u0001\u007f',
  ];
  assert.equal(await askApproval(h, details, { name: 'N\u2029ame\u202d', role: 'but\u0085ton' }), 'approved');
  const [message, options] = h.warnings.at(-1);
  assert.ok(
    message.includes('• "name": "Taro Test"'),
    'a formatted line is shown as sent, without a second layer of quoting',
  );
  assert.ok(message.includes('• Form POST https://example.com/order'));
  assert.ok(!message.includes('\\"name\\"') && !message.includes('"\\"'), 'no double escaping');
  assert.equal(
    message.split('\n').filter(line => line.startsWith('• ')).length,
    5,
    'a newline inside a line cannot start a new bullet',
  );
  assert.doesNotMatch(
    message,
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/,
    'no raw control, line-separator or bidi character reaches the dialog',
  );
  for (const visible of [
    '\\u2028',
    '\\u202e',
    '\\u2066',
    '\\u0085',
    '\\u009b',
    '\\u200f',
    '\\u061c',
    '\\u2029',
    '\\u202d',
    '\\u0001',
    '\\u007f',
    'line\\nbreak\\rx\\ty',
  ])
    assert.ok(message.includes(visible), `${visible} is shown as a visible escape`);
  assert.match(options.detail, /^Workspace: /);
});
test('the approval dialog says Cancel, Esc and closing deny, and only the Approve item approves', async () => {
  const cancelled = askHarness(undefined);
  await cancelled.ready;
  assert.equal(await askApproval(cancelled), 'denied', 'Cancel / Esc resolve to undefined');
  const [, options, ...items] = cancelled.warnings.at(-1);
  assert.equal(options.modal, true);
  for (const word of [/Cancel/, /Esc/, /closing this dialog/, /キャンセル/, /Esc/, /拒否/, /1回の操作/])
    assert.match(options.detail, word);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, APPROVE);
  assert.ok(!items[0].isCloseAffordance, 'Approve is never the close action');
  assert.equal(items[1].isCloseAffordance, true, 'Deny is the close action, so VS Code adds no second Cancel button');
  assert.match(items[1].title, /Deny/);
  assert.match(items[1].title, /Cancel\/Esc/);
  assert.match(items[1].title, /キャンセル・Esc/);
  const asDeny = askHarness(args => args.at(-1));
  await asDeny.ready;
  assert.equal(await askApproval(asDeny), 'denied', 'the Deny item denies');
  const asString = askHarness('Deny / 拒否');
  await asString.ready;
  assert.equal(await askApproval(asString), 'denied');
  const asItem = askHarness(args => args[2]);
  await asItem.ready;
  assert.equal(await askApproval(asItem), 'approved', 'VS Code returns the original Approve item');
  const wrong = askHarness({ title: 'Approve once / 今回のみ許可 (copy)' });
  await wrong.ready;
  assert.equal(await askApproval(wrong), 'denied', 'only the exact Approve title approves');
});

// ---- Desktop (native) approvals: the broker accepts a summary only for the configured application and renders it as app data ----
const DESKTOP_SUMMARY = {
  action: 'click',
  surface: 'desktop',
  target: 'Notes window',
  application: 'fixture-app',
  role: 'button',
  name: 'Delete all',
  risk: 'consequential',
};
async function postSummary(h, summary) {
  const [definition] = await h.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
  const headers = { authorization: `Bearer ${definition.env.ADL_APPROVAL_TOKEN}`, 'content-type': 'application/json' };
  const request_id = crypto.randomUUID();
  const post = await fetch(`${definition.env.ADL_APPROVAL_URL}/v1/requests`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      v: 1,
      request_id,
      server_id: crypto.randomUUID(),
      control_epoch: definition.env.ADL_APPROVAL_EPOCH,
      binding: 'c'.repeat(64),
      expires_at: Date.now() + 60_000,
      summary,
    }),
  });
  if (post.status !== 201) return { status: post.status };
  let reply;
  for (let i = 0; i < 40; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    reply = await (await fetch(`${definition.env.ADL_APPROVAL_URL}/v1/requests/${request_id}`, { headers })).json();
    if (reply.status !== 'pending') break;
  }
  return { status: post.status, decision: reply.status };
}
const desktopAskHarness = (confirmWarning, extra = {}) =>
  harness(
    {
      enabled: true,
      operationMode: 'ask',
      browserOrigins: ['https://example.com'],
      desktopAppId: 'fixture-app',
      desktopAppPath:
        process.platform === 'win32' ? 'C:\\Apps\\fixture\\fixture-app.exe' : '/Applications/fixture-app.app',
      ...extra,
    },
    { confirmWarning },
  );
test('a desktop approval summary for the configured application is shown as a native action with app data and can be approved once', async () => {
  const h = desktopAskHarness(APPROVE);
  await h.ready;
  const [definition] = await h.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
  assert.match(
    definition.env.ADL_APPROVAL_URL,
    /^http:\/\/127\.0\.0\.1:\d+$/,
    'a semantic-only desktop target keeps the broker',
  );
  const result = await postSummary(h, { ...DESKTOP_SUMMARY, value: { kind: 'public', length: 4, preview: 'Taro' } });
  assert.deepEqual(result, { status: 201, decision: 'approved' });
  const [message, options] = h.warnings.at(-1);
  assert.match(message, /asks to approve this native desktop action once/);
  assert.match(message, /デスクトップアプリの操作を今回のみ許可しますか/);
  assert.ok(message.includes('Desktop application (configured grant / 許可したデスクトップアプリ): fixture-app'));
  assert.ok(message.includes('Window (untrusted app data / 信頼できないアプリ由来データ): Notes window'));
  assert.ok(
    message.includes('Role (untrusted app data): button') && message.includes('Name (untrusted app data): Delete all'),
  );
  assert.ok(message.includes('Public value (untrusted app data): "Taro" (4 characters)'));
  assert.match(message, /nothing is rolled back/);
  assert.doesNotMatch(message, /Origin:/);
  assert.match(options.detail, /consequential native actions in the granted desktop app/);
  assert.match(options.detail, /機密コントロールは承認できません/);
  assert.doesNotMatch(options.detail, /Native actions are not covered|ネイティブ操作は対象外/);
  const denied = desktopAskHarness(undefined);
  await denied.ready;
  assert.deepEqual(
    await postSummary(denied, DESKTOP_SUMMARY),
    { status: 201, decision: 'denied' },
    'Cancel / Esc deny a native action too',
  );
});
test('desktop approval summaries are validated as strictly as browser ones', async () => {
  const h = desktopAskHarness(APPROVE);
  await h.ready;
  const rejected = [
    { ...DESKTOP_SUMMARY, application: 'other-app' }, // not the configured application
    { ...DESKTOP_SUMMARY, origin: 'https://example.com' }, // a desktop summary names no origin
    { ...DESKTOP_SUMMARY, risk: 'credential' }, // sensitive native controls are never approved
    (({ role, ...rest }) => rest)(DESKTOP_SUMMARY), // the element identity must be complete
    (({ name, ...rest }) => rest)(DESKTOP_SUMMARY),
    (({ application, ...rest }) => rest)(DESKTOP_SUMMARY),
    { ...DESKTOP_SUMMARY, application: 'fixture-app\u0000' },
    { ...DESKTOP_SUMMARY, application: 'x'.repeat(129) },
    { ...DESKTOP_SUMMARY, surface: 'native' },
    {
      action: 'click',
      surface: 'browser',
      target: 'Submit order',
      origin: 'https://example.com',
      application: 'fixture-app',
      risk: 'consequential',
    }, // a browser summary names no application
  ];
  for (const summary of rejected) assert.equal((await postSummary(h, summary)).status, 400, JSON.stringify(summary));
  assert.equal(h.warnings.length, 0, 'no dialog was shown for a rejected summary');
  const none = harness(
    { enabled: true, operationMode: 'ask', browserOrigins: ['https://example.com'] },
    { confirmWarning: APPROVE },
  );
  await none.ready;
  assert.equal(
    (await postSummary(none, DESKTOP_SUMMARY)).status,
    400,
    'no configured desktop application means no desktop approvals',
  );
  assert.deepEqual(await postSummary(h, DESKTOP_SUMMARY), { status: 201, decision: 'approved' });
});
test('Ask broker is withheld when a semantic-only native target is the VS Code host', async () => {
  const h = harness({
    enabled: true,
    operationMode: 'ask',
    browserOrigins: ['https://example.com'],
    desktopAppId: 'host-app',
    desktopAppPath: process.execPath,
  });
  await h.ready;
  const [definition] = await h.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
  assert.equal(
    definition.env.ADL_APPROVAL_URL,
    undefined,
    'the native tiers can invoke the modal through the accessibility API without physical input',
  );
  const panel = await h.panel();
  assert.ok(panel);
  assert.match(h.posts.at(-1).status.mcp, /native target can control the VS Code host/);
});

// ---- Allow-all confirmation (requirement 4) ----
test('allow all lists what becomes possible without approval and Cancel keeps the previous tier', async () => {
  const h = harness(
      { allowAllOperations: false, operationMode: 'standard' },
      { confirmWarning: 'すべて許可 / Allow all' },
    ),
    panel = await h.panel();
  await panel.send({ type: 'setOperationMode', mode: 'all' });
  const [message, options] = h.warnings.at(-1),
    text = `${message}\n${options.detail}`;
  assert.equal(options.modal, true);
  for (const needle of [
    /フォームの送信/,
    /Submit forms/,
    /注文・購入・支払い・送金/,
    /orders, purchases, payments and transfers/,
    /削除・送信・解約・アップロード/,
    /delete, send, cancel an account, upload/,
    /パスワードや認証情報/,
    /passwords and credentials/,
    /POST \/ PUT \/ DELETE/,
    /ファイルのダウンロード/,
    /file downloads/,
    /座標指定のクリック/,
    /Click at coordinates/,
    /デスクトップアプリのすべてのコントロール/,
    /every control of the configured desktop app/,
    /許可した origin とアプリ/,
    /granted origins and app/,
    /保護領域/,
    /protected regions/,
    /緊急停止/,
    /emergency stop/,
    /未対応/,
    /not supported/,
    /キャンセルすると/,
    /Cancel keeps your current permission tier/,
  ])
    assert.match(text, needle);
  assert.ok(h.writes.some(x => x.key === 'allowAllOperations' && x.value === true && x.target === 2));
  const cancel = harness({ allowAllOperations: false, operationMode: 'standard' }),
    cancelPanel = await cancel.panel();
  await cancelPanel.send({ type: 'setOperationMode', mode: 'all' });
  assert.equal(cancel.warnings.length, 1, 'the dialog was shown');
  assert.ok(
    !cancel.writes.some(x => x.key === 'allowAllOperations' || x.key === 'operationMode'),
    'cancelling writes nothing',
  );
  assert.equal(cancel.posts.at(-1).settings.operationMode, 'standard');
  assert.equal(cancel.posts.at(-1).permissions.effective.operationMode, 'standard');
  assert.equal(cancel.posts.at(-1).busy.operationMode, false);
  assert.equal(cancel.config.allowAllOperations, false);
});

// ---- Proxy hostname mode (requirement 6) ----
const parserKnowsProxyMode = async () => {
  try {
    (await import('../../dist/src/bundled-policy.js')).normalizeRuntimeSettings({
      browserProxyConnectByHostname: true,
    });
    return true;
  } catch {
    return false;
  }
};
test('browserProxyConnectByHostname is a trusted per-workspace boolean that defaults to off', async () => {
  const props =
    require('../../package.json').contributes.configuration.properties['agentdesklink.browserProxyConnectByHostname'];
  assert.equal(props.type, 'boolean');
  assert.equal(props.default, false);
  assert.equal(props.scope, 'window');
  assert.match(props.description, /ホスト名/);
  assert.match(props.description, /hostname/);
  assert.match(props.description, /HTTPS only/);
  const h = harness({ enabled: true, browserProxyServer: 'https://proxy.example:8443' });
  await h.ready;
  const [definition] = await h.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
  assert.notEqual(
    JSON.parse(definition.env.ADL_MCP_RUNTIME_SETTINGS).browserProxyConnectByHostname,
    true,
    'off by default',
  );
  for (const opts of [{ trusted: false }, { empty: true }]) {
    const u = harness({}, opts),
      panel = await u.panel();
    await panel.send({ type: 'setBrowserProxyConnectByHostname', enabled: true });
    assert.equal(u.writes.length, 0);
    assert.match(u.posts.at(-1).status.runtimeError, /信頼|trusted/);
  }
  const bad = harness({}),
    badPanel = await bad.panel();
  for (const enabled of ['true', 1, null, undefined])
    await badPanel.send({ type: 'setBrowserProxyConnectByHostname', enabled });
  assert.equal(bad.writes.length, 0);
});
test('the proxy hostname mode is saved in the workspace, passed to the server with the runtime settings and revokes the policy', async t => {
  if (!(await parserKnowsProxyMode()))
    return t.skip('needs the runtime-settings parser change that accepts browserProxyConnectByHostname');
  const h = harness({ enabled: true, browserProxyServer: 'https://proxy.example:8443' }),
    panel = await h.panel(),
    provider = h.providers.get('agentdesklink.mcp');
  const [before] = await provider.provideMcpServerDefinitions();
  let refreshed = 0;
  provider.onDidChangeMcpServerDefinitions(() => refreshed++);
  await panel.send({ type: 'setBrowserProxyConnectByHostname', enabled: true });
  assert.ok(h.writes.some(x => x.key === 'browserProxyConnectByHostname' && x.value === true && x.target === 2));
  assert.equal(h.posts.at(-1).settings.browserProxyConnectByHostname, true);
  assert.ok(refreshed > 0, 'changing it refreshes the server definition');
  const [after] = await provider.provideMcpServerDefinitions();
  assert.equal(JSON.parse(after.env.ADL_MCP_RUNTIME_SETTINGS).browserProxyConnectByHostname, true);
  assert.equal(
    JSON.parse(after.env.ADL_MCP_RUNTIME_SETTINGS).browserProxyServer,
    'https://proxy.example:8443',
    'sent next to the proxy origin',
  );
  assert.notEqual(before.version, after.version);
  await panel.send({ type: 'setBrowserProxyConnectByHostname', enabled: false });
  assert.notEqual(
    JSON.parse((await provider.provideMcpServerDefinitions())[0].env.ADL_MCP_RUNTIME_SETTINGS)
      .browserProxyConnectByHostname,
    true,
  );
});

// ---- Desktop app selection (requirement 2) ----
const exeName = base => (process.platform === 'win32' ? `${base}.exe` : base);
function fakeApp(h, base = 'tool') {
  const file = path.join(h.temp, exeName(base));
  fs.writeFileSync(file, 'x');
  fs.chmodSync(file, 0o755);
  return file;
}
const desktopWrites = h => h.writes.filter(x => x.key.startsWith('desktopApp')).map(x => [x.key, x.value, x.target]);
test('the panel HTML carries the new sections with both languages for every string', async () => {
  const html = (await harness({}).panel()).view.webview.html;
  for (const id of [
    'browser-setup',
    'browser-retry',
    'browser-hosts',
    'browser-installed',
    'browser-compat',
    'browser-use-auto',
    'desktop-os-hint',
    'desktop-app-id',
    'desktop-app-path',
    'desktop-browse',
    'desktop-save',
    'desktop-clear',
    'allow-physical-input',
    'allow-unredacted-images',
    'browser-proxy-connect-hostname',
    'private-network-suggestion',
  ])
    assert.match(html, new RegExp(`id="${id}"`), id);
  const part = (from, to) => html.slice(html.indexOf(from), html.indexOf(to, html.indexOf(from)));
  for (const block of [
    part('id="browser-setup"', 'aria-labelledby="desktop-title"'),
    part('aria-labelledby="desktop-title"', 'aria-labelledby="clients-title"'),
    part('id="private-network-suggestion"', 'id="resource-origins-list"'),
    part('id="browser-proxy-connect-hostname"', 'id="session-idle-effective"'),
  ]) {
    const text = block.replace(/<span data-i18n-ja>[^<]*<\/span>/g, '').replace(/<[^>]*>/g, '>');
    assert.doesNotMatch(text, /[぀-ヿ一-鿿]/, 'every Japanese string sits in a data-i18n-ja span');
    assert.equal(
      (block.match(/data-i18n-ja/g) ?? []).length,
      (block.match(/data-i18n-en/g) ?? []).length,
      'each Japanese span has an English twin',
    );
  }
  assert.match(html, /<span data-i18n-ja>参照…<\/span><span data-i18n-en>Browse…<\/span>/);
});
test('the desktop app pair is validated, written as trusted workspace settings (path first, ID first when clearing) and echoed to the webview', async () => {
  const h = harness({}),
    panel = await h.panel(),
    file = fakeApp(h);
  await panel.send({ type: 'setDesktopApp', appId: ' my-tool ', appPath: ` ${file} ` });
  assert.deepEqual(
    desktopWrites(h),
    [
      ['desktopAppPath', file, 2],
      ['desktopAppId', 'my-tool', 2],
    ],
    'the ID never exists without a path',
  );
  assert.equal(h.posts.at(-1).settings.desktopAppId, 'my-tool');
  assert.equal(h.posts.at(-1).settings.desktopAppPath, file);
  assert.equal(h.posts.at(-1).status.desktopError, '');
  assert.equal(h.posts.at(-1).platform, process.platform);
  assert.equal(h.posts.at(-1).busy.desktop, false);
  assert.equal(h.posts.at(-1).permissions.requested.desktopAppId, 'my-tool');
  h.writes.length = 0;
  await panel.send({ type: 'setDesktopApp', appId: '', appPath: '' });
  assert.deepEqual(
    desktopWrites(h),
    [
      ['desktopAppId', '', 2],
      ['desktopAppPath', '', 2],
    ],
    'clearing removes the ID first',
  );
  const missing = path.join(h.temp, exeName('missing')),
    long = 'a'.repeat(129),
    count = () => h.writes.length;
  const cases = [
    [{ appId: 'x', appPath: '' }, /両方|both/],
    [{ appId: '', appPath: file }, /両方|both/],
    [{ appId: '*', appPath: file }, /Wildcards/],
    [{ appId: 'x', appPath: 'relative/tool' }, /absolute/],
    [{ appId: 'x', appPath: missing }, /not found|not executable/],
    [{ appId: long, appPath: file }, /128/],
    [{ appId: 'a\nb', appPath: file }, /one line/],
  ];
  for (const [message, expected] of cases) {
    const before = count();
    await panel.send({ type: 'setDesktopApp', ...message });
    assert.equal(count(), before, JSON.stringify(message));
    assert.match(h.posts.at(-1).status.desktopError, expected, JSON.stringify(message));
  }
  {
    const before = count();
    await panel.send({ type: 'setDesktopApp', appId: 7, appPath: file });
    await panel.send({ type: 'setDesktopApp', appId: 'x' });
    assert.equal(count(), before, 'malformed messages are ignored');
  }
  for (const opts of [{ trusted: false }, { empty: true }]) {
    const u = harness({}, opts),
      p = await u.panel(),
      f = fakeApp(u);
    await p.send({ type: 'setDesktopApp', appId: 'x', appPath: f });
    await p.send({ type: 'setAllowPhysicalInput', enabled: true });
    await p.send({ type: 'setAllowUnredactedImages', enabled: true });
    assert.equal(u.writes.length, 0, 'untrusted or folderless windows save nothing');
    assert.match(u.posts.at(-1).status.desktopError, /信頼|trusted/);
    await p.send({ type: 'browseDesktopApp' });
    assert.equal(u.dialogs.length, 0, 'and open no file dialog');
  }
});
test('a failing save of the desktop app is reported next to the desktop controls', async () => {
  const h = harness({}, { failSave: true }),
    panel = await h.panel(),
    file = fakeApp(h);
  await panel.send({ type: 'setDesktopApp', appId: 'x', appPath: file });
  assert.match(h.posts.at(-1).status.desktopError, /read-only settings/);
  assert.equal(h.posts.at(-1).busy.desktop, false);
  await panel.send({ type: 'setAllowPhysicalInput', enabled: true });
  assert.match(h.posts.at(-1).status.desktopError, /allowPhysicalInput/);
  assert.equal(h.posts.at(-1).status.originsError, '');
});
test('physical input and unredacted images are separate trusted workspace toggles with strict message validation', async () => {
  const h = harness({}),
    panel = await h.panel();
  await panel.send({ type: 'setAllowPhysicalInput', enabled: true });
  await panel.send({ type: 'setAllowUnredactedImages', enabled: true });
  assert.ok(h.writes.some(x => x.key === 'allowPhysicalInput' && x.value === true && x.target === 2));
  assert.ok(h.writes.some(x => x.key === 'allowUnredactedImages' && x.value === true && x.target === 2));
  assert.equal(h.posts.at(-1).settings.allowPhysicalInput, true);
  assert.equal(h.posts.at(-1).settings.allowUnredactedImages, true);
  assert.equal(h.posts.at(-1).permissions.requested.allowPhysicalInput, true);
  const count = h.writes.length;
  for (const enabled of ['true', 1, null, undefined]) {
    await panel.send({ type: 'setAllowPhysicalInput', enabled });
    await panel.send({ type: 'setAllowUnredactedImages', enabled });
  }
  assert.equal(h.writes.length, count);
  await panel.send({ type: 'setAllowPhysicalInput', enabled: false });
  assert.equal(h.config.allowPhysicalInput, false);
  assert.equal(h.config.allowUnredactedImages, true, 'the toggles are independent');
});
test('Browse fills the webview from the picked file and saves nothing', async () => {
  const h = harness({}),
    panel = await h.panel(),
    file = fakeApp(h, 'picked');
  h.vscode.window.showOpenDialog = async (...args) => {
    h.dialogs.push(args);
    return [h.vscode.Uri.file(file)];
  };
  await panel.send({ type: 'browseDesktopApp' });
  const [dialog] = h.dialogs.at(-1);
  assert.equal(dialog.canSelectMany, false);
  assert.equal(dialog.canSelectFiles, true);
  assert.equal(dialog.canSelectFolders, process.platform === 'darwin');
  if (process.platform === 'win32') assert.deepEqual(Array.from(Object.values(dialog.filters)[0]), ['exe']);
  else assert.equal(dialog.filters, undefined);
  const picked = h.posts.find(x => x.type === 'desktopAppPicked');
  assert.equal(picked.appPath, process.platform === 'darwin' ? fs.realpathSync(file) : file);
  assert.equal(picked.appId, process.platform === 'darwin' ? '' : 'picked');
  assert.equal(picked.replaceId, false);
  assert.ok(Array.isArray(picked.notes) && picked.notes.length > 0);
  assert.equal(h.writes.length, 0, 'the user still has to press Save');
  h.posts.length = 0;
  h.vscode.window.showOpenDialog = async () => undefined;
  await panel.send({ type: 'browseDesktopApp' });
  assert.ok(!h.posts.some(x => x.type === 'desktopAppPicked'), 'cancelling the dialog changes nothing');
  const bad = path.join(h.temp, process.platform === 'win32' ? 'tool.lnk' : 'notes.txt');
  fs.writeFileSync(bad, 'x');
  fs.chmodSync(bad, 0o644);
  h.vscode.window.showOpenDialog = async () => [h.vscode.Uri.file(bad)];
  await panel.send({ type: 'browseDesktopApp' });
  assert.ok(!h.posts.some(x => x.type === 'desktopAppPicked'));
  assert.ok(h.posts.at(-1).status.desktopError.length > 0, 'an unsuitable pick is explained');
});

// ---- Browser setup failure (requirement 1) ----
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const plainJson = value => JSON.parse(JSON.stringify(value));
const browserRecords = h =>
  fs
    .readdirSync(path.join(h.temp, 'storage', 'browsers'))
    .map(name => path.join(h.temp, 'storage', 'browsers', name, 'ready.json'));
function breakBrowserCache(h) {
  const saved = browserRecords(h).map(file => [file, fs.readFileSync(file)]);
  for (const [file] of saved) fs.rmSync(file);
  return () => {
    for (const [file, data] of saved) fs.writeFileSync(file, data);
  };
}
function withEnv(values) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
test('a failed browser download lists the hosts, can be retried and explains the compatibility caveat', async () => {
  const restoreEnv = withEnv({ PLAYWRIGHT_DOWNLOAD_HOST: undefined, PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST: undefined });
  try {
    const h = harness({ enabled: true });
    await h.ready;
    fs.mkdirSync(path.join(h.extensionRoot, 'node_modules/playwright-core'), { recursive: true });
    fs.writeFileSync(
      path.join(h.extensionRoot, 'node_modules/playwright-core/browsers.json'),
      JSON.stringify({
        browsers: [
          { name: 'chromium', revision: '1248', browserVersion: '156.0.8078.4' },
          { name: 'firefox', revision: '1', browserVersion: '9' },
        ],
      }),
    );
    const repair = breakBrowserCache(h),
      panel = await h.panel(),
      provider = h.providers.get('agentdesklink.mcp');
    assert.equal((await provider.provideMcpServerDefinitions()).length, 0);
    assert.match(provider.lastError, /Automatic browser setup failed/);
    await panel.send({ type: 'ready' });
    await sleep(30);
    const browser = h.posts.at(-1).browser;
    assert.equal(browser.failed, true);
    assert.deepEqual(plainJson(browser.hosts), ['cdn.playwright.dev', 'playwright.download.prss.microsoft.com']);
    assert.deepEqual(plainJson(browser.expected), { playwright: '1.64.1', chromium: '156.0.8078.4', revision: '1248' });
    assert.ok(Array.isArray(browser.installed));
    // Retry runs a fresh attempt: still failing, then succeeding once the cause is fixed, and the failure disappears.
    await panel.send({ type: 'retryBrowserSetup' });
    assert.equal(h.posts.at(-1).browser.failed, true);
    assert.equal(h.posts.at(-1).busy.browser, false);
    repair();
    await panel.send({ type: 'retryBrowserSetup' });
    await sleep(30);
    assert.equal(h.posts.at(-1).browser.failed, false);
    assert.ok(!h.posts.at(-1).status.mcpError);
    assert.equal((await provider.provideMcpServerDefinitions()).length, 1);
  } finally {
    restoreEnv();
  }
});
test('download hosts follow the Playwright host overrides', async () => {
  const { browserDownloadHosts, BROWSER_DOWNLOAD_HOSTS } = await import('../../dist/src/extension/browser-setup.js');
  assert.deepEqual(browserDownloadHosts({}), [...BROWSER_DOWNLOAD_HOSTS]);
  assert.deepEqual([...BROWSER_DOWNLOAD_HOSTS], ['cdn.playwright.dev', 'playwright.download.prss.microsoft.com']);
  assert.deepEqual(browserDownloadHosts({ PLAYWRIGHT_DOWNLOAD_HOST: 'https://mirror.corp.example:8443' }), [
    'mirror.corp.example:8443',
  ]);
  assert.deepEqual(browserDownloadHosts({ PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST: 'https://chromium.corp.example' }), [
    'chromium.corp.example',
    'cdn.playwright.dev',
    'playwright.download.prss.microsoft.com',
  ]);
  assert.deepEqual(
    browserDownloadHosts({ PLAYWRIGHT_DOWNLOAD_HOST: 'not a url', PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST: 'file:///x' }),
    [...BROWSER_DOWNLOAD_HOSTS],
  );
});
test('an installed Edge is offered after a failure, used only once chosen, never from a stored path, and the choice can be reverted', async t => {
  if (process.platform === 'linux')
    return t.skip(
      'Linux candidates are fixed system paths outside the test sandbox; detection is covered in browser-acceptance.test.cjs',
    );
  const h = harness({ enabled: true });
  await h.ready;
  const darwin = process.platform === 'darwin',
    home = path.join(h.temp, 'home');
  const edge = darwin
    ? path.join(home, 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge')
    : path.join(h.temp, 'local', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  fs.mkdirSync(path.dirname(edge), { recursive: true });
  fs.writeFileSync(edge, 'edge');
  fs.chmodSync(edge, 0o755);
  if (darwin)
    fs.writeFileSync(
      path.join(path.dirname(edge), '..', 'Info.plist'),
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>130.0.1</string></dict></plist>',
    );
  else fs.mkdirSync(path.join(path.dirname(edge), '130.0.2849.80'));
  const restoreEnv = withEnv(darwin ? { HOME: home } : { LOCALAPPDATA: path.join(h.temp, 'local') });
  try {
    const repair = breakBrowserCache(h),
      panel = await h.panel(),
      provider = h.providers.get('agentdesklink.mcp');
    assert.equal((await provider.provideMcpServerDefinitions()).length, 0, 'nothing is chosen silently');
    await panel.send({ type: 'ready' });
    await sleep(30);
    const offered = h.posts.at(-1).browser.installed.find(item => item.id === 'msedge');
    assert.ok(offered, JSON.stringify(h.posts.at(-1).browser));
    assert.equal(offered.usable, true);
    assert.equal(fs.realpathSync(offered.path), fs.realpathSync(edge));
    assert.equal(offered.version, darwin ? '130.0.1' : '130.0.2849.80');
    await panel.send({ type: 'useInstalledBrowser', id: '../../evil' });
    assert.equal(h.state.get('agentdesklink.installedBrowser'), undefined);
    assert.match(h.posts.at(-1).status.globalError, /not found/);
    await panel.send({ type: 'useInstalledBrowser', id: offered.path });
    assert.equal(h.state.get('agentdesklink.installedBrowser'), undefined, 'a path is not an ID');
    await panel.send({ type: 'useInstalledBrowser', id: 'msedge' });
    await sleep(30);
    assert.equal(h.state.get('agentdesklink.installedBrowser'), 'msedge');
    const [definition] = await provider.provideMcpServerDefinitions();
    assert.equal(
      fs.realpathSync(definition.env.ADL_BROWSER_EXECUTABLE),
      fs.realpathSync(edge),
      'the server is launched with the installed browser',
    );
    const shown = h.posts.at(-1).browser;
    assert.equal(shown.failed, false);
    assert.equal(shown.using.id, 'msedge');
    assert.equal(fs.realpathSync(shown.using.path), fs.realpathSync(edge));
    assert.ok(!h.posts.at(-1).status.mcpError);
    await panel.send({ type: 'clearInstalledBrowser' });
    await sleep(30);
    assert.equal(h.state.get('agentdesklink.installedBrowser'), undefined);
    assert.equal(
      (await provider.provideMcpServerDefinitions()).length,
      0,
      'back to the automatic download, which still fails',
    );
    assert.equal(h.posts.at(-1).browser.failed, true);
    h.state.set('agentdesklink.installedBrowser', edge);
    assert.equal((await provider.provideMcpServerDefinitions()).length, 0, 'a stored path is never executed');
    repair();
    h.state.set('agentdesklink.installedBrowser', 'msedge');
    const [cached] = await provider.provideMcpServerDefinitions();
    assert.equal(
      fs.realpathSync(cached.env.ADL_BROWSER_EXECUTABLE),
      fs.realpathSync(edge),
      'an explicit choice outranks the download cache',
    );
  } finally {
    restoreEnv();
  }
});

test('the browser recovery section disappears when MCP is disabled again and never shows for other failures', async () => {
  const h = harness({ enabled: true });
  await h.ready;
  const repair = breakBrowserCache(h),
    panel = await h.panel(),
    provider = h.providers.get('agentdesklink.mcp');
  await provider.provideMcpServerDefinitions();
  await panel.send({ type: 'ready' });
  await sleep(30);
  assert.equal(h.posts.at(-1).browser.failed, true);
  h.config.enabled = false;
  h.changes.fire({ affectsConfiguration: name => name === 'agentdesklink' || name === 'agentdesklink.enabled' });
  await provider.provideMcpServerDefinitions();
  await panel.send({ type: 'ready' });
  await sleep(30);
  assert.equal(h.posts.at(-1).browser.failed, false, 'a disabled workspace shows no browser failure');
  repair();
  const broken = harness({ enabled: true }, { bundle: false });
  await broken.ready;
  const bp = await broken.panel();
  await broken.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
  await bp.send({ type: 'ready' });
  await sleep(30);
  assert.ok(broken.posts.at(-1).status.mcpError, 'the runtime bundle error is still shown');
  assert.equal(broken.posts.at(-1).browser.failed, false, 'but it is not mistaken for a browser download failure');
});
