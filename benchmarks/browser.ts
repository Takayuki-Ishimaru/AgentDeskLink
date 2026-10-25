import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {BrowserAdapter} from '../src/browser.js';
import {Engine} from '../src/core.js';
import {parsePolicy,assertUrlAllowed} from '../src/policy.js';
const fixture=createServer((_,r)=>{r.setHeader('content-type','text/html');r.end(`<label>Search<input id="q" aria-label="Search"></label><button id="find" type="button">Find</button>${Array.from({length:200},(_,i)=>`<p role="status">Row ${i} ready</p>`).join('')}`);});
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
 const result={measured_at:new Date().toISOString(),platform:process.platform,arch:process.arch,node:process.version,observations:100,warmup:1,p50_ms:sorted[49],p95_ms:sorted[94],full_response_bytes:fullBytes,median_unchanged_delta_bytes:[...bytes].sort((a,b)=>a-b)[49],estimated_byte_reduction:1-bytes[49]!/fullBytes,token_estimator:'ceil(UTF-8 bytes / 4), not model billing tokens',scope:'Local static 202-element fixture; unchanged deltas. No Windows or real client measurements.'};
 await mkdir('artifacts',{recursive:true});await writeFile('artifacts/benchmark.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{await engine.shutdown();await new Promise<void>(r=>fixture.close(()=>r()));}
