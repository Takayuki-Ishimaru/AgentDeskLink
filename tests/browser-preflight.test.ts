import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import type { ElementHandle, Page } from 'playwright';
import { preflightBrowserInput } from '../src/browser-preflight.js';
import { AdlError, type Action } from '../src/types.js';

const rectOf = (left: number, top: number, right: number, bottom: number) => ({
  x: left,
  y: top,
  left,
  top,
  right,
  bottom,
  width: right - left,
  height: bottom - top,
});

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
    // Layout fragments [left, top, right, bottom] of the target (default: one box) and rectangles that cover the points inside them.
    fragments: null as number[][] | null,
    covers: [] as number[][],
    hoverArgs: [] as unknown[],
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
      const f = state.fragments;
      if (!f) return rectOf(10, 20, 210, 60);
      return rectOf(
        Math.min(...f.map(r => r[0]!)),
        Math.min(...f.map(r => r[1]!)),
        Math.max(...f.map(r => r[2]!)),
        Math.max(...f.map(r => r[3]!)),
      );
    }
    getClientRects() {
      return state.fragments
        ? state.fragments.map(r => rectOf(r[0]!, r[1]!, r[2]!, r[3]!))
        : [this.getBoundingClientRect()];
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
    elementFromPoint(x = 0, y = 0) {
      return state.occluded || state.occludedStack || covered(x, y) ? other : element;
    }
    elementsFromPoint(x = 0, y = 0) {
      return state.occludedStack || covered(x, y) ? [other, element] : [state.occluded ? other : element];
    }
  }
  const covered = (x: number, y: number) => state.covers.some(c => x >= c[0]! && x < c[2]! && y >= c[1]! && y < c[3]!);
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
    hover: async (...args: unknown[]) => {
      state.events.push('hover');
      state.hoverArgs.push(...args);
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
test('browser preflight reports the verified click point and hovers exactly there', async () => {
  const f = fixture();
  const p = await preflightBrowserInput(f.page, f.handle, f.request, '#target', f.signal, () => {});
  // One fragment: the pixel centre of the box centre (110, 40), measured from the box origin (10, 20).
  assert.deepEqual(p.click, { offset: { x: 100.5, y: 20.5 }, position: { x: 100.5, y: 20.5 } });
  assert.deepEqual(f.state.hoverArgs, [{ position: { x: 100.5, y: 20.5 } }]);
});
test('browser preflight uses a layout fragment when the bounding-box centre is over other content', async () => {
  const f = fixture();
  // A link wrapped over two lines: the box centre (85, 40) lies between the fragments, under some other element.
  f.state.fragments = [
    [100, 20, 160, 40],
    [10, 40, 70, 60],
  ];
  f.state.covers = [[75, 30, 95, 50]];
  const p = await preflightBrowserInput(f.page, f.handle, f.request, '#target', f.signal, () => {});
  assert.deepEqual(p.click.offset, { x: 120.5, y: 10.5 });
  assert.deepEqual(f.state.hoverArgs, [{ position: { x: 120.5, y: 10.5 } }]);
});
test('browser preflight clicks the free fragment when the first one is covered', async () => {
  const f = fixture();
  f.state.fragments = [
    [100, 20, 160, 40],
    [10, 40, 70, 60],
  ];
  f.state.covers = [[100, 20, 160, 40]];
  const p = await preflightBrowserInput(f.page, f.handle, f.request, '#target', f.signal, () => {});
  assert.deepEqual(p.click.offset, { x: 30.5, y: 30.5 });
  assert.deepEqual(f.state.hoverArgs, [{ position: { x: 30.5, y: 30.5 } }]);
});
test('browser preflight still refuses an element whose every fragment is covered', async () => {
  const f = fixture();
  f.state.fragments = [
    [100, 20, 160, 40],
    [10, 40, 70, 60],
  ];
  f.state.covers = [[0, 0, 1000, 700]];
  await assert.rejects(
    preflightBrowserInput(f.page, f.handle, f.request, '#target', f.signal, () => {}),
    { code: 'E_NOT_INTERACTABLE', reason: 'occluded' },
  );
  assert.equal(f.state.events.length, 0);
});
test('browser preflight tests fragment centres clipped to the viewport and skips empty or offscreen fragments', async () => {
  const f = fixture();
  // Empty, fully offscreen, then a fragment partly left of the viewport: only the visible part counts (x 0..40, y 20..60).
  f.state.fragments = [
    [10, 20, 10, 60],
    [2000, 20, 2100, 60],
    [-60, 20, 40, 60],
  ];
  const p = await preflightBrowserInput(f.page, f.handle, f.request, '#target', f.signal, () => {});
  // bbox origin is (-60, 20); the visible part's pixel centre is (20.5, 40.5).
  assert.deepEqual(p.click.offset, { x: 80.5, y: 20.5 });
});
