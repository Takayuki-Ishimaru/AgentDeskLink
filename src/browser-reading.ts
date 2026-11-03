import { randomBytes } from 'node:crypto';
import type { CDPSession, Page } from 'playwright';
import { AdlError } from './types.js';

/** Private read-only store for one frame/document. The caller enforces origin,
 * iframe ancestor privacy, permission gates and document-generation checks. */
export class IsolatedReadStore {
  private closed = false;
  private constructor(
    private readonly cdp: CDPSession,
    private readonly group: string,
    private readonly contextId: number,
    private readonly objectId: string,
  ) {
    cdp.on('Runtime.executionContextDestroyed', event => {
      if (event.executionContextId === contextId) this.invalidate();
    });
    cdp.on('Runtime.executionContextsCleared', () => this.invalidate());
  }

  private invalidate(): void {
    if (this.closed) return;
    this.closed = true;
    void this.cdp.send('Runtime.releaseObjectGroup', { objectGroup: this.group }).catch(() => undefined);
    void this.cdp.detach().catch(() => undefined);
  }

  static async bounded<T>(promise: Promise<T>, signal?: AbortSignal, cleanup?: () => void): Promise<T> {
    if (signal?.aborted) {
      cleanup?.();
      throw new AdlError('E_CANCELLED');
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const stop = new Promise<never>((_, reject) => {
      abort = () => {
        cleanup?.();
        reject(new AdlError('E_CANCELLED'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        cleanup?.();
        reject(new AdlError('E_TIMEOUT'));
      }, 5000);
    });
    try {
      return await Promise.race([promise, stop]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
    }
  }

  static async create(
    page: Page,
    frameId: string | undefined,
    init: {
      installIntegrityFn: (input: { key: string; registrationSecret: string }) => void;
      storeInitFn: (key: string) => unknown;
      prefix: string;
    },
    signal?: AbortSignal,
  ): Promise<IsolatedReadStore> {
    if (signal?.aborted) throw new AdlError('E_CANCELLED');
    const pending = page.context().newCDPSession(page);
    let abandoned = false;
    const cdp = await IsolatedReadStore.bounded(pending, signal, () => {
      abandoned = true;
      void pending.then(session => session.detach()).catch(() => undefined);
    });
    if (abandoned) throw new AdlError('E_CANCELLED');
    const group = 'adl-isolated-read-' + randomBytes(16).toString('hex');
    const key = '__adl_read_' + randomBytes(18).toString('hex');
    const registrationSecret = randomBytes(32).toString('hex');
    const run = <T>(promise: Promise<T>) =>
      IsolatedReadStore.bounded(promise, signal, () => {
        void cdp.detach().catch(() => undefined);
      });
    try {
      await run(cdp.send('Runtime.enable'));
      const targetFrame = frameId ?? (await run(cdp.send('Page.getFrameTree'))).frameTree.frame.id;
      const world = await run(cdp.send('Page.createIsolatedWorld', { frameId: targetFrame, worldName: group }));
      const installed = await run(
        cdp.send('Runtime.evaluate', {
          contextId: world.executionContextId,
          expression: `void (${init.installIntegrityFn.toString()})(${JSON.stringify({ key, registrationSecret })})`,
          returnByValue: true,
          objectGroup: group,
        }),
      );
      if (installed.exceptionDetails) throw new AdlError('E_PRIVACY_BLOCKED');
      const store = await run(
        cdp.send('Runtime.evaluate', {
          contextId: world.executionContextId,
          expression: `(${init.storeInitFn.toString()})(${JSON.stringify(key)})`,
          objectGroup: group,
        }),
      );
      if (store.exceptionDetails || !store.result.objectId) throw new AdlError('E_PRIVACY_BLOCKED');
      const instance = new IsolatedReadStore(cdp, group, world.executionContextId, store.result.objectId);
      await instance.evaluate(
        (value: { prefix: string }, prefix: string) => {
          value.prefix = prefix;
        },
        init.prefix,
        signal,
      );
      if (signal?.aborted || instance.closed) {
        await instance.dispose();
        throw new AdlError(signal?.aborted ? 'E_CANCELLED' : 'E_STALE_STATE');
      }
      return instance;
    } catch (error) {
      void cdp.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => undefined);
      await cdp.detach().catch(() => undefined);
      if (error instanceof AdlError) throw error;
      throw new AdlError('E_STALE_STATE');
    }
  }

  private async call<T>(
    objectId: string,
    functionDeclaration: string,
    args: unknown[],
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed) throw new AdlError('E_STALE_STATE');
    if (signal?.aborted) {
      this.invalidate();
      throw new AdlError('E_CANCELLED');
    }
    const close = () => this.invalidate();
    try {
      const result = await IsolatedReadStore.bounded(
        this.cdp.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration,
          arguments: args.map(value => ({ value })),
          returnByValue: true,
          objectGroup: this.group,
          awaitPromise: true,
        }),
        signal,
        close,
      );
      if (signal?.aborted) {
        close();
        throw new AdlError('E_CANCELLED');
      }
      if (this.closed) throw new AdlError('E_STALE_STATE');
      if (result.exceptionDetails) {
        const description = result.exceptionDetails.exception?.description ?? '';
        if (/^Error: ADL_MISSING(?:\n|$)/.test(description)) throw new AdlError('E_TARGET_NOT_FOUND');
        if (/^Error: Snapshot field limit(?:\n|$)/.test(description)) throw new AdlError('E_RESOURCE_LIMIT');
        throw new AdlError('E_PRIVACY_BLOCKED');
      }
      return result.result.value as T;
    } catch (error) {
      if (error instanceof AdlError) throw error;
      close();
      throw new AdlError('E_STALE_STATE');
    }
  }

  evaluate<T, A>(fn: (store: any, arg: A) => T, arg: A, signal?: AbortSignal): Promise<T> {
    return this.call<T>(
      this.objectId,
      `function(arg){if(!this.integrity.check())throw new Error('ADL_UNTRUSTED_DOM');return (${fn.toString()})(this,arg);}`,
      [arg],
      signal,
    );
  }

  evaluateElement<T, A>(id: string, fn: (element: Element, arg: A) => T, arg: A, signal?: AbortSignal): Promise<T> {
    return this.call<T>(
      this.objectId,
      `function(id,arg){if(!this.integrity.check())throw new Error('ADL_UNTRUSTED_DOM');const node=this.nodes.get(id);if(!node||!Reflect.get(Object.getPrototypeOf(node),'isConnected',node))throw new Error('ADL_MISSING');return (${fn.toString()})(node,arg);}`,
      [id, arg],
      signal,
    );
  }

  async evaluateBackendNode<T, A>(
    backendNodeId: number,
    fn: (element: Element, arg: A) => T,
    arg: A,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed) throw new AdlError('E_STALE_STATE');
    if (signal?.aborted) {
      this.invalidate();
      throw new AdlError('E_CANCELLED');
    }
    let temporary: string | undefined;
    try {
      const node = await IsolatedReadStore.bounded(
        this.cdp.send('DOM.resolveNode', {
          backendNodeId,
          executionContextId: this.contextId,
          objectGroup: this.group,
        }),
        signal,
        () => this.invalidate(),
      );
      if (!node.object.objectId) throw new AdlError('E_STALE_STATE');
      temporary = node.object.objectId;
      // Check the isolated guard before reading a frame owner from that same realm.
      await this.evaluate(() => true, null, signal);
      return await this.call<T>(
        node.object.objectId,
        `function(arg){return (${fn.toString()})(this,arg);}`,
        [arg],
        signal,
      );
    } catch (error) {
      if (error instanceof AdlError) throw error;
      throw new AdlError('E_STALE_STATE');
    } finally {
      if (temporary && !this.closed)
        void this.cdp.send('Runtime.releaseObject', { objectId: temporary }).catch(() => undefined);
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.cdp.send('Runtime.releaseObjectGroup', { objectGroup: this.group }).catch(() => undefined);
    await this.cdp.detach().catch(() => undefined);
  }
}

