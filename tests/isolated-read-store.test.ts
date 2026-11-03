import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { IsolatedReadStore, MainDocumentIdentity } from '../src/browser-reading.js';
import type { CDPSession, Page } from 'playwright';

test('document identity cancels a pending attach and detaches its late result', { timeout: 3000 }, async () => {
  let resolveAttach!: (value: CDPSession) => void;
  const pending = new Promise<CDPSession>(resolve => {
    resolveAttach = resolve;
  });
  const page = { context: () => ({ newCDPSession: () => pending }) } as unknown as Page;
  const identity = new MainDocumentIdentity(page);
  const controller = new AbortController();
  const reading = identity.read(controller.signal);
  controller.abort();
  await assert.rejects(reading, { code: 'E_CANCELLED' });
  await identity.dispose();
  let detached = 0;
  resolveAttach({
    detach: async () => {
      detached++;
    },
  } as unknown as CDPSession);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(detached, 1);
  await assert.rejects(identity.read(), { code: 'E_STALE_STATE' });
});

test(
  'isolated store reads without main-world getters and cleans up on navigation and abort',
  { timeout: 20000 },
  async () => {
    const browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    const page = await browser.newPage();
    try {
      await page.setContent(`<p id="target">public</p><iframe srcdoc="<p>child</p>"></iframe><script>
      window.hits=0; Object.defineProperty(document.querySelector('p'),'textContent',{get(){window.hits++;return 'private'}});
    </script>`);
      const cdp = await page.context().newCDPSession(page);
      const tree = await cdp.send('Page.getFrameTree');
      const install = ({ key }: { key: string; registrationSecret: string }) => {
        Object.defineProperty(window, key, { value: { check: () => true } });
      };
      const init = (key: string) => ({
        integrity: (window as unknown as Record<string, unknown>)[key],
        nodes: new Map([['p', document.querySelector('p')]]),
        prefix: '',
      });
      const make = () =>
        IsolatedReadStore.create(page, tree.frameTree.frame.id, {
          installIntegrityFn: install,
          storeInitFn: init,
          prefix: 'x',
        });
      const store = await make();
      assert.deepEqual(await store.evaluate((value: { prefix: string }, arg: number) => [value.prefix, arg], 7), [
        'x',
        7,
      ]);
      assert.equal(await store.evaluateElement('p', element => element.textContent, null), 'public');
      assert.equal(await page.evaluate(() => (window as unknown as { hits: number }).hits), 0);
      await assert.rejects(
        store.evaluateElement('missing', element => element.textContent, null),
        { code: 'E_TARGET_NOT_FOUND' },
      );
      await assert.rejects(
        store.evaluate(() => {
          throw new Error('Snapshot field limit');
        }, null),
        { code: 'E_RESOURCE_LIMIT' },
      );
      await assert.rejects(
        store.evaluate(() => {
          throw new Error('private secret');
        }, null),
        { code: 'E_PRIVACY_BLOCKED' },
      );
      const owner = await cdp.send('DOM.getFrameOwner', { frameId: tree.frameTree.childFrames![0]!.frame.id });
      assert.equal(await store.evaluateBackendNode(owner.backendNodeId, element => element.tagName, null), 'IFRAME');
      const aborted = new AbortController();
      aborted.abort();
      await assert.rejects(
        store.evaluate(() => 1, null, aborted.signal),
        { code: 'E_CANCELLED' },
      );
      await assert.rejects(
        store.evaluate(() => 1, null),
        { code: 'E_STALE_STATE' },
      );
      await store.dispose();
      const next = await make();
      await page.goto('about:blank');
      await assert.rejects(
        next.evaluate(() => 1, null),
        { code: 'E_STALE_STATE' },
      );
      await next.dispose();
      await cdp.detach();
    } finally {
      await browser.close();
    }
  },
);
