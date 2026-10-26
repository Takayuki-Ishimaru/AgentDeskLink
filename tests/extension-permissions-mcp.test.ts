import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {initializeOperationState,readOperationState,writeOperationState} from '../src/operation-control.js';
const payload=(result:unknown):any=>JSON.parse((result as {content:{text:string}[]}).content[0]!.text);

test('real stdio legacy blanket flag and malformed permissions grant no target access',{timeout:15000},async()=>{
  for(const permissions of ['', '{', JSON.stringify({allowAllOperations:true,browserOrigins:['https://example.com/path']})]){
    const client=new Client({name:'default-deny-test',version:'1'},{versionNegotiation:{mode:'legacy'}});
    const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined&&!entry[0].startsWith('ADL_')));
    const transport=new StdioClientTransport({command:process.execPath,args:['dist/src/server.js'],cwd:process.cwd(),stderr:'pipe',env:{...env,ADL_ALLOW_ALL_OPERATIONS:'1',ADL_MCP_PERMISSIONS:permissions,ADL_BUNDLED_HELPER_PATH:''}});
    try{
      await client.connect(transport);transport.stderr?.on('data',()=>{});
      const call=async(name:string,args:Record<string,unknown>={})=>payload(await client.callTool({name,arguments:args}));
      assert.equal((await call('adl_capabilities')).permissions.all_operations,false);
      assert.deepEqual((await call('adl_targets')).targets,[]);
      assert.equal((await call('adl_open',{url:'https://example.com/'})).error.code,'E_POLICY_DENIED');
    }finally{await client.close();}
  }
});

