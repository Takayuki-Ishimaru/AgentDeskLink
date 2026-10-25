import type {CDPSession, ElementHandle, Page} from 'playwright';
import {AdlError} from './types.js';
import type {GestureExecution, GestureKind, GesturePlan, GesturePolicy, GestureReference} from './gesture-types.js';

const MIN_POINTS=2;
const MAX_POINTS=64;
const MAX_PATH_MS=5000;
const EPSILON=0.51;

interface Viewport {width:number;height:number;scroll_x:number;scroll_y:number;device_scale_factor:number}
interface Box {x:number;y:number;width:number;height:number}
interface ProbeArg {allowAllOperations?:boolean;origin:string;viewport:Viewport;selector:string;points:{x:number;y:number}[]}
interface Probe {ok:boolean;reason:string;origin:string;viewport:Viewport;box:Box;touch_action:string}

function invalid():never{throw new AdlError('E_INVALID_ARGUMENT');}
function denied():never{throw new AdlError('E_POLICY_DENIED');}
function stale():never{throw new AdlError('E_STALE_STATE');}
function unsupported():never{throw new AdlError('E_UNSUPPORTED_ACTION');}
function cancelled():never{throw new AdlError('E_CANCELLED');}
function isNum(v:unknown):v is number{return typeof v==='number'&&Number.isFinite(v);}
function rethrow(e:unknown):never{if(e instanceof AdlError)throw e;throw new AdlError('E_INTERNAL');}

function validate(plan:GesturePlan,policy:GesturePolicy,reference:GestureReference):{selector:string;kind:GestureKind;viewport:Viewport}{
  if(policy===null||typeof policy!=='object')invalid();
  if(policy.enabled!==true)denied();
  const kind=plan?.kind;
  if(kind!=='drag'&&kind!=='swipe')invalid();
  const surfaces=Array.isArray(policy.surfaces)?policy.surfaces:invalid();
  const matches=surfaces.filter(s=>s!==null&&typeof s==='object'&&s.id===plan?.surface_id);
  if(matches.length!==1)denied();
  const surface=matches[0]!;
  if(!Array.isArray(surface.kinds)||!surface.kinds.includes(kind))denied();
  if(typeof surface.selector!=='string'||surface.selector.length===0)invalid();
  if(reference===null||typeof reference!=='object'||reference.coordinate_space!=='viewport_css_pixels')invalid();
  const vp=reference.viewport;
  if(vp===null||typeof vp!=='object'||!isNum(vp.width)||!isNum(vp.height)||vp.width<=0||vp.height<=0
    ||!isNum(vp.scroll_x)||!isNum(vp.scroll_y)||!isNum(vp.device_scale_factor)||vp.device_scale_factor<=0)invalid();
  const points=plan.points;
  if(!Array.isArray(points)||points.length<MIN_POINTS||points.length>MAX_POINTS)invalid();
  let prev=-Infinity;
  for(let i=0;i<points.length;i++){
    const p=points[i];
    if(p===null||typeof p!=='object'||!isNum(p.x)||!isNum(p.y)||!isNum(p.t_ms))invalid();
    const point=p as {x:number;y:number;t_ms:number};
    if(point.t_ms<0||point.t_ms>MAX_PATH_MS)invalid();
    if(i===0){if(point.t_ms!==0)invalid();}
    else if(point.t_ms<=prev)invalid();
    if(point.x<0||point.x>=vp.width||point.y<0||point.y>=vp.height)invalid();
    prev=point.t_ms;
  }
  if(!points.some(p=>p.x!==points[0]!.x||p.y!==points[0]!.y))invalid();
  return {selector:surface.selector,kind,viewport:vp};
}

