import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  readSettings,
  log,
  panelPermissions,
  mcpPermissions,
  permissionError,
  permissionsEnvJson,
  runtimeSettingsEnvJson,
} from './shared.js';
import type { OperationMode } from '../bundled-policy.js';
import { SettingsPanelProvider, PanelHooks, type BrowserSetupView } from './panel.js';
import { UpdateChecker } from './updates.js';
import { resolveRuntime } from './runtime.js';
import {
  prepareBrowser,
  detectInstalledBrowsers,
  expectedChromium,
  browserDownloadHosts,
  type InstalledBrowser,
} from './browser-setup.js';
import { AiClientManager } from './client-manager.js';
import { initializeOperationState, readOperationState, writeOperationState } from '../operation-control.js';
import { ApprovalBroker } from './approval-broker.js';

function folders(): readonly vscode.WorkspaceFolder[] {
  return vscode.workspace.workspaceFolders ?? [];
}

// What allowAllOperations lifts (verified against browser-preflight.ts, policy.ts authorizeAction, browser.ts request routing and the native helper's --allow-all):
// the per-control privacy and consequential-action checks, the form-submit and non-GET network gates, and the native control allowlist. Origin, loopback/private-network and app grants stay enforced.
const ALLOW_ALL_MESSAGE = 'すべての操作を確認なしで許可しますか？ / Allow all operations without per-action approval?';
const ALLOW_ALL_DETAIL = [
  '許可済みのサイトとアプリの範囲内で、AI は次の操作を 1 回ごとの確認なしで実行できるようになります。',
  '• フォームの送信、ログイン、新規登録、注文・購入・支払い・送金の確定',
  '• 削除・送信・解約・アップロードなど、取り消せない可能性のあるボタンのクリック',
  '• パスワードや認証情報など秘密の可能性がある欄への入力',
  '• サイトのスクリプトによるデータの送信・変更・削除（POST / PUT / DELETE）と、ファイルのダウンロード',
  '• 座標指定のクリックと、設定したデスクトップアプリのすべてのコントロールの操作',
  '引き続き有効: 許可した origin とアプリ、ループバック／プライベートネットワークの設定、保護領域、緊急停止。ローカルファイルを選んで送るアップロード操作は未対応です。',
  'キャンセルすると、現在の権限段階のまま変更しません。',
  '',
  'Within the sites and app you have granted, the AI will be able to do the following without asking each time:',
  '• Submit forms, log in, sign up, and complete orders, purchases, payments and transfers',
  '• Click buttons that may be irreversible: delete, send, cancel an account, upload',
  '• Type into fields that may hold secrets, such as passwords and credentials',
  '• Let page scripts send, change or delete data (POST / PUT / DELETE), and accept file downloads',
  '• Click at coordinates, and operate every control of the configured desktop app',
  'Still enforced: your granted origins and app, loopback / private-network settings, protected regions and the emergency stop. Choosing local files to upload is not supported.',
  'Cancel keeps your current permission tier unchanged.',
].join('\n');
const KNOWN_VSCODE_APP_IDS = new Set([
  'com.microsoft.vscode',
  'com.microsoft.vscodeinsiders',
  'com.microsoft.vscodeexploration',
  'com.visualstudio.code.oss',
  'com.todesktop.230313mzl4w4u92',
  'com.exafunction.windsurf',
]);
function canonicalPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}
function appBundle(pathname: string): string | undefined {
  const normalized = path.resolve(pathname);
  const parts = normalized.split(path.sep);
  let current = path.parse(normalized).root;
  for (const part of parts.filter(Boolean)) {
    current = path.join(current, part);
    if (part.toLowerCase().endsWith('.app')) return canonicalPath(current);
  }
  return undefined;
}
/** Ask approvals must never be actionable by a native target that can click the host modal. */
function askHostTargetConflict(settings: ReturnType<typeof readSettings>): string | undefined {
  // Semantic native tiers reach every platform, so the conflict no longer depends on physical input: a host-app target could invoke the modal's buttons through the accessibility API.
  if (
    settings.allowAllOperations ||
    settings.operationMode !== 'ask' ||
    !settings.desktopAppId ||
    !settings.desktopAppPath
  )
    return undefined;
  const appId = settings.desktopAppId.trim().toLowerCase();
  const remote = typeof vscode.env.remoteName === 'string' && vscode.env.remoteName.length > 0;
  if (remote)
    return 'Ask approvals are disabled because this remote extension host cannot safely identify the native target. / リモート拡張ホストではネイティブ対象を安全に識別できないため、都度承認を無効にしています。';
  const hostIds = new Set(KNOWN_VSCODE_APP_IDS);
  const hostName = String(vscode.env.appName ?? '').toLowerCase();
  if (/visual studio code|vscodium|cursor|windsurf/.test(hostName)) {
    if (/visual studio code/.test(hostName)) {
      hostIds.add('com.microsoft.vscode');
      hostIds.add('com.microsoft.vscodeinsiders');
      hostIds.add('com.microsoft.vscodeexploration');
    }
    if (/vscodium/.test(hostName)) hostIds.add('com.visualstudio.code.oss');
    if (/cursor/.test(hostName)) hostIds.add('com.todesktop.230313mzl4w4u92');
    if (/windsurf/.test(hostName)) hostIds.add('com.exafunction.windsurf');
  }
  const exec = canonicalPath(process.execPath),
    target = canonicalPath(settings.desktopAppPath);
  const sameExec = exec === target;
  const hostBundle = appBundle(exec),
    targetBundle = appBundle(target);
  const sameBundle = !!hostBundle && hostBundle === targetBundle;
  const hostExe = path.basename(exec).toLowerCase();
  const sameId =
    hostIds.has(appId) ||
    appId === hostExe ||
    (appId === path.basename(settings.desktopAppPath).toLowerCase() &&
      /^(code|code-insiders|codium|cursor|windsurf)(\.exe)?$/.test(hostExe));
  if (sameExec || sameBundle || sameId)
    return 'Ask approvals are disabled because the native target can control the VS Code host and click its approval dialog. Remove the host app target or disable physical input. / ネイティブ対象がVS Codeホストを操作し承認ダイアログを押せるため、都度承認を無効にしています。ホストアプリの許可を削除するか物理入力を無効にしてください。';
  return undefined;
}

class McpProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions = this.emitter.event;
  lastError: string | null = null;
  private disposed = false;
  private helper: string | undefined;
  get helperPath(): string | undefined {
    return this.helper;
  }
  private seq = 0;
  private pendingSetups = 0;
  get preparing(): boolean {
    return this.pendingSetups > 0;
  }
  private setupController = new AbortController();
  // Browser setup state for the panel: the last download failure, the installed browsers that could stand in, and the one in use.
  browserFailed = false;
  installedBrowsers: InstalledBrowser[] = [];
  browserInUse: InstalledBrowser | null = null;
  expected: { revision?: string; version?: string } = {};
  playwrightVersion = '';
  constructor(
    private readonly serverPath: string,
    private readonly extVersion: string,
    private readonly extensionRoot: string,
    private readonly storageDir: string,
    private readonly controlPath: string,
    private readonly approvalBroker: Promise<ApprovalBroker>,
    private readonly approvalEnabled: () => boolean,
    private readonly fallbackChoice: () => string | undefined = () => undefined,
  ) {}
  refresh() {
    if (!this.disposed) {
      this.setupController.abort();
      this.setupController = new AbortController();
      this.seq++;
      this.lastError = null;
      this.helper = undefined;
      this.emitter.fire();
    }
  }
  dispose() {
    this.disposed = true;
    this.setupController.abort();
    this.emitter.dispose();
  }

  async provideMcpServerDefinitions(token?: vscode.CancellationToken): Promise<vscode.McpServerDefinition[]> {
    if (this.disposed || token?.isCancellationRequested) return [];
    const generation = this.seq;
    const settings = readSettings();
    const deny = (error: string | null): [] => {
      this.lastError = error;
      this.helper = undefined;
      this.browserFailed = false;
      this.browserInUse = null;
      return [];
    };
    if (!settings.enabled) return deny(null);
    if (!vscode.workspace.isTrusted) return deny('ワークスペースが信頼されていません / Workspace is not trusted.');
    const wsFolders = [...folders()];
    if (wsFolders.length === 0) return deny('ワークスペースにフォルダーがありません / No workspace folder is open.');
    initializeOperationState(this.controlPath);
    const control = readOperationState(this.controlPath);
    if (!control || control.stopped) return deny('緊急停止中です。操作を再開するまで MCP は停止します。');
    let runtimeEnv: string;
    try {
      runtimeEnv = runtimeSettingsEnvJson(settings);
    } catch {
      return deny('セッションまたはブラウザー運用設定が無効です。 / Runtime settings are invalid.');
    }
    const current = () => {
      const now = readSettings();
      const controlNow = readOperationState(this.controlPath);
      return (
        !this.disposed &&
        !token?.isCancellationRequested &&
        generation === this.seq &&
        now.enabled &&
        vscode.workspace.isTrusted &&
        controlNow?.epoch === control.epoch &&
        controlNow.stopped === false &&
        folders()
          .map(f => f.uri.toString())
          .join('\n') === wsFolders.map(f => f.uri.toString()).join('\n')
      );
    };
    let runtime;
    let browser;
    let browserStage = false,
      chosen: InstalledBrowser | undefined;
    this.pendingSetups++;
    try {
      runtime = await resolveRuntime({ extensionRoot: this.extensionRoot });
      if (!current()) return [];
      this.playwrightVersion = runtime.manifest.playwrightVersion;
      browserStage = true;
      // The installed browser is used only after the user chose it in the panel; the choice is an ID that is looked up again here, never a stored path.
      const choice = this.fallbackChoice();
      chosen = choice ? (await detectInstalledBrowsers()).find(b => b.id === choice && b.usable) : undefined;
      browser = await prepareBrowser({
        extensionRoot: this.extensionRoot,
        nodePath: runtime.nodePath,
        storageDir: this.storageDir,
        playwrightVersion: runtime.manifest.playwrightVersion,
        headless: settings.browserHeadless,
        signal: this.setupController.signal,
        ...(chosen ? { fallbackExecutable: chosen.executablePath } : {}),
      });
    } catch (err) {
      if (!current()) return [];
      if (browserStage) {
        this.installedBrowsers = await detectInstalledBrowsers().catch(() => []);
        this.expected = await expectedChromium(this.extensionRoot);
      }
      if (!current()) return [];
      const denied = deny(err instanceof Error ? err.message : String(err));
      // Set after deny(), which clears it: only a failed browser setup shows the recovery section.
      if (browserStage) this.browserFailed = true;
      return denied;
    } finally {
      this.pendingSetups--;
    }
    if (!current()) return [];
    this.browserFailed = false;
    this.browserInUse = browser.source === 'fallback' ? (chosen ?? null) : null;
    const args = ['--use-system-ca', this.serverPath];
    const cwd = wsFolders[0]!.uri;
    const command = runtime.nodePath;
    const approvalEnv = this.approvalEnabled() ? await (await this.approvalBroker).env(control.epoch) : {};
    if (!current()) return [];
    const env = {
      ...runtime.env,
      PLAYWRIGHT_BROWSERS_PATH: browser.browsersPath,
      ADL_BROWSER_EXECUTABLE: browser.executablePath,
      ADL_MCP_PERMISSIONS: permissionsEnvJson(settings),
      ADL_MCP_RUNTIME_SETTINGS: runtimeEnv,
      ADL_OPERATION_CONTROL: this.controlPath,
      ADL_OPERATION_EPOCH: control.epoch,
      ...approvalEnv,
    };
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([command, env, args, cwd.toString(), this.seq]))
      .digest('hex')
      .slice(0, 16);
    const version = `${this.extVersion}+${fingerprint}`;
    this.lastError = null;
    this.helper = runtime.helperPath ?? undefined;
    const def = new vscode.McpStdioServerDefinition('agentdesklink', command, args, env, version);
    (def as { cwd?: vscode.Uri }).cwd = cwd;
    return [def];
  }
}

