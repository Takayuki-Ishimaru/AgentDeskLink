import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeDesktopAdapter, type NativeDesktopOptions } from '../src/desktop.js';
import { WindowsAdapter } from '../src/windows.js';
import { MacOSAdapter } from '../src/macos.js';
import { LinuxAdapter } from '../src/linux.js';
import { Engine } from '../src/core.js';
import { isNativeConsequential, parsePolicy } from '../src/policy.js';
import { AdlError, safeError, type Action, type Adapter, type DesktopConfig } from '../src/types.js';

// Protocol-faithful stand-in for the Windows / macOS helpers' standard and ask tiers (same flags, codes and the one-shot `approved` field).
// Every request is appended to FAKE_LOG so a test can prove how often the helper saw `approved:true`.
const HELPER = `#!/usr/bin/env node
import{createInterface}from'node:readline';
import{appendFileSync,existsSync}from'node:fs';
const APP=process.env.FAKE_APP_ID||'com.example.notes';
const SPACE=process.env.FAKE_SPACE||'desktop_physical_pixels';
const args=process.argv.slice(2);
const allowAll=args.includes('--allow-all'),controls=args.includes('--controls-file'),mode=args.includes('--operation-mode')?args[args.indexOf('--operation-mode')+1]:undefined;
const tier=mode==='standard'||mode==='ask';
const out=o=>process.stdout.write(JSON.stringify(o)+'\\n');
const win={target_id:'t-fixture',application_id:APP,label:'Notes window',window:{bounds:{x:0,y:0,width:400,height:300,coordinate_space:SPACE},display_ids:['d1'],minimized:false}};
let label='Status: ready',rev=1,seq=0,external=false;const sessions=new Set();
const elements=()=>[{id:'e1',role:'window',name:'Notes window',enabled:true},{id:'e2',role:'text',name:label,enabled:true},{id:'e3',role:'button',name:'Run',enabled:true},{id:'e4',role:'button',name:'Delete all',enabled:true},{id:'e5',role:'edit',name:'Password',enabled:true,sensitive:true},{id:'e6',role:'edit',name:'Name',value:'',enabled:true},{id:'e7',role:'edit',name:'Send to',value:'',enabled:true},{id:'e8',role:'button',name:'Confirm',enabled:true},{id:'e9',role:'button',name:'キャンセル',enabled:true}];
createInterface({input:process.stdin}).on('line',l=>{
 if(!l.trim())return;let r;try{r=JSON.parse(l);}catch{return;}
 if(process.env.FAKE_LOG)appendFileSync(process.env.FAKE_LOG,JSON.stringify(r)+'\\n');
 if(r.op==='discover'){out({ok:true,request_id:r.request_id,result:{protocol_version:2,targets:[win],mutations_enabled:allowAll||controls||tier,autofocusing_disabled:true,focus_control:'probe_guarded_semantic',visual_capture:false}});return;}
 if(r.op==='open'){if(r.target_id!==win.target_id){out({ok:false,request_id:r.request_id,error:{code:'E_NO_TARGET'}});return;}if(r.mode!=='background_semantic'){out({ok:false,request_id:r.request_id,error:{code:'E_INTERFERENCE_RISK'}});return;}const session_id='s-'+(++seq);sessions.add(session_id);out({ok:true,request_id:r.request_id,result:{session_id}});return;}
 if(!sessions.has(r.session_id)){out({ok:false,request_id:r.request_id,error:{code:'E_NO_SESSION'}});return;}
 if(process.env.FAKE_MUTATE&&!external&&existsSync(process.env.FAKE_MUTATE)){external=true;label='Status: changed by a human';rev++;}
 if(r.op==='snapshot'){out({ok:true,request_id:r.request_id,result:{revision:rev,truncated:false,elements:elements()}});return;}
 if(r.op==='act'){
  if('approved'in r&&(r.approved!==true||mode!=='ask')){out({ok:false,request_id:r.request_id,error:{code:'E_BAD_REQUEST'}});return;}
  if(!(allowAll||controls||tier)){out({ok:false,request_id:r.request_id,error:{code:'E_NOT_ALLOWED'}});return;}
  if(r.expected_revision!==rev){out({ok:false,request_id:r.request_id,error:{code:'E_STALE_REVISION'}});return;}
  if(r.element_id==='e5'&&!allowAll){out({ok:false,request_id:r.request_id,error:{code:'E_PRIVACY_BLOCKED'}});return;}
  if(tier&&!r.approved&&r.action!=='scroll'&&['e4','e7','e8','e9'].includes(r.element_id)){out({ok:false,request_id:r.request_id,error:{code:'E_APPROVAL_REQUIRED'}});return;}
  if(r.action==='click'&&r.element_id==='e3'){label='Status: clicked';rev++;}
  if(r.action==='click'&&r.element_id==='e4'){label='Status: deleted';rev++;}
  out({ok:true,request_id:r.request_id,result:{applied:true}});return;}
 if(r.op==='close'){sessions.delete(r.session_id);out({ok:true,request_id:r.request_id,result:{closed:true}});return;}
 out({ok:false,request_id:r.request_id,error:{code:'E_BAD_REQUEST'}});
});
`;
const APP_ID = 'com.example.notes',
  APP_PATH = 'C:\\Apps\\Notes\\notes.exe';
