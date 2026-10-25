import {spawn,type ChildProcess} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import sharp from 'sharp';
import type {CapturedImage} from './visual-types.js';
import type {NativeGestureBackend,PreparedInput} from './physical-input-types.js';
import {AdlError,NativeError,ERROR_MESSAGES,type ErrorCode,type Adapter,type AdapterSession,type DesktopConfig,type Mode,type Target} from './types.js';
import {redactString} from './policy.js';
const bounds=z.object({x:z.number().finite(),y:z.number().finite(),width:z.number().finite().nonnegative(),height:z.number().finite().nonnegative(),coordinate_space:z.enum(['desktop_points_top_left','desktop_physical_pixels'])}).strict();
const windowSchema=z.object({bounds,display_ids:z.array(z.string().min(1).max(128)).max(16),minimized:z.boolean()}).strict();
const backend=z.enum(['mouse_drag','scroll_swipe','touch_swipe']);
const targetSchema=z.object({target_id:z.string().regex(/^t[-_][A-Za-z0-9_-]+$/).max(100),application_id:z.string().min(1).max(128),label:z.string().max(512),window:windowSchema,capture_only:z.boolean().optional(),interactive_input:z.boolean().optional(),gesture_backends:z.array(backend).max(3).optional()}).strict();
const discovery=z.object({protocol_version:z.literal(2),targets:z.array(targetSchema).max(32),mutations_enabled:z.boolean(),autofocusing_disabled:z.boolean().optional(),focus_control:z.literal('probe_guarded_semantic').optional(),visual_capture:z.boolean().optional(),interactive_input:z.boolean().optional(),gesture_backends:z.array(backend).max(3).optional()}).strict();
const preparedSchema=z.object({confirmation_id:z.string().min(1).max(128),expires_in_ms:z.number().int().positive().max(30000),action:z.enum(['click','fill']),target:z.object({role:z.string().min(1).max(100),name:z.string().max(512),enabled:z.boolean(),focused:z.boolean(),editable:z.boolean(),selection:z.object({start:z.number().int().nonnegative(),length:z.number().int().nonnegative()}).strict().optional()}).strict(),pointer_on_target:z.literal(true),focus_matches_target:z.boolean()}).strict();
const inputSchema=z.object({released_input:z.literal(true),verified:z.literal('input_sequence_completed'),action:z.enum(['click','fill'])}).strict();
const gestureSchema=z.object({released_input:z.literal(true),verified:z.literal('input_sequence_completed'),kind:z.enum(['drag','swipe']),points_executed:z.number().int().min(2).max(64),backend}).strict();
const captureSchema=z.object({
  png_base64:z.string().min(12).max(Math.ceil(8388608/3)*4),captured_at:z.string().max(64).refine(v=>Number.isFinite(Date.parse(v))),coordinate_space:z.literal('window_pixels'),
  viewport:z.object({width:z.number().int().positive().max(4096),height:z.number().int().positive().max(4096),scroll_x:z.literal(0),scroll_y:z.literal(0),device_scale_factor:z.number().finite().positive()}).strict(),
  source_to_desktop:z.object({origin_x:z.number().finite(),origin_y:z.number().finite(),scale_x:z.number().finite().positive(),scale_y:z.number().finite().positive(),coordinate_space:z.enum(['desktop_points_top_left','desktop_physical_pixels'])}).strict(),
  surface_epoch:z.string().min(1).max(256),input_token:z.string().min(1).max(128).optional(),redacted:z.boolean(),
}).strict();
const element=z.object({id:z.string().min(1).max(128),role:z.string().max(100),name:z.string().max(512).nullish().transform(x=>x??''),value:z.string().max(512).nullish().transform(x=>x??undefined),enabled:z.boolean(),checked:z.boolean().nullish().transform(x=>x??undefined),selected:z.boolean().nullish().transform(x=>x??undefined),sensitive:z.boolean().optional()}).strict();
const reply=z.object({ok:z.boolean(),request_id:z.string().max(128),result:z.record(z.string(),z.unknown()).optional(),error:z.object({code:z.string().max(100),message:z.string().max(512).optional(),may_have_executed:z.boolean().optional()}).optional(),may_have_executed:z.boolean().optional()}).strict();
const aliases:Record<string,ErrorCode>={E_NO_TARGET:'E_TARGET_NOT_FOUND',E_NO_SESSION:'E_TARGET_NOT_FOUND',E_SESSION_INVALID:'E_TARGET_NOT_FOUND',E_TARGET_MISMATCH:'E_TARGET_NOT_FOUND',E_STALE_HANDLE:'E_TARGET_NOT_FOUND',E_STALE_REVISION:'E_STALE_STATE',E_STALE_ELEMENT:'E_STALE_STATE',E_NO_ELEMENT:'E_TARGET_NOT_FOUND',E_PATTERN_UNSUPPORTED:'E_UNSUPPORTED_ACTION',E_BAD_REQUEST:'E_INVALID_ARGUMENT'};
const applicationState=z.object({running:z.boolean(),managed:z.boolean(),changed:z.boolean()}).strict().refine(state=>!state.managed||state.running);
const roles:Record<string,string>={edit:'textbox',listitem:'option',radiobutton:'radio',hyperlink:'link',tabitem:'tab'};
export type SpawnFn=(path:string,args:string[])=>ChildProcess;
export interface NativeDesktopOptions{platform?:string;spawnFn?:SpawnFn;}
/** One fixed process and one bounded FIFO; a lost helper is never restarted. */
interface PendingNativeCall {
  id:string;op:string;limit:number;resolve:(v:Record<string,unknown>)=>void;reject:(e:unknown)=>void;
  timer:NodeJS.Timeout;grace?:NodeJS.Timeout;reason?:'cancel'|'timeout';
}
const physicalCall=(op:string)=>['gesture','prepare_input','commit_input'].includes(op);
// Lifecycle is opted-in per platform config and only for these native helpers, which understand --lifecycle-enabled.
const lifecyclePlatform=(platform:string)=>platform==='darwin'||platform==='win32';
const canHoldInput=(op:string)=>op==='gesture'||op==='commit_input';
class NativeClient {
  private child:ChildProcess;private chunks:Buffer[]=[];private bufferedBytes=0;private dead=false;private closing?:Promise<void>;
  private queue:Promise<unknown>=Promise.resolve();private queued=0;private pending?:PendingNativeCall;private releaseRequired=false;
  constructor(private config:DesktopConfig,private invalidate:()=>void,private spawnFn?:SpawnFn,private platform:string=process.platform){
    const interactive=config.interactive?{...config.interactive,surfaces:config.interactive.surfaces.map(s=>({...s,...(s.kinds.includes('swipe')?{swipe_backend:s.swipe_backend??'scroll'}:{})}))}:undefined;
    const args=[...(config.allowAllOperations?['--allow-all']:[]),'--app-id',config.appId,'--app-path',config.appPath,...(config.controlsPath?['--controls-file',config.controlsPath]:[]),...(config.visual?.enabled?['--visual-enabled']:[]),...(interactive?.enabled?['--interactive-config',JSON.stringify(interactive)]:[]),...(lifecyclePlatform(this.platform)&&config.lifecycle?.enabled?['--lifecycle-enabled']:[])];
    this.child=this.launch(args);
    this.child.stderr?.resume();
    this.child.stdin?.on('error',()=>{void this.close().catch(()=>{});});this.child.stdout?.on('error',()=>{void this.close().catch(()=>{});});this.child.on('error',()=>{void this.close().catch(()=>{});});this.child.on('exit',()=>{void this.close().catch(()=>{});});
    this.child.stdout?.on('data',(chunk:Buffer)=>{
      if(this.dead)return;const limit=this.pending?.limit??65536;
      if(this.bufferedBytes+chunk.length>limit+1){void this.close('E_BACKEND_UNAVAILABLE').catch(()=>{});return;}
      const newline=chunk.indexOf(10);
      if(newline<0){this.chunks.push(chunk);this.bufferedBytes+=chunk.length;return;}
      if(newline!==chunk.length-1){void this.close('E_BACKEND_UNAVAILABLE').catch(()=>{});return;}
      const length=this.bufferedBytes+newline;this.chunks.push(chunk.subarray(0,newline));
      const line=Buffer.concat(this.chunks,length).toString('utf8');this.chunks=[];this.bufferedBytes=0;const p=this.pending;
      try{
        if(!p||length>p.limit)throw new Error();const r=reply.parse(JSON.parse(line));
        if(r.request_id!==p.id||r.ok&&!r.result||!r.ok&&!r.error)throw new Error();
        clearTimeout(p.timer);if(p.grace)clearTimeout(p.grace);this.pending=undefined;
        const may=r.may_have_executed===true||r.error?.may_have_executed===true;
        if(p.reason)p.reject(new NativeError(p.reason==='timeout'?'E_TIMEOUT':'E_CANCELLED',may||canHoldInput(p.op)));
        else if(r.ok)p.resolve(r.result!);
        else{const code=r.error!.code;const mapped=Object.hasOwn(ERROR_MESSAGES,code)?code as ErrorCode:aliases[code]??'E_POLICY_DENIED';p.reject(new NativeError(mapped,may));}
      }catch{void this.close('E_BACKEND_UNAVAILABLE').catch(()=>{});}
    });
  }
  private launch(args:string[]){return this.spawnFn?this.spawnFn(this.config.helperPath,args):spawn(this.config.helperPath,args,{stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});}
  private cancelPending(p:PendingNativeCall,reason:'cancel'|'timeout'){
    if(this.dead||this.pending!==p||p.reason)return;p.reason=reason;clearTimeout(p.timer);
    if(!physicalCall(p.op)&&p.op!=='application'){void this.close(reason==='timeout'?'E_TIMEOUT':'E_CANCELLED').catch(()=>{});return;}
    // The reader handles this out of band. Keep the original request pending until
    // the native driver has released its own input and acknowledged cancellation.
    this.child.stdin?.write(JSON.stringify({op:'cancel_input',request_id:p.id})+'\n',error=>{if(error)void this.close().catch(()=>{});});
    p.grace=setTimeout(()=>{void this.close(reason==='timeout'?'E_TIMEOUT':'E_CANCELLED').catch(()=>{});},2000);
  }
  call(op:string,args:Record<string,unknown>,signal?:AbortSignal):Promise<Record<string,unknown>>{
    if(this.dead)return Promise.reject(new AdlError('E_TARGET_NOT_FOUND'));if(this.queued>=64)return Promise.reject(new AdlError('E_RESOURCE_LIMIT'));
    if(signal?.aborted)return Promise.reject(new AdlError('E_CANCELLED'));
    let requestId:string|undefined;
    const abort=()=>{const p=this.pending;if(requestId&&p?.id===requestId)this.cancelPending(p,'cancel');};
    this.queued++;signal?.addEventListener('abort',abort,{once:true});
    const run=this.queue.then(()=>{
      if(signal?.aborted)throw new AdlError('E_CANCELLED');if(this.dead)throw new AdlError('E_TARGET_NOT_FOUND');
      return new Promise<Record<string,unknown>>((resolve,reject)=>{
        const id=randomUUID();requestId=id;
        const timeout=op==='capture'||op==='prepare_input'?10000:physicalCall(op)?15000:5000;
        const p:PendingNativeCall={id,op,limit:op==='capture'?12*1024*1024:65536,resolve,reject,timer:setTimeout(()=>{this.cancelPending(p,'timeout');},timeout)};this.pending=p;
        const data=JSON.stringify({op,request_id:id,...args})+'\n';
        if(Buffer.byteLength(data)>65536){clearTimeout(p.timer);this.pending=undefined;reject(new AdlError('E_RESOURCE_LIMIT'));return;}
        if(!this.child.stdin){void this.close().catch(()=>{});return;}
        this.child.stdin.write(data,error=>{if(error)void this.close().catch(()=>{});});
      });
    });this.queue=run.catch(()=>{});
    return run.then(value=>{if(signal?.aborted)throw new NativeError('E_CANCELLED',canHoldInput(op));return value;}).catch(error=>{if(signal?.aborted){const safe=new AdlError('E_CANCELLED');safe.mayHaveExecuted=error instanceof AdlError&&error.mayHaveExecuted;throw safe;}throw error;}).finally(()=>{this.queued--;signal?.removeEventListener('abort',abort);});
  }
  private emergencyRelease():Promise<void>{
    return new Promise((resolve,reject)=>{
      let child:ChildProcess;try{child=this.launch(['--release-input']);}catch{reject(new AdlError('E_BACKEND_UNAVAILABLE'));return;}
      child.stderr?.resume();child.stdin?.end();let output='';let settled=false;
      const done=(ok:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);ok?resolve():reject(new AdlError('E_BACKEND_UNAVAILABLE'));};
      const timer=setTimeout(()=>{child.kill('SIGKILL');done(false);},3000);
      child.stdout?.on('data',(chunk:Buffer)=>{if(Buffer.byteLength(output)+chunk.length>4096){child.kill('SIGKILL');done(false);}else output+=chunk.toString('utf8');});
      child.once('error',()=>done(false));child.once('close',code=>{let released=false;try{released=JSON.parse(output.trim()).released_input===true;}catch{}done(code===0&&released);});
    });
  }
  close(code:ErrorCode='E_TARGET_NOT_FOUND',forceRelease=false):Promise<void>{
    this.releaseRequired ||= forceRelease;
    if(this.closing)return this.closing;this.dead=true;this.invalidate();this.chunks=[];this.bufferedBytes=0;
    const p=this.pending;this.pending=undefined;if(p){clearTimeout(p.timer);if(p.grace)clearTimeout(p.grace);}
    const physical=!!p&&canHoldInput(p.op);this.releaseRequired ||= physical;
    const terminated=new Promise<void>((resolve,reject)=>{
      const child=this.child;if(child.exitCode!==null||child.signalCode!==null||!child.pid){resolve();return;}
      let killTimer:NodeJS.Timeout|undefined;
      const timer=setTimeout(()=>{child.kill('SIGKILL');killTimer=setTimeout(()=>reject(new AdlError('E_TIMEOUT')),1000);},1500);
      child.once('exit',()=>{clearTimeout(timer);if(killTimer)clearTimeout(killTimer);resolve();});child.kill();
    });
    this.closing=terminated.then(async()=>{if(this.releaseRequired)await this.emergencyRelease();});
    if(p){
      const error=new NativeError(code,physical);
      if(physical)void this.closing.then(()=>p.reject(error),()=>p.reject(error));else p.reject(error);
    }
    return this.closing;
  }
}
export class NativeDesktopAdapter implements Adapter {
  private client?:NativeClient;private dead=false;private closed=false;private issued=new Map<string,Target>();private listeners=new Set<()=>void>();private mutations=false;private visualCapture=false;private captureOnly=new Set<string>();private interactiveTargets=new Map<string,NativeGestureBackend[]>();
  private readonly platform:string;
  constructor(protected readonly config:DesktopConfig,private options:NativeDesktopOptions={}){this.platform=options.platform??process.platform;}
  onInvalidated(listener:()=>void){this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
  private invalidate=()=>{if(this.dead)return;this.dead=true;this.mutations=false;this.issued.clear();this.interactiveTargets.clear();for(const listener of this.listeners)listener();};
  private getClient(){if(this.dead||this.closed||!['darwin','win32'].includes(this.platform))throw new AdlError('E_TARGET_NOT_FOUND');return this.client??=new NativeClient(this.config,this.invalidate,this.options.spawnFn,this.platform);}
  private async parse<T>(operation:()=>Promise<T>):Promise<T>{try{return await operation();}catch(error){if(error instanceof AdlError)throw error;await this.client?.close();throw new AdlError('E_BACKEND_UNAVAILABLE');}}
  private async parsePhysical<T>(operation:()=>Promise<T>):Promise<T>{try{return await operation();}catch(error){
    if(error instanceof AdlError){
      if(error.mayHaveExecuted||error.code==='E_PARTIAL_EXECUTION'){error.mayHaveExecuted=true;await this.client?.close(error.code,true).catch(()=>{});}
      throw error;
    }
    await this.client?.close('E_BACKEND_UNAVAILABLE',true).catch(()=>{});throw new NativeError('E_BACKEND_UNAVAILABLE',true);
  }}
  desktopCapabilities(){return {available:!!this.client&&!this.dead&&!this.closed,mutations:this.mutations,visual_capture:this.visualCapture&&!this.dead&&!this.closed,interactive_input:!this.dead&&!this.closed&&this.interactiveTargets.size>0,gesture_backends:[...new Set([...this.interactiveTargets.values()].flat())],focus_control:this.platform==='darwin'?'probe_guarded_semantic':'autofocusing_disabled_probe',lifecycle:lifecyclePlatform(this.platform)&&this.config.lifecycle?.enabled===true&&!this.dead&&!this.closed};}
  discover(signal:AbortSignal):Promise<Target[]>{return this.parse(async()=>{
    const c=this.getClient();const result=discovery.parse(await c.call('discover',{},signal));
    const ids=new Set<string>();for(const t of result.targets){if(ids.has(t.target_id)||t.application_id!==this.config.appId)throw new Error();ids.add(t.target_id);if(t.window.bounds.coordinate_space!==(this.platform==='darwin'?'desktop_points_top_left':'desktop_physical_pixels'))throw new Error();}
    this.mutations=(this.config.allowAllOperations===true||!!this.config.controlsPath)&&result.mutations_enabled&&(this.platform==='darwin'?result.focus_control==='probe_guarded_semantic':result.autofocusing_disabled===true);
    this.visualCapture=this.config.visual?.enabled===true&&result.visual_capture===true;
    this.captureOnly=new Set(result.targets.filter(t=>t.capture_only).map(t=>t.target_id));
    this.interactiveTargets.clear();
    if(this.dead||signal.aborted)throw new AdlError('E_CANCELLED');
    const targets:Target[]=result.targets.map(t=>{
      const capture=this.visualCapture&&(this.platform==='win32'||t.capture_only&&this.config.visual?.allowUnredacted===true);
      const interactive=this.config.interactive?.enabled===true&&capture&&(t.interactive_input??result.interactive_input)===true;
      if(interactive)this.interactiveTargets.set(t.target_id,t.gesture_backends??result.gesture_backends??[]);
      return {...t,surface:'desktop',policy_class:this.config.classification,label:redactString(t.label),capabilities:['observe','read_state','wait_for',...(this.mutations&&!t.capture_only?['click','fill','check','select','scroll']:[]),...(capture?['capture','crop','record']:[]),...(interactive?['interactive_desktop','gesture','prepare_input','commit_input']:[])]};
    });this.issued=new Map(targets.map(t=>[t.target_id,t]));return targets;
  });}
  async open(target:Target,mode:Mode,signal:AbortSignal):Promise<AdapterSession>{
    if(mode!=='background_semantic'&&mode!=='interactive_desktop')throw new AdlError('E_INTERFERENCE_RISK');
    if(target.surface!=='desktop'||target.application_id!==this.config.appId||!this.issued.has(target.target_id))throw new AdlError('E_TARGET_NOT_FOUND');
    const interactive=mode==='interactive_desktop';
    if(interactive&&!this.interactiveTargets.has(target.target_id))throw new AdlError('E_UNSUPPORTED_ACTION');
    const c=this.getClient(),mutations=!interactive&&this.mutations&&!this.captureOnly.has(target.target_id),canCapture=this.issued.get(target.target_id)!.capabilities.includes('capture');
    const opened=await this.parse(()=>c.call('open',{target_id:target.target_id,mode},signal));
    const sid=await this.parse(async()=>z.string().min(1).max(128).parse(opened.session_id));let closed=false,nativeRevision:number|undefined;let closing:Promise<void>|undefined;let preparedAction:{id:string;action:'click'|'fill'}|undefined;
    const check=()=>{if(closed||this.dead||this.closed)throw new AdlError('E_TARGET_NOT_FOUND');};
    return {
      capabilities:['observe','read_state','wait_for',...(mutations?['click','fill','check','select','scroll']:[]),...(canCapture?['capture','crop','record']:[]),...(interactive?['interactive_desktop','gesture','prepare_input','commit_input']:[])],
      ...(interactive?{
        gesture:(plan,reference,signal)=>this.parsePhysical(async()=>{
          preparedAction=undefined;
          check();if(nativeRevision===undefined||!reference.input_token)throw new AdlError('E_STALE_STATE');
          const rule=this.config.interactive!.surfaces.find(s=>s.id===plan.surface_id);
          if(!rule||!rule.kinds.includes(plan.kind))throw new AdlError('E_APPROVAL_REQUIRED');
          const swipe=plan.swipe_backend??rule.swipe_backend??'scroll';
          if(plan.kind==='drag'&&plan.swipe_backend||plan.kind==='swipe'&&swipe!==(rule.swipe_backend??'scroll'))throw new AdlError('E_UNSUPPORTED_ACTION');
          const expected=plan.kind==='drag'?'mouse_drag':swipe==='touch'?'touch_swipe':'scroll_swipe';
          if(!this.interactiveTargets.get(target.target_id)?.includes(expected))throw new AdlError('E_UNSUPPORTED_ACTION');
          if(plan.points.some(p=>p.x<rule.region.x||p.y<rule.region.y||p.x>=rule.region.x+rule.region.width||p.y>=rule.region.y+rule.region.height))throw new AdlError('E_POLICY_DENIED');
          const result=gestureSchema.parse(await c.call('gesture',{target_id:target.target_id,session_id:sid,expected_revision:nativeRevision,input_token:reference.input_token,...plan,...(plan.kind==='swipe'?{swipe_backend:swipe}:{})},signal));
          if(result.kind!==plan.kind||result.points_executed!==plan.points.length||result.backend!==expected)throw new Error();
          const {backend,...execution}=result;return {...execution,input_backend:backend};
        }),
        prepareInput:(plan,reference,signal)=>this.parsePhysical(async()=>{
          preparedAction=undefined;
          check();if(!reference.input_token)throw new AdlError('E_STALE_STATE');
          const prepared=preparedSchema.parse(await c.call('prepare_input',{target_id:target.target_id,session_id:sid,input_token:reference.input_token,...plan},signal));
          prepared.target.role=(this.platform==='win32'?roles[prepared.target.role.toLowerCase()]??prepared.target.role:prepared.target.role).toLowerCase();
          if(prepared.action!==plan.action||!prepared.target.enabled||plan.action==='fill'&&!prepared.target.editable||prepared.target.focused!==prepared.focus_matches_target||plan.expected_target?.role!==undefined&&plan.expected_target.role!==prepared.target.role||plan.expected_target?.name!==undefined&&plan.expected_target.name!==prepared.target.name)throw new Error();
          preparedAction={id:prepared.confirmation_id,action:prepared.action};return prepared satisfies PreparedInput;
        }),
        commitInput:(confirmation_id,value,signal)=>this.parsePhysical(async()=>{
          check();const proof=preparedAction;if(!proof||proof.id!==confirmation_id)throw new AdlError('E_TARGET_NOT_FOUND');preparedAction=undefined;
          const execution=inputSchema.parse(await c.call('commit_input',{target_id:target.target_id,session_id:sid,confirmation_id,...(value!==undefined?{value}:{})},signal));
          if(execution.action!==proof.action)throw new Error();return execution;
        }),
      }:{}),
      ...(canCapture?{capture:(signal:AbortSignal)=>this.parse(async()=>{
        check();if(this.platform==='darwin'&&!this.config.visual?.allowUnredacted)throw new AdlError('E_PRIVACY_BLOCKED');
        const frame=captureSchema.parse(await c.call('capture',{target_id:target.target_id,session_id:sid},signal));
        if(signal.aborted)throw new AdlError('E_CANCELLED');check();
        if(frame.source_to_desktop.coordinate_space!==(this.platform==='darwin'?'desktop_points_top_left':'desktop_physical_pixels'))throw new Error();
        if(frame.viewport.width*frame.viewport.height>4194304)throw new AdlError('E_RESOURCE_LIMIT');
        const png=Buffer.from(frame.png_base64,'base64');if(!png.length||png.length>8388608||png.toString('base64')!==frame.png_base64)throw new Error();
        const header=await sharp(png,{limitInputPixels:false}).metadata();
        if(header.format!=='png'||header.width!==frame.viewport.width||header.height!==frame.viewport.height)throw new Error();
        const masks=this.config.visual?.maskRegions??[];
        if(masks.some(r=>r.x+r.width>frame.viewport.width||r.y+r.height>frame.viewport.height))throw new AdlError('E_PRIVACY_BLOCKED');
        const overlays=masks.map(r=>({input:{create:{width:r.width,height:r.height,channels:4 as const,background:{r:0,g:0,b:0,alpha:1}}},left:r.x,top:r.y}));
        const protectedPng=await sharp(png,{limitInputPixels:4194304}).composite(overlays).png().toBuffer();
        if(protectedPng.length>8388608)throw new AdlError('E_RESOURCE_LIMIT');if(signal.aborted)throw new AdlError('E_CANCELLED');check();
        const {png_base64,...metadata}=frame;return {...metadata,png:protectedPng,redacted:frame.redacted||masks.length>0} satisfies CapturedImage;
      })}:{}),
      snapshot:(signal)=>this.parse(async()=>{check();const r=await c.call('snapshot',{target_id:target.target_id,session_id:sid},signal);const elements=z.array(element).max(1000).parse(r.elements).map(e=>({...e,role:(this.platform==='win32'?roles[e.role.toLowerCase()]??e.role:e.role).toLowerCase()}));if(new Set(elements.map(e=>e.id)).size!==elements.length)throw new Error();nativeRevision=z.number().int().nonnegative().parse(r.revision);return {elements,fingerprint:createHash('sha256').update(JSON.stringify([nativeRevision,elements])).digest('hex'),truncated:z.boolean().parse(r.truncated)};}),
      act:async(action,signal)=>{check();if(!mutations)throw new AdlError('E_UNSUPPORTED_ACTION');if(nativeRevision===undefined)throw new AdlError('E_STALE_STATE');const applied=await c.call('act',{target_id:target.target_id,session_id:sid,expected_revision:nativeRevision,action:action.action,element_id:action.element_id,...(action.action==='fill'?{value:action.value}:{}),...(action.action==='check'?{checked:action.checked}:{}),...(action.action==='scroll'?{direction:action.direction}:{})},signal);if(applied.applied!==true){await c.close();throw new NativeError('E_INTERNAL',true);}},
      close:()=>closing??=(async()=>{closed=true;if(this.dead){await c.close();return;}try{await c.call('close',{target_id:target.target_id,session_id:sid});}catch(error){if(error instanceof AdlError&&error.code==='E_TARGET_NOT_FOUND')return;await c.close();throw error;}})()
    };
  }
  application(application_id:string,action:'status'|'launch'|'quit',signal:AbortSignal):Promise<{running:boolean;managed:boolean;changed:boolean}>{
    if(!lifecyclePlatform(this.platform))return Promise.reject(new AdlError('E_UNSUPPORTED_ACTION'));
    if(this.config.lifecycle?.enabled!==true||application_id!==this.config.appId||!['status','launch','quit'].includes(action))return Promise.reject(new AdlError('E_POLICY_DENIED'));
    if(signal.aborted)return Promise.reject(new AdlError('E_CANCELLED'));
    return this.parse(async()=>{
      const c=this.getClient();
      let state:{running:boolean;managed:boolean;changed:boolean};
      try{state=applicationState.parse(await c.call('application',{action},signal));}
      catch(error){if(action!=='status'&&error instanceof AdlError&&(signal.aborted||error.code==='E_TIMEOUT'||error.code==='E_CANCELLED'))error.mayHaveExecuted=true;throw error;}
      if(signal.aborted)throw new AdlError('E_CANCELLED');
      return state;
    });
  }
  async close(){if(this.closed)return;this.closed=true;await this.client?.close();}
}
