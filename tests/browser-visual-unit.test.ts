import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errors, type Page } from 'playwright';
import { captureBrowserImage } from '../src/browser-visual.js';
const allowed = { enabled: true, maskSelectors: ['#private'] };
function mock(extra: Record<string, unknown> = {}) {
  const state = {
    shots: 0,
    geometry: { width: 8, height: 6, scroll_x: 0, scroll_y: 10, device_scale_factor: 1 },
    options: undefined as any,
    dom: 'unchanged',
    scriptDisabled: false,
  };
  const cdp = {
    send: async (method: string, args: any) => {
      if (method === 'Emulation.setScriptExecutionDisabled') {
        state.scriptDisabled = args.value;
        return {};
      }
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      if (method === 'Runtime.evaluate') return { result: { value: state.dom } };
      throw new Error('unexpected method');
    },
    detach: async () => {},
  };
  const page = {
    url: () => 'https://example.com/demo',
    context: () => ({ newCDPSession: async () => cdp, close: async () => {} }),
    evaluate: async () => ({ ...state.geometry }),
    locator: (selector: string) => ({ selector }),
    screenshot: async (options: unknown) => {
      state.shots++;
      state.options = options;
      return Buffer.from('PNG');
    },
    ...extra,
  } as unknown as Page;
  return { page, state };
}
test('browser visual capture requires trusted opt-in and exact current origin', async () => {
  for (const policy of [undefined, { enabled: false, maskSelectors: [] }]) {
    const { page, state } = mock();
    await assert.rejects(captureBrowserImage(page, 'https://example.com', policy, new AbortController().signal), {
      code: 'E_PRIVACY_BLOCKED',
    });
    assert.equal(state.shots, 0);
  }
  const { page, state } = mock({ url: () => 'https://other.example/' });
  await assert.rejects(captureBrowserImage(page, 'https://example.com', allowed, new AbortController().signal), {
    code: 'E_POLICY_DENIED',
  });
  assert.equal(state.shots, 0);
});
test('browser capture preserves rendered PNG and masks protected controls and frames', async () => {
  const { page, state } = mock();
  const image = await captureBrowserImage(page, 'https://example.com', allowed, new AbortController().signal);
  assert.equal(image.png.toString(), 'PNG');
  assert.equal(image.coordinate_space, 'viewport_css_pixels');
  assert.equal(image.viewport.scroll_y, 10);
  assert.equal(image.redacted, true);
  assert.ok(Number.isFinite(Date.parse(image.captured_at)));
  assert.equal(state.options.type, 'png');
  assert.equal(state.options.scale, 'css');
  assert.equal(state.options.fullPage, false);
  assert.equal(state.options.animations, 'disabled');
  assert.equal(state.options.caret, 'initial');
  assert.equal(state.scriptDisabled, false);
  const masks = state.options.mask.map((x: any) => x.selector);
  for (const selector of ['input[type="password" i]', 'iframe', '[data-adl-sensitive]', '#private'])
    assert.ok(masks.includes(selector), selector);
  assert.ok(!masks.includes('input'));
});
test('capture fails closed if DOM changes and restores script execution', async () => {
  const f = mock();
  (f.page as any).screenshot = async () => {
    f.state.dom = 'changed';
    return Buffer.from('PNG');
  };
  await assert.rejects(captureBrowserImage(f.page, 'https://example.com', allowed, new AbortController().signal), {
    code: 'E_PRIVACY_BLOCKED',
  });
  assert.equal(f.state.scriptDisabled, false);
});
test('capture rejects navigation or geometry changes while screenshot is pending', async () => {
  let changed = false;
  const { page } = mock({
    url: () => (changed ? 'https://other.example/' : 'https://example.com/'),
    screenshot: async () => {
      changed = true;
      return Buffer.from('PNG');
    },
  });
  await assert.rejects(captureBrowserImage(page, 'https://example.com', allowed, new AbortController().signal), {
    code: 'E_POLICY_DENIED',
  });
  let calls = 0;
  const second = mock({
    evaluate: async () => ({
      width: ++calls === 1 ? 8 : 9,
      height: 6,
      scroll_x: 0,
      scroll_y: 0,
      device_scale_factor: 1,
    }),
  });
  await assert.rejects(captureBrowserImage(second.page, 'https://example.com', allowed, new AbortController().signal), {
    code: 'E_STALE_STATE',
  });
});
test('capture bounds source size and cancellation, and sanitizes renderer failures', async () => {
  const huge = mock({
    evaluate: async () => ({ width: 100000, height: 100000, scroll_x: 0, scroll_y: 0, device_scale_factor: 1 }),
  });
  await assert.rejects(captureBrowserImage(huge.page, 'https://example.com', allowed, new AbortController().signal), {
    code: 'E_RESOURCE_LIMIT',
  });
  assert.equal(huge.state.shots, 0);
  const controller = new AbortController();
  controller.abort();
  const early = mock();
  await assert.rejects(captureBrowserImage(early.page, 'https://example.com', allowed, controller.signal), {
    code: 'E_CANCELLED',
  });
  assert.equal(early.state.shots, 0);
  let release!: (b: Buffer) => void;
  const cancel = new AbortController();
  const slow = mock({ screenshot: () => new Promise<Buffer>(r => (release = r)) });
  const pending = captureBrowserImage(slow.page, 'https://example.com', allowed, cancel.signal);
  while (!release) await new Promise(r => setImmediate(r));
  cancel.abort();
  release(Buffer.from('PNG'));
  await assert.rejects(pending, { code: 'E_CANCELLED' });
  const fail = mock({
    screenshot: async () => {
      throw new Error('CANARY_RENDERER_SECRET');
    },
  });
  await assert.rejects(
    captureBrowserImage(fail.page, 'https://example.com', allowed, new AbortController().signal),
    (e: Error) => !e.message.includes('CANARY'),
  );
});
test('origin is rechecked after the final geometry read and invalid mask configuration fails closed', async () => {
  let calls = 0;
  let current = 'https://example.com/';
  const { page } = mock({
    url: () => current,
    evaluate: async () => {
      if (++calls === 2) current = 'https://other.example/';
      return { width: 8, height: 6, scroll_x: 0, scroll_y: 0, device_scale_factor: 1 };
    },
  });
  await assert.rejects(captureBrowserImage(page, 'https://example.com', allowed, new AbortController().signal), {
    code: 'E_POLICY_DENIED',
  });
  const invalid = mock();
  await assert.rejects(
    captureBrowserImage(
      invalid.page,
      'https://example.com',
      { enabled: true, maskSelectors: [''] },
      new AbortController().signal,
    ),
    { code: 'E_PRIVACY_BLOCKED' },
  );
  assert.equal(invalid.state.shots, 0);
});
test('encoded PNG byte budget is enforced as resource limit', async () => {
  const { page } = mock({ screenshot: async () => Buffer.alloc(8 * 1024 * 1024 + 1) });
  await assert.rejects(captureBrowserImage(page, 'https://example.com', allowed, new AbortController().signal), {
    code: 'E_RESOURCE_LIMIT',
  });
});
test('null masks fail closed and renderer timeout retains its lifecycle error code', async () => {
  const { page } = mock();
  await assert.rejects(
    captureBrowserImage(
      page,
      'https://example.com',
      { enabled: true, maskSelectors: null as any },
      new AbortController().signal,
    ),
    { code: 'E_PRIVACY_BLOCKED' },
  );
  const timed = mock({
    screenshot: async () => {
      throw new errors.TimeoutError('CANARY_TIMEOUT');
    },
  });
  await assert.rejects(captureBrowserImage(timed.page, 'https://example.com', allowed, new AbortController().signal), {
    code: 'E_TIMEOUT',
  });
});
test('capture masks text matching the AWS access key id and labelled secret access key patterns', async () => {
  const { page, state } = mock();
  await captureBrowserImage(page, 'https://example.com', allowed, new AbortController().signal);
  const patterns = state.options.mask
    .map((x: any) => String(x.selector))
    .filter((selector: string) => selector.startsWith(':text-matches('))
    .map(
      (selector: string) =>
        new RegExp(JSON.parse(selector.slice(':text-matches('.length, selector.lastIndexOf(', "i")'))), 'i'),
    );
  const masked = (text: string) => patterns.some((pattern: RegExp) => pattern.test(text));
  for (const text of [
    'AKIAIOSFODNN7EXAMPLE',
    'Access key ASIAY34FZKBOKMUTVV7A',
    'Secret access key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  ])
    assert.equal(masked(text), true, text);
  for (const text of [
    'AKIA is the prefix of access key IDs',
    'Build 20261029 is ready for review',
    'Secret access key rotation policy',
  ])
    assert.equal(masked(text), false, text);
});
