import * as http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as vscode from 'vscode';
import { redactApprovalText } from '../approval-summary.js';
import { log } from './shared.js';

type Status = 'pending' | 'approved' | 'denied' | 'expired' | 'consumed' | 'invalidated';
// The only standing scope: every write request this AI server sends to one destination origin. The Engine computes eligibility; only the host modal turns it into a grant.
type GrantScope = { scope: 'site_writes'; origin: string };
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
  grant?: GrantScope;
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
  // The id of the site grant that approved this entry, or that the human created while approving it.
  grantedBy?: string;
};
type SiteGrant = {
  id: string;
  serverId: string;
  origin: string;
  createdAt: number;
  expiresAt: number;
  generation: number;
  epoch: string;
  uses: number;
  lastUsedAt?: number;
  timer?: ReturnType<typeof setTimeout>;
};
export interface SiteGrantView {
  id: string;
  origin: string;
  scope: 'site_writes';
  created_at: number;
  expires_at: number;
  uses: number;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BINDING = /^[0-9a-f]{64}$/i;
const dialogLabels = (japanese: boolean) =>
  japanese
    ? { approve: '今回のみ許可', allowSite: 'サイト書き込みを30分許可', deny: '拒否（Esc・閉じるも拒否）' }
    : { approve: 'Approve once', allowSite: 'Allow site writes for 30 minutes', deny: 'Deny (Esc/close also deny)' };
const dialogNote = (japanese: boolean) =>
  japanese
    ? '今回のみ、この操作を許可します。拒否・Esc・ダイアログを閉じる操作はすべて拒否です。'
    : 'This authorizes one action. Deny, Esc, or closing the dialog denies it.';
// A standing grant lasts at most 30 minutes from the human's choice and ends earlier with the permission generation (settings, trust, emergency stop, deactivation) or an explicit revoke.
const SITE_GRANT_MS = 30 * 60_000;
const MAX_SITE_GRANTS = 16;
// The Engine may attach a grant scope only to these browser actions: the held request itself, and the click / key press of a real form submission.
const GRANT_ACTIONS = ['send_request', 'click', 'press'];
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
  private readonly siteGrants = new Map<string, SiteGrant>();
  private readonly grantsChanged = new vscode.EventEmitter<void>();
  private grantsNotify: ReturnType<typeof setTimeout> | undefined;
  // Coalesced: one emission per macrotask, however many grants were created, used or ended meanwhile.
  readonly onDidChangeGrants = this.grantsChanged.event;
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
    this.clearGrants();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revoke();
    this.server.close();
    if (this.grantsNotify) clearTimeout(this.grantsNotify);
    this.grantsNotify = undefined;
    this.grantsChanged.dispose();
  }
  /** The live standing grants of this window, oldest first. The panel lists them; it can revoke them but never create or widen one. */
  grants(): SiteGrantView[] {
    this.pruneGrants();
    return [...this.siteGrants.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(g => ({
        id: g.id,
        origin: g.origin,
        scope: 'site_writes' as const,
        created_at: g.createdAt,
        expires_at: g.expiresAt,
        uses: g.uses,
      }));
  }
  /** Explicit revoke from the panel: the grant ends, and anything it approved that nobody has consumed yet can no longer be used. */
  revokeGrant(id: string): boolean {
    this.pruneGrants();
    const grant = this.siteGrants.get(id);
    if (!grant) return false;
    this.dropGrant(grant);
    for (const entry of this.entries.values())
      if (entry.grantedBy === grant.id && entry.status === 'approved') entry.status = 'invalidated';
    log.line(
      `site grant revoked (panel): ${grant.origin} for server ${grant.serverId.slice(0, 8)} (${grant.uses} uses)`,
    );
    this.notifyGrants();
    return true;
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
      // A live grant for this server and destination approves right here, before the reply: there is no await between the check and the approval.
      const grant = this.grantFor(entry);
      if (grant) {
        this.useGrant(entry, grant);
        return this.reply(res, 201, this.response(entry));
      }
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
        'grant',
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
    // The standing-grant scope is only ever the Engine's description of a plain, non-credential browser write to one granted http(s) origin; anything else is refused like any other malformed summary field.
    let grant: GrantScope | undefined;
    if (Object.hasOwn(q, 'grant')) {
      const g = q.grant;
      if (!g || typeof g !== 'object' || Array.isArray(g)) return;
      const scope = g as Record<string, unknown>;
      if (
        !this.onlyKeys(scope, ['scope', 'origin']) ||
        !Object.hasOwn(scope, 'scope') ||
        !Object.hasOwn(scope, 'origin') ||
        scope.scope !== 'site_writes' ||
        typeof scope.origin !== 'string' ||
        scope.origin.length > 256 ||
        desktop ||
        q.risk !== 'consequential' ||
        value?.kind === 'secret' ||
        !GRANT_ACTIONS.includes(action)
      )
        return;
      try {
        const u = new URL(scope.origin);
        if (
          !['http:', 'https:'].includes(u.protocol) ||
          u.origin !== scope.origin ||
          u.username ||
          u.password ||
          !this.allowedOrigins().includes(scope.origin)
        )
          return;
      } catch {
        return;
      }
      grant = { scope: 'site_writes', origin: scope.origin };
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
      ...(grant ? { grant } : {}),
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
    // Queued behind an earlier modal: a grant the human gave there covers this request too, so no second modal is shown.
    const standing = this.grantFor(entry);
    if (standing) {
      this.useGrant(entry, standing);
      return;
    }
    const summary = entry.summary;
    const japanese = /^ja(?:-|$)/i.test(vscode.env.language);
    const labels = dialogLabels(japanese);
    const approve: vscode.MessageItem = { title: labels.approve };
    // The third item is offered only for a browser summary that carries a validated grant scope.
    const scope = !desktop && summary.risk === 'consequential' ? summary.grant : undefined;
    const allowSite: vscode.MessageItem = { title: labels.allowSite };
    // VS Code adds its own Cancel to a modal unless an item is the close affordance; Deny keeps Esc/close denying.
    const deny: vscode.MessageItem = { title: labels.deny, isCloseAffordance: true };
    const data = desktop
      ? japanese
        ? '信頼できないアプリのデータ'
        : 'untrusted app data'
      : japanese
        ? '信頼できないページのデータ'
        : 'untrusted page data';
    const heldRequest = summary.action === 'send_request' && !desktop;
    const lines = [
      heldRequest
        ? japanese
          ? '操作: 下のリクエストを送信（画面操作は実行済み）'
          : 'Action: send the request below (control already used)'
        : `${japanese ? '操作' : 'Action'}: ${visibleText(summary.action)}`,
      desktop ? `${japanese ? 'アプリ' : 'Application'}: ${visibleText(summary.application ?? '')}` : '',
      `${desktop ? (japanese ? 'ウィンドウ' : 'Window') : japanese ? '対象' : 'Target'} (${data}): ${visibleText(summary.target)}`,
      summary.name || summary.role
        ? `${japanese ? 'コントロール' : 'Control'} (${data}): ${summary.name ? visibleText(summary.name) : ''}${summary.role ? `${summary.name ? ' ' : ''}(${visibleText(summary.role)})` : ''}`
        : '',
      summary.value
        ? summary.value.kind === 'secret'
          ? `${japanese ? '値' : 'Value'}: ${japanese ? '秘密' : 'secret'} (${summary.value.length} ${japanese ? '文字' : 'characters'})`
          : `${japanese ? '入力値' : 'Value'} (${data}): ${visibleText(JSON.stringify(summary.value.preview ?? ''))} (${summary.value.length} ${japanese ? '文字' : 'characters'})`
        : '',
      summary.origin ? `Origin: ${visibleText(summary.origin)}` : '',
      summary.risk === 'credential' ? (japanese ? '認証情報を含みます。' : 'Credential data is involved.') : '',
      ...(summary.details?.length
        ? [
            `${japanese ? (desktop ? '詳細' : 'ページの詳細') : desktop ? 'Details' : 'Page details'} (${data}):`,
            ...summary.details.map(line => `• ${visibleText(line)}`),
          ]
        : []),
      desktop
        ? japanese
          ? 'アプリはすぐに処理する場合があります。この操作は取り消せません。'
          : 'The app may act immediately; this action cannot be undone.'
        : '',
      scope
        ? japanese
          ? `${visibleText(scope.origin)}への書き込みを30分、確認なしで許可します。認証情報や購入・支払いは毎回確認します。許可はパネルから取り消せます。`
          : `Grant: this server may send writes to ${visibleText(scope.origin)} without asking for 30 minutes. Credentials and purchases/payments still require approval; revoke in the AgentDeskLink panel.`
        : '',
    ].filter(Boolean);
    try {
      const title =
        summary.action === 'handoff'
          ? japanese
            ? '最大120秒、手動操作に切り替えますか？この間、サイトが通信できます。'
            : 'Allow manual browsing for up to 120 seconds? The site may send requests during this time.'
          : desktop
            ? japanese
              ? 'このデスクトップ操作を1回許可しますか？'
              : 'Approve this desktop action once?'
            : heldRequest
              ? japanese
                ? '下のリクエストを1回送信しますか？'
                : 'Send the request below once?'
              : japanese
                ? 'このブラウザー操作を1回許可しますか？'
                : 'Approve this browser action once?';
      const result = await vscode.window.showWarningMessage(
        `${title}\n\n${lines.join('\n')}`,
        {
          modal: true,
          detail: `${japanese ? 'ワークスペース' : 'Workspace'}: ${visibleText(this.ownerLabel())}\n${dialogNote(japanese)}${desktop ? (japanese ? '\n機密コントロールは承認できません。' : '\nSensitive native controls are never approved.') : ''}`,
        },
        ...(scope ? [approve, allowSite, deny] : [approve, deny]),
      );
      if (entry.status !== 'pending') return;
      this.expire(entry);
      // Only the Approve item and, when offered, the Allow-site item approve; Deny, Cancel, Esc and closing the dialog all resolve to anything else.
      const picked = typeof result === 'string' ? result : result?.title;
      const current =
        entry.status === 'pending' &&
        entry.epoch === this.epoch &&
        entry.generation === this.generation &&
        this.contextCurrent();
      if (current && picked === labels.approve) entry.status = 'approved';
      else if (current && scope && picked === labels.allowSite && this.allowedOrigins().includes(scope.origin)) {
        // The human approves this request and creates the standing grant in one choice; this request counts as the grant's first use.
        entry.status = 'approved';
        entry.grantedBy = this.createGrant(entry, scope.origin).id;
      } else if (entry.status === 'pending') entry.status = 'denied';
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
    return {
      v: 1,
      request_id: entry.id,
      binding: entry.binding,
      status: entry.status,
      expires_at: entry.expiresAt,
      ...(entry.grantedBy ? { granted: 'site_writes' as const } : {}),
    };
  }
  // The live grant that may approve this pending entry without a modal, or undefined. The entry's server and destination origin must equal the grant's, and everything the modal path checks must still hold.
  private grantFor(entry: Entry): SiteGrant | undefined {
    this.pruneGrants();
    const scope = entry.summary.grant;
    if (
      !scope ||
      !this.siteGrants.size ||
      entry.status !== 'pending' ||
      entry.summary.surface !== 'browser' ||
      entry.summary.risk !== 'consequential' ||
      entry.epoch !== this.epoch ||
      entry.generation !== this.generation ||
      entry.expiresAt <= Date.now() ||
      !this.contextCurrent() ||
      !this.allowedOrigins().includes(scope.origin)
    )
      return undefined;
    // pruneGrants() just ended every grant that is not live, and nothing awaits in between.
    for (const grant of this.siteGrants.values())
      if (grant.serverId === entry.serverId && grant.origin === scope.origin) return grant;
    return undefined;
  }
  private grantLive(grant: SiteGrant, current: boolean): boolean {
    return (
      current &&
      grant.expiresAt > Date.now() &&
      grant.generation === this.generation &&
      grant.epoch === this.epoch &&
      this.allowedOrigins().includes(grant.origin)
    );
  }
  private useGrant(entry: Entry, grant: SiteGrant): void {
    const now = Date.now();
    entry.status = 'approved';
    entry.grantedBy = grant.id;
    grant.uses++;
    grant.lastUsedAt = now;
    log.line(
      `approval ${entry.id} approved by site grant ${grant.origin} (${visibleText(entry.summary.action)}, server ${entry.serverId.slice(0, 8)}, use ${grant.uses}, ${Math.max(0, Math.ceil((grant.expiresAt - now) / 60_000))} min left)`,
    );
    this.notifyGrants();
  }
  // A new grant replaces one for the same server and origin; at the cap the oldest ends first. A use never extends the lifetime.
  private createGrant(entry: Entry, origin: string): SiteGrant {
    this.pruneGrants();
    for (const old of [...this.siteGrants.values()])
      if (old.serverId === entry.serverId && old.origin === origin) this.dropGrant(old);
    while (this.siteGrants.size >= MAX_SITE_GRANTS) {
      const oldest = [...this.siteGrants.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!oldest) break;
      this.dropGrant(oldest);
    }
    const now = Date.now();
    const grant: SiteGrant = {
      id: randomUUID(),
      serverId: entry.serverId,
      origin,
      createdAt: now,
      expiresAt: now + SITE_GRANT_MS,
      generation: this.generation,
      epoch: this.epoch,
      uses: 1,
      lastUsedAt: now,
    };
    this.siteGrants.set(grant.id, grant);
    // The timer only makes the panel notice the end; every use re-checks the clock itself.
    grant.timer = setTimeout(() => {
      grant.timer = undefined;
      this.pruneGrants();
    }, SITE_GRANT_MS + 50);
    grant.timer.unref?.();
    log.line(
      `site grant created: ${origin} for server ${entry.serverId.slice(0, 8)} (30 min; ends with the permission generation)`,
    );
    this.notifyGrants();
    return grant;
  }
  private dropGrant(grant: SiteGrant): void {
    if (grant.timer) clearTimeout(grant.timer);
    grant.timer = undefined;
    this.siteGrants.delete(grant.id);
  }
  // Ends every grant that is expired, from an older permission generation or epoch, or whose origin is no longer allowed.
  private pruneGrants(): void {
    if (!this.siteGrants.size) return;
    const current = this.contextCurrent();
    let ended = 0;
    for (const grant of [...this.siteGrants.values()]) {
      if (this.grantLive(grant, current)) continue;
      this.dropGrant(grant);
      ended++;
      log.line(`site grant ended: ${grant.origin} for server ${grant.serverId.slice(0, 8)} (${grant.uses} uses)`);
    }
    if (ended) this.notifyGrants();
  }
  private clearGrants(): void {
    const count = this.siteGrants.size;
    for (const grant of [...this.siteGrants.values()]) this.dropGrant(grant);
    if (!count) return;
    log.line(`site grants cleared (${count})`);
    this.notifyGrants();
  }
  private notifyGrants(): void {
    if (this.disposed || this.grantsNotify) return;
    this.grantsNotify = setTimeout(() => {
      this.grantsNotify = undefined;
      if (!this.disposed) this.grantsChanged.fire();
    }, 0);
    this.grantsNotify.unref?.();
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
