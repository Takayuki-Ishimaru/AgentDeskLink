const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

test('a generated Claude Code registration discovers real MCP tools and bulk disable closes it',async()=>{
 const {AiClientManager}=await import('../../dist/src/extension/client-manager.js');
 const {Client}=await import('@modelcontextprotocol/client');
 const {StdioClientTransport}=await import('@modelcontextprotocol/client/stdio');
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'adl-client-mcp-'));
 const home=path.join(directory,'home');fs.mkdirSync(home);
 const bundledNode=path.resolve('runtime',process.platform==='win32'?'node.exe':'node');
 const node=fs.existsSync(bundledNode)?bundledNode:process.execPath;
 const manager=new AiClientManager({storageDir:path.join(directory,'storage'),owner:'test-workspace',
  detectOptions:{home,platform:process.platform,env:{PATH:''},extensionIds:['anthropic.claude-code']},canEnable:()=>true,
  getLaunch:async()=>({command:node,args:[path.resolve('dist/src/server.js')],env:{ADL_MCP_PERMISSIONS:'{}'},cwd:home})});
 let client;
 try{
  await manager.sync(true,true);assert.equal(manager.error,'');
  const registration=JSON.parse(fs.readFileSync(path.join(home,'.claude.json'),'utf8')).mcpServers.agentdesklink;
  client=new Client({name:'adl-client-registration-test',version:'1.0.0'},{versionNegotiation:{mode:'legacy'}});
  const transport=new StdioClientTransport({...registration,cwd:home,stderr:'pipe'});
  let stderr='';transport.stderr?.on('data',chunk=>{stderr+=chunk;});
  try{await client.connect(transport);}catch(error){throw new Error(`Managed MCP startup failed: ${stderr}`,{cause:error});}
  const {tools}=await client.listTools();assert.equal(tools.length,13);assert.ok(tools.some(t=>t.name==='adl_capabilities'));assert.ok(!tools.some(t=>t.name==='adl_approvals'));
  const targets=await client.callTool({name:'adl_targets',arguments:{}});assert.deepEqual(JSON.parse(targets.content[0].text).targets,[]);
  let timer;const closed=new Promise((resolve,reject)=>{client.onclose=resolve;timer=setTimeout(()=>reject(new Error('managed MCP connection did not close after disable')),3000);});
  try{await manager.sync(false,true);await closed;}finally{clearTimeout(timer);}
  assert.equal(JSON.parse(fs.readFileSync(path.join(home,'.claude.json'),'utf8')).mcpServers.agentdesklink,undefined);
 }finally{await client?.close();manager.dispose();fs.rmSync(directory,{recursive:true,force:true});}
});
