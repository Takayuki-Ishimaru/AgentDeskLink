import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { readSettings, log, type PermissionSummary } from './shared.js';
import type { ClientRow } from './client-manager.js';

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
  clientState(): { rows: ClientRow[]; busy: boolean; error: string; owner: string };
  refreshClients(): Promise<void>;
  setAllClientsEnabled(enabled: boolean): Promise<void>;
}

const KEYS = ['enabled', 'autoUpdate', 'checkForUpdates'] as const;

export class SettingsPanelProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly busy = new Set<string>();
  private saves = Promise.resolve();
  private errors: { enabledError?: string; globalError?: string } = {};

  constructor(private readonly extUri: vscode.Uri, private readonly hooks: PanelHooks) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'media')] };
    view.webview.html = this.html(view.webview);
    this.disposables.push(view.webview.onDidReceiveMessage((msg: unknown) => this.handle(msg)));
    this.disposables.push(view.onDidDispose(() => { if (this.view === view) this.view = undefined; }));
    void this.postState();
  }

  async refresh(): Promise<void> { await this.postState(); }
  dispose(): void { this.view = undefined; this.disposables.splice(0).forEach(d => d.dispose()); }

  private html(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', 'settings.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', 'settings.js'));
    const brand = webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', 'brand-mark.png'));
    return `<!DOCTYPE html><html lang="ja"><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>AgentDeskLink</title></head><body>
<header class="header-row"><div class="title-group"><img class="brand-mark" src="${brand}" alt="" width="32" height="32"><h2>AgentDeskLink</h2></div><span class="version" id="version"></span></header>
<p class="hint intro">ブラウザとデスクトップを、必要な範囲で。</p>
<p class="hint">Nodeとhelperは同梱済みです。Chromeを自動検出し、なければ初回に専用Chromiumを取得します。</p>
<section class="section" aria-labelledby="workspace-title">
  <h3 id="workspace-title">このワークスペース</h3>
  <div class="actions emergency-row"><button id="emergency-stop" class="danger" title="実行中の操作をただちに停止します">緊急停止</button><button id="resume-operations" class="secondary" hidden>操作を再開</button></div>
  <p class="status" id="stopped-status" role="status" hidden>操作を緊急停止中です。再開するには「操作を再開」を押してください。</p>
  <div class="row"><label class="check"><input type="checkbox" id="enabled"><span>このワークスペースで MCP を有効にする</span></label></div>
  <p class="hint" id="enabled-hint">変更はこのワークスペースに保存されます。</p>
  <h4 class="perm-title">現在の実効権限 / Effective permissions</h4>
  <ul class="permissions" id="permissions"></ul>
  <p class="hint" id="permissions-hint"></p>
  <p class="error" id="enabled-error" role="alert"></p>
  <p class="status" id="mcp-status" role="status"></p>
  <p class="error" id="mcp-error" role="alert"></p>
</section>
<section class="section" aria-labelledby="clients-title">
  <h3 id="clients-title">AIクライアント</h3>
  <p class="hint">インストール済みのクライアントを自動検出します。一括有効で、このワークスペースの権限を共有します。</p>
  <div class="actions"><button id="clients-enable">すべて有効</button><button id="clients-disable" class="secondary">すべて無効</button><button id="clients-refresh" class="secondary">再検出</button></div>
  <ul class="client-list" id="clients-list" aria-label="AIクライアントの登録状態"></ul>
  <p class="status" id="clients-status" role="status"></p>
  <p class="error" id="clients-error" role="alert"></p>
  <p class="hint">反映には各クライアントでの再接続・新しい会話・再起動が必要な場合があります。同名の手動設定は保持します。最後に一括有効にしたワークスペースが接続を管理します。</p>
</section>
<section class="section" aria-labelledby="updates-title">
  <h3 id="updates-title">拡張機能の更新</h3>
  <p class="hint">すべてのワークスペースに適用されます。</p>
  <div class="row"><label class="check"><input type="checkbox" id="auto-update"><span>自動更新を有効にする</span></label></div>
  <div class="row"><label class="check"><input type="checkbox" id="check-updates"><span>新しいバージョンを確認する</span></label></div>
  <p class="hint">起動後と6時間ごとに確認します。更新の反映には VS Code の再読み込みが必要です。</p>
  <p class="status" id="update-status" role="status"></p>
  <div class="actions"><button id="check-now" class="secondary">今すぐ確認</button></div>
</section>
<p class="hint">更新元は GitHub の公式リポジトリ（<span id="update-source">Takayuki-Ishimaru/AgentDeskLink</span>）に固定されています。設定は不要です。</p>
<section class="section support">
  <div class="actions"><button id="open-logs" class="secondary">ログを開く</button><button id="open-settings" class="secondary">設定を開く / Open Settings</button></div>
  <p class="error" id="global-error" role="alert"></p>
</section>
<script nonce="${nonce}" src="${js}"></script>
</body></html>`;
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
        if (typeof m.enabled === 'boolean') return this.save('enabled', m.enabled, vscode.ConfigurationTarget.Workspace, 'enabledError');
        return Promise.resolve();
      case 'setAutoUpdate':
      case 'setCheckForUpdates': {
        const key = m.type === 'setAutoUpdate' ? 'autoUpdate' : 'checkForUpdates';
        if (typeof m.enabled === 'boolean') return this.save(key, m.enabled, vscode.ConfigurationTarget.Global, 'globalError');
        return Promise.resolve();
      }
      case 'emergencyStop': return this.runGuarded('stop', () => this.hooks.emergencyStop());
      case 'resumeOperations': return this.runGuarded('resume', () => this.hooks.resumeOperations());
      case 'enableAllClients': return this.saveClients(true);
      case 'disableAllClients': return this.saveClients(false);
      case 'refreshClients': return this.runGuarded('clients', () => this.hooks.refreshClients());
      case 'checkForUpdates': return this.checkForUpdates();
      case 'openLogs': this.hooks.openLogs(); return Promise.resolve();
      case 'openWorkspaceSettings': this.hooks.openWorkspaceSettings(); return Promise.resolve();
      case 'ready': return this.postState();
      default: return Promise.resolve();
    }
  }

  private save(key: typeof KEYS[number], value: boolean, target: vscode.ConfigurationTarget, errorKey: 'enabledError' | 'globalError'): Promise<void> {
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

  private async performSave(key: typeof KEYS[number], value: boolean, target: vscode.ConfigurationTarget, errorKey: 'enabledError' | 'globalError'): Promise<void> {
    this.errors[errorKey] = undefined;
    const workspaceScoped = target === vscode.ConfigurationTarget.Workspace;
    if (workspaceScoped && (!vscode.workspace.isTrusted || !vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0)) {
      this.errors[errorKey] = '信頼できるフォルダーを開いてからワークスペース設定を保存できます / Open a trusted folder to save workspace settings.';
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

  private busyKey(key: typeof KEYS[number]): string {
    return ({ enabled: 'enabled', autoUpdate: 'auto', checkForUpdates: 'check' })[key];
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
    }
    catch (err) {
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
    try { await this.hooks.checkForUpdates(); }
    finally { this.busy.delete('checkNow'); await this.postState(); }
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
    const hasFolder = !!vscode.workspace.workspaceFolders?.length;
    const state = {
      type: 'state',
      settings: {
        enabled: settings.enabled,
        autoUpdate: settings.autoUpdate,
        checkForUpdates: settings.checkForUpdates,
      },
      stopped: this.hooks.operationsStopped(),
      trusted: vscode.workspace.isTrusted,
      hasFolder,
      permissions: this.hooks.permissions(),
      clients: this.hooks.clientState(),
      busy: Object.fromEntries(['enabled', 'auto', 'check', 'checkNow', 'stop', 'resume', 'clients'].map(k => [k, this.busy.has(k)])),
      status: {
        version: this.hooks.version(),
        mcp: this.hooks.mcpStatus(),
        mcpError: this.hooks.mcpError(),
        update: this.hooks.updateStatus(),
        enabledError: this.errors.enabledError ?? '',
        globalError: this.errors.globalError ?? '',
      },
    };
    try { await this.view.webview.postMessage(state); } catch { /* view gone */ }

  }
}
