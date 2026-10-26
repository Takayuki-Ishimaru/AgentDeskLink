import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { detectClients, inspectClient, configureClient, type DetectOptions, type ClientInfo, type ClientResult, type Registration } from './ai-clients.js';
import { readManagedDescriptor, writeManagedDescriptor, writeManagedLauncher, type ManagedLaunchDescriptor } from './client-launcher.js';

export interface ClientLaunch { command: string; args: string[]; env: Record<string, string>; cwd: string }
export interface ClientManagerOptions {
  storageDir: string;
  owner: string;
  detectOptions?: DetectOptions;
  canEnable(): boolean;
  getLaunch(): Promise<ClientLaunch | undefined>;
  changed?(): void;
}
export interface ClientRow extends ClientInfo { status: ClientResult['status'] | 'not-detected'; message: string }

// External clients share one explicitly selected workspace. Opening another window
// never takes over its grants; the bulk-enable action is the ownership boundary.
export class AiClientManager {
  private readonly launcherPath: string;
  private readonly descriptorPath: string;
  private readonly nodePath: string;
  private queue = Promise.resolve();
  private revision = 0;
  private disposed = false;
  private results = new Map<string, ClientResult>();
  private clients: ClientInfo[] = [];
  error = '';
  busy = false;

  constructor(private readonly options: ClientManagerOptions) {
    const dir = path.join(options.storageDir, 'ai-clients');
    this.launcherPath = path.join(dir, 'launcher.cjs');
    this.descriptorPath = path.join(dir, 'launch.json');
    this.nodePath = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    this.detect();
  }

  private registration(): Registration { return { command: this.nodePath, args: [this.launcherPath, this.descriptorPath] }; }

  detect(): void {
    this.results.clear();
    this.clients = detectClients(this.options.detectOptions);
    this.options.changed?.();
  }

  rows(): ClientRow[] {
    return this.clients.map(client => {
      if (!client.detected) return { ...client, status: 'not-detected', message: '未検出 / Not detected' };
      const result = this.results.get(client.id) ?? inspectClient(client, this.registration());
      return { ...client, status: result.status, message: result.message };
    });
  }

  owner(): string | undefined { return readManagedDescriptor(this.descriptorPath)?.owner; }

  // Runs before asynchronous preparation or config writes, so a failed cleanup
  // still revokes connected clients and old saved launch commands.
  revoke(allOwners = false): void {
    this.revision++;
    const previous = readManagedDescriptor(this.descriptorPath);
    if (previous && (previous.owner === this.options.owner || allOwners)) {
      writeManagedDescriptor(this.descriptorPath, { ...previous, enabled: false, generation: randomUUID() });
    }
  }

  sync(enabled: boolean, takeOwnership = false): Promise<void> {
    try { this.revoke(takeOwnership); } catch (error) { this.error = this.message(error); return Promise.resolve(); }
    const revision = this.revision;
    const next = this.queue.then(() => this.performSync(enabled, takeOwnership, revision));
    this.queue = next.catch(error => { this.error = this.message(error); this.options.changed?.(); });
    return this.queue;
  }

  private current(revision: number): boolean { return !this.disposed && revision === this.revision; }

  private ensureNode(source: string): void {
    const { launcherPath, descriptorPath } = writeManagedLauncher(this.options.storageDir);
    if (launcherPath !== this.launcherPath || descriptorPath !== this.descriptorPath) throw new Error('Invalid managed launcher paths');
    // Keep the command stable across VSIX version-directory changes.
    const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (fs.existsSync(this.nodePath)) {
      const stat = fs.lstatSync(this.nodePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid managed Node runtime');
      if (digest(this.nodePath) === digest(source)) return;
    }
    const temporary = `${this.nodePath}.${randomUUID()}.tmp`;
    try {
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
      fs.chmodSync(temporary, 0o700);
      fs.renameSync(temporary, this.nodePath);
    } finally { try { fs.unlinkSync(temporary); } catch { /* already renamed */ } }
  }

  private async performSync(enabled: boolean, takeOwnership: boolean, revision: number): Promise<void> {
    if (!this.current(revision)) return;
    this.busy = true;
    this.error = '';
    this.results.clear();
    this.options.changed?.();
    try {
      this.detect();
      const previous = readManagedDescriptor(this.descriptorPath);
      if (previous && previous.owner !== this.options.owner && !takeOwnership) {
        this.error = '他のワークスペースがAIクライアントの接続を管理しています。一括有効で切り替えられます。';
        return;
      }
      if (enabled) {
        if (!this.options.canEnable()) throw new Error('信頼できるフォルダーで MCP を有効にしてください。');
        // Reserve ownership before slow runtime/browser preparation. Another
        // window's later enable/disable invalidates this exact reservation.
        const claim: ManagedLaunchDescriptor = { schemaVersion: 1, owner: this.options.owner, generation: randomUUID(),
          enabled: false, command: process.execPath, args: [], env: {}, cwd: path.resolve(this.options.storageDir) };
        writeManagedDescriptor(this.descriptorPath, claim);
        const launch = await this.options.getLaunch();
        if (!this.current(revision) || !this.options.canEnable()) return;
        if (readManagedDescriptor(this.descriptorPath)?.generation !== claim.generation) return;
        if (!launch) throw new Error('MCP の準備が完了していません。設定と緊急停止の状態を確認してください。');
        this.ensureNode(launch.command);
        const descriptor: ManagedLaunchDescriptor = { ...claim, generation: randomUUID(), enabled: true, ...launch };
        writeManagedDescriptor(this.descriptorPath, descriptor);
      }
      if (!this.current(revision)) return;
      // Disable also visits previously known paths when an app was uninstalled.
      for (const client of this.clients) {
        if (!this.current(revision)) break;
        if (!client.detected && enabled) continue;
        const result = configureClient(client, this.registration(), enabled);
        if (client.detected || result.status === 'error' || result.status === 'conflict') this.results.set(client.id, result);
      }
    } catch (error) { this.error = this.message(error); }
    finally { this.busy = false; this.options.changed?.(); }
  }

  private message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  dispose(): void { this.disposed = true; this.revision++; }
}
