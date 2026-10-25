const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const load=()=>import('../../dist/src/extension/browser-setup.js');
async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'adl-browser-parent-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const extensionRoot=path.join(root,'extension');await fs.mkdir(path.join(extensionRoot,'node_modules/playwright'),{recursive:true});
  await fs.writeFile(path.join(extensionRoot,'node_modules/playwright/cli.js'),'fake');
  const storageDir=path.join(root,'storage');const calls=[];
  const options={extensionRoot,storageDir,nodePath:process.execPath,playwrightVersion:'1.64.1',probePaths:[],runCommand:async(args,opts)=>{
    calls.push({args,opts});
    const cache=opts.env.PLAYWRIGHT_BROWSERS_PATH;
    const exe=path.join(cache,'chromium_headless_shell-1248','chrome-headless-shell');
    if(args.includes('install')){await fs.mkdir(path.dirname(exe),{recursive:true});await fs.writeFile(exe,'browser');await fs.chmod(exe,0o755);}
    return {stdout:JSON.stringify({headlessShell:exe,playwrightVersion:'1.64.1'}),stderr:''};
  }};
  return {root,options,calls};
}
test('installed Chrome skips all installer commands and does not touch its profile',async t=>{
  const {prepareBrowser}=await load();const f=await fixture(t);const chrome=path.join(f.root,'Google Chrome');await fs.writeFile(chrome,'chrome');await fs.chmod(chrome,0o755);
  const profile=path.join(f.root,'Default');await fs.mkdir(profile);await fs.writeFile(path.join(profile,'Cookies'),'do not touch');
  const result=await prepareBrowser({...f.options,probePaths:[chrome]});
  assert.equal(result.source,'chrome');assert.equal(result.executablePath,await fs.realpath(chrome));assert.equal(f.calls.length,0);
  assert.equal(await fs.readFile(path.join(profile,'Cookies'),'utf8'),'do not touch');
});
test('absent Chrome installs with the bundled node and reuses its private cache offline',async t=>{
  const {prepareBrowser}=await load();const f=await fixture(t);const first=await prepareBrowser(f.options);
  assert.equal(first.source,'chromium');assert.ok(first.executablePath.startsWith(await fs.realpath(f.options.storageDir)+path.sep));
  const install=f.calls.find(call=>call.args.includes('install'));assert.equal(install.args[0],process.execPath);assert.ok(install.args.includes('--only-shell'));
  assert.equal(install.opts.env.PLAYWRIGHT_SKIP_BROWSER_GC,'1');
  const second=await prepareBrowser({...f.options,runCommand:async()=>{throw Error('offline');}});
  assert.equal(second.executablePath,first.executablePath);
});
test('failed install cleans up, retries, and concurrent preparation uses one install',async t=>{
  const {prepareBrowser}=await load();const f=await fixture(t);
  await assert.rejects(prepareBrowser({...f.options,runCommand:async()=>{throw Error('offline');}}));
  const [a,b]=await Promise.all([prepareBrowser(f.options),prepareBrowser(f.options)]);
  assert.equal(a.executablePath,b.executablePath);assert.equal(f.calls.filter(call=>call.args.includes('install')).length,1);
});
test('pre-cancelled setup never starts an installer',async t=>{
  const {prepareBrowser}=await load();const f=await fixture(t);const abort=new AbortController();abort.abort();
  await assert.rejects(prepareBrowser({...f.options,signal:abort.signal}));assert.equal(f.calls.length,0);
});
test('Chrome candidates cover supported operating systems without executing a shell',async()=>{
  const {chromeCandidates}=await load();
  assert.ok(chromeCandidates('darwin',{},'/users/example').includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert.ok(chromeCandidates('linux',{},'/home/example').includes('/opt/google/chrome/chrome'));
  assert.deepEqual(chromeCandidates('win32',{LOCALAPPDATA:'C:\\Users\\Example\\AppData\\Local',PROGRAMFILES:'C:\\Program Files'},'C:\\Users\\Example'),[
    'C:\\Users\\Example\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']);
});
test('a missing or corrupt cached executable is repaired',async t=>{
  const {prepareBrowser}=await load();const f=await fixture(t);const first=await prepareBrowser(f.options);
  await fs.writeFile(first.executablePath,'');
  const repaired=await prepareBrowser(f.options);assert.equal(repaired.executablePath,first.executablePath);
  assert.equal(f.calls.filter(call=>call.args.includes('install')).length,2);
});
test('query paths and symlinks cannot escape the private browser cache',async t=>{
  const {prepareBrowser}=await load();const f=await fixture(t);const outside=path.join(f.root,'outside');await fs.writeFile(outside,'untouched');
  for(const symlink of [false,true]){
    await assert.rejects(prepareBrowser({...f.options,runCommand:async(args,opts)=>{
      await f.options.runCommand(args,opts);
      if(args.includes('install'))return {stdout:'',stderr:''};
      let file=outside;
      if(symlink){file=path.join(opts.env.PLAYWRIGHT_BROWSERS_PATH,'evil');await fs.symlink(outside,file);}
      return {stdout:JSON.stringify({headlessShell:file,playwrightVersion:'1.64.1'}),stderr:''};
    }}),/escapes/);
    assert.equal(await fs.readFile(outside,'utf8'),'untouched');
  }
});
test('cancellation stops its installer and removes staging before it rejects',async t=>{
  const {prepareBrowser}=await load();const f=await fixture(t),controller=new AbortController();
  let started;const entered=new Promise(yes=>started=yes);
  const pending=prepareBrowser({...f.options,signal:controller.signal,runCommand:async(args,opts)=>{
    started();await new Promise((_,no)=>opts.signal.addEventListener('abort',()=>no(new Error('cancelled')),{once:true}));return {stdout:'',stderr:''};
  }});
  await entered;controller.abort();await assert.rejects(pending);
  assert.deepEqual(await fs.readdir(path.join(f.options.storageDir,'browsers')),[]);
});
test('one cancelled subscriber cannot cancel another subscriber sharing the installer',async t=>{
  const {prepareBrowser}=await load();const f=await fixture(t),controller=new AbortController();
  const run=async(args,opts)=>{await new Promise(yes=>setTimeout(yes,20));return f.options.runCommand(args,opts);};
  const first=prepareBrowser({...f.options,signal:controller.signal,runCommand:run});
  const second=prepareBrowser({...f.options,runCommand:run});
  controller.abort();await assert.rejects(first);assert.equal((await second).source,'chromium');
  assert.equal(f.calls.filter(call=>call.args.includes('install')).length,1);
});
test('lock contention is bounded and real installer subprocess timeout releases its process',async t=>{
  const {prepareBrowser,runBrowserCommand}=await load();const f=await fixture(t);
  const parent=path.join(f.options.storageDir,'browsers');await fs.mkdir(parent,{recursive:true});
  const lock=path.join(parent,`1.64.1-${process.platform}-${process.arch}.lock`);await fs.writeFile(lock,'another owner');
  await assert.rejects(prepareBrowser({...f.options,lockTimeoutMs:20}),/lock timed out/);
  assert.equal(await fs.readFile(lock,'utf8'),'another owner');assert.equal(f.calls.length,0);
  await assert.rejects(runBrowserCommand([process.execPath,'-e','setInterval(()=>{},1000)'],{cwd:f.root,env:process.env,timeoutMs:40}),/timed out/);
});
