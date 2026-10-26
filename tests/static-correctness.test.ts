import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {Engine, type Step} from '../src/core.js';
import {parsePolicy} from '../src/policy.js';
import type {Adapter, Action} from '../src/types.js';

async function fixture(closeSession:()=>Promise<void>=async()=>{}) {
  const actions:Action[]=[];
  const adapter:Adapter={open:async()=>({
    snapshot:async()=>({elements:[{id:'entry',role:'textbox',name:'Reference',value:'original',enabled:true}],fingerprint:'same',truncated:false}),
    act:async action=>{actions.push({...action});},close:closeSession,
  }),close:async()=>{}};
  const engine=new Engine(parsePolicy({browserTargets:[{id:'fixture',label:'Fixture',url:'https://example.com',classification:'PUBLIC'}]}),{browser:adapter});
  const session=await engine.open((await engine.listTargets()).targets[0]!.target_id);
  return {engine,session,actions,adapter};
}
async function finish(engine:Engine,id:string) {
  for(let n=0;n<100;n++) {const task=engine.task(id);if(!['queued','running'].includes(task.status))return task;await nextTurn();}
  throw new Error('Batch did not finish');
}

test('batch captures steps, nested expectations and revision map before returning',{timeout:5000},async()=>{
  const {engine,session,actions}=await fixture();
  try {
    const steps:Step[]=[{session_id:session.session_id,action:'fill',element_id:'entry',value:'approved',expected_target:{name:'Reference'}}];
    const revisions={[session.session_id]:session.revision};
    const task=engine.execute(steps,revisions);
    steps[0]!.value='changed later';steps[0]!.expected_target!.name='Changed label';revisions[session.session_id]=999;
    steps.push({session_id:session.session_id,action:'fill',element_id:'entry',value:'unexpected extra'});
    const result=await finish(engine,task.task_id);
    assert.equal(result.status,'completed');assert.equal(result.results.length,1);
    assert.equal(actions.length,1);assert.equal(actions[0]!.value,'approved');assert.equal(actions[0]!.expected_target!.name,'Reference');
  } finally {await engine.shutdown();}
});

test('invalid later revision rejects the entire batch before executing its prefix',{timeout:5000},async()=>{
  const {engine,session,actions}=await fixture();
  try {
    const second=await engine.open((await engine.listTargets()).targets[0]!.target_id);
    const steps:Step[]=[{session_id:session.session_id,action:'fill',element_id:'entry',value:'first'},{session_id:second.session_id,action:'fill',element_id:'entry',value:'second'}];
    for(const revision of [0,-1,NaN,Infinity]) {
      assert.throws(()=>engine.execute(steps,{[session.session_id]:1,[second.session_id]:revision}),{code:'E_INVALID_ARGUMENT'});
      assert.throws(()=>engine.execute([steps[0]!,{...steps[1]!,expected_revision:revision}],{[session.session_id]:1,[second.session_id]:1}),{code:'E_INVALID_ARGUMENT'});
    }
    assert.equal(actions.length,0);
  } finally {await engine.shutdown();}
});

test('concurrent shutdown callers both await the same resource cleanup',{timeout:5000},async()=>{
  let release!:()=>void,closed=0;
  const gate=new Promise<void>(resolve=>release=resolve);
  const {engine}=await fixture(async()=>{closed++;await gate;});
  let secondDone=false;
  const first=engine.shutdown(),second=engine.shutdown().then(()=>{secondDone=true;});
  try {await nextTurn();assert.equal(secondDone,false,'second shutdown resolved before the session closed');}
  finally {release();await Promise.all([first,second]);}
  assert.equal(closed,1);
});

test('shutdown attempts remaining adapter cleanup even when one close throws synchronously',{timeout:5000},async()=>{
  let desktopClosed=false;
  const browser:Adapter={open:async()=>{throw new Error('unused');},close:()=>{throw new Error('close failed');}};
  const desktop:Adapter={open:async()=>{throw new Error('unused');},close:async()=>{desktopClosed=true;}};
  const engine=new Engine(parsePolicy({}),{browser,desktop});
  await engine.shutdown();assert.equal(desktopClosed,true);
});