const BROWSER_CHOICE_KEY = 'agentdesklink.installedBrowser';
let deactivateHook: (() => void) | undefined;
let liveApprovalBroker: ApprovalBroker | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const root = context.extensionUri?.fsPath ?? path.resolve(__dirname, '..', '..');
  const extVersion = String(context.extension?.packageJSON?.version ?? '0.0.0');
  log.channel = vscode.window.createOutputChannel('AgentDeskLink');
  const controlPath = path.join(context.globalStorageUri.fsPath, 'operations.json');
  const externalControlPath = path.join(context.globalStorageUri.fsPath, 'ai-clients-control.json');
  initializeOperationState(controlPath);
  let owner = folders()
    .map(f => f.uri.toString())
    .join('\n');
  const approvalBroker = ApprovalBroker.create(
    () => {
      const settings = readSettings();
      const control = readOperationState(controlPath);
      return (
        !askHostTargetConflict(settings) &&
        vscode.workspace.isTrusted &&
        folders().length > 0 &&
        folders()
          .map(f => f.uri.toString())
          .join('\n') === owner &&
        settings.enabled &&
        !permissionError(settings) &&
        control?.stopped === false &&
        readOperationState(externalControlPath)?.stopped !== true
      );
    },
    () => owner,
    () => panelPermissions(readSettings()).effective.browserOrigins,
    () => {
      const app = mcpPermissions(readSettings()).desktopAppId;
      return app ? [app] : [];
    },
  );
  void approvalBroker.then(broker => {
    liveApprovalBroker = broker;
    context.subscriptions.push(broker);
  });
  const provider = new McpProvider(
    path.join(root, 'dist', 'src', 'server.js'),
    extVersion,
    root,
    context.globalStorageUri.fsPath,
    controlPath,
    approvalBroker,
    () => !askHostTargetConflict(readSettings()),
    () => context.globalState.get<string>(BROWSER_CHOICE_KEY),
  );
  const updater = new UpdateChecker(extVersion, () => {
    void panel?.refresh();
  });
  let panel: SettingsPanelProvider | undefined;
  let bulkChanging = false;
  let bulkIntent = 0;
  let bulkSaves = Promise.resolve();
  const clients = new AiClientManager({
    storageDir: context.globalStorageUri.fsPath,
    get owner() {
      return owner;
    },
    detectOptions: { extensionIds: vscode.extensions?.all.map(extension => extension.id) ?? [] },
    canEnable: () =>
      readSettings().enabled &&
      vscode.workspace.isTrusted &&
      folders().length > 0 &&
      folders()
        .map(f => f.uri.toString())
        .join('\n') === owner &&
      readOperationState(controlPath)?.stopped === false &&
      readOperationState(externalControlPath)?.stopped !== true,
    getLaunch: async () => {
      const [definition] = await provider.provideMcpServerDefinitions();
      if (!definition || !('command' in definition)) return undefined;
      const stdio = definition as vscode.McpStdioServerDefinition;
      const env: Record<string, string> = Object.fromEntries(
        Object.entries(stdio.env ?? {}).flatMap(([key, value]) => (typeof value === 'string' ? [[key, value]] : [])),
      );
      return { command: stdio.command, args: [...stdio.args], env, cwd: folders()[0]!.uri.fsPath };
    },
    changed: () => {
      void panel?.refresh();
    },
  });
  const syncClients = () =>
    clients.sync(readSettings().enabled && readOperationState(externalControlPath)?.stopped !== true);
  let lastControl = JSON.stringify(readOperationState(controlPath));
  const revokePolicy = () => {
    const previous = readOperationState(controlPath);
    const next = writeOperationState(controlPath, previous?.stopped ?? false);
    lastControl = JSON.stringify(next);
    liveApprovalBroker?.revoke(next.epoch);
    clients.revoke(true);
    provider.refresh();
  };
  const controlChanged = () => {
    const current = JSON.stringify(readOperationState(controlPath));
    if (current === lastControl) return;
    lastControl = current;
    liveApprovalBroker?.revoke(readOperationState(controlPath)?.epoch);
    provider.refresh();
    void panel?.refresh();
    if (readSettings().syncClients) void syncClients();
  };

  // A new setup attempt: aborts the previous one, clears the shown failure and republishes the definitions (and the external client entries that embed the browser path).
  const retryBrowser = async () => {
    provider.refresh();
    await provider.provideMcpServerDefinitions();
    if (readSettings().syncClients) void syncClients();
  };
  const hooks: PanelHooks = {
    checkForUpdates: () => updater.check(true),
    openLogs: () => log.channel?.show(true),
    openWorkspaceSettings: () => {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'agentdesklink');
    },
    emergencyStop: async () => {
      writeOperationState(controlPath, true);
      liveApprovalBroker?.revoke(readOperationState(controlPath)?.epoch);
      controlChanged();
      log.line('Emergency stop requested: all extension-managed servers revoked.');
    },
    resumeOperations: async () => {
      writeOperationState(controlPath, false);
      liveApprovalBroker?.revoke(readOperationState(controlPath)?.epoch);
      controlChanged();
    },
    operationsStopped: () => readOperationState(controlPath)?.stopped !== false,
    mcpStatus: () => {
      if (readOperationState(controlPath)?.stopped !== false)
        return '緊急停止中です。再開するまで新しい操作も実行されません。';
      const s = readSettings();
      if (askHostTargetConflict(s)) return askHostTargetConflict(s)!;
      if (!s.enabled) return 'MCP は無効です。';
      if (!vscode.workspace.isTrusted) return 'ワークスペースを信頼すると MCP を利用できます。';
      if (folders().length === 0) return 'フォルダーを開くと MCP を利用できます。';
      if (permissionError(s)) return '権限設定が無効です。修正するまですべての権限を拒否します。';
      if (provider.preparing) return 'Chromeを確認しています。見つからない場合は専用Chromiumを自動準備します…';
      if (provider.lastError) return '設定を確認してください。MCP は提供されていません。';
      return 'VS Code に MCP を提供中です。起動は MCP 管理画面で確認できます。';
    },
    mcpError: () => askHostTargetConflict(readSettings()) ?? permissionError(readSettings()) ?? provider.lastError,
    permissions: () => {
      const summary = panelPermissions(readSettings(), provider.helperPath);
      const reason = askHostTargetConflict(readSettings());
      if (reason) summary.effective.reasons.push(reason);
      return summary;
    },
    updateStatus: () => updater.status(),
    version: () => extVersion,
    refreshMcp: async () => {
      await provider.provideMcpServerDefinitions();
    },
    browserSetup: (): BrowserSetupView => ({
      failed: provider.browserFailed,
      preparing: provider.preparing,
      hosts: browserDownloadHosts(),
      expected: {
        playwright: provider.playwrightVersion,
        ...(provider.expected.version ? { chromium: provider.expected.version } : {}),
        ...(provider.expected.revision ? { revision: provider.expected.revision } : {}),
      },
      installed: provider.installedBrowsers.map(b => ({
        id: b.id,
        label: b.label,
        path: b.executablePath,
        usable: b.usable,
        ...(b.note ? { note: b.note } : {}),
        ...(b.version ? { version: b.version } : {}),
      })),
      using: provider.browserInUse
        ? {
            id: provider.browserInUse.id,
            label: provider.browserInUse.label,
            path: provider.browserInUse.executablePath,
            ...(provider.browserInUse.version ? { version: provider.browserInUse.version } : {}),
          }
        : null,
    }),
    retryBrowserSetup: () => retryBrowser(),
    useInstalledBrowser: async (id: string) => {
      const found =
        provider.installedBrowsers.find(b => b.id === id && b.usable) ??
        (await detectInstalledBrowsers()).find(b => b.id === id && b.usable);
      if (!found) throw new Error('指定されたブラウザーが見つかりません。 / The selected browser was not found.');
      await context.globalState.update(BROWSER_CHOICE_KEY, found.id);
      await retryBrowser();
    },
    clearInstalledBrowser: async () => {
      await context.globalState.update(BROWSER_CHOICE_KEY, undefined);
      await retryBrowser();
    },
    clientState: () => ({
      rows: clients.rows(),
      busy: clients.busy,
      error: clients.error,
      owner: clients.owner() ?? '',
    }),
    refreshClients: async () => {
      clients.detect();
      if (readSettings().syncClients) await syncClients();
    },
    setAllClientsEnabled: async (enabled: boolean) => {
      if (enabled && (!vscode.workspace.isTrusted || !folders().length))
        throw new Error('信頼できるフォルダーを開いてください。');
      if (enabled && readOperationState(controlPath)?.stopped !== false)
        throw new Error('操作を再開してから有効にしてください。');
      const intent = ++bulkIntent;
      writeOperationState(externalControlPath, !enabled);
      liveApprovalBroker?.revoke();
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
        } finally {
          bulkChanging = false;
        }
      });
      bulkSaves = persisted.catch(() => {});
      await persisted;
      if (intent !== bulkIntent) return;
      provider.refresh();
      await clients.sync(enabled, true);
    },
    setOperationMode: async (mode: OperationMode | 'all') => {
      if (!vscode.workspace.isTrusted || !folders().length)
        throw new Error('信頼できるワークスペースが必要です / A trusted workspace is required.');
      if (mode === 'all') {
        const confirmed = await vscode.window.showWarningMessage(
          ALLOW_ALL_MESSAGE,
          { modal: true, detail: ALLOW_ALL_DETAIL },
          'すべて許可 / Allow all',
        );
        if (confirmed !== 'すべて許可 / Allow all') return;
      }
      writeOperationState(externalControlPath, true);
      await revokePolicy();
      bulkChanging = true;
      try {
        const configuration = vscode.workspace.getConfiguration('agentdesklink');
        if (mode === 'all')
          await configuration.update('allowAllOperations', true, vscode.ConfigurationTarget.Workspace);
        else {
          await configuration.update('allowAllOperations', false, vscode.ConfigurationTarget.Workspace);
          await configuration.update('operationMode', mode, vscode.ConfigurationTarget.Workspace);
        }
      } finally {
        bulkChanging = false;
        writeOperationState(externalControlPath, false);
        provider.refresh();
        if (readSettings().syncClients) await clients.sync(true, true);
      }
    },
  };

  panel = new SettingsPanelProvider(context.extensionUri, hooks);
  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider('agentdesklink.mcp', provider),
    vscode.window.registerWebviewViewProvider('agentdesklink.settings', panel),
  );

  fs.watchFile(controlPath, { interval: 100, persistent: false }, controlChanged);
  const controlWatcher = { dispose: () => fs.unwatchFile(controlPath, controlChanged) };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('agentdesklink')) return;
      if (['autoUpdate', 'checkForUpdates'].some(k => e.affectsConfiguration(`agentdesklink.${k}`))) updater.cancel();
      if (
        [
          'enabled',
          'sessionIdleMinutes',
          'browserHeadless',
          'browserProxyServer',
          'browserProxyConnectByHostname',
          'operationMode',
          'browserOrigins',
          'desktopAppId',
          'desktopAppPath',
          'allowAllOperations',
          'allowPhysicalInput',
          'browserResourceOrigins',
          'allowPersonalData',
          'allowUnredactedImages',
          'allowLoopback',
          'allowPrivateNetwork',
        ].some(k => e.affectsConfiguration(`agentdesklink.${k}`))
      ) {
        void revokePolicy();
      }
      if (
        !bulkChanging &&
        [
          'enabled',
          'syncClients',
          'sessionIdleMinutes',
          'browserHeadless',
          'browserProxyServer',
          'browserProxyConnectByHostname',
          'operationMode',
          'browserOrigins',
          'desktopAppId',
          'desktopAppPath',
          'allowAllOperations',
          'allowPhysicalInput',
          'browserResourceOrigins',
          'allowPersonalData',
          'allowUnredactedImages',
          'allowLoopback',
          'allowPrivateNetwork',
        ].some(k => e.affectsConfiguration(`agentdesklink.${k}`))
      ) {
        if (readSettings().syncClients) void syncClients();
        else if (clients.owner() === owner) void clients.sync(false);
      }
      void panel?.refresh();
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      clients.revoke();
      owner = folders()
        .map(f => f.uri.toString())
        .join('\n');
      void revokePolicy();
      clients.detect();
      void panel?.refresh();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void revokePolicy();
      if (readSettings().syncClients) void syncClients();
      void panel?.refresh();
    }),
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
  deactivateHook = () => {
    updater.dispose();
    provider.dispose();
    controlWatcher.dispose();
    clients.dispose();
    liveApprovalBroker?.dispose();
    liveApprovalBroker = undefined;
    void approvalBroker.then(broker => broker.dispose());
  };
}

export function deactivate(): void {
  deactivateHook?.();
  deactivateHook = undefined;
}
