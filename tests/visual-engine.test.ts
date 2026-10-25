import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import {Engine} from '../src/core.js';
import {parsePolicy} from '../src/policy.js';
import {AdlError,type Adapter,type AdapterSession,type Target} from '../src/types.js';
import type {CapturedImage,VisualRequest} from '../src/visual-types.js';

function deferred() {
  let resolve!:()=>void;
  const promise=new Promise<void>(r=>{resolve=r;});
  return {promise,resolve};
}
async function fixturePng() {
  const pixels=Buffer.alloc(320*200*3);
  for(let y=0;y<200;y++)for(let x=0;x<320;x++)pixels[(y*320+x)*3+(x<160?0:2)]=255;
  return sharp(pixels,{raw:{width:320,height:200,channels:3}}).png().toBuffer();
}
class VisualFake implements Adapter {
  captures=0;closed=0;extern=0;active=0;maxActive=0;
  captureError:AdlError|undefined;
  gate:ReturnType<typeof deferred>|undefined;
  entered:ReturnType<typeof deferred>|undefined;
  supported=true;
  discover?: (signal:AbortSignal)=>Promise<Target[]>;
  constructor(private readonly png:Buffer){}
  async open():Promise<AdapterSession> {
    let gone=false;
    return {
      snapshot:async()=>{if(gone)throw new AdlError('E_TARGET_NOT_FOUND');return {fingerprint:String(this.extern),truncated:false,elements:[{id:'e',role:'button',name:'Find',enabled:true}]};},
      act:async()=>{if(gone)throw new AdlError('E_TARGET_NOT_FOUND');this.extern++;},
      ...(this.supported?{capture:async(_signal:AbortSignal):Promise<CapturedImage>=>{
        if(gone)throw new AdlError('E_TARGET_NOT_FOUND');
        this.captures++;this.active++;this.maxActive=Math.max(this.maxActive,this.active);
        this.entered?.resolve();
        try {
          if(this.gate)await this.gate.promise;
          if(this.captureError)throw this.captureError;
          return {png:this.png,captured_at:new Date().toISOString(),coordinate_space:'viewport_css_pixels',viewport:{width:320,height:200,scroll_x:0,scroll_y:25,device_scale_factor:1},redacted:false};
        }finally{this.active--;}
      }}:{}),
      close:async()=>{if(!gone){gone=true;this.closed++;}}
    };
  }
  async close(){}
}
async function setup(options:{visual?:boolean;timeout?:number;desktop?:boolean;supported?:boolean}={}) {
  const fake=new VisualFake(await fixturePng());fake.supported=options.supported??true;
  const browserTargets=options.desktop?[]:[{id:'visual',label:'Visual',url:'https://example.com',classification:'PUBLIC',...(options.visual===undefined?{}:{visual:{enabled:options.visual,maskSelectors:[]}})}];
  const policy=parsePolicy({browserTargets,actionTimeoutMs:options.timeout??1000});
  if(options.desktop)fake.discover=async()=>[{target_id:'t_desktop',surface:'desktop',application_id:'fixture',label:'Desktop',policy_class:'PUBLIC',capabilities:['observe']}] satisfies Target[];
  const engine=new Engine(policy,{browser:fake,...(options.desktop?{desktop:fake}:{})});
  const id=(await engine.listTargets()).targets[0]!.target_id;
  const session=await engine.open(id,options.desktop?'background_semantic':'strict_isolated');
  return {engine,fake,session,id};
}

