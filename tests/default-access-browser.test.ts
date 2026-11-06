import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Engine } from '../src/core.js';
import { BrowserAdapter } from '../src/browser.js';
import { extensionPolicy, DEFAULT_PERMISSIONS } from '../src/bundled-policy.js';
import { assertUrlAllowed } from '../src/policy.js';

async function app() {
  const writes: string[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
      });
      req.on('end', () => {
        writes.push(body);
        res.end('saved');
      });
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      "<label>Memo<input oninput=\"fetch('/save',{method:'POST',body:this.value}).then(()=>document.querySelector('output').textContent='Saved')\"></label><output role=\"status\">Ready</output>",
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    writes,
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

test('fresh defaults open an unregistered URL and allow its ordinary autosave', { timeout: 30000 }, async () => {
  const a = await app(),
    p = extensionPolicy(undefined, process.platform, DEFAULT_PERMISSIONS);
  const browser = new BrowserAdapter(p, (url, purpose) => assertUrlAllowed(url, p, undefined, purpose));
  const e = new Engine(p, { browser });
  try {
    assert.deepEqual((await e.listTargets()).targets, []);
    const session = await e.openUrl(a.origin);
    const before = await e.observe(session.session_id);
    const input = before.elements!.find(el => el.role === 'textbox')!;
    const result = await e.act(
      session.session_id,
      { action: 'fill', element_id: input.id, value: 'draft saved once' },
      before.revision,
    );
    assert.equal(result.ok, true);
    assert.equal('write_blocked' in result, false);
    assert.ok('save' in result);
    assert.equal(result.save?.next_step, 'observe');
    assert.deepEqual(a.writes, ['draft saved once']);
    const after = await e.observe(session.session_id);
    assert.ok(after.elements?.some(el => el.name === 'Saved'));
    assert.equal(e.capabilities().permissions.origins, 'all_allowed');
  } finally {
    await e.shutdown();
    await a.close();
  }
});

test(
  'broad read-only navigation crosses origins without granting writes or physical input',
  { timeout: 30000 },
  async () => {
    const a = await app(),
      b = await app();
    const p = extensionPolicy(undefined, process.platform, {
      ...DEFAULT_PERMISSIONS,
      allowAllOperations: false,
      operationMode: 'read_only',
      allowPhysicalInput: false,
    });
    const e = new Engine(p, { browser: new BrowserAdapter(p, url => assertUrlAllowed(url, p)) });
    try {
      const session = await e.openUrl(a.origin);
      const before = await e.observe(session.session_id);
      const moved = await e.act(session.session_id, { action: 'navigate', url: b.origin }, before.revision);
      assert.equal(moved.ok, true);
      const after = await e.observe(session.session_id);
      assert.ok(after.url?.startsWith(b.origin));
      await assert.rejects(
        e.act(
          session.session_id,
          { action: 'fill', element_id: after.elements!.find(el => el.role === 'textbox')!.id, value: 'blocked' },
          after.revision,
        ),
        { code: 'E_POLICY_DENIED' },
      );
      assert.deepEqual([...a.writes, ...b.writes], []);
    } finally {
      await e.shutdown();
      await a.close();
      await b.close();
    }
  },
);

test('explicit loopback denial survives the broad origin defaults', async () => {
  const p = extensionPolicy(undefined, process.platform, { ...DEFAULT_PERMISSIONS, allowLoopback: false });
  await assert.rejects(assertUrlAllowed('http://127.0.0.1:1234/', p), { code: 'E_POLICY_DENIED' });
});
