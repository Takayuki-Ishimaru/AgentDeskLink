// Acceptance against the archive: no system Node, npm, or shared browser cache.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, mkdir, readFile, rm, chmod} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve, relative, isAbsolute} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const require = createRequire(import.meta.url);
const yauzl = createRequire(require.resolve('@vscode/vsce'))('yauzl');
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const vsix = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? join(root, 'artifacts', process.argv.includes('--universal')?`${pkg.name}-${pkg.version}.vsix`:`${pkg.name}-${process.platform}-${process.arch}-${pkg.version}.vsix`));
const forceBrowserDownload = process.argv.includes('--download-browser');
const temp = await mkdtemp(join(tmpdir(), 'adl-vsix-cold-'));

async function extract() {
  const zip = await new Promise((accept, reject) => yauzl.open(vsix, {lazyEntries:true}, (error, value) => error ? reject(error) : accept(value)));
  await new Promise((accept, reject) => {
    zip.on('error', reject);
    zip.on('end', accept);
    zip.on('entry', entry => {
      (async () => {
        const path = resolve(temp, entry.fileName);
        const rel = relative(temp, path);
        assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel));
        if (entry.fileName.endsWith('/')) await mkdir(path, {recursive:true});
        else {
          // VSCE follows source symlinks and packages regular files.
          const mode = entry.externalFileAttributes >>> 16;
          assert.notEqual(mode & 0o170000, 0o120000, `Unexpected archive symlink: ${entry.fileName}`);
          await mkdir(dirname(path), {recursive:true});
          const stream = await new Promise((yes, no) => zip.openReadStream(entry, (error, value) => error ? no(error) : yes(value)));
          await pipeline(stream, createWriteStream(path));
          if (process.platform !== 'win32' && mode) await chmod(path, mode & 0o777);
        }
        zip.readEntry();
      })().catch(error => { zip.close(); reject(error); });
    });
    zip.readEntry();
  });
}

async function run(command, args, env, expectedCode = 0) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {env, cwd:temp, windowsHide:true, stdio:['ignore','pipe','pipe']});
    const output = [];
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Bundled executable timed out')); }, 30000);
    child.stdout.on('data', bytes => output.push(bytes));
    child.stderr.on('data', bytes => output.push(bytes));
    child.on('error', error => {clearTimeout(timer); reject(error);});
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const text = Buffer.concat(output).toString();
      if (code !== expectedCode || signal) reject(new Error(`Bundled executable failed (${code}/${signal}): ${text}`));
      else accept(text.trim());
    });
  });
}

