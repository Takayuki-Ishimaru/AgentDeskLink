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
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
class Emitter {
  listeners = [];
  event = (fn) => { this.listeners.push(fn); return { dispose: () => { this.listeners = this.listeners.filter(x => x !== fn); } }; };
  fire(value) { for (const fn of [...this.listeners]) fn(value); }
  dispose() { this.listeners = []; }
}
function makeBundle(root, options = {}) {
  const rt = path.join(root, 'runtime');
  fs.mkdirSync(path.join(rt, 'helper'), { recursive: true });
  const isWin = process.platform === 'win32';
  const helperRel = process.platform === 'darwin' ? 'helper/adl-macos-ax-helper' : isWin ? 'helper/adl-windows-uia-helper.exe' : null;
  const manifest = { schemaVersion: 2, target: `${process.platform}-${process.arch}`, nodeVersion: 'v24.22.1', playwrightVersion: '1.64.1',
    node: isWin ? 'node.exe' : 'node', browserMode: 'auto', helper: helperRel, ...options.manifest };
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'adl-extension-'));
  const extensionRoot = path.join(temp, 'extension');
  fs.mkdirSync(extensionRoot, { recursive: true });
  if (options.bundle !== false) makeBundle(extensionRoot, options);
  const browserCache = path.join(temp, 'storage', 'browsers', `1.64.1-${process.platform}-${process.arch}`);
  fs.mkdirSync(browserCache, {recursive:true});
  fs.writeFileSync(path.join(browserCache, 'headless-shell'), 'browser');
  fs.chmodSync(path.join(browserCache, 'headless-shell'), 0o755);
  fs.writeFileSync(path.join(browserCache, 'ready.json'), JSON.stringify({schemaVersion:1,version:'1.64.1',target:`${process.platform}-${process.arch}`,executable:'headless-shell'}));
  const uri = value => ({ fsPath: value, path: value, scheme: 'file', toString: () => `file://${value}` });
  const config = { enabled: false, nodePath: '', configPath: '', autoUpdate: true, checkForUpdates: true, updateManifestUrl: '', ...initial };
  const changes = new Emitter(), folders = new Emitter(), trust = new Emitter();
  const commands = new Map(), providers = new Map(), views = new Map(), writes = [], executions = [], notifications = [], posts = [];
  const state = new Map();
  const subscriptions = [];
  const vscode = {
    EventEmitter: Emitter,
    Disposable: class { constructor(fn) { this.dispose = fn; } static from(...xs) { return { dispose() { xs.forEach(x => x.dispose()); } }; } },
    Uri: { file: uri, parse: value => ({ ...uri(value), scheme: value.split(':')[0] }), joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    McpStdioServerDefinition: class { constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); } },
    RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } },
    env: { language: 'ja', openExternal: async () => true, clipboard: { writeText: async () => {} } },
    workspace: {
      isTrusted: options.trusted !== false,
      workspaceFolders: options.empty ? undefined : [{ name: 'Example', uri: uri(temp), index: 0 }],
      workspaceFile: undefined,
      getConfiguration: () => ({ get: (key, fallback) => config[key] ?? fallback, inspect: key => ({ workspaceValue: config[key] }), update: async (key, value, target) => {
        if (options.failSave) throw new Error('read-only settings');
        writes.push({ key, value, target }); config[key] = value;
        changes.fire({ affectsConfiguration: section => section === 'agentdesklink' || section === `agentdesklink.${key}` });
      } }),
      onDidChangeConfiguration: changes.event, onDidChangeWorkspaceFolders: folders.event, onDidGrantWorkspaceTrust: trust.event,
      createFileSystemWatcher: () => ({ onDidChange: new Emitter().event, onDidCreate: new Emitter().event, onDidDelete: new Emitter().event, dispose() {} }),
      openTextDocument: async value => value,
      fs: { stat: async u => fs.promises.stat(u.fsPath), readFile: async u => fs.promises.readFile(u.fsPath), writeFile: async (u, data) => fs.promises.writeFile(u.fsPath, data), createDirectory: async u => fs.promises.mkdir(u.fsPath, { recursive: true }) }
    },
    window: {
      registerWebviewViewProvider: (id, provider) => { views.set(id, provider); return { dispose() {} }; },
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      showErrorMessage: async text => { notifications.push(text); }, showWarningMessage: async text => { notifications.push(text); }, showInformationMessage: async text => { notifications.push(text); },
      showOpenDialog: async () => undefined, showTextDocument: async () => {},
      withProgress: async (_opts, fn) => fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: new Emitter().event })
    },
    ProgressLocation: { Notification: 15 },
    commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; }, executeCommand: async (id, ...args) => {
      executions.push({ id, args }); return commands.get(id)?.(...args);
    } },
    lm: { registerMcpServerDefinitionProvider: (id, provider) => { providers.set(id, provider); return { dispose() {} }; } }
  };
  const context = { subscriptions, extensionUri: uri(extensionRoot), extensionPath: extensionRoot, globalStorageUri: uri(path.join(temp, 'storage')), storageUri: uri(path.join(temp, 'workspace-storage')),
    extension: { id: 'agentdesklink.agentdesklink', packageJSON: require('../../package.json') },
    globalState: { get: (key, fallback) => state.get(key) ?? fallback, update: async (key, value) => { state.set(key, value); } },
    workspaceState: { get: (_key, fallback) => fallback, update: async () => {} } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'dist/extension/extension.cjs'), 'utf8'), {
    module, exports: module.exports, require: name => name === 'vscode' ? vscode : name === 'node:fs' ? fs : require(name),
    __dirname: path.join(root, 'dist/extension'), __filename: path.join(root, 'dist/extension/extension.cjs'),
    process, console, Buffer, URL, AbortController, AbortSignal, TextDecoder, TextEncoder, fetch: (...args) => options.fetch ? options.fetch(...args) : Promise.reject(new Error('unexpected network request')),
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask
  });
  const ready = Promise.resolve(module.exports.activate(context));
  cleanups.push(async () => { subscriptions.slice().reverse().forEach(x => x.dispose?.()); await module.exports.deactivate?.(); fs.rmSync(temp, { recursive: true, force: true }); });
  return { ready, vscode, config, temp, extensionRoot, writes, commands, providers, executions, notifications, posts, changes,
    async panel() {
      await ready;
      const provider = views.get('agentdesklink.settings'); assert.ok(provider, 'settings view provider registered');
      let receive;
      const view = { visible: true, show() {}, onDidDispose: new Emitter().event, onDidChangeVisibility: new Emitter().event,
        webview: { options: {}, cspSource: 'vscode-webview:', asWebviewUri: x => x, html: '', postMessage: async x => { posts.push(x); return true; }, onDidReceiveMessage: fn => { receive = fn; return { dispose() {} }; } } };
      await provider.resolveWebviewView(view, {}, { isCancellationRequested: false });
      return { view, send: async message => { await receive(message); await new Promise(resolve => setImmediate(resolve)); } };
    }
  };
}

