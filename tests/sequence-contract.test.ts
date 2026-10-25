import {test} from 'node:test';import assert from 'node:assert/strict';
import {recordSequence} from '../src/sequence.js';
import {AdlError} from '../src/types.js';
import type {SequenceHooks,SequenceOptions} from '../src/sequence-types.js';
import type {VisualObservation} from '../src/visual-types.js';
interface Opts{session?:string;target?:string;bytes?:number;latency?:number;failCaptureAt?:number;ok?:boolean;dupAt?:number}
function makeImage(i:number,now:number,opts:Opts):VisualObservation{
 const ok=(opts.ok!==false) as true;
 return {metadata:{ok,session_id:'s1',target_id:'t1',revision:1,frame_id:`f_${i}`,captured_at:new Date(1000+now).toISOString(),expires_at:new Date(61000+now).toISOString(),media_type:'image/png',coordinate_space:'viewport_css_pixels',viewport:{width:8,height:6,scroll_x:0,scroll_y:0,device_scale_factor:1},source:{width:8,height:6},region:{x:0,y:0,width:8,height:6},output:{width:8,height:6,source_pixels_per_output_x:1,source_pixels_per_output_y:1},redacted:true,estimated_patch_tokens:1,token_estimate_basis:'32px_grid_not_model_billing'},png:Buffer.alloc(opts.bytes??10)};
}
function fixture(extra:Partial<SequenceHooks>={},opts:Opts={}){
 let now=0,count=0;const discarded:string[][]=[];const images:VisualObservation[]=[];const sleeps:number[]=[];const retained:string[]=[];const captureOpts:unknown[]=[];
 const hooks:SequenceHooks={now:()=>now,sleep:async(ms,signal)=>{sleeps.push(ms);if(signal.aborted)throw new AdlError('E_CANCELLED');now+=ms;},capture:async(o,signal)=>{captureOpts.push(o);if(signal.aborted)throw new AdlError('E_CANCELLED');now+=opts.latency??20;const i=++count;if(opts.failCaptureAt===i)throw new AdlError('E_PRIVACY_BLOCKED');const image=makeImage(i,now,opts);if(i>1&&opts.session)image.metadata.session_id=opts.session;if(i>1&&opts.target)image.metadata.target_id=opts.target;if(opts.dupAt===i)image.metadata.frame_id='f_'+(i-1);images.push(image);return image;},assertRetained:async(frame_id,signal)=>{if(signal.aborted)throw new AdlError('E_CANCELLED');retained.push(frame_id);},discard:ids=>discarded.push([...ids]),...extra};
 return {hooks,discarded,images,sleeps,retained,captureOpts,advance:(d:number)=>{now+=d;},clock:()=>now};
}
test('defaults: 8 frames, 250ms interval, max_dimension 512, max_pixels 262144',async()=>{
 const f=fixture();const r=await recordSequence(f.hooks,{},new AbortController().signal);
 assert.equal(r.frames.length,8);assert.equal(r.metadata.requested_interval_ms,250);
 assert.deepEqual(f.captureOpts[0],{max_dimension:512,max_pixels:262144});
 assert.equal(f.sleeps.length,7);assert.equal(f.sleeps[0],230);
});
test('reject null, array, unknown key, non-integer before any capture',async()=>{
 for(const o of [null,[],{nope:1},{frame_count:2.5},{interval_ms:100.5},{max_dimension:NaN},{max_pixels:'4096'}] as unknown[]){
  const f=fixture();await assert.rejects(recordSequence(f.hooks,o as SequenceOptions,new AbortController().signal),{code:'E_INVALID_ARGUMENT'});
  assert.equal(f.images.length,0,'no capture for '+JSON.stringify(o));assert.equal(f.discarded.length,0);
 }
});
test('valid boundary: 16 frames at 400ms (span 6000) succeeds',async()=>{
 const f=fixture();const r=await recordSequence(f.hooks,{frame_count:16,interval_ms:400},new AbortController().signal);
 assert.equal(r.frames.length,16);assert.equal(f.sleeps.length,15);assert.equal(f.discarded.length,0);
});
test('target_id change and duplicate frame_ids both fail with E_STALE_STATE and discard all captured',async()=>{
 const t=fixture({},{target:'t2'});await assert.rejects(recordSequence(t.hooks,{frame_count:3,interval_ms:50},new AbortController().signal),{code:'E_STALE_STATE'});
 const tDiscard=t.discarded.flat();assert.ok(tDiscard.includes('f_1')&&tDiscard.includes('f_2'),'target discard '+tDiscard);
 const d=fixture({},{dupAt:2});await assert.rejects(recordSequence(d.hooks,{frame_count:3,interval_ms:50},new AbortController().signal),{code:'E_STALE_STATE'});
 assert.ok(d.discarded.flat().includes('f_1'),'dup discard '+d.discarded.flat());
});
test('capture latency exceeding interval avoids negative or zero sleep',async()=>{
 const f=fixture({},{latency:100});const r=await recordSequence(f.hooks,{frame_count:3,interval_ms:50},new AbortController().signal);
 assert.equal(r.frames.length,3);assert.equal(f.sleeps.length,0,'sleeps should be skipped: '+f.sleeps);
});
test('per-frame capture timestamps (elapsed_ms) are unchanged by retention',async()=>{
 const f=fixture();const r=await recordSequence(f.hooks,{frame_count:4,interval_ms:100},new AbortController().signal);
 assert.deepEqual(r.metadata.frames.map(x=>x.elapsed_ms),[20,120,220,320]);
 assert.deepEqual(f.retained,['f_1','f_2','f_3','f_4']);
});
test('retention asserts every frame; a rejection drops all frames',async()=>{
 const ok=fixture();await recordSequence(ok.hooks,{frame_count:3,interval_ms:50},new AbortController().signal);
 assert.deepEqual(ok.retained,['f_1','f_2','f_3']);assert.equal(ok.discarded.length,0);
 const bad=fixture();bad.hooks.assertRetained=async(id)=>{bad.retained.push(id);throw new AdlError('E_TARGET_NOT_FOUND');};
 await assert.rejects(recordSequence(bad.hooks,{frame_count:3,interval_ms:50},new AbortController().signal),{code:'E_TARGET_NOT_FOUND'});
 const bd=bad.discarded.flat();assert.ok(bd.includes('f_1')&&bd.includes('f_3'),'retention discard '+bd);
});
test('cancellation during DEFAULT sleep clears the timer promptly (<300ms with interval 2000)',async()=>{
 const ac=new AbortController();let count=0;const discarded:string[][]=[];
 const hooks:SequenceHooks={capture:async()=>{count++;return makeImage(count,0,{});},assertRetained:async()=>{},discard:ids=>discarded.push([...ids])};
 const p=recordSequence(hooks,{frame_count:3,interval_ms:2000},ac.signal);
 const t0=Date.now();setTimeout(()=>ac.abort(),20);
 await assert.rejects(p,{code:'E_CANCELLED'});
 assert.ok(Date.now()-t0<300,'took '+(Date.now()-t0)+'ms');assert.ok(discarded.flat().includes('f_1'));
});
test('cancellation immediately after capture still discards the captured frame',async()=>{
 const ac=new AbortController();const f=fixture();const orig=f.hooks.capture;
 f.hooks.capture=async(o,signal)=>{const img=await orig(o,signal);ac.abort();return img;};
 await assert.rejects(recordSequence(f.hooks,{frame_count:2,interval_ms:50},ac.signal),{code:'E_CANCELLED'});
 assert.ok(f.discarded.flat().includes('f_1'),'post-capture discard '+f.discarded.flat());
});