let client, http;
try {
  await extract();
  const extension = join(temp, 'extension');
  // Consume the archive the way the extension does: the bundled resolver selects the host child
  // of a schema 3 universal bundle, or validates a schema 2 component bundle directly.
  const {resolveRuntime} = await import(pathToFileURL(join(extension, 'dist/src/extension/runtime.js')).href);
  const resolved = await resolveRuntime({extensionRoot: extension});
  const runtime = resolved.runtimeDir;
  const manifest = resolved.manifest;
  assert.equal(manifest.target, `${process.platform}-${process.arch}`);
  const home = join(temp, 'empty-home');
  await mkdir(home);
  const env = {
    ...process.env, PATH:'', HOME:home,
    // Windows Chrome resolves OS profile folders through USERPROFILE. Keep that
    // valid; Playwright still creates a separate temporary browser profile.
    ...(process.platform === 'win32' ? {} : {USERPROFILE:home, LOCALAPPDATA:home}),
    XDG_CACHE_HOME:join(home, 'cache'),
    PLAYWRIGHT_BROWSERS_PATH:join(runtime, 'browsers'), PLAYWRIGHT_SKIP_BROWSER_GC:'1',
    ...resolved.env,
  };
  delete env.NODE_PATH;
  delete env.NODE_OPTIONS;
  const node = resolved.nodePath;
  const version = await run(node, ['--version'], env);
  assert.equal(version, manifest.nodeVersion);
  if (manifest.helper) await run(resolved.helperPath, [], env, 2);
  const {prepareBrowser} = await import(pathToFileURL(join(extension,'dist/src/extension/browser-setup.js')).href);
  const browserOptions = {extensionRoot:extension,nodePath:node,storageDir:join(temp,'browser-storage'),playwrightVersion:manifest.playwrightVersion,
    ...(forceBrowserDownload ? {probePaths:[]} : {})};
  const browser = await prepareBrowser(browserOptions);
  env.PLAYWRIGHT_BROWSERS_PATH = browser.browsersPath;
  env.ADL_BROWSER_EXECUTABLE = browser.executablePath;
  if (browser.source === 'chromium') {
    const reused = await prepareBrowser({...browserOptions,probePaths:[],runCommand:async()=>{throw new Error('Cache reuse must be offline');}});
    assert.equal(reused.executablePath,browser.executablePath);
  }

  http = createServer((_, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<label>Search<input id="q" aria-label="Search"></label><p role="status">Bundle ready</p><button type="button" onclick="document.querySelector(\'p\').textContent=\'Submitted\'">Submit</button>');
  });
  await new Promise(accept => http.listen(0, '127.0.0.1', accept));
  const origin = `http://127.0.0.1:${http.address().port}`;
  const policy = {
    allowLoopback:true, allowedOrigins:[origin], actionTimeoutMs:30_000,
    browserTargets:[{id:'bundle',label:'Bundled browser',url:origin,classification:'PUBLIC',visual:{enabled:true},controls:[{selector:'#q',actions:['fill']}]}],
    ...(manifest.helper ? {[process.platform === 'darwin' ? 'macos' : 'windows']:{appId:'local.agentdesklink.package-probe', appPath:node, classification:'PUBLIC', lifecycle:{enabled:true}}} : {}),
  };
  const {writeFile} = await import('node:fs/promises');
  const policyPath = join(temp, 'policy.json');
  await writeFile(policyPath, JSON.stringify(policy));
  client = new Client({name:'vsix-cold-start',version:'1'},{versionNegotiation:{mode:'legacy'}});
  const transport = new StdioClientTransport({command:node,args:[join(extension,'dist/src/server.js'),'--config',policyPath],env,cwd:home,stderr:'pipe'});
  const errors = [];
  transport.stderr?.on('data', value => errors.push(value.toString()));
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, pkg.version);
  const call = async (name, args = {}) => {
    const raw = await client.callTool({name,arguments:args},{},{timeout:45000});
    const result = JSON.parse(raw.content.find(item => item.type === 'text').text);
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)} ${errors.join('')}`);
    return {raw,result};
  };
  const toolNames=(await client.listTools()).tools.map(tool=>tool.name).sort();
  const expectedTools=['adl_capabilities','adl_targets','adl_sessions','adl_open','adl_observe','adl_capture','adl_record','adl_gesture','adl_act','adl_execute','adl_wait','adl_task','adl_close',...(manifest.helper?['adl_applications','adl_app']:[])].sort();
  assert.deepEqual(toolNames,expectedTools,'register only tools supported by this host and policy');
  assert.equal((await call('adl_capabilities')).result.version, pkg.version);
  if (manifest.helper) assert.equal((await call('adl_applications')).result.applications[0].application_id, 'local.agentdesklink.package-probe');
  const target = (await call('adl_targets',{surface:'browser'})).result.targets[0];
  const session = (await call('adl_open',{target_id:target.target_id})).result;
  const observed = (await call('adl_observe',{session_id:session.session_id})).result;
  const input = observed.elements.find(item => item.role === 'textbox' && item.name === 'Search');
  assert.ok(input);
  await call('adl_act',{session_id:session.session_id,expected_revision:observed.revision,action:'fill',element_id:input.id,value:'bundled runtime'});
  const after = (await call('adl_observe',{session_id:session.session_id})).result;
  assert.ok(after.elements.some(item => item.value === 'bundled runtime'));
  const image = (await call('adl_capture',{session_id:session.session_id})).raw.content.find(item => item.type === 'image');
  assert.ok(image?.data.length > 100);
  await call('adl_close',{session_id:session.session_id});
  await client.close();
  const extensionManifest=JSON.parse(await readFile(join(extension,'package.json'),'utf8'));
  assert.equal(extensionManifest.version, pkg.version);
  assert.equal(extensionManifest.contributes.configuration.properties['agentdesklink.nodePath'],undefined);
  assert.equal(extensionManifest.contributes.configuration.properties['agentdesklink.configPath'],undefined);
  assert.ok(extensionManifest.contributes.commands.some(command=>command.command==='agentdesklink.emergencyStop'));
  const {initializeOperationState,readOperationState,writeOperationState}=await import(pathToFileURL(join(extension,'dist/src/operation-control.js')).href);
  const controlPath=join(temp,'operations.json');initializeOperationState(controlPath);
  client=new Client({name:'vsix-explicit-permissions',version:'1'},{versionNegotiation:{mode:'legacy'}});
  await client.connect(new StdioClientTransport({command:node,args:[join(extension,'dist/src/server.js')],cwd:home,stderr:'pipe',
    env:{...env,ADL_ALLOW_ALL_OPERATIONS:'',ADL_MCP_PERMISSIONS:JSON.stringify({browserOrigins:[origin],allowLoopback:true,allowAllOperations:true}),ADL_OPERATION_CONTROL:controlPath,ADL_OPERATION_EPOCH:readOperationState(controlPath).epoch}}));
  assert.equal((await call('adl_capabilities')).result.permissions.all_operations,true);
  const defaultSession=(await call('adl_open',{url:origin})).result;
  const defaultObserved=(await call('adl_observe',{session_id:defaultSession.session_id})).result;
  const submit=defaultObserved.elements.find(item=>item.role==='button');assert.ok(submit);
  await call('adl_act',{session_id:defaultSession.session_id,expected_revision:defaultObserved.revision,action:'click',element_id:submit.id});
  const waiting=client.callTool({name:'adl_wait',arguments:{session_id:defaultSession.session_id,condition:{name:'Never'},timeout_ms:30000}},{},{timeout:5000});
  await new Promise(resolve=>setTimeout(resolve,50));writeOperationState(controlPath,true);
  const stopped=JSON.parse((await waiting).content.find(item=>item.type==='text').text);
  assert.equal(stopped.error.code,'E_CANCELLED');
  const blocked=JSON.parse((await client.callTool({name:'adl_open',arguments:{url:origin}})).content.find(item=>item.type==='text').text);
  assert.equal(blocked.error.code,'E_CANCELLED');
  console.log(JSON.stringify({ok:true,vsix,target:manifest.target,node:version,systemPath:'empty',browser:browser.source,browserBundled:false,cacheReuse:browser.source==='chromium',nativeHelper:manifest.helper ? 'loader and policy default verified; OS permissions require interactive acceptance' : null,mcpTools:toolNames.length,browserFill:true,browserCapture:true,explicitPermissions:true,emergencyStop:true}));
} finally {
  await client?.close();
  if (http) await new Promise(accept => http.close(accept));
  await rm(temp, {recursive:true,force:true});
}
