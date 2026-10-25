import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeDesktopAdapter} from '../src/desktop.js';
import {AdlError,type DesktopConfig} from '../src/types.js';

// Exercise transport only. This fixture cannot access native input APIs or the UI.
const HELPER=String.raw`
import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const log=value=>appendFileSync(process.env.ADL_CANCEL_LOG,JSON.stringify(value)+'\n');
const out=value=>process.stdout.write(JSON.stringify(value)+'\n');
if(process.argv.includes('--release-input')){
 log({event:'release_started'});
 setTimeout(()=>{log({event:'release_completed'});out({released_input:true});process.exit(0)},125);
}else{
 if(process.env.ADL_CANCEL_MODE==='ignore_term')process.on('SIGTERM',()=>log({event:'term_ignored'}));
 let active;
 createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line);log({event:'request',op:r.op,id:r.request_id});
  if(r.op==='gesture'||r.op==='commit_input'||r.op==='prepare_input'){
   active=r;
   if(process.env.ADL_CANCEL_MODE==='release_failed')out({ok:false,request_id:r.request_id,error:{code:'E_PARTIAL_EXECUTION'},may_have_executed:true});
   if(process.env.ADL_CANCEL_MODE==='exit')setTimeout(()=>process.exit(7),20);
   if(process.env.ADL_CANCEL_MODE==='finish')setTimeout(()=>out({ok:true,request_id:r.request_id,result:{complete:true}}),250);
  }else if(r.op==='cancel_input'){
   // Wait for a test-controlled gate, so scheduler delays cannot satisfy the
   // assertion before the parent has observed the still-pending request.
  }else if(r.op==='fixture_release'){
   if(process.env.ADL_CANCEL_MODE==='ack'&&active)setTimeout(()=>{log({event:'cancel_ack'});out({ok:false,request_id:active.request_id,error:{code:'E_CANCELLED'},may_have_executed:true});active=undefined},125);
  }else out({ok:true,request_id:r.request_id,result:{alive:true}});
 });
}
`;
interface Client {call(op:string,args:Record<string,unknown>,signal?:AbortSignal):Promise<Record<string,unknown>>;close():Promise<void>}
async function fixture(mode:string){
 const dir=await mkdtemp(join(tmpdir(),'adl-cancel-contract-')),path=join(dir,'helper.mjs'),log=join(dir,'events.jsonl');await writeFile(path,HELPER);await writeFile(log,'');
 const children:ChildProcess[]=[];
 const config:DesktopConfig={helperPath:path,appId:'fixture',appPath:'/synthetic',classification:'PUBLIC'};
 const adapter=new NativeDesktopAdapter(config,{platform:'darwin',spawnFn:(helper,args)=>{const child=spawn(process.execPath,[helper,...args],{stdio:['pipe','pipe','pipe'],env:{...process.env,ADL_CANCEL_MODE:mode,ADL_CANCEL_LOG:log}});
  // Windows cannot trap process.kill(SIGTERM); simulate a refusing termination
  // boundary there so the same transport fallback still reaches SIGKILL.
  if(process.platform==='win32'&&mode==='ignore_term'&&!args.includes('--release-input')){const kill=child.kill.bind(child);child.kill=signal=>{if(!signal||signal==='SIGTERM'){appendFileSync(log,JSON.stringify({event:'term_ignored'})+'\n');return true;}return kill(signal);};}
  children.push(child);return child;}});
 // The client is kept private in production; this probe reaches only its JSONL queue.
 const client=(adapter as unknown as {getClient():Client}).getClient();
 const events=async()=>{const text=await readFile(log,'utf8');return text.trim()?text.trim().split('\n').map(line=>JSON.parse(line) as Record<string,unknown>):[]};
 const until=async(predicate:(events:Record<string,unknown>[])=>boolean)=>{for(let i=0;i<100;i++){const seen=await events();if(predicate(seen))return seen;await delay(10);}throw new Error('fixture event deadline')};
 return {client,children,events,until,physical:()=> (adapter as unknown as {parsePhysical<T>(operation:()=>Promise<T>):Promise<T>}).parsePhysical(()=>client.call('commit_input',{})),dispose:async()=>{await adapter.close().catch(()=>{});for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}};
}

