import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

export interface BrowserRuntime {executablePath:string; browsersPath:string; source:'chrome'|'chromium'}
interface CommandOptions {cwd:string;env:NodeJS.ProcessEnv;signal?:AbortSignal;timeoutMs:number}
export interface BrowserOptions {
  extensionRoot:string;nodePath:string;storageDir:string;playwrightVersion:string;
  platform?:NodeJS.Platform;arch?:string;env?:NodeJS.ProcessEnv;signal?:AbortSignal;
  probePaths?:string[];lockTimeoutMs?:number;commandTimeoutMs?:number;
  runCommand?:(args:string[],options:CommandOptions)=>Promise<{stdout:string;stderr:string}>;
}

export function chromeCandidates(platform:string, env:NodeJS.ProcessEnv, home:string):string[] {
  if(platform==='darwin')return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',path.join(home,'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')];
  if(platform==='win32')return [...new Set([env.LOCALAPPDATA,env.PROGRAMFILES,env['PROGRAMFILES(X86)'],env.ProgramFiles,env['ProgramFiles(x86)']].filter((p):p is string=>!!p).map(p=>path.win32.join(p,'Google','Chrome','Application','chrome.exe')))];
  return ['/opt/google/chrome/chrome','/usr/bin/google-chrome-stable','/usr/bin/google-chrome'];
}

// Kill the installer's process tree before allowing its staging directory to be removed.
export function runBrowserCommand(args:string[],options:CommandOptions):Promise<{stdout:string;stderr:string}> {
  options.signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const child=spawn(args[0]!,args.slice(1),{cwd:options.cwd,env:options.env,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',reason:Error|undefined,killing:Promise<void>|undefined;
    const kill=(error:Error)=>{
      if(reason)return;reason=error;
      if(!child.pid)return;
      if(process.platform==='win32'){
        killing=new Promise<void>(done=>{
          const taskkill=path.join(process.env.SystemRoot??'C:\\Windows','System32','taskkill.exe');
          const killer=spawn(taskkill,['/PID',String(child.pid),'/T','/F'],{shell:false,windowsHide:true,stdio:'ignore'});
          killer.once('error',()=>{child.kill('SIGKILL');done();});killer.once('close',()=>{child.kill('SIGKILL');done();});
        });
      }else{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
    };
    const abort=()=>kill(new Error('ブラウザ準備をキャンセルしました / Browser setup cancelled'));
    const timer=setTimeout(()=>kill(new Error('ブラウザ準備がタイムアウトしました / Browser setup timed out')),options.timeoutMs);
    options.signal?.addEventListener('abort',abort,{once:true});
    if(options.signal?.aborted)abort();
    const clean=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);};
    child.stdout.on('data',bytes=>{stdout+=String(bytes);if(stdout.length>2*1024*1024)kill(new Error('Browser setup output limit exceeded'));});
    child.stderr.on('data',bytes=>{stderr+=String(bytes);if(stderr.length>2*1024*1024)kill(new Error('Browser setup output limit exceeded'));});
    child.once('error',error=>{clean();reject(error);});
    child.once('close',async(code,signal)=>{clean();await killing;if(reason)reject(reason);else if(code===0)resolve({stdout,stderr});else reject(new Error(`Browser setup command failed (${code??signal}): ${stderr.slice(-2000)}`));});
  });
}

