const {test, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cleanup = [];
afterEach(() => { for (const dispose of cleanup.splice(0).reverse()) dispose(); });

async function fixture(options = {}) {
  const {AiClientManager} = await import('../../dist/src/extension/client-manager.js');
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'adl-manager-'));
  cleanup.push(() => fs.rmSync(directory, {recursive:true,force:true}));
  const home = path.join(directory, 'home'), storageDir = path.join(directory, 'storage');
  fs.mkdirSync(home);
  const configPath = path.join(home, '.claude.json');
  fs.writeFileSync(configPath, JSON.stringify({otherSetting:42,mcpServers:{existing:{command:'keep-me'}}}));
  const launch = {command:process.execPath,args:['-e','process.stdin.resume()'],env:{ADL_MCP_PERMISSIONS:'{}'},cwd:home};
  const opts = {storageDir,owner:'workspace-a',detectOptions:{home,platform:process.platform,env:{PATH:'',APPDATA:home,LOCALAPPDATA:home,XDG_CONFIG_HOME:path.join(home,'.config')},extensionIds:['anthropic.claude-code']},canEnable:()=>true,getLaunch:async()=>launch,...options};
  const manager = new AiClientManager(opts);
  cleanup.push(() => manager.dispose());
  return {manager,opts,directory,home,storageDir,configPath,launch,descriptor:path.join(storageDir,'ai-clients','launch.json'),AiClientManager};
}

test('detection is read-only; bulk enable and disable preserve existing settings and use stable absolute launch paths', async () => {
  const f = await fixture();
  assert.equal(fs.existsSync(f.storageDir),false);
  assert.equal(f.manager.rows().find(c=>c.id==='claude-code').status,'disabled');
  await f.manager.sync(true,true);
  assert.equal(f.manager.error,'');
  const configured = JSON.parse(fs.readFileSync(f.configPath,'utf8'));
  assert.equal(configured.otherSetting,42);
  assert.equal(configured.mcpServers.existing.command,'keep-me');
  const registered = configured.mcpServers.agentdesklink;
  assert.ok(path.isAbsolute(registered.command));
  assert.ok(registered.args.every(arg=>path.isAbsolute(arg)));
  assert.equal(JSON.parse(fs.readFileSync(f.descriptor,'utf8')).owner,'workspace-a');
  assert.equal(f.manager.rows().find(c=>c.id==='claude-code').status,'enabled');
  await f.manager.sync(false,true);
  assert.equal(JSON.parse(fs.readFileSync(f.descriptor,'utf8')).enabled,false);
  const disabled = JSON.parse(fs.readFileSync(f.configPath,'utf8'));
  assert.equal(disabled.mcpServers.agentdesklink,undefined);
  assert.equal(disabled.mcpServers.existing.command,'keep-me');
});

test('disable cancels an enable waiting for browser/runtime preparation', async () => {
  let finish;
  const prepared = new Promise(resolve => {finish=resolve;});
  const f = await fixture({getLaunch:()=>prepared});
  const enabling = f.manager.sync(true,true);
  await new Promise(resolve => setImmediate(resolve));
  const disabling = f.manager.sync(false,true);
  finish(f.launch);
  await Promise.all([enabling,disabling]);
  assert.equal(JSON.parse(fs.readFileSync(f.descriptor,'utf8')).enabled,false);
  assert.equal(JSON.parse(fs.readFileSync(f.configPath,'utf8')).mcpServers.agentdesklink,undefined);
});

test('revocation is immediate before failed config cleanup and permission refresh', async () => {
  let blocked = false;
  let finish;
  const pending = new Promise(resolve => {finish=resolve;});
  const f = await fixture({getLaunch:()=>blocked?pending:Promise.resolve(f.launch)});
  await f.manager.sync(true,true);
  const before = JSON.parse(fs.readFileSync(f.descriptor,'utf8'));
  blocked = true;
  const refreshing = f.manager.sync(true);
  const revoked = JSON.parse(fs.readFileSync(f.descriptor,'utf8'));
  assert.equal(revoked.enabled,false);
  assert.notEqual(before.generation,revoked.generation);
  finish({...f.launch,env:{ADL_MCP_PERMISSIONS:'{"allowAllOperations":false}'}});
  await refreshing;
  const current = JSON.parse(fs.readFileSync(f.descriptor,'utf8'));
  assert.equal(current.enabled,true);
  assert.equal(current.env.ADL_MCP_PERMISSIONS,'{"allowAllOperations":false}');
});

test('other windows cannot silently take over or disable the active workspace', async () => {
  const f = await fixture();
  await f.manager.sync(true,true);
  const other = new f.AiClientManager({...f.opts,owner:'workspace-b'});
  cleanup.push(()=>other.dispose());
  await other.sync(true);
  assert.match(other.error,/他のワークスペース/);
  assert.equal(JSON.parse(fs.readFileSync(f.descriptor,'utf8')).owner,'workspace-a');
  await other.sync(true,true);
  assert.equal(JSON.parse(fs.readFileSync(f.descriptor,'utf8')).owner,'workspace-b');
  await f.manager.sync(false);
  assert.equal(JSON.parse(fs.readFileSync(f.descriptor,'utf8')).enabled,true);
  assert.ok(JSON.parse(fs.readFileSync(f.configPath,'utf8')).mcpServers.agentdesklink);
  await f.manager.sync(false,true);
  assert.equal(JSON.parse(fs.readFileSync(f.descriptor,'utf8')).enabled,false);
  assert.equal(JSON.parse(fs.readFileSync(f.configPath,'utf8')).mcpServers.agentdesklink,undefined);
});

test('trust loss and disposal prevent publication after asynchronous preparation', async () => {
  for (const dispose of [false,true]) {
    let allowed=true,finish;
    const f=await fixture({canEnable:()=>allowed,getLaunch:()=>new Promise(resolve=>{finish=resolve;})});
    const pending=f.manager.sync(true,true);
    await new Promise(resolve=>setImmediate(resolve));
    if(dispose) f.manager.dispose(); else allowed=false;
    finish(f.launch);
    await pending;
    assert.equal(JSON.parse(fs.readFileSync(f.descriptor,'utf8')).enabled,false);
  }
});

test('one malformed client does not prevent other clients registering, or revocation on disable', async () => {
  const f=await fixture();
  const cursor=path.join(f.home,'.cursor');fs.mkdirSync(cursor);
  fs.writeFileSync(path.join(cursor,'mcp.json'),'{broken');
  await f.manager.sync(true,true);
  assert.equal(f.manager.rows().find(c=>c.id==='cursor').status,'error');
  assert.equal(f.manager.rows().find(c=>c.id==='claude-code').status,'enabled');
  await f.manager.sync(false,true);
  assert.equal(JSON.parse(fs.readFileSync(f.descriptor,'utf8')).enabled,false);
  assert.equal(fs.readFileSync(path.join(cursor,'mcp.json'),'utf8'),'{broken');
});

test('a later explicit action in another window wins over an older slow enable',async()=>{
 let finish;
 const f=await fixture({getLaunch:()=>new Promise(resolve=>{finish=resolve;})});
 const pending=f.manager.sync(true,true);await new Promise(resolve=>setImmediate(resolve));
 const other=new f.AiClientManager({...f.opts,owner:'workspace-b',getLaunch:async()=>f.launch});cleanup.push(()=>other.dispose());
 await other.sync(true,true);
 finish(f.launch);await pending;
 assert.equal(JSON.parse(fs.readFileSync(f.descriptor,'utf8')).owner,'workspace-b');
 assert.equal(JSON.parse(fs.readFileSync(f.descriptor,'utf8')).enabled,true);
});
