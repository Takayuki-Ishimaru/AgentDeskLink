import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { readSettings, log, panelPermissions, permissionError, permissionsEnvJson } from './shared.js';
import { SettingsPanelProvider, PanelHooks } from './panel.js';
import { UpdateChecker } from './updates.js';
import { resolveRuntime } from './runtime.js';
import { prepareBrowser } from './browser-setup.js';
import { AiClientManager } from './client-manager.js';
import { initializeOperationState,readOperationState,writeOperationState } from '../operation-control.js';

function folders(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

class McpProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions = this.emitter.event;
  lastError: string | null = null;
  private disposed = false;
  private helper: string | undefined;
  get helperPath(): string | undefined { return this.helper; }
  private seq = 0;
  private pendingSetups = 0;
  get preparing(): boolean { return this.pendingSetups > 0; }
  private setupController = new AbortController();
  constructor(private readonly serverPath: string, private readonly extVersion: string, private readonly extensionRoot: string, private readonly storageDir: string, private readonly controlPath:string) {}
  refresh() { if (!this.disposed) { this.setupController.abort(); this.setupController=new AbortController(); this.seq++; this.lastError = null; this.helper = undefined; this.emitter.fire(); } }
  dispose() { this.disposed = true; this.setupController.abort(); this.emitter.dispose(); }

  async provideMcpServerDefinitions(token?: vscode.CancellationToken): Promise<vscode.McpServerDefinition[]> {
    if (this.disposed || token?.isCancellationRequested) return [];
    const generation = this.seq;
    const settings = readSettings();
    const deny = (error: string | null): [] => { this.lastError = error; this.helper = undefined; return []; };
    if (!settings.enabled) return deny(null);
    if (!vscode.workspace.isTrusted) return deny('ワークスペースが信頼されていません / Workspace is not trusted.');
    const wsFolders = [...folders()];
    if (wsFolders.length === 0) return deny('ワークスペースにフォルダーがありません / No workspace folder is open.');
    initializeOperationState(this.controlPath);
    const control=readOperationState(this.controlPath);
    if(!control||control.stopped)return deny('緊急停止中です。操作を再開するまで MCP は停止します。');
    const current = () => {
      const now = readSettings();
      const controlNow=readOperationState(this.controlPath);
      return !this.disposed && !token?.isCancellationRequested && generation === this.seq && now.enabled && vscode.workspace.isTrusted &&
        controlNow?.epoch===control.epoch && controlNow.stopped===false &&
        folders().map(f => f.uri.toString()).join('\n') === wsFolders.map(f => f.uri.toString()).join('\n');
    };
    let runtime;
    let browser;
    this.pendingSetups++;
    try {
      runtime = await resolveRuntime({ extensionRoot: this.extensionRoot });
      if (!current()) return [];
      browser = await prepareBrowser({extensionRoot:this.extensionRoot,nodePath:runtime.nodePath,storageDir:this.storageDir,
        playwrightVersion:runtime.manifest.playwrightVersion,signal:this.setupController.signal});
    } catch (err) {
      return current() ? deny(err instanceof Error ? err.message : String(err)) : [];
    } finally { this.pendingSetups--; }
    if (!current()) return [];
    const args = [this.serverPath];
    const cwd = wsFolders[0]!.uri;
    const command = runtime.nodePath;
    const env = {...runtime.env,PLAYWRIGHT_BROWSERS_PATH:browser.browsersPath,ADL_BROWSER_EXECUTABLE:browser.executablePath,ADL_MCP_PERMISSIONS:permissionsEnvJson(settings),ADL_OPERATION_CONTROL:this.controlPath,ADL_OPERATION_EPOCH:control.epoch};
    const fingerprint = createHash('sha256').update(JSON.stringify([command, env, args, cwd.toString(), this.seq])).digest('hex').slice(0, 16);
    const version = `${this.extVersion}+${fingerprint}`;
    this.lastError = null;
    this.helper = runtime.helperPath ?? undefined;
    const def = new vscode.McpStdioServerDefinition('agentdesklink', command, args, env, version);
    (def as { cwd?: vscode.Uri }).cwd = cwd;
    return [def];
  }
}