function sleep(ms:number,signal:AbortSignal):Promise<void>{
  return new Promise<void>((resolve,reject)=>{
    if(signal.aborted){reject(new AdlError('E_CANCELLED'));return;}
    const onAbort=()=>{clearTimeout(timer);reject(new AdlError('E_CANCELLED'));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',onAbort);resolve();},ms);
    signal.addEventListener('abort',onAbort,{once:true});
  });
}

async function guard<T>(signal:AbortSignal,assertCurrent:()=>void,step:()=>Promise<T>):Promise<T>{
  if(signal.aborted)cancelled();
  try{assertCurrent();}catch{stale();}
  const value=await step().catch((e:unknown)=>rethrow(e));
  if(signal.aborted)cancelled();
  try{assertCurrent();}catch{stale();}
  return value;
}

// Runs in the page: geometry, origin, touch-action and a hit test for every path point.
function probeSurface(el:Element,arg:ProbeArg):Probe{
  const win=window as unknown as {innerWidth:number;innerHeight:number;scrollX:number;scrollY:number;devicePixelRatio:number};
  const doc=document as unknown as {elementsFromPoint?:(x:number,y:number)=>Element[];elementFromPoint:(x:number,y:number)=>Element|null};
  const rect=el.getBoundingClientRect();
  const viewport:Viewport={width:win.innerWidth,height:win.innerHeight,scroll_x:win.scrollX,scroll_y:win.scrollY,device_scale_factor:win.devicePixelRatio};
  let touchAction='';
  try{const style=getComputedStyle(el);touchAction=style.getPropertyValue?style.getPropertyValue('touch-action'):'';}catch{touchAction='';}
  let visible=true;
  try{const node=el as unknown as {checkVisibility?:(options:{opacityProperty:boolean;visibilityProperty:boolean})=>boolean};visible=el.isConnected&&typeof node.checkVisibility==='function'?node.checkVisibility({opacityProperty:true,visibilityProperty:true})!==false:el.isConnected;}catch{visible=false;}
  let reason='ok';
  const points=arg.points;
  for(let i=0;i<points.length&&reason==='ok';i++){
    const p=points[i]!;
    let stack:Element[]|null=null;
    try{
      stack=typeof doc.elementsFromPoint==='function'?(doc.elementsFromPoint!(p.x,p.y)||[]):(doc.elementFromPoint(p.x,p.y)===null?[]:[doc.elementFromPoint(p.x,p.y)!]);
    }catch{stack=null;}
    if(stack===null){reason='untestable';break;}
    const top=stack.length>0?stack[0]:null;
    if(!top){reason='outside';break;}
    const inside=top===el||el.contains(top)||(typeof top.closest==='function'&&top.closest(arg.selector)===el);
    if(!inside){reason='occluded';break;}
    for(let j=0;!arg.allowAllOperations&&j<stack.length;j++){
      const node=stack[j]!;
      if(typeof node.closest==='function'&&node.closest('input,textarea,select,button,a[href],iframe,frame,[contenteditable],[data-adl-sensitive],[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"],[role="option"],[role="tab"]')){reason='blocked_target';break;}
      // A trusted drawing surface can contain custom widgets without native tags.
      // Bound the ancestor walk and reject known sensitive/consequential names.
      let ancestor:Element|null=node,depth=0;
      while(ancestor&&depth++<32){
        let text='',visits=0;
        for(let child=ancestor.firstChild;child&&text.length<=512&&visits++<64;child=child.nextSibling){if(child.nodeType===3)text+=(child.nodeValue??'').slice(0,513-text.length);}
        const name=[ancestor.getAttribute('aria-label'),ancestor.getAttribute('title'),ancestor.getAttribute('id'),ancestor.getAttribute('name'),text].filter(Boolean).join(' ');
        if(visits>64||text.length>512||name.length>2048||/(?:password|passwd|passcode|secret|token|credential|authorization|otp|cvv|(?:api|access|private)[_ -]?key|delete|remove|upload|send|submit|purchase|checkout|pay|payment|login|log\s*in|sign\s*in|sign\s*up|register|withdraw|transfer)/i.test(name)){reason='blocked_target';break;}
        if(ancestor===el)break;ancestor=ancestor.parentElement;
      }
      if(ancestor&&depth>=32)reason='blocked_target';
      if(reason!=='ok')break;
    }
  }
  return {ok:reason==='ok'&&visible,reason:visible?reason:'invisible',origin:typeof location!=='undefined'&&location?location.origin:'',viewport,
    box:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},touch_action:String(touchAction||'')};
}

function sameViewport(a:Viewport,b:Viewport):boolean{
  return a.width===b.width&&a.height===b.height&&a.scroll_x===b.scroll_x&&a.scroll_y===b.scroll_y&&a.device_scale_factor===b.device_scale_factor;
}

function insideBox(box:Box,points:{x:number;y:number}[]):boolean{
  return points.every(p=>p.x>=box.x-EPSILON&&p.x<=box.x+box.width+EPSILON&&p.y>=box.y-EPSILON&&p.y<=box.y+box.height+EPSILON);
}

