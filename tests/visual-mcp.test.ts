import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
for(const mode of ['legacy','modern'] as const)test(`stdio ${mode} transmits PNG image content with metadata and no text base64 duplication`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'adl-visual-'));const audit=join(dir,'audit.jsonl');
 const http=createServer((_,r)=>{r.setHeader('content-type','text/html');r.end('<body style="margin:0;background:#ff0000"><canvas width="100" height="100" id="art"></canvas><script>const c=document.getElementById("art").getContext("2d");c.fillStyle="#0000ff";c.fillRect(0,0,100,100)</script>');});
 await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(http.address() as {port:number}).port}`;
 const config=join(dir,'policy.json');await writeFile(config,JSON.stringify({allowedOrigins:[origin],allowLoopback:true,auditPath:audit,browserTargets:[{id:'fixture',label:'Visual fixture',url:origin,classification:'PUBLIC',visual:{enabled:true}}]}));
 const client=new Client({name:'visual-integration',version:'1.0.0'},{versionNegotiation:{mode:mode==='legacy'?'legacy':{pin:'2026-07-28'}}});
 try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:['dist/src/server.js','--config',config],cwd:process.cwd(),stderr:'pipe',env:{CHROME_DEVEL_SANDBOX:process.env.CHROME_DEVEL_SANDBOX??''}}));
  const call=async(name:string,args:Record<string,unknown>={})=>client.callTool({name,arguments:args});
  const text=(r:any)=>JSON.parse(r.content[0].text);
  const targets=text(await call('adl_targets'));const session=text(await call('adl_open',{target_id:targets.targets[0].target_id}));
  const raw:any=await call('adl_capture',{session_id:session.session_id,max_dimension:2048});assert.ok(!raw.isError);assert.equal(raw.content.length,2);assert.equal(raw.content[0].type,'text');assert.equal(raw.content[1].type,'image');assert.equal(raw.content[1].mimeType,'image/png');
  const metadata=text(raw);assert.ok(metadata.frame_id);assert.ok(!raw.content[0].text.includes('base64'));assert.ok(!raw.content[0].text.includes(raw.content[1].data));
  const png=Buffer.from(raw.content[1].data,'base64');assert.equal((await sharp(png).metadata()).width,metadata.output.width);
  const crop:any=await call('adl_capture',{session_id:session.session_id,frame_id:metadata.frame_id,region:{x:0,y:0,width:80,height:80}});assert.equal(text(crop).frame_id,metadata.frame_id);
  const {data}=await sharp(Buffer.from(crop.content[1].data,'base64')).removeAlpha().raw().toBuffer({resolveWithObject:true});assert.deepEqual([...data.subarray(0,3)],[0,0,255]);
  const invalid:any=await call('adl_capture',{session_id:session.session_id,region:{x:0,y:0,width:10,height:10}});assert.ok(invalid.isError);assert.ok(invalid.content.every((c:any)=>c.type!=='image'));
  await call('adl_close',{session_id:session.session_id});const missing:any=await call('adl_capture',{session_id:session.session_id,frame_id:metadata.frame_id});assert.ok(missing.isError);assert.equal(text(missing).error.code,'E_TARGET_NOT_FOUND');
  const log=await readFile(audit,'utf8');assert.ok(log.includes('capture'));assert.ok(!log.includes(origin));assert.ok(!log.includes(raw.content[1].data));assert.ok(!log.includes('iVBOR'));
 }finally{await client.close();await new Promise<void>(r=>http.close(()=>r()));await rm(dir,{recursive:true,force:true});}
});
