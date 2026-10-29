import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeDesktopAdapter } from '../src/desktop.js';
import { Engine } from '../src/core.js';
import { parsePolicy } from '../src/policy.js';
import { safeError, AdlError, type Adapter, type DesktopConfig, type Target } from '../src/types.js';

const HELPER = `#!/usr/bin/env node
import{createInterface}from'node:readline';
const APP=process.env.FAKE_APP_ID||'com.example.notes';
const SPACE=process.env.FAKE_SPACE||'desktop_points_top_left';
const win=(id,x)=>({target_id:id,application_id:APP,label:'Notes',window:{bounds:{x,y:50,width:300,height:200,coordinate_space:SPACE},display_ids:['d1'],minimized:false}});
const wins=[win('t-alpha1',-100),win('t-beta2',0)];
const closed=new Set();const sessions=new Map();let seq=0;
const out=o=>process.stdout.write(JSON.stringify(o)+'\\n');
const live=()=>wins.filter(w=>!closed.has(w.target_id));
const disc=()=>{
 if(process.env.FAKE_DISCOVERY==='dup')return{protocol_version:2,targets:[live()[0],live()[0]],mutations_enabled:true,autofocusing_disabled:true,focus_control:'probe_guarded_semantic'};
 if(process.env.FAKE_DISCOVERY==='crossapp')return{protocol_version:2,targets:[{...live()[0],application_id:'com.evil.other'}],mutations_enabled:true,autofocusing_disabled:true,focus_control:'probe_guarded_semantic'};
 if(process.env.FAKE_DISCOVERY==='badid')return{protocol_version:2,targets:[{...live()[0],target_id:'raw-hwnd-99'}],mutations_enabled:true,autofocusing_disabled:true,focus_control:'probe_guarded_semantic'};
 if(process.env.FAKE_DISCOVERY==='badver')return{protocol_version:1,targets:live(),mutations_enabled:true};
 if(process.env.FAKE_DISCOVERY==='noflags')return{protocol_version:2,targets:live(),mutations_enabled:true};
 return{protocol_version:2,targets:live(),mutations_enabled:true,autofocusing_disabled:true,focus_control:'probe_guarded_semantic'};
};
createInterface({input:process.stdin}).on('line',l=>{
 if(!l.trim())return;let r;try{r=JSON.parse(l);}catch{return;}
 if(process.env.FAKE_GARBAGE==='1'){out('this is not json');return;}
 if(r.op==='discover'){out({ok:true,request_id:r.request_id,result:disc()});if(process.env.FAKE_EXIT_AFTER==='1')setTimeout(()=>process.exit(0),10);return;}
 if(r.op==='retire'){closed.add(r.target_id);out({ok:true,request_id:r.request_id,result:{}});return;}
 if(r.op==='open'){
  if(!live().some(w=>w.target_id===r.target_id)){out({ok:false,request_id:r.request_id,error:{code:'E_NO_TARGET'}});return;}
  const session_id='native-'+(++seq);sessions.set(session_id,{target_id:r.target_id,rev:1});
  if(process.env.FAKE_CLOSE_AFTER_OPEN==='1')closed.add(r.target_id);
  out({ok:true,request_id:r.request_id,result:{session_id}});return;}
 const sess=sessions.get(r.session_id);
 if(!sess||sess.target_id!==r.target_id){out({ok:false,request_id:r.request_id,error:{code:'E_STALE_HANDLE'}});return;}
 if(r.op!=='close'&&!live().some(w=>w.target_id===r.target_id)){out({ok:false,request_id:r.request_id,error:{code:'E_TARGET_NOT_FOUND'}});return;}
 if(r.op==='snapshot'){
  if(process.env.FAKE_SNAPSHOT_HANG==='1')return;
  out({ok:true,request_id:r.request_id,result:{revision:sess.rev,truncated:false,elements:[{id:'e1',role:'button',name:'OK',value:sess.target_id,enabled:true}]}});return;}
 if(r.op==='act'){
  if(process.env.FAKE_MAYBE==='1'){out({ok:false,request_id:r.request_id,error:{code:'E_TIMEOUT'},may_have_executed:true});return;}
  if(process.env.FAKE_MAYBE==='0'){out({ok:false,request_id:r.request_id,error:{code:'E_STALE_REVISION',may_have_executed:false}});return;}
  if(r.expected_revision!==sess.rev){out({ok:false,request_id:r.request_id,error:{code:'E_STALE_REVISION'}});return;}
  sess.rev++;out({ok:true,request_id:r.request_id,result:{applied:true}});return;}
 if(r.op==='close'){sessions.delete(r.session_id);out({ok:true,request_id:r.request_id,result:{}});return;}
 out({ok:false,request_id:r.request_id,error:{code:'E_BAD_REQUEST'}});
});
`;
const APP_ID = 'com.example.notes';
type Mode = Partial<
  Record<
    | 'FAKE_DISCOVERY'
    | 'FAKE_SPACE'
    | 'FAKE_MAYBE'
    | 'FAKE_GARBAGE'
    | 'FAKE_EXIT_AFTER'
    | 'FAKE_SNAPSHOT_HANG'
    | 'FAKE_CLOSE_AFTER_OPEN',
    string
  >
