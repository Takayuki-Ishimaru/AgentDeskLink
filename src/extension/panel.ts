import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { readSettings, runtimeSettings, runtimeProxyMode, log, type PermissionSummary } from './shared.js';
import {
  normalizePermissions,
  describePermissionError,
  normalizeRuntimeSettings,
  runtimeSettingsFromIdleMinutes,
  type ExtensionRuntimeSettings,
} from '../bundled-policy.js';
import type { OperationMode } from '../bundled-policy.js';
import type { ClientRow } from './client-manager.js';
import { resolveDesktopSelection, validateDesktopApp } from './desktop-app.js';

export interface BrowserSetupView {
  failed: boolean;
  preparing: boolean;
  hosts: string[];
  expected: { playwright: string; chromium?: string; revision?: string };
  installed: { id: string; label: string; path: string; usable: boolean; note?: string; version?: string }[];
  using: { id: string; label: string; path: string; version?: string } | null;
}

export interface PanelHooks {
  checkForUpdates(): Promise<void>;
  openLogs(): void;
  openWorkspaceSettings(): void;
  emergencyStop(): Promise<void>;
  resumeOperations(): Promise<void>;
  operationsStopped(): boolean;
  mcpStatus(): string;
  mcpError(): string | null;
  permissions(): PermissionSummary;
  updateStatus(): string;
  version(): string;
  refreshMcp(): Promise<void>;
  browserSetup(): BrowserSetupView;
  retryBrowserSetup(): Promise<void>;
  useInstalledBrowser(id: string): Promise<void>;
  clearInstalledBrowser(): Promise<void>;
  clientState(): { rows: ClientRow[]; busy: boolean; error: string; owner: string };
  refreshClients(): Promise<void>;
  setAllClientsEnabled(enabled: boolean): Promise<void>;
  setOperationMode(mode: OperationMode | 'all'): Promise<void>;
}

const KEYS = ['enabled', 'autoUpdate', 'checkForUpdates'] as const;

