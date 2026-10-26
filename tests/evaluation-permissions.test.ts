import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as bundled from '../src/bundled-policy.js';
import {assertUrlAllowed} from '../src/policy.js';
import {Engine} from '../src/core.js';
import type {Adapter,PolicyConfig} from '../src/types.js';
const profile=bundled.extensionPolicy as (...args:any[])=>PolicyConfig;

test('enabling MCP alone grants no targets or elevated permissions on any platform',()=>{
  for(const platform of ['darwin','win32','linux']){
    const p=profile('/installed/helper',platform);
    assert.equal(p.allowAllOperations,false);assert.equal(p.allowLoopback,false);assert.equal(p.allowPrivateNetwork,false);
    assert.deepEqual(p.allowedOrigins,[]);assert.deepEqual(p.browserTargets,[]);assert.equal(p.macos,undefined);assert.equal(p.windows,undefined);
  }
});
test('origin, operations, raw native images and physical input remain independent grants',async()=>{
  const origins={browserOrigins:['http://127.0.0.1:8123'],allowLoopback:true};
  const p=profile('/installed/helper','darwin',{...origins,allowAllOperations:true});
  assert.equal(p.restrictTargets,true);assert.equal(p.macos,undefined);
  await assertUrlAllowed('http://127.0.0.1:8123/path',p);
  await assert.rejects(assertUrlAllowed('http://127.0.0.1:8124/',p),{code:'E_POLICY_DENIED'});
  const app={desktopAppId:'test.app',desktopAppPath:'/Applications/Test.app/Contents/MacOS/Test'};
  for(const platform of ['darwin','win32']){
    const key=platform==='darwin'?'macos':'windows';
    const semantic=profile('/installed/helper',platform,{...app,allowAllOperations:true})[key]!;
    assert.equal(semantic.restrictTargets,true);assert.equal(semantic.allowAllOperations,true);assert.ok(!semantic.visual?.enabled);assert.ok(!semantic.interactive?.enabled);
    const images=profile('/installed/helper',platform,{...app,allowUnredactedImages:true})[key]!;
    assert.equal(images.visual?.allowUnredacted,true);assert.ok(!images.interactive?.enabled);
    const physical=profile('/installed/helper',platform,{...app,allowPhysicalInput:true})[key]!;assert.ok(!physical.interactive?.enabled);
    const all=profile('/installed/helper',platform,{...app,allowPhysicalInput:true,allowUnredactedImages:true})[key]!;assert.equal(all.interactive?.enabled,true);
  }
});
test('malformed or oversized environment permissions fail closed without partial grants',()=>{
  const parse=(bundled as any).parsePermissionsEnv as (text:string)=>unknown;assert.equal(typeof parse,'function');
  for(const text of ['{','[]','null',JSON.stringify({allowAllOperations:'true'}),JSON.stringify({allowAllOperations:true,browserOrigins:['https://example.com/path']}),' '.repeat(65537)]){
    try{const p=profile(undefined,'linux',parse(text));assert.deepEqual(p.browserTargets,[]);assert.equal(p.allowAllOperations,false);}catch(error){assert.equal((error as any).code,'E_INVALID_ARGUMENT');}
  }
  assert.equal(profile('/installed/helper','darwin',{desktopAppId:'*',desktopAppPath:'/app',allowAllOperations:true}).macos,undefined);
});
test('core URL admission checks origin/network grants before opening even with broad operations',async()=>{
  let opens=0,lastUrl='';let policy:PolicyConfig;const adapter:Adapter={open:async target=>{opens++;lastUrl=policy.browserTargets.find(c=>c.id===target.application_id)!.url;return {snapshot:async()=>({elements:[],fingerprint:'same',truncated:false}),act:async()=>{},close:async()=>{}};},close:async()=>{}};
  policy=profile(undefined,'linux',{browserOrigins:['http://127.0.0.1:8123'],allowLoopback:true,allowAllOperations:true});
  const engine=new Engine(policy,{browser:adapter});
  try{
    await assert.rejects(engine.openUrl('http://127.0.0.1:8124'),{code:'E_POLICY_DENIED'});assert.equal(opens,0);
    const s=await engine.openUrl('http://127.0.0.1:8123/path');assert.equal(opens,1);assert.equal(lastUrl,'http://127.0.0.1:8123/path');await engine.close(s.session_id);
    policy.allowLoopback=false;await assert.rejects(engine.openUrl('http://127.0.0.1:8123/another'),{code:'E_POLICY_DENIED'});assert.equal(opens,1);
  }finally{await engine.shutdown();}
});

test('all 64 configured origins can open their root without allocating another target',async()=>{
  const browserOrigins=Array.from({length:64},(_,i)=>`http://127.0.0.1:${8100+i}`);
  const policy=profile(undefined,'linux',{browserOrigins,allowLoopback:true});
  const adapter:Adapter={open:async()=>({snapshot:async()=>({elements:[],fingerprint:'same',truncated:false}),act:async()=>{},close:async()=>{}}),close:async()=>{}};
  const engine=new Engine(policy,{browser:adapter});
  try{await engine.openUrl(`${browserOrigins[0]}/`);assert.equal(policy.browserTargets.length,64);}finally{await engine.shutdown();}
});
