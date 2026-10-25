import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { gt, valid } from 'semver';
import { readSettings, log } from './shared.js';
import { fetchUpdateBytes, isHttpsUrl } from './update-download.js';

interface Manifest { version: string; url: string; sha256: string }
function parseManifest(bytes: Buffer): Manifest {
  const data: unknown = JSON.parse(bytes.toString('utf8'));
  if (typeof data !== 'object' || !data || Array.isArray(data)) throw new Error('更新情報の形式が不正です。');
  const d = data as Record<string, unknown>;
  if (typeof d.version !== 'string' || !valid(d.version) || typeof d.url !== 'string' || !isHttpsUrl(d.url) ||
      typeof d.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(d.sha256)) throw new Error('更新情報のバージョン・URL・SHA-256 を確認してください。');
  return { version: d.version, url: d.url, sha256: d.sha256.toLowerCase() };
}

export class UpdateChecker {
  private current?: { promise: Promise<void>; controller: AbortController };
  private installedVersion?: string;
  private statusText?: string;
  private timer?: ReturnType<typeof setInterval>;
  private startup?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private lastNotified?: string;
  constructor(private readonly extVersion: string, private readonly onChanged: () => void) {}

  status(): string {
    if (this.installedVersion) return `v${this.installedVersion} に更新済みです。再読み込みすると反映されます。`;
    const settings = readSettings();
    if (!settings.checkForUpdates) return '更新確認は無効です。';
    if (!settings.updateManifestUrl.trim()) return '更新先未設定。GitHub 公開後に URL を指定してください。';
    return this.statusText ?? '起動後と6時間ごとに更新を確認します。';
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
    if (this.current) return this.current.promise;
    const controller = new AbortController();
    const promise = this.run(manual, controller.signal).finally(() => {
      if (this.current?.promise === promise) this.current = undefined;
    });
    this.current = { promise, controller };
    return promise;
  }
  private setStatus(text: string): void {
    this.statusText = text;
    log.line(text);
    this.onChanged();
  }
  private async run(manual: boolean, signal: AbortSignal): Promise<void> {
    const settings = readSettings();
    const url = settings.updateManifestUrl.trim();
    if (!settings.checkForUpdates || !url || this.installedVersion) { this.onChanged(); return; }
    const active = () => {
      const now = readSettings();
      return !signal.aborted && !this.disposed && now.checkForUpdates && now.autoUpdate === settings.autoUpdate && now.updateManifestUrl.trim() === url;
    };
    try {
      if (!isHttpsUrl(url)) throw new Error('更新先は認証情報を含まない HTTPS URL を指定してください。');
      this.setStatus('更新を確認しています…');
      const bytes = await fetchUpdateBytes(url, { maxBytes: 1024 * 1024, timeoutMs: 15_000, signal });
      if (!active()) return;
      const manifest = parseManifest(bytes);
      if (!gt(manifest.version, this.extVersion)) { this.setStatus(`最新のバージョンです（v${this.extVersion}）。`); return; }
      if (!settings.autoUpdate) {
        this.setStatus(`v${manifest.version} が利用可能です。自動更新は無効です。`);
        if (manual || this.lastNotified !== manifest.version) {
          this.lastNotified = manifest.version;
          void vscode.window.showInformationMessage(`AgentDeskLink v${manifest.version} が利用可能です。自動更新を有効にするとインストールできます。`);
        }
        return;
      }
      this.setStatus(`v${manifest.version} をダウンロードしています…`);
      // The VSIX includes Chromium and Node, so allow the complete platform bundle.
      const download = await fetchUpdateBytes(manifest.url, { maxBytes: 512 * 1024 * 1024, timeoutMs: 300_000, signal });
      if (!active()) return;
      if (createHash('sha256').update(download).digest('hex') !== manifest.sha256) throw new Error('ダウンロードの SHA-256 が一致しません。');
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentdesklink-update-'));
      try {
        const file = path.join(directory, 'agentdesklink.vsix');
        await fs.writeFile(file, download, { mode: 0o600 });
        if (!active()) return;
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file));
        this.installedVersion = manifest.version;
        this.setStatus(`v${manifest.version} に更新しました。再読み込みすると反映されます。`);
        if (!this.disposed) {
          const button = '再読み込み';
          const pick = await vscode.window.showInformationMessage(`AgentDeskLink v${manifest.version} に更新しました。`, button);
          if (pick === button && !this.disposed) await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    } catch (error) {
      if (!active()) return;
      this.setStatus('更新を確認できませんでした。URL と配信ファイルを確認してください。');
      log.line(`update failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      if (manual) void vscode.window.showWarningMessage(this.statusText!);
    }
  }
}
