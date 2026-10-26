import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {BrowserAdapter} from '../src/browser.js';
import {Engine} from '../src/core.js';
import {parsePolicy,assertUrlAllowed} from '../src/policy.js';
import assert from 'node:assert/strict';
import type {ObserveOptions,ObserveResult} from '../src/snapshot.js';
import type {Element} from '../src/types.js';
const fixture=createServer((request,r)=>{const all=new URL(request.url??'/','http://fixture').searchParams.get('mode')==='status_all';r.setHeader('content-type','text/html');r.end(`<label>Search<input id="q" aria-label="Search"></label><button id="find" type="button">Find</button>${Array.from({length:200},(_,i)=>`<p role="status">Row ${i} ready</p>`).join('')}<script>let count=0;document.querySelector('#find').onclick=()=>{count++;const rows=document.querySelectorAll('[role=status]');for(let i=0;i<${all?200:1};i++)rows[i].textContent='Row '+i+' update '+count};</script>`);});
await new Promise<void>(r=>fixture.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${(fixture.address() as {port:number}).port}`;
const policy=parsePolicy({allowedOrigins:[origin],allowLoopback:true,browserTargets:[{id:'benchmark',label:'Benchmark',url:origin,classification:'PUBLIC',controls:[{selector:'#q',actions:['fill']},{selector:'#find',actions:['click']}]}]});
const browser=new BrowserAdapter(policy,url=>assertUrlAllowed(url,policy));const engine=new Engine(policy,{browser});
try{
 const target=(await engine.listTargets()).targets[0]!;const session=await engine.open(target.target_id);
 const warm=await engine.observe(session.session_id,{token_budget:8000});
 const durations:number[]=[],bytes:number[]=[];
 for(let i=0;i<100;i++){const start=performance.now();const p=await engine.observe(session.session_id,{since_revision:warm.revision,token_budget:1800});durations.push(performance.now()-start);bytes.push(Buffer.byteLength(JSON.stringify(p)));}
 const fullBytes=Buffer.byteLength(JSON.stringify(warm));const sorted=[...durations].sort((a,b)=>a-b);
 await engine.close(session.session_id);
 const measurements:Record<string,unknown>[]=[];
 const collect=async(id:string,options:ObserveOptions)=>{
   let cursor:string|undefined;const pages:ObserveResult[]=[];const start=performance.now();
   do{const page=await engine.observe(id,{...options,...(cursor?{cursor}:{})});pages.push(page);assert.ok(Buffer.byteLength(JSON.stringify(page))<=options.token_budget*4);cursor=page.next_cursor??undefined;assert.ok(pages.length<256);}while(cursor);
   return {pages,bytes:pages.reduce((n,p)=>n+Buffer.byteLength(JSON.stringify(p)),0),ms:performance.now()-start,elements:pages.flatMap(p=>p.elements??[])};
 };
 const sortElements=(elements:Element[])=>[...elements].sort((a,b)=>a.id.localeCompare(b.id));
 for(const token_budget of [1800,8000])for(const mode of ['unchanged','input_one','status_one','status_all']){
   policy.browserTargets[0]!.url=`${origin}/?mode=${mode}`;
   const current=await engine.open(target.target_id);
   try{for(let iteration=0;iteration<20;iteration++){
     const initial=await collect(current.session_id,{token_budget}),baseline=initial.pages[0]!.revision;
     const start=performance.now();
     if(mode==='input_one')await engine.act(current.session_id,{action:'fill',element_id:initial.elements.find(e=>e.role==='textbox')!.id,value:`TEST-${iteration}`},baseline);
     else if(mode!=='unchanged')await engine.act(current.session_id,{action:'click',element_id:initial.elements.find(e=>e.role==='button')!.id},baseline);
     const action_ms=performance.now()-start;
     const full=await collect(current.session_id,{token_budget});
     const delta=await collect(current.session_id,{token_budget,since_revision:baseline});
     const automatic=await collect(current.session_id,{token_budget,since_revision:baseline,representation:'auto'});
     const rebuilt=new Map(initial.elements.map(e=>[e.id,e]));
     for(const page of delta.pages)for(const change of page.changes??[])if(change.op==='removed')rebuilt.delete(change.id);else rebuilt.set(change.id,change.element!);
     assert.deepEqual(sortElements([...rebuilt.values()]),sortElements(full.elements));
     if(automatic.pages[0]!.representation==='full')assert.deepEqual(sortElements(automatic.elements),sortElements(full.elements));
     measurements.push({token_budget,mode,iteration,action_ms,full_bytes:full.bytes,delta_bytes:delta.bytes,auto_bytes:automatic.bytes,full_ms:full.ms,delta_ms:delta.ms,auto_ms:automatic.ms,full_pages:full.pages.length,delta_pages:delta.pages.length,auto_pages:automatic.pages.length,representation:automatic.pages[0]!.representation,reconstruction:true});
   }}finally{await engine.close(current.session_id);}
 }
 const median=(values:number[])=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)]!;
 const summary=[1800,8000].flatMap(token_budget=>['unchanged','input_one','status_one','status_all'].map(mode=>{
   const rows=measurements.filter(row=>row.token_budget===token_budget&&row.mode===mode),values=(key:string)=>rows.map(row=>row[key] as number);
   return {token_budget,mode,observations:rows.length,full_bytes:median(values('full_bytes')),delta_bytes:median(values('delta_bytes')),auto_bytes:median(values('auto_bytes')),full_pages:median(values('full_pages')),delta_pages:median(values('delta_pages')),auto_pages:median(values('auto_pages')),full_p50_ms:median(values('full_ms')),delta_p50_ms:median(values('delta_ms')),auto_p50_ms:median(values('auto_ms')),representations:[...new Set(rows.map(row=>row.representation))]};
 }));
 const result={measured_at:new Date().toISOString(),platform:process.platform,arch:process.arch,node:process.version,observations:100,warmup:1,p50_ms:sorted[49],p95_ms:sorted[94],full_response_bytes:fullBytes,median_unchanged_delta_bytes:[...bytes].sort((a,b)=>a-b)[49],estimated_byte_reduction:1-bytes[49]!/fullBytes,token_estimator:'UTF-8 JSON bytes / 4 estimate; not a tokenizer ceiling or model billing tokens',scope:'202-element local fixture: 100 unchanged observations plus four change conditions, two budgets, 20 iterations each. Includes all cursor pages; no model, native desktop, real client or human-concurrency measurements.',summary,measurements};
 await mkdir('artifacts',{recursive:true});await writeFile('artifacts/benchmark.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({...result,measurements:undefined},null,2));
}finally{await engine.shutdown();await new Promise<void>(r=>fixture.close(()=>r()));}
