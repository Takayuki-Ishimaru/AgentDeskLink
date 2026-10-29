/// <reference types="node" />
import * as http from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { AdlError } from './types.js';

export const MAX_BODY = 2 * 1024 * 1024;
export const MAX_ASSET_BODY = 20 * 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 5000;
const MAX_POOLED_AGENTS = 32;
const MAX_POOL_SOCKETS = 8;
export const HOP_RE =
  /^(connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade|content-length|content-encoding|host|set-cookie)$/i;

export interface FetchResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface PinnedFetchOptions {
  resourceType?: string;
  pool?: PinnedConnectionPool;
  proxyConnectByHostname?: boolean;
}

// Only the caller's declared resource type may widen the cap; a server
// content-type header is attacker controlled and is never consulted.
function bodyLimit(resourceType: string | undefined): number {
  return resourceType === 'script' || resourceType === 'stylesheet' ? MAX_ASSET_BODY : MAX_BODY;
}

/** A fresh routed CSS import preserves the destination's encoding and URL base. */
export function redirectStylesheet(destination: URL): Buffer {
  if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password)
    throw new AdlError('E_POLICY_DENIED');
  return Buffer.from('@import url(' + JSON.stringify(destination.href) + ');\n', 'utf8');
}

// The proxy is trusted configuration. It receives a vetted literal IP, never
// the destination hostname for resolution, so target DNS policy stays pinned.
// Exception: connectByHostname sends CONNECT <hostname>:<port> for proxies that
// authorize by hostname; the vetted IP still binds the agent key and the local
// DNS vetting already ran. HTTPS-only by design: with a hostname authority the
// proxy resolves the name itself, and only the original-hostname TLS check
// (servername + rejectUnauthorized) can stop it resolving elsewhere, e.g. to an
// internal address. Plain HTTP through a proxy has no such check, so it keeps
// the IP absolute-URI form in every mode.
class PinnedTunnelAgent extends https.Agent {
  private connections = new Set<http.ClientRequest>();
  private tunnels = new Set<Duplex>();
  constructor(
    private proxy: URL,
    private target: URL,
    private ip: string,
    private signal: AbortSignal,
    private connectByHostname = false,
  ) {
    super({ keepAlive: false });
  }
  /** The tunnel failure passed to agent.createConnection, if any; reported instead of the generic socket error. */
  lastFailure?: AdlError;
  override createConnection(
    _options: https.RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | undefined {
    const host = this.connectByHostname ? this.target.hostname : this.ip.includes(':') ? '[' + this.ip + ']' : this.ip;
    const authority = host + ':' + (this.target.port || '443');
    const transport = this.proxy.protocol === 'https:' ? https : http;
    let completed = false;
    const done = (error: Error | null, stream?: Duplex) => {
      if (error && !completed) this.lastFailure = error as AdlError;
      if (completed) {
        if (stream) stream.destroy();
        return;
      }
      completed = true;
      callback?.(error, stream!);
    };
    const connect = transport.request({
      hostname: this.proxy.hostname.replace(/^\[|\]$/g, ''),
      port: this.proxy.port || (this.proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: authority,
      headers: { host: authority },
      signal: this.signal,
      agent: false,
      rejectUnauthorized: true,
    });
    this.connections.add(connect);
    // Fails before CONNECT was answered: the proxy itself was unreachable.
    connect.once('error', () => done(new AdlError('E_POLICY_DENIED', 'proxy_unreachable')));
    connect.once('connect', (response, socket, head) => {
      this.connections.delete(connect);
      this.tunnels.add(socket);
      socket.once('close', () => this.tunnels.delete(socket));
      if (response.statusCode !== 200) {
        socket.destroy();
        done(new AdlError('E_POLICY_DENIED', 'proxy_connect_refused'));
        return;
      }
      if (head.length) socket.unshift(head);
      const secure = tls.connect({
        socket,
        servername: this.target.hostname.replace(/^\[|\]$/g, ''),
        rejectUnauthorized: true,
      });
      this.tunnels.add(secure);
      secure.once('close', () => this.tunnels.delete(secure));
      secure.once('secureConnect', () => done(null, secure));
      secure.once('error', () => done(new AdlError('E_POLICY_DENIED')));
    });
    connect.end();
    return undefined;
  }
  override destroy(): void {
    for (const request of this.connections) request.destroy();
    for (const socket of this.tunnels) socket.destroy();
    this.connections.clear();
    this.tunnels.clear();
    super.destroy();
  }
}

// Session-scoped keepalive for direct (non-proxied) pinned requests. Callers own
// a pool per session, so nothing outlives it and no module level state exists.
// A key binds the original origin (protocol + hostname + effective port) to the
// exact vetted IP, so a socket can never migrate across origin, port, IP or
// protocol; TLS identity stays the original hostname, verified per connection.
export class PinnedConnectionPool {
  private readonly agents = new Map<string, http.Agent>();
  private closed = false;

  /** The keepalive agent for this origin/IP pair, or null once the pool is closed. */
  agentFor(url: URL, ip: string): http.Agent | null {
    if (this.closed) return null;
    const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80';
    const key = `${url.protocol}//${url.hostname}:${port}|${ip}`;
    const cached = this.agents.get(key);
    if (cached) {
      this.agents.delete(key);
      this.agents.set(key, cached);
      return cached;
    }
    const config = { keepAlive: true, maxSockets: MAX_POOL_SOCKETS, keepAliveInitialDelay: 0 };
    const agent = url.protocol === 'https:' ? new https.Agent(config) : new http.Agent(config);
    this.agents.set(key, agent);
    // Eviction destroys the least recently used agent; its in-flight requests die
    // as socket errors, which pinnedFetch reports like any other socket failure.
    if (this.agents.size > MAX_POOLED_AGENTS) {
      const oldest = this.agents.keys().next();
      if (!oldest.done) {
        const evicted = this.agents.get(oldest.value);
        this.agents.delete(oldest.value);
        evicted?.destroy();
      }
    }
    return agent;
  }

  /** Number of pooled origin/IP agents; used to bound and observe the pool. */
  get size(): number {
    return this.agents.size;
  }

  /** Destroy every pooled socket and refuse all later use. */
  destroy(): void {
    this.closed = true;
    for (const agent of this.agents.values()) agent.destroy();
    this.agents.clear();
  }

  close(): void {
    this.destroy();
  }
}

// Pin DNS to the vetted IP while retaining the original host and TLS identity.
// Return redirect responses to the adapter; never follow a Location here.
// The adapter vets and pins every hop instead of fulfilling an HTTP redirect,
// whose follow-up request can bypass Playwright's route interception.
export function pinnedFetch(
  url: URL,
  ip: string,
  method: string,
  headers: Record<string, string>,
  signal: AbortSignal,
  body?: Buffer,
  proxyServer?: string,
  opts?: PinnedFetchOptions,
): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    let lib = url.protocol === 'https:' ? https : http;
    const limit = bodyLimit(opts?.resourceType);
    const outHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (!HOP_RE.test(k)) outHeaders[k] = v;
    outHeaders.host = url.host;
    outHeaders['accept-encoding'] = 'identity';
    const options: https.RequestOptions = {
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
      path: (url.pathname || '/') + (url.search || ''),
      method,
      headers: outHeaders,
      agent: false,
      lookup: (_h, lookupOptions, cb) => {
        const family = ip.includes(':') ? 6 : 4;
        if (typeof lookupOptions === 'object' && lookupOptions.all)
          (cb as unknown as (err: null, addresses: { address: string; family: number }[]) => void)(null, [
            { address: ip, family },
          ]);
        else (cb as unknown as (err: null, address: string, family: number) => void)(null, ip, family);
      },
      servername: url.hostname.replace(/^\[|\]$/g, ''),
      rejectUnauthorized: true,
      signal,
    };
    let tunnel: PinnedTunnelAgent | undefined;
    if (proxyServer) {
      let proxy: URL;
      try {
        proxy = new URL(proxyServer);
        if (
          !['http:', 'https:'].includes(proxy.protocol) ||
          proxy.username ||
          proxy.password ||
          proxy.pathname !== '/' ||
          proxyServer.includes('?') ||
          proxyServer.includes('#')
        )
          throw new Error();
      } catch {
        reject(new AdlError('E_INVALID_ARGUMENT'));
        return;
      }
      if (url.protocol === 'https:') {
        tunnel = new PinnedTunnelAgent(proxy, url, ip, signal, opts?.proxyConnectByHostname === true);
        options.agent = tunnel;
      } else {
        lib = proxy.protocol === 'https:' ? https : http;
        options.hostname = proxy.hostname.replace(/^\[|\]$/g, '');
        options.port = proxy.port || (proxy.protocol === 'https:' ? 443 : 80);
        options.path =
          'http://' +
          (ip.includes(':') ? '[' + ip + ']' : ip) +
          ':' +
          (url.port || '80') +
          (url.pathname || '/') +
          url.search;
        options.servername = proxy.hostname.replace(/^\[|\]$/g, '');
        delete options.lookup;
      }
    }
    // Keepalive applies only to direct requests: a proxied tunnel is one-shot so
    // it can never be shared across vetted destinations. A closed pool refuses
    // to dispatch rather than silently opening a new socket.
    if (opts?.pool && !proxyServer) {
      const agent = opts.pool.agentFor(url, ip);
      if (!agent) {
        reject(new AdlError('E_POLICY_DENIED'));
        return;
      }
      options.agent = agent;
    }
    let settled = false;
    let response: http.IncomingMessage | undefined;
    const finish = (error?: AdlError, result?: FetchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tunnel?.destroy();
      if (error) {
        // Destroying the request also drops its socket, so a socket that died
        // mid-response can never be handed back out by the keepalive pool.
        response?.destroy();
        req.destroy();
        reject(error);
      } else resolve(result!);
    };
    const timer = setTimeout(() => finish(new AdlError('E_TIMEOUT')), RESPONSE_TIMEOUT_MS);
    const req = lib.request(options, res => {
      response = res;
      // HEAD and bodyless status responses may still advertise the encoding of
      // the corresponding GET; there is no compressed stream to decode.
      const bodyless = method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304;
      const encoding = bodyless
        ? 'identity'
        : String(res.headers['content-encoding'] ?? 'identity')
            .trim()
            .toLowerCase();
      let decoder: ReturnType<typeof createGunzip> | undefined;
      if (encoding === 'gzip') decoder = createGunzip();
      else if (encoding === 'deflate') decoder = createInflate();
      else if (encoding === 'br') decoder = createBrotliDecompress();
      else if (encoding !== '' && encoding !== 'identity') return finish(new AdlError('E_POLICY_DENIED'));
      let compressed = 0,
        expanded = 0;
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        compressed += chunk.length;
        if (compressed > limit) finish(new AdlError('E_RESOURCE_LIMIT'));
      });
      res.on('error', () => finish(new AdlError('E_POLICY_DENIED')));
      res.on('aborted', () => finish(new AdlError('E_POLICY_DENIED')));
      const stream = decoder ? res.pipe(decoder) : res;
      stream.on('data', (chunk: Buffer) => {
        expanded += chunk.length;
        if (expanded > limit) finish(new AdlError('E_RESOURCE_LIMIT'));
        else chunks.push(chunk);
      });
      stream.on('error', () => finish(new AdlError('E_POLICY_DENIED')));
      stream.on('end', () =>
        finish(undefined, { status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on('error', () => finish(tunnel?.lastFailure ?? new AdlError('E_POLICY_DENIED')));
    req.end(body);
  });
}