/** Browser-owned document identity. Same-document history changes retain the
 * loader ID, including when a separate document navigation is still pending.
 * Keep one private protocol session rather than attaching for every snapshot. */
export class MainDocumentIdentity {
  private protocol: Promise<CDPSession> | undefined;
  private closed = false;

  constructor(private readonly page: Page) {}

  async read(signal?: AbortSignal): Promise<string> {
    if (this.closed) throw new AdlError('E_STALE_STATE');
    if (signal?.aborted) throw new AdlError('E_CANCELLED');
    this.protocol ??= this.page.context().newCDPSession(this.page);
    try {
      const abandon = () => {
        void this.dispose();
      };
      const protocol = await IsolatedReadStore.bounded(this.protocol, signal, abandon);
      if (this.closed) throw new AdlError('E_STALE_STATE');
      if (signal?.aborted) throw new AdlError('E_CANCELLED');
      const { frameTree } = await IsolatedReadStore.bounded(protocol.send('Page.getFrameTree'), signal, abandon);
      if (signal?.aborted) throw new AdlError('E_CANCELLED');
      if (this.closed) throw new AdlError('E_STALE_STATE');
      const { id, loaderId } = frameTree.frame;
      if (!id || !loaderId) throw new AdlError('E_STALE_STATE');
      return JSON.stringify([id, loaderId]);
    } catch (error) {
      if (error instanceof AdlError) throw error;
      throw new AdlError('E_STALE_STATE');
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending = this.protocol;
    this.protocol = undefined;
    // Never wait for an in-flight attach while cancelling. Its eventual result
    // is detached; the owning BrowserContext also closes all target sessions.
    void pending?.then(protocol => protocol.detach()).catch(() => undefined);
  }
}
