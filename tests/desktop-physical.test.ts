import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { NativeDesktopAdapter } from '../src/desktop.js';
import { AdlError, type AdapterSession, type DesktopConfig, type Target } from '../src/types.js';
import type { DesktopVisualPolicy } from '../src/visual-types.js';
import type { GesturePlan, GestureReference } from '../src/gesture-types.js';
import type { InteractivePolicy } from '../src/physical-input-types.js';

// Fake native helper: JSONL over stdio only. It cannot touch real input APIs or any GUI.
const HELPER = String.raw`
import{createInterface}from'node:readline';
import{appendFileSync}from'node:fs';
const SC=process.env.ADL_SCENARIO||'ok';
const SPACE=process.env.ADL_PLATFORM==='win32'?'desktop_physical_pixels':'desktop_points_top_left';
const PNG=Buffer.from(process.env.ADL_PNG_B64,'base64');
const SIZE=JSON.parse(process.env.ADL_SIZE);
const log=v=>{if(process.env.ADL_LOG)appendFileSync(process.env.ADL_LOG,JSON.stringify(v)+'\n');};
const send=v=>process.stdout.write(JSON.stringify(v)+'\n');
const ok=(r,result)=>send({ok:true,request_id:r.request_id,result});
const bad=(r,code,may)=>send({ok:false,request_id:r.request_id,error:{code,...(may===undefined?{}:{may_have_executed:may})}});
const win={bounds:{x:-64,y:32,width:SIZE.width,height:SIZE.height,coordinate_space:SPACE},display_ids:['display-1'],minimized:false};
const base=id=>({target_id:id,application_id:process.env.ADL_APP,label:'Native Fixture',window:win});
const BACKENDS=['mouse_drag','scroll_swipe','touch_swipe'];
const flags=extra=>({...base('t_phys'),capture_only:true,interactive_input:true,gesture_backends:BACKENDS,...extra});
const targets=()=>{
 if(SC==='no-flags')return[base('t_plain')];
 if(SC==='no-capture')return[flags(),base('t_plain')];
 if(SC==='global-only')return[{...base('t_glob'),capture_only:true},{...base('t_plain'),interactive_input:false}];
 if(SC==='not-interactive')return[flags({interactive_input:false}),base('t_plain')];
 if(SC==='no-backends')return[flags({gesture_backends:undefined}),base('t_plain')];
 if(SC==='partial-backends')return[flags({gesture_backends:['mouse_drag']}),base('t_plain')];
 return[flags(),base('t_plain')];
};
if(process.argv.includes('--release-input')){
 log({event:'release_started',scenario:SC});
 if(SC==='release-silent'||SC==='gesture-ignore'){setInterval(()=>{},1000);/* stay alive without acknowledging */}else{send({released_input:true});log({event:'release_completed'});process.exit(0);}
}
let rev=0;
createInterface({input:process.stdin}).on('line',line=>{
 if(!line.trim())return;
 let r;try{r=JSON.parse(line);}catch{return;}
 log({event:'request',op:r.op,request_id:r.request_id,payload:r});
 if(r.op==='discover'){
  const d={protocol_version:2,targets:targets(),mutations_enabled:true,autofocusing_disabled:true,focus_control:'probe_guarded_semantic'};
  if(SC!=='no-capture')d.visual_capture=true;
  if(SC==='global-only'){d.interactive_input=true;d.gesture_backends=BACKENDS;}
  ok(r,d);return;
 }
 if(r.op==='open'){ok(r,{session_id:'sess-1'});return;}
 if(r.op==='close'){ok(r,{closed:true});return;}
 if(r.op==='snapshot'){ok(r,{revision:1,truncated:false,elements:[{id:'e1',role:'button',name:'Native Fixture',enabled:true}]});return;}
 if(r.op==='capture'){
  rev++;
  const f={png_base64:PNG.toString('base64'),captured_at:'2026-10-24T00:00:00.000Z',coordinate_space:'window_pixels',viewport:{width:SIZE.width,height:SIZE.height,scroll_x:0,scroll_y:0,device_scale_factor:1},source_to_desktop:{origin_x:-64,origin_y:32,scale_x:2,scale_y:2,coordinate_space:SPACE},surface_epoch:'epoch-1',redacted:process.env.ADL_PLATFORM==='win32'};
  if(SC!=='no-token')f.input_token='tok-'+rev;
  ok(r,f);return;
 }
 if(r.op==='prepare_input'){
  const fill=r.action==='fill';
  const role=SC==='role-mismatch'?'button':(process.env.ADL_PLATFORM==='win32'?'Edit':'textbox');
  const target={role,name:SC==='name-mismatch'?'Other':'Subject',enabled:SC!=='disabled',focused:SC==='unfocused-fill'||SC==='focus-mismatch'?false:true,editable:SC==='fill-not-editable'?false:fill,selection:{start:0,length:0}};
  ok(r,{confirmation_id:'conf-1',expires_in_ms:30000,action:SC==='action-mismatch'?(fill?'click':'fill'):r.action,target,pointer_on_target:SC==='pointer-off'?false:true,focus_matches_target:SC==='focus-mismatch'?true:target.focused});return;
 }
 if(r.op==='commit_input'){
  if(SC==='commit-not-released'){ok(r,{released_input:false,verified:'input_sequence_completed',action:'fill'});return;}
  if(SC==='commit-wrong-action'){ok(r,{released_input:true,verified:'input_sequence_completed',action:'click'});return;}
  ok(r,{released_input:true,verified:'input_sequence_completed',action:'fill'});return;
 }
 if(r.op==='gesture'){
  const expected=r.kind==='drag'?'mouse_drag':(r.swipe_backend==='touch'?'touch_swipe':'scroll_swipe');
  const done=result=>{ok(r,result);};
  if(SC==='gesture-not-released')return done({released_input:false,verified:'input_sequence_completed',kind:r.kind,points_executed:r.points.length,backend:expected});
  if(SC==='gesture-wrong-kind')return done({released_input:true,verified:'input_sequence_completed',kind:r.kind==='drag'?'swipe':'drag',points_executed:r.points.length,backend:expected});
  if(SC==='gesture-wrong-count')return done({released_input:true,verified:'input_sequence_completed',kind:r.kind,points_executed:r.points.length+1,backend:expected});
  if(SC==='gesture-wrong-backend')return done({released_input:true,verified:'input_sequence_completed',kind:r.kind,points_executed:r.points.length,backend:expected==='scroll_swipe'?'touch_swipe':'scroll_swipe'});
  if(SC==='gesture-exit'){process.exit(0);}
  if(SC==='gesture-ignore'){return;}
  done({released_input:true,verified:'input_sequence_completed',kind:r.kind,points_executed:r.points.length,backend:expected});return;
 }
 bad(r,'E_BAD_REQUEST');
});
`;
const APP = 'local.test.phys';
const sig = () => new AbortController().signal;
const VISUAL: DesktopVisualPolicy = { enabled: true, allowUnredacted: true, maskRegions: [] };
const SURFACES = [
  { id: 'pane', region: { x: 0, y: 0, width: 32, height: 16 }, kinds: ['drag', 'swipe'] as ('drag' | 'swipe')[] },
];
const interactive = (enabled: boolean, surfaces = SURFACES): InteractivePolicy => ({ enabled, surfaces });
interface Harness {
  adapter: NativeDesktopAdapter;
  config: DesktopConfig;
  args: string[][];
  children: ChildProcess[];
  events: () => Promise<Record<string, unknown>[]>;
  requests: (op: string) => Promise<Record<string, unknown>[]>;
  dispose: () => Promise<void>;
}
async function harness(
  platform: 'darwin' | 'win32',
  scenario = 'ok',
  visual: DesktopVisualPolicy | boolean = true,
  interactivePolicy: InteractivePolicy | false = interactive(true),
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'adl-phys-'));
  const helper = join(dir, 'helper.mjs'),
    log = join(dir, 'events.jsonl');
  const png = await sharp({
    create: { width: 32, height: 16, channels: 4, background: { r: 25, g: 140, b: 220, alpha: 1 } },
  })
    .png()
    .toBuffer();
  await Promise.all([writeFile(helper, HELPER, { mode: 0o600 }), writeFile(log, '')]);
  const config: DesktopConfig = {
    helperPath: helper,
    appId: APP,
    appPath: '/synthetic/notes',
    controlsPath: join(dir, 'controls.json'),
    classification: 'INTERNAL',
    ...(visual === true ? { visual: VISUAL } : visual ? { visual } : {}),
    ...(interactivePolicy ? { interactive: interactivePolicy } : {}),
  };
  const args: string[][] = [],
    children: ChildProcess[] = [];
  const adapter = new NativeDesktopAdapter(config, {
    platform,
    spawnFn: (path, argv) => {
      args.push(argv);
      const child = spawn(process.execPath, [path, ...argv], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ADL_PLATFORM: platform,
          ADL_SCENARIO: scenario,
          ADL_APP: APP,
          ADL_LOG: log,
          ADL_PNG_B64: png.toString('base64'),
          ADL_SIZE: JSON.stringify({ width: 32, height: 16 }),
        },
      });
      children.push(child);
      return child;
    },
  });
  const events = async () => {
    const text = await readFile(log, 'utf8');
    return text.trim()
      ? text
          .trim()
          .split('\n')
          .map(line => JSON.parse(line) as Record<string, unknown>)
      : [];
  };
  return {
    adapter,
    config,
    args,
    children,
    events,
    requests: async op =>
      (await events()).filter(e => e.event === 'request' && e.op === op).map(e => e.payload as Record<string, unknown>),
    dispose: async () => {
      await adapter.close().catch(() => {});
      await delay(30);
      for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const isSafe = (code: string) => (error: unknown) => error instanceof AdlError && error.code === code;
const physicalFailure = (error: unknown) =>
  error instanceof AdlError && error.code === 'E_BACKEND_UNAVAILABLE' && error.mayHaveExecuted;
async function interactiveSession(
  h: Harness,
  _platform: 'darwin' | 'win32',
  id = 't_phys',
): Promise<{ session: AdapterSession; targets: Target[] }> {
  const targets = await h.adapter.discover(sig());
  const target = targets.find(t => t.target_id === id)!;
  return { session: await h.adapter.open(target, 'interactive_desktop', sig()), targets };
}
async function reference(session: AdapterSession): Promise<GestureReference> {
  const image = await session.capture!(sig());
  return {
    coordinate_space: image.coordinate_space,
    viewport: image.viewport,
    surface_epoch: image.surface_epoch,
    source_to_desktop: image.source_to_desktop,
    input_token: image.input_token,
  };
}
const plan = (over: Partial<GesturePlan> = {}): GesturePlan => ({
  surface_id: 'pane',
  kind: 'drag',
  points: [
    { x: 4, y: 4, t_ms: 0 },
    { x: 20, y: 12, t_ms: 40 },
  ],
  ...over,
});
for (const platform of ['darwin', 'win32'] as const) {
  test(
    `${platform}: trusted region/kind/backend and missing frame proof reject before native input`,
    { timeout: 10000 },
    async () => {
      const h = await harness(platform, 'ok', true, {
        enabled: true,
        surfaces: [{ ...SURFACES[0]!, kinds: ['drag'] }],
      });
      try {
        const { session } = await interactiveSession(h, platform);
        await session.snapshot(sig());
        const ref = await reference(session);
        for (const [p, code] of [
          [plan({ surface_id: 'unknown' }), 'E_APPROVAL_REQUIRED'],
          [plan({ kind: 'swipe' }), 'E_APPROVAL_REQUIRED'],
          [
            plan({
              points: [
                { x: 4, y: 4, t_ms: 0 },
                { x: 33, y: 12, t_ms: 40 },
              ],
            }),
            'E_POLICY_DENIED',
          ],
          [plan({ swipe_backend: 'scroll' }), 'E_UNSUPPORTED_ACTION'],
        ] as const)
          await assert.rejects(session.gesture!(p, ref, sig()), { code });
        await assert.rejects(session.gesture!(plan(), { ...ref, input_token: undefined }, sig()), {
          code: 'E_STALE_STATE',
        });
        assert.equal((await h.requests('gesture')).length, 0);
      } finally {
        await h.dispose();
      }
    },
  );
  test(
    `${platform}: protected pixels retain private frame proof and prepare forwards intended exact target`,
    { timeout: 10000 },
    async () => {
      const h = await harness(platform, 'ok', { ...VISUAL, maskRegions: [{ x: 0, y: 0, width: 1, height: 1 }] });
      try {
        const { session } = await interactiveSession(h, platform);
        const image = await session.capture!(sig());
        const { data, info } = await sharp(image.png).raw().toBuffer({ resolveWithObject: true });
        assert.deepEqual([...data.subarray(0, 3)], [0, 0, 0]);
        assert.equal(image.redacted, true);
        assert.equal(image.input_token, 'tok-1');
        assert.ok(info.width === 32);
        const prepared = await session.prepareInput!(
          { action: 'fill', point: { x: 6, y: 7 }, expected_target: { role: 'textbox', name: 'Subject' } },
          image,
          sig(),
        );
        assert.equal(prepared.target.role, 'textbox');
        const sent = (await h.requests('prepare_input'))[0]!;
        assert.deepEqual(sent.point, { x: 6, y: 7 });
        assert.deepEqual(sent.expected_target, { role: 'textbox', name: 'Subject' });
        assert.equal(sent.input_token, 'tok-1');
      } finally {
        await h.dispose();
      }
    },
  );
  test(
    `${platform}: interactive_desktop needs config enable AND native per-target interactive_input AND capture`,
    { timeout: 30000 },
    async () => {
      const on = await harness(platform);
      try {
        const targets = await on.adapter.discover(sig());
        const phys = targets.find(t => t.target_id === 't_phys')!,
          plain = targets.find(t => t.target_id === 't_plain')!;
        assert.ok(phys.capabilities.includes('interactive_desktop') && phys.capabilities.includes('capture'));
        assert.ok(!plain.capabilities.includes('interactive_desktop') && !plain.capabilities.includes('gesture'));
        assert.equal(on.adapter.desktopCapabilities().interactive_input, true);
        assert.deepEqual([...on.adapter.desktopCapabilities().gesture_backends].sort(), [
          'mouse_drag',
          'scroll_swipe',
          'touch_swipe',
        ]);
        assert.ok(on.args[0]!.includes('--interactive-config'));
        const s = await on.adapter.open(phys, 'interactive_desktop', sig());
        assert.ok(s.gesture && s.prepareInput && s.commitInput);
        await assert.rejects(on.adapter.open(plain, 'interactive_desktop', sig()), isSafe('E_UNSUPPORTED_ACTION'));
      } finally {
        await on.dispose();
      }
      const off = await harness(platform, 'ok', true, interactive(false));
      try {
        const targets = await off.adapter.discover(sig());
        assert.ok(targets.every(t => !t.capabilities.includes('interactive_desktop')));
        assert.equal(off.adapter.desktopCapabilities().interactive_input, false);
        assert.ok(!off.args[0]!.includes('--interactive-config'));
        await assert.rejects(
          off.adapter.open(
            targets.find(t => t.target_id === 't_phys')!,
            'interactive_desktop',
            sig(),
          ),
          isSafe('E_UNSUPPORTED_ACTION'),
        );
      } finally {
        await off.dispose();
      }
      const nocap = await harness(platform, 'no-capture');
      try {
        const targets = await nocap.adapter.discover(sig());
        const phys = targets.find(t => t.target_id === 't_phys')!;
        assert.ok(!phys.capabilities.includes('interactive_desktop') && !phys.capabilities.includes('capture'));
        await assert.rejects(nocap.adapter.open(phys, 'interactive_desktop', sig()), isSafe('E_UNSUPPORTED_ACTION'));
      } finally {
        await nocap.dispose();
      }
      const noflags = await harness(platform, 'not-interactive');
      try {
        const targets = await noflags.adapter.discover(sig());
        const phys = targets.find(t => t.target_id === 't_phys')!;
        assert.ok(phys.capabilities.includes('capture') && !phys.capabilities.includes('interactive_desktop'));
        await assert.rejects(noflags.adapter.open(phys, 'interactive_desktop', sig()), isSafe('E_UNSUPPORTED_ACTION'));
      } finally {
        await noflags.dispose();
      }
      const novisual = await harness(platform, 'ok', false);
      try {
        const targets = await novisual.adapter.discover(sig());
        assert.ok(
          targets.every(t => !t.capabilities.includes('interactive_desktop') && !t.capabilities.includes('capture')),
        );
      } finally {
        await novisual.dispose();
      }
    },
  );
  test(
    `${platform}: background_semantic never exposes physical methods even for an interactive target`,
    { timeout: 30000 },
    async () => {
      const h = await harness(platform);
      try {
        const targets = await h.adapter.discover(sig());
        const session = await h.adapter.open(
          targets.find(t => t.target_id === 't_phys')!,
          'background_semantic',
          sig(),
        );
        assert.ok(targets.find(t => t.target_id === 't_phys')!.capabilities.includes('interactive_desktop'));
        assert.equal(session.gesture, undefined);
        assert.equal(session.prepareInput, undefined);
        assert.equal(session.commitInput, undefined);
        assert.ok(
          !session.capabilities!.some(c =>
            ['interactive_desktop', 'gesture', 'prepare_input', 'commit_input'].includes(c),
          ),
        );
        assert.ok(session.capabilities!.includes('capture'));
      } finally {
        await h.dispose();
      }
    },
  );
  test(
    `${platform}: discovery interactive_input and gesture_backends are optional with global fallback`,
    { timeout: 30000 },
    async () => {
      const h = await harness(platform, 'global-only');
      try {
        const targets = await h.adapter.discover(sig());
        assert.ok(targets.find(t => t.target_id === 't_glob')!.capabilities.includes('interactive_desktop'));
        assert.ok(!targets.find(t => t.target_id === 't_plain')!.capabilities.includes('interactive_desktop'));
        const s = await h.adapter.open(
          targets.find(t => t.target_id === 't_glob')!,
          'interactive_desktop',
          sig(),
        );
        await s.snapshot(sig());
        await assert.rejects(
          s.gesture!(plan({ kind: 'swipe', swipe_backend: 'touch' }), await reference(s), sig()),
          isSafe('E_UNSUPPORTED_ACTION'),
        );
      } finally {
        await h.dispose();
      }
      const nb = await harness(platform, 'no-backends');
      try {
        const targets = await nb.adapter.discover(sig());
        const s = await nb.adapter.open(
          targets.find(t => t.target_id === 't_phys')!,
          'interactive_desktop',
          sig(),
        );
        assert.deepEqual(nb.adapter.desktopCapabilities().gesture_backends, []);
        await s.snapshot(sig());
        await assert.rejects(s.gesture!(plan(), await reference(s), sig()), isSafe('E_UNSUPPORTED_ACTION'));
        assert.equal((await nb.requests('gesture')).length, 0);
      } finally {
        await nb.dispose();
      }
    },
  );
  test(
    `${platform}: gesture forwards original source points, capture token and native revision without desktop transform`,
    { timeout: 30000 },
    async () => {
      const h = await harness(platform);
      try {
        const { session } = await interactiveSession(h, platform);
        await session.snapshot(sig());
        const ref = await reference(session);
        assert.equal(ref.input_token, 'tok-1');
        const p = plan({
          points: [
            { x: 4, y: 4, t_ms: 0 },
            { x: 20, y: 12, t_ms: 40 },
          ],
        });
        const execution = await session.gesture!(p, ref, sig());
        assert.equal(execution.released_input, true);
        assert.equal(execution.verified, 'input_sequence_completed');
        assert.equal(execution.kind, 'drag');
        assert.equal(execution.points_executed, 2);
        const sent = (await h.requests('gesture'))[0]!;
        assert.deepEqual(sent.points, p.points);
        assert.equal(sent.input_token, 'tok-1');
        assert.equal(sent.expected_revision, 1);
        assert.equal(sent.surface_id, 'pane');
        assert.equal(sent.kind, 'drag');
        assert.equal(sent.source_to_desktop, undefined);
        assert.equal(sent.origin_x, undefined);
        assert.equal(sent.viewport, undefined);
        assert.equal(JSON.stringify(sent.points), JSON.stringify(p.points));
      } finally {
        await h.dispose();
      }
    },
  );
  test(
    `${platform}: mouse_drag, scroll_swipe and touch_swipe are distinct advertised backends`,
    { timeout: 30000 },
    async () => {
      const h = await harness(platform);
      try {
        const { session } = await interactiveSession(h, platform);
        await session.snapshot(sig());
        const ref = await reference(session);
        const drag = await session.gesture!(plan(), ref, sig());
        const scroll = await session.gesture!(
          plan({
            kind: 'swipe',
            points: [
              { x: 4, y: 4, t_ms: 0 },
              { x: 4, y: 12, t_ms: 30 },
            ],
          }),
          ref,
          sig(),
        );
        await assert.rejects(
          session.gesture!(plan({ kind: 'swipe', swipe_backend: 'touch' }), ref, sig()),
          isSafe('E_UNSUPPORTED_ACTION'),
        );
        assert.equal(drag.input_backend, 'mouse_drag');
        assert.equal(scroll.input_backend, 'scroll_swipe');
        const touchHarness = await harness(platform, 'ok', true, {
          enabled: true,
          surfaces: SURFACES.map(s => ({ ...s, swipe_backend: 'touch' as const })),
        });
        try {
          const { session: ts } = await interactiveSession(touchHarness, platform);
          await ts.snapshot(sig());
          const touch = await ts.gesture!(plan({ kind: 'swipe', swipe_backend: 'touch' }), await reference(ts), sig());
          assert.equal(touch.input_backend, 'touch_swipe');
        } finally {
          await touchHarness.dispose();
        }
        const sent = await h.requests('gesture');
        assert.equal(sent[0]!.backend, undefined);
        assert.equal(sent[1]!.swipe_backend, 'scroll');
        assert.equal(sent.length, 2);
        const partial = await harness(platform, 'partial-backends');
        try {
          const t2 = await partial.adapter.discover(sig());
          const s2 = await partial.adapter.open(
            t2.find(t => t.target_id === 't_phys')!,
            'interactive_desktop',
            sig(),
          );
          await s2.snapshot(sig());
          const r2 = await reference(s2);
          assert.equal((await s2.gesture!(plan(), r2, sig())).input_backend, 'mouse_drag');
          await assert.rejects(s2.gesture!(plan({ kind: 'swipe' }), r2, sig()), isSafe('E_UNSUPPORTED_ACTION'));
          assert.equal((await partial.requests('gesture')).length, 1);
        } finally {
          await partial.dispose();
        }
      } finally {
        await h.dispose();
      }
    },
  );
  test(
    `${platform}: invalid prepare replies fail closed and still await emergency release`,
    { timeout: 30000 },
    async () => {
      for (const scenario of [
        'action-mismatch',
        'pointer-off',
        'disabled',
        'fill-not-editable',
        'role-mismatch',
        'name-mismatch',
        'focus-mismatch',
      ]) {
        const h = await harness(platform, scenario);
        try {
          const { session } = await interactiveSession(h, platform);
          const ref = await reference(session);
          await assert.rejects(
            session.prepareInput!(
              { action: 'fill', point: { x: 6, y: 6 }, expected_target: { role: 'textbox', name: 'Subject' } },
              ref,
              sig(),
            ),
            physicalFailure,
          );
          const events = await h.events();
          assert.equal(events.filter(e => e.event === 'release_started').length, 1, scenario);
          assert.equal(events.filter(e => e.event === 'release_completed').length, 1, scenario);
          assert.equal(h.children.length, 2, scenario);
          await assert.rejects(h.adapter.discover(sig()), isSafe('E_TARGET_NOT_FOUND'));
        } finally {
          await h.dispose();
        }
      }
    },
  );
  test(`${platform}: unfocused fill is a valid prepare observation`, { timeout: 30000 }, async () => {
    const h = await harness(platform, 'unfocused-fill');
    try {
      const targets = await h.adapter.discover(sig());
      const s = await h.adapter.open(
        targets.find(t => t.target_id === 't_phys')!,
        'interactive_desktop',
        sig(),
      );
      const ref = await reference(s);
      const p = await s.prepareInput!({ action: 'fill', point: { x: 6, y: 6 } }, ref, sig());
      assert.equal(p.target.focused, false);
      assert.equal(p.focus_matches_target, false);
      assert.equal(p.target.editable, true);
      const committed = await s.commitInput!(p.confirmation_id, 'hello', sig());
      assert.deepEqual(committed, { released_input: true, verified: 'input_sequence_completed', action: 'fill' });
      const sent = (await h.requests('commit_input'))[0]!;
      assert.equal(sent.confirmation_id, 'conf-1');
      assert.equal(sent.value, 'hello');
      assert.equal(sent.input_token, undefined);
    } finally {
      await h.dispose();
    }
  });
  test(
    `${platform}: malformed gesture completion fails closed and awaits the fixed --release-input acknowledgement`,
    { timeout: 30000 },
    async () => {
      for (const scenario of [
        'gesture-not-released',
        'gesture-wrong-kind',
        'gesture-wrong-count',
        'gesture-wrong-backend',
      ]) {
        const h = await harness(platform, scenario);
        try {
          const { session } = await interactiveSession(h, platform);
          await session.snapshot(sig());
          const ref = await reference(session);
          await assert.rejects(session.gesture!(plan(), ref, sig()), physicalFailure, scenario);
          const events = await h.events();
          assert.equal(events.filter(e => e.event === 'release_started').length, 1, scenario);
          assert.equal(events.filter(e => e.event === 'release_completed').length, 1, scenario);
          assert.equal(h.children.length, 2, scenario);
          assert.deepEqual(h.args[1]!.slice(0, 1), ['--release-input'], scenario);
          await assert.rejects(h.adapter.discover(sig()), isSafe('E_TARGET_NOT_FOUND'), scenario);
        } finally {
          await h.dispose();
        }
      }
    },
  );
  test(
    `${platform}: malformed commit completion fails closed and awaits the fixed --release-input acknowledgement`,
    { timeout: 30000 },
    async () => {
      for (const scenario of ['commit-not-released', 'commit-wrong-action']) {
        const h = await harness(platform, scenario);
        try {
          const { session } = await interactiveSession(h, platform);
          const ref = await reference(session);
          const p = await session.prepareInput!({ action: 'fill', point: { x: 6, y: 6 } }, ref, sig());
          await assert.rejects(session.commitInput!(p.confirmation_id, 'hello', sig()), physicalFailure, scenario);
          const events = await h.events();
          assert.equal(events.filter(e => e.event === 'release_started').length, 1, scenario);
          assert.equal(events.filter(e => e.event === 'release_completed').length, 1, scenario);
          assert.equal(h.children.length, 2, scenario);
          await assert.rejects(h.adapter.discover(sig()), isSafe('E_TARGET_NOT_FOUND'), scenario);
        } finally {
          await h.dispose();
        }
      }
    },
  );
  test(
    `${platform}: an unacknowledged emergency release is never treated as released`,
    { timeout: 30000 },
    async () => {
      const h = await harness(platform, 'gesture-ignore');
      try {
        const { session } = await interactiveSession(h, platform);
        await session.snapshot(sig());
        const ref = await reference(session);
        const controller = new AbortController();
        const pending = session.gesture!(plan(), ref, controller.signal);
        for (let n = 0; n < 200 && (await h.requests('gesture')).length === 0; n++) await delay(10);
        assert.equal((await h.requests('gesture')).length, 1);
        controller.abort();
        await assert.rejects(pending, (e: unknown) => e instanceof AdlError && e.mayHaveExecuted);
        const events = await h.events();
        assert.equal(events.filter(e => e.op === 'cancel_input').length, 1);
        assert.equal(events.filter(e => e.event === 'release_started').length, 1);
        assert.equal(events.filter(e => e.event === 'release_completed').length, 0);
      } finally {
        await h.dispose();
      }
    },
  );
}
