import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import sharp from 'sharp';
import {BrowserAdapter} from '../src/browser.js';
import {Engine} from '../src/core.js';
import {parsePolicy,assertUrlAllowed,authorizeAction,redactElement} from '../src/policy.js';
import {isSensitiveLabel} from '../src/privacy.js';

async function fixture(html:string,selectors:string[]=[],extra:Record<string,unknown>={}){
  const requests:{method:string;url:string}[]=[];
  const app=createServer((req,res)=>{requests.push({method:req.method??'',url:req.url??''});res.setHeader('content-type','text/html; charset=utf-8');res.end(`<!doctype html><style>input,button,select{display:block;margin:12px;width:240px;height:32px}</style>${html}`);});
  await new Promise<void>(resolve=>app.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(app.address() as {port:number}).port}`;
  const policy=parsePolicy({allowedOrigins:[origin],allowLoopback:true,actionTimeoutMs:5000,browserTargets:[{id:'fixture',label:'Fixture',url:origin,classification:'PUBLIC',visual:{enabled:true},controls:selectors.map(selector=>({selector,actions:['fill','click','select']}))}],...extra});
  const engine=new Engine(policy,{browser:new BrowserAdapter(policy,url=>assertUrlAllowed(url,policy))});
  try{
    const session=await engine.open((await engine.listTargets()).targets[0]!.target_id);
    return {engine,id:session.session_id,requests,close:async()=>{await engine.shutdown();app.closeAllConnections();await new Promise<void>(r=>app.close(()=>r()));}};
  }catch(error){await engine.shutdown();app.closeAllConnections();app.close();throw error;}
}

test('secret labels use boundaries and identifier segments without inspecting standard roles',()=>{
  for(const name of ['Shipping address','Author','monkey','Quantity','Keyboard','spinning']){
    assert.equal(isSensitiveLabel(name),false,name);
    const element={id:'e',name,role:'spinbutton',enabled:true,value:'3'};
    assert.equal(redactElement(element).name,name);
    assert.doesNotThrow(()=>authorizeAction({action:'fill',value:'3'},element));
  }
  for(const name of ['PIN','auth','api_key','access-token','accessToken','newPassword','APIKeyInput','apiKey1','password1','accessToken2','暗証番号','パスワード','認証コード','ＡＰＩキー']){
    assert.equal(isSensitiveLabel(name),true,name);
    const element={id:'e',name,role:'textbox',enabled:true,value:'PRIVATE_CANARY'};
    assert.ok(!JSON.stringify(redactElement(element)).includes('PRIVATE_CANARY'));
    assert.throws(()=>authorizeAction({action:'fill',value:'1234'},element),{code:'E_PRIVACY_BLOCKED'});
  }
});

test('real browser ordinary Shipping, Author and spinbutton controls remain editable',{timeout:20000},async()=>{
  const f=await fixture('<input id="a" aria-label="Shipping address"><input id="b" aria-label="Author"><input id="c" role="spinbutton" aria-label="Quantity" type="number">',['#a','#b','#c']);
  try{
    for(const [name,value] of [['Shipping address','Tokyo'],['Author','Alice'],['Quantity','3']]){
      const p=await f.engine.observe(f.id);const e=p.elements!.find(e=>e.name===name)!;assert.ok(e,name);
      await f.engine.act(f.id,{action:'fill',element_id:e.id,value,expected_target:{role:e.role,name}},p.revision);
      assert.equal((await f.engine.observe(f.id)).elements!.find(x=>x.id===e.id)!.value,value);
    }
  }finally{await f.close();}
});

test('Japanese labels and hidden lower-priority security hints protect neutral-id text inputs',{timeout:20000},async()=>{
  const f=await fixture('<label>暗証番号<input id="a" value="CANARY_PIN_1234"></label><input id="b" aria-label="パスワード" value="CANARY_PASSWORD_123"><label>パスワード<input id="c" aria-label="Reference" value="CANARY_HIDDEN_HINT"></label><input id="d" aria-label="Reference two" data-adl-sensitive value="CANARY_CLASSIFIED"><input id="e" aria-label="Reference three" autocomplete="one-time-code" value="CANARY_OTP">',['#a','#b','#c','#d','#e']);
  try{
    const p=await f.engine.observe(f.id,{token_budget:8000});
    assert.ok(!JSON.stringify(p).includes('CANARY_'));
    const fields=p.elements!.filter(e=>e.role==='textbox');assert.equal(fields.length,5);
    for(const e of fields){assert.equal(e.name,'[redacted]');await assert.rejects(f.engine.act(f.id,{action:'fill',element_id:e.id,value:'blocked'},p.revision),{code:'E_PRIVACY_BLOCKED'});}
  }finally{await f.close();}
});

test('bounded descendant and aria-labelledby names work through preflight; select choices are discoverable',{timeout:20000},async()=>{
  const f=await fixture('<button type="button" id="nested"><span><b>検索</b></span></button><span id="label">参照名</span><input id="field" aria-labelledby="label"><select id="color" aria-label="Color"><option value="r">赤</option><option value="b">青</option><option value="g" disabled>緑</option></select>',['#nested','#field','#color']);
  try{
    let p=await f.engine.observe(f.id,{token_budget:8000});const button=p.elements!.find(e=>e.role==='button')!;assert.equal(button.name,'検索');
    await f.engine.act(f.id,{action:'click',element_id:button.id,expected_target:{role:'button',name:'検索'}},p.revision);
    p=await f.engine.observe(f.id);const field=p.elements!.find(e=>e.role==='textbox')!;assert.equal(field.name,'参照名');
    await f.engine.act(f.id,{action:'fill',element_id:field.id,value:'日本語',expected_target:{role:'textbox',name:'参照名'}},p.revision);
    p=await f.engine.observe(f.id,{token_budget:8000});const select=p.elements!.find(e=>e.name==='Color')!;
    assert.deepEqual(select.options?.map(o=>[o.label,o.value,o.disabled]),[['赤','r',false],['青','b',false],['緑','g',true]]);
    await f.engine.act(f.id,{action:'select',element_id:select.id,value:'青'},p.revision);
    assert.equal((await f.engine.observe(f.id,{token_budget:8000})).elements!.find(e=>e.id===select.id)!.value,'b');
  }finally{await f.close();}
});

test('body email text is blacked out before retention and remains masked in crops',{timeout:20000},async()=>{
  const f=await fixture('<p style="position:absolute;left:20px;top:220px;margin:0;width:240px;height:30px">dummy@example.com</p><p style="position:absolute;left:20px;top:260px;margin:0;width:240px;height:30px">Ｐａｓｓｗｏｒｄ：Abc123</p><p style="position:absolute;left:20px;top:300px;margin:0;width:240px;height:30px">accessToken PRIVATE_CANARY</p><div style="position:absolute;left:300px;top:220px;width:50px;height:30px;background:#00ff00"></div>');
  try{
    assert.ok(!JSON.stringify(await f.engine.observe(f.id)).includes('dummy@example.com'));
    const frame=await f.engine.capture(f.id,{max_dimension:2048,max_pixels:4194304});
    const patch=await sharp(frame.png).extract({left:25,top:225,width:10,height:10}).removeAlpha().raw().toBuffer();
    assert.ok(patch.every(channel=>channel===0),'email text region must be masked');
    for(const top of [265,305])assert.ok((await sharp(frame.png).extract({left:25,top,width:10,height:10}).removeAlpha().raw().toBuffer()).every(value=>value===0));
    const publicPatch=await sharp(frame.png).extract({left:310,top:225,width:10,height:10}).removeAlpha().raw().toBuffer();assert.ok(publicPatch.every((value,i)=>value===(i%3===1?255:0)));
    assert.equal(frame.metadata.redaction?.scope,'detected_regions');assert.equal(frame.metadata.redaction?.complete,false);
    const crop=await f.engine.capture(f.id,{frame_id:frame.metadata.frame_id,region:{x:20,y:220,width:240,height:30}});
    assert.ok((await sharp(crop.png).removeAlpha().stats()).channels.every(c=>c.max===0));
    assert.deepEqual(crop.metadata.redaction,frame.metadata.redaction);
  }finally{await f.close();}
});

test('select option metadata and its selected value share secret redaction',{timeout:20000},async()=>{
  const f=await fixture('<select aria-label="Color"><option value="CANARY_OPTION_VALUE">API key</option><option value="b">青</option></select>');
  try{
    const p=await f.engine.observe(f.id,{token_budget:8000});assert.ok(!JSON.stringify(p).includes('CANARY_OPTION_VALUE'));
    const field=p.elements!.find(e=>e.role==='combobox')!;assert.equal(field.value,'[redacted]');assert.ok(field.options?.every(o=>o.value==='[redacted]'));
  }finally{await f.close();}
});

test('mixed nested labels and numeric identifiers never expose values or authorize a fill',{timeout:20000},async()=>{
  const f=await fixture('<label>API <b>key</b><input id="a" value="CANARY_NESTED_LABEL"></label><span id="n">Access <b>token</b></span><input id="b" aria-labelledby="n" value="CANARY_NESTED_REF"><input id="apiKey1" aria-label="Reference" value="CANARY_NUMERIC_SUFFIX"><button type="button" id="mixed">Search <span>now</span></button>',['#a','#b','#apiKey1','#mixed']);
  try{
    const p=await f.engine.observe(f.id,{token_budget:8000});assert.ok(!JSON.stringify(p).includes('CANARY_'));
    for(const e of p.elements!.filter(e=>e.role==='textbox')){
      assert.equal(e.name,'[redacted]');await assert.rejects(f.engine.act(f.id,{action:'fill',element_id:e.id,value:'blocked'},p.revision),{code:'E_PRIVACY_BLOCKED'});
    }
    const button=p.elements!.find(e=>e.role==='button')!;assert.equal(button.name,'Search now');
    await f.engine.act(f.id,{action:'click',element_id:button.id,expected_target:{role:'button',name:'Search now'}},p.revision);
  }finally{await f.close();}
});

test('classification and semantic attribute hints mask live non-form pixels and retained crops',{timeout:20000},async()=>{
  const values=['<p data-adl-classification="SECRET">2468</p>','<p aria-label="PIN">3579</p>','<p title="パスワード">4680</p>','<p aria-labelledby="hint">5791</p><span hidden id="hint">API <b>key</b></span>'];
  const html=values.map((value,i)=>value.replace('<p ',`<p style="position:absolute;left:20px;top:${60+i*50}px;width:200px;height:30px;margin:0;background:red" `)).join('');
  const f=await fixture(html);
  try{
    const state=await f.engine.observe(f.id,{token_budget:8000});for(const value of ['2468','3579','4680','5791'])assert.ok(!JSON.stringify(state).includes(value));
    const frame=await f.engine.capture(f.id,{max_dimension:2048,max_pixels:4194304});
    for(let i=0;i<4;i++){
      const crop=await f.engine.capture(f.id,{frame_id:frame.metadata.frame_id,region:{x:20,y:60+i*50,width:200,height:30}});
      assert.ok((await sharp(crop.png).removeAlpha().raw().toBuffer()).every(value=>value===0),`unmasked hint row ${i}`);
    }
  }finally{await f.close();}
});

test('incomplete bounded labels cannot disclose values and an oversized mask traversal fails closed',{timeout:20000},async()=>{
  const f=await fixture(`<label>Reference${'<span></span>'.repeat(140)}<b>API key</b><input id="field" value="CANARY_BEYOND_LABEL_LIMIT"></label>`,['#field']);
  try{
    const p=await f.engine.observe(f.id,{token_budget:8000});assert.ok(!JSON.stringify(p).includes('CANARY_BEYOND_LABEL_LIMIT'));
    const field=p.elements!.find(e=>e.role==='textbox')!;await assert.rejects(f.engine.act(f.id,{action:'fill',element_id:field.id,value:'blocked'},p.revision),{code:'E_PRIVACY_BLOCKED'});
  }finally{await f.close();}
  const big=await fixture('<span></span>'.repeat(5100));
  try{await assert.rejects(big.engine.capture(big.id),(error:any)=>['E_PRIVACY_BLOCKED','E_TIMEOUT'].includes(error.code));}finally{await big.close();}
});

test('depth limits semantic projection without breaking stable revisions or deeper observations',{timeout:20000},async()=>{
  const f=await fixture('<button type="button">Shallow</button><div><div><div><button type="button">Deep</button></div></div></div>');
  try{
    const shallow=await f.engine.observe(f.id,{depth:1}),deep=await f.engine.observe(f.id,{depth:12});
    assert.ok(shallow.elements!.some(e=>e.name==='Shallow'));assert.ok(!shallow.elements!.some(e=>e.name==='Deep'));
    assert.ok(deep.elements!.some(e=>e.name==='Deep'));assert.equal(shallow.revision,deep.revision);
    assert.ok(deep.elements!.every(e=>!('depth' in e)));
  }finally{await f.close();}
});

test('broad operation permission preserves target boundaries for subresources and navigation while allowing approved POST',{timeout:20000},async()=>{
  let contacts=0;const spy=createServer((_,res)=>{contacts++;res.end('forbidden');});await new Promise<void>(resolve=>spy.listen(0,'127.0.0.1',resolve));
  const forbidden=`http://127.0.0.1:${(spy.address() as {port:number}).port}`;
  const f=await fixture(`<p role="status" id="state">Loading</p><iframe src="${forbidden}/frame"></iframe><script>fetch('${forbidden}/fetch').catch(()=>{});fetch('/submit',{method:'POST',body:'TEST-001'}).then(()=>document.getElementById('state').textContent='Post done');</script>`,[],{allowAllOperations:true,restrictTargets:true});
  try{
    await f.engine.wait(f.id,{name:'Post done'},5000);
    assert.ok(f.requests.some(req=>req.method==='POST'&&req.url==='/submit'));
    assert.equal(contacts,0);
    const p=await f.engine.observe(f.id);await assert.rejects(f.engine.act(f.id,{action:'navigate',url:forbidden},p.revision),{code:'E_POLICY_DENIED'});
    assert.equal(contacts,0);
  }finally{await f.close();spy.closeAllConnections();await new Promise<void>(r=>spy.close(()=>r()));}
});
