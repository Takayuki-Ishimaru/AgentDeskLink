import * as http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as vscode from 'vscode';
import { redactApprovalText } from '../approval-summary.js';

type Status = 'pending' | 'approved' | 'denied' | 'expired' | 'consumed' | 'invalidated';
type Summary = {
  action: string;
  surface: 'browser' | 'desktop';
  target: string;
  origin?: string;
  application?: string;
  role?: string;
  name?: string;
  risk: 'consequential' | 'credential';
  value?: { kind: 'public' | 'secret'; preview?: string; length: number };
  details?: string[];
};
type Entry = {
  id: string;
  serverId: string;
  epoch: string;
  binding: string;
  expiresAt: number;
  summary: Summary;
  status: Status;
  generation: number;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BINDING = /^[0-9a-f]{64}$/i;
const APPROVE_LABEL = 'Approve once / 今回のみ許可';
const DENY_LABEL = 'Deny (same as Cancel/Esc) / 拒否（キャンセル・Escも同じ）';
const DIALOG_NOTE =
  'Approve once allows only this single action. Deny, Cancel, closing this dialog and Esc all deny it, and nothing is sent. / 「今回のみ許可」はこの1回の操作だけを許可します。「拒否」・キャンセル・ダイアログを閉じる・Escはすべて拒否となり、何も送信されません。';
// Untrusted text is shown as-is, except characters that could fake dialog structure or reorder text (line breaks, C0/C1 controls, bidi marks, overrides and isolates), which become visible escapes.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
export function visibleText(text: string): string {
  return text.replace(UNSAFE_TEXT, char =>
    char === '\n'
      ? '\\n'
      : char === '\r'
        ? '\\r'
        : char === '\t'
          ? '\\t'
          : `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** Loopback capability broker. A request can only be approved by the VS Code host modal. */
export class ApprovalBroker implements vscode.Disposable {
  private readonly server: http.Server;
  private token = randomBytes(32).toString('base64url');
  private readonly entries = new Map<string, Entry>();
  private readonly serverIds = new Set<string>();
  private decisionQueue = Promise.resolve();
  private port = 0;
  private generation = 0;
  private epoch = '';
  private disposed = false;
  // allowedApplications: the configured desktop application ids (normally one). A desktop summary naming any other application is refused.
  private constructor(
    private readonly contextCurrent: () => boolean,
    private readonly ownerLabel: () => string,
    private readonly allowedOrigins: () => string[],
    private readonly allowedApplications: () => string[],
  ) {
    this.server = http.createServer(
      (req, res) => void this.handle(req, res).catch(() => this.reply(res, 400, { error: 'invalid request' })),
    );
    this.server.maxHeadersCount = 32;
    this.server.requestTimeout = 5_000;
  }
  static async create(
    contextCurrent: () => boolean,
    ownerLabel: () => string,
    allowedOrigins: () => string[],
    allowedApplications: () => string[] = () => [],
  ): Promise<ApprovalBroker> {
    const broker = new ApprovalBroker(contextCurrent, ownerLabel, allowedOrigins, allowedApplications);
    await new Promise<void>((resolve, reject) => {
      broker.server.once('error', reject);
      broker.server.listen(0, '127.0.0.1', () => {
        broker.server.off('error', reject);
        const address = broker.server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('approval broker failed to bind'));
          return;
        }
        broker.port = address.port;
        resolve();
      });
    });
    return broker;
  }
  /** Pass these values only to the extension-managed MCP child process. */
  env(epoch: string): Record<string, string> {
    this.epoch = epoch;
    return {
      ADL_APPROVAL_URL: `http://127.0.0.1:${this.port}`,
      ADL_APPROVAL_TOKEN: this.token,
      ADL_APPROVAL_EPOCH: epoch,
    };
  }
  /** Revoke every outstanding request before changing trust, owner, grants, or operation control. */
  revoke(epoch?: string): void {
    this.generation++;
    this.token = randomBytes(32).toString('base64url');
    this.serverIds.clear();
    if (epoch) this.epoch = epoch;
    for (const entry of this.entries.values())
      if (entry.status === 'pending' || entry.status === 'approved') entry.status = 'invalidated';
    this.prune();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revoke();
    this.server.close();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const address = this.server.address();
    const expectedHost = typeof address === 'object' && address ? `127.0.0.1:${address.port}` : '';
    if (this.disposed || req.headers.host !== expectedHost || req.headers.origin !== undefined || !this.authorized(req))
      return this.reply(res, 403, { error: 'forbidden' });
    const url = new URL(req.url ?? '/', `http://${expectedHost}`);
    if (url.search || url.hash) return this.reply(res, 400, { error: 'invalid request' });
    if (req.method === 'POST' && url.pathname === '/v1/requests') {
      const body = await this.readBody(req);
      if (!body) return this.reply(res, 400, { error: 'invalid request' });
      const entry = this.parseEntry(body);
      if (!entry) return this.reply(res, 400, { error: 'invalid request' });
      if (entry.epoch !== this.epoch || !this.contextCurrent()) return this.reply(res, 409, { error: 'stale context' });
      this.prune();
      const prior = this.entries.get(entry.id);
      if (prior) {
        if (prior.binding !== entry.binding || prior.serverId !== entry.serverId)
          return this.reply(res, 409, { error: 'conflict' });
        return this.reply(res, 200, this.response(prior));
      }
      if (!this.serverIds.has(entry.serverId) && this.serverIds.size >= 16)
        return this.reply(res, 429, { error: 'server limit' });
      if (
        this.entries.size >= 1024 ||
        [...this.entries.values()].filter(x => x.status === 'pending').length >= 16 ||
        [...this.entries.values()].filter(x => x.serverId === entry.serverId && x.status === 'pending').length >= 8
      )
        return this.reply(res, 429, { error: 'limit' });
      entry.generation = this.generation;
      this.serverIds.add(entry.serverId);
      this.entries.set(entry.id, entry);
      this.reply(res, 201, this.response(entry));
      this.decisionQueue = this.decisionQueue
        .then(() => this.decide(entry))
        .catch(() => {
          if (entry.status === 'pending') entry.status = 'denied';
        });
      return;
    }
    const match = /^\/v1\/requests\/([0-9a-f-]{36})$/i.exec(url.pathname);
    if (!match || !UUID.test(match[1]!)) return this.reply(res, 404, { error: 'not found' });
    const entry = this.entries.get(match[1]!);
    if (!entry) return this.reply(res, 404, { error: 'not found' });
    if (req.method === 'GET') {
      this.expire(entry);
      return this.reply(res, 200, this.response(entry));
    }
    if (req.method === 'DELETE') {
      this.expire(entry);
      let consumedNow = false;
      if (
        entry.status === 'approved' &&
        entry.epoch === this.epoch &&
        entry.generation === this.generation &&
        this.contextCurrent()
      ) {
        entry.status = 'consumed';
        consumedNow = true;
      } else if (entry.status === 'pending') entry.status = 'invalidated';
      return this.reply(res, 200, { ...this.response(entry), consumed_now: consumedNow });
    }
    res.setHeader('Allow', 'GET, POST, DELETE');
    return this.reply(res, 405, { error: 'method not allowed' });
  }
  private authorized(req: http.IncomingMessage): boolean {
    const raw = req.headers.authorization;
    if (typeof raw !== 'string' || !raw.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(raw.slice(7));
    const expected = Buffer.from(this.token);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
  private async readBody(req: http.IncomingMessage): Promise<unknown | undefined> {
    if (
      req.headers['content-type'] !== 'application/json' ||
      req.headers['transfer-encoding'] ||
      !/^\d+$/.test(String(req.headers['content-length'] ?? ''))
    )
      return undefined;
    const declared = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(declared) || declared > 65_536) return undefined;
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      for await (const chunk of req) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += b.length;
        if (length > 65_536) return undefined;
        chunks.push(b);
      }
    } catch {
      return undefined;
    }
    if (length !== declared) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return undefined;
    }
  }
  private parseEntry(v: unknown): Entry | undefined {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return;
    const x = v as Record<string, unknown>;
    if (
      !this.onlyKeys(x, ['v', 'request_id', 'server_id', 'control_epoch', 'binding', 'expires_at', 'summary']) ||
      x.v !== 1 ||
      typeof x.request_id !== 'string' ||
      !UUID.test(x.request_id) ||
      typeof x.server_id !== 'string' ||
      !UUID.test(x.server_id) ||
      typeof x.control_epoch !== 'string' ||
      !UUID.test(x.control_epoch) ||
      typeof x.binding !== 'string' ||
      !BINDING.test(x.binding) ||
      typeof x.expires_at !== 'number' ||
      !Number.isSafeInteger(x.expires_at) ||
      x.expires_at <= Date.now() ||
      x.expires_at > Date.now() + 120_000
    )
      return;
    const s = x.summary;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return;
    const q = s as Record<string, unknown>;
    if (
      !this.onlyKeys(q, [
        'action',
        'surface',
        'target',
        'origin',
        'application',
        'role',
        'name',
        'risk',
        'value',
        'details',
      ]) ||
      Buffer.byteLength(JSON.stringify(q), 'utf8') > 8192
    )
      return;
    const str = (key: string, max: number, required = false): string | undefined => {
      const value = q[key];
      if (value === undefined && !required) return undefined;
      if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) return;
      return value;
    };
    const desktop = q.surface === 'desktop';
    // A browser summary names exactly one granted http origin; a desktop summary names exactly the configured application plus the control's role and name, and is never a credential action.
    const action = str('action', 64, true),
      target = str('target', 256, true),
      origin = str('origin', 256, !desktop),
      application = str('application', 128, desktop),
      role = str('role', 100, desktop),
      name = str('name', 128, desktop);
    if (
      !action ||
      !target ||
      (q.surface !== 'browser' && !desktop) ||
      !['consequential', 'credential'].includes(String(q.risk))
    )
      return;
    if (desktop) {
      if (
        !application ||
        origin !== undefined ||
        Object.hasOwn(q, 'origin') ||
        role === undefined ||
        name === undefined ||
        q.risk !== 'consequential' ||
        !this.allowedApplications().includes(application)
      )
        return;
    } else {
      if (!origin || Object.hasOwn(q, 'application')) return;
      try {
        const u = new URL(origin);
        if (
          !['http:', 'https:'].includes(u.protocol) ||
          u.origin !== origin ||
          u.username ||
          u.password ||
          !this.allowedOrigins().includes(origin)
        )
          return;
      } catch {
        return;
      }
    }
    for (const key of ['role', 'name']) if (Object.hasOwn(q, key) && typeof q[key] !== 'string') return;
    const details = q.details;
    if (
      details !== undefined &&
      (!Array.isArray(details) ||
        details.length > 25 ||
        details.some(d => typeof d !== 'string' || d.length > 8192 || d.includes('\0')))
    )
      return;
    let value: Summary['value'];
    if (q.value !== undefined) {
      if (!q.value || typeof q.value !== 'object' || Array.isArray(q.value)) return;
      const z = q.value as Record<string, unknown>;
      if (
        !this.onlyKeys(z, ['kind', 'length', 'preview']) ||
        !['secret', 'public'].includes(String(z.kind)) ||
        !Number.isSafeInteger(z.length) ||
        Number(z.length) < 0 ||
        Number(z.length) > 1_000_000
      )
        return;
      const preview = z.preview;
      if (z.kind === 'secret' && preview !== undefined) return;
      if (z.kind === 'public' && typeof preview !== 'string') return;
      if (preview !== undefined && (typeof preview !== 'string' || preview.length > 4_096 || preview.includes('\0')))
        return;
      value = {
        kind: z.kind as 'secret' | 'public',
        length: Number(z.length),
        ...(typeof preview === 'string' ? { preview: redactApprovalText(preview) } : {}),
      };
    }
    const safeDetails = Array.isArray(details) ? details.map(line => redactApprovalText(line, 8192)) : undefined;
    const summary: Summary = {
      action: redactApprovalText(action),
      target: redactApprovalText(target),
      surface: desktop ? 'desktop' : 'browser',
      risk: q.risk as Summary['risk'],
      ...(origin !== undefined ? { origin: redactApprovalText(origin, 256) } : {}),
      ...(application !== undefined ? { application: redactApprovalText(application, 128) } : {}),
      ...(role ? { role: redactApprovalText(role, 100) } : {}),
      ...(name ? { name: redactApprovalText(name, 128) } : {}),
      ...(value ? { value } : {}),
      ...(safeDetails ? { details: safeDetails } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(summary), 'utf8') > 8_192) return;
    return {
      id: x.request_id,
      serverId: x.server_id,
      epoch: x.control_epoch,
      binding: x.binding,
      expiresAt: x.expires_at,
      summary,
      status: 'pending',
      generation: this.generation,
    };
  }
  private async decide(entry: Entry): Promise<void> {
    if (entry.status !== 'pending') return;
    this.expire(entry);
    const desktop = entry.summary.surface === 'desktop';
    const granted = desktop
      ? this.allowedApplications().includes(entry.summary.application ?? '')
      : this.allowedOrigins().includes(entry.summary.origin ?? '');
    if (
      entry.status !== 'pending' ||
      entry.epoch !== this.epoch ||
      entry.generation !== this.generation ||
      !this.contextCurrent() ||
      !granted
    ) {
      if (entry.status === 'pending') entry.status = 'invalidated';
      return;
    }
    const approve: vscode.MessageItem = { title: APPROVE_LABEL };
    // VS Code adds its own Cancel to a modal unless an item is the close affordance; making Deny that item keeps one denying button and makes Esc/close explicit.
    const deny: vscode.MessageItem = { title: DENY_LABEL, isCloseAffordance: true };
    const summary = entry.summary;
    const data = desktop
        ? 'untrusted app data / 信頼できないアプリ由来データ'
        : 'untrusted page data / 信頼できないページ由来データ',
      short = desktop ? 'untrusted app data' : 'untrusted page data';
    const lines = [
      `Action: ${visibleText(summary.action)}`,
      desktop
        ? `Desktop application (configured grant / 許可したデスクトップアプリ): ${visibleText(summary.application ?? '')}`
        : '',
      `${desktop ? 'Window' : 'Target'} (${data}): ${visibleText(summary.target)}`,
      summary.origin ? `Origin: ${visibleText(summary.origin)}` : '',
      summary.role ? `Role (${short}): ${visibleText(summary.role)}` : '',
      summary.name ? `Name (${short}): ${visibleText(summary.name)}` : '',
      summary.risk === 'credential' ? 'Credential data is involved. / 認証情報を含む操作です。' : '',
      summary.value
        ? summary.value.kind === 'secret'
          ? `Value: secret (${summary.value.length} characters) / 秘密値（${summary.value.length}文字）`
          : `Public value (${short}): ${visibleText(JSON.stringify(summary.value.preview ?? ''))} (${summary.value.length} characters)`
        : '',
      desktop
        ? 'The native control is operated through the accessibility API in the background; the application may act immediately and nothing is rolled back. / ネイティブコントロールはアクセシビリティAPIで背面操作されます。アプリは直ちに処理する場合があり、取り消しはできません。'
        : '',
      ...(summary.details?.length
        ? [
            desktop
              ? 'Details (untrusted app data / 信頼できないアプリ由来の詳細):'
              : 'Page details (untrusted page data / 信頼できないページ由来の詳細):',
            ...summary.details.map(line => `• ${visibleText(line)}`),
          ]
        : []),
    ].filter(Boolean);
    try {
      const title =
        summary.action === 'handoff'
          ? 'Allow manual browsing for up to 120 seconds? Website scripts and forms at this origin can send requests while AI automation is paused. / 最大120秒、手動操作へ引き継ぎますか？ AIの自動操作は停止し、このoriginのサイト処理・フォーム送信を一時的に許可します。'
          : desktop
            ? 'AgentDeskLink asks to approve this native desktop action once. / このデスクトップアプリの操作を今回のみ許可しますか？'
            : 'AgentDeskLink asks to approve this browser action once. / このブラウザー操作を今回のみ許可しますか？';
      const result = await vscode.window.showWarningMessage(
        `${title}\n\n${lines.join('\n')}`,
        {
          modal: true,
          detail: `Workspace: ${visibleText(this.ownerLabel())}\n${DIALOG_NOTE}\nAsk covers browser actions and consequential native actions in the granted desktop app. Sensitive native controls are never approved. / 都度承認はブラウザー操作と、許可したデスクトップアプリの重要なネイティブ操作に適用されます。機密コントロールは承認できません。`,
        },
        approve,
        deny,
      );
      if (entry.status !== 'pending') return;
      this.expire(entry);
      // Only the Approve item approves; Deny, Cancel, Esc and closing the dialog all resolve to anything else.
      const picked = typeof result === 'string' ? result : result?.title;
      if (
        entry.status === 'pending' &&
        picked === APPROVE_LABEL &&
        entry.epoch === this.epoch &&
        entry.generation === this.generation &&
        this.contextCurrent()
      )
        entry.status = 'approved';
      else if (entry.status === 'pending') entry.status = 'denied';
    } catch {
      if (entry.status === 'pending') entry.status = 'denied';
    }
  }
  private expire(entry: Entry): void {
    if (entry.expiresAt <= Date.now() && (entry.status === 'pending' || entry.status === 'approved'))
      entry.status = 'expired';
  }
  private prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      this.expire(entry);
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }
  private response(entry: Entry) {
    return { v: 1, request_id: entry.id, binding: entry.binding, status: entry.status, expires_at: entry.expiresAt };
  }
  private onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
    return Object.keys(value).every(key => keys.includes(key));
  }
  private reply(res: http.ServerResponse, status: number, value: unknown): void {
    if (res.writableEnded) return;
    const body = Buffer.from(JSON.stringify(value));
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Length', String(body.length));
    res.end(body);
  }
}