test('physical cancellation sends one matching control, waits for release ack and preserves helper',{timeout:5000},async()=>{
 const f=await fixture('ack'),cancel=new AbortController();try{
  const input=f.client.call('gesture',{},cancel.signal);const rejected=assert.rejects(input,(e:unknown)=>e instanceof AdlError&&e.code==='E_CANCELLED'&&e.mayHaveExecuted);
  await f.until(events=>events.some(x=>x.op==='gesture'));cancel.abort();cancel.abort();await f.until(events=>events.some(x=>x.op==='cancel_input'));
  assert.equal(f.children[0]!.exitCode,null);assert.equal(f.children[0]!.signalCode,null);assert.ok(!(await f.events()).some(x=>x.event==='cancel_ack'));
  f.children[0]!.stdin!.write(JSON.stringify({op:'fixture_release'})+'\n');
  await rejected;const events=await f.events(),requests=events.filter(x=>x.event==='request'&&x.op!=='fixture_release');assert.deepEqual(requests.map(x=>x.op),['gesture','cancel_input']);assert.equal(requests[0]!.id,requests[1]!.id);assert.ok(events.some(x=>x.event==='cancel_ack'));assert.ok(!events.some(x=>x.event==='release_started'));
  assert.equal((await f.client.call('ping',{})).alive,true);assert.equal(f.children.length,1);
 }finally{await f.dispose();}
});
test('aborting a queued call does not cancel somebody else\'s pending physical request',{timeout:5000},async()=>{
 const f=await fixture('finish'),cancel=new AbortController();try{
  const first=f.client.call('gesture',{});await f.until(events=>events.some(x=>x.op==='gesture'));
  const queued=f.client.call('snapshot',{},cancel.signal),rejected=assert.rejects(queued,{code:'E_CANCELLED'});cancel.abort();assert.equal((await first).complete,true);await rejected;
  assert.deepEqual((await f.events()).filter(x=>x.event==='request').map(x=>x.op),['gesture']);assert.equal(f.children.length,1);assert.equal((await f.client.call('ping',{})).alive,true);
 }finally{await f.dispose();}
});
test('unexpected helper exit waits for fixed emergency release helper before rejecting physical call',{timeout:5000},async()=>{
 const f=await fixture('exit');try{
  await assert.rejects(f.client.call('commit_input',{}),(e:unknown)=>e instanceof AdlError&&e.mayHaveExecuted);
  const events=await f.events();assert.equal(events.filter(x=>x.event==='release_started').length,1);assert.equal(events.filter(x=>x.event==='release_completed').length,1);assert.equal(f.children.length,2);
 }finally{await f.dispose();}
});
test('unacknowledged physical cancellation terminates helper and waits for one emergency release',{timeout:6000},async()=>{
 const f=await fixture('ignore'),cancel=new AbortController();try{
  const input=f.client.call('gesture',{},cancel.signal),rejected=assert.rejects(input,(e:unknown)=>e instanceof AdlError&&e.code==='E_CANCELLED'&&e.mayHaveExecuted);await f.until(events=>events.some(x=>x.op==='gesture'));cancel.abort();await rejected;
  const events=await f.events();assert.equal(events.filter(x=>x.op==='cancel_input').length,1);assert.equal(events.filter(x=>x.event==='release_started').length,1);assert.equal(events.filter(x=>x.event==='release_completed').length,1);assert.equal(f.children.length,2);
 }finally{await f.dispose();}
});
test('forced SIGKILL also waits for emergency release instead of skipping release on termination deadline',{timeout:7000},async()=>{
 const f=await fixture('ignore_term'),cancel=new AbortController();try{
  const input=f.client.call('gesture',{},cancel.signal),rejected=assert.rejects(input,(e:unknown)=>e instanceof AdlError&&e.code==='E_CANCELLED'&&e.mayHaveExecuted);await f.until(events=>events.some(x=>x.op==='gesture'));cancel.abort();await rejected;
  const events=await f.events();assert.ok(events.some(x=>x.event==='term_ignored'));assert.equal(events.filter(x=>x.event==='release_started').length,1);assert.equal(events.filter(x=>x.event==='release_completed').length,1);assert.equal(f.children.length,2);
 }finally{await f.dispose();}
});

test('native release failure waits for emergency release acknowledgement before physical error rejection',{timeout:5000},async()=>{
 const f=await fixture('release_failed');try{
  await assert.rejects(f.physical(),(e:unknown)=>e instanceof AdlError&&e.code==='E_PARTIAL_EXECUTION'&&e.mayHaveExecuted);
  const events=await f.events();assert.equal(events.filter(x=>x.event==='release_started').length,1);assert.equal(events.filter(x=>x.event==='release_completed').length,1);assert.equal(f.children.length,2);assert.deepEqual(events.filter(x=>x.event==='request').map(x=>x.op),['commit_input']);
 }finally{await f.dispose();}
});
