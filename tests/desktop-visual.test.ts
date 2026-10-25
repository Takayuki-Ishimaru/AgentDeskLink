import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';
import sharp from 'sharp';
import {NativeDesktopAdapter} from '../src/desktop.js';
import {AdlError,type AdapterSession,type DesktopConfig,type Target} from '../src/types.js';
import type {DesktopVisualPolicy} from '../src/visual-types.js';

const APP='local.test.visual',sig=()=>new AbortController().signal;
const ENABLED:DesktopVisualPolicy={enabled:true,allowUnredacted:true,maskRegions:[]};
const HELPER=String.raw`
import {createInterface} from 'node:readline';
import {readFileSync} from 'node:fs';
const platform=process.env.ADL_PLATFORM,scenario=process.env.ADL_SCENARIO;
const png=readFileSync(process.env.ADL_PNG),size=JSON.parse(process.env.ADL_SIZE);
const enabled=process.argv.includes('--visual-enabled');let sequence=0;
const coords=platform==='darwin'?'desktop_points_top_left':'desktop_physical_pixels';
const window={bounds:{x:-100,y:50,width:size.width,height:size.height,coordinate_space:coords},display_ids:['display_fixture'],minimized:false};
const targets=[{target_id:'t_semantic',application_id:'local.test.visual',label:'Synthetic',window},...(platform==='darwin'&&enabled?[{target_id:'t_visual',application_id:'local.test.visual',label:'Window image',window,capture_only:true}]:[])];
const reply=(r,result)=>process.stdout.write(JSON.stringify({ok:true,request_id:r.request_id,result})+'\n');
createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line);
  if(r.op==='discover'){reply(r,{protocol_version:2,targets,mutations_enabled:true,focus_control:'probe_guarded_semantic',autofocusing_disabled:true,visual_capture:enabled&&scenario!=='native-disabled'});return;}
  if(r.op==='open'){reply(r,{session_id:'s_'+(++sequence)});return;}
  if(r.op==='close'){reply(r,{closed:true});return;}
  if(r.op==='snapshot'){
    if(scenario==='oversize-semantic'){reply(r,{revision:1,elements:[],truncated:false,padding:'x'.repeat(70_000)});return;}
    reply(r,{revision:1,elements:r.target_id==='t_visual'?[]:[{id:'e_safe',role:'button',name:'Synthetic',enabled:true}],truncated:false,surface_epoch:'fixture_epoch'});return;
  }
  if(r.op==='act'){reply(r,{applied:true});return;}
  if(r.op==='capture'){
    const result={png_base64:png.toString('base64'),captured_at:'2026-10-24T00:00:00.000Z',coordinate_space:'window_pixels',viewport:{...size,scroll_x:0,scroll_y:0,device_scale_factor:1},source_to_desktop:{origin_x:-100,origin_y:50,scale_x:1,scale_y:1,coordinate_space:coords},surface_epoch:'fixture_epoch',redacted:platform==='win32'};
    if(scenario==='base64-newline')result.png_base64+='\n';
    if(scenario==='base64-junk')result.png_base64='!!!!';
    if(scenario==='not-png')result.png_base64=Buffer.from('Synthetic non-image bytes').toString('base64');
    if(scenario==='oversize-capture')result.png_base64='a'.repeat(12*1024*1024);
    if(scenario==='dimension-mismatch')result.viewport.width++;
    if(scenario==='wrong-space')result.source_to_desktop.coordinate_space=platform==='darwin'?'desktop_physical_pixels':'desktop_points_top_left';
    if(scenario==='bad-transform')result.source_to_desktop.scale_x=0;
    if(scenario==='missing-epoch')delete result.surface_epoch;
    if(scenario==='bad-date')result.captured_at='not-a-timestamp';
    if(scenario==='slow-capture'){setTimeout(()=>reply(r,result),2000);return;}
    reply(r,result);return;
  }
});
`;
interface Harness {adapter:NativeDesktopAdapter;args:string[][];children:ChildProcess[];dispose():Promise<void>}
async function harness(platform:'darwin'|'win32',visual:DesktopVisualPolicy|false=ENABLED,scenario='normal',large=false):Promise<Harness>{
  const dir=await mkdtemp(join(tmpdir(),'adl-desktop-visual-'));
  const path=join(dir,'helper.mjs'),pngPath=join(dir,'synthetic.png');
  let png:Buffer;
  if(large){
    const raw=Buffer.alloc(512*256*3);let random=47;
    for(let i=0;i<raw.length;i++){random=(Math.imul(random,1664525)+1013904223)>>>0;raw[i]=random>>>24;}
    png=await sharp(raw,{raw:{width:512,height:256,channels:3}}).png().toBuffer();
  }else png=await sharp({create:{width:32,height:16,channels:4,background:{r:25,g:140,b:220,alpha:1}}}).png().toBuffer();
  const size=await sharp(png).metadata();
  await Promise.all([writeFile(path,HELPER),writeFile(pngPath,png)]);
  const config:DesktopConfig={helperPath:path,appId:APP,appPath:'/synthetic/app',controlsPath:join(dir,'controls.json'),classification:'INTERNAL',...(visual?{visual}: {})};
  const args:string[][]=[],children:ChildProcess[]=[];
  const adapter=new NativeDesktopAdapter(config,{platform,spawnFn:(helper,argv)=>{args.push(argv);const child=spawn(process.execPath,[helper,...argv],{stdio:['pipe','pipe','pipe'],env:{...process.env,ADL_PLATFORM:platform,ADL_SCENARIO:scenario,ADL_PNG:pngPath,ADL_SIZE:JSON.stringify({width:size.width,height:size.height})}});children.push(child);return child;}});
  return {adapter,args,children,dispose:async()=>{await adapter.close().catch(()=>{});for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}};
}
function hasVisual(target:Target){return ['capture','crop','record'].every(c=>target.capabilities.includes(c));}
async function visualSession(h:Harness,platform:'darwin'|'win32'):Promise<AdapterSession>{
  const targets=await h.adapter.discover(sig());
  const target=targets.find(t=>t.target_id===(platform==='darwin'?'t_visual':'t_semantic'));
  assert(target,'Expected configured native capture target');
  return h.adapter.open(target,'background_semantic',sig());
}
function safeFailure(error:unknown){assert(error instanceof AdlError);return true;}