function verifyProbe(probe:Probe,arg:ProbeArg,kind:GestureKind):void{
  if(probe===null||typeof probe!=='object')stale();
  if(probe.origin!==arg.origin)stale();
  if(!sameViewport(probe.viewport,arg.viewport))stale();
  const box=probe.box;
  if(box===null||typeof box!=='object'||!isNum(box.x)||!isNum(box.y)||!isNum(box.width)||!isNum(box.height)||box.width<=0||box.height<=0)stale();
  if(!insideBox(box,arg.points))denied();
  if(probe.reason==='blocked_target'||probe.reason==='occluded'||probe.reason==='outside')denied();
  if(!probe.ok)denied();
  if(!arg.allowAllOperations&&kind==='swipe'&&probe.touch_action.trim().toLowerCase()!=='none')unsupported();
}

export async function runBrowserGesture(page:Page,plan:GesturePlan,policy:GesturePolicy,reference:GestureReference,signal:AbortSignal,assertCurrent:()=>void,allowAllOperations=false):Promise<GestureExecution>{
  const {selector,kind,viewport}=validate(plan,policy,reference);
  if(typeof assertCurrent!=='function'||typeof page?.url!=='function')invalid();
  const check=()=>{if(signal.aborted)cancelled();assertCurrent();};
  check();
  let origin='';try{origin=new URL(page.url()).origin;}catch{stale();}
  if(!origin||origin==='null')stale();
  // Snapshot caller-owned path and viewport before awaiting external code.
  const points=plan.points.map(p=>({...p}));
  const arg:ProbeArg={allowAllOperations,origin,viewport:{...viewport},selector,points:points.map(p=>({x:p.x,y:p.y}))};
  let handle:ElementHandle|null=null,session:CDPSession|undefined;
  let mousePressed=false,touchActive=false,sent=false,executed=0;
  let failure:unknown;
  const remember=(error:unknown)=>{failure??=error;};
  try{
    const locator=page.locator(selector);
    if(await guard(signal,check,()=>locator.count())!==1)denied();
    // Keep resources even if cancellation/document invalidation follows creation.
    check();handle=await locator.elementHandle();check();if(!handle)denied();
    const initial=await guard(signal,check,()=>handle!.evaluate(probeSurface,arg));verifyProbe(initial,arg,kind);
    const recheck=async()=>{
      const live=await guard(signal,check,()=>handle!.evaluate(probeSurface,arg));verifyProbe(live,arg,kind);
      if(live.box.x!==initial.box.x||live.box.y!==initial.box.y||live.box.width!==initial.box.width||live.box.height!==initial.box.height)stale();
    };
    const touch=(p:{x:number;y:number})=>({x:p.x,y:p.y,radiusX:1,radiusY:1,force:1});
    if(kind==='drag'){
      sent=true;await guard(signal,check,()=>page.mouse.move(points[0]!.x,points[0]!.y));
      // Hover can itself replace/move the surface or reveal an unsafe overlay.
      await recheck();mousePressed=true;
      await guard(signal,check,()=>page.mouse.down());
    }else{
      check();session=await page.context().newCDPSession(page);check();await recheck();
      sent=true;touchActive=true;
      await guard(signal,check,()=>session!.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch(points[0]!)]}));
    }
    executed=1;
    const started=performance.now();
    for(let i=1;i<points.length;i++){
      const remaining=started+points[i]!.t_ms-performance.now();if(remaining>0)await sleep(remaining,signal);
      check();await recheck();const point=points[i]!;
      if(kind==='drag')await guard(signal,check,()=>page.mouse.move(point.x,point.y));
      else await guard(signal,check,()=>session!.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[touch(point)]}));
      executed=i+1;
      // Also verify after the last move before a drop/touchEnd can commit it.
      await recheck();
    }
    if(kind==='drag'){
      // Clear first: a failed up may already have reached the renderer; do not send a second drop.
      await guard(signal,check,()=>{mousePressed=false;return page.mouse.up();});
    }else{
      await guard(signal,check,()=>session!.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}));touchActive=false;
    }
  }catch(error){remember(error);}
  finally{
    if(mousePressed){try{await page.mouse.up();}catch(error){remember(error);}}
    if(touchActive&&session){try{await session.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});}catch(error){remember(error);}}
    if(session){try{await session.detach();}catch(error){remember(error);}}
    if(handle){try{await handle.dispose();}catch(error){remember(error);}}
  }
  if(failure!==undefined){const safe=failure instanceof AdlError?failure:new AdlError('E_INTERNAL');if(sent)safe.mayHaveExecuted=true;throw safe;}
  try{check();}catch(error){const safe=error instanceof AdlError?error:new AdlError('E_INTERNAL');if(sent)safe.mayHaveExecuted=true;throw safe;}
  return {released_input:true,kind,points_executed:executed,verified:'input_sequence_completed'};
}
