import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeDesktopAdapter } from '../src/desktop.js';
import { Engine } from '../src/core.js';
import { parsePolicy } from '../src/policy.js';
import type { Adapter, DesktopConfig } from '../src/types.js';

// A native quit retires all native sessions before Engine disposes its local
// sessions. A harmless stale-close acknowledgement must not kill that helper.
const HELPER = String.raw`
import {createInterface} from 'node:readline';
let running=false,generation=0,sequence=0;const sessions=new Set();
createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),out=result=>process.stdout.write(JSON.stringify({ok:true,request_id:r.request_id,result})+'\n');
 const fail=code=>process.stdout.write(JSON.stringify({ok:false,request_id:r.request_id,error:{code}})+'\n');
 if(r.op==='application'){
  const changed=r.action==='launch'?!running:r.action==='quit'?running:false;
  if(r.action==='launch'&&!running){generation++;running=true;}
  if(r.action==='quit'){running=false;sessions.clear();}
  out({running,managed:running,changed});return;
 }
 if(r.op==='discover'){out({protocol_version:2,mutations_enabled:true,autofocusing_disabled:true,targets:running?[0,1].map(i=>({target_id:'t-gen'+generation+'w'+i,application_id:'test.app',label:'owned',window:{bounds:{x:0,y:0,width:100,height:100,coordinate_space:'desktop_physical_pixels'},display_ids:['display'],minimized:false}})):[]});return;}
 if(r.op==='open'){const id='s-'+(++sequence);sessions.add(id);out({session_id:id});return;}
 if(!sessions.has(r.session_id)){fail('E_TARGET_MISMATCH');return;}
 if(r.op==='close'){sessions.delete(r.session_id);out({closed:true});return;}
 if(r.op==='snapshot'){out({revision:1,truncated:false,elements:[]});return;}
 fail('E_INVALID_ARGUMENT');
});
`;
test(
  'native quit retires two sessions while the same helper remains usable for relaunch',
  { timeout: 10000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adl-life-reuse-')),
      helper = join(dir, 'helper.mjs');
    await writeFile(helper, HELPER);
    let spawns = 0;
    const config: DesktopConfig = {
      helperPath: helper,
      appId: 'test.app',
      appPath: '/synthetic/app',
      classification: 'PUBLIC',
      lifecycle: { enabled: true },
    };
    const desktop = new NativeDesktopAdapter(config, {
      platform: 'win32',
      spawnFn: (exe, args) => {
        spawns++;
        return spawn(process.execPath, [exe, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
      },
    });
    const browser: Adapter = {
      open: async () => {
        throw new Error('unused');
      },
      close: async () => {},
    };
    const engine = new Engine(parsePolicy({ windows: config }), { browser, desktop }, 'win32');
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        assert.equal((await engine.application('test.app', 'launch')).changed, true);
        const targets = (await engine.listTargets('desktop')).targets;
        assert.equal(targets.length, 2);
        const sessions = await Promise.all(targets.map(t => engine.open(t.target_id, 'background_semantic')));
        assert.equal((await engine.application('test.app', 'quit')).running, false);
        for (const s of sessions) await assert.rejects(engine.observe(s.session_id), { code: 'E_TARGET_NOT_FOUND' });
        assert.equal((await engine.application('test.app', 'status')).running, false);
      }
      assert.equal(spawns, 1, 'normal quit and stale native close preserve the helper epoch');
    } finally {
      await engine.shutdown();
      await desktop.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
