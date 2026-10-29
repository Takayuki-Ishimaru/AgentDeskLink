import * as http from 'node:http';
import { AdlError } from './types.js';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'consumed' | 'invalidated';
export interface ApprovalSummary {
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
}
export interface ApprovalReply {
  v: 1;
  request_id: string;
  binding: string;
  status: ApprovalStatus;
  expires_at: number;
  consumed_now?: boolean;
}
export class ApprovalClient {
  private constructor(
    private url: URL,
    private token: string,
    readonly epoch: string,
  ) {}
  static fromEnv(): ApprovalClient | undefined {
    const raw = process.env.ADL_APPROVAL_URL,
      token = process.env.ADL_APPROVAL_TOKEN,
      epoch = process.env.ADL_APPROVAL_EPOCH;
    if (!raw || !token || !epoch) return undefined;
    try {
      const url = new URL(raw);
      if (
        url.protocol !== 'http:' ||
        url.hostname !== '127.0.0.1' ||
        !url.port ||
        url.pathname !== '/' ||
        url.search ||
        url.hash ||
        url.username ||
        url.password ||
        !/^[A-Za-z0-9_-]{43}$/.test(token) ||
        !/^[a-f0-9-]{36}$/i.test(epoch)
      )
        return undefined;
      return new ApprovalClient(url, token, epoch);
    } catch {
      return undefined;
    }
  }
  async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    expected: { request_id: string; binding: string; expires_at: number },
    body?: unknown,
  ): Promise<ApprovalReply> {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    if (data && data.length > 8192) throw new AdlError('E_POLICY_DENIED');
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => req.destroy(), 2000);
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: Number(this.url.port),
          path,
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}),
          },
          agent: false,
        },
        res => {
          if (res.statusCode !== 200 && res.statusCode !== 201) {
            clearTimeout(timer);
            res.resume();
            reject(new AdlError('E_POLICY_DENIED'));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 16384) {
              req.destroy();
              reject(new AdlError('E_POLICY_DENIED'));
            } else chunks.push(chunk);
          });
          res.on('end', () => {
            clearTimeout(timer);
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
              reject(new AdlError('E_POLICY_DENIED'));
            }
          });
          res.on('error', () => {
            clearTimeout(timer);
            reject(new AdlError('E_POLICY_DENIED'));
          });
          res.on('aborted', () => {
            clearTimeout(timer);
            reject(new AdlError('E_POLICY_DENIED'));
          });
        },
      );
      req.on('error', () => {
        clearTimeout(timer);
        reject(new AdlError('E_POLICY_DENIED'));
      });
      req.end(data);
    });
    if (!result || typeof result !== 'object') throw new AdlError('E_POLICY_DENIED');
    const r = result as ApprovalReply;
    if (
      r.v !== 1 ||
      r.request_id !== expected.request_id ||
      r.binding !== expected.binding ||
      r.expires_at !== expected.expires_at ||
      !['pending', 'approved', 'denied', 'expired', 'consumed', 'invalidated'].includes(r.status)
    )
      throw new AdlError('E_POLICY_DENIED');
    return r;
  }
}
