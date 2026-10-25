import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import sharp from 'sharp';
import {Engine} from '../src/core.js';
import {BrowserAdapter} from '../src/browser.js';
import {parsePolicy,assertUrlAllowed} from '../src/policy.js';

async function fixture(maskSelectors=['#private'],enabled=true){
 const asset=await sharp({create:{width:80,height:40,channels:3,background:'#00ff00'}}).png().toBuffer();
 const http=createServer((q,r)=>{
   if(q.url==='/asset.png'){r.setHeader('content-type','image/png');r.end(asset);return;}
   r.setHeader('content-type','text/html');r.end(`<!doctype html><html><body style="margin:0;background:white">
    <canvas id="art" width="320" height="120" style="position:absolute;left:0;top:0"></canvas>
    <img src="/asset.png" style="position:absolute;left:0;top:130px;width:80px;height:40px" onload="document.getElementById('status').textContent='Image ready'">
    <input aria-label="Reference" value="CANARY_INPUT" style="position:absolute;left:400px;top:10px;width:160px;height:40px">
    <div id="private" style="position:absolute;left:600px;top:10px;width:160px;height:40px;background:yellow">CANARY_PRIVATE</div>
    <div data-adl-sensitive style="position:absolute;left:800px;top:10px;width:160px;height:40px;background:cyan">CANARY_SENSITIVE</div>
    <button id="repaint" type="button" style="position:absolute;left:400px;top:100px" onclick="paint(true)">Repaint</button>
    <div role="status" id="status" style="position:absolute;top:200px">Loading</div>
    <script>function paint(changed){const c=document.getElementById('art').getContext('2d');c.fillStyle=changed?'#00ff00':'#ff0000';c.fillRect(0,0,160,120);c.fillStyle='#0000ff';c.fillRect(160,0,160,120);}paint(false);</script>
   </body></html>`);
 });await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${(http.address() as {port:number}).port}`;
 const policy=parsePolicy({allowedOrigins:[origin],allowLoopback:true,browserTargets:[{id:'visual',label:'Visual fixture',url:origin,classification:'PUBLIC',visual:{enabled,maskSelectors},controls:[{selector:'#repaint',actions:['click']}]}]});
 const engine=new Engine(policy,{browser:new BrowserAdapter(policy,u=>assertUrlAllowed(u,policy))});
 const target=(await engine.listTargets()).targets[0]!;const session=await engine.open(target.target_id);
 await engine.wait(session.session_id,{role:'status',name:'Image ready'},3000);
 return {engine,session,target,close:async()=>{await engine.shutdown();await new Promise<void>(r=>http.close(()=>r()));}};
}
async function pixel(png:Buffer,x:number,y:number){const {data,info}=await sharp(png).removeAlpha().raw().toBuffer({resolveWithObject:true});return [...data.subarray((y*info.width+x)*info.channels,(y*info.width+x)*info.channels+3)];}

test('real browser captures colored canvas and image, masks input/private pixels, and crops the retained original',async()=>{
 const f=await fixture();try{
  assert.ok(f.target.capabilities.includes('capture'));
  const full=await f.engine.capture(f.session.session_id,{max_dimension:2048});
  assert.deepEqual(await pixel(full.png,20,20),[255,0,0]);assert.deepEqual(await pixel(full.png,180,20),[0,0,255]);assert.deepEqual(await pixel(full.png,20,145),[0,255,0]);
  for(const [x,y] of [[410,20],[610,20],[810,20]])assert.deepEqual(await pixel(full.png,x!,y!),[0,0,0]);
  const crop=await f.engine.capture(f.session.session_id,{frame_id:full.metadata.frame_id,region:{x:160,y:0,width:160,height:120}});
  assert.equal(crop.metadata.frame_id,full.metadata.frame_id);assert.equal(crop.metadata.captured_at,full.metadata.captured_at);assert.deepEqual(await pixel(crop.png,10,10),[0,0,255]);
  const semantic=await f.engine.observe(f.session.session_id);const button=semantic.elements!.find(e=>e.name==='Repaint')!;
  await f.engine.act(f.session.session_id,{action:'click',element_id:button.id},semantic.revision);
  const fresh=await f.engine.capture(f.session.session_id,{max_dimension:2048});assert.notEqual(fresh.metadata.frame_id,full.metadata.frame_id);assert.equal(fresh.metadata.revision,full.metadata.revision);assert.deepEqual(await pixel(fresh.png,20,20),[0,255,0]);
  const historical=await f.engine.capture(f.session.session_id,{frame_id:full.metadata.frame_id,region:{x:0,y:0,width:40,height:40}});assert.deepEqual(await pixel(historical.png,10,10),[255,0,0]);
 }finally{await f.close();}
});
test('real browser refuses disabled images and invalid masks without unprotected fallback',async()=>{
 const disabled=await fixture([],false);try{assert.ok(!disabled.target.capabilities.includes('capture'));await assert.rejects(disabled.engine.capture(disabled.session.session_id),{code:'E_PRIVACY_BLOCKED'});}finally{await disabled.close();}
 const invalid=await fixture(['[invalid selector']);try{await assert.rejects(invalid.engine.capture(invalid.session.session_id),{code:'E_PRIVACY_BLOCKED'});assert.ok(await invalid.engine.observe(invalid.session.session_id));}finally{await invalid.close();}
});
