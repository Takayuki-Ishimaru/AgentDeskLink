import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {BrowserAdapter} from '../src/browser.js';
import {Engine} from '../src/core.js';
import {parsePolicy,assertUrlAllowed} from '../src/policy.js';
import {AdlError} from '../src/types.js';

async function listen(server:Server){await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}

test('explicit read-only CDN resources load in every tier without granting navigation or POST',{timeout:45000},async()=>{
  let posts=0,assetHits=0;
  const assets=createServer((_req,res)=>{assetHits++;res.setHeader('content-type','application/javascript');res.end('/*'+'x'.repeat(3*1024*1024)+'*/document.getElementById("status").textContent="CDN ready";');});
  const cdn=await listen(assets);
  const app=createServer((req,res)=>{if(req.method==='POST'){posts++;res.end('unexpected');return;}res.setHeader('content-type','text/html');res.end(`<p id="status">Loading</p><script src="${cdn}/app.js"></script><button onclick="fetch('/api',{method:'POST',body:'q=cats'}).catch(()=>{})">Search API</button>`);});
  const origin=await listen(app);
  try{
    for(const operationMode of ['read_only','standard','ask'] as const){
      const policy=parsePolicy({operationMode,allowedOrigins:[origin],resourceOrigins:[cdn],allowLoopback:true,browserTargets:[{id:'app',label:'App',url:origin,classification:'PUBLIC'}]});
      const engine=new Engine(policy,{browser:new BrowserAdapter(policy,(url,purpose)=>assertUrlAllowed(url,policy,undefined,purpose))});
      try{
        const session=await engine.open((await engine.listTargets()).targets[0]!.target_id);
        let observed=await engine.observe(session.session_id);assert.ok(observed.elements!.some(e=>e.name==='CDN ready'),operationMode);
        await assert.rejects(engine.act(session.session_id,{action:'navigate',url:cdn},observed.revision),{code:'E_POLICY_DENIED'});
        if(operationMode!=='read_only'){
          observed=await engine.observe(session.session_id);const button=observed.elements!.find(e=>e.name==='Search API')!;
          const result=await engine.act(session.session_id,{action:'click',element_id:button.id},observed.revision);
          assert.ok('network_blocked' in result);assert.equal(result.network_blocked,true);assert.ok(result.warnings?.some(w=>w.code==='request_denied'));
        }
        assert.equal(posts,0);
      }finally{await engine.shutdown();}
    }
    const policy=parsePolicy({allowedOrigins:[origin],allowLoopback:true,browserTargets:[{id:'app',label:'App',url:origin,classification:'PUBLIC'}]});
    const engine=new Engine(policy,{browser:new BrowserAdapter(policy,(url,purpose)=>assertUrlAllowed(url,policy,undefined,purpose))});
    try{const prior=assetHits,session=await engine.open((await engine.listTargets()).targets[0]!.target_id);const observed=await engine.observe(session.session_id);assert.equal(assetHits,prior);assert.ok(observed.warnings?.some(w=>w.code==='origin_denied'&&w.origin===cdn));}finally{await engine.shutdown();}
  }finally{await close(app);await close(assets);}
});

