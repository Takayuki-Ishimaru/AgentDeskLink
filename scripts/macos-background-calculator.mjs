// Explicit live test: no physical input, no foreground activation, no user app quit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test(
  'real Calculator lifecycle and arithmetic preserve the human foreground, focus and pointer',
  { timeout: 60000, skip: process.platform !== 'darwin' },
  async () => {
    const root = process.cwd(),
      out = resolve(process.env.ADL_PROOF_DIR ?? `artifacts/background-calculator-${Date.now()}`);
    await mkdir(out, { recursive: true });
    const config = resolve(out, 'policy.json');
    await writeFile(
      config,
      JSON.stringify(
        {
          actionTimeoutMs: 12000,
          macos: {
            helperPath: resolve('native/macos-ax/build/adl-macos-ax-helper'),
            appId: 'com.apple.calculator',
            appPath: '/System/Applications/Calculator.app/Contents/MacOS/Calculator',
            controlsPath: resolve('config/macos-calculator.controls.json'),
            classification: 'PUBLIC',
            lifecycle: { enabled: true },
          },
        },
        null,
        2,
      ),
    );
    const clients = [],
      records = [];
    let monitor,
      launched = false,
      quit = false,
      success = false,
      monitorResult;
    const connect = async () => {
      const client = new Client(
        { name: 'adl-background-calculator-live', version: '1.0.0' },
        { versionNegotiation: { mode: 'legacy' } },
      );
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [resolve('dist/src/server.js'), '--config', config],
          cwd: root,
          stderr: 'pipe',
        }),
      );
      clients.push(client);
      return client;
    };
    const call = async (client, name, args = {}, expectedError) => {
      const raw = await client.callTool({ name, arguments: args }, {}, { timeout: 20000 });
      const data = JSON.parse(raw.content.find(c => c.type === 'text').text);
      records.push({ tool: name, args, result: data });
      if (expectedError) assert.equal(data.error?.code, expectedError, JSON.stringify(data));
      else assert.equal(data.ok, true, JSON.stringify(data));
      return data;
    };
    const app = (client, action, error) =>
      call(client, 'adl_app', { application_id: 'com.apple.calculator', action }, error);
    let client;
    try {
      client = await connect();
      assert.equal(
        (await app(client, 'status')).running,
        false,
        'Close Calculator before this test; an existing human instance is never terminated.',
      );
      monitor = spawn(resolve('native/macos-ax/build/adl-macos-monitor'), [], { stdio: ['pipe', 'pipe', 'pipe'] });
      const lines = [],
        waiters = [];
      createInterface({ input: monitor.stdout }).on('line', line => {
        const row = JSON.parse(line),
          w = waiters.shift();
        if (w) {
          clearTimeout(w.timer);
          w.resolve(row);
        } else lines.push(row);
      });
      monitor.stderr.resume();
      monitor.next = () =>
        lines.length
          ? Promise.resolve(lines.shift())
          : new Promise((resolve, reject) => {
              const w = { resolve, timer: setTimeout(() => reject(new Error('monitor deadline')), 5000) };
              waiters.push(w);
            });
      assert.equal((await monitor.next()).ready, true);
      assert.equal((await call(client, 'adl_applications')).applications[0].application_id, 'com.apple.calculator');
      const started = await app(client, 'launch');
      launched = started.managed;
      assert.equal(launched, true);
      assert.equal(started.changed, true);
      assert.equal((await app(client, 'launch')).changed, false, 'launch is idempotent');
      const other = await connect();
      assert.equal((await app(other, 'status')).managed, false);
      await app(other, 'quit', 'E_POLICY_DENIED');
      await other.close();
      await call(client, 'adl_app', { application_id: 'com.other.app', action: 'launch' }, 'E_POLICY_DENIED');
      const capabilities = await call(client, 'adl_capabilities');
      assert.equal(capabilities.physical_input.configured, false);
      let target;
      for (let attempt = 0; attempt < 30 && !target; attempt++) {
        target = (await call(client, 'adl_targets', { surface: 'desktop' })).targets.find(t => !t.capture_only);
        if (!target) await delay(100);
      }
      assert.ok(target, 'Calculator window appeared');
      await call(client, 'adl_open', { target_id: target.target_id, mode: 'interactive_desktop' }, 'E_POLICY_DENIED');
      const session = await call(client, 'adl_open', { target_id: target.target_id, mode: 'background_semantic' });
      for (const names of [
        ['すべて消去', 'All Clear', 'Clear All', 'AC'],
        ['4'],
        ['2'],
        ['加算', 'Add', 'Addition', '+'],
        ['1'],
        ['7'],
        ['計算実行', 'Equals', 'Calculate', '='],
      ]) {
        const state = await call(client, 'adl_observe', { session_id: session.session_id, token_budget: 8000 });
        assert.equal(state.truncated, false);
        const button = state.elements.find(e => e.role === 'button' && names.includes(e.name));
        assert.ok(button, `missing button ${names}`);
        await call(client, 'adl_act', {
          session_id: session.session_id,
          expected_revision: state.revision,
          action: 'click',
          element_id: button.id,
          expected_target: { role: 'button', name: button.name },
        });
      }
      let after;
      for (let attempt = 0; attempt < 10; attempt++) {
        after = await call(client, 'adl_observe', { session_id: session.session_id, token_budget: 8000 });
        if (after.elements.some(e => e.role === 'text' && e.value === '59')) break;
        await delay(30);
      }
      assert.ok(after.elements.some(e => e.role === 'text' && e.value === '59'));
      await writeFile(resolve(out, 'calculator-after.json'), JSON.stringify(after, null, 2));
      assert.equal((await app(client, 'quit')).running, false);
      quit = true;
      await call(client, 'adl_observe', { session_id: session.session_id }, 'E_TARGET_NOT_FOUND');
      assert.equal((await app(client, 'status')).running, false);
      assert.equal((await app(client, 'quit')).changed, false);
      monitor.stdin.end();
      monitorResult = await monitor.next();
      assert.ok(monitorResult.samples > 0);
      assert.equal(monitorResult.probe_errors, 0);
      assert.equal(monitorResult.foreground_changed_samples, 0);
      assert.equal(monitorResult.focus_changed_samples, 0);
      assert.equal(monitorResult.cursor_changed_samples, 0);
      success = true;
    } finally {
      if (client && launched && !quit) await app(client, 'quit').catch(() => {});
      if (monitor && !monitorResult) {
        monitor.stdin.end();
        monitorResult = await monitor.next().catch(() => ({ error: 'monitor unavailable' }));
      }
      await Promise.allSettled(clients.map(c => c.close()));
      await writeFile(resolve(out, 'mcp-transcript.json'), JSON.stringify(records, null, 2));
      await writeFile(
        resolve(out, 'verification.json'),
        JSON.stringify(
          {
            ok: success,
            application: 'macOS Calculator',
            arithmetic: '42 + 17 = 59',
            mode: 'background_semantic',
            physical_input: false,
            monitor: monitorResult,
            app_terminated: quit,
            mcp_calls: records.length,
          },
          null,
          2,
        ),
      );
      if (monitor && monitor.exitCode === null) monitor.kill('SIGTERM');
      console.log(`Evidence: ${out}`);
    }
  },
);