test('manifest contributes the sidebar, workspace switch and application update settings', () => {
  const pkg = require('../../package.json');
  assert.equal(pkg.main, './dist/extension/extension.cjs');
  assert.ok(pkg.contributes.viewsContainers.activitybar.some(x => x.id === 'agentdesklink' && fs.existsSync(path.join(root, x.icon))));
  assert.ok(pkg.contributes.views.agentdesklink.some(x => x.id === 'agentdesklink.settings' && x.type === 'webview'));
  assert.ok(pkg.contributes.mcpServerDefinitionProviders.some(x => x.id === 'agentdesklink.mcp' && x.label === 'AgentDeskLink'));
  assert.equal(pkg.galleryBanner.color, '#191827');
  const props = pkg.contributes.configuration.properties;
  assert.equal(props['agentdesklink.enabled'].default, false);
  assert.equal(props['agentdesklink.enabled'].scope, 'window');
  for (const key of ['autoUpdate', 'checkForUpdates', 'updateManifestUrl']) assert.equal(props[`agentdesklink.${key}`].scope, 'application');
  const css = fs.readFileSync(path.join(root, 'media/settings.css'), 'utf8').toLowerCase();
  for (const hex of ['#ff6b1a', '#c6a7e8', '#4057d6', '#191827', '#f2eef5']) assert.ok(css.includes(hex));
  assert.ok(css.includes('--vscode-foreground')); assert.ok(css.includes('--vscode-focusborder'));
  assert.ok(!(pkg.files?.length && fs.existsSync(path.join(root, '.vscodeignore'))), 'VSCE forbids combining files with .vscodeignore');
});
test('MCP is opt-in and absent in empty and untrusted windows', async () => {
  for (const options of [{}, { empty: true }, { trusted: false }]) {
    const h = harness({ enabled: !!options.empty || options.trusted === false }, options); await h.ready;
    const p = h.providers.get('agentdesklink.mcp'); assert.ok(p);
    assert.equal((await p.provideMcpServerDefinitions()).length, 0);
  }
});
test('enabled MCP always uses bundled Node and permits operations without legacy policy inputs', async () => {
  const h=harness({enabled:true,nodePath:'/invalid/old/node',configPath:'missing-policy.json'});await h.ready;
  const p=h.providers.get('agentdesklink.mcp'),[definition]=await p.provideMcpServerDefinitions();
  assert.equal(definition.command,path.join(h.extensionRoot,'runtime',process.platform==='win32'?'node.exe':'node'));
  assert.deepEqual(Array.from(definition.args),[path.join(h.extensionRoot,'dist/src/server.js')]);
  assert.equal(definition.env.ADL_ALLOW_ALL_OPERATIONS,'1');assert.ok(definition.env.ADL_OPERATION_CONTROL);assert.ok(definition.env.ADL_OPERATION_EPOCH);
  let refreshed=0;p.onDidChangeMcpServerDefinitions(()=>refreshed++);
  h.config.enabled=false;h.changes.fire({affectsConfiguration:name=>name.startsWith('agentdesklink')});
  assert.ok(refreshed>0);assert.equal((await p.provideMcpServerDefinitions()).length,0);
});
test('stop command and sidebar revoke definitions and explicit resume creates a fresh generation',async()=>{
  const h=harness({enabled:true}),panel=await h.panel(),p=h.providers.get('agentdesklink.mcp');
  const [before]=await p.provideMcpServerDefinitions();
  assert.doesNotMatch(panel.view.webview.html,/id="(?:node-path|config-path|config-select|config-open)"/);
  assert.match(panel.view.webview.html,/id="emergency-stop"/);
  assert.equal(h.commands.has('agentdesklink.selectPolicy'),false);
  const props=require('../../package.json').contributes.configuration.properties;
  assert.equal(props['agentdesklink.nodePath'],undefined);assert.equal(props['agentdesklink.configPath'],undefined);
  await panel.send({type:'emergencyStop'});
  assert.equal((await p.provideMcpServerDefinitions()).length,0);
  assert.equal(JSON.parse(fs.readFileSync(before.env.ADL_OPERATION_CONTROL,'utf8')).stopped,true);
  assert.equal(h.posts.at(-1).stopped,true);
  await h.commands.get('agentdesklink.resumeOperations')();
  const [after]=await p.provideMcpServerDefinitions();
  assert.notEqual(before.env.ADL_OPERATION_EPOCH,after.env.ADL_OPERATION_EPOCH);assert.notEqual(before.version,after.version);
});
test('stop stays available in untrusted and empty windows and ignores removed UI messages',async()=>{
  for(const options of [{trusted:false},{empty:true}]){
    const h=harness({},options),panel=await h.panel();
    await panel.send({type:'emergencyStop'});assert.equal(h.posts.at(-1).stopped,true);
    await h.commands.get('agentdesklink.emergencyStop')();
    for(const type of ['setNodePath','setConfigPath','selectPolicy','openPolicy'])await panel.send({type,value:'ignored'});
    assert.equal(h.writes.length,0);
    await panel.send({type:'resumeOperations'});assert.equal(h.posts.at(-1).stopped,false);
  }
});
test('panel saves workspace and user scopes, validates messages and provides CSP', async () => {
  const h = harness(); const panel = await h.panel();
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
  for (const value of [null, [], { type: 'setEnabled', enabled: 'false' }, { type: 'setAutoUpdate', enabled: 1 }, { type: 'unknown' }]) await panel.send(value);
  assert.equal(h.writes.length, count);
});
test('untrusted or empty panel refuses workspace writes and saving failure is surfaced', async () => {
  for (const opts of [{ trusted: false }, { empty: true }]) {
    const h = harness({}, opts), panel = await h.panel();
    await panel.send({ type: 'setEnabled', enabled: true });
    assert.ok(!h.writes.some(x => x.key === 'enabled'));
  }
  const h = harness({}, { failSave: true }), panel = await h.panel();
  await panel.send({ type: 'setEnabled', enabled: true });
  assert.ok(h.notifications.length || h.posts.some(x => JSON.stringify(x).includes('error')));
});
test('update command does not fetch when no source is configured or checks are disabled', async () => {
  for (const config of [{}, { checkForUpdates: false, updateManifestUrl: 'https://updates.example/manifest.json' }]) {
    let fetched = 0;
    const h = harness(config, { fetch: async () => { fetched++; throw new Error('should not fetch'); } }); await h.ready;
    assert.ok(h.commands.has('agentdesklink.checkForUpdates'));
    await h.commands.get('agentdesklink.checkForUpdates')();
    assert.equal(fetched, 0);
  }
});
test('auto update verifies download, installs once and respects disabled setting mid-request', async () => {
  const bytes = Buffer.from('test-vsix');
  const manifest = { version: nextVersion, url: `https://updates.example/agentdesklink-${nextVersion}.vsix`, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  let count = 0;
  const h = harness({ updateManifestUrl: 'https://updates.example/manifest.json' }, { fetch: async url => {
    count++;
    return new Response(String(url).endsWith('.vsix') ? bytes : JSON.stringify(manifest), { status: 200 });
  } }); await h.ready;
  await Promise.all([h.commands.get('agentdesklink.checkForUpdates')(), h.commands.get('agentdesklink.checkForUpdates')()]);
  assert.equal(h.executions.filter(x => x.id === 'workbench.extensions.installExtension').length, 1);
  await h.commands.get('agentdesklink.checkForUpdates')();
  assert.equal(h.executions.filter(x => x.id === 'workbench.extensions.installExtension').length, 1);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const r = harness({ updateManifestUrl: 'https://updates.example/manifest.json' }, { fetch: async () => { await pending; return new Response(JSON.stringify(manifest)); } }); await r.ready;
  const check = r.commands.get('agentdesklink.checkForUpdates')();
  r.config.autoUpdate = false; r.changes.fire({ affectsConfiguration: name => name.startsWith('agentdesklink') }); release(); await check;
  assert.equal(r.executions.filter(x => x.id === 'workbench.extensions.installExtension').length, 0);
});
test('notifications-only mode and invalid digest never install an update', async () => {
  for (const automatic of [false, true]) {
    let downloads = 0;
    const h = harness({ autoUpdate: automatic, updateManifestUrl: 'https://updates.example/manifest.json' }, { fetch: async url => {
      const isVsix = String(url).endsWith('.vsix');
      if (isVsix) downloads++;
      return new Response(isVsix ? 'bad content' : JSON.stringify({ version: nextVersion, url: 'https://updates.example/update.vsix', sha256: 'a'.repeat(64) }));
    } });
    await h.ready; await h.commands.get('agentdesklink.checkForUpdates')();
    assert.equal(downloads, automatic ? 1 : 0);
    if (!automatic) assert.ok(h.notifications.some(text => text.includes(nextVersion)));
    assert.equal(h.executions.filter(x => x.id === 'workbench.extensions.installExtension').length, 0);
  }
});
test('equal and older update versions never download or install a VSIX', async () => {
  for (const version of [currentVersion, '0.0.0']) {
    let requests = 0;
    const h = harness({ updateManifestUrl: 'https://updates.example/manifest.json' }, { fetch: async url => {
      requests++;
      assert.ok(!String(url).endsWith('.vsix'));
      return new Response(JSON.stringify({ version, url: 'https://updates.example/update.vsix', sha256: 'a'.repeat(64) }));
    } });
    await h.ready; await h.commands.get('agentdesklink.checkForUpdates')();
    assert.equal(requests, 1);
    assert.equal(h.executions.filter(x => x.id === 'workbench.extensions.installExtension').length, 0);
  }
});

test('provider versions stay stable across reads and change only when MCP settings refresh', async () => {
  const h = harness({ enabled: true }); await h.ready;
  const p = h.providers.get('agentdesklink.mcp');
  const first = (await p.provideMcpServerDefinitions())[0];
  assert.equal((await p.provideMcpServerDefinitions())[0].version, first.version);
  h.config.nodePath = '/opt/another-node';
  h.changes.fire({ affectsConfiguration: name => name === 'agentdesklink' || name === 'agentdesklink.nodePath' });
  assert.equal((await p.provideMcpServerDefinitions())[0].version, first.version,'removed Node setting is ignored');
  await h.commands.get('agentdesklink.resumeOperations')();
  assert.notEqual((await p.provideMcpServerDefinitions())[0].version, first.version);
});

test('removed policy command and invalid update URLs leave saved settings unchanged', async () => {
  const h = harness(); const p = await h.panel();
  assert.equal(h.commands.has('agentdesklink.selectPolicy'),false);
  assert.equal(h.writes.length, 0);
  await p.send({ type: 'setUpdateManifestUrl', value: 'http://unsafe.example/update.json' });
  assert.equal(h.writes.length, 0);
  assert.ok(h.posts.at(-1).status.globalError);
});

test('default empty nodePath uses the bundled node with browser and GC env', async () => {
  const h = harness({ enabled: true }); await h.ready;
  const [definition] = await h.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
  const rt = path.join(h.extensionRoot, 'runtime');
  assert.equal(definition.command, path.join(rt, process.platform === 'win32' ? 'node.exe' : 'node'));
  assert.ok(definition.env.ADL_BROWSER_EXECUTABLE);
  assert.equal(definition.env.PLAYWRIGHT_SKIP_BROWSER_GC, '1');
  if (process.platform === 'linux') assert.ok(!('ADL_BUNDLED_HELPER_PATH' in definition.env));
  else assert.equal(definition.env.ADL_BUNDLED_HELPER_PATH, path.join(rt, process.platform === 'darwin' ? 'helper/adl-macos-ax-helper' : 'helper/adl-windows-uia-helper.exe'));
});

test('missing runtime or node and mismatched targets fail closed even with a custom nodePath; repair retries', async () => {
  const cases = [{ bundle: false }, { dropNode: true }, { manifest: { target: 'linux-ia32' } }];
  if (process.platform !== 'linux') cases.push({ dropHelper: true });
  for (const options of cases) {
    const h = harness({ enabled: true, nodePath: '/opt/custom node' }, options); await h.ready;
    const p = h.providers.get('agentdesklink.mcp');
    assert.equal((await p.provideMcpServerDefinitions()).length, 0, JSON.stringify(options));
    assert.ok(p.lastError, `error surfaced for ${JSON.stringify(options)}`);
  }
  const h = harness({ enabled: true }, { bundle: false }); await h.ready;
  const p = h.providers.get('agentdesklink.mcp');
  assert.equal((await p.provideMcpServerDefinitions()).length, 0);
  makeBundle(h.extensionRoot);
  const [definition] = await p.provideMcpServerDefinitions();
  assert.equal(definition.command, path.join(h.extensionRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'));
  assert.equal(p.lastError, null);
});

test('disabled, untrusted and empty windows never touch the runtime bundle', async () => {
  for (const options of [{ bundle: false }, { bundle: false, trusted: false }, { bundle: false, empty: true }]) {
    const h = harness({ enabled: options.trusted === false || !!options.empty }, options); await h.ready;
    const p = h.providers.get('agentdesklink.mcp');
    assert.equal((await p.provideMcpServerDefinitions()).length, 0);
    assert.ok(!p.lastError || !p.lastError.includes('Bundled runtime'), `bundle touched for ${JSON.stringify(options)}`);
  }
});

test('concurrent provider calls coalesce and cancellation or races during async setup publish nothing', async () => {
  const h = harness({ enabled: true }); await h.ready;
  const p = h.providers.get('agentdesklink.mcp');
  const [a, b] = await Promise.all([p.provideMcpServerDefinitions(), p.provideMcpServerDefinitions()]);
  assert.equal(a.length, 1); assert.equal(b.length, 1);
  const token = { isCancellationRequested: false };
  const cancelled = p.provideMcpServerDefinitions(token);
  token.isCancellationRequested = true;
  assert.equal((await cancelled).length, 0);
  const disabled = p.provideMcpServerDefinitions();
  h.config.enabled = false;
  assert.equal((await disabled).length, 0);
  const h2 = harness({ enabled: true }); await h2.ready;
  const p2 = h2.providers.get('agentdesklink.mcp');
  const stopping = p2.provideMcpServerDefinitions();
  await h2.commands.get('agentdesklink.emergencyStop')();
  assert.equal((await stopping).length, 0);
  const h3 = harness({ enabled: true }); await h3.ready;
  const p3 = h3.providers.get('agentdesklink.mcp');
  const trustChange = p3.provideMcpServerDefinitions();
  h3.vscode.workspace.isTrusted = false;
  assert.equal((await trustChange).length, 0);
  const h4 = harness({ enabled: true }); await h4.ready;
  const p4 = h4.providers.get('agentdesklink.mcp');
  const folderChange = p4.provideMcpServerDefinitions();
  h4.vscode.workspace.workspaceFolders = [];
  assert.equal((await folderChange).length, 0);
  const h5 = harness({ enabled: true }); await h5.ready;
  const p5 = h5.providers.get('agentdesklink.mcp');
  const disposed = p5.provideMcpServerDefinitions();
  p5.dispose();
  assert.equal((await disposed).length, 0);
  const h6 = harness({ enabled: true }); await h6.ready;
  const policyChange = h6.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
  h6.config.configPath = 'other-policy.json';
  assert.equal((await policyChange).length, 1,'obsolete policy setting no longer affects setup');
  const h7 = harness({ enabled: true }); await h7.ready;
  const mutatedFolders = h7.providers.get('agentdesklink.mcp').provideMcpServerDefinitions();
  h7.vscode.workspace.workspaceFolders.push({name:'New',uri:h7.vscode.Uri.file(path.join(h7.temp,'new')),index:1});
  assert.equal((await mutatedFolders).length, 0);
});

test('browser preparation does not block disabling MCP or overwrite newer panel settings', async () => {
  const h = harness({enabled:true}); await h.ready;
  const original = fs.promises.stat;
  let release;
  const blocked = new Promise(resolve => {release=resolve;});
  fs.promises.stat = async (file, ...args) => {
    if (String(file) === path.join(h.extensionRoot,'runtime','manifest.json')) await blocked;
    return original(file,...args);
  };
  try {
    const panel = await h.panel();
    await Promise.race([
      panel.send({type:'setEnabled',enabled:false}),
      new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('settings blocked by setup')),500);timer.unref();})
    ]);
    assert.equal(h.config.enabled,false);
    release();
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(h.posts.at(-1).settings.enabled,false);
  } finally { release(); fs.promises.stat=original; }
});