test('actions can return transient changes and text reads page through redacted content within budget',{timeout:20000},async()=>{
  const body='Readable public prose. '.repeat(80)+'alice@example.com '+String.fromCodePoint(0x65e5,0x672c,0x8a9e).repeat(150);
  const app=createServer((_,res)=>{res.setHeader('content-type','text/html; charset=utf-8');res.end(`<p>${body}</p><p aria-label="Emoji paragraph">&#128512;&#128512;</p><button onclick="const toast=document.createElement('p');toast.setAttribute('role','status');toast.textContent='Saved locally';document.body.append(toast);setTimeout(()=>toast.remove(),1500)">Save locally</button>`);});
  const origin=await listen(app),policy=parsePolicy({operationMode:'standard',allowedOrigins:[origin],allowLoopback:true,browserTargets:[{id:'app',label:'App',url:origin,classification:'PUBLIC'}]});
  const engine=new Engine(policy,{browser:new BrowserAdapter(policy,url=>assertUrlAllowed(url,policy))});
  try{
    const session=await engine.open((await engine.listTargets()).targets[0]!.target_id),observed=await engine.observe(session.session_id);
    const paragraph=observed.elements!.find(e=>e.name.startsWith('Readable'))!;assert.equal(paragraph.name_truncated,true);
    let text='',offset=0;
    for(let i=0;i<30;i++){
      const part=await engine.observe(session.session_id,{text:{element_id:paragraph.id,offset,length:8192},token_budget:256});
      assert.ok(Buffer.byteLength(JSON.stringify(part),'utf8')<=1024);text+=part.text!.content;
      if(part.text!.next_offset===null)break;assert.ok(part.text!.next_offset!>offset);offset=part.text!.next_offset!;
    }
    assert.ok(!text.includes('alice@example.com'));assert.ok(text.endsWith(String.fromCodePoint(0x65e5,0x672c,0x8a9e).repeat(150)));
    const emoji=(await engine.observe(session.session_id)).elements!.find(e=>e.name==='Emoji paragraph')!;
    const one=await engine.observe(session.session_id,{text:{element_id:emoji.id,offset:0,length:1}});assert.equal(one.text!.content,String.fromCodePoint(0x1f600));assert.equal(one.text!.next_offset,2);
    const two=await engine.observe(session.session_id,{text:{element_id:emoji.id,offset:one.text!.next_offset!,length:1}});assert.equal(two.text!.content,String.fromCodePoint(0x1f600));assert.equal(two.text!.next_offset,null);
    await assert.rejects(engine.observe(session.session_id,{text:{element_id:emoji.id,offset:1,length:1}}),{code:'E_INVALID_ARGUMENT'});
    const current=await engine.observe(session.session_id),button=current.elements!.find(e=>e.name==='Save locally')!;
    const action=await engine.act(session.session_id,{action:'click',element_id:button.id,include_diff:true},current.revision);
    assert.ok('observation' in action);assert.ok(action.observation?.changes?.some(c=>c.element?.name==='Saved locally'));
  }finally{await engine.shutdown();await close(app);}
});

test('warm public asset cache saves network requests and cannot bypass a fresh guard denial',{timeout:20000},async()=>{
  let hits=0,guards=0,permitted=true;
  const assets=createServer((_,res)=>{hits++;res.setHeader('cache-control','public, max-age=60');res.setHeader('content-type','application/javascript');res.end('document.getElementById("status").textContent="Ready";');});
  const cdn=await listen(assets),app=createServer((_,res)=>{res.setHeader('content-type','text/html');res.end(`<p id="status">Loading</p><script src="${cdn}/code.js"></script>`);}),origin=await listen(app);
  const policy=parsePolicy({operationMode:'read_only',allowedOrigins:[origin],resourceOrigins:[cdn],allowLoopback:true,browserTargets:[{id:'app',label:'App',url:origin,classification:'PUBLIC'}]});
  const adapter=new BrowserAdapter(policy,async(url,purpose)=>{if(purpose==='resource'&&new URL(url).origin===cdn){guards++;if(!permitted)throw new AdlError('E_POLICY_DENIED','origin_not_allowed');}await assertUrlAllowed(url,policy,undefined,purpose);});
  const engine=new Engine(policy,{browser:adapter});
  try{
    const session=await engine.open((await engine.listTargets()).targets[0]!.target_id);let observed=await engine.observe(session.session_id);assert.ok(observed.elements!.some(e=>e.name==='Ready'));assert.equal(hits,1);
    await engine.act(session.session_id,{action:'navigate',url:origin},observed.revision);observed=await engine.observe(session.session_id);assert.ok(observed.elements!.some(e=>e.name==='Ready'));assert.equal(hits,1);assert.ok(guards>=2);
    permitted=false;await engine.act(session.session_id,{action:'navigate',url:origin},observed.revision);observed=await engine.observe(session.session_id);assert.ok(observed.elements!.some(e=>e.name==='Loading'));assert.equal(hits,1);assert.ok(observed.warnings?.some(w=>w.code==='origin_not_allowed'));
  }finally{await engine.shutdown();await close(app);await close(assets);}
});
