import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { isolatedCollect } from '../src/browser-approval.js';
import { readTextPageFn } from '../src/browser-text.js';
import { BROWSER_PRIVACY_RULES, SECRET_LABEL_PATTERN } from '../src/privacy.js';

test(
  'isolated text reader ignores main-world DOM wrappers and hostile getters while masking protected text',
  { timeout: 20000 },
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<main id="target"><p>Visible copy</p><div data-adl-sensitive><p>PRIVATE_CANARY_TEXT</p></div></main><custom-panel id="custom"></custom-panel>',
      );
      const targetHandle = await page.evaluateHandle(() => document.getElementById('target'));
      const protectedHandle = await page.evaluateHandle(() => document.querySelector('div[data-adl-sensitive] p'));
      const target = targetHandle.asElement();
      const protectedNode = protectedHandle.asElement();
      assert.ok(target && protectedNode);
      await page.evaluate(() => {
        const state = { calls: 0 };
        (window as unknown as { __adlHostileState: typeof state }).__adlHostileState = state;
        for (const name of ['insertBefore', 'removeChild'] as const) {
          const original = Object.getOwnPropertyDescriptor(Node.prototype, name)!;
          Object.defineProperty(Node.prototype, name, {
            ...original,
            value: function () {
              state.calls++;
              throw new Error('DOM wrapper invoked');
            },
          });
        }
        Object.defineProperty(Element.prototype, 'matches', {
          configurable: true,
          get() {
            state.calls++;
            throw new Error('selector getter invoked');
          },
        });
        Object.defineProperty(HTMLElement.prototype, 'style', {
          configurable: true,
          get() {
            state.calls++;
            throw new Error('style getter invoked');
          },
        });
        class Panel extends HTMLElement {
          get type() {
            state.calls++;
            throw new Error('type getter invoked');
          }
          get disabled() {
            state.calls++;
            throw new Error('disabled getter invoked');
          }
          override get prefix(): string | null {
            state.calls++;
            throw new Error('prefix getter invoked');
          }
        }
        customElements.define('custom-panel', Panel);
        Object.defineProperty(window, 'HTMLElement', {
          configurable: true,
          get() {
            state.calls++;
            throw new Error('global constructor getter invoked');
          },
        });
      });
      const args = { rules: BROWSER_PRIVACY_RULES, pattern: SECRET_LABEL_PATTERN };
      const result = await isolatedCollect(target, readTextPageFn, args, [], page.mainFrame());
      assert.deepEqual(result, { text: 'Visible copy', truncated: false });
      assert.deepEqual(await isolatedCollect(protectedNode, readTextPageFn, args, [], page.mainFrame()), {
        error: 'protected',
      });
      assert.equal(
        await page.evaluate(
          () => (window as unknown as { __adlHostileState: { calls: number } }).__adlHostileState.calls,
        ),
        0,
      );
    } finally {
      await browser.close();
    }
  },
);
