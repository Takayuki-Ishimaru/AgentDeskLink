import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BrowserAdapter } from '../src/browser.js';
import { Engine } from '../src/core.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';

test(
  'oversized classification hints mask details in isolated reads and still reject strict sessions',
  { timeout: 30000 },
  async () => {
    const oversized = 'X'.repeat(5000) + ' token OVERSIZED_CANARY';
    let incompatible = true;
    const app = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(
        `<!doctype html><main><h1>Public page</h1><a aria-label="Safe link" href="/private-destination" title="${oversized}">Link</a><input aria-label="Account" value="SECRET_VALUE_CANARY" title="${oversized}"></main>${incompatible ? '<script>Element.prototype.matches=function(){return false}</script>' : ''}`,
      );
    });
    await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    const policy = parsePolicy({
      allowedOrigins: [origin],
      allowLoopback: true,
      browserTargets: [{ id: 'test', label: 'Test', url: origin, classification: 'PUBLIC' }],
    });
    const makeEngine = () =>
      new Engine(policy, { browser: new BrowserAdapter(policy, url => assertUrlAllowed(url, policy)) });
    try {
      const engine = makeEngine();
      try {
        const target = (await engine.listTargets()).targets[0]!;
        const session = await engine.open(target.target_id);
        assert.equal(session.read_only, true);
        const observed = await engine.observe(session.session_id, { token_budget: 8000 });
        const text = JSON.stringify(observed);
        assert.ok(!text.includes('OVERSIZED_CANARY'));
        assert.ok(!text.includes('SECRET_VALUE_CANARY'));
        assert.ok(!text.includes('private-destination'));
        const link = observed.elements!.find(element => element.name === 'Safe link');
        assert.ok(link);
        assert.equal(link.href, undefined);
        const input = observed.elements!.find(element => element.name === 'Account');
        assert.ok(input);
        assert.equal(input.value, '[redacted]');
        assert.ok(observed.elements!.some(element => element.name === 'Public page'));
      } finally {
        await engine.shutdown();
      }
      incompatible = false;
      const strict = makeEngine();
      try {
        const target = (await strict.listTargets()).targets[0]!;
        await assert.rejects(strict.open(target.target_id), { code: 'E_RESOURCE_LIMIT' });
      } finally {
        await strict.shutdown();
      }
    } finally {
      app.closeAllConnections();
      await new Promise<void>(resolve => app.close(() => resolve()));
    }
  },
);
