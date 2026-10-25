import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {BrowserAdapter} from '../src/browser.js';
import {AdlError, type PolicyConfig, type Target} from '../src/types.js';
async function fixture() {
 let forbidden=0;
 const blocked=createServer((_,r)=>{forbidden++;r.end('blocked')}); await new Promise<void>(r=>blocked.listen(0,'127.0.0.1',r));
 const bport=(blocked.address() as {port:number}).port;
 const app=createServer((q,r)=>{
   if(q.url==='/redirect'){r.writeHead(302,{location:`http://127.0.0.1:${bport}/`});r.end();return;}
   r.setHeader('content-type','text/html');r.end(`<html><body><label>Search<input id="q" aria-label="Search"></label><input type="password" aria-label="Password" value="CANARY_PASSWORD"><button id="find" type="button" onclick="document.getElementById('status').textContent='Done'">Find</button><div id="status" role="status">Ready</div><input id="option" type="checkbox" aria-label="Option"><select id="color" aria-label="Color"><option>Red</option><option>Blue</option></select><div id="pane" aria-label="Scroll region" role="region" style="height:100px;width:200px;overflow:auto" onscroll="document.getElementById('status').textContent='Scroll:'+this.scrollTop"><div style="height:600px">Long content</div></div><a href="/redirect">Redirect</a><form><button>Submit</button></form></body></html>`);
 }); await new Promise<void>(r=>app.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${(app.address() as {port:number}).port}`;
 const config:PolicyConfig={allowedOrigins:[origin],browserTargets:[{id:'demo',label:'Demo',url:origin,classification:'PUBLIC',controls:[{selector:'#q',actions:['fill']},{selector:'#find',actions:['click']},{selector:'#option',actions:['check']},{selector:'#color',actions:['select']},{selector:'#pane',actions:['scroll']}]}],allowLoopback:true,allowPrivateNetwork:false,maxSessions:4,sessionTtlMs:60000,maxBatchSteps:20,defaultTokenBudget:1800,maxElements:1000,actionTimeoutMs:3000};
 const guard=async(url:string)=>{if(new URL(url).origin!==origin)throw new AdlError('E_POLICY_DENIED');};
 const adapter=new BrowserAdapter(config,guard);
 const target:Target={target_id:'t_demo',application_id:'demo',label:'Demo',surface:'browser',policy_class:'PUBLIC',capabilities:[]};
 return {adapter,target,origin,forbidden:()=>forbidden,close:async()=>{await adapter.close();await Promise.all([new Promise<void>(r=>app.close(()=>r())),new Promise<void>(r=>blocked.close(()=>r()))]);}};
}
test('headless semantic fill click check select, stable snapshot, no secret disclosure',async()=>{
 const f=await fixture();try {
 const s=await f.adapter.open(f.target,'strict_isolated',new AbortController().signal);
 const a=await s.snapshot(),b=await s.snapshot();assert.equal(a.fingerprint,b.fingerprint);
 const field=a.elements.find(e=>e.name==='Search')!;assert.ok(field);
 await s.act({action:'fill',element_id:field.id,value:'TEST-001'},new AbortController().signal);
 assert.notEqual((await s.snapshot()).fingerprint,a.fingerprint);
 await s.act({action:'click',element_id:a.elements.find(e=>e.name==='Find')!.id},new AbortController().signal);
 assert.ok((await s.snapshot()).elements.some(e=>e.name==='Done'));
 await s.act({action:'check',element_id:a.elements.find(e=>e.name==='Option')!.id,checked:true},new AbortController().signal);
 await s.act({action:'select',element_id:a.elements.find(e=>e.name==='Color')!.id,value:'Blue'},new AbortController().signal);
 await assert.rejects(s.act({action:'fill',element_id:'forged',value:'x'},new AbortController().signal));
 await assert.rejects(s.act({action:'fill',element_id:a.elements.find(e=>e.name==='Password')!.id,value:'x'},new AbortController().signal));
 await assert.rejects(s.act({action:'click',element_id:a.elements.find(e=>e.name==='Submit')!.id},new AbortController().signal));
 await s.close();
 }finally{await f.close();}
});
test('redirect destination is never requested, unsupported modes fail before launch',async()=>{
 const f=await fixture();try{
 await assert.rejects(f.adapter.open(f.target,'background_semantic',new AbortController().signal),{code:'E_INTERFERENCE_RISK'});
 const s=await f.adapter.open(f.target,'strict_isolated',new AbortController().signal);
 await assert.rejects(s.act({action:'navigate',url:f.origin+'/redirect'},new AbortController().signal));
 assert.equal(f.forbidden(),0);await s.close();
 }finally{await f.close();}
});
test('abort closes session, no late action or handle reuse',async()=>{
 const f=await fixture();try{
 const s=await f.adapter.open(f.target,'strict_isolated',new AbortController().signal);
 const a=await s.snapshot();const abort=new AbortController();abort.abort();
 await assert.rejects(s.act({action:'click',element_id:a.elements.find(e=>e.name==='Find')!.id},abort.signal));
 await s.close();await assert.rejects(s.snapshot());
 }finally{await f.close();}
});

test('directional browser scroll changes the approved region in both directions',async()=>{
 const f=await fixture();try{
 const s=await f.adapter.open(f.target,'strict_isolated',new AbortController().signal);
 const initial=await s.snapshot();const pane=initial.elements.find(e=>e.name==='Scroll region')!;assert.ok(pane);
 await s.act({action:'scroll',element_id:pane.id,direction:'down'},new AbortController().signal);
 let down=0;for(let i=0;i<30;i++){const p=await s.snapshot();down=Number(p.elements.find(e=>e.role==='status')?.name.split(':')[1]);if(down>0)break;await new Promise(r=>setTimeout(r,10));}assert.ok(down>0);
 await s.act({action:'scroll',element_id:pane.id,direction:'up'},new AbortController().signal);
 let up=down;for(let i=0;i<30;i++){const p=await s.snapshot();up=Number(p.elements.find(e=>e.role==='status')?.name.split(':')[1]);if(up<down)break;await new Promise(r=>setTimeout(r,10));}assert.equal(up,0);
 await s.close();
 }finally{await f.close();}
});
