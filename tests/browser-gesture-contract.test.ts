import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import type {Page} from 'playwright';
import {runBrowserGesture} from '../src/browser-gesture.js';
import type {CapturedImage} from '../src/visual-types.js';
import type {GesturePlan,GesturePolicy} from '../src/gesture-types.js';

// Execute the supplied browser functions against a minimal DOM. The mock does not
// inspect source strings to guess which evaluate call the implementation made.
class FakeElement {
  tagName='CANVAS';isConnected=true;disabled=false;parentElement:FakeElement|null=null;
  constructor(readonly id:string,readonly rect={x:10,y:10,left:10,top:10,right:610,bottom:260,width:600,height:250}){}
  getBoundingClientRect(){return {...this.rect};}getClientRects(){return [this.getBoundingClientRect()];}
  checkVisibility(){return true;}contains(node:FakeElement){return node===this||node.parentElement===this;}
  matches(selector:string){return selector==='#board'||selector==='canvas';}
  closest(selector:string){if(selector.includes('input')||selector.includes('iframe')||selector.includes('button')||selector.includes('data-adl-sensitive'))return null;return null;}
  getAttribute(name:string){return name==='id'?this.id:null;}hasAttribute(){return false;}
}
class FakeInput extends FakeElement {}
function fake(){
  const surface=new FakeElement('board');
  const state={origin:'https://example.com/fixture',width:1000,height:700,scrollX:0,scrollY:0,dpr:1,touchAction:'none',count:1,occluded:false,throwMove:false,aborted:false};
  const events:{kind:string;x?:number;y?:number;type?:string;touchPoints?:unknown[]}[]=[];
  const unsafe=new FakeInput('password');unsafe.tagName='INPUT';
  const document={querySelectorAll:(selector:string)=>selector==='#board'?Array.from({length:state.count},()=>surface):[],querySelector:(selector:string)=>selector==='#board'?surface:null,elementFromPoint:()=>state.occluded?unsafe:surface,elementsFromPoint:()=>[state.occluded?unsafe:surface]};
  const run=(fn:unknown,args:unknown[])=>{assert.equal(typeof fn,'function','Page.evaluate must receive executable functions');return runInNewContext(`(${String(fn)})(...args)`,{args,document,window:{innerWidth:state.width,innerHeight:state.height,scrollX:state.scrollX,scrollY:state.scrollY,devicePixelRatio:state.dpr,location:{origin:new URL(state.origin).origin}},location:{origin:new URL(state.origin).origin},Element:FakeElement,HTMLElement:FakeElement,HTMLInputElement:FakeInput,HTMLTextAreaElement:FakeInput,HTMLSelectElement:FakeInput,getComputedStyle:()=>({touchAction:state.touchAction,display:'block',visibility:'visible',opacity:'1',pointerEvents:'auto',getPropertyValue:(name:string)=>name==='touch-action'?state.touchAction:''}),URL,Number,Math,Date});};
  const handle={evaluate:async(fn:unknown,arg:unknown)=>run(fn,[surface,arg]),dispose:async()=>{},asElement(){return this;},boundingBox:async()=>surface.getBoundingClientRect()};
  const locator={count:async()=>state.count,first(){return this;},nth(){return this;},elementHandle:async()=>handle,boundingBox:async()=>surface.getBoundingClientRect(),isVisible:async()=>true,evaluate:async(fn:unknown,arg:unknown)=>run(fn,[surface,arg])};
  const cdp={send:async(method:string,arg:any)=>{events.push({kind:method,...arg});},detach:async()=>{events.push({kind:'detach'});}};
  const page={url:()=>state.origin,evaluate:async(fn:unknown,arg:unknown)=>run(fn,[arg]),evaluateHandle:async()=>handle,locator:()=>locator,context:()=>({newCDPSession:async()=>cdp}),mouse:{move:async(x:number,y:number)=>{events.push({kind:'move',x,y});if(state.throwMove&&events.some(e=>e.kind==='down'))throw new Error('CANARY_INPUT_FAILURE');},down:async()=>{events.push({kind:'down'});},up:async()=>{events.push({kind:'up'});}},isClosed:()=>false} as unknown as Page;
  const policy:GesturePolicy={enabled:true,surfaces:[{id:'board',selector:'#board',kinds:['drag','swipe']}]};
  const reference={png:Buffer.from('not-decoded-by-gesture'),captured_at:new Date().toISOString(),coordinate_space:'viewport_css_pixels',viewport:{width:1000,height:700,scroll_x:0,scroll_y:0,device_scale_factor:1},redacted:true,origin:'https://example.com'} as CapturedImage;
  const plan:GesturePlan={surface_id:'board',kind:'drag',points:[{x:50,y:50,t_ms:0},{x:150,y:70,t_ms:20},{x:250,y:100,t_ms:40}]};
  return {page,state,events,policy,reference,plan};
}
function inputEvents(events:{kind:string}[]){return events.filter(e=>e.kind==='down'||e.kind==='move'||e.kind==='up'||e.kind==='Input.dispatchTouchEvent');}

