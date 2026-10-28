import {createHash} from 'node:crypto';
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
async function isolatedCollect<T>(el:ElementHandle,collect:(node:Element,args:any)=>T,args:unknown):Promise<T>{
 const frame=await el.ownerFrame();if(!frame||frame!==frame.page().mainFrame())throw new AdlError('E_POLICY_DENIED');
 const page=frame.page(),box=await el.boundingBox();if(!box||box.width<=0||box.height<=0)throw new AdlError('E_STALE_STATE');
 const viewport=page.viewportSize();const x=Math.floor(box.x+box.width/2),y=Math.floor(box.y+box.height/2);
 if(x<0||y<0||viewport&&(x>=viewport.width||y>=viewport.height))throw new AdlError('E_STALE_STATE');
 const cdp=await page.context().newCDPSession(page);
 try{
  const hit=await cdp.send('DOM.getNodeForLocation',{x,y,includeUserAgentShadowDOM:false,ignorePointerEventsNone:false});
  const dom=await cdp.send('DOM.getDocument',{depth:-1,pierce:false});
  type Candidate={backend:number;parent?:Candidate;selector:string};
  const pending:{node:typeof dom.root;parent?:Candidate;selector:string}[]=[{node:dom.root,selector:''}];let found:Candidate|undefined,visited=0;
  while(pending.length){
   const item=pending.pop()!;if(++visited>10000)throw new AdlError('E_RESOURCE_LIMIT');
   const current:Candidate={backend:item.node.backendNodeId,parent:item.parent,selector:item.selector};
   if(current.backend===hit.backendNodeId){found=current;break;}
   let index=0;
   for(const child of item.node.children??[]){if(child.nodeType!==1)continue;index++;pending.push({node:child,parent:current,selector:(item.selector?item.selector+' > ':'')+`*:nth-child(${index})`});}
  }
  let selected:Candidate|undefined;
  for(let candidate=found,depth=0;candidate?.selector&&depth++<128;candidate=candidate.parent){
   const other=await page.locator(candidate.selector).elementHandle({timeout:1000});if(!other)continue;
   try{if(await el.evaluate((node,otherNode)=>node===otherNode,other)){selected=candidate;break;}}finally{await other.dispose().catch(()=>undefined);}
  }
  if(!selected)throw new AdlError('E_STALE_STATE');
  const tree=await cdp.send('Page.getFrameTree');
  const world=await cdp.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'adl-approval-proof'});
  const object=await cdp.send('DOM.resolveNode',{backendNodeId:selected.backend,executionContextId:world.executionContextId});
  if(!object.object.objectId)throw new AdlError('E_STALE_STATE');
  const response=await cdp.send('Runtime.callFunctionOn',{objectId:object.object.objectId,functionDeclaration:`function(args){return (${collect.toString()})(this,args)}`,arguments:[{value:args}],returnByValue:true});
  if(response.exceptionDetails||!response.result.value)throw new AdlError('E_PRIVACY_BLOCKED');
  return response.result.value as T;
 }catch(error){if(error instanceof AdlError)throw error;throw new AdlError('E_STALE_STATE');}
 finally{await cdp.detach().catch(()=>undefined);}
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
  const name=[e.getAttribute('aria-label'),...labels.map(text),e.getAttribute('title'),e.getAttribute('placeholder'),text(e),e.id].filter(Boolean).join(' ').slice(0,4096);
  const normalize=(value:string)=>value.normalize('NFKC').replace(/([A-Z])([A-Z][a-z])/g,'$1 $2').replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/([A-Za-z])([0-9])/g,'$1 $2').replace(/([0-9])([A-Za-z])/g,'$1 $2');
  const normalized=normalize(name+' '+e.id+' '+(e.getAttribute('name')??'')+' '+(e.getAttribute('autocomplete')??''));
  const secret=new RegExp(args.pattern,'iu').test(normalized)||type==='password';
  const form=(input.form??e.closest('form')) as HTMLFormElement|null;
  const formControls:unknown[]=[],formDetails:{name:string;value:string;secret:boolean}[]=[];
  if(form){if(form.elements.length>128)fail();for(const item of Array.from(form.elements)){
   if(!(item instanceof Element)||protectedNode(item))fail();
   const field=item as HTMLInputElement;const value=String(field.value??'');if(value.length>4096)fail();
   formControls.push([item.tagName,attrs(item),value,Boolean(field.checked),item instanceof HTMLSelectElement?Array.from(item.selectedOptions,o=>[o.value,o.text]):null]);
   const fieldType=(field.type??'').toLowerCase(),fieldHints=[field.name,field.id,field.getAttribute('aria-label'),field.getAttribute('autocomplete'),...Array.from(field.labels??[]).map(text)].filter(Boolean).join(' ');
   if(field.name){if(formDetails.length>=24||field.name.length>128)fail();formDetails.push({name:field.name,value,secret:fieldType==='hidden'||fieldType==='password'||new RegExp(args.pattern,'iu').test(normalize(fieldHints))});}
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
  const consequential=submit||/(delete|remove|upload|send|submit|purchase|checkout|pay|payment|login|log\s*in|sign\s*in|sign\s*up|register|withdraw|transfer)/i.test(normalized);
  const role=e.getAttribute('role')||(tag==='input'?'textbox':tag==='button'?'button':tag==='a'?'link':tag==='select'?'combobox':'generic');
  const details=submit&&form?{method:(e.getAttribute('formmethod')||form.method||'get').toUpperCase(),url:new URL(e.getAttribute('formaction')||form.action,doc.location.href).href,fields:formDetails}:undefined;
  return {risk:secret?'credential':consequential?'consequential':'ordinary',role,name,origin:doc.location.origin,network,details,
   proof:JSON.stringify([doc.location.href,tag,type,attrs(e),name,targetValue,Boolean(input.checked),form?[form.action,form.method,attrs(form),formControls]:null])};
 };
 const data=await isolatedCollect(el,collect,{rules:BROWSER_PRIVACY_RULES,pattern:SECRET_LABEL_PATTERN,action});
 if(data.proof.length>1048576)throw new AdlError('E_RESOURCE_LIMIT');
 const details=data.details?describeApprovalForm(data.details):undefined;
 return {proof:createHash('sha256').update(data.proof).digest('hex'),risk:data.risk as ActionRisk,role:data.role,name:data.name,origin:data.origin,...(details?{details}:{}),...(data.network?{network:data.network}:{})};
}
