import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { Engine } from '../src/core.js';
import { BrowserAdapter } from '../src/browser.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import { AdlError } from '../src/types.js';

const FORM =
  '<form method="post" action="/submit"><input type="checkbox" name="agree" value="yes"><input type="radio" name="plan" value="basic" checked><input type="radio" name="plan" value="pro"><input name="nickname" value="Taro"><input type="hidden" name="ref" value="abc"><select name="color"><option value="red">Red</option><option value="blue" selected>Blue</option></select><input name="off" value="x" disabled><input value="unnamed"><button id="save" name="act" value="save">Save</button><button name="other" value="o">Other</button></form>';

test(
  'approval details list only the controls a submission would send, with the submitter',
  { timeout: 30000 },
  async () => {
    const saved = [process.env.ADL_APPROVAL_URL, process.env.ADL_APPROVAL_TOKEN, process.env.ADL_APPROVAL_EPOCH];
    const token = randomBytes(32).toString('base64url'),
      epoch = randomUUID();
    let request: any;
    const broker = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      const parts: Buffer[] = [];
      for await (const c of req) parts.push(Buffer.from(c));
      const data = Buffer.concat(parts).toString();
      if (req.method === 'POST') request = JSON.parse(data);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          v: 1,
          request_id: request.request_id,
          binding: request.binding,
          status: 'pending',
          expires_at: request.expires_at,
        }),
      );
    });
    await new Promise<void>(resolve => broker.listen(0, '127.0.0.1', resolve));
    process.env.ADL_APPROVAL_URL = `http://127.0.0.1:${(broker.address() as { port: number }).port}`;
    process.env.ADL_APPROVAL_TOKEN = token;
    process.env.ADL_APPROVAL_EPOCH = epoch;
    let submissions = 0;
    const app = createServer(async (req, res) => {
      if (req.method === 'POST') {
        submissions++;
        for await (const _ of req) {
        }
        res.end('<p>Done</p>');
        return;
      }
      res.setHeader('content-type', 'text/html');
      res.end(FORM);
    });
    await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
    const policy = parsePolicy({
      operationMode: 'ask',
      allowedOrigins: [origin],
      allowLoopback: true,
      browserTargets: [{ id: 'a', label: 'Fixture', url: origin, classification: 'PUBLIC' }],
    });
    const engine = new Engine(policy, { browser: new BrowserAdapter(policy, url => assertUrlAllowed(url, policy)) });
    try {
      const session = await engine.open((await engine.listTargets()).targets[0]!.target_id);
      const observed = await engine.observe(session.session_id, { token_budget: 8000 });
      const save = observed.elements!.find(e => e.name === 'Save')!;
      assert.ok(save);
      await assert.rejects(
        engine.act(session.session_id, { action: 'click', element_id: save.id }, observed.revision),
        (error: unknown) =>
          error instanceof AdlError && error.code === 'E_APPROVAL_REQUIRED' && typeof error.requestId === 'string',
      );
      assert.equal(submissions, 0);
      assert.deepEqual(request.summary.details, [
        `Form POST ${origin}/submit`,
        '"plan": "basic"',
        '"nickname": "Taro"',
        '"ref": [secret, 3 characters]',
        '"color": "blue"',
        '"act": "save"',
      ]);
      assert.equal(request.summary.risk, 'consequential');
    } finally {
      await engine.shutdown();
      app.closeAllConnections();
      broker.closeAllConnections();
      await Promise.all([
        new Promise<void>(r => app.close(() => r())),
        new Promise<void>(r => broker.close(() => r())),
      ]);
      for (const [key, value] of [
        ['ADL_APPROVAL_URL', saved[0]],
        ['ADL_APPROVAL_TOKEN', saved[1]],
        ['ADL_APPROVAL_EPOCH', saved[2]],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);
