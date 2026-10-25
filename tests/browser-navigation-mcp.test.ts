import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

async function runNavigation(action:'click'|'navigate') {
  const root=process.cwd();
  const dir=await mkdtemp(join(tmpdir(),'adl-link-regression-'));
  const http=createServer((request,response)=>{
    response.setHeader('content-type','text/html');
    response.end(request.url==='/next'
      ? '<h1>Navigation complete</h1><input id="destination" aria-label="Destination input">'
      : '<a id="next" href="/next">Next page</a>');
  });
  const client=new Client({name:'adl-link-regression',version:'1.0.0'},
    {versionNegotiation:{mode:'legacy'}});
  try {
    await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
    const origin=`http://127.0.0.1:${(http.address() as {port:number}).port}`;
    const config=join(dir,'policy.json');
    await writeFile(config,JSON.stringify({allowedOrigins:[origin],allowLoopback:true,
      browserTargets:[{id:'fixture',label:'Navigation fixture',url:origin,classification:'PUBLIC',
        controls:[{selector:'#next',actions:['click']},{selector:'#destination',actions:['fill']}]}]}));
    await client.connect(new StdioClientTransport({command:process.execPath,
      args:[resolve(root,'dist/src/server.js'),'--config',config],cwd:root,stderr:'pipe'}));
    const call=async(name:string,args:Record<string,unknown>={})=>{
      const result=await client.callTool({name,arguments:args});
      return JSON.parse((result.content as {type:string;text?:string}[]).find(block=>block.type==='text')!.text!) as any;
    };
    const targets=await call('adl_targets');
    const session=await call('adl_open',{target_id:targets.targets[0].target_id});
    assert.equal(session.ok,true,JSON.stringify(session));
    const snapshot=await call('adl_observe',{session_id:session.session_id});
    assert.equal(snapshot.ok,true,JSON.stringify(snapshot));
    const oldLink=snapshot.elements.find((e:any)=>e.name==='Next page');
    const request=action==='click'
      ? {action,element_id:oldLink.id,expected_target:{role:'link',name:'Next page'}}
      : {action,url:`${origin}/next`};
    const result=await call('adl_act',{session_id:session.session_id,expected_revision:snapshot.revision,...request});
    const after=await call('adl_observe',{session_id:session.session_id});
    assert.equal(result.ok,true,JSON.stringify({result,after}));
    assert.equal(after.ok,true,JSON.stringify(after));
    assert.ok(after.elements.some((e:any)=>e.role==='heading'&&e.name==='Navigation complete'));
    assert.ok(after.revision>snapshot.revision);
    const stale=await call('adl_act',{session_id:session.session_id,expected_revision:after.revision,
      action:'click',element_id:oldLink.id});
    assert.equal(stale.ok,false);
    const current=await call('adl_observe',{session_id:session.session_id});
    assert.equal(current.ok,true,JSON.stringify(current));
    const filled=await call('adl_act',{session_id:session.session_id,expected_revision:current.revision,
      action:'fill',element_id:current.elements.find((e:any)=>e.name==='Destination input').id,value:'usable after navigation'});
    assert.equal(filled.ok,true,JSON.stringify(filled));
    const final=await call('adl_observe',{session_id:session.session_id});
    assert.equal(final.elements.find((e:any)=>e.name==='Destination input').value,'usable after navigation');
  } finally {
    try {await client.close();}
    finally {
      await new Promise<void>(resolve=>http.close(()=>resolve()));
      await rm(dir,{recursive:true,force:true});
    }
  }
}

test('MCP same-origin link navigation preserves a usable session',{timeout:15000},()=>runNavigation('click'));
test('MCP explicit navigation still preserves a usable session',{timeout:15000},()=>runNavigation('navigate'));
