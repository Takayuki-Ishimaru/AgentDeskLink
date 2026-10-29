import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { Engine } from '../src/core.js';
import { BrowserAdapter } from '../src/browser.js';
import { parsePolicy, assertUrlAllowed } from '../src/policy.js';
import { AdlError } from '../src/types.js';

test(
  'ask mode binds local approval to one browser form submission and never sends the secret to broker',
  { timeout: 30000 },
  async () => {
    const saved = [process.env.ADL_APPROVAL_URL, process.env.ADL_APPROVAL_TOKEN, process.env.ADL_APPROVAL_EPOCH];
    const token = randomBytes(32).toString('base64url'),
      epoch = randomUUID();
    let request: any,
      approved = false,
      submissions = 0,
      wire = '',
      change = false,
      notify!: () => void;
    const changed = new Promise<void>(resolve => {
      notify = resolve;
    });
    const broker = createServer(async (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      const parts: Buffer[] = [];
      for await (const c of req) parts.push(Buffer.from(c));
      const data = Buffer.concat(parts).toString();
      wire += data;
      if (req.method === 'POST') {
        request = JSON.parse(data);
      }
      if (!request) {
        res.writeHead(404);
        res.end();
        return;
      }
      const status = req.method === 'DELETE' ? 'consumed' : approved ? 'approved' : 'pending';
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          v: 1,
          request_id: request.request_id,
          binding: request.binding,
          status,
          expires_at: request.expires_at,
          ...(req.method === 'DELETE' ? { consumed_now: approved } : {}),
        }),
      );
    });
    await new Promise<void>(resolve => broker.listen(0, '127.0.0.1', resolve));
    process.env.ADL_APPROVAL_URL = `http://127.0.0.1:${(broker.address() as { port: number }).port}`;
    process.env.ADL_APPROVAL_TOKEN = token;
    process.env.ADL_APPROVAL_EPOCH = epoch;
    const app = createServer(async (req, res) => {
      if (req.method === 'POST') {
        submissions++;
        for await (const _ of req) {
        }
        res.end('<p>Done</p>');
        return;
      }
      if (req.url === '/poll') {
        res.end(change ? 'change' : 'wait');
        return;
      }
      if (req.url === '/changed') {
        notify();
        res.end('ok');
        return;
      }
      res.end(
        '<button id="open" type="button">Open</button><form method="post" action="/submit"><input type="password" name="password" value="CANARY_SECRET_FORM"><button id="send">Send</button></form><script>let done=false;setInterval(async()=>{if(!done&&(await (await fetch("/poll")).text())==="change"){done=true;document.querySelector("input").value="CHANGED_SECRET";fetch("/changed")}},50)</script>',
      );
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
      let observed = await engine.observe(session.session_id, { token_budget: 8000 });
      const open = observed.elements!.find(e => e.name === 'Open')!;
      await engine.act(session.session_id, { action: 'click', element_id: open.id }, observed.revision);
      observed = await engine.observe(session.session_id, { token_budget: 8000 });
      const send = observed.elements!.find(e => e.name === 'Send')!;
      const action = { action: 'click' as const, element_id: send.id };
      await assert.rejects(
        engine.act(session.session_id, action, observed.revision),
        (error: unknown) =>
          error instanceof AdlError && error.code === 'E_APPROVAL_REQUIRED' && typeof error.requestId === 'string',
      );
      assert.equal(submissions, 0);
      assert.ok(!wire.includes('CANARY_SECRET_FORM'));
      assert.ok(request.summary.details.some((item: string) => item.includes('POST') && item.includes('/submit')));
      assert.ok(request.summary.details.some((item: string) => item.includes('[secret')));
      assert.equal((await engine.approvals()).requests[0]?.status, 'pending');
      approved = true;
      await engine.act(session.session_id, action, observed.revision);
      assert.equal(submissions, 1);
      assert.equal((await engine.approvals()).requests.length, 0);
      approved = false;
      const other = await engine.open((await engine.listTargets()).targets[0]!.target_id);
      const before = await engine.observe(other.session_id, { token_budget: 8000 });
      const sendAgain = before.elements!.find(e => e.name === 'Send')!;
      await assert.rejects(
        engine.act(other.session_id, { action: 'click', element_id: sendAgain.id }, before.revision),
        { code: 'E_APPROVAL_REQUIRED' },
      );
      approved = true;
      change = true;
      await changed;
      await assert.rejects(
        engine.act(other.session_id, { action: 'click', element_id: sendAgain.id }, before.revision),
        { code: 'E_STALE_STATE' },
      );
      assert.equal(submissions, 1);
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
