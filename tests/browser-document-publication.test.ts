import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Page } from 'playwright';
import { BrowserAdapter } from '../src/browser.js';
import { MainDocumentIdentity } from '../src/browser-reading.js';
import { assertUrlAllowed, parsePolicy } from '../src/policy.js';

const signal = () => new AbortController().signal;

async function fixture() {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const app = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/slow') {
      const timer = setTimeout(() => {
        timers.delete(timer);
        res.end('<h1>Slow replacement</h1>');
      }, 2500);
      timers.add(timer);
      return;
    }
    res.end(
      '<!doctype html><title>Fixture</title><main><h1>Readable document</h1><button>Open</button></main>' +
        (req.url === '/hostile'
          ? '<script>Element.prototype.matches = function(){throw new Error("page hook called")}</script>'
          : ''),
    );
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    allowedOrigins: [origin],
    allowLoopback: true,
    operationMode: 'standard',
    actionTimeoutMs: 5000,
    browserTargets: [
      {
        id: 'publication',
        label: 'Fixture',
        url: origin,
        classification: 'PUBLIC',
      },
    ],
  });
  const adapter = new BrowserAdapter(policy, (url, purpose) => assertUrlAllowed(url, policy, undefined, purpose));
  try {
    const session = await adapter.open(
      {
        target_id: 'publication',
        application_id: 'publication',
        label: 'Fixture',
        surface: 'browser',
        capabilities: [],
        policy_class: 'PUBLIC',
      },
      'strict_isolated',
      signal(),
    );
    const held = session as unknown as {
      pageValue: Page;
      publishedDocuments: Set<string>;
      notePublishedDocument(identity: string): void;
      canPublishIsolated(identity: string): boolean;
    };
    const identity = new MainDocumentIdentity(held.pageValue);
    return {
      origin,
      session,
      held,
      identity,
      close: async () => {
        await identity.dispose();
        await adapter.close();
        for (const timer of timers) clearTimeout(timer);
        app.closeAllConnections();
        await new Promise<void>(resolve => app.close(() => resolve()));
      },
    };
  } catch (error) {
    await adapter.close();
    for (const timer of timers) clearTimeout(timer);
    app.closeAllConnections();
    await new Promise<void>(resolve => app.close(() => resolve()));
    throw error;
  }
}

test(
  'pending navigation plus pushState and stop cannot downgrade a published document',
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      await f.session.snapshot();
      const original = await f.identity.read();
      const page = f.held.pageValue;
      await page.evaluate(() => {
        (window as unknown as { originalDocument: Document }).originalDocument = document;
        location.assign('/slow');
        setTimeout(() => {
          history.pushState({}, '', '/still-old');
          // Let Playwright receive framenavigated while the separate request is
          // pending, then abort that request without replacing the Document.
          setTimeout(() => window.stop(), 80);
          Object.defineProperty(Element.prototype, 'matches', {
            configurable: true,
            value() {
              throw new Error('runtime forgery must never execute');
            },
          });
        }, 100);
      });
      await page.waitForURL('**/still-old');
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(
        await page.evaluate(() => (window as unknown as { originalDocument: Document }).originalDocument === document),
        true,
      );
      assert.equal(await f.identity.read(), original);
      await assert.rejects(f.session.snapshot(), {
        code: 'E_PRIVACY_BLOCKED',
        reason: 'untrusted_dom_api',
      });
    } finally {
      await f.close();
    }
  },
);

test(
  'a genuinely new incompatible document can downgrade and stays read-only after back',
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      await f.session.snapshot();
      const original = await f.identity.read();
      await f.session.act({ action: 'navigate', url: `${f.origin}/hostile` }, signal());
      assert.notEqual(await f.identity.read(), original);
      const hostile = await f.session.snapshot();
      assert.equal(hostile.read_only, true);
      assert.ok(hostile.elements.some(element => element.name === 'Readable document'));
      await f.session.act({ action: 'back' }, signal());
      const back = await f.session.snapshot();
      assert.equal(back.read_only, true);
      const button = back.elements.find(element => element.name === 'Open')!;
      await assert.rejects(f.session.act({ action: 'click', element_id: button.id }, signal()), {
        code: 'E_UNSUPPORTED_ACTION',
        reason: 'isolated_read_only',
      });
    } finally {
      await f.close();
    }
  },
);

test(
  'publication history retains returning document identities and fails closed at its bound',
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      await f.session.snapshot();
      const original = await f.identity.read();
      assert.equal(f.held.canPublishIsolated(original), false);
      // A BFCache restoration returns an earlier loader identity, rather than a
      // newly allocated document. Later publications must never evict its trust.
      f.held.notePublishedDocument('another-document');
      assert.equal(f.held.canPublishIsolated(original), false);
      for (let i = 0; i < 4096; i++) f.held.notePublishedDocument(`document-${i}`);
      assert.equal(f.held.publishedDocuments.size, 4096);
      assert.equal(f.held.canPublishIsolated(original), false);
      assert.equal(f.held.canPublishIsolated('previously-unseen-document'), false);
    } finally {
      await f.close();
    }
  },
);
