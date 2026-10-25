import {test} from 'node:test';import assert from 'node:assert/strict';
import {recordSequence} from '../src/sequence.js';
import {AdlError} from '../src/types.js';
import type {SequenceHooks} from '../src/sequence-types.js';
import type {VisualObservation} from '../src/visual-types.js';
function fixture(extra:Partial<SequenceHooks>={}){
 let now=0,count=0;const discarded:string[][]=[];const images:VisualObservation[]=[];
 const hooks:SequenceHooks={now:()=>now,sleep:async(ms,signal)=>{if(signal.aborted)throw new AdlError('E_CANCELLED');now+=ms;},capture:async(_options,signal)=>{if(signal.aborted)throw new AdlError('E_CANCELLED');now+=20;const i=++count;const image={metadata:{ok:true,session_id:'s1',target_id:'t1',revision:1,frame_id:`f_${i}`,captured_at:new Date(1000+now).toISOString(),expires_at:new Date(61000+now).toISOString(),media_type:'image/png',coordinate_space:'viewport_css_pixels',viewport:{width:8,height:6,scroll_x:0,scroll_y:0,device_scale_factor:1},source:{width:8,height:6},region:{x:0,y:0,width:8,height:6},output:{width:8,height:6,source_pixels_per_output_x:1,source_pixels_per_output_y:1},redacted:true,estimated_patch_tokens:1,token_estimate_basis:'32px_grid_not_model_billing'},png:Buffer.from(`frame ${i}`)} satisfies VisualObservation;images.push(image);return image;},assertRetained:async()=>{},discard:ids=>discarded.push([...ids]),...extra};return {hooks,discarded,images};
}
test('temporal recording returns ordered actual capture times and distinct original frame references',async()=>{
 const f=fixture();const result=await recordSequence(f.hooks,{frame_count:4,interval_ms:100},new AbortController().signal);
 assert.equal(result.frames.length,4);assert.equal(result.metadata.encoding,'timestamped_png_sequence');assert.equal(result.metadata.audio,false);assert.equal(result.metadata.sampling,'discrete_frames_unsampled_intervals');assert.equal(result.metadata.requested_interval_ms,100);assert.equal(new Set(result.metadata.frames.map(f=>f.frame_id)).size,4);assert.equal(result.metadata.frames[0]?.elapsed_ms,20);assert.ok(result.metadata.frames[3]!.elapsed_ms>=300);assert.equal(f.discarded.length,0);
});
test('invalid temporal budgets fail before any capture',async()=>{
 for(const options of [{frame_count:1},{frame_count:17},{interval_ms:49},{frame_count:16,interval_ms:2000},{max_dimension:4096},{max_pixels:1},{region:{x:0,y:0,width:1,height:1}}]){const f=fixture();await assert.rejects(recordSequence(f.hooks,options,new AbortController().signal),{code:'E_INVALID_ARGUMENT'});assert.equal(f.images.length,0);}
});
test('capture errors, lost frames, mixed owners and aggregate wire budget never return partial success',async()=>{
 for(const kind of ['capture','retention','owner','size']){
  const f=fixture();const capture=f.hooks.capture;let n=0;f.hooks.capture=async(options,signal)=>{const image=await capture(options,signal);n++;if(kind==='capture'&&n===2)throw new AdlError('E_PRIVACY_BLOCKED');if(kind==='owner'&&n===2)image.metadata.session_id='s2';if(kind==='size')image.png=Buffer.alloc(4*1024*1024);return image;};if(kind==='retention')f.hooks.assertRetained=async()=>{throw new AdlError('E_TARGET_NOT_FOUND');};
  await assert.rejects(recordSequence(f.hooks,{frame_count:2,interval_ms:50},new AbortController().signal));assert.ok(f.discarded.length>0);assert.ok(f.discarded.flat().includes('f_1'));
 }
});
test('pre-abort and abort during sampling cannot return images and discard completed frame references',async()=>{
 const pre=new AbortController();pre.abort();const f=fixture();await assert.rejects(recordSequence(f.hooks,{},pre.signal),{code:'E_CANCELLED'});assert.equal(f.images.length,0);
 const cancel=new AbortController();const second=fixture({sleep:async()=>{cancel.abort();}});await assert.rejects(recordSequence(second.hooks,{frame_count:3,interval_ms:100},cancel.signal),{code:'E_CANCELLED'});assert.ok(second.discarded.flat().includes('f_1'));
});
