import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {BrowserAdapter} from '../src/browser.js';
import {Engine} from '../src/core.js';
import {parsePolicy,assertUrlAllowed} from '../src/policy.js';
import {AdlError} from '../src/types.js';

async function fixture(html:string,extra:Record<string,unknown>={},frameHtml='<button type="button" id="frame">Frame action</button>'){
  const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(req.url==='/frame'?frameHtml:html);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const policy=parsePolicy({allowedOrigins:[origin,...((extra.extraOrigins as string[]|undefined)??[])],allowLoopback:true,actionTimeoutMs:3000,browserTargets:[{id:'test',label:'Test',url:origin,classification:'PUBLIC',controls:[{selector:'#plain',actions:['click','hover']},{selector:'#field',actions:['press']},{selector:'#shadow',actions:['click']},{selector:'#frame',actions:['click']}]}],...Object.fromEntries(Object.entries(extra).filter(([key])=>key!=='extraOrigins'))});
  const engine=new Engine(policy,{browser:new BrowserAdapter(policy,url=>assertUrlAllowed(url,policy))});
  try{const opened=await engine.open((await engine.listTargets()).targets[0]!.target_id);return {engine,id:opened.session_id,origin,close:async()=>{await engine.shutdown();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};}
  catch(error){await engine.shutdown();server.closeAllConnections();server.close();throw error;}
}

test('plain div, headers, alt text and tabs expose meaningful names and state',{timeout:15000},async()=>{
  const f=await fixture('<title>Demo page</title><div>Finished rendering</div><table><tr><th>Product</th><td>Widget</td></tr></table><img alt="Product preview" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2220%22 height=%2220%22/%3E"><div role="tab" aria-selected="true" aria-expanded="false"><span>Overview</span></div><div id="plain" onclick="this.textContent=\'Clicked\'">Clickable div</div>');
  try{
    const state=await f.engine.observe(f.id,{token_budget:8000});
    assert.ok(state.elements?.some(e=>e.role==='text'&&e.name==='Finished rendering'));
    assert.ok(state.elements?.some(e=>e.role==='columnheader'&&e.name==='Product'));
    assert.ok(state.elements?.some(e=>e.role==='img'&&e.name==='Product preview'));
    const tab=state.elements!.find(e=>e.role==='tab')!;assert.equal(tab.name,'Overview');assert.equal(tab.selected,true);assert.equal(tab.expanded,false);
    assert.equal(state.url,f.origin+'/');assert.equal(state.title,'Demo page');
    const button=state.elements!.find(e=>e.name==='Clickable div')!;assert.equal(button.role,'button');
    await f.engine.act(f.id,{action:'click',element_id:button.id,expected_target:{role:'button',name:'Clickable div'}},state.revision);
    assert.equal((await f.engine.wait(f.id,{name:'Click'},500)).matched,true);
  }finally{await f.close();}
});

test('scopes and cursors reach controls beyond the first 500 observations',{timeout:15000},async()=>{
  const f=await fixture(Array.from({length:550},(_,i)=>`<div>Row ${i}</div>`).join('')+'<button type="button" id="plain">Late action</button>',{maxElements:500});
  try{
    const first=await f.engine.observe(f.id,{token_budget:8000});assert.ok(first.next_cursor);
    const scoped=await f.engine.observe(f.id,{scope:'name:Late action',token_budget:8000});assert.equal(scoped.elements!.length,1);
    await f.engine.act(f.id,{action:'click',element_id:scoped.elements![0]!.id},scoped.revision);
  }finally{await f.close();}
});

test('open shadow roots and allowed iframe documents remain observable and actionable',{timeout:15000},async()=>{
  const f=await fixture('<div id="host"></div><iframe src="/frame"></iframe><script>document.getElementById("host").attachShadow({mode:"open"}).innerHTML=`<button type="button" id="shadow" onclick="this.textContent=\'Shadow done\'">Shadow action</button>`;</script>');
  try{
    let state=await f.engine.observe(f.id,{token_budget:8000});
    const shadow=state.elements!.find(e=>e.name==='Shadow action')!;assert.ok(shadow);
    await f.engine.act(f.id,{action:'click',element_id:shadow.id,expected_target:{role:'button',name:'Shadow action'}},state.revision);
    state=await f.engine.observe(f.id,{token_budget:8000});assert.ok(state.elements!.some(e=>e.name==='Shadow done'));
    const frame=state.elements!.find(e=>e.name==='Frame action')!;assert.ok(frame);
    await f.engine.act(f.id,{action:'click',element_id:frame.id,expected_target:{role:'button',name:'Frame action'}},state.revision);
    assert.equal((await f.engine.observe(f.id,{token_budget:8000})).elements!.find(e=>e.name==='Frame action')!.id,frame.id);
  }finally{await f.close();}
});

test('explicit protection follows shadow hosts and iframe ancestors even with broad operations',{timeout:15000},async()=>{
  const f=await fixture('<div data-adl-sensitive><div id="host"></div><iframe src="/frame"></iframe></div><script>document.getElementById("host").attachShadow({mode:"open"}).innerHTML=`<button type="button" id="shadow">SHADOW_CANARY</button>`;</script>',{allowAllOperations:true,restrictTargets:true},'<p>FRAME_CANARY</p>');
  try{const state=await f.engine.observe(f.id,{token_budget:8000});assert.ok(!JSON.stringify(state).includes('CANARY'));for(const item of state.elements!.filter(e=>e.role==='button'))await assert.rejects(f.engine.act(f.id,{action:'click',element_id:item.id},state.revision),{code:'E_PRIVACY_BLOCKED'});assert.ok((await f.engine.observe(f.id)).ok);}finally{await f.close();}
});

test('overlay preflight failure and denied navigation preserve browser session without execution claim',{timeout:15000},async()=>{
  const f=await fixture('<button type="button" id="plain" style="width:200px;height:100px">Try action</button><div style="position:absolute;inset:0;background:white"></div>');
  try{const state=await f.engine.observe(f.id);const button=state.elements!.find(e=>e.name==='Try action')!;await assert.rejects(f.engine.act(f.id,{action:'click',element_id:button.id},state.revision),error=>error instanceof AdlError&&error.code==='E_STALE_STATE'&&!error.mayHaveExecuted);await assert.rejects(f.engine.act(f.id,{action:'navigate',url:'https://example.net'},state.revision),error=>error instanceof AdlError&&error.code==='E_POLICY_DENIED'&&!error.mayHaveExecuted);assert.equal((await f.engine.observe(f.id)).revision,state.revision);}finally{await f.close();}
});


test('allowed cross-origin iframe contents are observed and hidden frame contents are omitted',{timeout:15000},async()=>{
  const child=createServer((_,res)=>res.end('<button type="button" id="frame">Cross frame action</button>'));
  await new Promise<void>(resolve=>child.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(child.address() as {port:number}).port}`;
  const f=await fixture(`<iframe src="${origin}"></iframe><iframe hidden src="/frame"></iframe>`,{allowAllOperations:true,restrictTargets:true,extraOrigins:[origin]});
  try{await f.engine.wait(f.id,{name:'Cross frame action'},3000);const state=await f.engine.observe(f.id,{token_budget:8000});assert.ok(!state.elements?.some(e=>e.name==='Frame action'));const button=state.elements!.find(e=>e.name==='Cross frame action')!;await f.engine.act(f.id,{action:'click',element_id:button.id},state.revision);}finally{await f.close();child.closeAllConnections();await new Promise<void>(resolve=>child.close(()=>resolve()));}
});

test('approved keyboard input, hover, back and read-only scroll operate with current revisions',{timeout:15000},async()=>{
  const f=await fixture(`<input id="field" aria-label="Query" onkeydown="document.getElementById('status').textContent=event.key"><button id="plain" type="button" onmouseenter="document.getElementById('status').textContent='Hovered'">Hover target</button><div role="region" aria-label="Scrollable" style="height:40px;overflow:auto"><div style="height:300px">Scroll content</div></div><p id="status" role="status">Ready</p>`);
  try{
    let state=await f.engine.observe(f.id);const field=state.elements!.find(e=>e.name==='Query')!;
    await f.engine.act(f.id,{action:'press',element_id:field.id,value:'Enter',expected_target:{role:'textbox',name:'Query'}},state.revision);assert.ok((await f.engine.observe(f.id)).elements!.some(e=>e.role==='status'&&e.name==='Enter'));
    state=await f.engine.observe(f.id);await f.engine.act(f.id,{action:'hover',element_id:state.elements!.find(e=>e.name==='Hover target')!.id},state.revision);assert.ok((await f.engine.observe(f.id)).elements!.some(e=>e.name==='Hovered'));
    state=await f.engine.observe(f.id);await f.engine.act(f.id,{action:'scroll',element_id:state.elements!.find(e=>e.name==='Scrollable')!.id,direction:'down'},state.revision);
    state=await f.engine.observe(f.id);await f.engine.act(f.id,{action:'navigate',url:f.origin+'/frame'},state.revision);
    state=await f.engine.observe(f.id);assert.ok(state.elements!.some(e=>e.name==='Frame action'));
    await f.engine.act(f.id,{action:'back'},state.revision);assert.ok((await f.engine.observe(f.id)).elements!.some(e=>e.name==='Query'));
    const caps=(await f.engine.listTargets()).targets[0]!.capabilities;assert.ok(caps.includes('press'));assert.ok(caps.includes('hover'));assert.ok(caps.includes('scroll'));assert.ok(!caps.includes('fill'));
  }finally{await f.close();}
});

test('keyboard form submission requires broad permission and arbitrary key chords are refused',{timeout:15000},async()=>{
  const f=await fixture('<form><input id="field" aria-label="Query"></form>');
  try{const state=await f.engine.observe(f.id);const field=state.elements!.find(e=>e.name==='Query')!;for(const [value,code]of [['Enter','E_APPROVAL_REQUIRED'],['Control+A','E_INVALID_ARGUMENT']])await assert.rejects(f.engine.act(f.id,{action:'press',element_id:field.id,value},state.revision),error=>error instanceof AdlError&&error.code===code&&!error.mayHaveExecuted);assert.ok((await f.engine.observe(f.id)).ok);}finally{await f.close();}
});


test('native link and form roles take precedence over generic clickability',{timeout:15000},async()=>{
  const f=await fixture('<a id="plain" href="/frame" style="cursor:pointer" onclick="void 0">Next page</a><input aria-label="Text entry" onclick="void 0"><input type="checkbox" aria-label="Toggle" onclick="void 0"><select aria-label="Choice" onclick="void 0"><option>One</option></select>');
  try{const state=await f.engine.observe(f.id,{token_budget:8000});for(const [name,role]of [['Next page','link'],['Text entry','textbox'],['Toggle','checkbox'],['Choice','combobox']])assert.equal(state.elements!.find(e=>e.name===name)?.role,role);const link=state.elements!.find(e=>e.name==='Next page')!;await f.engine.act(f.id,{action:'click',element_id:link.id,expected_target:{role:'link',name:'Next page'}},state.revision);assert.ok((await f.engine.observe(f.id)).elements!.some(e=>e.name==='Frame action'));}finally{await f.close();}
});


test('article text tags and long public prose stay readable while structured secrets remain masked',{timeout:15000},async()=>{
  const paragraph='A session represents a sequence of related interactions. This article explains how a token works in ordinary language. '+'Public discussion remains visible. '.repeat(30);
  const f=await fixture(`<p>${paragraph}</p><blockquote>Quoted public explanation</blockquote><pre>Preformatted public example</pre><code>const total = 42;</code><time>Tomorrow afternoon</time><table><caption>Quarterly results</caption><tr><td>Public row</td></tr></table><figcaption>Illustration description</figcaption><p>Public notes password=CANARY_PASSWORD and token=CANARY_TOKEN remain protected.</p><div role="status">${paragraph}</div><p title="PIN">CANARY_HINT</p>`);
  try{
    const state=await f.engine.observe(f.id,{token_budget:8000});
    const names=state.elements!.map(e=>e.name);assert.ok(names.some(name=>name.startsWith('A session represents a sequence of related interactions.')));assert.ok(state.elements!.some(e=>e.role==='status'&&e.name.startsWith('A session represents')));
    for(const [role,name]of [['blockquote','Quoted public explanation'],['code','Preformatted public example'],['code','const total = 42;'],['time','Tomorrow afternoon'],['caption','Quarterly results'],['caption','Illustration description']])assert.ok(state.elements!.some(e=>e.role===role&&e.name===name),name);
    assert.ok(names.some(name=>name.includes('Public notes')&&name.includes('[redacted]')));assert.ok(!JSON.stringify(state).includes('CANARY_'));assert.equal(state.truncated,true);
  }finally{await f.close();}
});
