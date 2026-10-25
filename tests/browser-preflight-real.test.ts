import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {BrowserAdapter} from '../src/browser.js';
import {Engine} from '../src/core.js';
import {parsePolicy,assertUrlAllowed} from '../src/policy.js';
import {AdlError} from '../src/types.js';

async function fixture(body:string,action:'click'|'fill'='fill'){
 const events:string[]=[];
 const app=createServer((req,res)=>{if(req.url?.startsWith('/event?')){events.push(req.url);res.end('ok');return;}res.setHeader('content-type','text/html');res.end(`<!doctype html><style>body{margin:0}input,button{width:220px;height:44px;margin:16px}</style>${body}`);});
 await new Promise<void>(resolve=>app.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(app.address() as {port:number}).port}`;
 const policy=parsePolicy({allowedOrigins:[origin],allowLoopback:true,actionTimeoutMs:3000,browserTargets:[{id:'fixture',label:'Preflight fixture',url:origin,classification:'PUBLIC',controls:[{selector:'#target',actions:[action]}]}]});
 const adapter=new BrowserAdapter(policy,url=>assertUrlAllowed(url,policy)),engine=new Engine(policy,{browser:adapter});const target=(await engine.listTargets()).targets[0]!;const session=await engine.open(target.target_id);const observed=await engine.observe(session.session_id,{token_budget:8000});const element=observed.elements!.find(e=>e.name.trim()==='Reference'||e.name==='Continue'||e.name==='Inspect')!;assert.ok(element,JSON.stringify(observed.elements));
 const act=()=>engine.act(session.session_id,{action,element_id:element.id,expected_target:{role:element.role,name:element.name},...(action==='fill'?{value:'AI intended text'}:{})},observed.revision);
 return {engine,session,element,events,act,close:async()=>{await engine.shutdown();app.closeAllConnections();await new Promise<void>(resolve=>app.close(()=>resolve()));}};
}
const input=`<label>Reference<input id="target" oninput="fetch('/event?input=target')"></label>`;

test('real Chromium Engine scrolls an offscreen approved field before hit/focus checks',{timeout:12000},async()=>{
 const f=await fixture(`<div style="height:1800px"></div>${input}`);try{await f.act();const observed=await f.engine.observe(f.session.session_id);assert.equal(observed.elements!.find(e=>e.id===f.element.id)?.value,'AI intended text');await delay(40);assert.equal(f.events.length,1);}finally{await f.close();}
});
test('real Chromium Engine permits ordinary form fill without submitting',{timeout:12000},async()=>{
 const f=await fixture(`<form onsubmit="fetch('/event?submit');return false">${input}<button>Continue</button></form>`);try{await f.act();const observed=await f.engine.observe(f.session.session_id);assert.equal(observed.elements!.find(e=>e.id===f.element.id)?.value,'AI intended text');await delay(40);assert.ok(f.events.every(x=>!x.includes('submit')));}finally{await f.close();}
});
test('real Chromium Engine refuses a foreign overlay before sending any input',{timeout:12000},async()=>{
 const f=await fixture(`${input}<div style="position:fixed;inset:0;z-index:50;background:#eee">Cover</div>`);try{await assert.rejects(f.act(),(e:unknown)=>e instanceof AdlError&&e.code==='E_STALE_STATE');await delay(40);assert.equal(f.events.length,0);}finally{await f.close();}
});
test('real Chromium Engine catches an overlay created by hover before fill',{timeout:12000},async()=>{
 const f=await fixture(`<input id="target" aria-label="Reference" oninput="fetch('/event?input=target')" onmouseenter="const o=document.createElement('div');o.style='position:fixed;inset:0;z-index:99;background:#eee';document.body.append(o)">`);try{await assert.rejects(f.act());await delay(40);assert.equal(f.events.length,0);}finally{await f.close();}
});
test('real Chromium Engine catches a target renamed by hover before fill',{timeout:12000},async()=>{
 const f=await fixture(`<input id="target" aria-label="Reference" oninput="fetch('/event?input=target')" onmouseenter="this.setAttribute('aria-label','Different control')">`);try{await assert.rejects(f.act(),(e:unknown)=>e instanceof AdlError&&e.code==='E_STALE_STATE');await delay(40);assert.equal(f.events.length,0);}finally{await f.close();}
});
test('real Chromium Engine refuses redirected focus and leaves both inputs untouched',{timeout:12000},async()=>{
 const f=await fixture(`<input id="target" aria-label="Reference" onfocus="document.querySelector('#other').focus()" oninput="fetch('/event?input=target')"><input id="other" aria-label="Other control" oninput="fetch('/event?input=other')">`);try{await assert.rejects(f.act(),(e:unknown)=>e instanceof AdlError&&e.code==='E_FOCUS_CHANGED');await delay(40);assert.equal(f.events.length,0);}finally{await f.close();}
});
test('real Chromium Engine refuses an implicit submit button before click',{timeout:12000},async()=>{
 const f=await fixture(`<form onsubmit="fetch('/event?submit');return false"><button id="target" onclick="fetch('/event?click')">Continue</button></form>`,'click');try{await assert.rejects(f.act());await delay(40);assert.equal(f.events.length,0);}finally{await f.close();}
});
test('real Chromium Engine accepts a noninteractive descendant at the intended button center',{timeout:12000},async()=>{
 const f=await fixture(`<button type="button" id="target" aria-label="Inspect" onclick="fetch('/event?click')"><span style="display:block;width:100%;height:100%">Icon</span></button>`,'click');try{await f.act();await delay(40);assert.equal(f.events.length,1);}finally{await f.close();}
});
test('real Chromium Engine refuses readonly and disabled-fieldset inputs',{timeout:20000},async()=>{
 for(const body of [`<input readonly id="target" aria-label="Reference" oninput="fetch('/event?input')">`,`<fieldset disabled><input id="target" aria-label="Reference" oninput="fetch('/event?input')"></fieldset>`]){const f=await fixture(body);try{await assert.rejects(f.act());await delay(40);assert.equal(f.events.length,0);}finally{await f.close();}}
});
test('real Chromium Engine names a wrapping label using bounded direct text',{timeout:12000},async()=>{
 const f=await fixture(`<label>Reference<span>decorative subtree text</span><input id="target" oninput="fetch('/event?input=target')"></label>`);try{assert.equal(f.element.name,'Reference');await f.act();const observed=await f.engine.observe(f.session.session_id);assert.equal(observed.elements!.find(e=>e.id===f.element.id)?.value,'AI intended text');}finally{await f.close();}
});

test('real Chromium Engine preserves snapshot role for input buttons and exact aria-label spacing',{timeout:20000},async()=>{
 for(const body of [`<input id="target" type="button" aria-label="Inspect" onclick="fetch('/event?click')">`,`<button id="target" type="button" aria-label=" Reference " onclick="fetch('/event?click')">Inspect</button>`]){const f=await fixture(body,'click');try{await f.act();await delay(40);assert.equal(f.events.length,1);}finally{await f.close();}}
});
