import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {BrowserAdapter} from '../src/browser.js';
import {parsePolicy,assertUrlAllowed} from '../src/policy.js';
import type {AdapterSession,Target} from '../src/types.js';
async function fixture(html:string|((req:IncomingMessage,res:ServerResponse)=>void),controls:{selector:string;actions:string[]}[]=[],maxElements=500){
 let external=0,posts=0,popups=0,ws=0,mainRequests=0;
 const spy=createServer((_,r)=>{external++;r.end('forbidden');});await new Promise<void>(r=>spy.listen(0,'127.0.0.1',r));
 const forbidden=`http://127.0.0.1:${(spy.address() as {port:number}).port}`;
 const http=createServer((q,r)=>{
   if(q.url==='/')mainRequests++;
   if(q.method==='POST'){posts++;r.end();return;}
   if(q.url==='/popup'){popups++;r.end('popup');return;}
   if(typeof html==='function'){html(q,r);return;}
   r.setHeader('content-type','text/html');r.end(html.replaceAll('FORBIDDEN_ORIGIN',forbidden));
 });http.on('upgrade',(_,socket)=>{ws++;socket.destroy();});await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${(http.address() as {port:number}).port}`;
 const p=parsePolicy({allowedOrigins:[origin],allowLoopback:true,maxElements,browserTargets:[{id:'test',label:'Test',url:origin,classification:'PUBLIC',controls}]});
 const adapter=new BrowserAdapter(p,url=>assertUrlAllowed(url,p));const target:Target={target_id:'t',application_id:'test',label:'Test',surface:'browser',policy_class:'PUBLIC',capabilities:[]};
 return {adapter,target,origin,requested:()=>mainRequests,counts:()=>({external,posts,popups,ws}),close:async()=>{await adapter.close();await Promise.all([new Promise<void>(r=>http.close(()=>r())),new Promise<void>(r=>spy.close(()=>r()))]);}};
}
async function named(s:AdapterSession,name:string){for(let i=0;i<100;i++){const p=await s.snapshot();if(p.elements.some(e=>e.name===name))return p;await delay(20);}throw new Error('Condition missing');}
test('iframe, image, fetch, beacon, POST, WS and popup cannot contact forbidden destinations',async()=>{
 const f=await fixture(`<p role="status" id="s">Ready</p><iframe src="FORBIDDEN_ORIGIN/frame"></iframe><img src="FORBIDDEN_ORIGIN/image"><script>fetch('FORBIDDEN_ORIGIN/fetch').catch(()=>{});fetch('/write',{method:'POST',body:'canary'}).catch(()=>{});navigator.sendBeacon('/beacon','canary');new WebSocket(location.origin.replace('http','ws')+'/ws');window.open('/popup');setTimeout(()=>document.getElementById('s').textContent='Probe complete',200);</script>`);
 try{const s=await f.adapter.open(f.target,'strict_isolated',new AbortController().signal);await named(s,'Probe complete');assert.deepEqual(f.counts(),{external:0,posts:0,popups:0,ws:0});}finally{await f.close();}
});
test('replaced nodes never inherit old actionable handles',async()=>{
 const f=await fixture(`<input id="q" aria-label="Search"><button id="replace" type="button" onclick="document.getElementById('q').outerHTML='<input id=q aria-label=Search>'">Replace</button>`,[{selector:'#q',actions:['fill']},{selector:'#replace',actions:['click']}]);
 try{const s=await f.adapter.open(f.target,'strict_isolated',new AbortController().signal);const p=await s.snapshot();const old=p.elements.find(e=>e.name==='Search')!.id;await s.act({action:'click',element_id:p.elements.find(e=>e.name==='Replace')!.id},new AbortController().signal);const fresh=await s.snapshot();assert.notEqual(fresh.elements.find(e=>e.name==='Search')!.id,old);await assert.rejects(s.act({action:'fill',element_id:old,value:'x'},new AbortController().signal));}finally{await f.close();}
});
test('navigation changes document handle namespace and sessions never share handles',async()=>{
 const f=await fixture('<input id="q" aria-label="Search">',[{selector:'#q',actions:['fill']}]);try{
 const a=await f.adapter.open(f.target,'strict_isolated',new AbortController().signal),b=await f.adapter.open(f.target,'strict_isolated',new AbortController().signal);const old=(await a.snapshot()).elements[0]!.id;await assert.rejects(b.act({action:'fill',element_id:old,value:'x'},new AbortController().signal));
 await a.act({action:'navigate',url:f.origin+'/?page=2'},new AbortController().signal);const next=(await a.snapshot()).elements[0]!.id;assert.notEqual(old,next);await assert.rejects(a.act({action:'fill',element_id:old,value:'x'},new AbortController().signal));
 }finally{await f.close();}
});
test('page text cannot authorize a selector; ambiguous selectors fail closed',async()=>{
 const f=await fixture('<button id="approved" type="button">Continue</button><button id="unapproved" data-actions="click" type="button">Continue</button>',[{selector:'button',actions:['click']}]);try{const s=await f.adapter.open(f.target,'strict_isolated',new AbortController().signal);const p=await s.snapshot();for(const e of p.elements)await assert.rejects(s.act({action:'click',element_id:e.id},new AbortController().signal),{code:'E_APPROVAL_REQUIRED'});}finally{await f.close();}
});
test('depth and collection limits mark truncation; oversized fields fail safely',async()=>{
 for(const html of ['<div>'.repeat(15)+'<button>Deep</button>'+'</div>'.repeat(15),Array.from({length:100},(_,i)=>`<button>Button ${i}</button>`).join('')]){
 const f=await fixture(html,[],10);try{const s=await f.adapter.open(f.target,'strict_isolated',new AbortController().signal);const p=await s.snapshot();assert.equal(p.truncated,true);assert.ok(p.elements.length<=10);}finally{await f.close();}}
 const f=await fixture(`<p id="x" role="status">Ready</p><script>document.getElementById('x').setAttribute('role','R'.repeat(100000));</script>`);try{const s=await f.adapter.open(f.target,'strict_isolated',new AbortController().signal);await assert.rejects(s.snapshot(),{code:'E_RESOURCE_LIMIT'});}finally{await f.close();}
});
test('network response size cap fails before oversized document is loaded',async()=>{
 const f=await fixture((_,r)=>{r.setHeader('content-type','text/html');r.end('<p>'+'x'.repeat(2*1024*1024)+'</p>');});try{await assert.rejects(f.adapter.open(f.target,'strict_isolated',new AbortController().signal));assert.ok(f.requested()>0,'the oversized response must actually be requested');}finally{await f.close();}
});
test('abort during page load stops outbound request and close is awaitable/idempotent',async()=>{
 let connected!:()=>void;const ready=new Promise<void>(r=>connected=r);
 const f=await fixture((_,r)=>{connected();r.writeHead(200,{'content-type':'text/html'});r.write('<p>');});
 try{const cancel=new AbortController();const opening=f.adapter.open(f.target,'strict_isolated',cancel.signal);await Promise.race([ready,opening]);cancel.abort();await assert.rejects(opening);await Promise.all([f.adapter.close(),f.adapter.close()]);await assert.rejects(f.adapter.open(f.target,'strict_isolated',new AbortController().signal),{code:'E_CANCELLED'});}finally{await f.close();}
});
