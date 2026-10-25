import {randomUUID} from 'node:crypto';
import {appendFile, chmod, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {AdlError, NativeError, safeError, type Action, type Adapter, type AdapterSession, type Condition, type Mode, type PolicyConfig, type RawSnapshot, type Target} from './types.js';
import {authorizeAction,redactElement,redactString} from './policy.js';
import {SnapshotStore} from './snapshot.js';
import {VisualStore} from './visual.js';
import {visualRequestSchema} from './visual-request.js';
import type {VisualRequest,VisualObservation} from './visual-types.js';
import type {VisualViewOptions} from './visual-types.js';
import type {GestureRequest,GestureExecution} from './gesture-types.js';
import type {SequenceOptions,SequenceObservation} from './sequence-types.js';
import {recordSequence} from './sequence.js';
import {gestureRequestSchema,sequenceRequestSchema,expectedTargetSchema,prepareInputSchema,commitInputSchema} from './interaction-request.js';
import {InputProofStore} from './input-proof-store.js';
import type {PrepareInputRequest,PreparedObservation,CommitInputRequest,InputExecution} from './physical-input-types.js';

type Session = { id:string; target:Target; adapter:AdapterSession; mode:Mode;revision:number; raw:RawSnapshot; expires:number;latestFrame?:string };
export type Step = Action & {session_id:string; expected_revision?:number; condition?:Condition};
type Task = {id:string; status:'queued'|'running'|'completed'|'failed'|'cancelled'; controller:AbortController; results:Record<string,unknown>[]; error?:ReturnType<typeof safeError>; created:number};
export class Engine {
  private sessions=new Map<string,Session>();
  private targets=new Map<string,Target>();
  private tasks=new Map<string,Task>();
  private snapshots=new SnapshotStore();
  private visuals=new VisualStore();
  private inputProofs=new InputProofStore();
  private queue:Promise<unknown>=Promise.resolve();
  private stopped=false;
  private shut=false;
  private queued=0;
  private closures=new WeakMap<AdapterSession,Promise<void>>();
  private master=new AbortController();
  private timer:NodeJS.Timeout;
  constructor(readonly policy:PolicyConfig,private adapters:{browser:Adapter;desktop?:Adapter},private readonly platform:string=process.platform,private readonly operationAllowed:()=>boolean=()=>true) {
    for(const config of policy.browserTargets) {
      if(config.classification==='SECRET'||config.classification==='UNKNOWN') continue;
      const target:Target={target_id:`t_${randomUUID()}`,surface:'browser',application_id:config.id,label:redactString(config.label),policy_class:config.classification,capabilities:['observe','click','fill','select','check','scroll','navigate','read_state','wait_for',...(config.visual?.enabled?['capture','crop','record']:[]),...(config.gestures?.enabled?['gesture']:[])]};
      this.targets.set(target.target_id,target);
    }
    adapters.desktop?.onInvalidated?.(()=>{void this.enqueue(async()=>{this.replaceDesktopTargets([]);for(const s of [...this.sessions.values()])if(s.target.surface==='desktop')await this.destroy(s);}).catch(()=>{});});
    this.timer=setInterval(()=>{this.visuals.prune();this.inputProofs.prune();void this.enqueue(async()=>{for(const s of this.sessions.values())if(s.expires<=Date.now())await this.destroy(s);}).catch(()=>{});},1000);this.timer.unref();
  }
  private replaceDesktopTargets(targets:Target[]){
    for(const [id,target] of this.targets)if(target.surface==='desktop')this.targets.delete(id);
    for(const target of targets)this.targets.set(target.target_id,target);
  }
  capabilities() {
    const probe=(this.adapters.desktop as {desktopCapabilities?:()=>{available:boolean;mutations:boolean;focus_control?:string;interactive_input?:boolean;gesture_backends?:string[];lifecycle?:boolean}}|undefined)?.desktopCapabilities?.();
    const interactive=this.desktopConfig()?.interactive?.enabled===true;
    return {ok:true,permissions:{all_operations:this.policy.allowAllOperations===true},version:'0.1.1',transport:'stdio',modes:['strict_isolated',...(this.adapters.desktop?['background_semantic',...(interactive?['interactive_desktop']:[])]:[])],
      adapters:{browser:'chromium_headless',desktop:this.adapters.desktop?(probe?.focus_control==='probe_guarded_semantic'?'macos_ax_probe_required':'windows_uia_probe_required'):'unavailable',...(probe?{desktop_mutations:probe.mutations}:{})},
      lifecycle:{configured:this.policy.macos?.lifecycle?.enabled===true||this.policy.windows?.lifecycle?.enabled===true,available:probe?.lifecycle===true&&this.lifecyclePlatformSupported(),platform_supported:this.lifecyclePlatformSupported(),mode:'background_semantic'},
      limits:{max_sessions:this.policy.maxSessions,max_batch_steps:this.policy.maxBatchSteps,max_elements:this.policy.maxElements},
      visual:{browser:true,desktop:!!(this.policy.macos?.visual?.enabled||this.policy.windows?.visual?.enabled),formats:['image/png'],sources:['viewport','exact_window'],max_source_pixels:4194304,max_source_bytes:8388608,max_frames:16,max_retained_bytes:33554432,frame_ttl_ms:60000,max_output_dimension:2048,max_output_pixels:4194304,max_output_bytes:6291456,video:'timestamped_png_sequence',audio:false,gestures:'isolated_browser_and_opt_in_desktop',max_sequence_frames:16,max_sequence_span_ms:6000,gesture_frame_max_age_ms:5000},
      physical_input:{configured:interactive,available:probe?.interactive_input===true,backends:probe?.gesture_backends??[],requires_foreground:true,exclusive_lease:true,confirmation_ttl_ms:30000,pre_dispatch_target_check:true},
      limitations:['Visuals require trusted per-target opt-in. Native images may need explicit unredacted-pixel permission. Sequences sample discrete frames without audio.',
        'interactive_desktop shares the human desktop and moves the real pointer. Human input or focus changes stop execution; partial input cannot be rolled back.',
        'Native scroll_swipe is wheel/scroll input, distinct from genuine touch_swipe. Check each target backend capability.',
        ...(this.policy.allowAllOperations?[]:['Credentials, uploads, arbitrary code and consequential operations are disabled.']),'Desktop strict isolation requires a separate isolated runner.','background_semantic preserves its native focus-control probe and trusted control allowlist.',
        'Application lifecycle is noninterfering background launch/status/quit for the one configured opted-in application only; it never sends input or focus changes and never falls back to interactive control automatically.']};
  }
  listTargets(surface?:string,cancel?:AbortSignal) {return this.enqueue(async()=>{
    if(surface!=='browser'&&this.adapters.desktop?.discover){
      try{this.replaceDesktopTargets(await this.deadline(signal=>this.adapters.desktop!.discover!(signal),this.policy.actionTimeoutMs,cancel));}
      catch(error){this.replaceDesktopTargets([]);throw error;}
    }
    return {ok:true,targets:[...this.targets.values()].filter(t=>!surface||t.surface===surface)};
  });}
  private enqueue<T>(fn:()=>Promise<T>):Promise<T> {
    if(this.stopped||!this.operationAllowed())return Promise.reject(new AdlError('E_CANCELLED'));
    if(this.queued>=64)return Promise.reject(new AdlError('E_RESOURCE_LIMIT'));
    this.queued++;
    const run=this.queue.then(()=>{if(this.stopped||!this.operationAllowed())throw new AdlError('E_CANCELLED');return fn();});
    this.queue=run.catch(()=>{});return run.finally(()=>{this.queued--;});
  }
  private get(id:string):Session {
    const s=this.sessions.get(id);if(!s||s.expires<=Date.now())throw new AdlError('E_TARGET_NOT_FOUND');
    return s;
  }
  private async audit(event:string, fields:{session_id?:string;task_id?:string;action?:string;code?:string}={}) {
    const audit_id=`a_${randomUUID()}`;
    if(this.policy.auditPath){await mkdir(dirname(this.policy.auditPath),{recursive:true,mode:0o700});await appendFile(this.policy.auditPath,JSON.stringify({audit_id,time:new Date().toISOString(),event,...fields})+'\n',{mode:0o600});await chmod(this.policy.auditPath,0o600);}
    return audit_id;
  }
  private async destroy(s:Session){
    this.sessions.delete(s.id);this.snapshots.close(s.id);this.visuals.dropSession(s.id);this.inputProofs.invalidateSession(s.id);
    await this.stopAdapter(s.adapter);
  }
  private stopAdapter(adapter:AdapterSession):Promise<void>{
    const current=this.closures.get(adapter);if(current)return current;
    const closing=this.performStop(adapter);this.closures.set(adapter,closing);return closing;
  }
  private async performStop(adapter:AdapterSession){
    let timer:NodeJS.Timeout|undefined;
    const cleanupMs=adapter.capabilities?.includes('interactive_desktop')?8000:1000;
    const closed=await Promise.race([adapter.close().then(()=>true,()=>false),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),cleanupMs);})]);
    if(timer)clearTimeout(timer);
    if(!closed){this.stopped=true;clearInterval(this.timer);this.master.abort();for(const task of this.tasks.values())task.controller.abort();}
  }
  private async deadline<T>(operation:(signal:AbortSignal)=>Promise<T>, timeout:number, cancel?:AbortSignal, session?:Session):Promise<T> {
    const controller=new AbortController();const signal=AbortSignal.any([controller.signal,this.master.signal,...(cancel?[cancel]:[])]);
    let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeout);
    let listener:()=>void=()=>{};
    const aborted=new Promise<never>((_,reject)=>{listener=()=>reject(new AdlError(timedOut?'E_TIMEOUT':'E_CANCELLED'));signal.addEventListener('abort',listener,{once:true});if(signal.aborted)listener();});
    try {return await Promise.race([signal.aborted?aborted:operation(signal),aborted]);}
    catch(error) {if(signal.aborted && session)await this.destroy(session);if(signal.aborted)throw new AdlError(timedOut?'E_TIMEOUT':'E_CANCELLED');throw error;}
    finally {clearTimeout(timer);signal.removeEventListener('abort',listener);}
  }
  private async refresh(s:Session,signal?:AbortSignal){
    const raw=this.boundSnapshot(await this.deadline(sig=>s.adapter.snapshot(sig),this.policy.actionTimeoutMs,signal,s));
    if(raw.fingerprint!==s.raw.fingerprint){s.revision++;s.raw=raw;this.snapshots.record(s.id,s.revision,raw);}
    return s.revision;
  }
  private boundSnapshot(raw:RawSnapshot):RawSnapshot{return {...raw,elements:raw.elements.slice(0,this.policy.maxElements),truncated:raw.truncated||raw.elements.length>this.policy.maxElements};}
  openUrl(url:string,mode:Mode='strict_isolated',cancel?:AbortSignal){
    if(this.stopped||!this.operationAllowed())return Promise.reject(new AdlError('E_CANCELLED'));
    if(!this.policy.allowAllOperations)return Promise.reject(new AdlError('E_POLICY_DENIED'));
    let parsed:URL;try{parsed=new URL(url);}catch{return Promise.reject(new AdlError('E_INVALID_ARGUMENT'));}
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||url.length>2048)return Promise.reject(new AdlError('E_INVALID_ARGUMENT'));
    // A bounded per-process target catalogue lets clients open a URL without a policy file.
    let config=this.policy.browserTargets.find(t=>t.url===parsed.href);
    if(!config){
      if(this.policy.browserTargets.length>=64)return Promise.reject(new AdlError('E_RESOURCE_LIMIT'));
      config={id:`browser_${randomUUID()}`,label:parsed.origin,url:parsed.href,classification:'PUBLIC',visual:{enabled:true,maskSelectors:[]},gestures:{enabled:true,surfaces:[{id:'page',selector:'body',kinds:['drag','swipe']}]}};
      this.policy.browserTargets.push(config);
      const target:Target={target_id:`t_${randomUUID()}`,surface:'browser',application_id:config.id,label:parsed.origin,policy_class:'PUBLIC',capabilities:['observe','click','fill','select','check','scroll','navigate','read_state','wait_for','capture','crop','record','gesture']};
      this.targets.set(target.target_id,target);
    }
    return this.open([...this.targets.values()].find(t=>t.application_id===config!.id)!.target_id,mode,cancel);
  }
  open(target_id:string,mode:Mode='strict_isolated',cancel?:AbortSignal) {return this.enqueue(async()=>{
    if(this.sessions.size>=this.policy.maxSessions)throw new AdlError('E_RESOURCE_LIMIT');
    const target=this.targets.get(target_id);if(!target)throw new AdlError('E_TARGET_NOT_FOUND');
    if(target.surface==='desktop'&&mode==='strict_isolated')throw new AdlError('E_INTERFERENCE_RISK');
    if(mode==='interactive_desktop'){
      if(target.surface!=='desktop')throw new AdlError('E_INTERFERENCE_RISK');
      if(!this.desktopConfig()?.interactive?.enabled)throw new AdlError('E_POLICY_DENIED');
      if(!target.capabilities.includes('interactive_desktop'))throw new AdlError('E_UNSUPPORTED_ACTION');
      if([...this.sessions.values()].some(s=>s.mode==='interactive_desktop'))throw new AdlError('E_INTERFERENCE_RISK');
    }
    const adapter=target.surface==='browser'?this.adapters.browser:this.adapters.desktop;if(!adapter)throw new AdlError('E_TARGET_NOT_FOUND');
    let instance:AdapterSession|undefined;
    try {
      instance=await this.deadline(async signal=>{const opened=await adapter.open(target,mode,signal);if(signal.aborted){void this.stopAdapter(opened);throw new AdlError('E_CANCELLED');}return opened;},this.policy.actionTimeoutMs,cancel);
      const raw=this.boundSnapshot(await this.deadline(sig=>instance!.snapshot(sig),this.policy.actionTimeoutMs,cancel));
      const s:Session={id:`s_${randomUUID()}`,target,adapter:instance,mode,revision:1,raw,expires:Date.now()+this.policy.sessionTtlMs};
      await this.audit('open',{session_id:s.id});
      if(this.stopped||this.master.signal.aborted||cancel?.aborted)throw new AdlError('E_CANCELLED');
      this.sessions.set(s.id,s);this.snapshots.record(s.id,1,raw);
      return {ok:true,session_id:s.id,revision:1,capabilities:instance.capabilities??target.capabilities,mode};
    }catch(error){if(instance)await this.stopAdapter(instance);throw error;}
  });}
  capture(session_id:string,options:VisualRequest={},cancel?:AbortSignal):Promise<VisualObservation>{return this.enqueue(async()=>{
    const s=this.get(session_id);
    const parsed=visualRequestSchema.safeParse(options);if(!parsed.success)throw new AdlError('E_INVALID_ARGUMENT');
    this.assertCaptureAllowed(s);
    return this.deadline(async signal=>{
      if(signal.aborted)throw new AdlError('E_CANCELLED');
      const {frame_id,...view}=parsed.data;
      if(frame_id)return this.visuals.view(s.id,frame_id,view,signal);
      return this.captureFrame(s,view,signal);
    },this.policy.actionTimeoutMs,cancel,s).catch(async error=>{if(error instanceof AdlError&&['E_TIMEOUT','E_CANCELLED'].includes(error.code))await this.destroy(s);throw error;});
  });}
  private assertCaptureAllowed(s:Session):void{
    if(!s.adapter.capture)throw new AdlError('E_UNSUPPORTED_ACTION');
    const config=s.target.surface==='browser'?this.policy.browserTargets.find(t=>t.id===s.target.application_id):this.desktopConfig();
    if(!config?.visual?.enabled)throw new AdlError('E_PRIVACY_BLOCKED');
  }
  private desktopConfig(){return this.platform==='darwin'?this.policy.macos:this.policy.windows;}
  private async captureFrame(s:Session,view:VisualViewOptions,signal:AbortSignal):Promise<VisualObservation>{
    await this.refresh(s,signal);
    const image=await s.adapter.capture!(signal);
    if(signal.aborted||this.stopped||!this.sessions.has(s.id))throw new AdlError('E_CANCELLED');
    const id=await this.visuals.record({session_id:s.id,target_id:s.target.target_id,revision:s.revision},image,signal);
    try{
      if(signal.aborted||this.stopped||!this.sessions.has(s.id))throw new AdlError('E_CANCELLED');
      await this.audit('capture',{session_id:s.id});
      if(signal.aborted)throw new AdlError('E_CANCELLED');
      const observation=await this.visuals.view(s.id,id,view,signal);s.latestFrame=id;return observation;
    }catch(error){this.visuals.discard(s.id,id);throw error;}
  }
  record(session_id:string,options:SequenceOptions={},cancel?:AbortSignal):Promise<SequenceObservation>{return this.enqueue(async()=>{
    const s=this.get(session_id);const parsed=sequenceRequestSchema.safeParse(options);if(!parsed.success)throw new AdlError('E_INVALID_ARGUMENT');this.assertCaptureAllowed(s);
    return this.deadline(signal=>recordSequence({
      capture:(view,sig)=>this.captureFrame(s,view,sig),
      assertRetained:async id=>{this.visuals.assertRetained(s.id,id);},
      discard:ids=>{for(const id of ids)this.visuals.discard(s.id,id);if(s.latestFrame&&ids.includes(s.latestFrame))delete s.latestFrame;},
    },parsed.data,signal),Math.min(30000,this.policy.actionTimeoutMs+6000),cancel,s).catch(async error=>{if(error instanceof AdlError&&['E_TIMEOUT','E_CANCELLED'].includes(error.code))await this.destroy(s);throw error;});
  });}
  gesture(session_id:string,request:GestureRequest,cancel?:AbortSignal):Promise<VisualObservation&{metadata:VisualObservation['metadata']&{gesture:GestureExecution}}>{return this.enqueue(async()=>{
    const s=this.get(session_id);const parsed=gestureRequestSchema.safeParse(request);if(!parsed.success)throw new AdlError('E_INVALID_ARGUMENT');
    this.assertCaptureAllowed(s);
    if(!s.adapter.gesture)throw new AdlError('E_UNSUPPORTED_ACTION');
    if(s.target.surface==='browser'){
      const config=this.policy.browserTargets.find(t=>t.id===s.target.application_id);if(!config?.gestures?.enabled)throw new AdlError('E_POLICY_DENIED');
      if(parsed.data.swipe_backend==='scroll'||parsed.data.kind==='drag'&&parsed.data.swipe_backend)throw new AdlError('E_UNSUPPORTED_ACTION');
    }else{
      if(s.mode!=='interactive_desktop'||!this.desktopConfig()?.interactive?.enabled)throw new AdlError('E_INTERFERENCE_RISK');
    }
    const {frame_id,expected_revision,...plan}=parsed.data;
    this.visuals.assertRetained(s.id,frame_id,5000);
    if(frame_id!==s.latestFrame)throw new AdlError('E_STALE_STATE');
    let dispatched=false;
    return this.deadline(async signal=>{
      await this.refresh(s,signal);if(s.revision!==expected_revision)throw new AdlError('E_STALE_STATE');
      const {metadata:reference}=await this.visuals.view(s.id,frame_id,{max_dimension:64,max_pixels:4096},signal);
      if(reference.revision!==s.revision)throw new AdlError('E_STALE_STATE');
      await this.audit('gesture_started',{session_id:s.id,action:plan.kind});
      this.visuals.assertRetained(s.id,frame_id,5000);
      let completed=false;
      try{
        this.inputProofs.invalidateSession(s.id);
        dispatched=true;const execution=await s.adapter.gesture!(plan,reference,signal);completed=true;
        delete s.latestFrame;
        const image=await this.captureFrame(s,{},signal);
        await this.audit('gesture_completed',{session_id:s.id,action:plan.kind});
        return {...image,metadata:{...image.metadata,gesture:execution}};
      }catch(error){
        const safe=error instanceof AdlError?error:new AdlError('E_INTERNAL');
        if(completed)safe.mayHaveExecuted=true;
        if(safe.mayHaveExecuted)await this.destroy(s);
        throw safe;
      }
    },this.policy.actionTimeoutMs+5000,cancel,s).catch(error=>{if(dispatched&&error instanceof AdlError&&['E_CANCELLED','E_TIMEOUT'].includes(error.code))error.mayHaveExecuted=true;throw error;});
  });}
  prepareInput(session_id:string,request:PrepareInputRequest,cancel?:AbortSignal):Promise<PreparedObservation>{return this.enqueue(async()=>{
    const s=this.get(session_id),parsed=prepareInputSchema.safeParse(request);if(!parsed.success)throw new AdlError('E_INVALID_ARGUMENT');
    if(s.target.surface!=='desktop'||s.mode!=='interactive_desktop'||!s.adapter.prepareInput)throw new AdlError('E_UNSUPPORTED_ACTION');
    this.assertCaptureAllowed(s);
    const {frame_id,expected_revision,include_image,...plan}=parsed.data;
    this.visuals.assertRetained(s.id,frame_id,5000);if(s.latestFrame!==frame_id)throw new AdlError('E_STALE_STATE');
    this.inputProofs.invalidateSession(s.id);
    let dispatched=false;
    return this.deadline(async signal=>{
      await this.refresh(s,signal);if(s.revision!==expected_revision)throw new AdlError('E_STALE_STATE');
      const reference=(await this.visuals.view(s.id,frame_id,{max_dimension:64,max_pixels:4096},signal)).metadata;
      if(reference.revision!==s.revision||plan.point.x>=reference.viewport.width||plan.point.y>=reference.viewport.height)throw new AdlError('E_STALE_STATE');
      this.visuals.assertRetained(s.id,frame_id,5000);
      const started_at=performance.now();
      dispatched=true;const prepared=await s.adapter.prepareInput!(plan,reference,signal);
      if(signal.aborted||!this.sessions.has(s.id))throw new AdlError('E_CANCELLED');
      if(prepared.action!==plan.action||prepared.pointer_on_target!==true||!prepared.target.enabled||plan.action==='fill'&&!prepared.target.editable||plan.expected_target?.role!==undefined&&plan.expected_target.role!==prepared.target.role||plan.expected_target?.name!==undefined&&plan.expected_target.name!==prepared.target.name)throw new AdlError('E_STALE_STATE');
      await this.refresh(s,signal);
      let image:VisualObservation|undefined;
      if(include_image){
        const full=await this.captureFrame(s,{max_dimension:64,max_pixels:4096},signal);
        if(full.metadata.surface_epoch!==reference.surface_epoch)throw new AdlError('E_STALE_STATE');
        const w=Math.min(256,full.metadata.source.width),h=Math.min(192,full.metadata.source.height);
        const x=Math.max(0,Math.min(full.metadata.source.width-w,Math.floor(plan.point.x-w/2))),y=Math.max(0,Math.min(full.metadata.source.height-h,Math.floor(plan.point.y-h/2)));
        image=await this.visuals.view(s.id,full.metadata.frame_id,{region:{x,y,width:w,height:h},max_dimension:256,max_pixels:49152},signal);
      }
      const proof=this.inputProofs.issue({session_id:s.id,native_id:prepared.confirmation_id,action:prepared.action,revision:s.revision,target:{role:prepared.target.role,name:prepared.target.name},ttl_ms:Math.min(30000,prepared.expires_in_ms),started_at});
      await this.audit('input_prepared',{session_id:s.id,action:prepared.action});
      if(signal.aborted){this.inputProofs.invalidateSession(s.id);throw new AdlError('E_CANCELLED');}
      return {metadata:{...prepared,...proof,ok:true as const,session_id:s.id,revision:s.revision},...(image?{image}:{})};
    },this.policy.actionTimeoutMs,cancel,s).catch(async error=>{this.inputProofs.invalidateSession(s.id);if(dispatched&&error instanceof AdlError&&['E_TIMEOUT','E_CANCELLED'].includes(error.code))error.mayHaveExecuted=true;if(error instanceof AdlError&&(error.mayHaveExecuted||['E_TIMEOUT','E_CANCELLED'].includes(error.code)))await this.destroy(s);throw error;});
  });}
  commitInput(session_id:string,request:CommitInputRequest,cancel?:AbortSignal):Promise<VisualObservation&{metadata:VisualObservation['metadata']&{input:InputExecution}}>{return this.enqueue(async()=>{
    const s=this.get(session_id),parsed=commitInputSchema.safeParse(request);if(!parsed.success)throw new AdlError('E_INVALID_ARGUMENT');
    if(s.mode!=='interactive_desktop'||!s.adapter.commitInput)throw new AdlError('E_UNSUPPORTED_ACTION');
    const proof=this.inputProofs.consume(s.id,parsed.data.confirmation_id);
    if(proof.action==='click'&&parsed.data.value!==undefined||proof.action==='fill'&&(parsed.data.value===undefined||Buffer.byteLength(parsed.data.value)>4096||/[\u0000-\u001f\u007f-\u009f]/u.test(parsed.data.value)))throw new AdlError('E_INVALID_ARGUMENT');
    authorizeAction({action:proof.action,...(parsed.data.value!==undefined?{value:parsed.data.value}:{})},{id:'confirmed-target',...proof.target,enabled:true},this.policy.allowAllOperations);
    let dispatched=false,completed=false;
    return this.deadline(async signal=>{
      await this.refresh(s,signal);if(s.revision!==proof.revision)throw new AdlError('E_STALE_STATE');
      await this.audit('input_started',{session_id:s.id,action:proof.action});
      if(performance.now()>=proof.expires_at_ms)throw new AdlError('E_STALE_STATE');
      dispatched=true;
      const execution=await s.adapter.commitInput!(proof.native_id,parsed.data.value,signal);completed=true;
      if(execution.action!==proof.action||execution.released_input!==true||execution.verified!=='input_sequence_completed')throw new AdlError('E_BACKEND_UNAVAILABLE');
      delete s.latestFrame;
      const image=await this.captureFrame(s,{},signal);
      await this.audit('input_completed',{session_id:s.id,action:proof.action});
      return {...image,metadata:{...image.metadata,input:execution}};
    },this.policy.actionTimeoutMs,cancel,s).catch(async error=>{const safe=error instanceof AdlError?error:new AdlError('E_INTERNAL');if(completed||dispatched&&['E_TIMEOUT','E_CANCELLED'].includes(safe.code))safe.mayHaveExecuted=true;if(safe.mayHaveExecuted||['E_TIMEOUT','E_CANCELLED'].includes(safe.code))await this.destroy(s);throw safe;});
  });}
  observe(session_id:string,options:{token_budget?:number;since_revision?:number;cursor?:string;scope?:string;depth?:number;include?:string[]}={},cancel?:AbortSignal) {return this.enqueue(async()=>{
    const s=this.get(session_id);await this.refresh(s,cancel);
    return this.snapshots.observe(s.id,s.revision,{...options,token_budget:options.token_budget??this.policy.defaultTokenBudget});
  });}
  private async action(s:Session,action:Action,expected:number,signal?:AbortSignal){
    this.validateAction(action,s.target.surface);if(!Number.isSafeInteger(expected)||expected<1)throw new AdlError('E_INVALID_ARGUMENT');
    await this.refresh(s,signal);if(!['read_state','wait_for'].includes(action.action)&&s.revision!==expected)throw new AdlError('E_STALE_STATE');
    if(action.action==='read_state')return {ok:true,revision:s.revision};
    if(action.action==='wait_for')return this.waitInternal(s,{role:action.role,name:action.name,element_id:action.element_id},action.timeout_ms??this.policy.actionTimeoutMs,signal);
    if(s.mode==='interactive_desktop')throw new AdlError('E_UNSUPPORTED_ACTION');
    const element=action.element_id?s.raw.elements.find(e=>e.id===action.element_id):undefined;
    if(action.action!=='navigate'&&!element)throw new AdlError('E_TARGET_NOT_FOUND');
    authorizeAction(action,element,this.policy.allowAllOperations);
    if(action.expected_target&&(!element||(action.expected_target.role!==undefined&&action.expected_target.role!==element.role)||(action.expected_target.name!==undefined&&action.expected_target.name!==redactElement(element).name)))throw new AdlError('E_STALE_STATE');
    this.inputProofs.invalidateSession(s.id);
    await this.audit('action_started',{session_id:s.id,action:action.action});
    let acknowledged=false;
    try {
      await this.deadline(sig=>s.adapter.act(action,sig),Math.min(action.timeout_ms??this.policy.actionTimeoutMs,this.policy.actionTimeoutMs),signal,s);
      acknowledged=true;
      delete s.latestFrame;
      await this.refresh(s,signal);
      const audit_id=await this.audit('action_completed',{session_id:s.id,action:action.action});
      return {ok:true,session_id:s.id,revision:s.revision,audit_id};
    }catch(error){await this.destroy(s);const safe=error instanceof AdlError?error:new AdlError('E_INTERNAL');if(acknowledged||!(error instanceof NativeError))safe.mayHaveExecuted=true;throw safe;}
  }
  act(session_id:string,action:Action,expected_revision:number,cancel?:AbortSignal){return this.enqueue(()=>this.action(this.get(session_id),action,expected_revision,cancel));}
  private async waitInternal(s:Session,condition:Condition,timeout:number,cancel?:AbortSignal){
    if(!condition.role&&!condition.name&&!condition.element_id)throw new AdlError('E_INVALID_ARGUMENT');
    return this.deadline(async signal=>{
      while(true){
        await this.refresh(s,signal);
        const element=s.raw.elements.map(redactElement).find(e=>(!condition.element_id||e.id===condition.element_id)&&(!condition.role||e.role===condition.role)&&(!condition.name||e.name===condition.name));
        const matched=condition.state==='hidden'?!element:condition.state==='enabled'?!!element?.enabled:!!element;
        if(matched)return {ok:true,session_id:s.id,revision:s.revision,matched:true};
        await delay(50,undefined,{signal});
      }
    },Math.min(timeout,30000),cancel,s);
  }
  wait(session_id:string,condition:Condition,timeout_ms:number,cancel?:AbortSignal){return this.enqueue(()=>this.waitInternal(this.get(session_id),condition,timeout_ms,cancel));}
  private validateAction(action:Action,surface:'browser'|'desktop'){
    if(!['click','fill','select','check','scroll','navigate','read_state','wait_for'].includes(action.action))throw new AdlError('E_INVALID_ARGUMENT');
    if(action.action==='navigate'){try{const url=new URL(action.url!);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error();}catch{throw new AdlError('E_INVALID_ARGUMENT');}}
    if((action.action==='fill'||(action.action==='select'&&surface==='browser'))&&typeof action.value!=='string')throw new AdlError('E_INVALID_ARGUMENT');
    if(action.action==='scroll'&&surface==='desktop'&&!action.direction)throw new AdlError('E_INVALID_ARGUMENT');
    if(action.action==='check'&&typeof action.checked!=='boolean')throw new AdlError('E_INVALID_ARGUMENT');
    if(['click','fill','select','check','scroll'].includes(action.action)&&!action.element_id)throw new AdlError('E_INVALID_ARGUMENT');
    if(action.direction!==undefined&&!['up','down'].includes(action.direction))throw new AdlError('E_INVALID_ARGUMENT');
    if(action.timeout_ms!==undefined&&(!Number.isSafeInteger(action.timeout_ms)||action.timeout_ms<1))throw new AdlError('E_INVALID_ARGUMENT');
    if(action.action==='wait_for'&&!action.role&&!action.name&&!action.element_id)throw new AdlError('E_INVALID_ARGUMENT');
    if(action.expected_target&&!expectedTargetSchema.safeParse(action.expected_target).success)throw new AdlError('E_INVALID_ARGUMENT');
  }
  execute(steps:Step[],expected_revisions:Record<string,number>) {
    if(this.stopped||!this.operationAllowed())throw new AdlError('E_CANCELLED');
    if(!steps.length||steps.length>this.policy.maxBatchSteps)throw new AdlError('E_INVALID_ARGUMENT');
    for(const step of steps){
      this.get(step.session_id);if(!Number.isSafeInteger(expected_revisions[step.session_id]))throw new AdlError('E_INVALID_ARGUMENT');
      this.validateAction(step,this.get(step.session_id).target.surface);
    }
    if(this.tasks.size>=128){const done=[...this.tasks.values()].find(t=>!['queued','running'].includes(t.status));if(done)this.tasks.delete(done.id);else throw new AdlError('E_RESOURCE_LIMIT');}
    const task:Task={id:`task_${randomUUID()}`,status:'queued',controller:new AbortController(),results:[],created:Date.now()};this.tasks.set(task.id,task);
    void this.enqueue(async()=>{
      if(task.controller.signal.aborted)throw new AdlError('E_CANCELLED');
      task.status='running';const expected={...expected_revisions};
      for(const [step_index,step] of steps.entries()){
        if(task.controller.signal.aborted)throw new AdlError('E_CANCELLED');
        try{
          const s=this.get(step.session_id);
          const result=await this.action(s,step,step.expected_revision??expected[s.id]!,task.controller.signal);
          expected[s.id]=s.revision;
          task.results.push({step_index,status:'completed',...result});
        }catch(error){task.results.push({step_index,status:'failed',error:safeError(error)});throw error;}
      }
      task.status='completed';
    }).catch(error=>{task.error=safeError(error);task.status=task.controller.signal.aborted?'cancelled':'failed';
      for(let i=task.results.length;i<steps.length;i++)task.results.push({step_index:i,status:'not_executed'});
    });
    return {ok:true,task_id:task.id,status:task.status};
  }
  task(task_id:string,command:'status'|'cancel'='status'){
    const t=this.tasks.get(task_id);if(!t||(!['queued','running'].includes(t.status)&&Date.now()-t.created>this.policy.sessionTtlMs)){this.tasks.delete(task_id);throw new AdlError('E_TARGET_NOT_FOUND');}
    if(command==='cancel'&&['queued','running'].includes(t.status))t.controller.abort();
    return {ok:true,task_id:t.id,status:t.status,results:t.results.map(r=>({...r})),...(t.error?{error:t.error}: {})};
  }
  close(session_id:string){return this.enqueue(async()=>{const s=this.get(session_id);await this.destroy(s);return {ok:true,closed:true};});}
  private lifecyclePlatformSupported(){return this.platform==='darwin'||this.platform==='win32';}
  private lifecycleAdapter():Adapter|undefined{
    const config=this.desktopConfig();
    const adapter=this.adapters.desktop;
    return config?.lifecycle?.enabled===true&&typeof adapter?.application==='function'?adapter:undefined;
  }
  applications(){return this.enqueue(async()=>{
    const adapter=this.lifecycleAdapter();
    if(!adapter||!this.lifecyclePlatformSupported())return {ok:true,applications:[] as {application_id:string;capabilities:string[];mode:string}[]};
    const config=this.desktopConfig()!;
    return {ok:true,applications:[{application_id:config.appId,capabilities:['status','launch','quit'],mode:'background_semantic'}]};
  });}
  application(application_id:string,action:'status'|'launch'|'quit',cancel?:AbortSignal){return this.enqueue(async()=>{
    if(this.stopped||!this.operationAllowed())throw new AdlError('E_CANCELLED');
    const adapter=this.lifecycleAdapter();
    if(!adapter||action!=='status'&&action!=='launch'&&action!=='quit')throw new AdlError('E_POLICY_DENIED');
    if(!this.lifecyclePlatformSupported())throw new AdlError('E_UNSUPPORTED_ACTION');
    const config=this.desktopConfig()!;
    if(application_id!==config.appId)throw new AdlError('E_POLICY_DENIED');
    let dispatched=false;
    const state=await this.deadline(async signal=>{dispatched=true;return adapter.application!(application_id,action,signal);},this.policy.actionTimeoutMs,cancel).catch((error:unknown)=>{if(action!=='status'&&dispatched&&error instanceof AdlError&&(cancel?.aborted||this.master.signal.aborted||error.code==='E_TIMEOUT'||error.code==='E_CANCELLED'))error.mayHaveExecuted=true;throw error;});
    await this.audit('application_lifecycle',{action});
    if(action==='quit'&&state.changed){
      for(const s of [...this.sessions.values()])if(s.target.surface==='desktop'&&s.target.application_id===config.appId)await this.destroy(s);
      this.replaceDesktopTargets([]);
    }
    return {ok:true,application_id,...state};
  });}
  async shutdown(){if(this.shut)return;this.shut=true;this.stopped=true;clearInterval(this.timer);this.master.abort();this.visuals.clear();this.inputProofs.clear();for(const t of this.tasks.values())t.controller.abort();await Promise.allSettled([...this.sessions.values()].map(s=>this.destroy(s)));await Promise.allSettled([this.adapters.browser.close(),this.adapters.desktop?.close()]);this.snapshots.clear();}
}
