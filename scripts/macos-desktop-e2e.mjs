// Real macOS multi-display/multiwindow acceptance; synthetic app only.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
assert.equal(process.platform,'darwin');const root=process.cwd(),out=resolve('artifacts');await mkdir(out,{recursive:true});
const build=resolve('native/macos-ax/build');
function channel(exe,args=[]){
 const p=spawn(exe,args,{stdio:['pipe','pipe','pipe']});let queued=[],waiters=[];let errors='';p.stderr.on('data',c=>errors=(errors+c).slice(-1000));
 createInterface({input:p.stdout}).on('line',l=>{const value=JSON.parse(l);const w=waiters.shift();if(w){clearTimeout(w.timer);w.resolve(value)}else queued.push(value)});
 const next=()=>queued.length?Promise.resolve(queued.shift()):new Promise((resolve,reject)=>{const w={resolve,reject,timer:setTimeout(()=>{waiters=waiters.filter(v=>v!==w);reject(new Error(`native fixture timed out: ${errors}`))},10000)};waiters.push(w)});
 return {p,next,call:async value=>{p.stdin.write(JSON.stringify(value)+'\n');return next()}};
}
const checks=[];let client,fixture,monitor,human;const record=(name,detail={})=>{const row={name,ok:true,...detail};checks.push(row);console.log(JSON.stringify(row))};
try {
 fixture=channel(join(build,'ADLFixture.app/Contents/MacOS/ADLFixture'));const initial=await fixture.next();assert.equal(initial.ready,true);assert.ok(initial.screens.length>=2);const n=initial.windows.length;assert.ok(n>=2);
 record('real display inventory',{screens:initial.screens,windows:n});
 human=channel(join(build,'ADLHuman.app/Contents/MacOS/ADLFixture'),['--foreground']);assert.equal((await human.next()).ready,true);await delay(500);
 monitor=channel(join(build,'adl-macos-monitor'));assert.equal((await monitor.next()).ready,true);
 const config=join(out,'macos-e2e-policy.json'),audit=join(out,'macos-e2e-audit.jsonl');
 await writeFile(config,JSON.stringify({maxSessions:8,actionTimeoutMs:15000,auditPath:audit,macos:{helperPath:join(build,'adl-macos-ax-helper'),appPath:join(build,'ADLFixture.app/Contents/MacOS/ADLFixture'),appId:'local.agentdesklink.fixture',controlsPath:resolve('native/macos-ax/controls.example.json'),classification:'PUBLIC'}}));
 client=new Client({name:'adl-macos-native-acceptance',version:'1.0.0'},{versionNegotiation:{mode:'legacy'}});await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/src/server.js','--config',config],cwd:root,stderr:'pipe'}));
 const call=async(name,arguments_={})=>JSON.parse((await client.callTool({name,arguments:arguments_})).content[0].text);
 const ok=async(name,args)=>{const r=await call(name,args);assert.equal(r.ok,true,`${name}: ${JSON.stringify(r)}`);return r};
 const targets=(await ok('adl_targets',{surface:'desktop'})).targets;assert.equal(targets.length,n);assert.equal(new Set(targets.map(t=>t.target_id)).size,n);assert.equal(new Set(targets.map(t=>t.label)).size,1);
 assert.ok(targets.some(t=>t.window.bounds.x<0));assert.ok(new Set(targets.flatMap(t=>t.window.display_ids)).size>=2);record('same-title windows have distinct targets on separate displays',{targets});
 assert.equal((await call('adl_open',{target_id:targets[0].target_id})).error.code,'E_INTERFERENCE_RISK');
 const windows=[];const observe=async s=>{const r=await ok('adl_observe',{session_id:s.session_id,token_budget:8000});assert.equal(r.truncated,false);assert.ok(!JSON.stringify(r).includes('CANARY_MAC_SECRET'));return r};
 const find=(p,name)=>{const e=p.elements.find(e=>e.name===name);assert.ok(e,`missing ${name}`);return e};
 for(const target of targets){const s=await ok('adl_open',{target_id:target.target_id,mode:'background_semantic'});const p=await observe(s);const index=Number(find(p,'Reference').value.split('-')[1]);windows[index]={...s,target,p,index};}
 for(const w of windows)assert.ok(w);record('exact initial window binding and secure-field redaction');
 const foreign=await call('adl_act',{session_id:windows[1].session_id,action:'fill',element_id:find(windows[0].p,'Reference').id,value:'MUST-NOT-WRITE',expected_revision:windows[1].p.revision});assert.equal(foreign.error.code,'E_TARGET_NOT_FOUND');record('cross-window element handle rejected');
 // AppKit lazily materializes window chrome on its first AX mutation. Capture it before paired batches.
 await ok('adl_act',{session_id:windows[0].session_id,action:'fill',element_id:find(windows[0].p,'Reference').id,value:'Initial-0',expected_revision:windows[0].p.revision});
 for(const w of windows)w.p=await observe(w);record('AppKit accessibility materialization observed after explicit warmup');
 let actionCount=1;
 for(let round=0;round<30;round++){
  const steps=[],expected={};
  for(const w of windows){w.p=await observe(w);expected[w.session_id]=w.p.revision;const value=`MAC-${w.index}-${String(round).padStart(2,'0')}`;steps.push({session_id:w.session_id,action:'fill',element_id:find(w.p,'Reference').id,value},{session_id:w.session_id,action:'click',element_id:find(w.p,'Run search').id},{session_id:w.session_id,action:'wait_for',role:'text',name:`Done ${value} #${round+1}`,timeout_ms:3000},{session_id:w.session_id,action:'check',element_id:find(w.p,'Enabled').id,checked:round%2===0});}
  const task=await ok('adl_execute',{steps,expected_revisions:expected});let final;
  for(let i=0;i<600;i++){final=await ok('adl_task',{task_id:task.task_id});if(!['queued','running'].includes(final.status))break;await delay(25)}
  if(final.status!=='completed'){const debug=[];for(const w of windows){debug.push({index:w.index,before:w.p,after:await call('adl_observe',{session_id:w.session_id,token_budget:8000})})}await writeFile(join(out,'macos-state-debug.json'),JSON.stringify({final,debug},null,2));}assert.equal(final.status,'completed',JSON.stringify(final));actionCount+=steps.length;
  const state=await fixture.call({op:'state'});
  for(const w of windows){const f=state.windows.find(v=>v.index===w.index),value=`MAC-${w.index}-${String(round).padStart(2,'0')}`;assert.equal(f.field,value);assert.equal(f.clicks,round+1);assert.equal(f.checked,round%2===0);w.p=await observe(w);assert.equal(find(w.p,'Reference').value,value);assert.equal(find(w.p,'Enabled').checked,round%2===0);assert.ok(w.p.elements.some(e=>e.value===`Done ${value} #${round+1}`));}
 }
 record('30 paired variants across all same-app windows',{actions:actionCount,windows:n});
 const first=windows[0],oldID=first.target.target_id;
 for(let screen=0;screen<initial.screens.length;screen++){
  await fixture.call({op:'move',index:0,screen});await delay(80);const list=(await ok('adl_targets',{surface:'desktop'})).targets;const moved=list.find(t=>t.target_id===oldID);assert.ok(moved);assert.ok(moved.window.display_ids.includes(initial.screens[screen].display_id));first.p=await observe(first);
  await ok('adl_act',{session_id:first.session_id,action:'fill',element_id:find(first.p,'Reference').id,value:`MOVED-${screen}`,expected_revision:first.p.revision});actionCount++;
  assert.equal((await fixture.call({op:'state'})).windows.find(v=>v.index===0).field,`MOVED-${screen}`);
 }
 record('session and target identity retained across every physical display');
 await fixture.call({op:'span',index:0});await delay(80);const span=(await ok('adl_targets',{surface:'desktop'})).targets.find(t=>t.target_id===oldID);assert.ok(span.window.display_ids.length>=2);record('window spanning displays reports all intersecting displays');
 await fixture.call({op:'rename',index:0});await delay(50);assert.ok((await ok('adl_targets',{surface:'desktop'})).targets.some(t=>t.target_id===oldID&&t.label==='ADL Renamed Fixture'));record('title change preserves identity');
 first.p=await observe(first);await fixture.call({op:'set',index:0,value:'EXTERNAL'});const stale=await call('adl_act',{session_id:first.session_id,action:'fill',element_id:find(first.p,'Reference').id,value:'STALE-WRITE',expected_revision:first.p.revision});assert.equal(stale.error.code,'E_STALE_STATE');record('external mutation rejects stale revision');
 await fixture.call({op:'close',index:0});await fixture.call({op:'reopen',index:0,screen:1});await delay(100);
 const refreshed=(await ok('adl_targets',{surface:'desktop'})).targets;assert.equal(refreshed.length,n);assert.ok(!refreshed.some(t=>t.target_id===oldID));assert.equal((await call('adl_open',{target_id:oldID,mode:'background_semantic'})).error.code,'E_TARGET_NOT_FOUND');assert.equal((await call('adl_observe',{session_id:first.session_id})).error.code,'E_TARGET_NOT_FOUND');
 await ok('adl_close',{session_id:first.session_id});await observe(windows[1]);const replacement=refreshed.find(t=>!targets.some(old=>old.target_id===t.target_id));assert.ok(replacement);const newS=await ok('adl_open',{target_id:replacement.target_id,mode:'background_semantic'});for(let tries=0;;tries++){const r=await call('adl_observe',{session_id:newS.session_id,token_budget:8000});if(r.ok)break;if(tries>=20||r.error.code!=='E_TARGET_NOT_FOUND')assert.fail(JSON.stringify(r));await delay(50)}record('close/recreate never retargets, sibling session survives');
 await ok('adl_close',{session_id:newS.session_id});for(const w of windows.slice(1))await ok('adl_close',{session_id:w.session_id});
 monitor.p.stdin.end();const sample=await monitor.next();assert.ok(sample.samples>10);assert.equal(sample.probe_errors,0);assert.equal(sample.changed_samples,0);record('external foreground/focus/cursor stability',sample);await writeFile(join(out,'macos-external-monitor.json'),JSON.stringify(sample,null,2));
 const log=await readFile(audit,'utf8');assert.ok(!log.includes('MAC-')&&!log.includes('CANARY_')&&!log.includes('MOVED-'));record('audit excludes values');
 await writeFile(join(out,'macos-desktop-e2e.json'),JSON.stringify({ok:true,measured_at:new Date().toISOString(),steps:actionCount,semantic_mutations:1+30*windows.length*3+initial.screens.length,wait_steps:30*windows.length,checks},null,2)+'\n');
} catch(error){if(monitor){monitor.p.stdin.end();try{const sample=await monitor.next();await writeFile(join(out,'macos-external-monitor-failed.json'),JSON.stringify(sample,null,2));console.error(JSON.stringify(sample));}catch{}}await writeFile(join(out,'macos-desktop-e2e.json'),JSON.stringify({ok:false,error:String(error),checks},null,2)+'\n');throw error}
finally{await client?.close();fixture?.p.kill();monitor?.p.kill();if(human){human.p.stdin.write(JSON.stringify({op:'quit'})+'\n');await new Promise(r=>{human.p.once('exit',r);setTimeout(()=>{human.p.kill();r()},1000).unref()})}}
