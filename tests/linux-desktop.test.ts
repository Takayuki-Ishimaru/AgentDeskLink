import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LinuxAdapter } from '../src/linux.js';
import { MacOSAdapter } from '../src/macos.js';
import { NativeDesktopAdapter, type NativeDesktopOptions } from '../src/desktop.js';
import { Engine } from '../src/core.js';
import { parsePolicy } from '../src/policy.js';
import { parseStartupPolicy, extensionPolicy, effectivePermissions } from '../src/bundled-policy.js';
import { AdlError, safeError, type Adapter, type DesktopConfig, type Target } from '../src/types.js';

// Protocol-faithful stand-in for native/linux-atspi/adl-linux-atspi-helper.py: same flags, same codes, same shapes.
const HELPER = `#!/usr/bin/env node
import{createInterface}from'node:readline';
const APP=process.env.FAKE_APP_ID||'adl-fixture';
const SPACE=process.env.FAKE_SPACE||'desktop_physical_pixels';
const args=process.argv.slice(2);
const allowAll=args.includes('--allow-all'),controls=args.includes('--controls-file'),standard=['standard','ask'].includes(args[args.indexOf('--operation-mode')+1]);
const out=o=>process.stdout.write(JSON.stringify(o)+'\\n');
const win={target_id:'t_fixture',application_id:APP,label:'ADL Fixture',window:{bounds:{x:0,y:0,width:400,height:300,coordinate_space:SPACE},display_ids:['x11::99'],minimized:false}};
let label='Status: ready',rev=1,seq=0;const sessions=new Set();
const elements=()=>[{id:'e1',role:'window',name:'ADL Fixture',enabled:true},{id:'e2',role:'text',name:label,enabled:true},{id:'e3',role:'button',name:'Run',enabled:true},{id:'e4',role:'button',name:'Delete all',enabled:true},{id:'e5',role:'textbox',name:'Password',enabled:true,sensitive:true},{id:'e6',role:'textbox',name:'Name',value:'',enabled:true}];
createInterface({input:process.stdin}).on('line',l=>{
 if(!l.trim())return;let r;try{r=JSON.parse(l);}catch{return;}
 if(process.env.FAKE_ATSPI==='missing'){out({ok:false,request_id:r.request_id,error:{code:'E_ATSPI_UNAVAILABLE',message:'python3-gi or the Atspi 2.0 typelib is missing'}});return;}
 if(r.op==='discover'){out({ok:true,request_id:r.request_id,result:{protocol_version:2,targets:[win],mutations_enabled:allowAll||controls||standard,...(process.env.FAKE_DISCOVERY==='noflags'?{}:{focus_control:'probe_guarded_semantic'}),visual_capture:false}});return;}
 if(r.op==='open'){if(r.target_id!==win.target_id){out({ok:false,request_id:r.request_id,error:{code:'E_NO_TARGET'}});return;}if(r.mode!=='background_semantic'){out({ok:false,request_id:r.request_id,error:{code:'E_INTERFERENCE_RISK'}});return;}const session_id='s_'+(++seq);sessions.add(session_id);out({ok:true,request_id:r.request_id,result:{session_id}});return;}
 if(!sessions.has(r.session_id)){out({ok:false,request_id:r.request_id,error:{code:'E_NO_SESSION'}});return;}
 if(r.op==='snapshot'){out({ok:true,request_id:r.request_id,result:{revision:rev,truncated:false,elements:elements()}});return;}
 if(r.op==='act'){
  if(!(allowAll||controls||standard)){out({ok:false,request_id:r.request_id,error:{code:'E_POLICY_DENIED'}});return;}
  if(r.expected_revision!==rev){out({ok:false,request_id:r.request_id,error:{code:'E_STALE_REVISION'}});return;}
  if(r.element_id==='e5'){out({ok:false,request_id:r.request_id,error:{code:'E_PRIVACY_BLOCKED'}});return;}
  if(standard&&r.element_id==='e4'){out({ok:false,request_id:r.request_id,error:{code:'E_APPROVAL_REQUIRED'}});return;}
  if(r.action==='click'&&r.element_id==='e3'){label='Status: clicked';rev++;}
  out({ok:true,request_id:r.request_id,result:{applied:true}});return;}
 if(r.op==='close'){sessions.delete(r.session_id);out({ok:true,request_id:r.request_id,result:{}});return;}
 out({ok:false,request_id:r.request_id,error:{code:'E_BAD_REQUEST'}});
});
`;
const APP_ID = 'adl-fixture',
  APP_PATH = '/usr/bin/python3.12';
