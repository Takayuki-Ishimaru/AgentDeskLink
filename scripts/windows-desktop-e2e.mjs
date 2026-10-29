// Run in the same interactive Windows session as the two synthetic fixture apps.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const [helperPath, appPath, controlsPath, outputDir] = process.argv.slice(2);
if (!outputDir || process.platform !== 'win32') throw new Error('Windows interactive fixture paths required');
await mkdir(outputDir, { recursive: true });
const rows = [];
let client;
const http = createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(
    '<input id="q" aria-label="Reference" value="WEB-104"><button id="go" type="button" onclick="document.getElementById(\'s\').textContent=\'Checked\'">Verify</button><p id="s" role="status">Ready</p><input type="password" aria-label="Password" value="CANARY_WEB_SECRET">',
  );
});
await new Promise(r => http.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${http.address().port}`;
const policy = join(outputDir, 'e2e-policy.json');
const audit = join(outputDir, 'e2e-audit.jsonl');
await writeFile(
  policy,
  JSON.stringify({
    allowedOrigins: [origin],
    allowLoopback: true,
    actionTimeoutMs: 15000,
    auditPath: audit,
    browserTargets: [
      {
        id: 'web-fixture',
        label: 'Web fixture',
        url: origin,
        classification: 'PUBLIC',
        controls: [
          { selector: '#q', actions: ['fill'] },
          { selector: '#go', actions: ['click'] },
        ],
      },
    ],
    windows: {
      helperPath: resolve(helperPath),
      appPath: resolve(appPath),
      controlsPath: resolve(controlsPath),
      appId: 'native-fixture',
      classification: 'PUBLIC',
    },
  }),
);
const record = (name, detail = {}) => {
  rows.push({ name, ok: true, ...detail });
  console.log(JSON.stringify(rows.at(-1)));
};
try {
  client = new Client(
    { name: 'adl-windows-desktop-acceptance', version: '1.0.0' },
    { versionNegotiation: { mode: 'legacy' } },
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['dist/src/server.js', '--config', policy],
      cwd: process.cwd(),
      stderr: 'pipe',
    }),
  );
  const call = async (name, args = {}) =>
    JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  const ok = async (name, args) => {
    const r = await call(name, args);
    assert.equal(r.ok, true, `${name}: ${JSON.stringify(r.error)}`);
    return r;
  };
  const targets = (await ok('adl_targets')).targets;
  assert.equal(targets.length, 2);
  const desktop = targets.find(t => t.surface === 'desktop'),
    browser = targets.find(t => t.surface === 'browser');
  assert.equal((await call('adl_open', { target_id: desktop.target_id })).error.code, 'E_INTERFERENCE_RISK');
  record('desktop strict isolation denied');
  const ds = await ok('adl_open', { target_id: desktop.target_id, mode: 'background_semantic' });
  const bs = await ok('adl_open', { target_id: browser.target_id });
  const observe = async s => {
    const p = await ok('adl_observe', { session_id: s.session_id, token_budget: 8000 });
    assert.ok(!JSON.stringify(p).includes('CANARY_'));
    return p;
  };
  let d = await observe(ds);
  let b = await observe(bs);
  record('desktop and browser observation redacts synthetic secrets', { desktop_elements: d.elements.length });
  const find = (p, name) => {
    const e = p.elements.find(e => e.name === name);
    assert.ok(e, `Missing ${name}; ${JSON.stringify(p.elements.map(e => [e.role, e.name]))}`);
    return e;
  };
  // Denials happen before mutation; they must not alter the other foreground app.
  for (const [name, action, code] of [
    ['Delete record', 'click', 'E_APPROVAL_REQUIRED'],
    ['Unapproved control', 'click', 'E_POLICY_DENIED'],
  ]) {
    const r = await call('adl_act', {
      session_id: ds.session_id,
      action,
      element_id: find(d, name).id,
      expected_revision: d.revision,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, code);
    record(`denied: ${name}`);
  }
  // A denied native action invalidates the parent session, so reopen to continue.
  await call('adl_close', { session_id: ds.session_id });
  let current = await ok('adl_open', { target_id: desktop.target_id, mode: 'background_semantic' });
  for (let i = 0; i < 30; i++) {
    d = await observe(current);
    b = await observe(bs);
    const value = `REF-${String(i + 1).padStart(3, '0')}`;
    const task = await ok('adl_execute', {
      expected_revisions: { [current.session_id]: d.revision, [bs.session_id]: b.revision },
      steps: [
        { session_id: bs.session_id, action: 'fill', element_id: find(b, 'Reference').id, value },
        { session_id: current.session_id, action: 'fill', element_id: find(d, 'Fixture text').id, value },
        { session_id: current.session_id, action: 'click', element_id: find(d, 'Fixture button').id },
        {
          session_id: current.session_id,
          action: 'check',
          element_id: find(d, 'Fixture check').id,
          checked: i % 2 === 0,
        },
        {
          session_id: current.session_id,
          action: 'select',
          element_id: find(d, i % 2 === 0 ? 'Select beta' : 'Select alpha').id,
        },
        { session_id: bs.session_id, action: 'click', element_id: find(b, 'Verify').id },
        { session_id: bs.session_id, action: 'wait_for', role: 'status', name: 'Checked', timeout_ms: 2000 },
      ],
    });
    let state;
    for (let j = 0; j < 400; j++) {
      state = await ok('adl_task', { task_id: task.task_id });
      if (!['queued', 'running'].includes(state.status)) break;
      await delay(25);
    }
    assert.equal(state.status, 'completed', JSON.stringify(state));
    assert.equal(state.results.length, 7);
    d = await observe(current);
    b = await observe(bs);
    assert.equal(find(d, 'Fixture text').value, value);
    assert.equal(find(b, 'Reference').value, value);
    assert.equal(find(d, 'Fixture check').checked, i % 2 === 0);
    assert.equal(find(d, i % 2 === 0 ? 'Select beta' : 'Select alpha').selected, true);
    find(d, `Button clicks: ${i + 1}`);
    find(b, 'Checked');
    record(`cross-surface input variant ${i + 1}`, { steps: 7 });
  }
  d = await observe(current);
  for (const direction of ['down', 'up']) {
    await ok('adl_act', {
      session_id: current.session_id,
      action: 'scroll',
      element_id: find(d, 'Fixture scroll').id,
      direction,
      expected_revision: d.revision,
    });
    d = await observe(current);
  }
  record('desktop scroll both directions');
  const stale = await call('adl_act', {
    session_id: current.session_id,
    action: 'fill',
    element_id: find(d, 'Fixture text').id,
    value: 'should-not-apply',
    expected_revision: 1,
  });
  assert.equal(stale.error.code, 'E_STALE_STATE');
  record('stale mutation denied');
  await ok('adl_close', { session_id: current.session_id });
  await ok('adl_close', { session_id: bs.session_id });
  const log = await readFile(audit, 'utf8');
  assert.ok(!log.includes('REF-') && !log.includes('CANARY_') && !log.includes(origin));
  record('safe audit and cleanup');
  await writeFile(
    join(outputDir, 'desktop-e2e-result.json'),
    JSON.stringify({ ok: true, checks: rows, variants: 30, cross_surface_steps: 210 }, null, 2),
  );
} catch (error) {
  await writeFile(
    join(outputDir, 'desktop-e2e-result.json'),
    JSON.stringify({ ok: false, checks: rows, error: String(error) }, null, 2),
  );
  throw error;
} finally {
  await client?.close();
  http.closeAllConnections();
  await new Promise(r => http.close(r));
}
