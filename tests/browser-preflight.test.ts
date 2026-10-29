import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import type { ElementHandle, Page } from 'playwright';
import { preflightBrowserInput } from '../src/browser-preflight.js';
import { AdlError, type Action } from '../src/types.js';

function fixture(action: 'click' | 'fill' = 'click') {
  const state = {
    occluded: false,
    occludedStack: false,
    replaced: false,
    focusRedirect: false,
    disabled: false,
    connected: true,
    count: 1,
    origin: 'https://example.com',
    name: 'Reference',
    events: [] as string[],
    onHover: () => {},
    onFocus: () => {},
    onEvaluate: () => {},
  };
  class FakeElement {
    getRootNode() {
      return document;
    }
    // Prototype accessors, like real DOM nodes: the probe reads through the prototype chain so form/document named properties cannot shadow APIs.
    get tagName() {
      return action === 'fill' ? 'INPUT' : 'BUTTON';
    }
    get id() {
      return 'target';
    }
    get isContentEditable() {
      return false;
    }
    get readOnly() {
      return false;
    }
    get type() {
      return 'text';
    }
    get parentElement() {
      return null;
    }
    get isConnected() {
      return state.connected;
    }
    get disabled() {
      return state.disabled;
    }
    get innerText() {
      return state.name;
    }
    get textContent() {
      return state.name;
    }
    getBoundingClientRect() {
      return { x: 10, y: 20, left: 10, top: 20, right: 210, bottom: 60, width: 200, height: 40 };
    }
    getClientRects() {
      return [this.getBoundingClientRect()];
    }
    checkVisibility() {
      return true;
    }
    contains(node: unknown) {
      return node === this;
    }
    matches(selector: string) {
      return selector === '#target';
    }
    closest(selector: string) {
      return selector === 'form' ? null : null;
    }
    getAttribute(name: string) {
      return (
        (
          {
            id: 'target',
            'aria-label': state.name,
            type: 'text',
            role: action === 'fill' ? 'textbox' : 'button',
          } as Record<string, string>
        )[name] ?? null
      );
    }
    hasAttribute(name: string) {
      return name === 'readonly' ? this.readOnly : false;
    }
    focus() {
      document.activeElement = state.focusRedirect ? other : this;
      state.onFocus();
    }
  }
  const element = new FakeElement(),
    other = new FakeElement();
  class FakeDocument {
    declare activeElement: FakeElement | null;
    querySelectorAll() {
      return state.replaced ? [other] : Array.from({ length: state.count }, () => element);
    }
    querySelector() {
      return state.replaced ? other : element;
    }
    elementFromPoint() {
      return state.occluded || state.occludedStack ? other : element;
    }
    elementsFromPoint() {
      return state.occludedStack ? [other, element] : [state.occluded ? other : element];
    }
  }
  // activeElement is a prototype accessor (real documents expose it that way); the instance keeps the focused element.
  Object.defineProperty(FakeDocument.prototype, 'activeElement', {
    get(this: { focused?: FakeElement | null }) {
      return this.focused ?? null;
    },
    set(this: { focused?: FakeElement | null }, value: FakeElement | null) {
      this.focused = value;
    },
    configurable: true,
  });
  const document = new FakeDocument();
  const run = (fn: unknown, arg: unknown) =>
    runInNewContext(`(${String(fn)})(element,arg)`, {
      element,
      arg,
      document,
      window: {
        innerWidth: 1000,
        innerHeight: 700,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
        location: { origin: state.origin },
      },
      location: { origin: state.origin },
      Element: FakeElement,
      HTMLElement: FakeElement,
      HTMLInputElement: FakeElement,
      HTMLTextAreaElement: FakeElement,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', pointerEvents: 'auto' }),
      Number,
      Math,
      URL,
    });
  const handle = {
    evaluate: async (fn: unknown, arg: unknown) => {
      const value = run(fn, arg);
      state.onEvaluate();
      return value;
    },
    hover: async () => {
      state.events.push('hover');
      state.onHover();
    },
    focus: async () => {
      state.events.push('focus');
      element.focus();
    },
    scrollIntoViewIfNeeded: async () => {},
    boundingBox: async () => element.getBoundingClientRect(),
    isVisible: async () => true,
    isEnabled: async () => !state.disabled,
  } as unknown as ElementHandle;
  const page = {
    url: () => state.origin + '/',
    isClosed: () => false,
    locator: () => ({ count: async () => state.count }),
  } as unknown as Page;
  const request: Action = {
    action,
    element_id: 'e',
    expected_target: { role: action === 'fill' ? 'textbox' : 'button', name: 'Reference' },
  };
  return { state, page, handle, request, signal: new AbortController().signal };
}
test('browser preflight verifies actual hovered target and intended role/name before click', async () => {
  const f = fixture();
  const p = await preflightBrowserInput(f.page, f.handle, f.request, '#target', f.signal, () => {});
  assert.equal(p.pointer_on_target, true);
  assert.equal(p.target.name, 'Reference');
  assert.equal(p.target.role, 'button');
  assert.ok(f.state.events.includes('hover'));
  assert.ok(!f.state.events.includes('focus'));
});
test('browser preflight rejects an overlay even when the intended element remains lower in the hit stack', async () => {
  const f = fixture();
  f.state.occludedStack = true;
  await assert.rejects(
    preflightBrowserInput(f.page, f.handle, f.request, '#target', f.signal, () => {}),
    { code: 'E_NOT_INTERACTABLE', reason: 'occluded' },
  );
  assert.equal(f.state.events.length, 0);
});
test('browser preflight stops before hover when cancellation arrives during the target probe', async () => {
  const f = fixture(),
    abort = new AbortController();
  f.state.onEvaluate = () => abort.abort();
  await assert.rejects(
    preflightBrowserInput(f.page, f.handle, f.request, '#target', abort.signal, () => {}),
    { code: 'E_CANCELLED' },
  );
  assert.equal(f.state.events.length, 0);
});
test('browser preflight supports legacy clients while anchoring the current target identity', async () => {
  const f = fixture();
  delete f.request.expected_target;
  const result = await preflightBrowserInput(f.page, f.handle, f.request, '#target', f.signal, () => {});
  assert.equal(result.target.name, 'Reference');
});
test('browser preflight focuses fill target and proves exact active element without entering data', async () => {
  const f = fixture('fill');
  const p = await preflightBrowserInput(f.page, f.handle, f.request, '#target', f.signal, () => {});
  assert.equal(p.focus_matches_target, true);
  assert.ok(f.state.events.includes('focus'));
  assert.equal(p.target.role, 'textbox');
});
test('browser preflight refuses mismatched intent and known sensitive/consequential names', async () => {
  for (const name of ['Other', 'Password', 'Pay now']) {
    const f = fixture();
    f.state.name = name;
    await assert.rejects(preflightBrowserInput(f.page, f.handle, f.request, '#target', f.signal, () => {}));
    assert.ok(!f.state.events.includes('focus'));
  }
});
test('browser preflight rechecks hover overlays, replacement and disabled target', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.state.occluded = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.replaced = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.connected = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.disabled = true;
    },
  ]) {
    const f = fixture();
    f.state.onHover = () => change(f);
    await assert.rejects(preflightBrowserInput(f.page, f.handle, f.request, '#target', f.signal, () => {}));
  }
});
test('browser preflight prevents input after focus redirect or identity replacement', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.state.focusRedirect = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.onFocus = () => {
        f.state.replaced = true;
      };
    },
  ]) {
    const f = fixture('fill');
    change(f);
    await assert.rejects(preflightBrowserInput(f.page, f.handle, f.request, '#target', f.signal, () => {}));
  }
});
test('browser preflight stops on cancellation and document invalidation', async () => {
  const f = fixture(),
    c = new AbortController();
  c.abort();
  await assert.rejects(
    preflightBrowserInput(f.page, f.handle, f.request, '#target', c.signal, () => {}),
    { code: 'E_CANCELLED' },
  );
  assert.equal(f.state.events.length, 0);
  const g = fixture();
  await assert.rejects(
    preflightBrowserInput(g.page, g.handle, g.request, '#target', g.signal, () => {
      throw new AdlError('E_STALE_STATE');
    }),
    { code: 'E_STALE_STATE' },
  );
  assert.equal(g.state.events.length, 0);
});