test('retained image redaction metadata is captured before asynchronous decoding',{timeout:5000},async()=>{
  const {default:sharp}=await import('sharp');
  const {VisualStore}=await import('../src/visual.js');
  const png=await sharp({create:{width:64,height:64,channels:3,background:'black'}}).png().toBuffer();
  const image:import('../src/visual-types.js').CapturedImage={
    png,captured_at:new Date().toISOString(),coordinate_space:'viewport_css_pixels',
    viewport:{width:64,height:64,scroll_x:0,scroll_y:0,device_scale_factor:1},redacted:true,
    redaction:{scope:'detected_regions',methods:['sensitive_labels'],complete:false},
  };
  const store=new VisualStore();
  const pending=store.record({session_id:'s',target_id:'t',revision:1},image);
  image.redaction!.scope='unredacted';image.redaction!.methods.splice(0,1,'configured_regions');
  const id=await pending;
  const frame=await store.view('s',id);
  assert.deepEqual(frame.metadata.redaction,{scope:'detected_regions',methods:['sensitive_labels'],complete:false});
  store.clear();
});

for(const action of ['status','launch','quit'] as const)test(`application ${action} preserves acknowledged state when writing its audit fails`,{timeout:5000},async()=>{
  let closed=0;
  const desktop:Adapter={
    discover:async()=>[{target_id:'t_native',surface:'desktop',application_id:'fixture',label:'Fixture',capabilities:['observe'],policy_class:'PUBLIC'}],
    open:async()=>({snapshot:async()=>({elements:[],fingerprint:'same',truncated:false}),act:async()=>{},close:async()=>{closed++;}}),
    application:async(_id,operation)=>({running:operation!=='quit',managed:operation!=='quit',changed:operation!=='status'}),close:async()=>{},
  };
  const browser:Adapter={open:async()=>{throw new Error('unused');},close:async()=>{}};
  const engine=new Engine(parsePolicy({windows:{helperPath:'/helper',appId:'fixture',appPath:'/fixture',classification:'PUBLIC',lifecycle:{enabled:true}}}),{browser,desktop},'win32');
  try {
    await engine.listTargets('desktop');const session=await engine.open('t_native','background_semantic');
    (engine as unknown as {audit:(event:string)=>Promise<string>}).audit=async event=>{if(event==='application_lifecycle')throw new Error('disk full');return 'audit';};
    let failure:unknown;
    try {await engine.application('fixture',action);}catch(error){failure=error;}
    assert.equal(closed,action==='quit'?1:0,'only an acknowledged quit retires the app sessions');
    assert.equal((failure as {code?:string})?.code,'E_INTERNAL');
    assert.equal((failure as {mayHaveExecuted?:boolean})?.mayHaveExecuted,action!=='status','only a completed mutation carries execution uncertainty');
    if(action==='quit')await assert.rejects(engine.observe(session.session_id),{code:'E_TARGET_NOT_FOUND'});
    else assert.equal((await engine.observe(session.session_id)).ok,true);
  } finally {await engine.shutdown();}
});

for(const reason of ['pre_cancel','cancel','timeout','shutdown'] as const)test(`URL admission respects ${reason} while DNS is pending`,{timeout:5000},async()=>{
  const {default:dns}=await import('node:dns/promises');
  const {syncBuiltinESMExports}=await import('node:module');
  const {setTimeout:delay}=await import('node:timers/promises');
  const original=dns.lookup;
  let release!:()=>void,calls=0,opens=0;
  const gate=new Promise<void>(resolve=>release=resolve);
  // The production resolver uses the all:true overload.
  dns.lookup=(async()=>{calls++;await gate;return [{address:'93.184.216.34',family:4}];}) as unknown as typeof dns.lookup;
  syncBuiltinESMExports();
  const adapter:Adapter={open:async()=>{opens++;return {snapshot:async()=>({elements:[],fingerprint:'same',truncated:false}),act:async()=>{},close:async()=>{}};},close:async()=>{}};
  const policy=parsePolicy({actionTimeoutMs:100,allowedOrigins:['https://dns.example'],browserTargets:[{id:'fixture',label:'Fixture',url:'https://dns.example/',classification:'PUBLIC'}]});
  const engine=new Engine(policy,{browser:adapter}),cancel=new AbortController();
  if(reason==='pre_cancel')cancel.abort();
  const opening=engine.openUrl('https://dns.example/path','strict_isolated',cancel.signal).then(()=>({error:undefined}),error=>({error}));
  try {
    if(reason==='cancel')cancel.abort();
    if(reason==='shutdown')await engine.shutdown();
    const result=await Promise.race([opening,delay(500).then(()=>null)]);
    assert.ok(result,'URL admission remained blocked on DNS after cancellation/deadline');
    assert.equal((result.error as {code?:string})?.code,reason==='timeout'?'E_TIMEOUT':'E_CANCELLED');
    if(reason==='pre_cancel')assert.equal(calls,0,'a pre-cancelled request must not begin DNS work');
    release();await opening;await nextTurn();assert.equal(opens,0);assert.equal(policy.browserTargets.length,1);
  } finally {release();await opening;await engine.shutdown();dns.lookup=original;syncBuiltinESMExports();}
});
