import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile,symlink,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const payload=(result:unknown):any=>JSON.parse((result as {content:{text:string}[]}).content[0]!.text);

test('stdio resolves and initializes auditPath relative to its config, and reports unusable paths at startup',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-audit-startup-'));const client=new Client({name:'audit-startup',version:'1.0.0'},{versionNegotiation:{mode:'legacy'}});
 const entry=resolve('dist/src/server.js');
 try{
  await mkdir(join(dir,'settings'));await mkdir(join(dir,'host'));
  const config=join(dir,'settings','policy.json');await writeFile(config,JSON.stringify({auditPath:'../logs/audit.jsonl'}));
  await client.connect(new StdioClientTransport({command:process.execPath,args:[entry,'--config',config],cwd:join(dir,'host'),stderr:'pipe',env:{CHROME_DEVEL_SANDBOX:process.env.CHROME_DEVEL_SANDBOX??''}}));
  assert.equal(payload(await client.callTool({name:'adl_targets',arguments:{}})).ok,true);
  assert.equal(await readFile(join(dir,'logs','audit.jsonl'),'utf8'),'');
  await client.close();
  await writeFile(join(dir,'blocked'),'ordinary file');
  await writeFile(config,JSON.stringify({auditPath:'../blocked/audit.jsonl'}));
  const failure=await new Promise<{code:number|null;stderr:string;stdout:string}>((done,reject)=>{
   const child=spawn(process.execPath,[entry,'--config',config],{cwd:join(dir,'host'),windowsHide:true,stdio:['ignore','pipe','pipe']});let stderr='',stdout='';
   child.stderr.on('data',chunk=>{stderr+=chunk;});child.stdout.on('data',chunk=>{stdout+=chunk;});child.on('error',reject);child.on('close',code=>done({code,stderr,stdout}));
  });
  assert.equal(failure.code,1);assert.match(failure.stderr,/audit log initialization failed \([A-Z_]+\)/);assert.match(failure.stderr,/auditPath/);assert.equal(failure.stdout,'');
 }finally{await client.close();await rm(dir,{recursive:true,force:true});}
});
const runClient=async(mode:'legacy'|'modern',config?:string)=>{
 const transport=new StdioClientTransport({command:process.execPath,args:['dist/src/server.js',...(config?['--config',config]:[])],cwd:process.cwd(),stderr:'pipe',env:{CHROME_DEVEL_SANDBOX:process.env.CHROME_DEVEL_SANDBOX??''}});
 const client=new Client({name:`adl-${mode}-integration`,version:'1.0.0'},{versionNegotiation:{mode:mode==='legacy'?'legacy':{pin:'2026-07-28'}}});
 await client.connect(transport);transport.stderr?.on('data',()=>{});return {client,transport};
};
for(const mode of ['legacy','modern'] as const)test(`real stdio ${mode}: tool schema, closed policy and safe errors`,async()=>{
 const {client}=await runClient(mode);try{
 const tools=await client.listTools();assert.equal(tools.tools.length,13);assert.equal(new Set(tools.tools.map(t=>t.name)).size,13);
 for(const name of ['adl_prepare_input','adl_commit_input','adl_applications','adl_app'])assert.ok(!tools.tools.some(t=>t.name===name));
 const targets=payload(await client.callTool({name:'adl_targets',arguments:{}}));assert.deepEqual(targets.targets,[]);
 assert.deepEqual(payload(await client.callTool({name:'adl_sessions',arguments:{}})).sessions,[]);
 await assert.rejects(client.callTool({name:'adl_applications',arguments:{}}),/not found/);
 await assert.rejects(client.callTool({name:'adl_app',arguments:{application_id:'com.other.app',action:'launch'}}),/not found/);
 const error=payload(await client.callTool({name:'adl_open',arguments:{target_id:'forged'}}));assert.equal(error.error.code,'E_TARGET_NOT_FOUND');
 const invalid=await client.callTool({name:'adl_act',arguments:{session_id:'s',action:'evaluate',javascript:'CANARY_JS'}});assert.ok(invalid.isError);
 }finally{await client.close();}
});
test('stdio browser workflow, deltas, privacy, audit and cross-process ownership',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-mcp-'));const audit=join(dir,'audit.jsonl');
 const http=createServer((_,r)=>{r.setHeader('content-type','text/html');r.end('<label>Search<input id="q" aria-label="Search"></label><button id="go" type="button" onclick="document.getElementById(\'s\').textContent=\'Done\'">Find</button><p id="s" role="status">Ready</p><input type="password" aria-label="Password" value="CANARY_MCP_PASSWORD"><p>alice@example.com</p><div role="sk-CANARY123456789012345678901234" aria-label="Public">text</div>');});
 await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(http.address() as {port:number}).port}`;
 const file=join(dir,'policy.json');await writeFile(file,JSON.stringify({allowedOrigins:[origin],allowLoopback:true,auditPath:audit,browserTargets:[{id:'fixture',label:'Fixture',url:origin,classification:'PUBLIC',controls:[{selector:'#q',actions:['fill']},{selector:'#go',actions:['click']}]}]}));
 let a:Client|undefined,b:Client|undefined;
 try{
 a=(await runClient('modern',file)).client;b=(await runClient('legacy',file)).client;
 const call=async(name:string,args:Record<string,unknown>)=>payload(await a!.callTool({name,arguments:args}));
 const target=(await call('adl_targets',{})).targets[0];const s=await call('adl_open',{target_id:target.target_id});assert.equal(s.ok,true,JSON.stringify(s));
 const p=await call('adl_observe',{session_id:s.session_id});assert.ok(!JSON.stringify(p).includes('CANARY_MCP_PASSWORD'));assert.ok(!JSON.stringify(p).includes('alice@example.com'));assert.ok(!JSON.stringify(p).includes('sk-CANARY'));assert.ok(p.elements.some((e:any)=>e.name==='[redacted]'));
 const input=p.elements.find((e:any)=>e.name==='Search');const fill=await call('adl_act',{session_id:s.session_id,action:'fill',element_id:input.id,value:'TEST-001',expected_revision:p.revision});assert.equal(fill.ok,true);
 const delta=await call('adl_observe',{session_id:s.session_id,since_revision:p.revision});assert.ok(delta.changes.length>0);
 const wrong=payload(await b.callTool({name:'adl_observe',arguments:{session_id:s.session_id}}));assert.equal(wrong.error.code,'E_TARGET_NOT_FOUND');
 const click=await call('adl_act',{session_id:s.session_id,action:'click',element_id:p.elements.find((e:any)=>e.name==='Find').id,expected_revision:fill.revision});assert.equal(click.ok,true);
 const waited=await call('adl_wait',{session_id:s.session_id,condition:{role:'status',name:'Done'},timeout_ms:2000});assert.equal(waited.ok,true);
 await call('adl_close',{session_id:s.session_id});const log=await readFile(audit,'utf8');assert.ok(!log.includes('TEST-001'));assert.ok(!log.includes('CANARY'));assert.ok(!log.includes(origin));
 }finally{await a?.close();await b?.close();await new Promise<void>(r=>http.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});

test('stdio starts through an absolute symlink or Windows junction entrypoint',async()=>{const dir=await mkdtemp(join(tmpdir(),'adl-entry-'));let client:Client|undefined;try{const entry=join(dir,'entry');await symlink(resolve('dist/src'),entry,process.platform==='win32'?'junction':'dir');client=new Client({name:'adl-symlink-entry',version:'1.0.0'},{versionNegotiation:{mode:'legacy'}});await client.connect(new StdioClientTransport({command:process.execPath,args:[join(entry,'server.js')],cwd:dir,stderr:'pipe',env:{CHROME_DEVEL_SANDBOX:process.env.CHROME_DEVEL_SANDBOX??''}}));const targets=payload(await client.callTool({name:'adl_targets',arguments:{}}));assert.equal(targets.ok,true);assert.deepEqual(targets.targets,[]);}finally{await client?.close();await rm(dir,{recursive:true,force:true})}});
