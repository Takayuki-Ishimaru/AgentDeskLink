import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import type {Page} from 'playwright';
import {BrowserAdapter} from '../src/browser.js';
import {Engine} from '../src/core.js';
import {parsePolicy,assertUrlAllowed} from '../src/policy.js';
import {AdlError,type Action,type AdapterSession} from '../src/types.js';

const HTML=`<!doctype html><style>input,button,a{display:block;margin:6px}#scroll{height:80px;overflow:auto}</style>
<span id="clock" role="status">Clock 0</span><button id="open" type="button" onclick="window.clicks=(window.clicks||0)+1">Open</button>
<form id="form" method="post" action="/submit"><input id="query" name="q" aria-label="Search" value="original">
<input id="hidden" type="hidden" name="token" value="HIDDEN_CANARY"><button id="send">Send</button></form>
<input id="external" name="external" form="form" value="external"><a id="next" href="/next">Next</a>
<section id="scroll" role="region" aria-label="Scroll area"><div style="height:1000px">Long content</div></section>`;

async function fixture(mode:'legacy'|'read_only'|'standard'|'ask'|'all'='standard',html=HTML){
  let submissions=0;
  const app=createServer(async(req,res)=>{if(req.method==='POST'){submissions++;for await(const _ of req){/* drain */}}res.setHeader('content-type','text/html');res.end(html);});
  await new Promise<void>(resolve=>app.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(app.address() as {port:number}).port}`;
  const policy=parsePolicy({allowedOrigins:[origin],allowLoopback:true,actionTimeoutMs:5000,
    ...(mode==='all'?{allowAllOperations:true}:mode==='legacy'?{}:{operationMode:mode}),
    browserTargets:[{id:'fixture',label:'Fixture',url:origin,classification:'PUBLIC',controls:[
      {selector:'#open',actions:['click']},{selector:'#query',actions:['fill']},{selector:'#next',actions:['click']}]}]});
  const browser=new BrowserAdapter(policy,url=>assertUrlAllowed(url,policy));let adapterSession:AdapterSession|undefined;
  const engine=new Engine(policy,{browser:{open:async(...args)=>adapterSession=await browser.open(...args),close:()=>browser.close()}});
  const session=await engine.open((await engine.listTargets()).targets[0]!.target_id);
  const page=(adapterSession as unknown as {pageValue:Page}).pageValue;
  const observe=()=>engine.observe(session.session_id,{token_budget:8000});
  const tick=()=>page.evaluate(()=>{document.querySelector('#clock')!.textContent='Clock '+Math.random();});
  return {engine,session,page,origin,observe,tick,submissions:()=>submissions,close:async()=>{await engine.shutdown();app.closeAllConnections();await new Promise<void>(resolve=>app.close(()=>resolve()));}};
}

for(const mode of ['legacy','standard','ask','all'] as const)test(`${mode}: clock and unrelated controls do not stale exact click/fill/scroll targets`,{timeout:30000},async()=>{
  const f=await fixture(mode);try{
    let before=await f.observe();const open=before.elements!.find(e=>e.name==='Open')!;
    await f.tick();const updated=await f.observe();assert.ok(updated.revision>before.revision);
    assert.ok(!JSON.stringify(updated).includes('actionEvidence'));assert.ok(!JSON.stringify(updated).includes('HIDDEN_CANARY'));
    await f.engine.act(f.session.session_id,{action:'click',element_id:open.id,expected_target:{role:'button',name:'Open'}},before.revision);
    assert.equal(await f.page.evaluate(()=>(window as unknown as {clicks:number}).clicks),1);
    before=await f.observe();const query=before.elements!.find(e=>e.name==='Search')!;
    await f.page.evaluate(()=>{document.querySelector('#open')!.setAttribute('aria-label','Other control changed');});
    await f.tick();await f.engine.act(f.session.session_id,{action:'fill',element_id:query.id,value:'dictionary'},before.revision);
    assert.equal(await f.page.locator('#query').inputValue(),'dictionary');
    before=await f.observe();await f.tick();
    await f.engine.act(f.session.session_id,{action:'scroll',element_id:before.elements!.find(e=>e.name==='Scroll area')!.id,direction:'down'},before.revision);
    assert.ok(await f.page.locator('#scroll').evaluate(e=>e.scrollTop)>0);
  }finally{await f.close();}
});

test('read_only retains operation denial while clock-safe scroll/navigate/back remain available',{timeout:30000},async()=>{
  const f=await fixture('read_only');try{
    let before=await f.observe();await f.tick();
    await assert.rejects(f.engine.act(f.session.session_id,{action:'click',element_id:before.elements!.find(e=>e.name==='Open')!.id},before.revision),{code:'E_POLICY_DENIED'});
    await f.engine.act(f.session.session_id,{action:'scroll',element_id:before.elements!.find(e=>e.name==='Scroll area')!.id,direction:'down'},before.revision);
    before=await f.observe();await f.tick();await f.engine.act(f.session.session_id,{action:'navigate',url:f.origin+'/next'},before.revision);
    before=await f.observe();await f.tick();await f.engine.act(f.session.session_id,{action:'back'},before.revision);
    assert.equal(new URL(f.page.url()).pathname,'/');
  }finally{await f.close();}
});

test('target, full hidden values, external form controls, form targets and link href changes still stale',{timeout:60000},async()=>{
  const f=await fixture('all');try{
    const cases=[
      {selector:'#query',script:()=>{(document.querySelector('#query') as HTMLInputElement).value='changed';}},
      {selector:'#query',script:()=>{document.querySelector('#query')!.setAttribute('aria-label','Renamed');}},
      {selector:'#query',script:()=>{(document.querySelector('#hidden') as HTMLInputElement).value='OTHER_CANARY';}},
      {selector:'#query',script:()=>{(document.querySelector('#external') as HTMLInputElement).value='changed';}},
      {selector:'#query',script:()=>{document.querySelector('#form')!.setAttribute('action','/different');}},
      {selector:'#query',script:()=>{document.querySelector('#form')!.setAttribute('method','get');}},
      {selector:'#query',script:()=>{document.querySelector('#query')!.replaceWith(document.querySelector('#query')!.cloneNode(true));}},
      {selector:'#send',script:()=>{document.querySelector('#send')!.setAttribute('formaction','/different');}},
      {selector:'#next',script:()=>{document.querySelector('#next')!.setAttribute('href','/other');}},
    ];
    for(const item of cases){
      await f.page.goto(f.origin);const before=await f.observe();
      const name=item.selector==='#query'?'Search':item.selector==='#send'?'Send':'Next';const element=before.elements!.find(e=>e.name===name)!;
      await f.page.evaluate(item.script);await f.tick();
      const action:Action=item.selector==='#query'?{action:'fill',element_id:element.id,value:'must not enter'}:{action:'click',element_id:element.id};
      await assert.rejects(f.engine.act(f.session.session_id,action,before.revision),{code:'E_STALE_STATE'},item.selector+' '+item.script.toString());
      assert.equal(f.submissions(),0);
    }
    await f.page.goto(f.origin);const before=await f.observe();await f.tick();
    await assert.rejects(f.engine.act(f.session.session_id,{action:'click',element_id:before.elements!.find(e=>e.name==='Open')!.id,expected_target:{name:'Wrong'}},before.revision),{code:'E_STALE_STATE'});
  }finally{await f.close();}
});

test('document replacement, same-document URL and base changes stale navigation and exact targets',{timeout:45000},async()=>{
  const f=await fixture('all');try{
    for(const change of ['reload','hash','query','base'] as const){
      await f.page.goto(f.origin);const before=await f.observe();
      if(change==='reload')await f.page.reload();
      else if(change==='hash')await f.page.evaluate(()=>{location.hash='changed';});
      else if(change==='query')await f.page.evaluate(()=>{history.pushState({},'','?changed=private');});
      else await f.page.evaluate(()=>{const base=document.createElement('base');base.href='/different/';document.head.append(base);});
      await assert.rejects(f.engine.act(f.session.session_id,{action:'navigate',url:f.origin+'/next'},before.revision),{code:'E_STALE_STATE'},change);
      await assert.rejects(f.engine.act(f.session.session_id,{action:'click',element_id:before.elements!.find(e=>e.name==='Open')!.id},before.revision),{code:'E_STALE_STATE'},change);
    }
  }finally{await f.close();}
});

test('clock-safe stale aliases cannot cross an executed local action or win twice concurrently',{timeout:30000},async()=>{
  const f=await fixture('all');try{
    const before=await f.observe();await f.tick();
    const action:Action={action:'click',element_id:before.elements!.find(e=>e.name==='Open')!.id};
    const outcomes=await Promise.allSettled([f.engine.act(f.session.session_id,action,before.revision),f.engine.act(f.session.session_id,action,before.revision)]);
    assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);
    assert.equal(await f.page.evaluate(()=>(window as unknown as {clicks:number}).clicks),1);
    const current=await f.observe();const task=f.engine.execute([{session_id:f.session.session_id,...action},{session_id:f.session.session_id,...action}],{[f.session.session_id]:current.revision});
    let result=f.engine.task(task.task_id);for(let i=0;i<200&&['queued','running'].includes(result.status);i++){await new Promise(resolve=>setTimeout(resolve,10));result=f.engine.task(task.task_id);}
    assert.equal(result.status,'completed');assert.equal(result.results.length,2);
    assert.equal(await f.page.evaluate(()=>(window as unknown as {clicks:number}).clicks),3);
    await assert.rejects(f.engine.act(f.session.session_id,action,current.revision),{code:'E_STALE_STATE'});
  }finally{await f.close();}
});

test('unknown and evicted revisions, incomplete form evidence and iframe targets remain fail-closed',{timeout:30000},async()=>{
  const f=await fixture('all',HTML+'<iframe srcdoc="<input aria-label=Framed>"></iframe>');try{
    const before=await f.observe(),open=before.elements!.find(e=>e.name==='Open')!,framed=before.elements!.find(e=>e.name==='Framed')!;
    await f.tick();await assert.rejects(f.engine.act(f.session.session_id,{action:'fill',element_id:framed.id,value:'must not enter'},before.revision),{code:'E_STALE_STATE'});
    await assert.rejects(f.engine.act(f.session.session_id,{action:'click',element_id:open.id},999999),{code:'E_STALE_STATE'});
    for(let i=0;i<33;i++){await f.tick();await f.observe();}
    await assert.rejects(f.engine.act(f.session.session_id,{action:'click',element_id:open.id},before.revision),{code:'E_STALE_STATE'});
    await f.page.evaluate(()=>{for(let i=0;i<130;i++){const input=document.createElement('input');input.type='hidden';document.querySelector('#form')!.append(input);}});
    const incomplete=await f.observe();await f.tick();
    await assert.rejects(f.engine.act(f.session.session_id,{action:'fill',element_id:incomplete.elements!.find(e=>e.name==='Search')!.id,value:'must not enter'},incomplete.revision),{code:'E_STALE_STATE'});
  }finally{await f.close();}
});

test('pending and approved requests survive unrelated observations and consume exactly once',{timeout:30000},async()=>{
  const saved=[process.env.ADL_APPROVAL_URL,process.env.ADL_APPROVAL_TOKEN,process.env.ADL_APPROVAL_EPOCH];
  const token=randomBytes(32).toString('base64url'),epoch=randomUUID();let entry:any,approved=false,posts=0,consumes=0,wire='';
  const broker=createServer(async(req,res)=>{
    assert.equal(req.headers.authorization,`Bearer ${token}`);const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const body=Buffer.concat(chunks).toString();wire+=body;
    if(req.method==='POST'){posts++;entry=JSON.parse(body);}
    if(!entry){res.writeHead(404);res.end();return;}
    if(req.method==='DELETE'&&approved)consumes++;
    res.setHeader('content-type','application/json');res.end(JSON.stringify({v:1,request_id:entry.request_id,binding:entry.binding,expires_at:entry.expires_at,status:req.method==='DELETE'?'consumed':approved?'approved':'pending',...(req.method==='DELETE'?{consumed_now:approved}:{})}));
  });
  await new Promise<void>(resolve=>broker.listen(0,'127.0.0.1',resolve));
  process.env.ADL_APPROVAL_URL=`http://127.0.0.1:${(broker.address() as {port:number}).port}`;process.env.ADL_APPROVAL_TOKEN=token;process.env.ADL_APPROVAL_EPOCH=epoch;
  const f=await fixture('ask');try{
    const before=await f.observe();const action:Action={action:'click',element_id:before.elements!.find(e=>e.name==='Send')!.id};
    await assert.rejects(f.engine.act(f.session.session_id,action,before.revision),{code:'E_APPROVAL_REQUIRED'});const requestId=entry.request_id;
    // Repeated observation during a human wait must not evict the approval's
    // original baseline even when ordinary revision history reaches its cap.
    for(let i=0;i<34;i++){await f.tick();await f.observe();}
    await assert.rejects(f.engine.act(f.session.session_id,action,before.revision),(error:unknown)=>error instanceof AdlError&&error.code==='E_APPROVAL_REQUIRED'&&error.requestId===requestId);
    assert.equal(posts,1);assert.equal(consumes,0);assert.equal(f.submissions(),0);
    approved=true;await f.tick();const current=await f.observe();
    await f.engine.act(f.session.session_id,action,current.revision);
    assert.equal(posts,1);assert.equal(consumes,1);assert.equal(f.submissions(),1);assert.ok(!wire.includes('HIDDEN_CANARY'));
    approved=false;const changed=await f.observe(),sendAgain:Action={action:'click',element_id:changed.elements!.find(e=>e.name==='Send')!.id};
    await assert.rejects(f.engine.act(f.session.session_id,sendAgain,changed.revision),{code:'E_APPROVAL_REQUIRED'});
    approved=true;await f.page.evaluate(()=>{(document.querySelector('#hidden') as HTMLInputElement).value='CHANGED_SECRET';});await f.tick();
    await assert.rejects(f.engine.act(f.session.session_id,sendAgain,changed.revision),{code:'E_STALE_STATE'});assert.equal(f.submissions(),1);
  }finally{
    await f.close();broker.closeAllConnections();await new Promise<void>(resolve=>broker.close(()=>resolve()));
    for(const [key,value]of [['ADL_APPROVAL_URL',saved[0]],['ADL_APPROVAL_TOKEN',saved[1]],['ADL_APPROVAL_EPOCH',saved[2]]]as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});
