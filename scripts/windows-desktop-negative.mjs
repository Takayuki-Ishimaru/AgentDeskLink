import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const [helper,app,controls,output]=process.argv.slice(2);const config=join(output,'negative-policy.json');
const allow=JSON.parse(await readFile(controls,'utf8'));allow.FixtureFocus={role:'button',allowed:['click']};
const localControls=join(output,'negative-controls.json');await writeFile(localControls,JSON.stringify(allow));
await writeFile(config,JSON.stringify({windows:{helperPath:resolve(helper),appPath:resolve(app),controlsPath:localControls,appId:'negative-fixture',classification:'PUBLIC'}}));
let client;const rows=[];const connect=async()=>{const c=new Client({name:'adl-negative',version:'1'});await c.connect(new StdioClientTransport({command:process.execPath,args:['dist/src/server.js','--config',config],cwd:process.cwd(),stderr:'pipe'}));return c};
try{
 client=await connect();
 const call=async(name,args={})=>JSON.parse((await client.callTool({name,arguments:args})).content[0].text);
 let target=(await call('adl_targets')).targets[0];const resetIfStopped=async()=>{const r=await call('adl_targets');if(r.ok)return;const old=target.target_id;await client.close();client=await connect();target=(await call('adl_targets')).targets[0];assert.equal((await call('adl_open',{target_id:old,mode:'background_semantic'})).error.code,'E_TARGET_NOT_FOUND');rows.push('explicit restart creates a fresh helper epoch after interrupted native IPC')};
 const open=async()=>{const s=await call('adl_open',{target_id:target.target_id,mode:'background_semantic'});assert.equal(s.ok,true,JSON.stringify(s));return s;};
 const observe=async(s)=>{const p=await call('adl_observe',{session_id:s.session_id,token_budget:8000});assert.equal(p.ok,true,JSON.stringify(p));return p;};
 const find=(p,name)=>{const e=p.elements.find(e=>e.name===name);assert.ok(e,`missing ${name}`);return e;};
 let s=await open();let p=await observe(s);
 const readOnly=await call('adl_act',{session_id:s.session_id,action:'fill',element_id:find(p,'Read only').id,value:'should-not-change',expected_revision:p.revision});assert.equal(readOnly.ok,false);assert.equal(readOnly.error.code,'E_POLICY_DENIED');rows.push('read-only mutation rejected');
 s=await open();p=await observe(s);
 const task=await call('adl_execute',{expected_revisions:{[s.session_id]:p.revision},steps:[{session_id:s.session_id,action:'wait_for',name:'Never appears',timeout_ms:20000},{session_id:s.session_id,action:'fill',element_id:find(p,'Fixture text').id,value:'MUST-NOT-APPLY'}]});assert.equal(task.ok,true);
 await delay(100);await call('adl_task',{task_id:task.task_id,command:'cancel'});
 let state;for(let i=0;i<100;i++){state=await call('adl_task',{task_id:task.task_id});if(state.status==='cancelled')break;await delay(25);}assert.equal(state.status,'cancelled');assert.equal(state.results[1].status,'not_executed');assert.equal((await call('adl_observe',{session_id:s.session_id})).ok,false);rows.push('native wait cancellation invalidates session and skips suffix');await resetIfStopped();
 s=await open();p=await observe(s);assert.notEqual(find(p,'Fixture text').value,'MUST-NOT-APPLY');await call('adl_close',{session_id:s.session_id});rows.push('cancelled suffix did not mutate fixture');
 s=await open();const timeout=await call('adl_wait',{session_id:s.session_id,condition:{name:'Never appears'},timeout_ms:100});assert.equal(timeout.error.code,'E_TIMEOUT');assert.equal((await call('adl_observe',{session_id:s.session_id})).ok,false);rows.push('native timeout invalidates session');await resetIfStopped();
 s=await open();p=await observe(s);
 const before=find(p,'Fixture text').value;
 const focus=await call('adl_execute',{expected_revisions:{[s.session_id]:p.revision},steps:[{session_id:s.session_id,action:'click',element_id:find(p,'Focus test').id},{session_id:s.session_id,action:'fill',element_id:find(p,'Fixture text').id,value:'MUST-NOT-AFTER-FOCUS'}]});assert.equal(focus.ok,true);
 for(let i=0;i<200;i++){state=await call('adl_task',{task_id:focus.task_id});if(!['queued','running'].includes(state.status))break;await delay(25);}
 if(state.status==='completed'){const actual=await observe(s);await writeFile(join(output,'focus-diagnostic.json'),JSON.stringify({task:state,observed:actual},null,2));}
 assert.equal(state.status,'failed',JSON.stringify(state));assert.equal(state.results[0].error.code,'E_FOCUS_CHANGED');assert.equal(state.results[0].error.may_have_executed,true);assert.equal(state.results[1].status,'not_executed');rows.push('deliberate application input-state interference stops batch with execution uncertainty');
 s=await open();p=await observe(s);find(p,'Interference fixture invoked');assert.equal(find(p,'Fixture text').value,before);await call('adl_close',{session_id:s.session_id});rows.push('interference handler ran and suffix did not mutate fixture');
 const stimulus=JSON.parse(await readFile(join(output,'interference-stimulus.json'),'utf8'));assert.equal(stimulus.cursor_changed,true);assert.notDeepEqual(stimulus.actual,stimulus.before);rows.push('actual cursor readback proves the negative-test stimulus changed input state');
 await writeFile(join(output,'negative-result.json'),JSON.stringify({ok:true,checks:rows,stimulus},null,2));
}catch(error){await writeFile(join(output,'negative-result.json'),JSON.stringify({ok:false,checks:rows,error:String(error)},null,2));throw error;}
finally{await client?.close();}
