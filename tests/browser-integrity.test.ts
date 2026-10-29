import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {Page} from 'playwright';
import {BrowserAdapter} from '../src/browser.js';
import {Engine} from '../src/core.js';
import {parsePolicy,assertUrlAllowed} from '../src/policy.js';
import type {AdapterSession} from '../src/types.js';
import {registerBrowserPrototypes} from '../src/browser-integrity.js';

const html='<!doctype html><input id="field" aria-label="Search" value="native"><input id="check" type="checkbox" aria-label="Toggle"><button id="open" type="button" onclick="window.clicks=(window.clicks||0)+1">Open</button><div data-adl-sensitive><p id="secret">PRIVATE_CANARY_CONTENT</p><button id="protected" type="button" onclick="window.secretClicks=(window.secretClicks||0)+1">Hidden control</button></div>';
async function fixture(mode:'read_only'|'standard'|'ask'|'all'='all',extra='',touch=false){
  const app=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(html+extra);});
  await new Promise<void>(resolve=>app.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(app.address() as {port:number}).port}`;
  const policy=parsePolicy({allowedOrigins:[origin],allowLoopback:true,actionTimeoutMs:5000,...(mode==='all'?{allowAllOperations:true}:{operationMode:mode}),browserTargets:[{id:'fixture',label:'Fixture',url:origin,classification:'PUBLIC',...(touch?{visual:{enabled:true},gestures:{enabled:true,surfaces:[{id:'board',selector:'#board',kinds:['drag']}]}}:{})}]});
  const adapter=new BrowserAdapter(policy,url=>assertUrlAllowed(url,policy));let instance:AdapterSession|undefined;
  const engine=new Engine(policy,{browser:{open:async(...args)=>instance=await adapter.open(...args),close:()=>adapter.close()}});
  const close=async()=>{await engine.shutdown();app.closeAllConnections();await new Promise<void>(resolve=>app.close(()=>resolve()));};
  try{const session=await engine.open((await engine.listTargets()).targets[0]!.target_id);return {engine,instance:instance!,session,page:(instance as unknown as {pageValue:Page}).pageValue,close};}
  catch(error){await close();throw error;}
}

for(const mode of ['read_only','standard','ask','all']as const)test(`${mode}: forged matches cannot expose protected text or dispatch a protected click`,{timeout:20000},async()=>{
  const f=await fixture(mode);try{
    const before=await f.engine.observe(f.session.session_id,{token_budget:8000});assert.ok(!JSON.stringify(before).includes('PRIVATE_CANARY_CONTENT'));
    const raw=await f.instance.snapshot(),target=raw.elements.find(e=>e.protected&&e.role==='button')!;assert.ok(target);
    await f.page.evaluate(()=>{(Element.prototype as unknown as {matches:()=>boolean}).matches=()=>false;});
    await assert.rejects(f.engine.observe(f.session.session_id),{code:'E_PRIVACY_BLOCKED'});
    await assert.rejects(f.instance.act({action:'click',element_id:target.id},new AbortController().signal),{code:'E_PRIVACY_BLOCKED'});
    assert.equal(await f.page.evaluate(()=>(window as unknown as {secretClicks?:number}).secretClicks??0),0);
  }finally{await f.close();}
});

test('page-load prototype forgery is denied before first observation',{timeout:20000},async()=>{
  await assert.rejects(fixture('all','<script>Element.prototype.matches=function(){return false}</script>'),{code:'E_PRIVACY_BLOCKED'});
});

test('own DOM, document, attribute and collection API shadows fail without running hostile getters',{timeout:30000},async()=>{
  const attacks=[
    ()=>{Object.defineProperty(document.querySelector('#secret'),'parentElement',{get(){(window as unknown as {getterRuns:number}).getterRuns++;return null;}});},
    ()=>{Object.defineProperty(document.querySelector('#secret'),'matches',{get(){(window as unknown as {getterRuns:number}).getterRuns++;return ()=>false;}});},
    ()=>{Object.defineProperty(document.querySelector('#secret'),'getRootNode',{value:()=>document});},
    ()=>{Object.defineProperty(document,'createTreeWalker',{get(){(window as unknown as {getterRuns:number}).getterRuns++;return ()=>null;}});},
    ()=>{Object.defineProperty(document.querySelector('#secret')!.attributes,Symbol.iterator,{value:function*(){}});},
    ()=>{Object.defineProperty(document.querySelector('#secret')!.getAttributeNode('id'),'value',{get(){(window as unknown as {getterRuns:number}).getterRuns++;return 'forged';}});},
    ()=>{Object.defineProperty(document.querySelector('#secret'),'textContent',{get(){(Element.prototype as unknown as {matches:()=>boolean}).matches=()=>false;(window as unknown as {getterRuns:number}).getterRuns++;return 'PRIVATE_CANARY_CONTENT';}});},
  ];
  for(const attack of attacks){const f=await fixture();try{
    await f.page.evaluate(()=>{(window as unknown as {getterRuns:number}).getterRuns=0;});await f.page.evaluate(attack);
    await assert.rejects(f.instance.snapshot(),{code:'E_PRIVACY_BLOCKED'},attack.toString());
    assert.equal(await f.page.evaluate(()=>(window as unknown as {getterRuns:number}).getterRuns),0);
  }finally{await f.close();}}
});

test('global bindings and reflection primitives cannot forge the immutable checker',{timeout:30000},async()=>{
  const attacks=[
    ()=>{Object.getOwnPropertyDescriptor=()=>undefined;},
    ()=>{Reflect.ownKeys=()=>[];},
    ()=>{Object.defineProperty(window,'globalThis',{value:{},configurable:true});},
    ()=>{Object.setPrototypeOf(HTMLParagraphElement.prototype,new Proxy(Element.prototype,{get(){(window as unknown as {trapRuns:number}).trapRuns++;return ()=>false;}}));},
  ];
  for(const attack of attacks){const f=await fixture();try{
    await f.page.evaluate(()=>{(window as unknown as {trapRuns:number}).trapRuns=0;});await f.page.evaluate(attack);
    await assert.rejects(f.instance.snapshot(),{code:'E_PRIVACY_BLOCKED'});
    assert.equal(await f.page.evaluate(()=>(window as unknown as {trapRuns:number}).trapRuns),0);
  }finally{await f.close();}}
});

test('React-style own input value and checked wrappers are bypassed with captured native getters',{timeout:20000},async()=>{
  const f=await fixture('standard');try{
    await f.page.evaluate(()=>{
      (window as unknown as {getterRuns:number}).getterRuns=0;
      for(const [id,key]of [['field','value'],['check','checked']]as const){const node=document.getElementById(id)!;
        Object.defineProperty(node,key,{configurable:true,get(){(window as unknown as {getterRuns:number}).getterRuns++;(Element.prototype as unknown as {matches:()=>boolean}).matches=()=>false;return 'FORGED_SECRET';},set(){}});}
    });
    const before=await f.engine.observe(f.session.session_id,{token_budget:8000});
    assert.equal(before.elements!.find(e=>e.name==='Search')!.value,'native');assert.equal(before.elements!.find(e=>e.name==='Toggle')!.checked,false);
    assert.ok(!JSON.stringify(before).includes('FORGED_SECRET'));assert.equal(await f.page.evaluate(()=>(window as unknown as {getterRuns:number}).getterRuns),0);
    await f.engine.act(f.session.session_id,{action:'fill',element_id:before.elements!.find(e=>e.name==='Search')!.id,value:'updated'},before.revision);
    const after=await f.engine.observe(f.session.session_id);assert.equal(after.elements!.find(e=>e.name==='Search')!.value,'updated');
    assert.equal(await f.page.evaluate(()=>(window as unknown as {getterRuns:number}).getterRuns),0);
  }finally{await f.close();}
});

test('prototype tampering triggered during preflight hover cannot dispatch the requested click',{timeout:20000},async()=>{
  const f=await fixture('all');try{
    const before=await f.engine.observe(f.session.session_id);
    await f.page.evaluate(()=>{document.querySelector('#open')!.addEventListener('mouseover',()=>{(Element.prototype as unknown as {matches:()=>boolean}).matches=()=>false;});});
    await assert.rejects(f.engine.act(f.session.session_id,{action:'click',element_id:before.elements!.find(e=>e.name==='Open')!.id},before.revision),{code:'E_PRIVACY_BLOCKED'});
    assert.equal(await f.page.evaluate(()=>(window as unknown as {clicks?:number}).clicks??0),0);
  }finally{await f.close();}
});

test('native CDP registration admits layered custom elements and open Shadow DOM without granting API overrides',{timeout:20000},async()=>{
  const f=await fixture();try{
    await f.page.evaluate(()=>{
      class PanelBase extends HTMLElement {render(){return 'Base';}}
      class Panel extends PanelBase {override render(){return 'Custom content';}connectedCallback(){this.attachShadow({mode:'open'}).innerHTML='<p>'+this.render()+'</p><button type="button">Custom button</button>';this.shadowRoot!.querySelector('button')!.addEventListener('click',()=>{(window as unknown as {customClicks:number}).customClicks=1;});}}
      customElements.define('custom-panel',Panel);document.body.append(document.createElement('custom-panel'));
    });
    const result=await f.instance.snapshot();assert.ok(result.elements.some(e=>e.name==='Custom content'));assert.ok(result.elements.some(e=>e.name==='Custom button'));
    const observed=await f.engine.observe(f.session.session_id);await f.engine.act(f.session.session_id,{action:'click',element_id:observed.elements!.find(e=>e.name==='Custom button')!.id},observed.revision);
    assert.equal(await f.page.evaluate(()=>(window as unknown as {customClicks:number}).customClicks),1);
    await f.page.evaluate(()=>{Object.defineProperty(customElements.get('custom-panel')!.prototype,'render',{value:()=> 'Changed'});});
    await assert.rejects(f.instance.snapshot(),{code:'E_PRIVACY_BLOCKED'});
  }finally{await f.close();}
});

test('unknown Proxy prototypes are rejected by CDP without invoking any trap',{timeout:20000},async()=>{
  const f=await fixture();try{
    await f.page.evaluate(()=>{
      (window as unknown as {trapRuns:number}).trapRuns=0;const trap=()=>{(window as unknown as {trapRuns:number}).trapRuns++;return [];};
      const proxy=new Proxy(HTMLElement.prototype,{ownKeys:trap,getPrototypeOf(){trap();return HTMLElement.prototype;},get(){trap();return undefined;}});
      Object.setPrototypeOf(document.querySelector('#secret'),proxy);
    });
    await assert.rejects(f.instance.snapshot(),{code:'E_PRIVACY_BLOCKED'});
    assert.equal(await f.page.evaluate(()=>(window as unknown as {trapRuns:number}).trapRuns),0);
  }finally{await f.close();}
});

test('custom inherited DOM getters and generic control API getters cannot enter the trusted prototype set',{timeout:30000},async()=>{
  for(const property of ['matches','parentElement','type','form','disabled','then','toJSON']){const f=await fixture();try{
    await f.page.evaluate(property=>{
      (window as unknown as {getterRuns:number}).getterRuns=0;class Panel extends HTMLElement{}
      Object.defineProperty(Panel.prototype,property,{get(){(window as unknown as {getterRuns:number}).getterRuns++;return ()=>false;}});
      customElements.define('custom-panel',Panel);document.body.append(document.createElement('custom-panel'));
    },property);
    await assert.rejects(f.instance.snapshot(),{code:'E_PRIVACY_BLOCKED'},property);
    assert.equal(await f.page.evaluate(()=>(window as unknown as {getterRuns:number}).getterRuns),0);
  }finally{await f.close();}}
});

test('page calls cannot register prototypes with a guessed nonce and registration is bounded',{timeout:30000},async()=>{
  const f=await fixture();try{
    const accepted=await f.page.evaluate(()=>{
      const key=Object.getOwnPropertyNames(window).find(key=>key.startsWith('__adl_integrity_'))!;
      const guard=(window as unknown as Record<string,{acceptPrototype:(key:string,proto:object)=>boolean}>)[key]!;
      class Bad extends HTMLElement{}Object.defineProperty(Bad.prototype,'matches',{value:()=>false});
      return guard.acceptPrototype('guessed',Bad.prototype);
    });assert.equal(accepted,false);
    await f.page.evaluate(()=>{for(let i=0;i<65;i++){const name='custom-item-'+i;customElements.define(name,class extends HTMLElement{});document.body.append(document.createElement(name));}});
    await assert.rejects(f.instance.snapshot(),error=>typeof error==='object'&&error!==null&&'code'in error&&['E_RESOURCE_LIMIT','E_TIMEOUT','E_PRIVACY_BLOCKED'].includes(String(error.code)));
  }finally{await f.close();}
});

test('cancelled prototype registration does not begin any host acceptance work',{timeout:20000},async()=>{
  const f=await fixture();try{
    const controller=new AbortController();controller.abort();
    const privateSession=f.instance as unknown as {integrityKey:string;registrationSecret:string};
    await assert.rejects(registerBrowserPrototypes(f.page,{key:privateSession.integrityKey,registrationSecret:privateSession.registrationSecret},controller.signal),{code:'E_CANCELLED'});
  }finally{await f.close();}
});

test('native touch-enabled canvas/video and password/email forms open without weakening DOM integrity',{timeout:20000},async()=>{
  const f=await fixture('all','<canvas id="board"></canvas><video muted></video><div id="status">Ready</div><form method="post"><input type="password" aria-label="Password"><input aria-label="Email"><button>Submit</button></form><script>const board=document.getElementById("board"),ctx=board.getContext("2d"),status=document.getElementById("status");ctx.fillRect(0,0,10,10);</script>',true);
  try{
    const observed=await f.engine.observe(f.session.session_id,{token_budget:8000});assert.ok(observed.elements!.some(e=>e.name==='Password'));assert.ok(observed.elements!.some(e=>e.name==='Email'));assert.ok(observed.elements!.some(e=>e.name==='Ready'));
    await f.page.evaluate(()=>{(Element.prototype as unknown as {matches:()=>boolean}).matches=()=>false;});
    await assert.rejects(f.instance.snapshot(),{code:'E_PRIVACY_BLOCKED'});
  }finally{await f.close();}
});