>;
interface Harness {
  adapter: NativeDesktopAdapter;
  spawns: () => number;
  children: () => ChildProcess[];
  dispose(): Promise<void>;
}
async function harness(env: Mode = {}, platform = 'darwin', extra: Partial<DesktopConfig> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'adl-native-'));
  const file = join(dir, 'helper.mjs');
  await writeFile(file, HELPER, { mode: 0o600 });
  const config: DesktopConfig = {
    helperPath: file,
    appId: APP_ID,
    appPath: '/usr/bin/fake-notes',
    controlsPath: join(dir, 'controls.json'),
    classification: 'INTERNAL',
    ...extra,
  };
  const children: ChildProcess[] = [];
  const adapter = new NativeDesktopAdapter(config, {
    platform,
    spawnFn: (path, args) => {
      const child = spawn(process.execPath, [path, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      });
      children.push(child);
      return child;
    },
  });
  return {
    adapter,
    spawns: () => children.length,
    children: () => children,
    dispose: async () => {
      await adapter.close().catch(() => {});
      await delay(30);
      for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const sig = () => new AbortController().signal;
async function discover(h: Harness): Promise<Target[]> {
  return h.adapter.discover(sig());
}
async function open(h: Harness, target: Target) {
  return h.adapter.open(target, 'background_semantic', sig());
}
const fakeBrowser: Adapter = {
  open: async () => ({
    snapshot: async () => ({ fingerprint: 'empty', elements: [], truncated: false }),
    act: async () => {},
    close: async () => {},
  }),
  close: async () => {},
};
function engineWith(adapter: NativeDesktopAdapter) {
  const policy = parsePolicy({
    maxSessions: 2,
    browserTargets: [{ id: 'browser', label: 'Browser', url: 'https://example.com', classification: 'PUBLIC' }],
    macos: {
      helperPath: '/usr/bin/fake-helper',
      appId: APP_ID,
      appPath: '/usr/bin/fake-notes',
      controlsPath: '/etc/fake-controls.json',
      classification: 'INTERNAL',
    },
  });
  return new Engine(policy, { browser: fakeBrowser, desktop: adapter });
}

test(
  'two same-title windows enumerate with distinct opaque ids and negative geometry preserved',
  { timeout: 20000 },
  async () => {
    const h = await harness();
    try {
      const targets = await discover(h);
      assert.equal(targets.length, 2);
      assert.deepEqual(
        targets.map(x => x.label),
        ['Notes', 'Notes'],
      );
      assert.notEqual(targets[0]!.target_id, targets[1]!.target_id);
      assert.deepEqual(targets[0]!.window?.bounds, {
        x: -100,
        y: 50,
        width: 300,
        height: 200,
        coordinate_space: 'desktop_points_top_left',
      });
      assert.ok(
        targets.every(
          x => /^t[-_][A-Za-z0-9_-]+$/.test(x.target_id) && x.surface === 'desktop' && x.application_id === APP_ID,
        ),
      );
    } finally {
      await h.dispose();
    }
  },
);
test('open selects exactly the supplied id and both sessions snapshot independently', { timeout: 20000 }, async () => {
  const h = await harness();
  try {
    const [a, b] = await discover(h);
    const sa = await open(h, a!),
      sb = await open(h, b!);
    assert.equal((await sa.snapshot()).elements[0]!.value, a!.target_id);
    assert.equal((await sb.snapshot()).elements[0]!.value, b!.target_id);
    await sa.act({ action: 'click', element_id: 'e1' }, sig());
    assert.notEqual((await sa.snapshot()).fingerprint, (await sb.snapshot()).fingerprint);
  } finally {
    await h.dispose();
  }
});
test('forged and cross-app targets are rejected before any native open', { timeout: 20000 }, async () => {
  const h = await harness();
  try {
    const [a] = await discover(h);
    const forged = { ...a!, target_id: 't-notissued' };
    await assert.rejects(h.adapter.open(forged, 'background_semantic', sig()), { code: 'E_TARGET_NOT_FOUND' });
    const cross = { ...a!, application_id: 'com.evil.other' };
    await assert.rejects(h.adapter.open(cross, 'background_semantic', sig()), { code: 'E_TARGET_NOT_FOUND' });
    await assert.rejects(h.adapter.open(a!, 'strict_isolated', sig()), { code: 'E_INTERFERENCE_RISK' });
  } finally {
    await h.dispose();
  }
});
test('closing one native session preserves its sibling session', { timeout: 20000 }, async () => {
  const h = await harness();
  try {
    const [a, b] = await discover(h);
    const sa = await open(h, a!),
      sb = await open(h, b!);
    await sa.close();
    assert.equal((await sb.snapshot()).elements.length, 1);
    await assert.rejects(sa.snapshot(), { code: 'E_TARGET_NOT_FOUND' });
  } finally {
    await h.dispose();
  }
});
test('ids stay stable across discovery and a retired id becomes unavailable', { timeout: 20000 }, async () => {
  const h = await harness({ FAKE_CLOSE_AFTER_OPEN: '1' });
  try {
    const first = await discover(h);
    assert.deepEqual(
      (await discover(h)).map(x => x.target_id),
      first.map(x => x.target_id),
    );
    const [a, b] = first;
    const sa = await open(h, a!);
    const after = await discover(h);
    assert.deepEqual(
      after.map(x => x.target_id),
      [b!.target_id],
    );
    await assert.rejects(h.adapter.open(a!, 'background_semantic', sig()), { code: 'E_TARGET_NOT_FOUND' });
    await assert.rejects(sa.snapshot(), { code: 'E_TARGET_NOT_FOUND' });
  } finally {
    await h.dispose();
  }
});
test(
  'duplicate target ids in discovery fail closed and kill the client without respawn',
  { timeout: 20000 },
  async () => {
    const h = await harness({ FAKE_DISCOVERY: 'dup' });
    try {
      await assert.rejects(discover(h), { code: 'E_BACKEND_UNAVAILABLE' });
      await assert.rejects(discover(h), { code: 'E_TARGET_NOT_FOUND' });
      assert.equal(h.spawns(), 1);
    } finally {
      await h.dispose();
    }
  },
);
test('cross-app and malformed discovery payloads kill the client', { timeout: 30000 }, async () => {
  for (const mode of ['crossapp', 'badid', 'badver'] as const) {
    const h = await harness({ FAKE_DISCOVERY: mode });
    try {
      await assert.rejects(discover(h), { code: 'E_BACKEND_UNAVAILABLE' });
      assert.equal(h.spawns(), 1);
      await assert.rejects(discover(h), { code: 'E_TARGET_NOT_FOUND' });
    } finally {
      await h.dispose();
    }
  }
  const g = await harness({ FAKE_GARBAGE: '1' });
  try {
    await assert.rejects(discover(g), { code: 'E_BACKEND_UNAVAILABLE' });
  } finally {
    await g.dispose();
  }
});
test('helper death invalidates every session and never respawns', { timeout: 20000 }, async () => {
  const h = await harness();
  try {
    const [a] = await discover(h);
    const s = await open(h, a!);
    h.children()[0]!.kill();
    await delay(150);
    await assert.rejects(s.snapshot(), { code: 'E_TARGET_NOT_FOUND' });
    await assert.rejects(discover(h), { code: 'E_TARGET_NOT_FOUND' });
    assert.equal(h.spawns(), 1);
  } finally {
    await h.dispose();
  }
});
test('aborting a pending snapshot kills the helper and no late action lands', { timeout: 20000 }, async () => {
  const h = await harness({ FAKE_SNAPSHOT_HANG: '1' });
  try {
    const [a] = await discover(h);
    const s = await open(h, a!);
    const controller = new AbortController();
    const pending = s.snapshot(controller.signal);
    await delay(50);
    controller.abort();
    await assert.rejects(pending, { code: 'E_CANCELLED' });
    await assert.rejects(discover(h), { code: 'E_TARGET_NOT_FOUND' });
    assert.equal(h.spawns(), 1);
  } finally {
    await h.dispose();
  }
});
test('native top-level may_have_executed propagates through safeError', { timeout: 20000 }, async () => {
  const h = await harness({ FAKE_MAYBE: '1' });
  try {
    const e = engineWith(h.adapter);
    try {
      const targets = (await e.listTargets('desktop')).targets;
      const s = await e.open(targets[0]!.target_id, 'background_semantic');
      const err = await e.act(s.session_id, { action: 'click', element_id: 'e1' }, 1).then(
        () => undefined,
        (x: unknown) => x,
      );
      assert.ok(err instanceof AdlError);
      const safe = safeError(err);
      assert.equal(safe.may_have_executed, true);
      assert.equal(safe.code, 'E_TIMEOUT');
    } finally {
      await e.shutdown();
    }
  } finally {
    await h.dispose();
  }
});
test('native may_have_executed false never surfaces as executed', { timeout: 20000 }, async () => {
  const h = await harness({ FAKE_MAYBE: '0' });
  try {
    const e = engineWith(h.adapter);
    try {
      const targets = (await e.listTargets('desktop')).targets;
      const s = await e.open(targets[0]!.target_id, 'background_semantic');
      const err = await e.act(s.session_id, { action: 'click', element_id: 'e1' }, 1).then(
        () => undefined,
        (x: unknown) => x,
      );
      assert.ok(err instanceof AdlError);
      const safe = safeError(err);
      assert.equal(safe.may_have_executed, undefined);
      assert.equal(safe.code, 'E_STALE_STATE');
    } finally {
      await e.shutdown();
    }
  } finally {
    await h.dispose();
  }
});
test(
  'windows helper without verified autofocusing_disabled exposes no mutation capabilities',
  { timeout: 20000 },
  async () => {
    const h = await harness({ FAKE_DISCOVERY: 'noflags', FAKE_SPACE: 'desktop_physical_pixels' }, 'win32');
    try {
      const targets = await discover(h);
      assert.ok(targets.every(x => !x.capabilities.includes('click') && x.capabilities.includes('observe')));
      const s = await open(h, targets[0]!);
      await assert.rejects(s.act({ action: 'click', element_id: 'e1' }, sig()), { code: 'E_UNSUPPORTED_ACTION' });
    } finally {
      await h.dispose();
    }
    const ok = await harness({ FAKE_SPACE: 'desktop_physical_pixels' }, 'win32');
    try {
      const targets = await discover(ok);
      assert.ok(targets[0]!.capabilities.includes('click'));
      assert.equal(ok.adapter.desktopCapabilities().mutations, true);
    } finally {
      await ok.dispose();
    }
  },
);
test(
  'engine serializes discovery and actions and drops desktop sessions on helper invalidation',
  { timeout: 30000 },
  async () => {
    const h = await harness();
    try {
      const e = engineWith(h.adapter);
      try {
        const listed = await Promise.all([e.listTargets('desktop'), e.listTargets('desktop')]);
        assert.deepEqual(
          listed[0]!.targets.map(x => x.target_id),
          listed[1]!.targets.map(x => x.target_id),
        );
        const ids = listed[0]!.targets.map(x => x.target_id);
        const s1 = await e.open(ids[0]!, 'background_semantic');
        const s2 = await e.open(ids[1]!, 'background_semantic');
        const [refresh, first] = await Promise.all([
          e.listTargets('desktop'),
          e.act(s1.session_id, { action: 'click', element_id: 'e1' }, 1),
        ]);
        assert.equal(refresh.targets.length, 2);
        assert.equal(first.revision, 2);
        await assert.rejects(e.act(s1.session_id, { action: 'click', element_id: 'e1' }, 1), { code: 'E_STALE_STATE' });
        h.children()[0]!.kill();
        await delay(200);
        await assert.rejects(e.observe(s1.session_id), { code: 'E_TARGET_NOT_FOUND' });
        await assert.rejects(e.observe(s2.session_id), { code: 'E_TARGET_NOT_FOUND' });
        await assert.rejects(e.open(ids[0]!, 'background_semantic'), { code: 'E_TARGET_NOT_FOUND' });
        assert.equal(h.spawns(), 1);
        const browser = (await e.listTargets('browser')).targets[0]!;
        const replacement = await e.open(browser.target_id);
        assert.equal((await e.observe(replacement.session_id)).ok, true);
      } finally {
        await e.shutdown();
      }
    } finally {
      await h.dispose();
    }
  },
);

test('all-operation desktop mode permits semantic input without a controls file', async () => {
  const h = await harness({}, 'darwin', { controlsPath: undefined, allowAllOperations: true });
  try {
    const targets = await discover(h);
    assert.ok(targets[0]!.capabilities.includes('click'));
    const session = await open(h, targets[0]!);
    await session.snapshot();
    await session.act({ action: 'click', element_id: 'e1' }, sig());
  } finally {
    await h.dispose();
  }
});

test('native app restriction is a separate trusted launch flag alongside broad operations', async () => {
  const h = await harness({}, 'darwin', { controlsPath: undefined, allowAllOperations: true, restrictTargets: true });
  try {
    const targets = await discover(h);
    const args = h.children()[0]!.spawnargs;
    assert.ok(args.includes('--restrict-targets'));
    assert.ok(args.includes('--allow-all'));
    assert.equal(args[args.indexOf('--app-id') + 1], APP_ID);
    const session = await open(h, targets[0]!);
    await session.snapshot();
    await session.act({ action: 'click', element_id: 'e1' }, sig());
  } finally {
    await h.dispose();
  }
});
