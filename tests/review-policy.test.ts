import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parsePolicy,assertUrlAllowed,redactElement,redactText,redactUrl} from '../src/policy.js';
import {normalizePermissions,extensionPolicy,parsePermissionsEnv} from '../src/bundled-policy.js';
import {describeApprovalValue} from '../src/approval-summary.js';
import {AdlError,safeError} from '../src/types.js';
import {SnapshotStore} from '../src/snapshot.js';
import {Engine} from '../src/core.js';
import type {Adapter} from '../src/types.js';

test('resource origins grant only resource resolution and retain IP protections',async()=>{
  const policy=parsePolicy({allowedOrigins:['https://app.test'],resourceOrigins:['https://cdn.test']});
  const publicDns=async()=>['93.184.216.34'];
  await assertUrlAllowed('https://cdn.test/code.js',policy,publicDns,'resource');
  await assert.rejects(assertUrlAllowed('https://cdn.test/',policy,publicDns),{reason:'origin_not_allowed'});
  await assert.rejects(assertUrlAllowed('https://cdn.test/a.js',policy,async()=>['127.0.0.1'],'resource'),{reason:'loopback_not_allowed'});
  await assert.rejects(assertUrlAllowed('https://cdn.test/a.js',policy,async()=>['10.0.0.1'],'resource'),{reason:'private_network_not_allowed'});
  await assert.rejects(assertUrlAllowed('https://cdn.test/a.js',policy,async()=>{throw Error('private DNS details');},'resource'),{reason:'dns_resolution_failed'});
  assert.throws(()=>parsePolicy({resourceOrigins:['https://cdn.test/assets']}),{code:'E_INVALID_ARGUMENT'});
  assert.deepEqual(parsePolicy({allowedOrigins:['https://APP.test/'],resourceOrigins:['https://CDN.test/','https://cdn.test']}).resourceOrigins,['https://cdn.test']);
  assert.deepEqual(parsePolicy({allowedOrigins:['https://APP.test/']}).allowedOrigins,['https://app.test']);
});

test('trusted permission transport keeps resource-only grants and personal-data opt-in explicit',()=>{
  const grants=normalizePermissions({browserResourceOrigins:['https://cdn.test/'],allowPersonalData:true});
  const policy=extensionPolicy(undefined,'linux',grants);
  assert.deepEqual(policy.allowedOrigins,[]);assert.deepEqual(policy.browserTargets,[]);
  assert.deepEqual(policy.resourceOrigins,['https://cdn.test']);assert.equal(policy.allowPersonalData,true);
  assert.equal(parsePolicy({}).allowPersonalData,false);
  assert.deepEqual(parsePermissionsEnv('{"browserResourceOrigins":["https://cdn.test/path"],"allowPersonalData":true}').browserResourceOrigins,[]);
  assert.throws(()=>normalizePermissions({allowPersonalData:'true'}),{code:'E_INVALID_ARGUMENT'});
});

test('personal data and credentials have separate disclosure rules; consent shows supplied email',()=>{
  const personal='alice@example.com 090-1234-5678 employee id: 4711';
  assert.ok(!redactText(personal).includes('4711'));assert.ok(!redactText(personal).includes('090-1234'));
  assert.equal(redactText(personal,true),personal);
  assert.ok(!redactText(personal+' password=NEVER_REVEAL',true).includes('NEVER_REVEAL'));
  assert.deepEqual(describeApprovalValue('alice@example.com'),{kind:'public',length:17,preview:'alice@example.com'});
  assert.deepEqual(describeApprovalValue('password=NEVER_REVEAL'),{kind:'secret',length:21});
  const password=redactElement({id:'e',role:'textbox',name:'Password',value:'private',sensitive:true,enabled:true});
  assert.equal(password.name,'Password');assert.equal(password.value,'[redacted]');
  assert.equal(redactElement({id:'e',role:'textbox',name:'Password',value:'',sensitive:true,enabled:true}).value,'');
  for(const name of ['Cookie recipes','Key features','Pin to top','Session schedule'])assert.equal(redactElement({id:'e',role:'button',name,enabled:true}).name,name);
  const store=new SnapshotStore(true);store.record('s',1,{elements:[{id:'e',role:'textbox',name:'Email',value:'alice@example.com',enabled:true}],fingerprint:'x',truncated:false});
  assert.equal(store.observe('s',1,{token_budget:1000}).elements![0]!.value,'alice@example.com');
});

test('known public query parameters remain readable while opaque and secret values stay masked',()=>{
  const text=redactUrl('https://app.test/?q=cats&page=2&access_token=NEVER_REVEAL#secret');
  assert.equal(new URL(text).searchParams.get('q'),'cats');assert.equal(new URL(text).searchParams.get('page'),'2');
  assert.ok(!text.includes('NEVER_REVEAL'));assert.ok(!text.includes('#secret'));
});

test('safe errors expose actionable reasons and settings without granting retry of mutations',()=>{
  const stopped=safeError(new AdlError('E_CANCELLED','emergency_stop'));assert.equal(stopped.reason,'emergency_stop');assert.equal(stopped.retryable,false);
  const loopback=safeError(new AdlError('E_POLICY_DENIED','loopback_not_allowed'));assert.equal(loopback.workspace_setting,'agentdesklink.allowLoopback');
  const approval=safeError(new AdlError('E_APPROVAL_REQUIRED','requires_ask_mode'));assert.equal(approval.workspace_setting,'agentdesklink.operationMode');assert.equal(approval.retryable,false);
});

test('optional diff serialization failure preserves a completed action and its session',async()=>{
  let acts=0,closed=0;
  const adapter:Adapter={open:async()=>({snapshot:async()=>({fingerprint:String(acts),truncated:false,elements:acts?[{id:'x'.repeat(700),role:'text',name:'Result',enabled:true}]:[{id:'e',role:'button',name:'Open',enabled:true}]}),act:async()=>{acts++;},close:async()=>{closed++;}}),close:async()=>{}};
  const engine=new Engine(parsePolicy({allowAllOperations:true,defaultTokenBudget:256,browserTargets:[{id:'f',label:'Fixture',url:'https://example.test',classification:'PUBLIC'}]}),{browser:adapter});
  try{
    const session=await engine.open((await engine.listTargets()).targets[0]!.target_id);
    const result=await engine.act(session.session_id,{action:'click',element_id:'e',include_diff:true},session.revision);
    assert.ok('observation_error' in result);assert.equal(result.ok,true);assert.equal(result.observation_error?.code,'E_RESOURCE_LIMIT');assert.equal(acts,1);assert.equal(closed,0);assert.equal(engine.listSessions().sessions.length,1);
  }finally{await engine.shutdown();}
});
