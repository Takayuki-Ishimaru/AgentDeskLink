import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { gt } from 'semver';
import { readSettings, log } from './shared.js';
import { fetchUpdateBytes } from './update-download.js';
import { GITHUB_RELEASES_URL, findGitHubUpdate, isGitHubUpdateUrl } from './update-source.js';

export class UpdateChecker {
  private current?: { promise: Promise<void>; controller: AbortController };
  private installedVersion?: string;
  private statusText?: string;
  private timer?: ReturnType<typeof setInterval>;
  private startup?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private retry?: Promise<void>;
  private lastNotified?: string;
  constructor(private readonly extVersion: string, private readonly onChanged: () => void) {}

  status(): string {
    if (this.installedVersion) return `v${this.installedVersion} に更新済みです。再読み込みすると反映されます。`;
    if (!readSettings().checkForUpdates) return '更新確認は無効です。';
    return this.statusText ?? 'GitHub を起動後と6時間ごとに確認します。';
  }

  start(): void {
    this.startup = setTimeout(() => { void this.check(false); }, 5_000);
    this.timer = setInterval(() => { void this.check(false); }, 6 * 60 * 60 * 1000);
    this.startup.unref?.(); this.timer.unref?.();
  }
  cancel(): void {
    // Keep the promise until it settles: a second check must not overlap an install.
    this.current?.controller.abort();
    this.statusText = undefined;
  }
  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer); clearTimeout(this.startup);
    this.cancel();
  }
  check(manual: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.current) {
      // A cancelled run must not swallow a later explicit request: chain exactly one
      // replacement behind it, so an install can never overlap another check.
      if (manual && this.current.controller.signal.aborted) return this.queueRetry();
      return this.current.promise;
    }
    const controller = new AbortController();
    const promise = this.run(manual, controller.signal).finally(() => {
      if (this.current?.promise === promise) this.current = undefined;
    });
    this.current = { promise, controller };
    return promise;
  }
  private queueRetry(): Promise<void> {
    if (this.retry) return this.retry;
    const previous = this.current?.promise ?? Promise.resolve();
    const retry = previous.then(() => {
      if (this.retry === retry) this.retry = undefined;
      // Automatic and disabled checks never restart cancelled work.
      if (this.disposed || this.current || !readSettings().checkForUpdates) return;
      return this.check(true);
    });
    this.retry = retry;
    return retry;
  }

  private setStatus(text: string): void {
    this.statusText = text;
    log.line(text);
    this.onChanged();
  }
  private async run(manual: boolean, signal: AbortSignal): Promise<void> {
    const settings = readSettings();
    if (!settings.checkForUpdates || this.installedVersion) { this.onChanged(); return; }
    const active = () => {
      const now = readSettings();
      return !signal.aborted && !this.disposed && now.checkForUpdates && now.autoUpdate === settings.autoUpdate;
    };
    try {
      this.setStatus('更新を確認しています…');
      const bytes = await fetchUpdateBytes(GITHUB_RELEASES_URL, { maxBytes: 1024 * 1024, timeoutMs: 15_000, signal, isAllowedUrl: isGitHubUpdateUrl });
      if (!active()) return;
      const update = findGitHubUpdate(JSON.parse(bytes.toString('utf8')), process.platform, process.arch);
      if (!update) { this.setStatus('この OS・CPU に対応する更新はありません。'); return; }
      if (!gt(update.version, this.extVersion)) { this.setStatus(`最新のバージョンです（v${this.extVersion}）。`); return; }
      if (!settings.autoUpdate) {
        this.setStatus(`v${update.version} が利用可能です。自動更新は無効です。`);
        if (manual || this.lastNotified !== update.version) {
          this.lastNotified = update.version;
          void vscode.window.showInformationMessage(`AgentDeskLink v${update.version} が利用可能です。自動更新を有効にするとインストールできます。`);
        }
        return;
      }
      this.setStatus(`v${update.version} をダウンロードしています…`);
      // The VSIX bundles Node and the native helper dependencies, so allow the complete platform package.
      const download = await fetchUpdateBytes(update.url, { maxBytes: 512 * 1024 * 1024, timeoutMs: 300_000, signal, isAllowedUrl: isGitHubUpdateUrl });
      if (!active()) return;
      if (createHash('sha256').update(download).digest('hex') !== update.sha256) throw new Error('ダウンロードの SHA-256 が一致しません。');
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentdesklink-update-'));
      try {
        const file = path.join(directory, 'agentdesklink.vsix');
        await fs.writeFile(file, download, { mode: 0o600 });
        if (!active()) return;
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
        this.installedVersion = update.version;
        this.setStatus(`v${update.version} に更新しました。再読み込みすると反映されます。`);
        if (!this.disposed) {
          const button = '再読み込み';
          const pick = await vscode.window.showInformationMessage(`AgentDeskLink v${update.version} に更新しました。`, button);
          if (pick === button && !this.disposed) await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    } catch (error) {
      if (!active()) return;
      this.setStatus('GitHub から更新を確認できませんでした。時間をおいて再度お試しください。');
      log.line(`update failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      if (manual) void vscode.window.showWarningMessage(this.statusText!);
    }
  }
}
