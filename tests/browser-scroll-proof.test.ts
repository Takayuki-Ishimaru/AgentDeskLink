import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';

// Regression for the v0.1.6 evaluation: CDP DOM.getNodeForLocation takes
// document coordinates, so proofs for elements below the first viewport must
// add the scroll offset. standard/ask modes use those proofs for every action.
async function setup(html: string, operationMode: 'standard' | 'ask' = 'standard', visual = false, frame = '') {
  const app = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/frame' ? `<!doctype html>${frame}` : `<!doctype html><title>Long</title>${html}`);
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  const policy = parsePolicy({
    allowedOrigins: [origin],
    allowLoopback: true,
    operationMode,
    actionTimeoutMs: 5000,
    browserTargets: [
      {
        id: 'long',
        label: 'Long page',
        url: origin,
        classification: 'PUBLIC',
        ...(visual ? { visual: { enabled: true, maskSelectors: [] } } : {}),
      },
    ],
  });
  const engine = new Engine(policy, { browser: new BrowserAdapter(policy, url => assertUrlAllowed(url, policy)) });
  const session = await engine.open((await engine.listTargets()).targets[0]!.target_id);
  return {
    engine,
    session,
    close: async () => {
      await engine.shutdown();
      app.closeAllConnections();
      await new Promise<void>(resolve => app.close(() => resolve()));
    },
  };
}

const filler = Array.from(
  { length: 60 },
  (_, i) => `<p>Paragraph ${i} with enough text to occupy vertical space in the page.</p>`,
).join('');

test('standard mode acts on controls that need scrolling into view', { timeout: 30000 }, async () => {
  const f = await setup(`${filler}<label><input type="checkbox" id="agree"> Agree to terms</label>
    <input id="nick" aria-label="Nickname"><select id="size" aria-label="Size"><option>S</option><option>M</option></select>
    <button id="more" onclick="document.getElementById('out').textContent='clicked'">Show more</button><p id="out">idle</p>`);
  try {
    let view = await f.engine.observe(f.session.session_id, { token_budget: 8000 });
    const find = (name: string) => view.elements!.find(e => e.name === name)!;
    let r = await f.engine.act(
      f.session.session_id,
      { action: 'check', element_id: find('Agree to terms').id, checked: true },
      view.revision,
    );
    assert.equal(r.ok, true);
    view = await f.engine.observe(f.session.session_id, { token_budget: 8000 });
    assert.equal(find('Agree to terms').checked, true);
    r = await f.engine.act(
      f.session.session_id,
      { action: 'fill', element_id: find('Nickname').id, value: 'taro' },
      view.revision,
    );
    assert.equal(r.ok, true);
    view = await f.engine.observe(f.session.session_id, { token_budget: 8000 });
    r = await f.engine.act(
      f.session.session_id,
      { action: 'select', element_id: find('Size').id, value: 'M' },
      view.revision,
    );
    assert.equal(r.ok, true);
    view = await f.engine.observe(f.session.session_id, { token_budget: 8000 });
    r = await f.engine.act(f.session.session_id, { action: 'click', element_id: find('Show more').id }, view.revision);
    assert.equal(r.ok, true);
    view = await f.engine.observe(f.session.session_id, { token_budget: 8000 });
    assert.ok(view.elements!.some(e => e.name === 'clicked'));
  } finally {
    await f.close();
  }
});

test('a control scrolled out of view again is proven at its new document position', { timeout: 30000 }, async () => {
  const f = await setup(`<button id="top" onclick="this.textContent='top clicked'">Top button</button>${filler}${filler}
    <button id="bottom" onclick="this.textContent='bottom clicked'">Bottom button</button>`);
  try {
    let view = await f.engine.observe(f.session.session_id, { token_budget: 8000 });
    const bottom = view.elements!.find(e => e.name === 'Bottom button')!;
    let r = await f.engine.act(f.session.session_id, { action: 'click', element_id: bottom.id }, view.revision);
    assert.equal(r.ok, true);
    view = await f.engine.observe(f.session.session_id, { token_budget: 8000 });
    // The page is now scrolled to the bottom; the top control needs scrolling back.
    const top = view.elements!.find(e => e.name === 'Top button')!;
    r = await f.engine.act(f.session.session_id, { action: 'click', element_id: top.id }, view.revision);
    assert.equal(r.ok, true);
    view = await f.engine.observe(f.session.session_id, { token_budget: 8000 });
    assert.ok(view.elements!.some(e => e.name === 'top clicked'));
    assert.ok(view.elements!.some(e => e.name === 'bottom clicked'));
  } finally {
    await f.close();
  }
});

test('a captured-frame point click resolves its target after the page scrolled', { timeout: 30000 }, async () => {
  const f = await setup(
    `<button id="pin" style="position:fixed;left:10px;top:10px;width:200px;height:50px"
    onclick="this.textContent='pinned clicked'">Pinned action</button>${filler}${filler}<p id="end">End of page</p>`,
    'standard',
    true,
  );
  try {
    let view = await f.engine.observe(f.session.session_id, { token_budget: 8000 });
    const end = view.elements!.find(e => e.name === 'End of page')!;
    let r = await f.engine.act(f.session.session_id, { action: 'scroll', element_id: end.id }, view.revision);
    assert.equal(r.ok, true);
    const frame = await f.engine.capture(f.session.session_id, {});
    r = await f.engine.act(
      f.session.session_id,
      { action: 'click', point: { frame_id: frame.metadata.frame_id, x: 100, y: 35 } },
      frame.metadata.revision,
    );
    assert.equal(r.ok, true);
    view = await f.engine.observe(f.session.session_id, { token_budget: 8000 });
    assert.ok(view.elements!.some(e => e.name === 'pinned clicked'));
  } finally {
    await f.close();
  }
});

test('a same-origin iframe below the fold is operable in standard mode', { timeout: 30000 }, async () => {
  const f = await setup(
    `${filler}<iframe src="/frame" title="Embedded form" style="width:400px;height:200px"></iframe>`,
    'standard',
    false,
    `<p style="height:300px">Frame intro</p><button onclick="this.textContent='frame clicked'">Frame button</button>`,
  );
  try {
    let view = await f.engine.observe(f.session.session_id, { token_budget: 8000 });
    const button = view.elements!.find(e => e.name === 'Frame button')!;
    assert.ok(button, 'the frame control is observed');
    const r = await f.engine.act(f.session.session_id, { action: 'click', element_id: button.id }, view.revision);
    assert.equal(r.ok, true);
    view = await f.engine.observe(f.session.session_id, { token_budget: 8000 });
    assert.ok(view.elements!.some(e => e.name === 'frame clicked'));
  } finally {
    await f.close();
  }
});

test('long text below the fold can be read in standard mode', { timeout: 30000 }, async () => {
  const long = 'Lorem ipsum dolor sit amet. '.repeat(60);
  const f = await setup(`${filler}<article id="body" aria-label="Release notes"><p>${long}</p></article>`);
  try {
    const view = await f.engine.observe(f.session.session_id, { token_budget: 8000 });
    const target = view.elements!.find(e => e.name_truncated === true && e.name.startsWith('Lorem'))!;
    assert.ok(target, 'a clipped long-text element is observed');
    const read = await f.engine.observe(f.session.session_id, {
      text: { element_id: target.id, offset: 0, length: 2048 },
      token_budget: 4000,
    });
    assert.ok(read.text!.content.startsWith('Lorem ipsum'));
    assert.ok(read.text!.total_length > 512);
  } finally {
    await f.close();
  }
});