export class SettingsPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly busy = new Set<string>();
  private saves = Promise.resolve();
  private errors: {
    enabledError?: string;
    originsError?: string;
    runtimeError?: string;
    operationModeError?: string;
    globalError?: string;
    desktopError?: string;
    desktopNotice?: string;
  } = {};

  constructor(
    private readonly extUri: vscode.Uri,
    private readonly hooks: PanelHooks,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'media')] };
    view.webview.html = this.html(view.webview);
    this.disposables.push(view.webview.onDidReceiveMessage((msg: unknown) => this.handle(msg)));
    this.disposables.push(
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined;
      }),
    );
    void this.postState();
  }

  async refresh(): Promise<void> {
    await this.postState();
  }
  dispose(): void {
    this.view = undefined;
    this.disposables.splice(0).forEach(d => d.dispose());
  }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', 'settings.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', 'settings.js'));
    const brand = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', 'brand-mark.png'));
    const language = /^ja(?:-|$)/i.test(vscode.env.language) ? 'ja' : 'en';
    const options: string[] = [];
    const html = `<!DOCTYPE html><html lang="${language}"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>AgentDeskLink</title></head><body>
<header class="header-row"><div class="title-group"><img class="brand-mark" src="${brand}" alt="" width="32" height="32"><h2>AgentDeskLink</h2></div><label class="language-control" for="ui-language"><span data-i18n-ja>表示言語</span><span data-i18n-en>Language</span><select id="ui-language" aria-label="表示言語 / UI language"><option value="ja">日本語</option><option value="en">English</option></select></label><span class="version" id="version"></span></header>
<p class="hint intro">ブラウザとデスクトップを、必要な範囲で。 / Control your browser and desktop within explicit grants.</p>
<p class="hint">Node と helper を同梱しています。Chrome を検出し、必要な場合は専用 Chromium を取得します。 / Node and helpers are bundled. Chrome is detected, with dedicated Chromium downloaded when needed.</p>
<section class="section" aria-labelledby="workspace-title">
  <h3 id="workspace-title">このワークスペース / Workspace</h3>
  <div class="actions emergency-row"><button id="emergency-stop" class="danger" title="実行中の操作をただちに停止します / Stop running operations immediately">緊急停止 / Emergency stop</button><button id="resume-operations" class="secondary" hidden>操作を再開 / Resume operations</button></div>
  <p class="status" id="stopped-status" role="status" hidden>緊急停止中です。再開するには「操作を再開」を押してください。 / Operations are stopped. Select Resume operations to continue.</p>
  <div class="row"><label class="check"><input type="checkbox" id="enabled"><span>このワークスペースで MCP を有効にする / Enable MCP in this workspace</span></label></div>
  <p class="hint" id="enabled-hint">変更はこのワークスペースに保存されます。 / Changes are saved to this workspace.</p>
  <h4 class="perm-title">許可する範囲 / Trusted grants</h4>
  <p class="hint">権限はワークスペース単位です。空の許可リストはアクセスを許可しません。 / Grants apply to this workspace; empty lists allow no access.</p>
  <div class="row"><label class="check"><input type="checkbox" id="allow-loopback"><span>ループバックを許可 / Allow loopback (localhost)</span></label></div>
  <div class="row"><label class="check"><input type="checkbox" id="allow-private-network"><span>プライベートネットワークを許可 / Allow private network</span></label></div>
  <div class="row"><label class="check"><input type="checkbox" id="allow-personal-data"><span>メール・電話番号などの個人データを表示 / Allow revealing email and phone numbers</span></label></div>
  <h4 class="perm-title">ブラウザ移動を許可する origin / Navigable browser origins</h4>
  <p class="hint">完全な http(s) origin を追加します。localhost はループバック許可を手動で有効にした場合のみ利用できます。 / Add exact http(s) origins. Localhost requires manually enabling the loopback grant.</p>
  <ul class="client-list" id="origins-list" aria-label="Navigable browser origins"></ul>
  <div class="actions"><input id="origin-input" type="text" inputmode="url" placeholder="https://example.com" aria-label="Origin to allow"><button id="origin-add">追加 / Add</button></div>
  <p class="hint" id="loopback-suggestion" hidden>この origin はループバックです。必要な場合だけ上の許可を手動で有効にしてください。 / This is a loopback origin. Enable the grant above manually only if needed.</p>
  <p class="hint" id="private-network-suggestion" hidden>この origin はプライベートネットワークのアドレスです。必要な場合だけ上の「プライベートネットワークを許可」を手動で有効にしてください。 / This origin is a private-network address. Enable "Allow private network" above manually only if needed.</p>
  <h4 class="perm-title">サブリソースを許可する origin / Resource origins</h4>
  <p class="hint">画像などの読み込み専用です。ブラウザ移動は許可されません。完全な http(s) origin が必要です。 / Allows subresource loading only, not navigation; exact http(s) origins required.</p>
  <ul class="client-list" id="resource-origins-list" aria-label="Resource origins"></ul>
  <div class="actions"><input id="resource-origin-input" type="text" inputmode="url" placeholder="https://cdn.example.com" aria-label="Resource origin to allow"><button id="resource-origin-add">追加 / Add</button></div>
  <p class="error" id="origins-error" role="alert"></p>
  <h4 class="perm-title">現在の実効権限 / Effective permissions</h4>
  <ul class="permissions" id="permissions"></ul>
  <div class="row"><label for="operation-mode">操作の権限段階 / Operation permission tier</label><select id="operation-mode" aria-label="Operation permission tier"><option value="read_only">読み取り専用 / Read only</option><option value="standard">標準 / Standard</option><option value="ask">都度承認 / Ask each time</option><option value="all">すべて許可 / Allow all (legacy)</option></select></div>
  <p class="hint">都度承認はブラウザー操作と、許可したデスクトップアプリの重要なネイティブ操作（削除・送信など）に適用されます。機密コントロールは承認できません。「すべて許可」は、フォーム送信・削除・購入や支払い・認証情報の入力を確認なしで許可します。有効にする前に内容を確認する画面が表示されます。 / Ask applies to browser actions and to consequential native actions (delete, send, ...) in the granted desktop app; sensitive native controls are never approved. Allow all lets the AI submit forms, delete, buy or pay, and enter credentials without asking; a confirmation dialog lists the details before it is enabled.</p>
  <p class="error" id="operation-mode-error" role="alert"></p>
  <p class="hint" id="permissions-hint"></p>
  <details class="advanced-settings"><summary>詳細設定 / Advanced settings</summary>
  <div class="row runtime-row"><label for="session-idle-minutes">セッションのアイドル期限 / Session idle timeout</label><input id="session-idle-minutes" type="number" min="1" max="60" step="1" aria-label="分 / Minutes"><span>分 / minutes</span></div>
  <div class="row"><label class="check"><input id="browser-headless" type="checkbox"><span>ヘッドレスで起動 / Run headless</span></label></div>
  <label class="field-label" for="browser-proxy-server">公開プロキシ origin / Public proxy origin</label>
  <input id="browser-proxy-server" type="text" inputmode="url" placeholder="https://proxy.example:8443" aria-label="http(s) proxy origin"><p class="hint">認証情報・パス・クエリなしの http(s) origin のみ。認証プロキシは CLI 設定を使用してください。 / http(s) origin only, without credentials, path, or query. Configure authenticated proxies through the CLI.</p>
  <div class="row"><label class="check"><input id="browser-proxy-connect-hostname" type="checkbox"><span>プロキシへの CONNECT をホスト名で送る / Send proxy CONNECT by hostname</span></label></div>
  <p class="hint">ホスト名で許可判定する企業プロキシ向けです。通常は検査済みの IP アドレスで接続します。ローカルの DNS／IP 検査と TLS のホスト名検証は維持されます。HTTPS のみ。 / For corporate proxies that allow traffic by hostname; by default CONNECT uses the vetted IP address. Local DNS and IP checks and TLS hostname verification still apply. HTTPS only.</p>
  <p class="hint">操作がないセッションを自動終了します（1〜60 分）。 / Automatically closes idle sessions (1–60 minutes).</p>
  <p class="status" id="session-idle-effective" role="status"></p>
  <p class="error" id="runtime-settings-error" role="alert"></p>
  </details>
  <p class="error" id="enabled-error" role="alert"></p>
  <p class="status" id="mcp-status" role="status"></p>
  <p class="error" id="mcp-error" role="alert"></p>
  <div class="browser-setup" id="browser-setup" hidden>
    <h4 class="perm-title">ブラウザの準備 / Browser setup</h4>
    <p class="status" id="browser-setup-status" role="status"></p>
    <p class="hint">自動取得に必要な接続先（HTTPS・ポート 443）: / Hosts the automatic download needs (HTTPS, port 443):</p>
    <ul class="client-list" id="browser-hosts" aria-label="ブラウザ取得先 / Browser download hosts"></ul>
    <p class="hint">プロキシ配下では VS Code を起動する環境に HTTPS_PROXY を、社内ミラーを使う場合は PLAYWRIGHT_DOWNLOAD_HOST を設定してから再試行してください。 / Behind a proxy, set HTTPS_PROXY in the environment VS Code starts from; for an internal mirror set PLAYWRIGHT_DOWNLOAD_HOST. Then retry.</p>
    <div class="actions"><button id="browser-retry">再試行 / Retry</button></div>
    <h4 class="perm-title">インストール済みのブラウザ / Installed browsers</h4>
    <p class="hint" id="browser-installed-empty" hidden>Chromium 系のブラウザ（Microsoft Edge、Chromium など）は見つかりませんでした。Google Chrome を入れるか、上の接続先を許可して再試行してください。 / No other Chromium-based browser (Microsoft Edge, Chromium) was found. Install Google Chrome, or allow the hosts above and retry.</p>
    <ul class="client-list stacked" id="browser-installed" aria-label="インストール済みのブラウザ / Installed browsers"></ul>
    <p class="hint" id="browser-compat"></p>
    <div class="actions"><button id="browser-use-auto" class="secondary" hidden>自動取得に戻す / Back to the automatic download</button></div>
  </div>
</section>
<section class="section" aria-labelledby="desktop-title">
  <h3 id="desktop-title">デスクトップアプリ / Desktop app</h3>
  <p class="hint">AI が観測・操作できるネイティブアプリを 1 つだけ指定します。ワークスペースごとの信頼設定で、信頼したワークスペースでのみ保存できます。 / Name the one native app the AI may observe and operate. A trusted per-workspace setting that can only be saved in a trusted workspace.</p>
  <p class="hint" id="desktop-os-hint"></p>
  <label class="field-label" for="desktop-app-id">アプリ ID / App ID</label>
  <input id="desktop-app-id" type="text" maxlength="128" placeholder="com.example.app" aria-label="アプリ ID / App ID" autocomplete="off" spellcheck="false">
  <label class="field-label" for="desktop-app-path">実行ファイルの絶対パス / Absolute executable path</label>
  <input id="desktop-app-path" type="text" placeholder="/path/to/app" aria-label="実行ファイルの絶対パス / Absolute executable path" autocomplete="off" spellcheck="false">
  <div class="actions"><button id="desktop-browse" class="secondary">参照… / Browse…</button><button id="desktop-save">保存 / Save</button><button id="desktop-clear" class="secondary">指定を解除 / Clear</button></div>
  <p class="status" id="desktop-notice" role="status"></p>
  <p class="error" id="desktop-error" role="alert"></p>
  <div class="row"><label class="check"><input type="checkbox" id="allow-physical-input"><span>物理入力を許可 / Allow physical input</span></label></div>
  <p class="hint">AI が本物のマウス・スクロール操作を OS 全体に送れるようになります。人の操作と区別されず、前面の別のウィンドウに届く恐れがあります。無加工の画像の許可も必要です。 / Lets the AI send real mouse and scroll input to the whole desktop. It is not isolated from your own input and could reach another window in front. Needs unredacted images too.</p>
  <div class="row"><label class="check"><input type="checkbox" id="allow-unredacted-images"><span>無加工のネイティブ画像を許可 / Allow unredacted native images</span></label></div>
  <p class="hint">アプリのウィンドウ画像を、秘密情報のマスクなしで AI に送ります。パスワード、個人情報、他のウィンドウの内容が写る恐れがあります。 / Sends the app window image to the AI without masking secrets. Passwords, personal data or other content in the window may be visible.</p>
</section>
<section class="section" aria-labelledby="clients-title">
  <h3 id="clients-title">AI クライアント / AI clients</h3>
  <p class="hint">インストール済みクライアントを検出します。一括有効にすると、このワークスペースの権限を共有します。 / Installed clients are detected automatically. Enabling all shares this workspace's permissions.</p>
  <div class="actions"><button id="clients-enable">すべて有効 / Enable all</button><button id="clients-disable" class="secondary">すべて無効 / Disable all</button><button id="clients-refresh" class="secondary">再検出 / Detect again</button></div>
  <ul class="client-list" id="clients-list" aria-label="AIクライアントの登録状態 / AI client registration status"></ul>
  <p class="status" id="clients-status" role="status"></p>
  <p class="error" id="clients-error" role="alert"></p>
  <p class="hint">反映には再接続や再起動が必要な場合があります。同名の手動設定は保持します。最後に一括有効にしたワークスペースが接続を管理します。 / Reconnect or restart clients if needed. Existing entries with the same name are preserved. The workspace that last enabled all clients manages the connection.</p>
</section>
<section class="section" aria-labelledby="updates-title">
  <h3 id="updates-title">拡張機能の更新 / Extension updates</h3>
  <p class="hint">すべてのワークスペースに適用されます。 / Applies to all workspaces.</p>
  <div class="row"><label class="check"><input type="checkbox" id="auto-update"><span>自動更新を有効にする / Enable automatic updates</span></label></div>
  <div class="row"><label class="check"><input type="checkbox" id="check-updates"><span>新しいバージョンを確認する / Check for new versions</span></label></div>
  <p class="hint">起動後と 6 時間ごとに確認します。更新の反映には VS Code の再読み込みが必要です。 / Checks after startup and every 6 hours. Reload VS Code to apply an update.</p>
  <p class="status" id="update-status" role="status"></p>
  <div class="actions"><button id="check-now" class="secondary">今すぐ確認 / Check now</button></div>
</section>
<p class="hint"><span data-i18n-ja>更新元は GitHub の公式リポジトリ（<span id="update-source">Takayuki-Ishimaru/AgentDeskLink</span>）に固定されています。設定は不要です。</span><span data-i18n-en>Updates use the official GitHub repository; no source configuration is needed.</span></p>
<section class="section support">
  <div class="actions"><button id="open-logs" class="secondary">ログを開く / Open logs</button><button id="open-settings" class="secondary">設定を開く / Open Settings</button></div>
  <p class="error" id="global-error" role="alert"></p>
</section>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
    return html
      .replace(/<option\b[\s\S]*?<\/option>/g, option => `__ADL_OPTION_${options.push(option) - 1}__`)
      .replace(/>([^<>]*?) \/ ([^<>]*?)</g, '><span data-i18n-ja>$1</span><span data-i18n-en>$2</span><')
      .replace(/__ADL_OPTION_(\d+)__/g, (_match, index: string) => options[Number(index)]!);
  }

  private isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  // Returns an awaitable promise for the host onDidReceiveMessage contract.
  handle(message: unknown): Promise<void> {
    if (!this.isPlainObject(message) || typeof message.type !== 'string') return Promise.resolve();
    const m = message;
    switch (m.type) {
      case 'setEnabled':
        if (typeof m.enabled === 'boolean')
          return this.save('enabled', m.enabled, vscode.ConfigurationTarget.Workspace, 'enabledError');
        return Promise.resolve();
      case 'setAutoUpdate':
      case 'setCheckForUpdates': {
        const key = m.type === 'setAutoUpdate' ? 'autoUpdate' : 'checkForUpdates';
        if (typeof m.enabled === 'boolean')
          return this.save(key, m.enabled, vscode.ConfigurationTarget.Global, 'globalError');
        return Promise.resolve();
      }
      case 'setBrowserOrigins':
        if (Array.isArray(m.origins) && m.origins.every(value => typeof value === 'string'))
          return this.saveOrigins(m.origins as string[]);
        return Promise.resolve();
      case 'setBrowserResourceOrigins':
        if (Array.isArray(m.origins) && m.origins.every(value => typeof value === 'string'))
          return this.saveGrantSetting('browserResourceOrigins', m.origins as string[]);
        return Promise.resolve();
      case 'setAllowLoopback':
      case 'setAllowPrivateNetwork':
      case 'setAllowPersonalData': {
        if (typeof m.enabled !== 'boolean') return Promise.resolve();
        const key =
          m.type === 'setAllowLoopback'
            ? 'allowLoopback'
            : m.type === 'setAllowPrivateNetwork'
              ? 'allowPrivateNetwork'
              : 'allowPersonalData';
        return this.saveGrantSetting(key, m.enabled);
      }
      case 'setAllowPhysicalInput':
      case 'setAllowUnredactedImages':
        if (typeof m.enabled === 'boolean')
          return this.saveGrantSetting(
            m.type === 'setAllowPhysicalInput' ? 'allowPhysicalInput' : 'allowUnredactedImages',
            m.enabled,
            'desktopError',
          );
        return Promise.resolve();
      case 'setDesktopApp':
        if (typeof m.appId === 'string' && typeof m.appPath === 'string')
          return this.saveDesktopApp(m.appId, m.appPath);
        return Promise.resolve();
      case 'browseDesktopApp':
        return this.browseDesktopApp();
      case 'retryBrowserSetup':
        return this.runGuarded('browser', () => this.hooks.retryBrowserSetup());
      case 'useInstalledBrowser':
        if (typeof m.id === 'string') {
          const id = m.id;
          return this.runGuarded('browser', () => this.hooks.useInstalledBrowser(id));
        }
        return Promise.resolve();
      case 'clearInstalledBrowser':
        return this.runGuarded('browser', () => this.hooks.clearInstalledBrowser());
      case 'setSessionIdleMinutes':
        if (typeof m.minutes === 'number') return this.saveRuntimeSetting(m.minutes);
        return Promise.resolve();
      case 'setBrowserHeadless':
        if (typeof m.enabled === 'boolean') return this.saveRuntimeSetting({ browserHeadless: m.enabled });
        return Promise.resolve();
      case 'setBrowserProxyServer':
        if (typeof m.proxy === 'string') return this.saveRuntimeSetting({ browserProxyServer: m.proxy });
        return Promise.resolve();
      case 'setBrowserProxyConnectByHostname':
        if (typeof m.enabled === 'boolean')
          return this.saveRuntimeSetting({ browserProxyConnectByHostname: m.enabled });
        return Promise.resolve();
      case 'setOperationMode':
        if (m.mode === 'read_only' || m.mode === 'standard' || m.mode === 'ask' || m.mode === 'all')
          return this.saveOperationMode(m.mode);
        return Promise.resolve();
      case 'emergencyStop':
        return this.runGuarded('stop', () => this.hooks.emergencyStop());
      case 'resumeOperations':
        return this.runGuarded('resume', () => this.hooks.resumeOperations());
      case 'enableAllClients':
        return this.saveClients(true);
      case 'disableAllClients':
        return this.saveClients(false);
      case 'refreshClients':
        return this.runGuarded('clients', () => this.hooks.refreshClients());
      case 'checkForUpdates':
        return this.checkForUpdates();
      case 'openLogs':
        this.hooks.openLogs();
        return Promise.resolve();
      case 'openWorkspaceSettings':
        this.hooks.openWorkspaceSettings();
        return Promise.resolve();
      case 'ready':
        return this.postState();
      default:
        return Promise.resolve();
    }
  }

  private save(
    key: (typeof KEYS)[number],
    value: boolean,
    target: vscode.ConfigurationTarget,
    errorKey: 'enabledError' | 'globalError',
  ): Promise<void> {
    const saved = this.saves.then(() => this.performSave(key, value, target, errorKey));
    this.saves = saved.catch(() => {});
    return saved;
  }

  private saveClients(enabled: boolean): Promise<void> {
    if (!enabled) return this.runGuarded('clients', () => this.hooks.setAllClientsEnabled(false));
    const saved = this.saves.then(() => this.runGuarded('clients', () => this.hooks.setAllClientsEnabled(enabled)));
    this.saves = saved.catch(() => {});
    return saved;
  }

  private saveOrigins(origins: string[]): Promise<void> {
    const saved = this.saves.then(async () => {
      this.errors.originsError = undefined;
      if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.length) {
        this.errors.originsError =
          '信頼できるワークスペースでのみ保存できます。 / Open a trusted workspace to save origins.';
        await this.postState();
        return;
      }
      try {
        const current = readSettings();
        const grants = {
          browserOrigins: origins,
          desktopAppId: current.desktopAppId,
          desktopAppPath: current.desktopAppPath,
          allowAllOperations: current.allowAllOperations,
          allowPhysicalInput: current.allowPhysicalInput,
          browserResourceOrigins: current.browserResourceOrigins,
          allowPersonalData: current.allowPersonalData,
          allowUnredactedImages: current.allowUnredactedImages,
          allowLoopback: current.allowLoopback,
          allowPrivateNetwork: current.allowPrivateNetwork,
        };
        const normalized = normalizePermissions(grants).browserOrigins;
        const candidate = normalizePermissions({ ...grants, browserOrigins: normalized });
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > 65_536)
          throw new Error('permission settings exceed 65536 bytes');
        this.busy.add('origins');
        await this.postState();
        await vscode.workspace
          .getConfiguration('agentdesklink')
          .update('browserOrigins', normalized, vscode.ConfigurationTarget.Workspace);
      } catch (error) {
        this.errors.originsError = `${describePermissionError(error)} / Failed to save browser origins: ${error instanceof Error ? error.message : String(error)}`;
        log.line(`save failed browserOrigins: ${String(error)}`);
      } finally {
        this.busy.delete('origins');
      }
      await this.postState();
    });
    this.saves = saved.catch(() => {});
    return saved;
  }

  private saveGrantSetting(
    key:
      | 'browserResourceOrigins'
      | 'allowLoopback'
      | 'allowPrivateNetwork'
      | 'allowPersonalData'
      | 'allowPhysicalInput'
      | 'allowUnredactedImages',
    value: string[] | boolean,
    errorKey: 'originsError' | 'desktopError' = 'originsError',
  ): Promise<void> {
    const saved = this.saves.then(async () => {
      this.errors[errorKey] = undefined;
      const busyKey = errorKey === 'desktopError' ? 'desktop' : 'origins';
      if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.length) {
        this.errors[errorKey] =
          '信頼できるワークスペースでのみ保存できます。 / Open a trusted workspace to save grants.';
        await this.postState();
        return;
      }
      try {
        const current = readSettings();
        const candidate = normalizePermissions({
          browserOrigins: current.browserOrigins,
          browserResourceOrigins: key === 'browserResourceOrigins' ? value : current.browserResourceOrigins,
          allowPersonalData: key === 'allowPersonalData' ? value : current.allowPersonalData,
          desktopAppId: current.desktopAppId,
          desktopAppPath: current.desktopAppPath,
          allowAllOperations: current.allowAllOperations,
          operationMode: current.operationMode,
          allowPhysicalInput: key === 'allowPhysicalInput' ? value : current.allowPhysicalInput,
          allowUnredactedImages: key === 'allowUnredactedImages' ? value : current.allowUnredactedImages,
          allowLoopback: key === 'allowLoopback' ? value : current.allowLoopback,
          allowPrivateNetwork: key === 'allowPrivateNetwork' ? value : current.allowPrivateNetwork,
        });
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > 65_536)
          throw new Error('permission settings exceed 65536 bytes');
        this.busy.add(busyKey);
        await this.postState();
        const persisted = key === 'browserResourceOrigins' ? candidate.browserResourceOrigins : value;
        await vscode.workspace
          .getConfiguration('agentdesklink')
          .update(key, persisted, vscode.ConfigurationTarget.Workspace);
      } catch (error) {
        this.errors[errorKey] =
          `${describePermissionError(error)} / Failed to save ${key}: ${error instanceof Error ? error.message : String(error)}`;
        log.line(`save failed ${key}: ${String(error)}`);
      } finally {
        this.busy.delete(busyKey);
      }
      await this.postState();
    });
    this.saves = saved.catch(() => {});
    return saved;
  }

  private saveRuntimeSetting(
    update:
      | number
      | { browserHeadless: boolean }
      | { browserProxyServer: string }
      | { browserProxyConnectByHostname: boolean },
  ): Promise<void> {
    const saved = this.saves.then(async () => {
      this.errors.runtimeError = undefined;
      if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.length) {
        this.errors.runtimeError =
          '信頼できるワークスペースでのみ保存できます。 / Open a trusted workspace to save this setting.';
        await this.postState();
        return;
      }
      try {
        const current = readSettings();
        if (typeof update === 'number' && (!Number.isSafeInteger(update) || update < 1 || update > 60))
          throw new Error('Enter a whole number of minutes from 1 to 60. / 1〜60 の整数分を入力してください。');
        const next =
          typeof update === 'number' ? { ...current, sessionIdleMinutes: update } : { ...current, ...update };
        const runtime = normalizeRuntimeSettings({
          ...runtimeSettingsFromIdleMinutes(next.sessionIdleMinutes),
          browserHeadless: next.browserHeadless,
          browserProxyServer: next.browserProxyServer,
          ...runtimeProxyMode(next),
        });
        this.busy.add('runtime');
        await this.postState();
        const config = vscode.workspace.getConfiguration('agentdesklink');
        if (typeof update === 'number')
          await config.update('sessionIdleMinutes', update, vscode.ConfigurationTarget.Workspace);
        else if ('browserHeadless' in update)
          await config.update('browserHeadless', runtime.browserHeadless, vscode.ConfigurationTarget.Workspace);
        else if ('browserProxyConnectByHostname' in update)
          await config.update(
            'browserProxyConnectByHostname',
            update.browserProxyConnectByHostname,
            vscode.ConfigurationTarget.Workspace,
          );
        else
          await config.update('browserProxyServer', runtime.browserProxyServer, vscode.ConfigurationTarget.Workspace);
      } catch (error) {
        this.errors.runtimeError = `設定値が無効です。 / Invalid runtime setting: ${error instanceof Error ? error.message : String(error)}`;
        log.line(`save failed runtime settings: ${String(error)}`);
      } finally {
        this.busy.delete('runtime');
      }
      await this.postState();
    });
    this.saves = saved.catch(() => {});
    return saved;
  }

  // A trusted per-workspace pair: the ID never exists without a path (the path is written first when setting, last when clearing).
  private saveDesktopApp(appId: string, appPath: string): Promise<void> {
    const saved = this.saves.then(async () => {
      this.errors.desktopError = undefined;
      this.errors.desktopNotice = undefined;
      if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.length) {
        this.errors.desktopError =
          '信頼できるワークスペースでのみ保存できます。 / Open a trusted workspace to save the desktop app.';
        await this.postState();
        return;
      }
      try {
        const checked = await validateDesktopApp({ appId, appPath });
        if (!checked.ok) {
          this.errors.desktopError = checked.message;
          await this.postState();
          return;
        }
        const current = readSettings();
        const candidate = normalizePermissions({
          browserOrigins: current.browserOrigins,
          browserResourceOrigins: current.browserResourceOrigins,
          allowPersonalData: current.allowPersonalData,
          desktopAppId: checked.value.appId,
          desktopAppPath: checked.value.appPath,
          allowAllOperations: current.allowAllOperations,
          operationMode: current.operationMode,
          allowPhysicalInput: current.allowPhysicalInput,
          allowUnredactedImages: current.allowUnredactedImages,
          allowLoopback: current.allowLoopback,
          allowPrivateNetwork: current.allowPrivateNetwork,
        });
        if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > 65_536)
          throw new Error('permission settings exceed 65536 bytes');
        this.busy.add('desktop');
        await this.postState();
        const config = vscode.workspace.getConfiguration('agentdesklink'),
          target = vscode.ConfigurationTarget.Workspace;
        if (candidate.desktopAppId === '') {
          await config.update('desktopAppId', '', target);
          await config.update('desktopAppPath', '', target);
        } else {
          await config.update('desktopAppPath', candidate.desktopAppPath, target);
          await config.update('desktopAppId', candidate.desktopAppId, target);
        }
        this.errors.desktopNotice = checked.notes.join(' ') || undefined;
      } catch (error) {
        this.errors.desktopError = `${describePermissionError(error)} / Failed to save the desktop app: ${error instanceof Error ? error.message : String(error)}`;
        log.line(`save failed desktop app: ${String(error)}`);
      } finally {
        this.busy.delete('desktop');
      }
      await this.postState();
    });
    this.saves = saved.catch(() => {});
    return saved;
  }

  // Browse only fills the inputs of the webview; nothing is saved until the user presses Save.
  private async browseDesktopApp(): Promise<void> {
    this.errors.desktopError = undefined;
    this.errors.desktopNotice = undefined;
    if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.length) {
      this.errors.desktopError =
        '信頼できるワークスペースでのみ選択できます。 / Open a trusted workspace to choose an app.';
      await this.postState();
      return;
    }
    const platform = process.platform;
    const defaultPath =
      platform === 'darwin'
        ? '/Applications'
        : platform === 'win32'
          ? (process.env.ProgramFiles ?? 'C:\\Program Files')
          : '/usr/bin';
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: platform === 'darwin',
      defaultUri: vscode.Uri.file(defaultPath),
      openLabel: '選択 / Select',
      title: 'デスクトップアプリを選択 / Choose the desktop app',
      ...(platform === 'win32' ? { filters: { 'Applications (*.exe)': ['exe'] } } : {}),
    });
    const uri = picked?.[0];
    if (!uri) return;
    const result = await resolveDesktopSelection(uri.fsPath, platform);
    if (!result.ok) {
      this.errors.desktopError = result.message;
      await this.postState();
      return;
    }
    await this.postState();
    try {
      await this.view?.webview.postMessage({
        type: 'desktopAppPicked',
        appPath: result.pick.appPath,
        appId: result.pick.appId ?? '',
        replaceId: result.pick.replaceId,
        notes: result.pick.notes,
      });
    } catch {
      /* view gone */
    }
  }

  private saveOperationMode(mode: OperationMode | 'all'): Promise<void> {
    const saved = this.saves.then(async () => {
      this.errors.operationModeError = undefined;
      if (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders?.length) {
        this.errors.operationModeError =
          '信頼できるワークスペースでのみ変更できます。 / Open a trusted workspace to change this.';
        await this.postState();
        return;
      }
      this.busy.add('operationMode');
      await this.postState();
      try {
        await this.hooks.setOperationMode(mode);
      } catch (error) {
        this.errors.operationModeError = `権限段階を変更できませんでした。 / Could not change permission tier: ${error instanceof Error ? error.message : String(error)}`;
        log.line(`operation mode change failed: ${String(error)}`);
      } finally {
        this.busy.delete('operationMode');
        await this.postState();
      }
    });
    this.saves = saved.catch(() => {});
    return saved;
  }

  private async performSave(
    key: (typeof KEYS)[number],
    value: boolean,
    target: vscode.ConfigurationTarget,
    errorKey: 'enabledError' | 'globalError',
  ): Promise<void> {
    this.errors[errorKey] = undefined;
    const workspaceScoped = target === vscode.ConfigurationTarget.Workspace;
    if (
      workspaceScoped &&
      (!vscode.workspace.isTrusted ||
        !vscode.workspace.workspaceFolders ||
        vscode.workspace.workspaceFolders.length === 0)
    ) {
      this.errors[errorKey] =
        '信頼できるフォルダーを開いてからワークスペース設定を保存できます / Open a trusted folder to save workspace settings.';
      await this.postState();
      return;
    }
    try {
      const busyKey = this.busyKey(key);
      this.busy.add(busyKey);
      await this.postState();
      await vscode.workspace.getConfiguration('agentdesklink').update(key, value, target);
    } catch (err) {
      const text = `設定の保存に失敗しました / Failed to save setting (${key}): ${err instanceof Error ? err.message : String(err)}`;
      this.errors[errorKey] = text;
      void vscode.window.showErrorMessage(text);
      log.line(`save failed ${key}: ${String(err)}`);
    } finally {
      this.busy.delete(this.busyKey(key));
    }
    await this.postState();
  }

  private busyKey(key: (typeof KEYS)[number]): string {
    return { enabled: 'enabled', autoUpdate: 'auto', checkForUpdates: 'check' }[key];
  }

  // Stop/resume bypass the saves queue and workspace-trust checks; the thunk
  // runs synchronously inside try so even a synchronous throw lands in the
  // visible error path, before any await.
  private async runGuarded(busyKey: string, start: () => Promise<void>): Promise<void> {
    this.errors.globalError = undefined;
    this.busy.add(busyKey);
    try {
      const started = start();
      void this.postState();
      await started;
    } catch (err) {
      const text = `操作に失敗しました / Operation failed: ${err instanceof Error ? err.message : String(err)}`;
      this.errors.globalError = text;
      void vscode.window.showErrorMessage(text);
      log.line(`${busyKey} failed: ${String(err)}`);
    } finally {
      this.busy.delete(busyKey);
      await this.postState();
    }
  }

  private async checkForUpdates(): Promise<void> {
    this.busy.add('checkNow');
    await this.postState();
    try {
      await this.hooks.checkForUpdates();
    } finally {
      this.busy.delete('checkNow');
      await this.postState();
    }
  }

  async postState(): Promise<void> {
    if (!this.view) return;
    const preparing = this.hooks.refreshMcp();
    await this.publishState();
    void preparing.then(() => this.publishState()).catch(error => log.line(`MCP refresh failed: ${String(error)}`));
  }

  private async publishState(): Promise<void> {
    if (!this.view) return;
    const settings = readSettings();
    let runtime: ExtensionRuntimeSettings;
    try {
      runtime = runtimeSettings(settings);
    } catch {
      runtime = normalizeRuntimeSettings({});
      this.errors.runtimeError ??=
        '保存済みの運用設定が無効です。値を修正してください。 / Saved runtime settings are invalid. Update the values to repair them.';
    }
    const hasFolder = !!vscode.workspace.workspaceFolders?.length;
    const state = {
      type: 'state',
      settings: {
        enabled: settings.enabled,
        autoUpdate: settings.autoUpdate,
        checkForUpdates: settings.checkForUpdates,
        browserOrigins: settings.browserOrigins,
        browserResourceOrigins: settings.browserResourceOrigins,
        allowLoopback: settings.allowLoopback,
        allowPrivateNetwork: settings.allowPrivateNetwork,
        allowPersonalData: settings.allowPersonalData,
        sessionIdleMinutes: runtime.sessionTtlMs / 60_000,
        browserHeadless: runtime.browserHeadless,
        // Normalize first: credentials or malformed URL components are never sent to the webview.
        browserProxyServer: runtime.browserProxyServer,
        browserProxyConnectByHostname: settings.browserProxyConnectByHostname === true,
        desktopAppId: settings.desktopAppId,
        desktopAppPath: settings.desktopAppPath,
        allowPhysicalInput: settings.allowPhysicalInput,
        allowUnredactedImages: settings.allowUnredactedImages,
        operationMode: settings.operationMode,
      },
      platform: process.platform,
      browser: this.hooks.browserSetup(),
      stopped: this.hooks.operationsStopped(),
      trusted: vscode.workspace.isTrusted,
      hasFolder,
      permissions: this.hooks.permissions(),
      clients: this.hooks.clientState(),
      busy: Object.fromEntries(
        [
          'enabled',
          'auto',
          'check',
          'checkNow',
          'stop',
          'resume',
          'clients',
          'origins',
          'runtime',
          'operationMode',
          'desktop',
          'browser',
        ].map(k => [k, this.busy.has(k)]),
      ),
      status: {
        version: this.hooks.version(),
        mcp: this.hooks.mcpStatus(),
        mcpError: this.hooks.mcpError(),
        update: this.hooks.updateStatus(),
        enabledError: this.errors.enabledError ?? '',
        originsError: this.errors.originsError ?? '',
        runtimeError: this.errors.runtimeError ?? '',
        operationModeError: this.errors.operationModeError ?? '',
        desktopError: this.errors.desktopError ?? '',
        desktopNotice: this.errors.desktopNotice ?? '',
        globalError: this.errors.globalError ?? '',
      },
    };
    try {
      await this.view.webview.postMessage(state);
    } catch {
      /* view gone */
    }
  }
}