let deactivateHook: (() => void) | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const root = context.extensionUri?.fsPath ?? path.resolve(__dirname, '..', '..');
  const extVersion = String(context.extension?.packageJSON?.version ?? '0.0.0');
  log.channel = vscode.window.createOutputChannel('AgentDeskLink');
  const controlPath=path.join(context.globalStorageUri.fsPath,'operations.json');
  const externalControlPath=path.join(context.globalStorageUri.fsPath,'ai-clients-control.json');
  initializeOperationState(controlPath);
  const provider = new McpProvider(path.join(root, 'dist', 'src', 'server.js'), extVersion, root, context.globalStorageUri.fsPath,controlPath);
  const updater = new UpdateChecker(extVersion, () => { void panel?.refresh(); });
  let panel: SettingsPanelProvider | undefined;
  let bulkChanging = false;
  let bulkIntent = 0;
  let bulkSaves = Promise.resolve();
  let owner = folders().map(f => f.uri.toString()).join('\n');
  const clients = new AiClientManager({
    storageDir: context.globalStorageUri.fsPath,
    get owner() { return owner; },
    detectOptions: { extensionIds: vscode.extensions?.all.map(extension => extension.id) ?? [] },
    canEnable: () => readSettings().enabled && vscode.workspace.isTrusted && folders().length > 0 &&
      folders().map(f => f.uri.toString()).join('\n') === owner && readOperationState(controlPath)?.stopped === false &&
      readOperationState(externalControlPath)?.stopped !== true,
    getLaunch: async () => {
      const [definition] = await provider.provideMcpServerDefinitions();
      if (!definition || !('command' in definition)) return undefined;
      const stdio = definition as vscode.McpStdioServerDefinition;
      const env: Record<string, string> = Object.fromEntries(Object.entries(stdio.env ?? {}).flatMap(([key,value]) => typeof value === 'string' ? [[key,value]] : []));
      return { command: stdio.command, args: [...stdio.args], env, cwd: folders()[0]!.uri.fsPath };
    },
    changed: () => { void panel?.refresh(); },
  });
  const syncClients = () => clients.sync(readSettings().enabled && readOperationState(externalControlPath)?.stopped !== true);
  let lastControl=JSON.stringify(readOperationState(controlPath));
  const controlChanged=()=>{
    const current=JSON.stringify(readOperationState(controlPath));
    if(current===lastControl)return;
    lastControl=current;provider.refresh();void panel?.refresh();
    if (readSettings().syncClients) void syncClients();
  };

  const hooks: PanelHooks = {
    checkForUpdates: () => updater.check(true),
    openLogs: () => log.channel?.show(true),
    openWorkspaceSettings: () => { void vscode.commands.executeCommand('workbench.action.openSettings', 'agentdesklink'); },
    emergencyStop: async () => {
      writeOperationState(controlPath,true);
      controlChanged();
      log.line('Emergency stop requested: all extension-managed servers revoked.');
    },
    resumeOperations: async () => {
      writeOperationState(controlPath,false);
      controlChanged();
    },
    operationsStopped: () => readOperationState(controlPath)?.stopped!==false,
    mcpStatus: () => {
      if(readOperationState(controlPath)?.stopped!==false)return '緊急停止中です。再開するまで新しい操作も実行されません。';
      const s = readSettings();
      if (!s.enabled) return 'MCP は無効です。';
      if (!vscode.workspace.isTrusted) return 'ワークスペースを信頼すると MCP を利用できます。';
      if (folders().length === 0) return 'フォルダーを開くと MCP を利用できます。';
      if (permissionError(s)) return '権限設定が無効です。修正するまですべての権限を拒否します。';
      if (provider.preparing) return 'Chromeを確認しています。見つからない場合は専用Chromiumを自動準備します…';
      if (provider.lastError) return '設定を確認してください。MCP は提供されていません。';
      return 'VS Code に MCP を提供中です。起動は MCP 管理画面で確認できます。';
    },
    mcpError: () => permissionError(readSettings()) ?? provider.lastError,
    permissions: () => panelPermissions(readSettings(), provider.helperPath),
    updateStatus: () => updater.status(),
    version: () => extVersion,
    refreshMcp: async () => { await provider.provideMcpServerDefinitions(); },
    clientState: () => ({ rows: clients.rows(), busy: clients.busy, error: clients.error, owner: clients.owner() ?? '' }),
    refreshClients: async () => { clients.detect(); if (readSettings().syncClients) await syncClients(); },
    setAllClientsEnabled: async (enabled: boolean) => {
      if (enabled && (!vscode.workspace.isTrusted || !folders().length)) throw new Error('信頼できるフォルダーを開いてください。');
      if (enabled && readOperationState(controlPath)?.stopped !== false) throw new Error('操作を再開してから有効にしてください。');
      const intent = ++bulkIntent;
      writeOperationState(externalControlPath, !enabled);
      // Revoke before awaiting settings persistence, including when saving fails.
      clients.revoke(true);
      const persisted = bulkSaves.then(async () => {
        if (intent !== bulkIntent || !folders().length) return;
        bulkChanging = true;
        try {
          const configuration = vscode.workspace.getConfiguration('agentdesklink');
          await configuration.update('enabled', enabled, vscode.ConfigurationTarget.Workspace);
          if (intent !== bulkIntent) return;
          await configuration.update('syncClients', enabled, vscode.ConfigurationTarget.Workspace);
        } finally { bulkChanging = false; }
      });
      bulkSaves = persisted.catch(() => {});
      await persisted;
      if (intent !== bulkIntent) return;
      provider.refresh();
      await clients.sync(enabled, true);
    },
  };

  panel = new SettingsPanelProvider(context.extensionUri, hooks);
  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider('agentdesklink.mcp', provider),
    vscode.window.registerWebviewViewProvider('agentdesklink.settings', panel),
  );

  fs.watchFile(controlPath,{interval:100,persistent:false},controlChanged);
  const controlWatcher={dispose:()=>fs.unwatchFile(controlPath,controlChanged)};

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('agentdesklink')) return;
    if (['autoUpdate', 'checkForUpdates'].some(k => e.affectsConfiguration(`agentdesklink.${k}`))) updater.cancel();
    if (['enabled', 'browserOrigins', 'desktopAppId', 'desktopAppPath', 'allowAllOperations', 'allowPhysicalInput',
      'allowUnredactedImages', 'allowLoopback', 'allowPrivateNetwork'].some(k => e.affectsConfiguration(`agentdesklink.${k}`))) {
      provider.refresh();
    }
    if (!bulkChanging && ['enabled', 'syncClients', 'browserOrigins', 'desktopAppId', 'desktopAppPath', 'allowAllOperations',
      'allowPhysicalInput', 'allowUnredactedImages', 'allowLoopback', 'allowPrivateNetwork'].some(k => e.affectsConfiguration(`agentdesklink.${k}`))) {
      if (readSettings().syncClients) void syncClients();
      else if (clients.owner() === owner) void clients.sync(false);
    }
    void panel?.refresh();
  }));
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => { clients.revoke(); owner = folders().map(f => f.uri.toString()).join('\n'); clients.detect(); provider.refresh(); void panel?.refresh(); }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { provider.refresh(); if (readSettings().syncClients) void syncClients(); void panel?.refresh(); }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agentdesklink.openSettings', async () => {
      await vscode.commands.executeCommand('agentdesklink.settings.focus');
    }),
    vscode.commands.registerCommand('agentdesklink.openLogs', () => log.channel?.show(true)),
    vscode.commands.registerCommand('agentdesklink.checkForUpdates', () => updater.check(true)),
    vscode.commands.registerCommand('agentdesklink.emergencyStop', () => hooks.emergencyStop()),
    vscode.commands.registerCommand('agentdesklink.resumeOperations', () => hooks.resumeOperations()),
    vscode.commands.registerCommand('agentdesklink.openWorkspaceSettings', () => hooks.openWorkspaceSettings()),
    vscode.commands.registerCommand('agentdesklink.enableAllClients', () => hooks.setAllClientsEnabled(true)),
    vscode.commands.registerCommand('agentdesklink.disableAllClients', () => hooks.setAllClientsEnabled(false)),
    vscode.commands.registerCommand('agentdesklink.refreshClients', () => hooks.refreshClients()),
  );

  updater.start();
  context.subscriptions.push(provider, updater, panel, log.channel!, controlWatcher, clients);
  log.line(`activated v${extVersion}`);
  void panel.refresh();
  if (readSettings().syncClients) void syncClients();
  else if (clients.owner() === owner) void clients.sync(false);
  deactivateHook = () => { updater.dispose(); provider.dispose(); controlWatcher.dispose(); clients.dispose(); };
}

export function deactivate(): void {
  deactivateHook?.();
  deactivateHook = undefined;
}