test('extension stdio permits explicitly granted origins, controls and POST; file stop interrupts batch and wait',{timeout:20000},async()=>{
  let posts=0;
  const second=createServer((_,r)=>{r.setHeader('content-type','text/html');r.end('<p>Other origin</p>');});
  await new Promise<void>(r=>second.listen(0,'127.0.0.1',r));
  const other=`http://127.0.0.1:${(second.address() as {port:number}).port}`;
  const http=createServer((q,r)=>{
    if(q.method==='POST'){posts++;r.setHeader('content-type','text/html');r.end(`<p>Submitted</p><a href="${other}/">Other site</a>`);return;}
    r.setHeader('content-type','text/html');r.end('<form method="post"><input type="password" aria-label="Password"><input aria-label="Email"><button>Submit</button></form>');
  });
  await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(http.address() as {port:number}).port}`;
  const dir=await mkdtemp(join(tmpdir(),'adl-stdio-stop-')),file=join(dir,'operations.json');initializeOperationState(file);
  const clients:Client[]=[];
  const connect=async()=>{
    const client=new Client({name:'extension-control-test',version:'1'},{versionNegotiation:{mode:'legacy'}});
    const transport=new StdioClientTransport({command:process.execPath,args:['dist/src/server.js'],cwd:process.cwd(),stderr:'pipe',env:{...Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined)),ADL_MCP_PERMISSIONS:JSON.stringify({browserOrigins:[origin,other],allowLoopback:true,allowAllOperations:true}),ADL_ALLOW_ALL_OPERATIONS:'',ADL_OPERATION_CONTROL:file,ADL_OPERATION_EPOCH:readOperationState(file)!.epoch,ADL_BUNDLED_HELPER_PATH:''}});
    await client.connect(transport);transport.stderr?.on('data',()=>{});clients.push(client);return client;
  };
  try{
    const a=await connect();const call=async(name:string,args:Record<string,unknown>={})=>payload(await a.callTool({name,arguments:args}));
    const cap=await call('adl_capabilities');assert.equal(cap.permissions.all_operations,true);
    assert.equal(cap.permissions.restricted_targets,true);assert.equal((await call('adl_open',{url:'http://127.0.0.1:1/'})).error.code,'E_POLICY_DENIED');
    const opened=await call('adl_open',{url:origin});assert.equal(opened.ok,true,JSON.stringify(opened));
    const session=opened.session_id;
    let state=await call('adl_observe',{session_id:session});
    const password=state.elements.find((e:any)=>e.role==='textbox'&&e.name==='[redacted]');assert.ok(password);
    let result=await call('adl_act',{session_id:session,expected_revision:state.revision,action:'fill',element_id:password.id,value:'example-pass',expected_target:{role:'textbox',name:'[redacted]'}});assert.equal(result.ok,true,JSON.stringify(result));
    state=await call('adl_observe',{session_id:session});
    const email=state.elements.find((e:any)=>e.role==='textbox'&&e.id!==password.id);assert.ok(email);
    result=await call('adl_act',{session_id:session,expected_revision:state.revision,action:'fill',element_id:email.id,value:'user@example.com'});assert.equal(result.ok,true,JSON.stringify(result));
    state=await call('adl_observe',{session_id:session});
    const submit=state.elements.find((e:any)=>e.role==='button');
    result=await call('adl_act',{session_id:session,expected_revision:state.revision,action:'click',element_id:submit.id});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(posts,1);
    state=await call('adl_observe',{session_id:session});
    const link=state.elements.find((e:any)=>e.role==='link');assert.ok(link);
    result=await call('adl_act',{session_id:session,expected_revision:state.revision,action:'click',element_id:link.id});assert.equal(result.ok,true,JSON.stringify(result));
    state=await call('adl_observe',{session_id:session});assert.ok(state.elements.some((e:any)=>e.name==='Other origin'));
    const independent=await call('adl_open',{url:origin});assert.equal(independent.ok,true);
    const waitingTask=await call('adl_execute',{steps:[{session_id:independent.session_id,action:'wait_for',name:'never',timeout_ms:10000}],expected_revisions:{[independent.session_id]:independent.revision}});
    let background;
    for(let i=0;i<100;i++){background=await call('adl_task',{task_id:waitingTask.task_id});if(background.status==='running')break;await delay(10);}
    assert.equal(background.status,'running');
    try{
      const observed=await Promise.race([call('adl_observe',{session_id:session}),delay(1000).then(()=>null)]);
      assert.ok(observed?.ok,'a different MCP session was held behind the pending wait');
    }finally{await call('adl_task',{task_id:waitingTask.task_id,command:'cancel'});}
    for(let i=0;i<100;i++){background=await call('adl_task',{task_id:waitingTask.task_id});if(background.status==='cancelled')break;await delay(10);}
    assert.equal(background.status,'cancelled');
    const batch=await call('adl_execute',{steps:[{session_id:session,action:'wait_for',name:'never',timeout_ms:30000},{session_id:session,action:'navigate',url:origin}],expected_revisions:{[session]:state.revision}});assert.equal(batch.ok,true);
    await delay(60);writeOperationState(file,true);
    let task;for(let i=0;i<100;i++){task=await call('adl_task',{task_id:batch.task_id});if(task.status==='cancelled')break;await delay(10);}
    assert.equal(task.status,'cancelled');assert.equal(task.results[1].status,'not_executed');assert.equal(posts,1);
    const denied=await call('adl_open',{url:origin});assert.equal(denied.error.code,'E_CANCELLED');
    writeOperationState(file,false);
    assert.equal((await call('adl_open',{url:origin})).error.code,'E_CANCELLED','old process remains revoked');
    const b=await connect(),bcall=async(name:string,args:Record<string,unknown>)=>payload(await b.callTool({name,arguments:args}));
    const next=await bcall('adl_open',{url:other});assert.equal(next.ok,true);
    const pending=bcall('adl_wait',{session_id:next.session_id,condition:{name:'never'},timeout_ms:30000});
    await delay(50);const stoppedAt=Date.now();writeOperationState(file,true);
    assert.equal((await pending).error.code,'E_CANCELLED');assert.ok(Date.now()-stoppedAt<2000);
  }finally{
    await Promise.allSettled(clients.map(c=>c.close()));
    await Promise.all([new Promise<void>(r=>http.close(()=>r())),new Promise<void>(r=>second.close(()=>r()))]);
    await rm(dir,{recursive:true,force:true});
  }
});
