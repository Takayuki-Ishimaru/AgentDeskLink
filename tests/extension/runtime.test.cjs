const {test,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const load=()=>import('../../dist/src/extension/runtime.js');
const dirs=[];
afterEach(()=>{for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
const base={schemaVersion:2,target:'linux-x64',nodeVersion:'v24.22.1',playwrightVersion:'1.64.1',node:'node',browserMode:'auto',helper:null};
function fixture(manifest=base){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'adl-runtime-'));dirs.push(root);
  const rt=path.join(root,'runtime');fs.mkdirSync(rt);
  for(const rel of [manifest.node,manifest.helper]){
    if(typeof rel!=='string'||!rel||path.isAbsolute(rel)||/[\\:\0]/.test(rel)||rel.split('/').some(s=>!s||s==='.'||s==='..'))continue;
    const file=path.join(rt,rel);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'executable');fs.chmodSync(file,0o755);
  }
  fs.writeFileSync(path.join(rt,'manifest.json'),JSON.stringify(manifest));
  return {root,rt,options:{extensionRoot:root,platform:manifest.target.split('-')[0],arch:manifest.target.split('-')[1]}};
}
test('minimal bundle resolves without browsers; setup uses only local filesystem',async()=>{
  const {resolveRuntime}=await load();const f=fixture();
  const original=globalThis.fetch;let requests=0;globalThis.fetch=()=>{requests++;throw Error('offline');};
  try{
    const result=await resolveRuntime(f.options);assert.equal(result.nodePath,path.join(f.rt,'node'));assert.equal(result.helperPath,null);
    assert.equal(result.manifest.browserMode,'auto');assert.ok(!fs.existsSync(path.join(f.rt,'browsers')));assert.equal(requests,0);
  }finally{globalThis.fetch=original;}
});
test('OS-specific helper and Node names resolve; missing helper is rejected',async()=>{
  const {resolveRuntime}=await load();
  for(const [target,node,helper] of [['darwin-arm64','node','helper/adl-macos-ax-helper'],['win32-x64','node.exe','helper/adl-windows-uia-helper.exe']]){
    const f=fixture({...base,target,node,helper});const result=await resolveRuntime(f.options);
    assert.equal(result.helperPath,path.join(f.rt,helper));assert.equal(result.env.ADL_BUNDLED_HELPER_PATH,result.helperPath);
    fs.unlinkSync(result.helperPath);await assert.rejects(resolveRuntime(f.options),/missing/);
  }
});
test('manifest rejects unsupported hosts, schema, versions, browser modes and mismatched targets',async()=>{
  const {resolveRuntime}=await load();
  for(const patch of [{schemaVersion:1},{nodeVersion:'v23.0.0'},{nodeVersion:'24.0.0'},{browserMode:'download-all'},{target:'freebsd-x64'},{target:'linux-ia32'},{helper:'helper/evil'}]){
    const f=fixture({...base,...patch});await assert.rejects(resolveRuntime(f.options),/Bundled runtime/);
  }
  const f=fixture();await assert.rejects(resolveRuntime({...f.options,platform:'darwin'}),/target mismatch/);
  fs.writeFileSync(path.join(f.rt,'manifest.json'),'{');await assert.rejects(resolveRuntime(f.options),/valid JSON/);
});
test('invalid paths never escape the bundle, empty files and directories fail closed',async()=>{
  const {resolveRuntime}=await load();
  for(const node of ['','../node','a/../node','a//node','/etc/node','C:\\evil','a\\node']){
    const f=fixture({...base,node});await assert.rejects(resolveRuntime(f.options),/Bundled runtime/);
  }
  const f=fixture();fs.writeFileSync(path.join(f.rt,'node'),'');await assert.rejects(resolveRuntime(f.options),/empty/);
  fs.unlinkSync(path.join(f.rt,'node'));fs.mkdirSync(path.join(f.rt,'node'));await assert.rejects(resolveRuntime(f.options),/regular file/);
});
test('symlink escapes are rejected',async t=>{
  const {resolveRuntime}=await load();const f=fixture(),outside=fixture();
  fs.unlinkSync(path.join(f.rt,'node'));
  try{fs.symlinkSync(path.join(outside.rt,'node'),path.join(f.rt,'node'));}catch(error){if(error.code==='EPERM'&&process.platform==='win32'){t.skip('File symlinks require Windows developer mode');return;}throw error;}
  await assert.rejects(resolveRuntime(f.options),/missing|escapes/);
  fs.unlinkSync(path.join(f.rt,'manifest.json'));fs.symlinkSync(path.join(outside.rt,'manifest.json'),path.join(f.rt,'manifest.json'));
  await assert.rejects(resolveRuntime(f.options),/escapes/);
});
test('mode repair, concurrent resolutions, and retry after repair',async()=>{
  const {resolveRuntime}=await load();const f=fixture();fs.chmodSync(path.join(f.rt,'node'),0o644);
  const a=resolveRuntime(f.options),b=resolveRuntime(f.options);assert.equal(a,b);const result=await a;
  if(process.platform!=='win32')assert.ok(fs.statSync(result.nodePath).mode&0o100);
  fs.unlinkSync(result.nodePath);await assert.rejects(resolveRuntime(f.options),/missing/);
  fs.writeFileSync(result.nodePath,'fixed');await resolveRuntime(f.options);
});
