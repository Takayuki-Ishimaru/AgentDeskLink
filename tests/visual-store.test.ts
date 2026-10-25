import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {randomFillSync} from 'node:crypto';
import {VisualStore} from '../src/visual.js';
import type {CapturedImage} from '../src/visual-types.js';
const owner={session_id:'s1',target_id:'t1',revision:3};
async function image(width=8,height=6):Promise<CapturedImage>{
 const pixels=Buffer.alloc(width*height*3);
 for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*3;pixels[i]=x<width/2?255:0;pixels[i+2]=x<width/2?0:255;}
 return {png:await sharp(pixels,{raw:{width,height,channels:3}}).png().toBuffer(),captured_at:'2026-10-24T00:00:00.000Z',coordinate_space:'viewport_css_pixels',viewport:{width,height,scroll_x:0,scroll_y:10,device_scale_factor:1},redacted:true};
}
test('visual store retains rendered pixels and returns exact crop from the same immutable frame',async()=>{
 const store=new VisualStore();const source=await image();const id=await store.record(owner,source);
 const full=await store.view('s1',id);assert.equal(full.metadata.frame_id,id);assert.equal(full.metadata.revision,3);assert.equal(full.metadata.captured_at,source.captured_at);assert.deepEqual(full.metadata.source,{width:8,height:6});
 source.png.fill(0);source.viewport.scroll_y=999;
 const crop=await store.view('s1',id,{region:{x:4,y:1,width:3,height:4}});
 assert.equal(crop.metadata.frame_id,id);assert.equal(crop.metadata.viewport.scroll_y,10);assert.equal(crop.metadata.output.width,3);assert.equal(crop.metadata.output.height,4);
 const raw=await sharp(crop.png).removeAlpha().raw().toBuffer();for(let i=0;i<raw.length;i+=3)assert.deepEqual([...raw.subarray(i,i+3)],[0,0,255]);
 assert.equal(crop.metadata.output.source_pixels_per_output_x,1);
});
test('visual output is bounded, never upscaled, and maps output coordinates back to source',async()=>{
 const store=new VisualStore();const id=await store.record(owner,await image(256,128));
 const view=await store.view('s1',id,{max_dimension:64,max_pixels:4096});
 assert.equal(view.metadata.output.width,64);assert.equal(view.metadata.output.height,32);assert.equal(view.metadata.output.source_pixels_per_output_x,4);assert.equal(view.metadata.estimated_patch_tokens,2);
 const small=await store.record(owner,await image());assert.equal((await store.view('s1',small,{max_dimension:2048})).metadata.output.width,8);
});
test('visual views reject foreign frames, invalid regions, and invalid budgets',async()=>{
 const store=new VisualStore();const id=await store.record(owner,await image());
 await assert.rejects(store.view('s2',id),{code:'E_TARGET_NOT_FOUND'});
 for(const region of [{x:-1,y:0,width:1,height:1},{x:7,y:0,width:2,height:1},{x:0,y:0,width:0,height:1},{x:NaN,y:0,width:1,height:1},{x:0.5,y:0,width:1,height:1}])await assert.rejects(store.view('s1',id,{region}),{code:'E_INVALID_ARGUMENT'});
 for(const options of [{max_dimension:0},{max_dimension:4097},{max_pixels:1},{max_pixels:Infinity}])await assert.rejects(store.view('s1',id,options),{code:'E_INVALID_ARGUMENT'});
});
test('frame ownership, TTL, eviction, session close and clear invalidate retained images',async()=>{
 let now=1000;const store=new VisualStore({max_frames:2,ttl_ms:100,now:()=>now});
 const a=await store.record(owner,await image()),b=await store.record(owner,await image()),c=await store.record({...owner,session_id:'s2'},await image());
 await assert.rejects(store.view('s1',a),{code:'E_TARGET_NOT_FOUND'});assert.ok(await store.view('s1',b));store.dropSession('s1');await assert.rejects(store.view('s1',b),{code:'E_TARGET_NOT_FOUND'});
 now+=101;await assert.rejects(store.view('s2',c),{code:'E_TARGET_NOT_FOUND'});
 const d=await store.record(owner,await image());store.clear();await assert.rejects(store.view('s1',d),{code:'E_TARGET_NOT_FOUND'});
});
test('visual source budgets, malformed PNG and cancellation fail without retained images',async()=>{
 const source=await image();await assert.rejects(new VisualStore({max_bytes:1}).record(owner,source),{code:'E_RESOURCE_LIMIT'});
 await assert.rejects(new VisualStore().record(owner,{...source,png:Buffer.from('invalid')}),{code:'E_INVALID_ARGUMENT'});
 const cancel=new AbortController();cancel.abort();const store=new VisualStore();await assert.rejects(store.record(owner,source,cancel.signal),{code:'E_CANCELLED'});
 const id=await store.record(owner,source);await assert.rejects(store.view('s1',id,{},cancel.signal),{code:'E_CANCELLED'});
 const results=await Promise.all([store.record(owner,source),store.record(owner,source)]);assert.notEqual(results[0],results[1]);
});
test('total retained bytes evict oldest images before admitting another source',async()=>{
 const source=await image();const store=new VisualStore({max_bytes:source.png.length+1});const a=await store.record(owner,source);const b=await store.record(owner,source);
 await assert.rejects(store.view('s1',a),{code:'E_TARGET_NOT_FOUND'});assert.ok(await store.view('s1',b));
});
test('drop and clear during asynchronous decode prevent late insertion without affecting sibling sessions',async()=>{
 for(const clear of [false,true]){
   const store=new VisualStore();const pending=store.record(owner,await image(512,512));const rejected=assert.rejects(pending,{code:'E_CANCELLED'});if(clear)store.clear();else store.dropSession('s1');await rejected;
 }
 const store=new VisualStore();const source=await image(512,512);const pending=store.record({...owner,session_id:'s2'},source);store.dropSession('s1');const id=await pending;assert.ok(await store.view('s2',id));
});
test('source metadata is copied before decoding and uniformly transparent images are valid',async()=>{
 const store=new VisualStore();const source=await image(256,256);const pending=store.record(owner,source);source.viewport.scroll_y=1234;const id=await pending;assert.equal((await store.view('s1',id)).metadata.viewport.scroll_y,10);
 const transparent=await sharp({create:{width:8,height:6,channels:4,background:{r:255,g:0,b:0,alpha:0.5}}}).png().toBuffer();
 const capture={...await image(),png:transparent};const alpha=await store.record(owner,capture);assert.ok(await store.view('s1',alpha));
});
test('oversized compressed PNG headers are resource errors and mutable crop options cannot change result metadata',async()=>{
 const store=new VisualStore();const large=await image(2100,2100);await assert.rejects(store.record(owner,large),{code:'E_RESOURCE_LIMIT'});
 const source=await image(256,128);const id=await store.record(owner,source);const region={x:128,y:0,width:64,height:64};const viewing=store.view('s1',id,{region});region.x=0;const view=await viewing;assert.equal(view.metadata.region.x,128);
 assert.deepEqual([...await sharp(view.png).removeAlpha().extract({left:0,top:0,width:1,height:1}).raw().toBuffer()],[0,0,255]);
});
test('high-entropy output stays within the MCP stdio envelope or fails safely before base64 expansion',async()=>{
 const width=1660,height=1660;const png=await sharp(randomFillSync(Buffer.alloc(width*height*3)),{raw:{width,height,channels:3}}).png().toBuffer();assert.ok(png.length<8*1024*1024);
 const store=new VisualStore();const capture={...await image(),png,viewport:{width,height,scroll_x:0,scroll_y:0,device_scale_factor:1}};const id=await store.record(owner,capture);
 await assert.rejects(store.view('s1',id,{max_dimension:2048,max_pixels:4194304}),{code:'E_RESOURCE_LIMIT'});
 const overview=await store.view('s1',id);assert.ok(overview.png.length<=6*1024*1024);assert.ok(Buffer.byteLength(JSON.stringify({content:[{type:'text',text:JSON.stringify(overview.metadata)},{type:'image',data:overview.png.toString('base64'),mimeType:'image/png'}]}))<10*1024*1024);
});
