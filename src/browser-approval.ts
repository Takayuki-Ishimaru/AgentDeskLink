import {createHash,randomUUID} from 'node:crypto';
import type {ElementHandle} from 'playwright';
import {AdlError,type Action} from './types.js';
import {BROWSER_PRIVACY_RULES,SECRET_LABEL_PATTERN} from './privacy.js';
import {describeApprovalForm} from './approval-summary.js';

export type ActionRisk='ordinary'|'credential'|'consequential';
export interface ActionProof {proof:string;risk:ActionRisk;role:string;name:string;origin:string;details?:string[];network?:{url:string;method:string;body:string}}

// CDP supplies a backend node identity from the hit-test. We compare candidate
// ancestors to the retained Playwright handle with JavaScript identity only;
// no DOM attributes or page-controlled getters are used for that comparison.
// CDP then resolves that exact backend node in a fresh isolated world.
export async function isolatedCollect<T>(el:ElementHandle,collect:(node:Element,args:any)=>T,args:unknown,allowedFrameOrigins:readonly string[]=[]):Promise<T>{
 const frame=await el.ownerFrame();if(!frame)throw new AdlError('E_STALE_STATE');
 const page=frame.page();
 const permittedOrigins=new Set([new URL(page.url()).origin,...allowedFrameOrigins.map(origin=>new URL(origin).origin)]);
 if(frame!==page.mainFrame()&&!frame.url().startsWith('about:')&&!permittedOrigins.has(new URL(frame.url()).origin))throw new AdlError('E_POLICY_DENIED','iframe_action_proof_unavailable');
 const box=await el.boundingBox();if(!box||box.width<=0||box.height<=0)throw new AdlError('E_STALE_STATE');
 const viewport=page.viewportSize();const left=Math.max(0,box.x),top=Math.max(0,box.y),right=Math.min(viewport?.width??box.x+box.width,box.x+box.width),bottom=Math.min(viewport?.height??box.y+box.height,box.y+box.height);
 if(right<=left||bottom<=top)throw new AdlError('E_STALE_STATE');
 const x=Math.floor((left+right)/2),y=Math.floor((top+bottom)/2);
 if(x<0||y<0||viewport&&(x>=viewport.width||y>=viewport.height))throw new AdlError('E_STALE_STATE');
 const cdp=await page.context().newCDPSession(page),objectGroup='adl-proof-'+randomUUID();
 try{
  const hit=await cdp.send('DOM.getNodeForLocation',{x,y,includeUserAgentShadowDOM:false,ignorePointerEventsNone:false});
  const tree=await cdp.send('Page.getFrameTree');
  const frameInfo=new Map<string,typeof tree.frameTree.frame>();
  const framePending=[tree.frameTree];while(framePending.length){const item=framePending.pop()!;frameInfo.set(item.frame.id,item.frame);framePending.push(...(item.childFrames??[]));}
  const mainInfo=tree.frameTree.frame,hitInfo=frameInfo.get(hit.frameId);
  // Descendants require explicit exact-origin authorization and an in-process
  // CDP document. Opaque origins and OOPIFs fail closed.
  if(frame!==page.mainFrame()&&(!hitInfo||mainInfo.securityOrigin!==new URL(page.url()).origin||!permittedOrigins.has(hitInfo.securityOrigin)))throw new AdlError('E_POLICY_DENIED','iframe_action_proof_unavailable');
  const dom=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});
  type Host={backend:number;frameId:string;selector:string};
  type Candidate={backend:number;parent?:Candidate;selector:string;frameId:string;hosts:Host[];unavailableFrame:boolean};
  const pending:{node:typeof dom.root;parent?:Candidate;selector:string;frameId:string;hosts:Host[]}[]=[{node:dom.root,selector:'',frameId:mainInfo.id,hosts:[]}];let found:Candidate|undefined,visited=0;
  while(pending.length){
   const item=pending.pop()!;if(++visited>10000)throw new AdlError('E_RESOURCE_LIMIT');
   if(item.node.shadowRootType==='closed'||item.node.shadowRootType==='user-agent')continue;
   const current:Candidate={backend:item.node.backendNodeId,parent:item.parent,selector:item.selector,frameId:item.frameId,hosts:item.hosts,unavailableFrame:!!item.node.frameId&&!item.node.contentDocument};
   if(current.backend===hit.backendNodeId&&item.frameId===hit.frameId){found=current;break;}
   let index=0;
   for(const child of item.node.children??[]){if(child.nodeType!==1)continue;index++;pending.push({node:child,parent:current,frameId:item.frameId,hosts:item.hosts,selector:item.node.nodeType===9?':root':(item.selector?item.selector+(item.node.nodeType===11?' >> css=':' > '):'')+`*:nth-child(${index})`});}
   for(const shadow of item.node.shadowRoots??[])pending.push({node:shadow,parent:current,selector:item.selector,frameId:item.frameId,hosts:item.hosts});
   if(item.node.contentDocument&&item.node.frameId){
    const childInfo=frameInfo.get(item.node.frameId);
    if(childInfo&&permittedOrigins.has(childInfo.securityOrigin))pending.push({node:item.node.contentDocument,selector:'',frameId:item.node.frameId,hosts:[...item.hosts,{backend:current.backend,frameId:item.frameId,selector:current.selector}]});
   }
  }
  // A selector is meaningful only in its original frame. Prove every CDP
  // iframe owner is the exact Playwright owner before using frame.locator.
  const chain:typeof frame[]=[];for(let f:typeof frame|null=frame;f?.parentFrame();f=f.parentFrame())chain.unshift(f);
  let frameMatches=!!found&&found.hosts.length===chain.length;
  if(frameMatches&&found){for(let i=0;i<chain.length;i++){
   const child=chain[i]!,host=found.hosts[i]!,parent=child.parentFrame();if(!parent){frameMatches=false;break;}
   const actual=await child.frameElement(),candidate=await parent.locator(host.selector).elementHandle({timeout:1000});
   try{if(!candidate||!await actual.evaluate((node,other)=>node===other,candidate))frameMatches=false;}finally{await actual.dispose();await candidate?.dispose();}
   if(!frameMatches)break;
  }}
  let selected:Candidate|undefined;
  for(let candidate=frameMatches?found:undefined,depth=0;candidate?.selector&&depth++<128;candidate=candidate.parent){
   const other=await frame.locator(candidate.selector).elementHandle({timeout:1000});if(!other)continue;
   try{if(await el.evaluate((node,otherNode)=>node===otherNode,other)){selected=candidate;break;}}finally{await other.dispose().catch(()=>undefined);}
  }
  if(!selected){
   if(!await el.evaluate(node=>node.isConnected))throw new AdlError('E_STALE_STATE');
   // When the hit is the actual frame owner but CDP has no child document,
   // Chromium has not exposed an in-process identity proof (typically OOPIF).
   if(found?.unavailableFrame)for(const child of chain){const parent=child.parentFrame();if(!parent)continue;const actual=await child.frameElement(),other=await parent.locator(found.selector).elementHandle({timeout:1000});
    try{if(other&&await actual.evaluate((node,candidate)=>node===candidate,other))throw new AdlError('E_POLICY_DENIED','iframe_action_proof_unavailable');}finally{await actual.dispose();await other?.dispose();}}
   throw new AdlError('E_NOT_INTERACTABLE','occluded');
  }
  const contexts=new Map<string,number>();
  const isolatedWorld=async(frameId:string)=>{let id=contexts.get(frameId);if(id===undefined){id=(await cdp.send('Page.createIsolatedWorld',{frameId,worldName:'adl-approval-proof'})).executionContextId;contexts.set(frameId,id);}return id;};
  // Each iframe owner and its composed ancestors are checked in the parent's
  // isolated world, not through page-provided DOM getters.
  for(const host of selected.hosts){
   const owner=await cdp.send('DOM.resolveNode',{backendNodeId:host.backend,objectGroup,executionContextId:await isolatedWorld(host.frameId)});
   if(!owner.object.objectId)throw new AdlError('E_PRIVACY_BLOCKED');
   const check=await cdp.send('Runtime.callFunctionOn',{objectId:owner.object.objectId,functionDeclaration:`function(rules){let n=this,depth=0;while(n&&depth++<rules.ancestorCap){if(n.matches(rules.regionSelector))return 'protected';n=n.parentElement??n.getRootNode().host??null;}if(n!==null||!this.isConnected)return 'protected';if(this.hasAttribute('sandbox')&&!this.sandbox.contains('allow-same-origin'))return 'opaque';return 'ok';}`,arguments:[{value:BROWSER_PRIVACY_RULES}],returnByValue:true});
   if(check.result.value==='opaque')throw new AdlError('E_POLICY_DENIED','iframe_action_proof_unavailable');
   if(check.exceptionDetails||check.result.value!=='ok')throw new AdlError('E_PRIVACY_BLOCKED');
  }
  const world={executionContextId:await isolatedWorld(selected.frameId)};
  const object=await cdp.send('DOM.resolveNode',{backendNodeId:selected.backend,objectGroup,executionContextId:world.executionContextId});
  if(!object.object.objectId)throw new AdlError('E_STALE_STATE');
  const response=await cdp.send('Runtime.callFunctionOn',{objectId:object.object.objectId,functionDeclaration:`function(args){return (${collect.toString()})(this,args)}`,arguments:[{value:args}],returnByValue:true});
  if(response.exceptionDetails||!response.result.value)throw new AdlError('E_PRIVACY_BLOCKED');
  return response.result.value as T;
 }catch(error){if(error instanceof AdlError)throw error;throw new AdlError('E_STALE_STATE');}
 finally{await cdp.send('Runtime.releaseObjectGroup',{objectGroup}).catch(()=>undefined);await cdp.detach().catch(()=>undefined);}
}
// The raw form values remain inside the adapter and are hashed before return.
export async function inspectBrowserAction(el:ElementHandle,action:Action):Promise<ActionProof>{
 const collect=(node:Element,args:{rules:typeof BROWSER_PRIVACY_RULES;pattern:string;action:Action})=>{
  const e=node as HTMLElement,doc=e.ownerDocument;
  const fail=()=>{throw new Error('unavailable');};
  if(!e.isConnected)fail();
  const protectedNode=(element:Element)=>{let n:Element|null=element,depth=0;while(n&&depth++<args.rules.ancestorCap){if(n.matches(args.rules.regionSelector))return true;n=n.parentElement??(n.getRootNode() as ShadowRoot).host??null;}return n!==null;};
  if(protectedNode(e))fail();
  const text=(el:Element)=>{let s='',count=0;const walker=doc.createTreeWalker(el,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT);let n:Node|null;while((n=walker.nextNode())){if(++count>512)fail();if(n.nodeType===3){const part=n.nodeValue??'';if(s.length+part.length>4096)fail();s+=part;}}return s.trim();};
  const attrs=(el:Element)=>{const entries=Array.from(el.attributes,a=>[a.name,a.value]).sort((a,b)=>a[0]!.localeCompare(b[0]!));if(entries.length>128||JSON.stringify(entries).length>16384)fail();return entries;};
  const input=e as HTMLInputElement,tag=e.tagName.toLowerCase(),type=(input.type??'').toLowerCase();
  if(type==='file')fail();
  const targetValue=String(input.value??'');if(targetValue.length>4096)fail();
  const labelList=Array.from(input.labels??[]);if(labelList.length>16)fail();
  const refs=(e.getAttribute('aria-labelledby')??'').trim().split(/\s+/).filter(Boolean);if(refs.length>16)fail();
  const root=e.getRootNode() as Document|ShadowRoot;
  const labels=[...labelList,...refs.map(id=>root.getElementById(id)).filter((x):x is HTMLElement=>!!x)];
  if(labels.some(protectedNode))fail();
  const name=[e.getAttribute('aria-label'),...labels.map(text),e.getAttribute('title'),e.getAttribute('placeholder'),text(e)].filter(Boolean).join(' ').slice(0,4096);
  const normalize=(value:string)=>value.normalize('NFKC').replace(/([A-Z])([A-Z][a-z])/g,'$1 $2').replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/([A-Za-z])([0-9])/g,'$1 $2').replace(/([0-9])([A-Za-z])/g,'$1 $2');
  const normalized=normalize(name+' '+e.id+' '+(e.getAttribute('name')??'')+' '+(e.getAttribute('autocomplete')??''));
  const credentialHints=['input','textarea','select'].includes(tag)?normalized:normalize(name);
  const secret=new RegExp(args.pattern,'iu').test(credentialHints)||type==='password';
  const form=(input.form??e.closest('form')) as HTMLFormElement|null;
  const formControls:unknown[]=[],formDetails:{name:string;value:string;secret:boolean}[]=[];
  let formCredential=false;
  if(form){if(form.elements.length>128)fail();for(const item of Array.from(form.elements)){
   if(!(item instanceof Element)||protectedNode(item))fail();
   const field=item as HTMLInputElement;const value=String(field.value??'');if(value.length>4096)fail();
   formControls.push([item.tagName,attrs(item),value,Boolean(field.checked),item instanceof HTMLSelectElement?Array.from(item.selectedOptions,o=>[o.value,o.text]):null]);
   const fieldType=(field.type??'').toLowerCase(),fieldHints=[field.name,field.id,field.getAttribute('aria-label'),field.getAttribute('autocomplete'),...Array.from(field.labels??[]).map(text)].filter(Boolean).join(' ');
   const credential=fieldType==='password'||new RegExp(args.pattern,'iu').test(normalize(fieldHints));
   formCredential ||= credential;
   if(field.name){if(formDetails.length>=24||field.name.length>128)fail();formDetails.push({name:field.name,value,secret:fieldType==='hidden'||credential});}
  }}
  const submit=!!form&&(type==='submit'||type==='image'||tag==='button'&&(!type||type==='submit')||args.action.action==='press'&&args.action.value==='Enter');
  let network:{url:string;method:string;body:string}|undefined;
  if(submit&&type!=='image'&&form&&args.action.action==='click'&&(e.getAttribute('formenctype')||form.enctype)==='application/x-www-form-urlencoded'){
   const method=(e.getAttribute('formmethod')||form.method||'get').toUpperCase();
   const url=new URL(e.getAttribute('formaction')||form.action,doc.location.href);
   if(method==='POST'&&url.origin===doc.location.origin&&!url.username&&!url.password){
    const params=new URLSearchParams();
    const append=(key:string,value:string)=>params.append(key.replace(/\r?\n/g,'\r\n'),value.replace(/\r?\n/g,'\r\n'));
    for(const item of Array.from(form.elements)){
      if(!(item instanceof HTMLElement))fail();
      const field=item as HTMLInputElement,fieldTag=item.tagName.toLowerCase(),fieldType=(field.type||'').toLowerCase();
      if(!['input','select','textarea','button','fieldset','output'].includes(fieldTag))fail();
      if(field.matches(':disabled')||!field.name||['fieldset','output'].includes(fieldTag))continue;
      if(fieldTag==='button'||['submit','image','button','reset'].includes(fieldType)){if(item===e)append(field.name,field.value);continue;}
      if(fieldType==='file')fail();
      if((fieldType==='checkbox'||fieldType==='radio')&&!field.checked)continue;
      if(fieldTag==='select'){for(const option of Array.from((field as unknown as HTMLSelectElement).selectedOptions)){if(!option.disabled&&!option.closest('optgroup:disabled'))append(field.name,option.value);}continue;}
      append(field.name,field.value);
    }
    network={url:url.href,method,body:params.toString()};
   }
  }
  const method=submit&&form?(e.getAttribute('formmethod')||form.method||'get').toUpperCase():'';
  const humanName=normalize(name);
  const searchForm=!!form&&(form.getAttribute('role')==='search'||type==='search'||/\bsearch\b|検索/iu.test(normalize(name))||Array.from(form.elements).some(item=>item instanceof HTMLInputElement&&(item.type==='search'||/^(?:q|query|search)$/i.test(item.name))));
  const consequential=(submit&&(method!=='GET'||!searchForm))||(!searchForm&&/\bsubmit\b/i.test(humanName))||/\b(?:delete|remove(?!\s+filter\b)|upload|send|purchase|checkout|pay|payment|login|log\s*in|sign\s*in|sign\s*up|register|withdraw|transfer|confirm|cancel|order)\b/i.test(humanName)||/(?:\u524a\u9664|\u8cfc\u5165|\u6ce8\u6587|\u652f\u6255|\u6c7a\u6e08|\u9001\u4fe1|\u767b\u9332|\u53d6\u6d88|\u53d6\u308a\u6d88|\u30ad\u30e3\u30f3\u30bb\u30eb|\u632f\u8fbc|\u9001\u91d1|\u8ee2\u9001|\u7533\u8fbc|\u7533\u3057\u8fbc|\u89e3\u7d04|\u78ba\u5b9a|\u30ed\u30b0\u30a4\u30f3)/u.test(humanName);
  const role=e.getAttribute('role')||(tag==='input'?'textbox':tag==='button'?'button':tag==='a'?'link':tag==='select'?'combobox':'generic');
  const details=submit&&form?{method:(e.getAttribute('formmethod')||form.method||'get').toUpperCase(),url:new URL(e.getAttribute('formaction')||form.action,doc.location.href).href,fields:formDetails}:undefined;
  return {risk:(secret||(submit&&formCredential))?'credential':consequential?'consequential':'ordinary',role,name,origin:doc.location.origin,network,details,
   proof:JSON.stringify([doc.location.href,tag,type,attrs(e),name,targetValue,Boolean(input.checked),form?[form.action,form.method,attrs(form),formControls]:null])};
 };
 const data=await isolatedCollect(el,collect,{rules:BROWSER_PRIVACY_RULES,pattern:SECRET_LABEL_PATTERN,action});
 if(data.proof.length>1048576)throw new AdlError('E_RESOURCE_LIMIT');
 const details=data.details?describeApprovalForm(data.details):undefined;
 return {proof:createHash('sha256').update(data.proof).digest('hex'),risk:data.risk as ActionRisk,role:data.role,name:data.name,origin:data.origin,...(details?{details}:{}),...(data.network?{network:data.network}:{})};
}
