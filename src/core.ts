import {randomUUID,randomBytes,createHmac} from 'node:crypto';
import {appendFile, chmod, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {AdlError, NativeError, safeError, type Action, type Adapter, type AdapterSession, type Condition, type Mode, type PolicyConfig, type RawSnapshot, type Target, type BrowserTargetConfig} from './types.js';
import {assertUrlAllowed,authorizeAction,redactElement,redactString} from './policy.js';
import {SnapshotStore,type ObserveOptions,type ObserveResult} from './snapshot.js';
import {VisualStore} from './visual.js';
import {visualRequestSchema} from './visual-request.js';
import type {VisualRequest,VisualObservation} from './visual-types.js';
import type {VisualViewOptions} from './visual-types.js';
import type {GestureRequest,GestureExecution} from './gesture-types.js';
import type {SequenceOptions,SequenceObservation} from './sequence-types.js';
import {recordSequence} from './sequence.js';
import {gestureRequestSchema,sequenceRequestSchema,expectedTargetSchema,prepareInputSchema,commitInputSchema} from './interaction-request.js';
import {InputProofStore} from './input-proof-store.js';
import {ApprovalClient,type ApprovalSummary} from './approval-client.js';
import {describeApprovalValue} from './approval-summary.js';
import type {PrepareInputRequest,PreparedObservation,CommitInputRequest,InputExecution} from './physical-input-types.js';

type EvidenceRecord={epoch:number;evidence:NonNullable<RawSnapshot['actionEvidence']>};
type Session = { id:string; target:Target; adapter:AdapterSession; mode:Mode;revision:number; raw:RawSnapshot; expires:number;latestFrame?:string;paused?:boolean;actionEpoch:number;actionHistory:Map<number,EvidenceRecord> };
export type Step = Action & {session_id:string; expected_revision?:number; condition?:Condition};
type Task = {id:string; status:'queued'|'running'|'completed'|'failed'|'cancelled'; controller:AbortController; results:Record<string,unknown>[]; error?:ReturnType<typeof safeError>; created:number};
type PendingApproval={request_id:string;binding:string;expires_at:number;session_id:string;summary:ApprovalSummary;baselineRevision?:number};
function canonical(value:unknown):unknown{if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));return value;}
export class Engine {
  private sessions=new Map<string,Session>();
  private targets=new Map<string,Target>();
  private tasks=new Map<string,Task>();
  private snapshots:SnapshotStore;
  private visuals=new VisualStore();
  private inputProofs=new InputProofStore();
  private readonly approval=ApprovalClient.fromEnv();
  private readonly approvalKey=randomBytes(32);
  private readonly approvalServerId=randomUUID();
  private readonly approvalPending=new Map<string,PendingApproval>();
  private readonly approvalTerminal=new Map<string,number>();
  private queue:Promise<unknown>=Promise.resolve();
  private readonly sessionQueues=new Map<string,Promise<unknown>>();
  private desktopLane:Promise<unknown>|undefined;
  private readonly expiring=new Set<string>();
  private stopped=false;
  private shutdownPromise:Promise<void>|undefined;
  private queued=0;
  private closures=new WeakMap<AdapterSession,Promise<void>>();
  private master=new AbortController();
  private timer:NodeJS.Timeout;
  constructor(readonly policy:PolicyConfig,private adapters:{browser:Adapter;desktop?:Adapter},private readonly platform:string=process.platform,private readonly operationAllowed:()=>boolean=()=>true) {
    this.snapshots=new SnapshotStore(policy.allowPersonalData);
    for(const config of policy.browserTargets) {
      if(config.classification==='SECRET'||config.classification==='UNKNOWN') continue;
      const target:Target={target_id:`t_${randomUUID()}`,surface:'browser',application_id:config.id,label:redactString(config.label),policy_class:config.classification,capabilities:this.browserCapabilities(config)};
      this.targets.set(target.target_id,target);
    }
    adapters.desktop?.onInvalidated?.(()=>{void this.enqueueDesktop(async()=>{this.replaceDesktopTargets([]);for(const s of [...this.sessions.values()])if(s.target.surface==='desktop')await this.destroy(s);}).catch(()=>{});});
    this.timer=setInterval(()=>{
      this.visuals.prune();this.inputProofs.prune();
      for(const s of this.sessions.values())if(s.expires<=Date.now()&&!this.expiring.has(s.id)){
        this.expiring.add(s.id);
        void this.sessionLane(s.id,async()=>{if(this.sessions.get(s.id)===s&&s.expires<=Date.now())await this.destroy(s);}).catch(()=>{}).finally(()=>this.expiring.delete(s.id));
      }
    },1000);this.timer.unref();
  }
  private browserCapabilities(config:BrowserTargetConfig):string[]{
    const actions=this.policy.allowAllOperations||this.policy.operationMode==='standard'||this.policy.operationMode==='ask'?['click','fill','select','check','press','hover']:this.policy.operationMode==='read_only'?[]:[...new Set((config.controls??[]).flatMap(control=>control.actions))];
    return [...new Set(['observe','scroll','navigate','back','read_state','wait_for',...actions,...(this.policy.browserHeadless===false&&(this.policy.allowAllOperations||this.policy.operationMode==='ask'&&!!this.approval)?['handoff']:[]),...(config.visual?.enabled?['capture','crop','record']:[]),...(config.gestures?.enabled&&(this.policy.allowAllOperations||this.policy.operationMode!=='read_only')?['gesture']:[])])];
  }
  private replaceDesktopTargets(targets:Target[]){
    for(const [id,target] of this.targets)if(target.surface==='desktop')this.targets.delete(id);
    for(const target of targets)this.targets.set(target.target_id,target);
  }
  capabilities() {
    const probe=(this.adapters.desktop as {desktopCapabilities?:()=>{available:boolean;mutations:boolean;focus_control?:string;interactive_input?:boolean;gesture_backends?:string[];lifecycle?:boolean}}|undefined)?.desktopCapabilities?.();
    const interactive=this.desktopConfig()?.interactive?.enabled===true;
    const p=this.policy,blanket=p.allowAllOperations===true,app=this.platform==='darwin'?p.macos:this.platform==='win32'?p.windows:undefined;
    return {ok:true,permissions:{all_operations:blanket,operation_mode:blanket?'all':p.operationMode??'legacy_controls',restricted_targets:p.restrictTargets===true,origins:blanket&&!p.restrictTargets?'all_allowed':p.allowedOrigins.slice(),resource_origins:(p.resourceOrigins??[]).slice(),personal_data:p.allowPersonalData===true,targets:blanket&&!p.restrictTargets?'all_allowed':p.browserTargets.map(t=>({application_id:t.id,origin:new URL(t.url).origin})),desktop_app:app?.appId??'',physical_input:app?.interactive?.enabled===true,unredacted_images:app?.visual?.allowUnredacted===true,loopback:p.allowLoopback,private_network:p.allowPrivateNetwork},approvals:{available:!!this.approval&&p.operationMode==='ask'&&!blanket,surface:'browser',max_pending:8,expires_ms:120000,requires_visible_main_document_control:false,requires_visible_control:true,iframe_and_shadow:false,open_shadow:true,same_origin_iframe:true,cross_origin_iframe_approval:false},version:'0.1.6',transport:'stdio',modes:['strict_isolated',...(this.adapters.desktop?['background_semantic',...(interactive?['interactive_desktop']:[])]:[])],
      adapters:{browser:this.policy.browserHeadless===false?'chromium_headful':'chromium_headless',desktop:this.adapters.desktop?(probe?.focus_control==='probe_guarded_semantic'?'macos_ax_probe_required':'windows_uia_probe_required'):'unavailable',...(probe?{desktop_mutations:probe.mutations}:{})},
      lifecycle:{configured:this.policy.macos?.lifecycle?.enabled===true||this.policy.windows?.lifecycle?.enabled===true,available:probe?.lifecycle===true&&this.lifecyclePlatformSupported(),platform_supported:this.lifecyclePlatformSupported(),mode:'background_semantic'},
      limits:{max_sessions:this.policy.maxSessions,max_batch_steps:this.policy.maxBatchSteps,max_elements:this.policy.maxElements,retained_elements:20000},
      visual:{browser:true,desktop:!!(this.policy.macos?.visual?.enabled||this.policy.windows?.visual?.enabled),formats:['image/png'],sources:['viewport','exact_window'],max_source_pixels:4194304,max_source_bytes:8388608,max_frames:16,max_retained_bytes:33554432,frame_ttl_ms:60000,max_output_dimension:2048,max_output_pixels:4194304,max_output_bytes:6291456,video:'timestamped_png_sequence',audio:false,gestures:'isolated_browser_and_opt_in_desktop',max_sequence_frames:16,max_sequence_span_ms:6000,gesture_frame_max_age_ms:5000,browser_gesture_frame_max_age_ms:30000},
      physical_input:{configured:interactive,available:probe?.interactive_input===true,backends:probe?.gesture_backends??[],requires_foreground:true,exclusive_lease:true,confirmation_ttl_ms:30000,pre_dispatch_target_check:true},
      limitations:[blanket&&!p.restrictTargets?'Broad policy supplies default browser visuals; native images follow the native visual policy. Sequences sample discrete frames without audio.':'Visuals require trusted per-target opt-in. Native images may need explicit unredacted-pixel permission. Sequences sample discrete frames without audio.',
        'interactive_desktop shares the human desktop and moves the real pointer. Human input or focus changes stop execution; partial input cannot be rolled back.',
        'Native scroll_swipe is wheel/scroll input, distinct from genuine touch_swipe. Check each target backend capability.',
        ...(blanket?[]:[p.operationMode==='ask'?'Browser credentials and consequential operations require a matching one-shot host approval. Unsupported payloads and native escalation remain denied.':'Credentials, uploads and consequential operations are disabled.']),
        ...(p.restrictTargets?['Origin and application grants remain enforced even with broad operation permission.']:[]),
        'Arbitrary code execution is unavailable. Desktop strict isolation requires a separate isolated runner.',
        app?.allowAllOperations?'background_semantic preserves native focus probes; the explicit native operation grant replaces the control allowlist.':'background_semantic preserves native focus probes and requires a trusted control allowlist.',
        'Application lifecycle is noninterfering background launch/status/quit for the one configured opted-in application only; it never sends input or focus changes and never falls back to interactive control automatically.']};
  }
  listSessions(){return {ok:true,sessions:[...this.sessions.values()].filter(s=>s.expires>Date.now()).map(s=>({session_id:s.id,target_id:s.target.target_id,surface:s.target.surface,mode:s.mode,revision:s.revision,paused:s.paused===true,expires_at:new Date(s.expires).toISOString()}))};}
  handoff(sessionId:string,command:'pause'|'resume',cancel?:AbortSignal){return this.sessionLane(sessionId,async()=>{
    const s=this.get(sessionId);if(!['pause','resume'].includes(command))throw new AdlError('E_INVALID_ARGUMENT');
    if(s.target.surface!=='browser'||this.policy.browserHeadless!==false||!s.adapter.handoff)throw new AdlError('E_UNSUPPORTED_ACTION');
    let expires=Date.now()+120000;
    if(command==='pause'&&!this.policy.allowAllOperations){
      if(this.policy.operationMode!=='ask')throw new AdlError('E_APPROVAL_REQUIRED');
      await this.refresh(s,cancel,true);const configured=this.policy.browserTargets.find(t=>t.id===s.target.application_id);
      const origin=new URL(s.raw.url??configured?.url??'').origin;
      expires=(await this.approvalFor(s,{action:'handoff'},s.revision,{proof:'manual-network:'+s.raw.fingerprint,risk:'consequential',role:'browser',name:'Manual browsing: temporary same-origin network access',origin,details:['Automation stays paused. Website scripts may send, change or delete before any human click, until resume or expiry.','Maximum duration: 120 seconds. This is a temporary manual-session grant, not approval of only one form request.']}))!;
    }
    await this.invalidateApproval(s.id);this.inputProofs.invalidateSession(s.id);delete s.latestFrame;
    if(command==='pause')s.paused=true;
    try{
      await this.deadline(sig=>{if(!this.operationAllowed()||cancel?.aborted||command==='pause'&&expires<=Date.now())throw new AdlError('E_POLICY_DENIED');return s.adapter.handoff!(command==='pause',sig,command==='pause'?expires:undefined);},this.policy.actionTimeoutMs,cancel,s);
      await this.refresh(s,cancel);s.revision++;this.snapshots.record(s.id,s.revision,s.raw);this.recordActionEvidence(s);
    }catch(error){await s.adapter.handoff(false,new AbortController().signal).catch(()=>undefined);throw error;}
    s.paused=command==='pause';
    return {ok:true,session_id:s.id,paused:s.paused,revision:s.revision,...(s.paused?{manual_network_expires_at:new Date(expires).toISOString()}:{}),instructions:s.paused?'Use the visible isolated browser to sign in or finish the manual step. This origin may send requests during the approved manual interval. Resume afterward and observe again.':'Observe again and use the new revision before acting.'};
  });}
  listTargets(surface?:string,cancel?:AbortSignal) {return this.enqueue(async()=>{
    if(surface!=='browser'&&this.adapters.desktop?.discover){
      try{this.replaceDesktopTargets(await this.enqueueDesktop(()=>this.deadline(signal=>this.adapters.desktop!.discover!(signal),this.policy.actionTimeoutMs,cancel)));}
      catch(error){this.replaceDesktopTargets([]);throw error;}
    }
    return {ok:true,targets:[...this.targets.values()].filter(t=>!surface||t.surface===surface)};
  });}
  private enqueue<T>(fn:()=>Promise<T>):Promise<T> {return this.runQueued(this.queue,p=>{this.queue=p;},fn);}
  private enqueueSession<T>(session_id:string,fn:()=>Promise<T>):Promise<T> {
    const prior=this.sessionQueues.get(session_id)??Promise.resolve();
    let tail:Promise<unknown>|undefined;
    return this.runQueued(prior,p=>{tail=p;this.sessionQueues.set(session_id,p);},fn).finally(()=>{if(tail&&this.sessionQueues.get(session_id)===tail)this.sessionQueues.delete(session_id);});
  }
  private enqueueDesktop<T>(fn:()=>Promise<T>):Promise<T> {
    const prior=this.desktopLane??Promise.resolve();
    let tail:Promise<unknown>|undefined;
    return this.runQueued(prior,p=>{tail=p;this.desktopLane=p;},fn).finally(()=>{if(tail&&this.desktopLane===tail)this.desktopLane=undefined;});
  }
  private runQueued<T>(chain:Promise<unknown>,bind:(tail:Promise<unknown>)=>void,fn:()=>Promise<T>):Promise<T> {
    if(this.stopped||!this.operationAllowed())return Promise.reject(new AdlError('E_CANCELLED',this.stopped||!this.operationAllowed()?'emergency_stop':undefined));
    if(this.queued>=64)return Promise.reject(new AdlError('E_RESOURCE_LIMIT'));
    this.queued++;
    const run=chain.then(()=>{if(this.stopped||!this.operationAllowed())throw new AdlError('E_CANCELLED',this.stopped||!this.operationAllowed()?'emergency_stop':undefined);return fn();});
    bind(run.catch(()=>{}));return run.finally(()=>{this.queued--;});
  }
  private sessionLane<T>(session_id:string,fn:()=>Promise<T>):Promise<T> {
    const s=this.sessions.get(session_id);
    if(s?.target.surface==='desktop')return this.enqueueDesktop(fn);
    return this.enqueueSession(session_id,fn);
  }
  private get(id:string):Session {
    const s=this.sessions.get(id);if(!s||s.expires<=Date.now())throw new AdlError('E_TARGET_NOT_FOUND');
    s.expires=Date.now()+this.policy.sessionTtlMs;
    return s;
  }
  private async audit(event:string, fields:{session_id?:string;task_id?:string;action?:string;code?:string}={}) {
    const audit_id=`a_${randomUUID()}`;
    if(this.policy.auditPath){await mkdir(dirname(this.policy.auditPath),{recursive:true,mode:0o700});await appendFile(this.policy.auditPath,JSON.stringify({audit_id,time:new Date().toISOString(),event,...fields})+'\n',{mode:0o600});await chmod(this.policy.auditPath,0o600);}
    return audit_id;
  }
  private async destroy(s:Session){
    this.sessions.delete(s.id);this.snapshots.close(s.id);this.visuals.dropSession(s.id);this.inputProofs.invalidateSession(s.id);
    await this.invalidateApproval(s.id);
    await this.stopAdapter(s.adapter);
  }
  private async invalidateApproval(sessionId:string){const entry=this.approvalPending.get(sessionId);if(!entry)return;this.approvalPending.delete(sessionId);this.approvalTerminal.set(entry.binding,entry.expires_at);await this.approval?.request('DELETE',`/v1/requests/${entry.request_id}`,entry).catch(()=>undefined);}
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
    const interruption=()=>new AdlError(timedOut?'E_TIMEOUT':'E_CANCELLED',!timedOut&&(this.stopped||!this.operationAllowed())?'emergency_stop':undefined);
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeout);
    let listener:()=>void=()=>{};
    const aborted=new Promise<never>((_,reject)=>{listener=()=>reject(interruption());signal.addEventListener('abort',listener,{once:true});if(signal.aborted)listener();});
    try {return await Promise.race([signal.aborted?aborted:operation(signal),aborted]);}
    catch(error) {if(signal.aborted && session)await this.destroy(session);if(signal.aborted)throw interruption();throw error;}
    finally {clearTimeout(timer);signal.removeEventListener('abort',listener);}
  }
  private async refresh(s:Session,signal?:AbortSignal,preserve=false){
    const raw=this.boundSnapshot(await this.deadline(sig=>s.adapter.snapshot(sig),this.policy.actionTimeoutMs,signal,preserve?undefined:s));
    if(raw.fingerprint!==s.raw.fingerprint||raw.actionEvidence&&s.actionHistory.get(s.revision)?.epoch!==s.actionEpoch){s.revision++;s.raw=raw;this.snapshots.record(s.id,s.revision,raw);this.recordActionEvidence(s);}
    return s.revision;
  }
  private recordActionEvidence(s:Session){
    if(s.target.surface!=='browser'||!s.raw.actionEvidence)return;
    s.actionHistory.set(s.revision,{epoch:s.actionEpoch,evidence:s.raw.actionEvidence});
    const pinned=this.approvalPending.get(s.id)?.baselineRevision;
    while(s.actionHistory.size>32){const oldest=[...s.actionHistory.keys()].find(revision=>revision!==pinned)!;s.actionHistory.delete(oldest);}
  }
  private boundSnapshot(raw:RawSnapshot):RawSnapshot{return {...raw,elements:raw.elements.slice(0,20000),truncated:raw.truncated||raw.elements.length>20000,...(raw.actionEvidence?{actionEvidence:{navigation:raw.actionEvidence.navigation,elements:{...raw.actionEvidence.elements}}}:{})};}
  openUrl(url:string,mode:Mode='strict_isolated',cancel?:AbortSignal){
    if(this.stopped||!this.operationAllowed()||cancel?.aborted)return Promise.reject(new AdlError('E_CANCELLED',this.stopped||!this.operationAllowed()?'emergency_stop':undefined));
    let parsed:URL;try{parsed=new URL(url);}catch{return Promise.reject(new AdlError('E_INVALID_ARGUMENT'));}
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||url.length>2048)return Promise.reject(new AdlError('E_INVALID_ARGUMENT'));
    // Origin and network grants are both checked before any catalogue mutation or open; the
    // extension profile sets restrictTargets so allowAllOperations cannot bypass them.
    return this.deadline(()=>assertUrlAllowed(url,this.policy),this.policy.actionTimeoutMs,cancel).then(()=>this.enqueue(async()=>{
      if(cancel?.aborted)throw new AdlError('E_CANCELLED',this.stopped||!this.operationAllowed()?'emergency_stop':undefined);
      return this.openInternal(this.openGranted(parsed),mode,cancel);
    }));
  }
  private openGranted(parsed:URL):Target{
    const origin=parsed.origin;
    // A bounded per-process target catalogue lets clients open a URL without a policy file.
    let config=this.policy.browserTargets.find(t=>new URL(t.url).href===parsed.href);
    if(!config){
      const granted=this.policy.browserTargets.find(t=>new URL(t.url).origin===origin);
      if(!granted&&(!this.policy.allowAllOperations||this.policy.restrictTargets))throw new AdlError('E_POLICY_DENIED');
      if(this.policy.browserTargets.length>=64)throw new AdlError('E_RESOURCE_LIMIT');
      // Preserve the exact requested path without mutating another live target's
      // configuration; inherit only permissions already granted to this origin.
      config={...(granted??{label:origin,classification:'PUBLIC' as const,visual:{enabled:true,maskSelectors:[]},gestures:{enabled:true,surfaces:[{id:'page',selector:'body',kinds:['drag' as const,'swipe' as const]}]}}),id:`browser_${randomUUID()}`,url:parsed.href};
      this.policy.browserTargets.push(config);
      const target:Target={target_id:`t_${randomUUID()}`,surface:'browser',application_id:config.id,label:redactString(config.label),policy_class:config.classification,capabilities:this.browserCapabilities(config)};
      this.targets.set(target.target_id,target);
    }
    const target=[...this.targets.values()].find(t=>t.application_id===config!.id);if(!target)throw new AdlError('E_TARGET_NOT_FOUND');return target;
  }
  open(target_id:string,mode:Mode='strict_isolated',cancel?:AbortSignal) {return this.enqueue(async()=>{
    const target=this.targets.get(target_id);if(!target)throw new AdlError('E_TARGET_NOT_FOUND');
    return target.surface==='desktop'?this.enqueueDesktop(()=>this.openInternal(target,mode,cancel)):this.openInternal(target,mode,cancel);
  });}
  private async openInternal(target:Target,mode:Mode,cancel?:AbortSignal){
    if(this.sessions.size>=this.policy.maxSessions)throw new AdlError('E_RESOURCE_LIMIT');
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
      instance=await this.deadline(async signal=>{const opened=await adapter.open(target,mode,signal);if(signal.aborted){void this.stopAdapter(opened);throw new AdlError('E_CANCELLED',this.stopped||!this.operationAllowed()?'emergency_stop':undefined);}return opened;},this.policy.actionTimeoutMs,cancel);
      const raw=this.boundSnapshot(await this.deadline(sig=>instance!.snapshot(sig),this.policy.actionTimeoutMs,cancel));
      const s:Session={id:`s_${randomUUID()}`,target,adapter:instance,mode,revision:1,raw,expires:Date.now()+this.policy.sessionTtlMs,actionEpoch:0,actionHistory:new Map()};
      await this.audit('open',{session_id:s.id});
      if(this.stopped||this.master.signal.aborted||cancel?.aborted)throw new AdlError('E_CANCELLED',this.stopped||!this.operationAllowed()?'emergency_stop':undefined);
      this.sessions.set(s.id,s);this.snapshots.record(s.id,1,raw);this.recordActionEvidence(s);
      return {ok:true,session_id:s.id,revision:1,capabilities:instance.capabilities??target.capabilities,mode};
    }catch(error){if(instance)await this.stopAdapter(instance);throw error;}
  }
  capture(session_id:string,options:VisualRequest={},cancel?:AbortSignal):Promise<VisualObservation>{return this.sessionLane(session_id,async()=>{
    const s=this.get(session_id);
    const parsed=visualRequestSchema.safeParse(options);if(!parsed.success)throw new AdlError('E_INVALID_ARGUMENT');
    this.assertCaptureAllowed(s);
    return this.deadline(async signal=>{
      if(signal.aborted)throw new AdlError('E_CANCELLED',this.stopped||!this.operationAllowed()?'emergency_stop':undefined);
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
    if(signal.aborted||this.stopped||!this.sessions.has(s.id))throw new AdlError('E_CANCELLED',this.stopped||!this.operationAllowed()?'emergency_stop':undefined);
    const id=await this.visuals.record({session_id:s.id,target_id:s.target.target_id,revision:s.revision},image,signal);
    try{
      if(signal.aborted||this.stopped||!this.sessions.has(s.id))throw new AdlError('E_CANCELLED',this.stopped||!this.operationAllowed()?'emergency_stop':undefined);
      await this.audit('capture',{session_id:s.id});
      if(signal.aborted)throw new AdlError('E_CANCELLED',this.stopped||!this.operationAllowed()?'emergency_stop':undefined);
      const observation=await this.visuals.view(s.id,id,view,signal);s.latestFrame=id;return observation;
    }catch(error){this.visuals.discard(s.id,id);throw error;}
  }
  record(session_id:string,options:SequenceOptions={},cancel?:AbortSignal):Promise<SequenceObservation>{return this.sessionLane(session_id,async()=>{
    const s=this.get(session_id);const parsed=sequenceRequestSchema.safeParse(options);if(!parsed.success)throw new AdlError('E_INVALID_ARGUMENT');this.assertCaptureAllowed(s);
    return this.deadline(signal=>recordSequence({
      capture:(view,sig)=>this.captureFrame(s,view,sig),
      assertRetained:async id=>{this.visuals.assertRetained(s.id,id);},
      discard:ids=>{for(const id of ids)this.visuals.discard(s.id,id);if(s.latestFrame&&ids.includes(s.latestFrame))delete s.latestFrame;},
    },parsed.data,signal),Math.min(30000,this.policy.actionTimeoutMs+6000),cancel,s).catch(async error=>{if(error instanceof AdlError&&['E_TIMEOUT','E_CANCELLED'].includes(error.code))await this.destroy(s);throw error;});
  });}
  gesture(session_id:string,request:GestureRequest,cancel?:AbortSignal):Promise<VisualObservation&{metadata:VisualObservation['metadata']&{gesture:GestureExecution}}>{return this.sessionLane(session_id,async()=>{
    const s=this.get(session_id);const parsed=gestureRequestSchema.safeParse(request);if(!parsed.success)throw new AdlError('E_INVALID_ARGUMENT');
    if(s.paused)throw new AdlError('E_POLICY_DENIED');
    if(s.target.surface==='browser'&&this.policy.operationMode==='read_only'&&!this.policy.allowAllOperations)throw new AdlError('E_POLICY_DENIED');
    this.assertCaptureAllowed(s);
    if(!s.adapter.gesture)throw new AdlError('E_UNSUPPORTED_ACTION');
    if(s.target.surface==='browser'){
      const config=this.policy.browserTargets.find(t=>t.id===s.target.application_id);if(!config?.gestures?.enabled)throw new AdlError('E_POLICY_DENIED');
      if(parsed.data.swipe_backend==='scroll'||parsed.data.kind==='drag'&&parsed.data.swipe_backend)throw new AdlError('E_UNSUPPORTED_ACTION');
    }else{
      if(s.mode!=='interactive_desktop'||!this.desktopConfig()?.interactive?.enabled)throw new AdlError('E_INTERFERENCE_RISK');
    }
    const {frame_id,expected_revision,...plan}=parsed.data;
    this.visuals.assertRetained(s.id,frame_id,s.target.surface==='browser'?30000:5000);
    if(frame_id!==s.latestFrame)throw new AdlError('E_STALE_STATE');
    let dispatched=false;
    return this.deadline(async signal=>{
      await this.refresh(s,signal);if(s.revision!==expected_revision)throw new AdlError('E_STALE_STATE');
      const {metadata:reference}=await this.visuals.view(s.id,frame_id,{max_dimension:64,max_pixels:4096},signal);
      if(reference.revision!==s.revision)throw new AdlError('E_STALE_STATE');
      await this.audit('gesture_started',{session_id:s.id,action:plan.kind});
      this.visuals.assertRetained(s.id,frame_id,s.target.surface==='browser'?30000:5000);
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
  prepareInput(session_id:string,request:PrepareInputRequest,cancel?:AbortSignal):Promise<PreparedObservation>{return this.sessionLane(session_id,async()=>{
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
      if(signal.aborted||!this.sessions.has(s.id))throw new AdlError('E_CANCELLED',this.stopped||!this.operationAllowed()?'emergency_stop':undefined);
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
      if(signal.aborted){this.inputProofs.invalidateSession(s.id);throw new AdlError('E_CANCELLED',this.stopped||!this.operationAllowed()?'emergency_stop':undefined);}
      return {metadata:{...prepared,...proof,ok:true as const,session_id:s.id,revision:s.revision},...(image?{image}:{})};
    },this.policy.actionTimeoutMs,cancel,s).catch(async error=>{this.inputProofs.invalidateSession(s.id);if(dispatched&&error instanceof AdlError&&['E_TIMEOUT','E_CANCELLED'].includes(error.code))error.mayHaveExecuted=true;if(error instanceof AdlError&&(error.mayHaveExecuted||['E_TIMEOUT','E_CANCELLED'].includes(error.code)))await this.destroy(s);throw error;});
  });}
  commitInput(session_id:string,request:CommitInputRequest,cancel?:AbortSignal):Promise<VisualObservation&{metadata:VisualObservation['metadata']&{input:InputExecution}}>{return this.sessionLane(session_id,async()=>{
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
  observe(session_id:string,options:Omit<ObserveOptions,'token_budget'|'element_limit'>&{token_budget?:number}={},cancel?:AbortSignal):Promise<ObserveResult> {return this.sessionLane(session_id,async()=>{
    const s=this.get(session_id);
    if(options.depth!==undefined){if(s.target.surface!=='browser')throw new AdlError('E_UNSUPPORTED_ACTION');if(!Number.isSafeInteger(options.depth)||options.depth<1||options.depth>12)throw new AdlError('E_INVALID_ARGUMENT');}
    await this.refresh(s,cancel);
    if(options.text){
      if(s.target.surface!=='browser'||!s.adapter.readText)throw new AdlError('E_UNSUPPORTED_ACTION');
      if(options.cursor!==undefined||options.since_revision!==undefined||options.scope!==undefined||options.include!==undefined||options.depth!==undefined||options.format!==undefined||options.representation!==undefined)throw new AdlError('E_INVALID_ARGUMENT');
      const {element_id,offset=0,length=4096}=options.text,budget=options.token_budget??this.policy.defaultTokenBudget;
      if(!Number.isInteger(offset)||offset<0||offset>1048576||!Number.isInteger(length)||length<1||length>8192||!Number.isInteger(budget)||budget<256||budget>8000)throw new AdlError('E_INVALID_ARGUMENT');
      if(!s.raw.elements.some(e=>e.id===element_id))throw new AdlError('E_TARGET_NOT_FOUND');
      const read=await this.deadline(sig=>s.adapter.readText!(element_id,offset,length,sig),this.policy.actionTimeoutMs,cancel);
      const chars=Array.from(read.text);
      const make=(count:number):ObserveResult=>{
        const content=chars.slice(0,count).join(''),next=offset+content.length<read.total_length?offset+content.length:null;
        return {ok:true,session_id:s.id,revision:s.revision,redactions:(content.match(/\[redacted\]/g)??[]).length,truncated:read.truncated||next!==null,next_cursor:null,text:{element_id,offset,content,total_length:read.total_length,next_offset:next,truncated:read.truncated||next!==null}};
      };
      let lo=0,hi=chars.length;
      while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(Buffer.byteLength(JSON.stringify(make(mid)),'utf8')<=budget*4)lo=mid;else hi=mid-1;}
      if(!lo&&chars.length)throw new AdlError('E_RESOURCE_LIMIT');
      return make(lo);
    }
    return this.snapshots.observe(s.id,s.revision,{...options,token_budget:options.token_budget??this.policy.defaultTokenBudget,element_limit:this.policy.maxElements});
  });}
  async approvals(requestId?:string){
    if(!this.approval)return {ok:true,requests:[]};
    const rows=[...this.approvalPending.values()].filter(p=>!requestId||p.request_id===requestId);
    const requests=[];
    for(const entry of rows){
      const reply=await this.approval.request('GET',`/v1/requests/${entry.request_id}`,entry);
      requests.push({request_id:entry.request_id,status:reply.status,expires_at:entry.expires_at,summary:entry.summary});
    }
    return {ok:true,requests};
  }
  private async approvalFor(s:Session,action:Omit<Action,'action'>&{action:string},expected:number,proof:{proof:string;risk:'ordinary'|'credential'|'consequential';role:string;name:string;origin:string;details?:string[]},actionEvidence?:{navigation:string;element?:string}){
    if(!this.operationAllowed())throw new AdlError('E_CANCELLED','emergency_stop');
    if(!this.approval)throw new AdlError('E_APPROVAL_REQUIRED','approval_unavailable');
    const existing=this.approvalPending.get(s.id);
    const freshness=actionEvidence?{actionEvidence,actionEpoch:s.actionEpoch}:{revision:expected,fingerprint:s.raw.fingerprint};
    const binding=createHmac('sha256',this.approvalKey).update(JSON.stringify(canonical({action,session:s.id,target:s.target.target_id,...freshness,proof:proof.proof,epoch:this.approval.epoch,server:this.approvalServerId}))).digest('hex');
    for(const [key,expires]of this.approvalTerminal)if(expires<=Date.now())this.approvalTerminal.delete(key);
    if(this.approvalTerminal.has(binding))throw new AdlError('E_POLICY_DENIED');
    if(existing){
      if(existing.binding!==binding||existing.expires_at<=Date.now()){
        this.approvalPending.delete(s.id);await this.approval.request('DELETE',`/v1/requests/${existing.request_id}`,existing).catch(()=>undefined);throw new AdlError('E_STALE_STATE');
      }
      const reply=await this.approval.request('GET',`/v1/requests/${existing.request_id}`,existing);
      if(reply.status==='pending'){const error=new AdlError('E_APPROVAL_REQUIRED');error.requestId=existing.request_id;throw error;}
      this.approvalPending.delete(s.id);
      this.approvalTerminal.set(binding,existing.expires_at);
      if(reply.status!=='approved'||!this.operationAllowed())throw new AdlError('E_POLICY_DENIED');
      const consumed=await this.approval.request('DELETE',`/v1/requests/${existing.request_id}`,existing);
      if(consumed.status!=='consumed'||consumed.consumed_now!==true||!this.operationAllowed()||existing.expires_at<=Date.now())throw new AdlError('E_POLICY_DENIED');
      return existing.expires_at;
    }
    for(const entry of this.approvalPending.values())if(entry.expires_at<=Date.now())this.approvalPending.delete(entry.session_id);
    if(this.approvalPending.size>=8||this.approvalTerminal.size+this.approvalPending.size>=128)throw new AdlError('E_RESOURCE_LIMIT');
    const raw=action.value,value=typeof raw==='string'?describeApprovalValue(raw,proof.risk==='credential'):undefined;
    const summary:ApprovalSummary={action:action.action,surface:s.target.surface,target:redactString(s.target.label).slice(0,128),origin:proof.origin,role:redactString(proof.role).slice(0,100),name:redactString(proof.name).slice(0,128),risk:value?.kind==='secret'||proof.risk==='credential'?'credential':'consequential',...(proof.details?{details:proof.details}:{}),...(value?{value}:{})};
    const entry:PendingApproval={request_id:randomUUID(),binding,expires_at:Date.now()+120000,session_id:s.id,summary,...(actionEvidence?{baselineRevision:expected}:{})};
    this.approvalPending.set(s.id,entry);
    try{const reply=await this.approval.request('POST','/v1/requests',entry,{v:1,request_id:entry.request_id,server_id:this.approvalServerId,control_epoch:this.approval.epoch,binding,expires_at:entry.expires_at,summary});if(reply.status!=='pending')throw new AdlError('E_POLICY_DENIED');}
    catch(error){this.approvalPending.delete(s.id);throw error;}
    const error=new AdlError('E_APPROVAL_REQUIRED');error.requestId=entry.request_id;throw error;
  }
  private async action(s:Session,action:Action,expected:number,signal?:AbortSignal){
    action={...action,...(action.expected_target?{expected_target:{...action.expected_target}}:{}),...(action.point?{point:{...action.point}}:{})};
    this.validateAction(action,s.target.surface);if(!Number.isSafeInteger(expected)||expected<1)throw new AdlError('E_INVALID_ARGUMENT');
    await this.refresh(s,signal,s.target.surface==='browser');
    let actionEvidence:{navigation:string;element?:string}|undefined;
    if(s.target.surface==='browser'&&!action.point&&['click','fill','select','check','press','scroll','navigate','back','hover'].includes(action.action)){
      const prior=s.actionHistory.get(expected),current=s.raw.actionEvidence;
      const navigationOnly=action.action==='navigate'||action.action==='back';
      if(prior&&current&&prior.epoch===s.actionEpoch&&prior.evidence.navigation===current.navigation&&
        (navigationOnly||action.element_id&&prior.evidence.elements[action.element_id]!==undefined&&prior.evidence.elements[action.element_id]===current.elements[action.element_id])){
        actionEvidence={navigation:current.navigation,...(!navigationOnly?{element:current.elements[action.element_id!]}:{})};
      }
    }
    if(!['read_state','wait_for'].includes(action.action)&&s.revision!==expected&&!actionEvidence){await this.invalidateApproval(s.id);throw new AdlError('E_STALE_STATE');}
    if(action.action==='read_state')return {ok:true,revision:s.revision};
    if(action.action==='wait_for')return this.waitInternal(s,{role:action.role,name:action.name,element_id:action.element_id},action.timeout_ms??this.policy.actionTimeoutMs,signal);
    if(s.paused)throw new AdlError('E_POLICY_DENIED');
    if(s.target.surface==='browser'&&this.policy.operationMode==='read_only'&&!this.policy.allowAllOperations&&!['navigate','back','scroll'].includes(action.action))throw new AdlError('E_POLICY_DENIED','operation_not_granted');
    if(s.mode==='interactive_desktop')throw new AdlError('E_UNSUPPORTED_ACTION');
    let pointReference:import('./gesture-types.js').GestureReference|undefined,directPoint=false;
    if(action.point){
      if(s.target.surface!=='browser'||!s.adapter.resolvePoint)throw new AdlError('E_UNSUPPORTED_ACTION');
      this.visuals.assertRetained(s.id,action.point.frame_id,30000);if(s.latestFrame!==action.point.frame_id)throw new AdlError('E_STALE_STATE');
      const {metadata}=await this.visuals.view(s.id,action.point.frame_id,{max_dimension:64,max_pixels:4096},signal??this.master.signal);
      if(metadata.revision!==s.revision)throw new AdlError('E_STALE_STATE');pointReference=metadata;
      const id=await s.adapter.resolvePoint(action.point,metadata,signal??this.master.signal);
      if(id)action={...action,element_id:id};else {if(!this.policy.allowAllOperations||!s.adapter.clickPoint)throw new AdlError('E_APPROVAL_REQUIRED','operation_not_granted');directPoint=true;}
    }
    const element=action.element_id?s.raw.elements.find(e=>e.id===action.element_id):undefined;
    if(!directPoint&&!['navigate','back'].includes(action.action)&&!element)throw new AdlError('E_TARGET_NOT_FOUND');
    if(action.expected_target&&(!element||(action.expected_target.role!==undefined&&action.expected_target.role!==element.role)||(action.expected_target.name!==undefined&&action.expected_target.name!==redactElement(element,this.policy.allowPersonalData).name)))throw new AdlError('E_STALE_STATE');
    const modern=!this.policy.allowAllOperations&&['standard','ask'].includes(this.policy.operationMode??'read_only')&&s.target.surface==='browser'&&!['navigate','back','scroll'].includes(action.action);
    let liveProof:{proof:string;risk:'ordinary'|'credential'|'consequential';role:string;name:string;origin:string;details?:string[]}|undefined;
    let approved=false,approvalExpires:number|undefined;
    if(modern){
      if(!s.adapter.prepareAction)throw new AdlError('E_POLICY_DENIED');
      authorizeAction(action,element,true);
      liveProof=await s.adapter.prepareAction(action,signal??this.master.signal);
      if(element?.sensitive)liveProof={...liveProof,risk:'credential'};
      const sensitiveValue=typeof action.value==='string'&&describeApprovalValue(action.value).kind==='secret';
      if(liveProof.risk!=='ordinary'||sensitiveValue){if(this.policy.operationMode!=='ask')throw new AdlError('E_APPROVAL_REQUIRED','requires_ask_mode');approvalExpires=await this.approvalFor(s,action,expected,liveProof,actionEvidence);approved=true;}
    }else if(!directPoint)authorizeAction(action,element,this.policy.allowAllOperations);
    this.inputProofs.invalidateSession(s.id);
    await this.audit('action_started',{session_id:s.id,action:action.action});
    let acknowledged=false,dispatched=false;
    const beforeRevision=s.revision,beforeBlocks=(s.raw.warnings??[]).reduce((n,w)=>n+w.count,0);
    try {
      await this.deadline(sig=>{const dispatch=()=>{if(sig.aborted||!this.operationAllowed()||approvalExpires!==undefined&&approvalExpires<=Date.now())throw new AdlError('E_POLICY_DENIED');if(!dispatched)s.actionEpoch++;dispatched=true;};if(!s.adapter.tracksDispatch)dispatch();if(directPoint)return s.adapter.clickPoint!(action.point!,pointReference!,sig,dispatch);return s.adapter.act(action,sig,dispatch,liveProof||pointReference||actionEvidence?{...(liveProof?{normalOperations:true,approvalProof:liveProof.proof,approved,...(approvalExpires!==undefined?{expires_at:approvalExpires}:{})}:{}),...(pointReference?{pointReference}:{}),...(actionEvidence?{actionEvidence}:{})}:undefined);},Math.min(action.timeout_ms??this.policy.actionTimeoutMs,this.policy.actionTimeoutMs),signal);
      acknowledged=true;
      delete s.latestFrame;
      await this.refresh(s,signal);
      const audit_id=await this.audit('action_completed',{session_id:s.id,action:action.action});
      const warnings=s.raw.warnings??[],networkBlocked=warnings.reduce((n,w)=>n+w.count,0)>beforeBlocks;
      let observation:ObserveResult|undefined,observation_error:ReturnType<typeof safeError>|undefined;
      if(action.include_diff){try{observation=this.snapshots.observe(s.id,s.revision,{token_budget:this.policy.defaultTokenBudget,since_revision:beforeRevision,element_limit:this.policy.maxElements,representation:'delta'});}catch(error){observation_error=safeError(error);}}
      return {ok:true,session_id:s.id,revision:s.revision,audit_id,...(networkBlocked?{network_blocked:true}:{}),...(warnings.length?{warnings}:{}),...(observation?{observation}:{}),...(observation_error?{observation_error}:{})};
    }catch(error){const safe=error instanceof AdlError?error:new AdlError('E_INTERNAL');if(acknowledged||dispatched&&!(error instanceof NativeError)&&(safe.code==='E_TIMEOUT'||safe.code==='E_CANCELLED'||!(error instanceof AdlError)))safe.mayHaveExecuted=true;if(safe.mayHaveExecuted)await this.destroy(s);throw safe;}
  }
  act(session_id:string,action:Action,expected_revision:number,cancel?:AbortSignal){const captured={...action,...(action.expected_target?{expected_target:{...action.expected_target}}:{}),...(action.point?{point:{...action.point}}:{})};return this.sessionLane(session_id,()=>this.action(this.get(session_id),captured,expected_revision,cancel));}
  private async waitInternal(s:Session,condition:Condition,timeout:number,cancel?:AbortSignal){
    if(!condition.role&&!condition.name&&!condition.element_id)throw new AdlError('E_INVALID_ARGUMENT');
    return this.deadline(async signal=>{
      while(true){
        await this.refresh(s,signal,true);
        const element=s.raw.elements.map(e=>redactElement(e,this.policy.allowPersonalData)).find(e=>(!condition.element_id||e.id===condition.element_id)&&(!condition.role||e.role===condition.role)&&(!condition.name||e.name.includes(condition.name)));
        const matched=condition.state==='hidden'?!element:condition.state==='enabled'?!!element?.enabled:!!element;
        if(matched)return {ok:true,session_id:s.id,revision:s.revision,matched:true};
        await delay(50,undefined,{signal});
      }
    },Math.min(timeout,30000),cancel).catch(async error=>{if(error instanceof AdlError&&error.code==='E_CANCELLED')await this.destroy(s);throw error;});
  }
  wait(session_id:string,condition:Condition,timeout_ms:number,cancel?:AbortSignal){return this.sessionLane(session_id,()=>this.waitInternal(this.get(session_id),condition,timeout_ms,cancel));}
  private validateAction(action:Action,surface:'browser'|'desktop'){
    if(action.include_diff!==undefined&&typeof action.include_diff!=='boolean')throw new AdlError('E_INVALID_ARGUMENT');
    if(!['click','fill','select','check','scroll','navigate','read_state','wait_for','press','back','hover'].includes(action.action))throw new AdlError('E_INVALID_ARGUMENT');
    if(['press','back','hover'].includes(action.action)&&surface!=='browser')throw new AdlError('E_UNSUPPORTED_ACTION');
    if(action.action==='press'&&!['Enter','Escape','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Space'].includes(action.value??''))throw new AdlError('E_INVALID_ARGUMENT');
    if(action.action==='navigate'){try{const url=new URL(action.url!);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error();}catch{throw new AdlError('E_INVALID_ARGUMENT');}}
    if((action.action==='fill'||(action.action==='select'&&surface==='browser'))&&typeof action.value!=='string')throw new AdlError('E_INVALID_ARGUMENT');
    if(action.action==='scroll'&&surface==='desktop'&&!action.direction)throw new AdlError('E_INVALID_ARGUMENT');
    if(action.action==='check'&&typeof action.checked!=='boolean')throw new AdlError('E_INVALID_ARGUMENT');
    if(action.point&&(action.action!=='click'||surface!=='browser'||typeof action.point.frame_id!=='string'||!action.point.frame_id||![action.point.x,action.point.y].every(v=>Number.isFinite(v)&&v>=0&&v<4096)||action.element_id))throw new AdlError('E_INVALID_ARGUMENT');
    if(['click','fill','select','check','scroll','press','hover'].includes(action.action)&&!action.element_id&&!action.point)throw new AdlError('E_INVALID_ARGUMENT');
    if(action.direction!==undefined&&!['up','down'].includes(action.direction))throw new AdlError('E_INVALID_ARGUMENT');
    if(action.timeout_ms!==undefined&&(!Number.isSafeInteger(action.timeout_ms)||action.timeout_ms<1))throw new AdlError('E_INVALID_ARGUMENT');
    if(action.action==='wait_for'&&!action.role&&!action.name&&!action.element_id)throw new AdlError('E_INVALID_ARGUMENT');
    if(action.expected_target&&!expectedTargetSchema.safeParse(action.expected_target).success)throw new AdlError('E_INVALID_ARGUMENT');
  }
  execute(steps:Step[],expected_revisions:Record<string,number>) {
    if(this.stopped||!this.operationAllowed())throw new AdlError('E_CANCELLED',this.stopped||!this.operationAllowed()?'emergency_stop':undefined);
    if(!steps.length||steps.length>this.policy.maxBatchSteps)throw new AdlError('E_INVALID_ARGUMENT');
    // Validation and asynchronous execution must use the same caller-independent plan.
    steps=steps.map(step=>({...step,...(step.expected_target?{expected_target:{...step.expected_target}}:{}),...(step.point?{point:{...step.point}}:{}),...(step.condition?{condition:{...step.condition}}:{})}));
    expected_revisions={...expected_revisions};
    for(const step of steps){
      this.get(step.session_id);const expected=expected_revisions[step.session_id];
      if(!Number.isSafeInteger(expected)||(expected??0)<1||step.expected_revision!==undefined&&(!Number.isSafeInteger(step.expected_revision)||step.expected_revision<1))throw new AdlError('E_INVALID_ARGUMENT');
      this.validateAction(step,this.get(step.session_id).target.surface);
    }
    if(this.tasks.size>=128){const done=[...this.tasks.values()].find(t=>!['queued','running'].includes(t.status));if(done)this.tasks.delete(done.id);else throw new AdlError('E_RESOURCE_LIMIT');}
    const task:Task={id:`task_${randomUUID()}`,status:'queued',controller:new AbortController(),results:[],created:Date.now()};this.tasks.set(task.id,task);
    void Promise.resolve().then(async()=>{
      if(task.controller.signal.aborted)throw new AdlError('E_CANCELLED',this.stopped||!this.operationAllowed()?'emergency_stop':undefined);
      task.status='running';const expected={...expected_revisions};
      for(const [step_index,step] of steps.entries()){
        if(task.controller.signal.aborted)throw new AdlError('E_CANCELLED',this.stopped||!this.operationAllowed()?'emergency_stop':undefined);
        try{
          const result=await this.sessionLane(step.session_id,async()=>{const s=this.get(step.session_id);const outcome=await this.action(s,step,step.expected_revision??expected[s.id]!,task.controller.signal);expected[s.id]=s.revision;return outcome;});
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
  close(session_id:string){return this.sessionLane(session_id,async()=>{const s=this.get(session_id);await this.destroy(s);return {ok:true,closed:true};});}
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
  application(application_id:string,action:'status'|'launch'|'quit',cancel?:AbortSignal){return this.enqueue(()=>this.enqueueDesktop(async()=>{
    if(this.stopped||!this.operationAllowed())throw new AdlError('E_CANCELLED',this.stopped||!this.operationAllowed()?'emergency_stop':undefined);
    const adapter=this.lifecycleAdapter();
    if(!adapter||action!=='status'&&action!=='launch'&&action!=='quit')throw new AdlError('E_POLICY_DENIED');
    if(!this.lifecyclePlatformSupported())throw new AdlError('E_UNSUPPORTED_ACTION');
    const config=this.desktopConfig()!;
    if(application_id!==config.appId)throw new AdlError('E_POLICY_DENIED');
    let dispatched=false;
    const state=await this.deadline(async signal=>{dispatched=true;return adapter.application!(application_id,action,signal);},this.policy.actionTimeoutMs,cancel).catch((error:unknown)=>{if(action!=='status'&&dispatched&&error instanceof AdlError&&(cancel?.aborted||this.master.signal.aborted||error.code==='E_TIMEOUT'||error.code==='E_CANCELLED'))error.mayHaveExecuted=true;throw error;});
    try{
      // An acknowledged quit has already changed native state. Retire its
      // handles even if the subsequent audit write fails.
      if(action==='quit'&&state.changed){
        for(const s of [...this.sessions.values()])if(s.target.surface==='desktop'&&s.target.application_id===config.appId)await this.destroy(s);
        this.replaceDesktopTargets([]);
      }
      await this.audit('application_lifecycle',{action});
      return {ok:true,application_id,...state};
    }catch(error){
      const safe=error instanceof AdlError?error:new AdlError('E_INTERNAL');
      if(action!=='status'&&state.changed)safe.mayHaveExecuted=true;
      throw safe;
    }
  }));}
  shutdown():Promise<void>{
    if(this.shutdownPromise)return this.shutdownPromise;
    this.stopped=true;
    // Publish the shared completion before abort listeners or adapter callbacks
    // can reenter shutdown. Every caller waits for all cleanup attempts.
    this.shutdownPromise=Promise.resolve().then(async()=>{
      await Promise.allSettled([...this.sessions.values()].map(s=>this.destroy(s)));
      await Promise.allSettled([this.adapters.browser,this.adapters.desktop].map(adapter=>Promise.resolve().then(()=>adapter?.close())));
      this.snapshots.clear();
    });
    clearInterval(this.timer);this.master.abort();this.visuals.clear();this.inputProofs.clear();for(const t of this.tasks.values())t.controller.abort();
    return this.shutdownPromise;
  }
}
