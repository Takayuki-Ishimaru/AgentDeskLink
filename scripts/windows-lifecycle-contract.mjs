// Additional real-Windows failure, cancellation and concurrent-owner checks.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
assert.equal(process.platform,'win32');
const [helperArg,appArg,outArg]=process.argv.slice(2),helper=resolve(helperArg),app=resolve(appArg),out=resolve(outArg);
await mkdir(out,{recursive:true});const records=[],checks=[];let ok=false;
const assertCheck=(name)=>checks.push({name,ok:true});
async function native(enabled,appId='windows-character-map'){
 const child=spawn(helper,['--app-id',appId,'--app-path',app,...(enabled?['--lifecycle-enabled']:[])],{stdio:['pipe','pipe','pipe'],windowsHide:true});child.stderr.resume();
 let pending;const lines=createInterface({input:child.stdout});
 lines.on('line',line=>{const p=pending;pending=undefined;if(p){clearTimeout(p.timer);p.resolve(JSON.parse(line));}});
 let sequence=0;
 const send=(action,preCancel=false)=>new Promise((resolve,reject)=>{
  const id='r-'+(++sequence);const timer=setTimeout(()=>{pending=undefined;reject(new Error('native lifecycle deadline'));},10000);pending={resolve,reject,timer};
  const rows=[...(preCancel?[{op:'cancel_input',request_id:id}]:[]),{op:'application',request_id:id,action}];child.stdin.write(rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 }).then(result=>{records.push({transport:'native',enabled,action,preCancel,result});return result;});
 return{send,close:async()=>{try{if(enabled)await send('quit');}finally{child.stdin.end();await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('native helper did not exit'));},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});if(child.exitCode!==null){clearTimeout(timer);resolve();}});}}};
}
const peers=[];
async function peer(id){
 const policy=join(out,`policy-${id}.json`);await writeFile(policy,JSON.stringify({actionTimeoutMs:15000,windows:{helperPath:helper,appPath:app,appId:'windows-character-map',classification:'PUBLIC',lifecycle:{enabled:true}}},null,2));
 const client=new Client({name:`adl-windows-owner-${id}`,version:'1.0.0'},{versionNegotiation:{mode:'legacy'}});
 await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/src/server.js','--config',policy],cwd:process.cwd(),stderr:'pipe'}));
 const call=async(action)=>{const raw=await client.callTool({name:'adl_app',arguments:{application_id:'windows-character-map',action}},{},{timeout:22000});const result=JSON.parse(raw.content.find(c=>c.type==='text').text);records.push({transport:'mcp',peer:id,action,result});assert.equal(result.ok,true,JSON.stringify(result));return result;};
 const p={client,call};peers.push(p);return p;
}
try{
 const off=await native(false);try{assert.equal((await off.send('launch')).error.code,'E_POLICY_DENIED');assertCheck('native opt-out rejects lifecycle before launching an application');}finally{await off.close();}
 const literal=await native(false,'--lifecycle-worker');try{assert.equal((await literal.send('launch')).error.code,'E_POLICY_DENIED');assertCheck('a configured application ID resembling an internal flag remains data');}finally{await literal.close();}
 const cancelled=await native(true);try{
  const result=await cancelled.send('launch',true);assert.equal(result.error.code,'E_CANCELLED');assert.notEqual(result.may_have_executed,true);
  assert.deepEqual((await cancelled.send('status')).result,{running:false,managed:false,changed:false});assertCheck('native pre-cancellation launches no process and status stays available');
 }finally{await cancelled.close();}
 const a=await peer('A'),b=await peer('B');
 assert.equal((await a.call('launch')).managed,true);
 assert.equal((await b.call('status')).running,false);
 assert.equal((await b.call('quit')).changed,false);
 assert.equal((await a.call('status')).running,true);assertCheck('one helper cannot adopt or quit the other helper application');
 assert.equal((await b.call('launch')).managed,true);
 assert.equal((await b.call('quit')).changed,true);
 assert.equal((await a.call('status')).running,true);
 assert.equal((await a.call('quit')).changed,true);assertCheck('concurrent helper owners launch and close independently');
 ok=true;
}finally{
 const cleanup=[];for(const p of peers){try{cleanup.push(await p.call('quit'));}catch(e){cleanup.push({ok:false,error:e.message});}await p.client.close();}
 await writeFile(join(out,'verification.json'),JSON.stringify({ok,checks,cleanup,physical_input:false},null,2));
 await writeFile(join(out,'transcript.json'),JSON.stringify(records,null,2));
}
