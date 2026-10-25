// Run inside an interactive Windows session, with an independent human-input
// monitor. The application is started and closed exclusively through the MCP.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

assert.equal(process.platform,'win32');
const [helper,app,outArg]=process.argv.slice(2);
assert.ok(helper&&app&&outArg,'helper, charmap executable and output directory required');
const out=resolve(outArg),appId='windows-character-map',records=[],checks=[];
await mkdir(out,{recursive:true});
const policy=join(out,'policy.json');
await writeFile(policy,JSON.stringify({actionTimeoutMs:15000,auditPath:join(out,'audit.jsonl'),windows:{helperPath:resolve(helper),appPath:resolve(app),appId,controlsPath:resolve('config/windows-character-map.controls.json'),classification:'PUBLIC',lifecycle:{enabled:true}}},null,2));
const client=new Client({name:'adl-windows-background-charmap',version:'1.0.0'},{versionNegotiation:{mode:'legacy'}});
const call=async(name,args={},expected)=>{
 const raw=await client.callTool({name,arguments:args},{},{timeout:22000});
 const data=JSON.parse(raw.content.find(c=>c.type==='text').text);records.push({tool:name,args,result:data});
 if(expected==='reobserve_stale'&&data.error?.code==='E_STALE_STATE'&&!data.error.may_have_executed)return data;
 if(expected&&expected!=='reobserve_stale')assert.equal(data.error?.code,expected,JSON.stringify(data));else assert.equal(data.ok,true,JSON.stringify(data));
 return data;
};
const record=(name,detail={})=>checks.push({name,ok:true,...detail});
const observe=async(session)=>{
 let p=await call('adl_observe',{session_id:session,token_budget:8000});const revision=p.revision,elements=[...p.elements];
 while(p.next_cursor){p=await call('adl_observe',{session_id:session,token_budget:8000,cursor:p.next_cursor});assert.equal(p.revision,revision);elements.push(...p.elements);}
 assert.equal(p.truncated,false);return{revision,elements};
};
const text=e=>e.role==='textbox'&&/コピーする文字|Characters to copy/i.test(e.name);
const checkbox=e=>e.role==='checkbox'&&/詳細表示|Advanced view/i.test(e.name);
let connected=false,owned=false,session,ok=false,error;
try{
 await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/src/server.js','--config',policy],cwd:process.cwd(),stderr:'pipe'}));connected=true;
 assert.deepEqual((await call('adl_applications')).applications.map(x=>x.application_id),[appId]);
 const caps=await call('adl_capabilities');assert.equal(caps.lifecycle.platform_supported,true);assert.equal(caps.lifecycle.available,true);
 await call('adl_app',{application_id:'unapproved-app',action:'launch'},'E_POLICY_DENIED');
 assert.deepEqual(await call('adl_app',{application_id:appId,action:'status'}),{ok:true,application_id:appId,running:false,managed:false,changed:false});
 for(let cycle=1;cycle<=3;cycle++){
  const launch=await call('adl_app',{application_id:appId,action:'launch'});owned=true;assert.equal(launch.running,true);assert.equal(launch.managed,true);assert.equal(launch.changed,true);
  assert.equal((await call('adl_app',{application_id:appId,action:'launch'})).changed,false);
  const inspected=[];let state;
  for(let attempt=0;attempt<30&&!session;attempt++){
   const targets=(await call('adl_targets',{surface:'desktop'})).targets;
   for(const target of targets){
    const opened=await call('adl_open',{target_id:target.target_id,mode:'background_semantic'});
    const current=await observe(opened.session_id);
    inspected.push({target_id:target.target_id,label:target.label,elements:current.elements.length,text_fields:current.elements.filter(text),checkboxes:current.elements.filter(checkbox)});
    if(current.elements.filter(text).length===1&&current.elements.filter(checkbox).length===1){assert.equal(session,undefined);session=opened.session_id;state=current;break;}
    await call('adl_close',{session_id:opened.session_id});
   }
   if(!session)await delay(100);
  }
  await writeFile(join(out,`target-selection-${cycle}.json`),JSON.stringify(inspected,null,2));
  assert.ok(session,'an exact window exposing both approved Character Map controls');
  const original=state.elements.find(text).value;
  assert.ok(['','\r','\n','\r\n'].includes(original),'new owned application must contain only an empty edit or its line terminator');
  const apply=async(predicate,action,args)=>{
   for(let attempt=0;attempt<3;attempt++){
    const current=await observe(session);const matches=current.elements.filter(predicate);assert.equal(matches.length,1);
    const applied=await call('adl_act',{session_id:session,expected_revision:current.revision,action,element_id:matches[0].id,expected_target:{role:matches[0].role,name:matches[0].name},...args},'reobserve_stale');
    if(applied.ok)return (await observe(session)).elements.find(predicate);
    await delay(100); // A proven pre-dispatch stale revision requires a new observation.
   }
   throw new Error('Character Map did not reach a stable observed revision');
  };
  const value=`AgentDeskLink 日本語 ${cycle}`;
  assert.equal((await apply(text,'fill',{value})).value,value);
  assert.equal((await apply(text,'fill',{value:original})).value,original);
  assert.equal((await apply(checkbox,'check',{checked:true})).checked,true);
  assert.equal((await apply(checkbox,'check',{checked:false})).checked,false);
  record('actual application launch, Unicode input/readback, toggle and restore',{cycle});
  const quit=await call('adl_app',{application_id:appId,action:'quit'});owned=false;assert.equal(quit.running,false);assert.equal(quit.managed,false);assert.equal(quit.changed,true);
  await call('adl_observe',{session_id:session},'E_TARGET_NOT_FOUND');session=undefined;
  assert.equal((await call('adl_app',{application_id:appId,action:'quit'})).changed,false);
  assert.equal((await call('adl_app',{application_id:appId,action:'status'})).running,false);
  record('normal quit, stale session invalidation and idempotent stopped state',{cycle});
 }
 ok=true;
}catch(e){error={message:e.message,stack:e.stack};throw e;}
finally{
 if(connected&&owned){try{const closed=await call('adl_app',{application_id:appId,action:'quit'});owned=closed.running;}catch(e){checks.push({name:'normal cleanup',ok:false,error:e.message});}}
 await client.close();
 await writeFile(join(out,'mcp-transcript.json'),JSON.stringify(records,null,2));
 await writeFile(join(out,'verification.json'),JSON.stringify({ok,application:'Windows Character Map',cycles:3,checks,error,owned_app_remaining:owned,physical_input:false,setup_and_quit:'AgentDeskLink lifecycle API',mcp_calls:records.length},null,2));
}