function safeRelative(value:unknown):value is string {
  return typeof value==='string'&&value.length>0&&!/[\\:\0]/.test(value)&&!path.isAbsolute(value)&&!value.split('/').some(p=>!p||p==='.'||p==='..');
}
async function executable(file:string,repair=false):Promise<string|undefined>{
  try{
    const actual=await fs.realpath(file),st=await fs.stat(actual);
    if(!st.isFile()||st.size===0)return;
    if(repair&&process.platform!=='win32'&&(st.mode&0o111)!==0o111)await fs.chmod(actual,st.mode|0o111);
    if(process.platform!=='win32')await fs.access(actual,1);
    return actual;
  }catch{return;}
}
async function within(root:string,file:string):Promise<boolean>{
  const [base,actual]=await Promise.all([fs.realpath(root),fs.realpath(file)]);
  const rel=path.relative(base,actual);return !!rel&&!rel.startsWith('..')&&!path.isAbsolute(rel);
}
async function cached(cache:string,version:string,target:string,storage:string):Promise<BrowserRuntime|undefined>{
  try{
    if(!await within(storage,cache))return;
    const ready=path.join(cache,'ready.json');
    if(!await within(cache,ready)||(await fs.stat(ready)).size>65536)return;
    const meta=JSON.parse(await fs.readFile(ready,'utf8')) as Record<string,unknown>;
    if(meta.schemaVersion!==1||meta.version!==version||meta.target!==target||!safeRelative(meta.executable))return;
    const file=path.join(cache,meta.executable);
    if(!await within(cache,file))return;
    const actual=await executable(file,true);
    if(actual)return {executablePath:actual,browsersPath:cache,source:'chromium'};
  }catch{ /* An incomplete cache is repaired under the install lock. */ }
}
async function exists(file:string):Promise<boolean>{try{await fs.lstat(file);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
async function lock(file:string,signal:AbortSignal,timeoutMs:number):Promise<()=>Promise<void>>{
  const deadline=Date.now()+timeoutMs,owner=`${process.pid}-${randomUUID()}`;
  for(;;){
    signal.throwIfAborted();
    try{
      const handle=await fs.open(file,'wx',0o600);
      try{await handle.writeFile(owner);}finally{await handle.close();}
      return async()=>{if(await fs.readFile(file,'utf8').catch(()=>'')===owner)await fs.unlink(file).catch(()=>{});};
    }catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    if(Date.now()>=deadline)throw new Error('別のブラウザ準備が完了していません / Browser setup lock timed out');
    await new Promise(resolve=>setTimeout(resolve,50));
  }
}

async function provision(options:BrowserOptions,signal:AbortSignal):Promise<BrowserRuntime>{
  signal.throwIfAborted();
  const platform=options.platform??process.platform,arch=options.arch??process.arch,version=options.playwrightVersion;
  if(!['darwin','win32','linux'].includes(platform)||!['arm64','x64'].includes(arch)||!/^\d+\.\d+\.\d+$/.test(version))throw new Error('Unsupported browser setup target/version');
  if(!path.isAbsolute(options.storageDir)||!path.isAbsolute(options.nodePath)||!path.isAbsolute(options.extensionRoot))throw new Error('Browser setup requires absolute installation paths');
  const target=`${platform}-${arch}`,cache=path.join(options.storageDir,'browsers',`${version}-${target}`);
  const env={...process.env,...options.env};
  for(const candidate of options.probePaths??chromeCandidates(platform,env,os.homedir())){
    signal.throwIfAborted();const chrome=await executable(candidate);
    if(chrome)return {executablePath:chrome,browsersPath:cache,source:'chrome'};
  }
  const ready=await cached(cache,version,target,options.storageDir);if(ready)return ready;
  const parent=path.dirname(cache);await fs.mkdir(parent,{recursive:true,mode:0o700});
  const release=await lock(`${cache}.lock`,signal,options.lockTimeoutMs??300000);
  let stage:string|undefined;
  try{
    signal.throwIfAborted();const current=await cached(cache,version,target,options.storageDir);if(current)return current;
    stage=await fs.mkdtemp(`${cache}.staging-`);
    const childEnv:NodeJS.ProcessEnv={...env,PLAYWRIGHT_BROWSERS_PATH:stage,PLAYWRIGHT_SKIP_BROWSER_GC:'1'};
    delete childEnv.NODE_OPTIONS;delete childEnv.NODE_PATH;
    const command=options.runCommand??runBrowserCommand;
    const commandOptions={cwd:options.extensionRoot,env:childEnv,signal,timeoutMs:options.commandTimeoutMs??300000};
    await command([options.nodePath,path.join(options.extensionRoot,'node_modules/playwright/cli.js'),'install','chromium','--only-shell'],commandOptions);
    signal.throwIfAborted();
    const core=path.join(options.extensionRoot,'node_modules/playwright-core/lib/coreBundle.js');
    const pkg=path.join(options.extensionRoot,'node_modules/playwright-core/package.json');
    const query=`const {registry}=require(${JSON.stringify(core)}).registry;process.stdout.write(JSON.stringify({headlessShell:registry.findExecutable('chromium-headless-shell').executablePath(),playwrightVersion:require(${JSON.stringify(pkg)}).version}));`;
    const answer=await command([options.nodePath,'-e',query],commandOptions);
    const found=JSON.parse(answer.stdout) as {headlessShell?:unknown;playwrightVersion?:unknown};
    if(found.playwrightVersion!==version||typeof found.headlessShell!=='string')throw new Error('Browser installation version/path mismatch');
    const rel=path.relative(stage,found.headlessShell).split(path.sep).join('/');
    if(!safeRelative(rel)||!await within(stage,found.headlessShell)||!await executable(found.headlessShell,true))throw new Error('Browser executable is missing or escapes its cache');
    await fs.rm(path.join(stage,'.links'),{recursive:true,force:true});
    await fs.writeFile(path.join(stage,'ready.json'),JSON.stringify({schemaVersion:1,version,target,executable:rel}),{mode:0o600});
    signal.throwIfAborted();
    const backup=`${cache}.previous-${randomUUID()}`;
    const old=await exists(cache);if(old)await fs.rename(cache,backup);
    try{await fs.rename(stage,cache);stage=undefined;}catch(error){if(old)await fs.rename(backup,cache);throw error;}
    if(old)await fs.rm(backup,{recursive:true,force:true});
    const installed=await cached(cache,version,target,options.storageDir);
    if(!installed)throw new Error('Browser cache validation failed');
    return installed;
  }catch(error){
    if(signal.aborted)throw error;
    throw new Error(`ブラウザを自動準備できませんでした。ネット接続を確認して再試行してください / Automatic browser setup failed: ${error instanceof Error?error.message:String(error)}`);
  }finally{if(stage)await fs.rm(stage,{recursive:true,force:true});await release();}
}

interface Flight {promise:Promise<BrowserRuntime>;controller:AbortController;users:number}
const flights=new Map<string,Flight>();
export function prepareBrowser(options:BrowserOptions):Promise<BrowserRuntime>{
  if(options.signal?.aborted)return Promise.reject(options.signal.reason??new Error('Browser setup cancelled'));
  const key=JSON.stringify([options.extensionRoot,options.nodePath,options.storageDir,options.playwrightVersion,options.platform??process.platform,options.arch??process.arch,options.probePaths??null,options.env??null]);
  let entry=flights.get(key);
  if(!entry){
    const controller=new AbortController();
    entry={controller,users:0,promise:undefined!};
    const owned=entry;
    entry.promise=provision(options,controller.signal).finally(()=>{if(flights.get(key)===owned)flights.delete(key);});
    flights.set(key,entry);
  }
  const flight=entry;flight.users++;
  return new Promise((resolve,reject)=>{
    let settled=false;
    const clean=()=>{flight.users--;options.signal?.removeEventListener('abort',abort);};
    const abort=()=>{
      if(settled)return;settled=true;clean();
      const error=options.signal?.reason??new Error('Browser setup cancelled');
      if(flight.users===0){flight.controller.abort(error);flight.promise.then(()=>reject(error),()=>reject(error));}else reject(error);
    };
    options.signal?.addEventListener('abort',abort,{once:true});
    if(options.signal?.aborted)abort();
    flight.promise.then(value=>{if(!settled){settled=true;clean();resolve(value);}},error=>{if(!settled){settled=true;clean();reject(error);}});
  });
}