type Env = Partial<Record<'FAKE_SPACE' | 'FAKE_LOG' | 'FAKE_MUTATE', string>>;
interface Harness {
  adapter: NativeDesktopAdapter;
  argsLog: string[][];
  dir: string;
  log: () => Promise<Record<string, unknown>[]>;
  dispose(): Promise<void>;
}
async function harness(
  platform: string,
  options: NativeDesktopOptions = {},
  extra: Partial<DesktopConfig> = {},
  env: Env = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'adl-tier-'));
  const file = join(dir, 'helper.mjs');
  await writeFile(file, HELPER, { mode: 0o600 });
  const logPath = join(dir, 'requests.jsonl');
  const config: DesktopConfig = {
    helperPath: file,
    appId: APP_ID,
    appPath: APP_PATH,
    classification: 'PUBLIC',
    ...extra,
  };
  const argsLog: string[][] = [],
    children: ChildProcess[] = [];
  const fullEnv = {
    ...process.env,
    FAKE_SPACE: platform === 'darwin' ? 'desktop_points_top_left' : 'desktop_physical_pixels',
    FAKE_LOG: logPath,
    FAKE_MUTATE: join(dir, 'mutate'),
    ...env,
  };
  const spawnFn = (path: string, args: string[]) => {
    argsLog.push(args);
    const child = spawn(process.execPath, [path, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: fullEnv });
    children.push(child);
    return child;
  };
  const adapter =
    platform === 'win32'
      ? new WindowsAdapter(config, { ...options, spawnFn })
      : platform === 'darwin'
        ? new MacOSAdapter(config, { ...options, spawnFn })
        : new LinuxAdapter(config, { ...options, spawnFn });
  const log = async () =>
    (await readFile(logPath, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
  return {
    adapter,
    argsLog,
    dir,
    log,
    dispose: async () => {
      await adapter.close().catch(() => {});
      await delay(30);
      for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const sig = () => new AbortController().signal;
const fakeBrowser: Adapter = {
  open: async () => ({
    snapshot: async () => ({ fingerprint: 'empty', elements: [], truncated: false }),
    act: async () => {},
    close: async () => {},
  }),
  close: async () => {},
};
const nativeKey = (platform: string) => (platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux');
const policyFor = (platform: string, operationMode: string, extra: Record<string, unknown> = {}) =>
  parsePolicy({
    operationMode,
    browserTargets: [],
    [nativeKey(platform)]: {
      helperPath: 'C:\\helper\\adl.exe',
      appId: APP_ID,
      appPath: APP_PATH,
      classification: 'PUBLIC',
      ...extra,
    },
  });

// Loopback stand-in for the VS Code approval broker: decisions are set by the test, consumption is one-shot.
async function broker() {
  const saved = {
    url: process.env.ADL_APPROVAL_URL,
    token: process.env.ADL_APPROVAL_TOKEN,
    epoch: process.env.ADL_APPROVAL_EPOCH,
  };
  const token = randomBytes(32).toString('base64url'),
    epoch = randomUUID();
  type Entry = {
    request_id: string;
    binding: string;
    expires_at: number;
    status: string;
    summary: Record<string, unknown>;
    [key: string]: unknown;
  };
  const entries = new Map<string, Entry>();
  const state = { posts: 0, consumes: 0, deletes: 0 };
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      let entry: Entry | undefined;
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Entry;
        state.posts++;
        entry = { ...body, status: 'pending' };
        entries.set(entry.request_id, entry);
      } else entry = entries.get(req.url!.split('/').at(-1)!);
      if (!entry) {
        res.writeHead(404);
        res.end();
        return;
      }
      let consumed = false;
      if (req.method === 'DELETE') {
        state.deletes++;
        if (entry.status === 'approved' && entry.expires_at > Date.now()) {
          entry.status = 'consumed';
          state.consumes++;
          consumed = true;
        } else if (entry.status === 'pending') entry.status = 'invalidated';
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          v: 1,
          request_id: entry.request_id,
          binding: entry.binding,
          expires_at: entry.expires_at,
          status: entry.status,
          ...(req.method === 'DELETE' ? { consumed_now: consumed } : {}),
        }),
      );
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.ADL_APPROVAL_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.ADL_APPROVAL_TOKEN = token;
  process.env.ADL_APPROVAL_EPOCH = epoch;
  return {
    entries,
    state,
    last: () => [...entries.values()].at(-1)!,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const [key, value] of [
        ['ADL_APPROVAL_URL', saved.url],
        ['ADL_APPROVAL_TOKEN', saved.token],
        ['ADL_APPROVAL_EPOCH', saved.epoch],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}
async function opened(engine: Engine) {
  const { targets } = await engine.listTargets('desktop');
  assert.equal(targets.length, 1);
  const session = await engine.open(targets[0]!.target_id, 'background_semantic');
  const observed = await engine.observe(session.session_id);
  const find = (name: string) => observed.elements!.find(e => e.name === name)!;
  return { target: targets[0]!, session, observed, find };
}
const rejectsWith = async (promise: Promise<unknown>, code: string, reason?: string) => {
  const error = await promise.then(
    () => undefined,
    e => e as AdlError,
  );
  assert.ok(error instanceof AdlError, 'expected an AdlError');
  assert.equal(error.code, code);
  if (reason) assert.equal(error.reason, reason);
  return error;
};

test(
  'every helper receives --operation-mode standard|ask only for a tier without --allow-all or a controls file',
  { timeout: 30000 },
  async () => {
    const base = ['--app-id', APP_ID, '--app-path', APP_PATH];
    const cases: [string, NativeDesktopOptions, Partial<DesktopConfig>, string[]][] = [
      ['win32', { operationMode: 'standard' }, {}, [...base, '--operation-mode', 'standard']],
      ['win32', { operationMode: 'ask' }, {}, [...base, '--operation-mode', 'ask']],
      ['win32', { operationMode: 'read_only' }, {}, base],
      ['win32', {}, {}, base],
      [
        'win32',
        { operationMode: 'ask' },
        { allowAllOperations: true, restrictTargets: true },
        ['--allow-all', '--restrict-targets', ...base],
      ],
      [
        'win32',
        { operationMode: 'standard' },
        { controlsPath: 'C:\\adl\\controls.json' },
        [...base, '--controls-file', 'C:\\adl\\controls.json'],
      ],
      [
        'win32',
        { operationMode: 'standard' },
        { visual: { enabled: true, allowUnredacted: true, maskRegions: [] }, lifecycle: { enabled: true } },
        [...base, '--visual-enabled', '--lifecycle-enabled', '--operation-mode', 'standard'],
      ],
      ['darwin', { operationMode: 'standard' }, {}, [...base, '--operation-mode', 'standard']],
      ['darwin', { operationMode: 'ask' }, {}, [...base, '--operation-mode', 'ask']],
      [
        'darwin',
        { operationMode: 'ask' },
        { controlsPath: '/etc/adl/controls.json' },
        [...base, '--controls-file', '/etc/adl/controls.json'],
      ],
      ['linux', { operationMode: 'ask' }, {}, [...base, '--operation-mode', 'ask']],
    ];
    for (const [platform, options, extra, expected] of cases) {
      const h = await harness(platform, options, extra);
      try {
        const [target] = await h.adapter.discover(sig());
        assert.deepEqual(h.argsLog[0], expected, JSON.stringify({ platform, options, extra }));
        const tier = options.operationMode === 'standard' || options.operationMode === 'ask';
        assert.equal(
          target!.capabilities.includes('click'),
          tier || !!extra.allowAllOperations || !!extra.controlsPath,
          'mutation capabilities follow the grant',
        );
      } finally {
        await h.dispose();
      }
    }
  },
);

test(
  'standard tier on Windows and macOS: ordinary actions run, consequential and sensitive controls are refused with specific reasons, read_only is observe-only',
  { timeout: 40000 },
  async () => {
    for (const platform of ['win32', 'darwin']) {
      const h = await harness(platform, { operationMode: 'standard' });
      const engine = new Engine(
        policyFor(platform, 'standard'),
        { browser: fakeBrowser, desktop: h.adapter },
        platform,
      );
      try {
        const caps = engine.capabilities() as unknown as {
          limitations: string[];
          adapters: { desktop: string; desktop_mutations?: boolean };
        };
        assert.ok(
          caps.limitations.some(l => /operationMode standard\/ask permits ordinary actions/.test(l)),
          caps.limitations.join('|'),
        );
        const { session, observed, find } = await opened(engine);
        assert.ok(session.capabilities.includes('click') && session.capabilities.includes('fill'));
        const consequential = await rejectsWith(
          engine.act(session.session_id, { action: 'click', element_id: find('Delete all').id }, observed.revision),
          'E_APPROVAL_REQUIRED',
          'consequential_operation',
        );
        assert.equal(safeError(consequential).retryable, false);
        await rejectsWith(
          engine.act(
            session.session_id,
            { action: 'fill', element_id: find('Password').id, value: 'hunter2' },
            observed.revision,
          ),
          'E_PRIVACY_BLOCKED',
        );
        await rejectsWith(
          engine.act(
            session.session_id,
            { action: 'fill', element_id: find('Send to').id, value: 'a@b.example' },
            observed.revision,
          ),
          'E_APPROVAL_REQUIRED',
          'consequential_operation',
        );
        // The helpers' extra terms (confirm, cancel, order, 取消, キャンセル, 転送) are decided by the server too, with the same reason.
        for (const name of ['Confirm', 'キャンセル'])
          await rejectsWith(
            engine.act(session.session_id, { action: 'click', element_id: find(name).id }, observed.revision),
            'E_APPROVAL_REQUIRED',
            'consequential_operation',
          );
        const log = await h.log();
        assert.equal(log.filter(r => r.op === 'act').length, 0, 'refusals never reach the helper');
        const acted = await engine.act(
          session.session_id,
          { action: 'click', element_id: find('Run').id },
          observed.revision,
        );
        assert.equal(acted.revision, observed.revision + 1);
        assert.equal(
          (await engine.observe(session.session_id)).elements!.find(e => e.role === 'text')?.name,
          'Status: clicked',
        );
        await engine.act(
          session.session_id,
          { action: 'fill', element_id: find('Name').id, value: 'Taro' },
          acted.revision,
        );
        const acts = (await h.log()).filter(r => r.op === 'act');
        assert.equal(acts.length, 2);
        assert.ok(
          acts.every(r => !('approved' in r)),
          'the standard tier never sends approved',
        );
      } finally {
        await engine.shutdown();
        await h.dispose();
      }
      const readOnly = await harness(platform, { operationMode: 'read_only' });
      const observeOnly = new Engine(
        policyFor(platform, 'read_only'),
        { browser: fakeBrowser, desktop: readOnly.adapter },
        platform,
      );
      try {
        const { session, observed, find } = await opened(observeOnly);
        assert.deepEqual(session.capabilities, ['observe', 'read_state', 'wait_for']);
        const error = await rejectsWith(
          observeOnly.act(session.session_id, { action: 'click', element_id: find('Run').id }, observed.revision),
          'E_POLICY_DENIED',
          'desktop_operation_not_granted',
        );
        assert.equal(safeError(error).workspace_setting, 'agentdesklink.operationMode');
        // read_only names the setting for every control, never an approval or privacy reason that suggests another way in.
        for (const [action, name] of [
          ['click', 'Delete all'],
          ['fill', 'Password'],
          ['click', 'Confirm'],
        ] as const)
          await rejectsWith(
            observeOnly.act(
              session.session_id,
              { action, element_id: find(name).id, ...(action === 'fill' ? { value: 'x' } : {}) },
              observed.revision,
            ),
            'E_POLICY_DENIED',
            'desktop_operation_not_granted',
          );
        assert.equal((await readOnly.log()).filter(r => r.op === 'act').length, 0);
      } finally {
        await observeOnly.shutdown();
        await readOnly.dispose();
      }
    }
  },
);

test(
  'ask tier: a consequential native action waits for one host approval, executes exactly once with approved:true, and the next one asks again',
  { timeout: 40000 },
  async () => {
    const b = await broker();
    const h = await harness('win32', { operationMode: 'ask' });
    const engine = new Engine(policyFor('win32', 'ask'), { browser: fakeBrowser, desktop: h.adapter }, 'win32');
    try {
      const caps = engine.capabilities() as unknown as {
        approvals: { available: boolean; surfaces: string[]; desktop_sensitive_controls: string };
      };
      assert.deepEqual(
        [caps.approvals.available, caps.approvals.surfaces, caps.approvals.desktop_sensitive_controls],
        [true, ['browser', 'desktop'], 'refused'],
      );
      const { target, session, observed, find } = await opened(engine);
      const action: Action = { action: 'click', element_id: find('Delete all').id };
      const first = await rejectsWith(engine.act(session.session_id, action, observed.revision), 'E_APPROVAL_REQUIRED');
      assert.ok(first.requestId);
      assert.equal(safeError(first).retryable, true);
      assert.equal(b.state.posts, 1);
      const summary = b.last().summary as Record<string, unknown>;
      assert.deepEqual(summary, {
        action: 'click',
        surface: 'desktop',
        target: 'Notes window',
        application: APP_ID,
        role: 'button',
        name: 'Delete all',
        risk: 'consequential',
      });
      assert.equal(target.label, 'Notes window');
      const pending = await rejectsWith(
        engine.act(session.session_id, action, observed.revision),
        'E_APPROVAL_REQUIRED',
      );
      assert.equal(pending.requestId, first.requestId);
      assert.equal(b.state.posts, 1, 'an identical retry polls the same request');
      const other = await rejectsWith(
        engine.act(
          session.session_id,
          { action: 'fill', element_id: find('Send to').id, value: 'x' },
          observed.revision,
        ),
        'E_APPROVAL_REQUIRED',
        'approval_pending_other_action',
      );
      assert.equal(other.requestId, undefined);
      const status = await engine.approvals(first.requestId);
      assert.equal(status.requests[0]!.status, 'pending');
      assert.equal((await h.log()).filter(r => r.op === 'act').length, 0, 'nothing reached the helper while pending');
      b.last().status = 'approved';
      const results = await Promise.allSettled([
        engine.act(session.session_id, action, observed.revision),
        engine.act(session.session_id, action, observed.revision),
      ]);
      assert.equal(
        results.filter(r => r.status === 'fulfilled').length,
        1,
        'one approval dispatches once under concurrent identical retries',
      );
      assert.equal(b.state.consumes, 1);
      const acts = (await h.log()).filter(r => r.op === 'act');
      assert.equal(acts.length, 1);
      assert.equal(acts[0]!.approved, true);
      assert.equal(acts[0]!.element_id, action.element_id);
      const after = await engine.observe(session.session_id);
      assert.equal(after.elements!.find(e => e.role === 'text')?.name, 'Status: deleted');
      // The approval was for that one action: the same control at the new revision needs a fresh human decision.
      const again = await rejectsWith(engine.act(session.session_id, action, after.revision), 'E_APPROVAL_REQUIRED');
      assert.notEqual(again.requestId, first.requestId);
      assert.equal(b.state.posts, 2);
      assert.equal((await h.log()).filter(r => r.op === 'act').length, 1);
      // Ordinary actions never ask in ask mode.
      await engine.act(
        session.session_id,
        { action: 'fill', element_id: find('Name').id, value: 'Hanako' },
        after.revision,
      );
      assert.equal(b.state.posts, 2);
    } finally {
      await engine.shutdown();
      await h.dispose();
      await b.close();
    }
  },
);

test(
  'ask tier: helper-only terms such as Confirm and キャンセル reach the host approval and dispatch once with approved:true',
  { timeout: 40000 },
  async () => {
    const b = await broker();
    const h = await harness('linux', { operationMode: 'ask' });
    const engine = new Engine(policyFor('linux', 'ask'), { browser: fakeBrowser, desktop: h.adapter }, 'linux');
    try {
      const { session, observed, find } = await opened(engine);
      for (const [index, name] of ['Confirm', 'キャンセル'].entries()) {
        const action: Action = { action: 'click', element_id: find(name).id };
        const first = await rejectsWith(
          engine.act(session.session_id, action, observed.revision),
          'E_APPROVAL_REQUIRED',
        );
        assert.ok(first.requestId);
        assert.equal(b.state.posts, index + 1);
        assert.equal((b.last().summary as Record<string, unknown>).name, name);
        b.last().status = 'approved';
        await engine.act(session.session_id, action, observed.revision);
        const acts = (await h.log()).filter(r => r.op === 'act');
        assert.equal(acts.length, index + 1);
        assert.equal(acts.at(-1)!.approved, true);
        assert.equal(acts.at(-1)!.element_id, action.element_id);
      }
    } finally {
      await engine.shutdown();
      await h.dispose();
      await b.close();
    }
  },
);

test(
  'ask tier: denial, a changed native revision, a secret value and a sensitive control never dispatch',
  { timeout: 40000 },
  async () => {
    const b = await broker();
    const h = await harness('darwin', { operationMode: 'ask' });
    const engine = new Engine(policyFor('darwin', 'ask'), { browser: fakeBrowser, desktop: h.adapter }, 'darwin');
    try {
      const { session, observed, find } = await opened(engine);
      const action: Action = { action: 'click', element_id: find('Delete all').id };
      await rejectsWith(engine.act(session.session_id, action, observed.revision), 'E_APPROVAL_REQUIRED');
      b.last().status = 'denied';
      await rejectsWith(engine.act(session.session_id, action, observed.revision), 'E_POLICY_DENIED');
      await rejectsWith(engine.act(session.session_id, action, observed.revision), 'E_POLICY_DENIED');
      assert.equal(b.state.posts, 1, 'a denial is a tombstone for the identical action');
      // A new identical request after denial is refused without re-prompting; a different consequential action may ask.
      const second = await rejectsWith(
        engine.act(
          session.session_id,
          { action: 'fill', element_id: find('Send to').id, value: 'Taro' },
          observed.revision,
        ),
        'E_APPROVAL_REQUIRED',
      );
      assert.ok(second.requestId);
      assert.equal(b.state.posts, 2);
      assert.deepEqual((b.last().summary as Record<string, unknown>).value, {
        kind: 'public',
        length: 4,
        preview: 'Taro',
      });
      b.last().status = 'approved';
      // The native tree changes before the retry: the stale revision withdraws the approval instead of dispatching it.
      await writeFile(join(h.dir, 'mutate'), '');
      await rejectsWith(
        engine.act(
          session.session_id,
          { action: 'fill', element_id: find('Send to').id, value: 'Taro' },
          observed.revision,
        ),
        'E_STALE_STATE',
      );
      // The withdrawn approval is burned at the broker (DELETE on an approved entry consumes it) and nothing was dispatched.
      assert.ok(['consumed', 'invalidated'].includes(b.last().status), b.last().status);
      assert.equal((await h.log()).filter(r => r.op === 'act').length, 0);
      await rejectsWith(
        engine.act(
          session.session_id,
          { action: 'fill', element_id: find('Send to').id, value: 'Taro' },
          observed.revision,
        ),
        'E_STALE_STATE',
      );
      assert.equal(b.state.posts, 2, 'a stale retry never re-prompts');
      const fresh = await engine.observe(session.session_id);
      assert.equal(fresh.revision, observed.revision + 1);
      // Sensitive stays refused even though the broker is reachable, and a secret-looking value on a consequential control is not shown to anyone.
      await rejectsWith(
        engine.act(
          session.session_id,
          { action: 'fill', element_id: find('Password').id, value: 'hunter2' },
          fresh.revision,
        ),
        'E_PRIVACY_BLOCKED',
      );
      await rejectsWith(
        engine.act(
          session.session_id,
          { action: 'fill', element_id: find('Send to').id, value: 'sk-abcdefghijklmnopqrstuv' },
          fresh.revision,
        ),
        'E_PRIVACY_BLOCKED',
      );
      assert.equal(b.state.posts, 2);
      assert.equal((await h.log()).filter(r => r.op === 'act').length, 0);
    } finally {
      await engine.shutdown();
      await h.dispose();
      await b.close();
    }
  },
);

test(
  'ask tier: emergency stop and a missing broker fail closed, and a helper outside ask mode rejects the field',
  { timeout: 40000 },
  async () => {
    const b = await broker();
    const h = await harness('win32', { operationMode: 'ask' });
    let allowed = true;
    const engine = new Engine(
      policyFor('win32', 'ask'),
      { browser: fakeBrowser, desktop: h.adapter },
      'win32',
      () => allowed,
    );
    try {
      const { session, observed, find } = await opened(engine);
      const action: Action = { action: 'click', element_id: find('Delete all').id };
      await rejectsWith(engine.act(session.session_id, action, observed.revision), 'E_APPROVAL_REQUIRED');
      b.last().status = 'approved';
      allowed = false;
      await rejectsWith(engine.act(session.session_id, action, observed.revision), 'E_CANCELLED', 'emergency_stop');
      assert.equal(b.state.consumes, 0);
      assert.equal((await h.log()).filter(r => r.op === 'act').length, 0);
    } finally {
      await engine.shutdown();
      await h.dispose();
      await b.close();
    }
    // CLI ask mode without the VS Code broker: consequential native actions stay refused with the specific reason.
    const lone = await harness('win32', { operationMode: 'ask' });
    const cli = new Engine(policyFor('win32', 'ask'), { browser: fakeBrowser, desktop: lone.adapter }, 'win32');
    try {
      const { session, observed, find } = await opened(cli);
      await rejectsWith(
        cli.act(session.session_id, { action: 'click', element_id: find('Delete all').id }, observed.revision),
        'E_APPROVAL_REQUIRED',
        'approval_unavailable',
      );
      await cli.act(session.session_id, { action: 'click', element_id: find('Run').id }, observed.revision);
    } finally {
      await cli.shutdown();
      await lone.dispose();
    }
    // The adapter forwards approved:true only when its own helper was started in ask mode.
    const standard = await harness('win32', { operationMode: 'standard' });
    try {
      const [target] = await standard.adapter.discover(sig());
      const session = await standard.adapter.open(target!, 'background_semantic', sig());
      await session.snapshot(sig());
      await session.act({ action: 'click', element_id: 'e3' }, sig(), undefined, {
        approved: true,
        approvalProof: 'x',
        normalOperations: true,
      });
      const acts = (await standard.log()).filter(r => r.op === 'act');
      assert.equal(acts.length, 1);
      assert.ok(!('approved' in acts[0]!));
    } finally {
      await standard.dispose();
    }
  },
);

test('server native vocabulary matches the helpers: extra terms, width folding and identifier-style labels', () => {
  for (const label of [
    'Confirm',
    'Cancel',
    'Order now',
    'confirmPayment',
    'cancel_order',
    'ＣＯＮＦＩＲＭ',
    '取消',
    '取り消し',
    'キャンセル',
    '転送',
    'Delete all',
    'Log in',
    '送信',
  ])
    assert.equal(isNativeConsequential(label), true, label);
  for (const label of [
    'Run',
    'Remove filters',
    'Ordinary',
    'Reorder',
    'Confirmation code field',
    'Name',
    'Status: ready',
  ])
    assert.equal(isNativeConsequential(label), false, label);
});