test('visual capture is denied by default and when disabled before adapter capture',{timeout:3000},async()=>{
  for(const visual of [undefined,false]){
    const {engine,fake,session}=await setup({visual});
    try{await assert.rejects(engine.capture(session.session_id),{code:'E_PRIVACY_BLOCKED'});assert.equal(fake.captures,0);assert.equal((await engine.observe(session.session_id)).revision,1);}
    finally{await engine.shutdown();}
  }
});
test('full frame and historical crop share source pixels without recapture',{timeout:3000},async()=>{
  const {engine,fake,session,id}=await setup({visual:true});
  try{
    const full=await engine.capture(session.session_id,{max_dimension:320});
    assert.equal(fake.captures,1);assert.equal(full.metadata.session_id,session.session_id);assert.equal(full.metadata.target_id,id);assert.equal(full.metadata.revision,1);
    assert.ok(Number.isFinite(Date.parse(full.metadata.captured_at)));assert.equal(full.metadata.viewport.scroll_y,25);
    assert.deepEqual(full.metadata.source,{width:320,height:200});
    assert.deepEqual(full.metadata.region,{x:0,y:0,width:320,height:200});
    assert.equal((await sharp(full.png).metadata()).width,320);
    fake.extern++;assert.equal((await engine.observe(session.session_id)).revision,2);
    const crop=await engine.capture(session.session_id,{frame_id:full.metadata.frame_id,region:{x:160,y:20,width:80,height:100},max_dimension:320});
    assert.equal(fake.captures,1);assert.equal(crop.metadata.frame_id,full.metadata.frame_id);assert.equal(crop.metadata.revision,1);
    assert.equal(crop.metadata.captured_at,full.metadata.captured_at);assert.deepEqual(crop.metadata.region,{x:160,y:20,width:80,height:100});
    const {data,info}=await sharp(crop.png).removeAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(info.width,80);assert.equal(info.height,100);assert.deepEqual([...data.subarray(0,3)],[0,0,255]);
  }finally{await engine.shutdown();}
});
test('overview rendering obeys requested image dimensions and pixel limit',{timeout:3000},async()=>{
  const {engine,session}=await setup({visual:true});
  try{
    const image=await engine.capture(session.session_id,{max_dimension:64,max_pixels:4096});
    const dimensions=await sharp(image.png).metadata();
    assert.ok(dimensions.width!<=64&&dimensions.height!<=64);assert.ok(dimensions.width!*dimensions.height!<=4096);
    assert.equal(image.metadata.output.width,dimensions.width);assert.equal(image.metadata.output.height,dimensions.height);
    assert.deepEqual(image.metadata.source,{width:320,height:200});
  }finally{await engine.shutdown();}
});
test('fresh visual frames have distinct identity even with unchanged semantic revision',{timeout:3000},async()=>{
  const {engine,fake,session}=await setup({visual:true});
  try{const a=await engine.capture(session.session_id),b=await engine.capture(session.session_id);assert.notEqual(a.metadata.frame_id,b.metadata.frame_id);assert.equal(a.metadata.revision,b.metadata.revision);assert.equal(fake.captures,2);}
  finally{await engine.shutdown();}
});
test('visual frame handles are session scoped and invalidated by close',{timeout:3000},async()=>{
  const {engine,session,id}=await setup({visual:true});
  try{
    const frame=await engine.capture(session.session_id);const second=await engine.open(id);
    await assert.rejects(engine.capture(second.session_id,{frame_id:frame.metadata.frame_id}),{code:'E_TARGET_NOT_FOUND'});
    await engine.close(session.session_id);
    await assert.rejects(engine.capture(session.session_id,{frame_id:frame.metadata.frame_id}),{code:'E_TARGET_NOT_FOUND'});
    assert.equal((await engine.observe(second.session_id)).revision,1);
  }finally{await engine.shutdown();}
});
test('malformed visual requests fail before capture and preserve session',{timeout:3000},async()=>{
  const {engine,fake,session}=await setup({visual:true});
  try{
    const bad:unknown[]=[{region:{x:0,y:0,width:20,height:20}},{frame_id:''},{max_dimension:63},{max_dimension:2049},{max_dimension:NaN},{max_pixels:4095},{max_pixels:4194305},{frame_id:'missing',region:{x:-1,y:0,width:10,height:10}},{frame_id:'missing',region:{x:0,y:0,width:0,height:10}}];
    for(const options of bad)await assert.rejects(engine.capture(session.session_id,options as VisualRequest),{code:'E_INVALID_ARGUMENT'});
    assert.equal(fake.captures,0);assert.equal((await engine.observe(session.session_id)).revision,1);
    const frame=await engine.capture(session.session_id);
    await assert.rejects(engine.capture(session.session_id,{frame_id:frame.metadata.frame_id,region:{x:300,y:0,width:40,height:40}}),{code:'E_INVALID_ARGUMENT'});
    assert.equal(fake.captures,1);
  }finally{await engine.shutdown();}
});
test('ordinary capture failure preserves the session for retry',{timeout:3000},async()=>{
  const {engine,fake,session}=await setup({visual:true});
  try{fake.captureError=new AdlError('E_PRIVACY_BLOCKED');await assert.rejects(engine.capture(session.session_id),{code:'E_PRIVACY_BLOCKED'});assert.equal(fake.closed,0);fake.captureError=undefined;const image=await engine.capture(session.session_id);assert.equal(image.metadata.session_id,session.session_id);}
  finally{await engine.shutdown();}
});
test('provider-reported timeout invalidates the session and its existing frames',{timeout:3000},async()=>{
 const {engine,fake,session}=await setup({visual:true});
 try{const prior=await engine.capture(session.session_id);fake.captureError=new AdlError('E_TIMEOUT');await assert.rejects(engine.capture(session.session_id),{code:'E_TIMEOUT'});assert.equal(fake.closed,1);await assert.rejects(engine.capture(session.session_id,{frame_id:prior.metadata.frame_id}),{code:'E_TARGET_NOT_FOUND'});}
 finally{await engine.shutdown();}
});
test('desktop without capture explicitly reports unsupported action',{timeout:3000},async()=>{
  const {engine,fake,session}=await setup({desktop:true,supported:false});
  try{await assert.rejects(engine.capture(session.session_id),{code:'E_UNSUPPORTED_ACTION'});assert.equal(fake.captures,0);assert.equal((await engine.observe(session.session_id)).revision,1);}
  finally{await engine.shutdown();}
});
test('capture cancellation closes session and rejects late image retention',{timeout:3000},async()=>{
  const {engine,fake,session}=await setup({visual:true});
  const old=await engine.capture(session.session_id);fake.gate=deferred();fake.entered=deferred();const abort=new AbortController();
  try{
    const capturing=engine.capture(session.session_id,{},abort.signal);const rejected=assert.rejects(capturing,{code:'E_CANCELLED'});
    await fake.entered.promise;abort.abort();await rejected;assert.equal(fake.closed,1);
    fake.gate.resolve();await delay(10);
    await assert.rejects(engine.capture(session.session_id,{frame_id:old.metadata.frame_id}),{code:'E_TARGET_NOT_FOUND'});
  }finally{fake.gate.resolve();await engine.shutdown();}
});
test('capture timeout closes session even when adapter resolves later',{timeout:3000},async()=>{
  const {engine,fake,session}=await setup({visual:true,timeout:100});
  const old=await engine.capture(session.session_id);fake.gate=deferred();
  try{await assert.rejects(engine.capture(session.session_id),{code:'E_TIMEOUT'});assert.equal(fake.closed,1);fake.gate.resolve();await delay(10);await assert.rejects(engine.capture(session.session_id,{frame_id:old.metadata.frame_id}),{code:'E_TARGET_NOT_FOUND'});}
  finally{fake.gate.resolve();await engine.shutdown();}
});
test('shutdown cancels in-flight capture and rejects subsequent observations',{timeout:3000},async()=>{
  const {engine,fake,session}=await setup({visual:true});fake.gate=deferred();fake.entered=deferred();
  try{
    const capturing=engine.capture(session.session_id);const rejected=assert.rejects(capturing,{code:'E_CANCELLED'});
    await fake.entered.promise;await engine.shutdown();await rejected;fake.gate.resolve();await delay(10);
    await assert.rejects(engine.capture(session.session_id),{code:'E_CANCELLED'});assert.equal(fake.closed,1);
  }finally{fake.gate.resolve();await engine.shutdown();}
});
test('concurrent captures serialize adapter work',{timeout:3000},async()=>{
  const {engine,fake,session}=await setup({visual:true});fake.gate=deferred();fake.entered=deferred();
  try{
    const a=engine.capture(session.session_id),b=engine.capture(session.session_id);await fake.entered.promise;
    assert.equal(fake.captures,1);fake.gate.resolve();const [first,second]=await Promise.all([a,b]);
    assert.equal(fake.captures,2);assert.equal(fake.maxActive,1);assert.notEqual(first.metadata.frame_id,second.metadata.frame_id);
  }finally{fake.gate.resolve();await engine.shutdown();}
});