type Env = Partial<Record<'FAKE_SPACE' | 'FAKE_DISCOVERY' | 'FAKE_ATSPI', string>>;
interface Harness {
  adapter: NativeDesktopAdapter;
  argsLog: string[][];
  children: ChildProcess[];
  dispose(): Promise<void>;
}
async function harness(
  env: Env = {},
  extra: Partial<DesktopConfig> = {},
  options: NativeDesktopOptions = {},
  platform = 'linux',
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'adl-linux-'));
  const file = join(dir, 'helper.mjs');
  await writeFile(file, HELPER, { mode: 0o600 });
  const config: DesktopConfig = {
    helperPath: file,
    appId: APP_ID,
    appPath: APP_PATH,
    classification: 'PUBLIC',
    ...extra,
  };
  const argsLog: string[][] = [],
    children: ChildProcess[] = [];
  const spawnFn = (path: string, args: string[]) => {
    argsLog.push(args);
    const child = spawn(process.execPath, [path, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    children.push(child);
    return child;
  };
  const adapter =
    platform === 'darwin'
      ? new MacOSAdapter(config, { ...options, spawnFn })
      : new LinuxAdapter(config, { ...options, spawnFn });
  return {
    adapter,
    argsLog,
    children,
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
const linuxPolicy = (extra: Record<string, unknown> = {}) =>
  parsePolicy({
    operationMode: 'standard',
    browserTargets: [{ id: 'browser', label: 'Browser', url: 'https://example.com', classification: 'PUBLIC' }],
    linux: { helperPath: '/opt/adl/helper', appId: APP_ID, appPath: APP_PATH, classification: 'PUBLIC' },
    ...extra,
  });

test(
  'linux helper arguments carry only the Linux flags; the tier adds --operation-mode standard|ask and a macOS controls file keeps precedence',
  { timeout: 20000 },
  async () => {
    const cases: [Partial<DesktopConfig>, NativeDesktopOptions, string[]][] = [
      [{}, { operationMode: 'standard' }, ['--app-id', APP_ID, '--app-path', APP_PATH, '--operation-mode', 'standard']],
      [{}, { operationMode: 'ask' }, ['--app-id', APP_ID, '--app-path', APP_PATH, '--operation-mode', 'ask']],
      [{}, { operationMode: 'read_only' }, ['--app-id', APP_ID, '--app-path', APP_PATH]],
      [{}, {}, ['--app-id', APP_ID, '--app-path', APP_PATH]],
      [
        { allowAllOperations: true, restrictTargets: true },
        { operationMode: 'standard' },
        ['--app-id', APP_ID, '--app-path', APP_PATH, '--allow-all', '--restrict-targets'],
      ],
      [
        { controlsPath: '/etc/adl/controls.json' },
        { operationMode: 'standard' },
        ['--app-id', APP_ID, '--app-path', APP_PATH, '--controls-file', '/etc/adl/controls.json'],
      ],
      [
        { visual: { enabled: true, allowUnredacted: true, maskRegions: [] }, lifecycle: { enabled: true } },
        { operationMode: 'standard' },
        ['--app-id', APP_ID, '--app-path', APP_PATH, '--operation-mode', 'standard'],
      ],
    ];
    for (const [extra, options, expected] of cases) {
      const h = await harness({}, extra, options);
      try {
        await h.adapter.discover(sig());
        assert.deepEqual(h.argsLog[0], expected, JSON.stringify({ extra, options }));
      } finally {
        await h.dispose();
      }
    }
    const mac = await harness(
      { FAKE_SPACE: 'desktop_points_top_left' },
      { controlsPath: '/etc/adl/controls.json' },
      { operationMode: 'standard' },
      'darwin',
    );
    try {
      await mac.adapter.discover(sig());
      assert.deepEqual(mac.argsLog[0], [
        '--app-id',
        APP_ID,
        '--app-path',
        APP_PATH,
        '--controls-file',
        '/etc/adl/controls.json',
      ]);
    } finally {
      await mac.dispose();
    }
  },
);

test(
  'linux discovery requires physical-pixel geometry and the probe-guarded focus contract',
  { timeout: 20000 },
  async () => {
    const points = await harness({ FAKE_SPACE: 'desktop_points_top_left' }, {}, { operationMode: 'standard' });
    try {
      await assert.rejects(points.adapter.discover(sig()), { code: 'E_BACKEND_UNAVAILABLE' });
    } finally {
      await points.dispose();
    }
    const noflags = await harness(
      { FAKE_DISCOVERY: 'noflags' },
      { allowAllOperations: true },
      { operationMode: 'standard' },
    );
    try {
      const [target] = await noflags.adapter.discover(sig());
      assert.ok(
        target && !target.capabilities.includes('click'),
        'mutations stay disabled without focus_control:probe_guarded_semantic',
      );
      assert.equal(noflags.adapter.desktopCapabilities().mutations, false);
    } finally {
      await noflags.dispose();
    }
    const h = await harness({}, {}, { operationMode: 'standard' });
    try {
      const [target] = await h.adapter.discover(sig());
      assert.equal(target!.window?.bounds.coordinate_space, 'desktop_physical_pixels');
      assert.deepEqual(h.adapter.desktopCapabilities().focus_control, 'probe_guarded_semantic');
      assert.equal(h.adapter.desktopCapabilities().lifecycle, false);
      await assert.rejects(h.adapter.application(APP_ID, 'launch', sig()), { code: 'E_UNSUPPORTED_ACTION' });
    } finally {
      await h.dispose();
    }
  },
);

test(
  'standard tier enables ordinary mutations while read_only stays observe-only with a specific reason',
  { timeout: 20000 },
  async () => {
    const standard = await harness({}, {}, { operationMode: 'standard' });
    try {
      const [target] = await standard.adapter.discover(sig());
      assert.deepEqual(target!.capabilities, [
        'observe',
        'read_state',
        'wait_for',
        'click',
        'fill',
        'check',
        'select',
        'scroll',
      ]);
      const session = await standard.adapter.open(target!, 'background_semantic', sig());
      const before = await session.snapshot(sig());
      assert.equal(before.elements.find(e => e.id === 'e2')?.name, 'Status: ready');
      await session.act({ action: 'click', element_id: 'e3' }, sig());
      const after = await session.snapshot(sig());
      assert.equal(after.elements.find(e => e.id === 'e2')?.name, 'Status: clicked');
      assert.notEqual(after.fingerprint, before.fingerprint);
      await session.close();
    } finally {
      await standard.dispose();
    }
    const readOnly = await harness({}, {}, { operationMode: 'read_only' });
    try {
      const [target] = await readOnly.adapter.discover(sig());
      assert.deepEqual(target!.capabilities, ['observe', 'read_state', 'wait_for']);
      const session = await readOnly.adapter.open(target!, 'background_semantic', sig());
      await session.snapshot(sig());
      const error = await session.act({ action: 'click', element_id: 'e3' }, sig()).then(
        () => undefined,
        e => e as AdlError,
      );
      assert.equal(error?.code, 'E_POLICY_DENIED');
      assert.equal(error?.reason, 'desktop_operation_not_granted');
      assert.equal(safeError(error).workspace_setting, 'agentdesklink.operationMode');
      assert.match(safeError(error).safe_message, /operationMode = standard/);
    } finally {
      await readOnly.dispose();
    }
  },
);

test(
  'missing AT-SPI prerequisites surface a specific installation reason without a helper restart',
  { timeout: 20000 },
  async () => {
    const h = await harness({ FAKE_ATSPI: 'missing' }, {}, { operationMode: 'standard' });
    try {
      for (let i = 0; i < 2; i++) {
        const error = await h.adapter.discover(sig()).then(
          () => undefined,
          e => e as AdlError,
        );
        assert.equal(error?.code, 'E_BACKEND_UNAVAILABLE');
        assert.equal(error?.reason, 'linux_accessibility_unavailable');
        const safe = safeError(error);
        assert.match(safe.safe_message, /python3-gi, gir1\.2-atspi-2\.0 and at-spi2-core/);
        assert.match(safe.safe_message, /toolkit-accessibility/);
      }
      assert.equal(h.children.length, 1, 'the helper keeps answering; no respawn per failure');
    } finally {
      await h.dispose();
    }
  },
);

test(
  'Engine on linux reports the AT-SPI adapter, applies the standard tier and marks unsupported features',
  { timeout: 30000 },
  async () => {
    const h = await harness({}, {}, { operationMode: 'standard' });
    const policy = linuxPolicy();
    const engine = new Engine(policy, { browser: fakeBrowser, desktop: h.adapter }, 'linux');
    try {
      const caps = engine.capabilities() as unknown as {
        adapters: { desktop: string };
        permissions: { desktop_app: string; physical_input: boolean };
        platform_unsupported: string[];
        lifecycle: { configured: boolean; platform_supported: boolean };
        modes: string[];
        limitations: string[];
        physical_input: { configured: boolean };
      };
      assert.equal(caps.adapters.desktop, 'linux_atspi_probe_required');
      assert.equal(caps.permissions.desktop_app, APP_ID);
      assert.deepEqual(caps.platform_unsupported, [
        'physical_input',
        'interactive_desktop',
        'desktop_capture',
        'lifecycle',
      ]);
      assert.deepEqual(
        [caps.lifecycle.configured, caps.lifecycle.platform_supported, caps.physical_input.configured],
        [false, false, false],
      );
      assert.deepEqual(caps.modes, ['strict_isolated', 'background_semantic']);
      assert.ok(caps.limitations.some(l => /AT-SPI2/.test(l) && /platform_unsupported/.test(l)));
      const { targets } = await engine.listTargets('desktop');
      assert.equal(targets.length, 1);
      assert.ok(targets[0]!.capabilities.includes('click'));
      await assert.rejects(engine.open(targets[0]!.target_id, 'strict_isolated'), { code: 'E_INTERFERENCE_RISK' });
      await assert.rejects(engine.open(targets[0]!.target_id, 'interactive_desktop'), { code: 'E_POLICY_DENIED' });
      const opened = await engine.open(targets[0]!.target_id, 'background_semantic');
      const observed = await engine.observe(opened.session_id);
      const find = (name: string) => observed.elements!.find(e => e.name === name)!;
      assert.deepEqual(
        observed.elements!.map(e => e.role),
        ['window', 'text', 'button', 'button', 'textbox', 'textbox'],
      );
      const consequential = await engine
        .act(opened.session_id, { action: 'click', element_id: find('Delete all').id }, observed.revision)
        .then(
          () => undefined,
          e => e as AdlError,
        );
      assert.equal(consequential?.code, 'E_APPROVAL_REQUIRED');
      assert.equal(consequential?.reason, 'consequential_operation');
      await assert.rejects(
        engine.act(
          opened.session_id,
          { action: 'fill', element_id: find('Password').id, value: 'hunter2' },
          observed.revision,
        ),
        { code: 'E_PRIVACY_BLOCKED' },
      );
      await assert.rejects(
        engine.act(opened.session_id, { action: 'click', element_id: find('Run').id }, observed.revision + 7),
        { code: 'E_STALE_STATE' },
      );
      const acted = await engine.act(
        opened.session_id,
        { action: 'click', element_id: find('Run').id },
        observed.revision,
      );
      assert.equal(acted.revision, observed.revision + 1);
      assert.equal(
        (await engine.observe(opened.session_id)).elements!.find(e => e.role === 'text')?.name,
        'Status: clicked',
      );
      const capture = await engine.capture(opened.session_id).then(
        () => undefined,
        e => e as AdlError,
      );
      assert.equal(capture?.code, 'E_UNSUPPORTED_ACTION');
      assert.equal(capture?.reason, 'platform_unsupported');
      const lifecycle = await engine.application(APP_ID, 'status').then(
        () => undefined,
        e => e as AdlError,
      );
      assert.equal(lifecycle?.code, 'E_UNSUPPORTED_ACTION');
      assert.equal(lifecycle?.reason, 'platform_unsupported');
    } finally {
      await engine.shutdown();
      await h.dispose();
    }
  },
);

test('policy parsing accepts the linux key, rejects Linux physical input and derives extension grants', () => {
  const app = { appId: APP_ID, appPath: APP_PATH, classification: 'PUBLIC' as const };
  assert.equal(linuxPolicy().linux?.appId, APP_ID);
  assert.throws(
    () =>
      parsePolicy({
        linux: {
          ...app,
          helperPath: '/opt/adl/helper',
          visual: { enabled: true, allowUnredacted: true },
          interactive: { enabled: true, surfaces: [] },
        },
      }),
    { code: 'E_INVALID_ARGUMENT' },
  );
  assert.equal(
    parsePolicy({ linux: { ...app, helperPath: '/opt/adl/helper', lifecycle: { enabled: true } } }).linux?.lifecycle
      ?.enabled,
    true,
  );
  assert.equal(parseStartupPolicy({ linux: app }, '/installed/helper', 'linux').linux?.helperPath, '/installed/helper');
  assert.throws(() => parseStartupPolicy({ linux: app }, undefined, 'linux'), { code: 'E_INVALID_ARGUMENT' });
  assert.equal(
    parseStartupPolicy({ linux: { ...app, helperPath: '/own/helper' } }, '/installed/helper', 'linux').linux
      ?.helperPath,
    '/own/helper',
  );
  assert.throws(
    () =>
      parseStartupPolicy({ linux: app, macos: { ...app, helperPath: '/mac/helper' } }, '/installed/helper', 'darwin'),
    { code: 'E_INVALID_ARGUMENT' },
    'the bundled helper is injected only for the host platform',
  );
  assert.equal(
    parseStartupPolicy({ macos: app, linux: { ...app, helperPath: '/own/helper' } }, '/installed/helper', 'darwin')
      .macos?.helperPath,
    '/installed/helper',
  );
  const grants = {
    desktopAppId: APP_ID,
    desktopAppPath: APP_PATH,
    operationMode: 'standard',
    allowUnredactedImages: true,
    allowPhysicalInput: true,
  };
  const policy = extensionPolicy('/helper', 'linux', grants);
  assert.deepEqual(policy.linux, {
    restrictTargets: true,
    helperPath: '/helper',
    appId: APP_ID,
    appPath: APP_PATH,
    classification: 'PUBLIC',
    allowAllOperations: false,
  });
  assert.equal(policy.macos, undefined);
  assert.equal(policy.windows, undefined);
  assert.equal(policy.operationMode, 'standard');
  assert.equal(
    extensionPolicy('/helper', 'linux', { ...grants, allowAllOperations: true }).linux?.allowAllOperations,
    true,
  );
  assert.equal(extensionPolicy(undefined, 'linux', grants).linux, undefined, 'no bundled helper means no native grant');
  const effective = effectivePermissions(grants, '/helper', 'linux');
  assert.deepEqual(
    [effective.desktopAppId, effective.allowPhysicalInput, effective.allowUnredactedImages, effective.operationMode],
    [APP_ID, false, false, 'standard'],
  );
  assert.ok(
    effective.reasons.some(r => /unsupported on Linux/.test(r)),
    effective.reasons.join('|'),
  );
  assert.ok(
    effectivePermissions({ desktopAppId: APP_ID, desktopAppPath: APP_PATH }, undefined, 'linux').reasons.some(r =>
      /python3-gi/.test(r),
    ),
  );
  assert.deepEqual(
    effectivePermissions({ desktopAppId: APP_ID, desktopAppPath: APP_PATH }, '/helper', 'linux').reasons,
    [],
  );
  assert.ok(
    effectivePermissions({ desktopAppId: APP_ID, desktopAppPath: APP_PATH }, '/helper', 'freebsd').reasons.some(r =>
      /macOS, Windows or Linux/.test(r),
    ),
  );
  assert.deepEqual(
    effectivePermissions(
      { desktopAppId: APP_ID, desktopAppPath: APP_PATH, allowPhysicalInput: true },
      '/helper',
      'darwin',
    ).reasons,
    ['Physical input needs unredacted native images / 物理入力には無加工ネイティブ画像の許可が必要です。'],
  );
});

test('other platforms never spawn the Linux adapter and keep their own contracts', { timeout: 20000 }, async () => {
  const h = await harness({}, {}, { operationMode: 'standard' }, 'darwin');
  try {
    const policy = parsePolicy({
      operationMode: 'standard',
      browserTargets: [],
      macos: { helperPath: '/opt/adl/helper', appId: APP_ID, appPath: APP_PATH, classification: 'PUBLIC' },
    });
    const engine = new Engine(policy, { browser: fakeBrowser, desktop: h.adapter }, 'darwin');
    const caps = engine.capabilities() as unknown as { platform_unsupported: string[]; adapters: { desktop: string } };
    assert.deepEqual(caps.platform_unsupported, []);
    await engine.shutdown();
  } finally {
    await h.dispose();
  }
  const freebsd = new LinuxAdapter(
    { helperPath: '/opt/adl/helper', appId: APP_ID, appPath: APP_PATH, classification: 'PUBLIC' },
    {
      platform: 'freebsd',
      spawnFn: () => {
        throw new Error('must not spawn');
      },
    },
  );
  await assert.rejects(freebsd.discover(sig()), { code: 'E_TARGET_NOT_FOUND' });
  const targetShape: Target = {
    target_id: 't_x',
    surface: 'desktop',
    application_id: APP_ID,
    label: 'x',
    capabilities: [],
    policy_class: 'PUBLIC',
  };
  await assert.rejects(freebsd.open(targetShape, 'background_semantic', sig()), { code: 'E_TARGET_NOT_FOUND' });
});