for(const platform of ['darwin','win32'] as const){
  test(`${platform}: desktop pixels are default-off`,{timeout:5000},async()=>{
    const h=await harness(platform,false);try{
      const targets=await h.adapter.discover(sig());assert(h.args.every(a=>!a.includes('--visual-enabled')));
      assert(targets.every(t=>!t.capabilities.some(c=>['capture','crop','record'].includes(c))));
      const session=await h.adapter.open(targets[0]!,'background_semantic',sig());assert.equal(session.capture,undefined);
    }finally{await h.dispose();}
  });
  test(`${platform}: native opt-in captures bounded PNG with exact metadata`,{timeout:5000},async()=>{
    const h=await harness(platform);try{
      const targets=await h.adapter.discover(sig()),target=targets.find(t=>t.target_id===(platform==='darwin'?'t_visual':'t_semantic'))!;
      assert(hasVisual(target));assert(h.args[0]!.includes('--visual-enabled'));
      const session=await h.adapter.open(target,'background_semantic',sig());assert(session.capture);
      assert(['capture','crop','record'].every(c=>session.capabilities?.includes(c)));
      const image=await session.capture(sig()),metadata=await sharp(image.png).metadata();
      assert.equal(metadata.width,32);assert.equal(metadata.height,16);assert.equal(image.coordinate_space,'window_pixels');
      assert.equal(image.surface_epoch,'fixture_epoch');assert.equal(image.captured_at,'2026-10-24T00:00:00.000Z');
      assert.deepEqual(image.source_to_desktop,{origin_x:-100,origin_y:50,scale_x:1,scale_y:1,coordinate_space:platform==='darwin'?'desktop_points_top_left':'desktop_physical_pixels'});
      if(platform==='darwin'){
        const semantic=targets.find(t=>t.target_id==='t_semantic')!;assert(!hasVisual(semantic));
        const semanticSession=await h.adapter.open(semantic,'background_semantic',sig());assert.equal(semanticSession.capture,undefined);
        assert(!target.capabilities.includes('click'));assert(!session.capabilities?.includes('click'));
      }
    }finally{await h.dispose();}
  });
  test(`${platform}: a native unavailable-capture flag cannot advertise pixels`,{timeout:5000},async()=>{
    const h=await harness(platform,ENABLED,'native-disabled');try{const targets=await h.adapter.discover(sig());assert(targets.every(t=>!hasVisual(t)));}finally{await h.dispose();}
  });
  test(`${platform}: static pixel masks are applied before image returns`,{timeout:5000},async()=>{
    const h=await harness(platform,{...ENABLED,maskRegions:[{x:1,y:0,width:2,height:2}]});try{
      const session=await visualSession(h,platform);assert(session.capture);const image=await session.capture(sig());assert.equal(image.redacted,true);
      const {data,info}=await sharp(image.png).removeAlpha().raw().toBuffer({resolveWithObject:true});
      const pixel=(x:number,y:number)=>[...data.subarray((y*info.width+x)*info.channels,(y*info.width+x)*info.channels+3)];
      assert.deepEqual(pixel(1,0),[0,0,0]);assert.deepEqual(pixel(2,1),[0,0,0]);assert.deepEqual(pixel(0,0),[25,140,220]);
    }finally{await h.dispose();}
  });
  test(`${platform}: capture transport accepts a PNG reply over the semantic 64 KiB limit`,{timeout:5000},async()=>{
    const h=await harness(platform,ENABLED,'normal',true);try{const session=await visualSession(h,platform);assert(session.capture);const image=await session.capture(sig());assert(image.png.length>65536);assert.equal((await sharp(image.png).metadata()).width,512);}finally{await h.dispose();}
  });
  test(`${platform}: semantic replies retain the 64 KiB bound`,{timeout:5000},async()=>{
    const h=await harness(platform,ENABLED,'oversize-semantic');try{const session=await visualSession(h,platform);await assert.rejects(session.snapshot(),safeFailure);assert.equal(h.args.length,1);await assert.rejects(h.adapter.discover(sig()),safeFailure);}finally{await h.dispose();}
  });
  test(`${platform}: cancelling capture invalidates the shared helper and other sessions`,{timeout:5000},async()=>{
    const h=await harness(platform,ENABLED,'slow-capture');try{
      const first=await visualSession(h,platform),second=await visualSession(h,platform);assert(first.capture);let invalidations=0;h.adapter.onInvalidated(()=>invalidations++);
      const controller=new AbortController(),pending=first.capture(controller.signal);await delay(30);controller.abort();
      await assert.rejects(pending,(error:unknown)=>error instanceof AdlError&&error.code==='E_CANCELLED');
      await assert.rejects(second.snapshot(),safeFailure);await assert.rejects(h.adapter.discover(sig()),safeFailure);
      assert.equal(invalidations,1);assert.equal(h.args.length,1);
    }finally{await h.dispose();}
  });
  for(const scenario of ['base64-newline','base64-junk','not-png','oversize-capture','dimension-mismatch','wrong-space','bad-transform','missing-epoch','bad-date']){
    test(`${platform}: malformed ${scenario} capture is rejected`,{timeout:5000},async()=>{
      const h=await harness(platform,ENABLED,scenario);try{const session=await visualSession(h,platform);assert(session.capture);await assert.rejects(session.capture(sig()),safeFailure);}finally{await h.dispose();}
    });
  }
}
test('macOS capture-only pixels require explicit allowUnredacted even when static masks exist',{timeout:5000},async()=>{
  const h=await harness('darwin',{enabled:true,allowUnredacted:false,maskRegions:[{x:0,y:0,width:1,height:1}]});try{
    const targets=await h.adapter.discover(sig());
    for(const target of targets.filter(t=>t.target_id==='t_visual')){
      assert(!hasVisual(target));const session=await h.adapter.open(target,'background_semantic',sig());assert.equal(session.capture,undefined);
    }
  }finally{await h.dispose();}
});