test('gesture module: disabled, absent or wrong-kind surface never emits input',{timeout:3000},async()=>{
 for(const kind of ['disabled','missing','wrong-kind'] as const){const f=fake();if(kind==='disabled')f.policy.enabled=false;if(kind==='missing')f.plan.surface_id='missing';if(kind==='wrong-kind')f.policy.surfaces[0]!.kinds=['swipe'];await assert.rejects(runBrowserGesture(f.page,f.plan,f.policy,f.reference,new AbortController().signal,()=>{}));assert.equal(inputEvents(f.events).length,0);}
});
test('gesture module: invalid points/timing and non-unique surfaces fail before input',{timeout:3000},async()=>{
 const cases=[(f:ReturnType<typeof fake>)=>{f.plan.points[1]!.x=NaN;},(f:ReturnType<typeof fake>)=>{f.plan.points[1]!.t_ms=-1;},(f:ReturnType<typeof fake>)=>{f.plan.points[1]!.t_ms=50;},(f:ReturnType<typeof fake>)=>{f.plan.points[2]!.t_ms=5001;},(f:ReturnType<typeof fake>)=>{f.plan.points[1]!.x=800;},(f:ReturnType<typeof fake>)=>{f.plan.points=[];},(f:ReturnType<typeof fake>)=>{f.state.count=2;}];
 for(const change of cases){const f=fake();change(f);await assert.rejects(runBrowserGesture(f.page,f.plan,f.policy,f.reference,new AbortController().signal,()=>{}));assert.equal(inputEvents(f.events).length,0);}
});
test('gesture module: stale geometry, document generation and sensitive occlusion fail before input',{timeout:3000},async()=>{
 for(const change of [(f:ReturnType<typeof fake>)=>{f.state.scrollY=5;},(f:ReturnType<typeof fake>)=>{f.state.width=999;},(f:ReturnType<typeof fake>)=>{f.state.dpr=2;},(f:ReturnType<typeof fake>)=>{f.state.occluded=true;}]){const f=fake();change(f);await assert.rejects(runBrowserGesture(f.page,f.plan,f.policy,f.reference,new AbortController().signal,()=>{}));assert.equal(inputEvents(f.events).length,0);}
 const f=fake();await assert.rejects(runBrowserGesture(f.page,f.plan,f.policy,f.reference,new AbortController().signal,()=>{throw Object.assign(new Error('stale'),{code:'E_STALE_STATE'});}));assert.equal(inputEvents(f.events).length,0);
});
test('gesture module: mouse drag releases once and reports input completion only',{timeout:3000},async()=>{
 const f=fake();const out=await runBrowserGesture(f.page,f.plan,f.policy,f.reference,new AbortController().signal,()=>{});assert.equal(out.released_input,true);assert.equal(out.kind,'drag');assert.equal(out.points_executed,3);assert.equal(out.verified,'input_sequence_completed');assert.equal(f.events.filter(e=>e.kind==='down').length,1);assert.equal(f.events.filter(e=>e.kind==='up').length,1);assert.ok(!f.events.some(e=>e.kind==='Input.dispatchTouchEvent'));
});
test('gesture module: swipe uses true CDP touch rather than mouse drag, then detaches',{timeout:3000},async()=>{
 const f=fake();f.plan.kind='swipe';const out=await runBrowserGesture(f.page,f.plan,f.policy,f.reference,new AbortController().signal,()=>{});assert.equal(out.kind,'swipe');assert.equal(out.released_input,true);assert.ok(!f.events.some(e=>['down','move','up'].includes(e.kind)));const touch=f.events.filter(e=>e.kind==='Input.dispatchTouchEvent');assert.equal(touch[0]!.type,'touchStart');assert.ok(touch.some(e=>e.type==='touchMove'));assert.ok(touch.some(e=>e.type==='touchEnd'&&e.touchPoints?.length===0));assert.ok(f.events.some(e=>e.kind==='detach'));
});
test('gesture module: touch auto surfaces are unsupported before input',{timeout:3000},async()=>{
 const f=fake();f.plan.kind='swipe';f.state.touchAction='auto';await assert.rejects(runBrowserGesture(f.page,f.plan,f.policy,f.reference,new AbortController().signal,()=>{}));assert.equal(inputEvents(f.events).length,0);
});
test('gesture module: input errors and late document invalidation release pressed mouse',{timeout:3000},async()=>{
 const f=fake();f.state.throwMove=true;await assert.rejects(runBrowserGesture(f.page,f.plan,f.policy,f.reference,new AbortController().signal,()=>{}));assert.equal(f.events.filter(e=>e.kind==='down').length,1);assert.equal(f.events.filter(e=>e.kind==='up').length,1);
 const g=fake();let checks=0;await assert.rejects(runBrowserGesture(g.page,g.plan,g.policy,g.reference,new AbortController().signal,()=>{if(g.events.some(e=>e.kind==='down')&&++checks>=1)throw new Error('generation changed');}));assert.ok(g.events.some(e=>e.kind==='up'));
});
test('gesture module: pre-abort emits nothing; cancellation after press releases mouse',{timeout:3000},async()=>{
 const f=fake(),pre=new AbortController();pre.abort();await assert.rejects(runBrowserGesture(f.page,f.plan,f.policy,f.reference,pre.signal,()=>{}));assert.equal(inputEvents(f.events).length,0);
 const g=fake(),cancel=new AbortController();await assert.rejects(runBrowserGesture(g.page,g.plan,g.policy,g.reference,cancel.signal,()=>{if(g.events.some(e=>e.kind==='down'))cancel.abort();}));assert.ok(g.events.some(e=>e.kind==='up'));
});
