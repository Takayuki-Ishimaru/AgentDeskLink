import * as crypto from 'node:crypto';
import {chromium, type Browser, type BrowserContext, type JSHandle, type ElementHandle, type Frame, type Page, type Route,type Request} from 'playwright';
import {resolveAllowedAddresses,redactString,redactText,redactUrl} from './policy.js';
import {pinnedFetch,redirectStylesheet,PinnedConnectionPool, MAX_BODY, HOP_RE} from './browser-network.js';
import {BrowserResourceCache} from './browser-cache.js';
import {captureBrowserImage} from './browser-visual.js';
import {runBrowserGesture,captureGestureGeometry,type GestureGeometry} from './browser-gesture.js';
import {preflightBrowserInput} from './browser-preflight.js';
import type {ActionAuthorization} from './types.js';
import {ensurePointSelector,pointSelector} from './browser-point.js';
import {inspectBrowserAction,isolatedCollect} from './browser-approval.js';
import {installBrowserIntegrity,registerBrowserPrototypes,type BrowserIntegrity} from './browser-integrity.js';
import {SECRET_LABEL_PATTERN, BROWSER_PRIVACY_RULES} from './privacy.js';
import {ensureBrowserPrivacySelectors} from './browser-privacy.js';
import type {GesturePolicy,GesturePlan,GestureReference,GestureExecution} from './gesture-types.js';
import type {CapturedImage,VisualPolicy} from './visual-types.js';
import {AdlError, type Action, type Adapter, type AdapterSession, type Element as ElementInfo, type Mode, type PolicyConfig, type RawSnapshot, type Target} from './types.js';

function deny(): never {
  throw new AdlError('E_POLICY_DENIED');
}

type Store = {ids: WeakMap<object, string>; nodes: Map<string, object>; seq: number; prefix: string; seen: Set<string>;integrity:BrowserIntegrity};

type PageSnapshot = {elements:ElementInfo[];sig:string;truncated:boolean;navigation:string;actionStates:Record<string,{target:string;form?:string}>;forms:Record<string,string>};

// Runs inside the page against the private store kept in the JSHandle
// closure (WeakMap/Map not on window, unreachable from page scripts).
// Bounded TreeWalker traversal: visit cap, depth cap, output cap; only
// bounded text nodes are read (never textContent on huge subtrees).
function snapshotPageFn(store: Store, cfg: {maxOut: number; visitCap: number; maxDepth: number; fieldMax: number; secretLabelPattern:string; privacyRules:typeof BROWSER_PRIVACY_RULES}): PageSnapshot {
  if(!store.integrity.check())throw new Error('ADL_UNTRUSTED_DOM');
  const clip = (s: string): string => s.length > cfg.fieldMax ? s.slice(0, cfg.fieldMax) : s;
  const idFor = (n: object): string => {
    let id = store.ids.get(n);
    if (!id) {
      id = store.prefix + '-' + (++store.seq).toString(36);
      store.ids.set(n, id);
      store.nodes.set(id, n);
    }
    return id;
  };
  const directText = (el: Element): string => {
    let t = '';
    let visits=0;
    for (let c = el.firstChild; c && t.length < cfg.fieldMax && visits++<64; c = c.nextSibling) {
      if (c.nodeType === 3 && c.textContent) t += c.textContent.slice(0,cfg.fieldMax-t.length);
    }
    return t.trim();
  };
  const directTextInfo=(el:Element):{truncated:boolean;length?:number}=>{
    let full='',visits=0,c:ChildNode|null=el.firstChild;
    for(;c&&visits++<64;c=c.nextSibling){if(c.nodeType===3&&c.nodeValue){if(full.length+c.nodeValue.length>1048576)return {truncated:true};full+=c.nodeValue;}}
    if(c)return {truncated:true};
    const length=full.trim().length;return {truncated:length>cfg.fieldMax,length};
  };
  const visible = (el: HTMLElement): boolean => {
    try {
      return el.checkVisibility({opacityProperty: false, visibilityProperty: true});
    } catch {
      return el.offsetParent !== null || el.getClientRects().length > 0;
    }
  };
  const secretPattern=new RegExp(cfg.secretLabelPattern,'iu');
  const sensitiveLabel=(text:string)=>secretPattern.test(text.normalize('NFKC').replace(/([A-Z])([A-Z][a-z])/g,'$1 $2').replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/([A-Za-z])([0-9])/g,'$1 $2').replace(/([0-9])([A-Za-z])/g,'$1 $2'));
  const inSensitiveRegion=(element:Element):boolean=>{
    let node:Element|null=element,depth=0;
    while(node&&depth++<cfg.privacyRules.ancestorCap){
      if(node.matches(cfg.privacyRules.regionSelector))return true;
      node=node.parentElement??(node.getRootNode() as ShadowRoot).host??null;
    }
    return node!==null; // Incomplete ancestry cannot establish a public region.
  };
  let descendantClipped=false;
  const descendantText=(el:Element,includeHidden=false,failClosed=true):string=>{
    descendantClipped=false;
    if(inSensitiveRegion(el))return "x".repeat(cfg.fieldMax);
    let scanned=0, exhausted=false;
    const walker=document.createTreeWalker(el,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT,{acceptNode:node=>{if(++scanned>128){exhausted=true;return NodeFilter.FILTER_ACCEPT;}return node.nodeType===1&&(node as Element).matches(cfg.privacyRules.textSkipSelector+","+cfg.privacyRules.regionSelector)?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT;}});
    let node:Node|null=walker.nextNode(),text='',visits=0;
    while(node&&!exhausted&&visits++<128&&text.length<cfg.fieldMax){
      if(node.nodeType===3&&!node.parentElement?.closest('script,style')&&(includeHidden||!node.parentElement?.closest('[hidden],[aria-hidden="true"]'))){const value=node.textContent??'';if(value.length>cfg.fieldMax-text.length)descendantClipped=true;text+=value.slice(0,cfg.fieldMax-text.length);}
      node=walker.nextNode();
    }
    descendantClipped ||= !!node||exhausted;
    // An incomplete naming hint cannot establish that a field is public.
    return node&&failClosed?'x'.repeat(cfg.fieldMax):text.trim();
  };
  let referencedClipped=false;
  const referencedName=(el:Element):string=>{
    referencedClipped=false;
    const refs=el.getAttribute('aria-labelledby');if(!refs)return '';
    if(refs.length>4096)throw new Error('Snapshot field limit');
    const ids=refs.trim().split(/\s+/);if(ids.length>16)return 'x'.repeat(cfg.fieldMax);
    const text=ids.map(id=>{const label=(el.getRootNode() as Document|ShadowRoot).getElementById(id);if(!label)return '';const value=descendantText(label,true);referencedClipped ||= descendantClipped;return value;}).join(' ');
    referencedClipped ||= text.length>cfg.fieldMax;return text.slice(0,cfg.fieldMax).trim();
  };
  const CONSEQUENTIAL_RE = /(delete|remove|upload|send|submit|purchase|checkout|pay|payment|login|log in|sign in|sign up|register|withdraw|transfer)/i;
  const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea']);
  const elements: ElementInfo[] = [];
  const sigParts: string[] = [];
  // These complete strings are hashed in Node, never included in public elements.
  // Missing/over-budget evidence disables relaxed freshness for that target.
  const actionStates:PageSnapshot['actionStates']=Object.create(null),forms:Record<string,string>=Object.create(null);
  const formCache=new Map<HTMLFormElement,string|null>();let evidenceBytes=0;
  const accountEvidence=(length:number)=>{if(evidenceBytes+length>4194304)throw new Error('evidence limit');evidenceBytes+=length;};
  const fullAttrs=(element:Element)=>{
    // Pure inline geometry is guarded by the existing input/point preflight.
    // Keeping it out preserves the semantic revision contract for layout drift.
    const attrs=Array.from(element.attributes).filter(a=>a.name!=='style').map(a=>[a.name,a.value]).sort((a,b)=>a[0]!.localeCompare(b[0]!));
    const length=JSON.stringify(attrs).length;if(attrs.length>128||length>16384)throw new Error('evidence limit');accountEvidence(length);
    return attrs;
  };
  const retainedId=(element:Element)=>{const id=idFor(element);store.seen.add(id);return id;};
  const formEvidence=(form:HTMLFormElement):string=>{
    if(formCache.has(form)){const cached=formCache.get(form);if(!cached)throw new Error('evidence unavailable');return cached;}
    formCache.set(form,null);
    if(form.elements.length>128)throw new Error('evidence limit');
    const controls=Array.from(form.elements,item=>{
      const field=item as HTMLInputElement,value=store.integrity.value(item);if(value.length>4096)throw new Error('evidence limit');accountEvidence(value.length);
      if(item instanceof HTMLSelectElement&&item.options.length>128)throw new Error('evidence limit');
      const options=item instanceof HTMLSelectElement?Array.from(item.options,option=>{
        if(option.value.length>4096||option.text.length>4096)throw new Error('evidence limit');accountEvidence(option.value.length+option.text.length);
        return [retainedId(option),fullAttrs(option),option.value,option.text,option.disabled,option.selected];
      }):undefined;
      return [retainedId(item),item.tagName,fullAttrs(item),value,store.integrity.checked(item),Boolean(field.disabled),options];
    });
    const id=retainedId(form),serialized=JSON.stringify([id,fullAttrs(form),form.action,form.method,form.enctype,form.target,controls]);
    if(serialized.length>1048576)throw new Error('evidence limit');accountEvidence(serialized.length);
    forms[id]=serialized;formCache.set(form,id);return id;
  };
  let visited = 0;
  let truncated = false;
  const root = document.body || document.documentElement;
  const pending:{node:HTMLElement;depth:number;group?:string}[]=[{node:root,depth:0}];
  let cur:HTMLElement;
  let depth = 0;
  while (pending.length) {
    if (visited++ >= cfg.visitCap) {truncated=true;break;}
    const item=pending.pop()!;cur=item.node;depth=item.depth;
    const skipChildren = depth >= cfg.maxDepth;
    if(skipChildren&&cur.firstElementChild)truncated=true;
    const tag = cur.tagName.toLowerCase();
    const type = tag === 'input' ? ((cur as HTMLInputElement).type || 'text').toLowerCase() : '';
    const roleAttr = cur.getAttribute('role');
    if((roleAttr?.length??0)>100||cur.id.length>512)throw new Error('Snapshot field limit');
    const isInteractive = INTERACTIVE.has(tag) && (tag !== 'a' || cur.hasAttribute('href')) && type !== 'hidden';
    const isStatus = roleAttr === 'status' || roleAttr === 'alert' || cur.hasAttribute('aria-live');
    const clickable=cur.hasAttribute('onclick')||cur.tabIndex>=0&&getComputedStyle(cur).cursor==='pointer';
    const isText=/^(div|p|span|legend|h[1-6]|td|th|li|dt|dd|blockquote|code|pre|time|caption|figcaption|summary|strong|em|b|i|small|mark|q|samp|kbd|cite|abbr|address|article|section|main|header|footer|aside|output)$/.test(tag)&&!!directText(cur);
    const structural=['table','tr','ul','ol','li'].includes(tag);
    const interesting = (isInteractive || clickable || isStatus || roleAttr || isText || structural || tag==='td' || tag==='th' || tag==='img'&&cur.hasAttribute('alt')) && visible(cur);
    let childGroup=item.group;
    if (interesting) {
      if (elements.length >= cfg.maxOut) {
        truncated = true;
        break;
      }
      let role = roleAttr || '';
      if (!role) {
        if (tag === 'table') role='table';
        else if(tag==='tr')role='row';
        else if(tag==='ul'||tag==='ol')role='list';
        else if(tag==='li')role='listitem';
        else if(tag==='td')role='cell';
        else if (tag === 'button') role = 'button';
        else if (tag === 'a') role = 'link';
        else if (tag === 'select') role = 'combobox';
        else if (tag === 'textarea') role = 'textbox';
        else if (tag === 'input') role = type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'submit' ? 'button' : type === 'file' ? 'file' : 'textbox';
        else role = tag==='img'?'img':tag==='th'?'columnheader':/^h[1-6]$/.test(tag)?'heading':clickable?'button':tag==='blockquote'?'blockquote':tag==='code'||tag==='pre'?'code':tag==='time'?'time':tag==='caption'||tag==='figcaption'?'caption':isText?'text':'generic';
      }
      const bodyText=!isInteractive&&!clickable&&cfg.privacyRules.textRoles.some(textRole=>textRole===role);
      const form = cur.closest('form');
      const labelEl = (tag === 'input' || tag === 'textarea' || tag === 'select') ? (cur as HTMLInputElement).labels?.[0] : undefined;
      const ownText = directText(cur);
      const labelText=labelEl?descendantText(labelEl):'',labelClipped=!!labelEl&&descendantClipped;
      const referenceText=referencedName(cur),referenceClipped=referencedClipped;
      const useOwn=isText&&!isInteractive&&!clickable&&!roleAttr;
      const descendant=useOwn?'':descendantText(cur,false,!bodyText),descendantWasClipped=descendantClipped;
      const rawName=referenceText || cur.getAttribute('aria-label') || labelText || (useOwn ? ownText : descendant) || cur.getAttribute('alt') || cur.getAttribute('placeholder') || cur.getAttribute('title') || cur.id || '';
      const derived=!(referenceText||cur.getAttribute('aria-label')||labelText);
      const ownInfo=useOwn?directTextInfo(cur):undefined;
      const nameTruncated=(referenceText?referenceClipped:cur.getAttribute('aria-label')?false:labelText?labelClipped:useOwn?ownInfo!.truncated:descendantWasClipped)||rawName.length>cfg.fieldMax;
      const textLength=derived&&useOwn&&!cur.firstElementChild?ownInfo?.length:undefined;
      if(rawName.length>4096)throw new Error('Snapshot field limit');
      const name = clip(rawName);
      if(nameTruncated)truncated=true;
      const isPassword = tag === 'input' && type === 'password';
      const rawNameAttr = cur.getAttribute('name') || '';
      if(rawNameAttr.length>512)throw new Error('Snapshot field limit');
      const hints=[...(bodyText?[]:[rawName]),labelText,...(labelEl?[descendantText(labelEl,true)]:[]),referenceText,cur.getAttribute('aria-label')||'',cur.getAttribute('placeholder')||'',cur.getAttribute('title')||'',cur.getAttribute('autocomplete')||'',cur.id,rawNameAttr];
      if(hints.some(hint=>hint.length>4096))throw new Error('Snapshot field limit');
      const credentialField=['input','textarea','select'].includes(tag)||role==='textbox'||role==='searchbox';
      const semanticHints=[referenceText,cur.getAttribute('aria-label')||'',cur.getAttribute('title')||'',cur.getAttribute('autocomplete')||'',...([cur.id,rawNameAttr].filter(hint=>!/^(?:cookie|key|pin|session)$/i.test(hint)))];
      let sensitive = isPassword || inSensitiveRegion(cur) || (credentialField?hints:semanticHints).some(hint=>hint.length>=cfg.fieldMax||sensitiveLabel(hint));
      let rawVal = '';
      if (tag === 'input' || tag === 'textarea') rawVal = store.integrity.value(cur);
      else if (tag === 'select') {
        const sel = cur as HTMLSelectElement;
        rawVal = sel.options[sel.selectedIndex]?.value ?? '';
        if(sel.selectedIndex>=0&&(inSensitiveRegion(sel.options[sel.selectedIndex]!)||sensitiveLabel(sel.options[sel.selectedIndex]?.label??'')))sensitive=true;
      }
      if(rawVal.length>4096)throw new Error('Snapshot field limit');
      const value = isPassword ? undefined : clip(rawVal);
      const enabled = !(cur as HTMLButtonElement).disabled && !cur.closest('fieldset:disabled') && cur.getAttribute('aria-disabled')!=='true';
      const checked = tag === 'input' && (type === 'checkbox' || type === 'radio') ? store.integrity.checked(cur) : undefined;
      const selected = cur.hasAttribute('aria-selected')?cur.getAttribute('aria-selected')==='true':tag === 'select' ? (cur as HTMLSelectElement).selectedIndex >= 0 : undefined;
      const expanded=cur.hasAttribute('aria-expanded')?cur.getAttribute('aria-expanded')==='true':undefined;
      let options:ElementInfo['options'];
      let optionsTruncated=false;
      if(tag==='select'){
        const entries=(cur as HTMLSelectElement).options;
        if(entries.length>100){truncated=true;optionsTruncated=true;}
        options=[];
        for(let i=0;i<Math.min(entries.length,100);i++){
          const option=entries[i]!;
          if(option.label.length>4096||option.value.length>4096)throw new Error('Snapshot field limit');
          const hidden=inSensitiveRegion(option)||sensitiveLabel(option.label);
          if(option.label.length>cfg.fieldMax||option.value.length>cfg.fieldMax){truncated=true;optionsTruncated=true;}
          options.push({label:hidden?'[redacted]':clip(option.label),value:hidden?'[redacted]':clip(option.value),disabled:option.disabled||option.parentElement?.matches('optgroup:disabled')===true,selected:option.selected});
        }
      }
      const isSubmitControl = (tag === 'button' && (cur.getAttribute('type') || 'submit') === 'submit' && !!form) || (tag === 'input' && type === 'submit');
      const consequential = CONSEQUENTIAL_RE.test(name) || CONSEQUENTIAL_RE.test(rawNameAttr) || isSubmitControl;
      const href = tag === 'a' ? cur.getAttribute('href') || '' : '';
      const actionAttr = form ? form.getAttribute('action') || '' : '';
      if(href.length>2048||actionAttr.length>2048)throw new Error('Snapshot field limit');
      const id = idFor(cur);
      store.seen.add(id);
      if(structural)childGroup=id;
      const signature=JSON.stringify([id, role, rawName, enabled, checked, selected, expanded, type, consequential, href, actionAttr, rawVal,ownText,sensitive,options,optionsTruncated,depth]);
      sigParts.push(signature);
      try{
        if(optionsTruncated)throw new Error('evidence limit');
        // Child frames deliberately retain strict revision checks. Their stores
        // are collected separately and not merged into the main action map.
        const owningForm=((cur as HTMLInputElement).form??cur.closest('form')) as HTMLFormElement|null;
        const formId=owningForm?formEvidence(owningForm):undefined;
        const target=JSON.stringify([signature,fullAttrs(cur),tag==='a'?(cur as HTMLAnchorElement).href:null,
          (cur as HTMLInputElement).formAction??null,(cur as HTMLInputElement).formMethod??null,
          (cur as HTMLInputElement).formEnctype??null,(cur as HTMLInputElement).formTarget??null]);
        accountEvidence(target.length);actionStates[id]={target,...(formId?{form:formId}:{})};
      }catch{/* Observation remains available; incomplete evidence never authorizes freshness fallback. */}
      elements.push({id, role, name, depth,...(item.group?{parent_id:item.group}:{}),...(nameTruncated&&!inSensitiveRegion(cur)?{name_truncated:true}:{}),...(textLength!==undefined&&!inSensitiveRegion(cur)?{text_length:textLength}:{}), ...(options?{options,...(optionsTruncated?{options_truncated:true}:{})}:{}), ...(value !== undefined ? {value} : {}), enabled, ...(checked !== undefined ? {checked} : {}), ...(selected !== undefined ? {selected} : {}), ...(expanded!==undefined?{expanded}:{}),...(inSensitiveRegion(cur)?{protected:true}:{}), ...(sensitive ? {sensitive: true} : {})});
    }
    if(!skipChildren){
      const children=Array.from(cur.children) as HTMLElement[];
      if(cur.shadowRoot)children.push(...Array.from(cur.shadowRoot.children) as HTMLElement[]);
      for(let i=children.length-1;i>=0;i--)pending.push({node:children[i]!,depth:depth+1,group:childGroup});
    }
  }
  if(!store.integrity.check())throw new Error('ADL_UNTRUSTED_DOM');
  return {elements,sig:JSON.stringify(sigParts),truncated,navigation:JSON.stringify([store.prefix,location.href,document.baseURI]),actionStates,forms};
}

const STORE_INIT = (key:string) => {
  const integrity=(window as unknown as Record<string,BrowserIntegrity>)[key];
  if(!integrity||!integrity.check())throw new Error('ADL_UNTRUSTED_DOM');
  return {ids:new WeakMap<object,string>(),nodes:new Map<string,object>(),seq:0,prefix:'',seen:new Set<string>(),integrity};
};

class BrowserSession implements AdapterSession {
  readonly tracksDispatch=true;
  private readonly frameStores=new Map<Frame,JSHandle<Store>>();
  private frameSeq=0;
  private readonly networkBlocks=new Map<string,{code:string;count:number;origin?:string}>();
  recordNetworkBlock(code:string,origin?:string){
    if(origin){try{origin=new URL(origin).origin;}catch{origin=undefined;}}
    const key=code+'|'+(origin??'');const old=this.networkBlocks.get(key);
    if(old){old.count=Math.min(old.count+1,999999);return;}
    if(this.networkBlocks.size<8)this.networkBlocks.set(key,{code,count:1,...(origin?{origin}:{})});
  }
  pendingDocumentRedirect:string|undefined;
  documentRedirects=0;
  stylesheetRedirects=0;
  approvedRequest?:{url:string;method:string;body:string;expires:number;frame:Frame};
  private manualNetworkExpires=0;
  private manualNetworkGeneration=0;
  manualRequestGeneration(request:Request):number|undefined{return this.consumeManualRequest(request)?this.manualNetworkGeneration:undefined;}
  manualRequestCurrent(request:Request,generation:number):boolean{return generation===this.manualNetworkGeneration&&this.consumeManualRequest(request);}
  consumeManualRequest(request:Request):boolean{
    return this.manualNetworkExpires>Date.now()&&request.frame()===this.page.mainFrame()&&new URL(request.url()).origin===this.origin;
  }

  private async settleRedirect():Promise<void>{
    const deadline=Date.now()+Math.min(5000,this.policy.actionTimeoutMs);
    while(this.pendingDocumentRedirect){
      if(Date.now()>=deadline)throw new AdlError('E_POLICY_DENIED');
      const destination=this.pendingDocumentRedirect;
      try{await this.page.waitForURL(destination,{waitUntil:'domcontentloaded',timeout:Math.max(1,deadline-Date.now())});}
      catch{throw new AdlError('E_POLICY_DENIED');}
      // A self-redirect can already match the current URL. Yield to the route
      // handler rather than spinning on immediately fulfilled promises.
      await new Promise<void>(resolve=>setImmediate(resolve));
      this.checkAlive();
    }
  }

  private closed = false;
  private closing:Promise<void>|undefined;
  private store: JSHandle<Store> | null = null;
  private pageValue: Page | null = null;
  private documentGeneration=0;
  private storeGeneration=0;
  private readonly visualEpoch=crypto.randomUUID();
  private readonly captureGeometry=new Map<string,{generation:number;geometry:GestureGeometry;pointNonce?:string}>();
  openAbortCleanup: (() => void) | undefined;
  prefix = crypto.randomBytes(9).toString('base64url');
  readonly controller = new AbortController();
  readonly transportPool=new PinnedConnectionPool();
  readonly resourceCache=new BrowserResourceCache();

  constructor(
    private readonly owner: BrowserAdapter,
    private readonly policy: PolicyConfig,
    readonly context: BrowserContext,
    private readonly initialOrigin: string,
    private readonly controls: {selector: string; actions: string[]}[],
    private readonly visual?:VisualPolicy,
    private readonly gestures?:GesturePolicy,
    private readonly integrityKey='',
    private readonly registrationSecret='',
  ) {}

  get origin():string {return this.policy.allowAllOperations&&this.pageValue?new URL(this.pageValue.url()).origin:this.initialOrigin;}

  private get page(): Page {
    if (!this.pageValue || !this.store) throw new AdlError('E_TARGET_NOT_FOUND');
    return this.pageValue;
  }

  async attach(page: Page): Promise<void> {
    this.pageValue = page;
    page.on('framenavigated',frame=>{if(frame===page.mainFrame())this.documentGeneration++;});
    this.store = await this.freshStore();
    this.storeGeneration = this.documentGeneration;
  }

  async sessionReady(): Promise<void> {
    await this.settleRedirect();
    await this.freshStoreAssign();
  }

  private async freshStore(): Promise<JSHandle<Store>> {
    if (!this.pageValue) throw new AdlError('E_TARGET_NOT_FOUND');
    this.prefix=crypto.randomBytes(9).toString('base64url');
    const handle=await this.initializeStore(this.pageValue);
    await handle.evaluate((s: Store, prefix: string) => {
      s.prefix = prefix;
    }, this.prefix);
    return handle as JSHandle<Store>;
  }

  private checkAlive(): void {
    if (this.closed) throw new AdlError('E_TARGET_NOT_FOUND');
  }
  private async registerPrototypes(signal?:AbortSignal):Promise<void>{
    if(!this.pageValue)throw new AdlError('E_TARGET_NOT_FOUND');
    try{await registerBrowserPrototypes(this.pageValue,{key:this.integrityKey,registrationSecret:this.registrationSecret},AbortSignal.any([this.controller.signal,...(signal?[signal]:[])]));}
    catch(error){if(error instanceof AdlError&&error.code==='E_PRIVACY_BLOCKED'&&!error.reason)throw new AdlError('E_PRIVACY_BLOCKED','untrusted_dom_api');throw error;}
  }
  private async initializeStore(frame:Page|Frame,signal?:AbortSignal):Promise<JSHandle<Store>>{
    try{return await frame.evaluateHandle(STORE_INIT,this.integrityKey);}
    catch(error){
      if(!(error instanceof Error&&error.message.includes('ADL_UNTRUSTED_DOM')))throw error;
      await this.registerPrototypes(signal);
      try{return await frame.evaluateHandle(STORE_INIT,this.integrityKey);}
      catch(error){if(error instanceof Error&&error.message.includes('ADL_UNTRUSTED_DOM'))throw new AdlError('E_PRIVACY_BLOCKED','untrusted_dom_api');throw error;}
    }
  }
  private async collectSnapshot(store:JSHandle<Store>,cfg:Parameters<typeof snapshotPageFn>[1],signal?:AbortSignal):Promise<PageSnapshot>{
    try{return await store.evaluate(snapshotPageFn,cfg);}
    catch(error){
      if(!(error instanceof Error&&error.message.includes('ADL_UNTRUSTED_DOM')))throw error;
      await this.registerPrototypes(signal);
      try{return await store.evaluate(snapshotPageFn,cfg);}
      catch(error){if(error instanceof Error&&error.message.includes('ADL_UNTRUSTED_DOM'))throw new AdlError('E_PRIVACY_BLOCKED','untrusted_dom_api');throw error;}
    }
  }
  private async assertIntegrity(signal?:AbortSignal):Promise<void>{
    this.checkAlive();
    for(const store of [this.store,...this.frameStores.values()]){
      if(!store)throw new AdlError('E_TARGET_NOT_FOUND');
      let intact=false;try{intact=await store.evaluate(value=>value.integrity.check());}catch{throw new AdlError('E_STALE_STATE');}
      if(!intact){await this.registerPrototypes(signal);if(!await store.evaluate(value=>value.integrity.check()))throw new AdlError('E_PRIVACY_BLOCKED','untrusted_dom_api');}
    }
  }

  private async freshStoreAssign(): Promise<void> {
    this.checkAlive();
    const gen = this.documentGeneration;
    const candidate = await this.freshStore();
    // Recheck lifetime and origin before publishing; never leave a handle
    // installed on a closed session, and dispose the candidate on failure.
    try {
      this.checkAlive();
      if (new URL(this.page.url()).origin !== this.origin) {
        await this.close();
        throw new AdlError('E_POLICY_DENIED');
      }
    } catch (e) {
      await candidate.dispose().catch(() => undefined);
      throw e;
    }
    const old = this.store;
    this.store = candidate;
    // A navigation committed while the handle was being created leaves
    // storeGeneration behind, so snapshot() recovers lazily next time.
    this.storeGeneration = gen;
    if (old) await old.dispose().catch(() => undefined);
  }

  // True only when a main-frame document navigation was observed (generation
  // advanced past the store's) and the old handle's context is confirmed
  // destroyed. Without a generation change it returns false so unrelated
  // evaluate errors are never masked and same-document hash/pushState keep
  // stable IDs.
  private async storeContextGone(): Promise<boolean> {
    const store = this.store;
    if (!store || this.closed) return false;
    const page = this.pageValue;
    if (!page || page.isClosed()) return false;
    try { await store.evaluate(() => undefined); return false; } catch {
      // Context destruction can arrive just before the main-frame commit event.
      // Confirm that event with a bounded read-only wait instead of turning this
      // short navigation race into E_INTERNAL. A live store or unrelated error
      // still cannot trigger recovery, and same-document changes keep their IDs.
      if (this.documentGeneration === this.storeGeneration) {
        await page.waitForEvent('framenavigated', {predicate:frame=>frame===page.mainFrame(),timeout:150}).catch(()=>undefined);
      }
      return !this.closed && !page.isClosed() && this.documentGeneration !== this.storeGeneration;
    }
  }

  async snapshot(signal?:AbortSignal): Promise<RawSnapshot> {
    this.checkAlive();
    await this.settleRedirect();
    if(new URL(this.page.url()).origin!==this.origin){await this.close();throw new AdlError('E_POLICY_DENIED');}
    const maxOut = 20000;
    const cfg = {maxOut, visitCap: 100000, maxDepth: 12, fieldMax: 512,secretLabelPattern:SECRET_LABEL_PATTERN,privacyRules:BROWSER_PRIVACY_RULES};
    let res: PageSnapshot;
    try {
      res = await this.collectSnapshot(this.store!,cfg,signal);
    } catch (e) {
      if (e instanceof AdlError) throw e;
      if(e instanceof Error&&e.message.includes('ADL_UNTRUSTED_DOM'))throw new AdlError('E_PRIVACY_BLOCKED','untrusted_dom_api');
      if(e instanceof Error&&e.message.includes('Snapshot field limit'))throw new AdlError('E_RESOURCE_LIMIT');
      this.checkAlive();
      // Bounded lazy recovery: a same-origin document replacement (link click)
      // destroys the store handle's context; rebuild once, only when confirmed.
      if (!(await this.storeContextGone())) {this.checkAlive();throw new AdlError('E_INTERNAL');}
      if(new URL(this.page.url()).origin!==this.origin){await this.close();throw new AdlError('E_POLICY_DENIED');}
      await this.freshStoreAssign();
      this.checkAlive();
      try {
        res = await this.collectSnapshot(this.store!,cfg,signal);
      } catch (e2) {
        if (e2 instanceof AdlError) throw e2;
        if(e2 instanceof Error&&e2.message.includes('ADL_UNTRUSTED_DOM'))throw new AdlError('E_PRIVACY_BLOCKED','untrusted_dom_api');
        if(e2 instanceof Error&&e2.message.includes('Snapshot field limit'))throw new AdlError('E_RESOURCE_LIMIT');
        this.checkAlive();
        throw new AdlError('E_INTERNAL');
      }
    }
    this.checkAlive();
    if(new URL(this.page.url()).origin!==this.origin){await this.close();throw new AdlError('E_POLICY_DENIED');}
    // Each allowed frame has a private store in its own realm. Cross-origin DOM
    // access is never used; the same network/origin guard gates frame observation.
    for(const [frame,store] of this.frameStores)if(frame.isDetached()){this.frameStores.delete(frame);await store.dispose().catch(()=>undefined);}
    const frames=this.page.frames().filter(frame=>frame!==this.page.mainFrame());
    if(frames.length>32)res.truncated=true;
    for(const frame of frames.slice(0,32)){
      if(res.elements.length>=maxOut){res.truncated=true;break;}
      try{
        let frameUrl=frame.url();
        if(frameUrl==='about:blank'||frameUrl==='about:srcdoc')frameUrl=frame.parentFrame()?.url()??'';
        await this.owner.callGuard(frameUrl);
        let parent:Frame|null=frame,protectedFrame=false;
        while(parent?.parentFrame()){
          const host=await parent.frameElement();
          if(!await host.isVisible()){await host.dispose();protectedFrame=true;break;}
          protectedFrame=await host.evaluate((element,rule)=>{
            let node:Element|null=element as Element;let depth=0;
            while(node&&depth++<rule.ancestorCap){if(node.matches(rule.regionSelector))return true;node=node.parentElement??(node.getRootNode() as ShadowRoot).host??null;}
            return node!==null;
          },BROWSER_PRIVACY_RULES);
          await host.dispose();if(protectedFrame)break;parent=parent.parentFrame();
        }
        if(protectedFrame)continue;
        let store=this.frameStores.get(frame);
        if(store){try{await store.evaluate(()=>undefined);}catch{await store.dispose().catch(()=>undefined);this.frameStores.delete(frame);store=undefined;}}
        if(!store){store=await this.initializeStore(frame,signal);await store.evaluate((value,prefix)=>{value.prefix=prefix;},`${this.prefix}_f${++this.frameSeq}`);this.frameStores.set(frame,store);}
        const child=await this.collectSnapshot(store,{...cfg,maxOut:maxOut-res.elements.length},signal);
        res.elements.push(...child.elements);res.sig+=child.sig;res.truncated||=child.truncated;
        await store.evaluate(value=>{for(const [id,node]of value.nodes)if(!value.seen.has(id)){value.ids.delete(node);value.nodes.delete(id);}value.seen.clear();});
      }catch{res.truncated=true;}
    }
    // Prune the private handle table to the current observation (bounds memory).
    await this.store!.evaluate((s: Store) => {
      for (const id of Array.from(s.nodes.keys())) {
        if (!s.seen.has(id)) {
          const n = s.nodes.get(id);
          if (n) s.ids.delete(n);
          s.nodes.delete(id);
        }
      }
      s.seen.clear();
    }, undefined).catch(() => undefined);
    this.checkAlive();
    if(new URL(this.page.url()).origin!==this.origin){await this.close();throw new AdlError('E_POLICY_DENIED');}
    await this.owner.callGuard(this.page.url());
    const url=redactUrl(this.page.url(),this.policy.allowPersonalData),title=redactString(await this.page.title(),this.policy.allowPersonalData);
    const warnings=[...this.networkBlocks.values()].map(w=>({...w}));
    const digest=(value:string)=>crypto.createHash('sha256').update(value).digest('hex');
    const formDigests=Object.fromEntries(Object.entries(res.forms).map(([id,value])=>[id,digest(value)]));
    const actionEvidence={navigation:digest(JSON.stringify([res.navigation,this.documentGeneration])),elements:Object.fromEntries(Object.entries(res.actionStates).map(([id,state])=>[id,digest(JSON.stringify([state.target,state.form?formDigests[state.form]:null]))]))};
    const fingerprint=digest(res.sig+JSON.stringify([url,title,warnings,actionEvidence]));
    await this.assertIntegrity(signal);
    return {elements:res.elements,fingerprint,truncated:res.truncated,url,title,actionEvidence,...(warnings.length?{warnings}:{})};
  }

  async readText(elementId:string,offset:number,length:number,signal:AbortSignal):Promise<{text:string;total_length:number;next_offset:number|null;truncated:boolean}>{
    this.checkAlive();
    if(signal.aborted)throw new AdlError('E_CANCELLED');
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>1048576)throw new AdlError('E_INVALID_ARGUMENT');
    let store=this.store!,frame:Frame|undefined;
    if(!elementId.startsWith(this.prefix+'-')){
      store=null as unknown as JSHandle<Store>;
      for(const [candidate,value] of this.frameStores){if(await value.evaluate((s,id)=>s.nodes.has(id),elementId)){store=value;frame=candidate;break;}}
      if(!store||!frame)throw new AdlError('E_TARGET_NOT_FOUND');
      for(let current:Frame|null=frame;current?.parentFrame();current=current.parentFrame()){
        const url=current.url().startsWith('about:')?current.parentFrame()!.url():current.url();await this.owner.callGuard(url);
        const host=await current.frameElement();
        try{if(await host.evaluate((element,rules)=>{let node:Element|null=element as Element,depth=0;while(node&&depth++<rules.ancestorCap){if(node.matches(rules.regionSelector))return true;node=node.parentElement??(node.getRootNode() as ShadowRoot).host??null;}return node!==null;},BROWSER_PRIVACY_RULES))throw new AdlError('E_PRIVACY_BLOCKED');}finally{await host.dispose();}
      }
    }
    const generation=this.documentGeneration;
    const handle=await store.evaluateHandle((s,id)=>s.nodes.get(id)??null,elementId);
    const element=handle.asElement() as ElementHandle|null;if(!element){await handle.dispose();throw new AdlError('E_TARGET_NOT_FOUND');}
    let result:{error:'missing'|'protected'}|{text:string;truncated:boolean};
    try{
      await element.scrollIntoViewIfNeeded({timeout:this.policy.actionTimeoutMs});
      result=await isolatedCollect(element,(root,arg:{rules:typeof BROWSER_PRIVACY_RULES;pattern:string})=>{
      if(!root.isConnected)return {error:'missing' as const};
      const protectedNode=(element:Element)=>{let n:Element|null=element,depth=0;while(n&&depth++<arg.rules.ancestorCap){if(n.matches(arg.rules.regionSelector))return true;n=n.parentElement??(n.getRootNode() as ShadowRoot).host??null;}return n!==null;};
      if(protectedNode(root))return {error:'protected' as const};
      const secret=new RegExp(arg.pattern,'iu');
      const skip=(e:Element)=>{
        if(e.matches('script,style,input,textarea,select,option,optgroup')||e.matches(arg.rules.regionSelector))return true;
        if(e instanceof HTMLLabelElement){const field=e.control;if(field){const hints=[field.id,field.getAttribute('name'),field.getAttribute('autocomplete'),field.getAttribute('aria-label')].filter(Boolean).join(' ');if(protectedNode(field)||(field as HTMLInputElement).type==='password'||secret.test(hints))return true;}}
        return false;
      };
      for(let ancestor:Element|null=root,depth=0;ancestor&&depth++<arg.rules.ancestorCap;ancestor=ancestor.parentElement??(ancestor.getRootNode() as ShadowRoot).host??null)if(skip(ancestor))return {text:'',truncated:false};
      const walker=root.ownerDocument.createTreeWalker(root,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT,{acceptNode:n=>n.nodeType===1&&skip(n as Element)?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});
      let text='',visited=0,node:Node|null=walker.nextNode(),truncated=false;
      while(node){if(++visited>100000){truncated=true;break;}if(node.nodeType===3){const value=node.nodeValue??'';const remaining=1048576-text.length;if(value.length>remaining){text+=value.slice(0,remaining);truncated=true;break;}text+=value;}node=walker.nextNode();}
      // Never return the prefix of a token cut at the source cap.
      if(truncated)text=text.replace(/[A-Za-z0-9._%+@-]+$/u,'');
      return {text,truncated};
    },{rules:BROWSER_PRIVACY_RULES,pattern:SECRET_LABEL_PATTERN});
    }finally{await handle.dispose().catch(()=>undefined);}
    this.checkAlive();if(signal.aborted)throw new AdlError('E_CANCELLED');if(generation!==this.documentGeneration)throw new AdlError('E_STALE_STATE');
    if('error'in result)throw new AdlError(result.error==='protected'?'E_PRIVACY_BLOCKED':'E_TARGET_NOT_FOUND');
    const text=redactText(result.text,this.policy.allowPersonalData===true);
    const high=(code:number)=>code>=0xd800&&code<=0xdbff,low=(code:number)=>code>=0xdc00&&code<=0xdfff;
    if(offset>text.length||offset>0&&low(text.charCodeAt(offset))&&high(text.charCodeAt(offset-1)))throw new AdlError('E_INVALID_ARGUMENT');
    let end=Math.min(text.length,offset+length);
    if(end<text.length&&high(text.charCodeAt(end-1))&&low(text.charCodeAt(end)))end++;
    return {text:text.slice(offset,end),total_length:text.length,next_offset:end<text.length?end:null,truncated:result.truncated};
  }

  async capture(signal:AbortSignal):Promise<CapturedImage>{
    this.checkAlive();
    await this.assertIntegrity(signal);
    if(signal.aborted){await this.close();throw new AdlError('E_CANCELLED');}
    const onAbort=()=>{void this.close();};
    signal.addEventListener('abort',onAbort,{once:true});
    let timer:NodeJS.Timeout|undefined;
    const generation=this.documentGeneration;
    try{
      return await Promise.race([
        (async()=>{
          await ensurePointSelector();const pointNonce=crypto.randomBytes(12).toString('base64url');
          const pointReady=await this.page.locator(pointSelector('capture',pointNonce)).count()===1;
          const geometry=await captureGestureGeometry(this.page,this.gestures??{enabled:false,surfaces:[]},signal);
          const image=await captureBrowserImage(this.page,this.origin,this.visual,signal,this.policy.allowPersonalData);
          const after=await captureGestureGeometry(this.page,this.gestures??{enabled:false,surfaces:[]},signal);
          this.checkAlive();if(signal.aborted)throw new AdlError('E_CANCELLED');
          if(JSON.stringify(geometry)!==JSON.stringify(after)||generation!==this.documentGeneration)throw new AdlError('E_STALE_STATE');
          if(pointReady&&await this.page.locator(pointSelector('validate',pointNonce)).count()!==1)throw new AdlError('E_STALE_STATE');
          const epoch=`${this.visualEpoch}:${generation}:${crypto.randomBytes(9).toString('base64url')}`;
          this.captureGeometry.set(epoch,{generation,geometry,...(pointReady?{pointNonce}:{})});
          while(this.captureGeometry.size>16)this.captureGeometry.delete(this.captureGeometry.keys().next().value!);
          await this.assertIntegrity(signal);
          return {...image,surface_epoch:epoch};
        })(),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>{void this.close();reject(new AdlError('E_TIMEOUT'));},this.policy.actionTimeoutMs);}),
      ]);
    }catch(error){if(error instanceof AdlError&&['E_TIMEOUT','E_CANCELLED'].includes(error.code))await this.close();throw error;}
    finally{if(timer)clearTimeout(timer);signal.removeEventListener('abort',onAbort);}
  }

  async gesture(plan:GesturePlan,reference:GestureReference,signal:AbortSignal):Promise<GestureExecution>{
    await this.assertIntegrity(signal);
    this.checkAlive();
    const proof=reference.surface_epoch?this.captureGeometry.get(reference.surface_epoch):undefined;
    const assertCurrent=()=>{this.checkAlive();if(!proof||proof.generation!==this.documentGeneration)throw new AdlError('E_STALE_STATE');if(new URL(this.page.url()).origin!==this.origin)throw new AdlError('E_POLICY_DENIED');};
    assertCurrent();
    try{return await runBrowserGesture(this.page,plan,this.gestures??{enabled:false,surfaces:[]},reference,signal,assertCurrent,this.policy.allowAllOperations,proof!.geometry);}
    catch(error){if(signal.aborted||(error instanceof AdlError&&error.mayHaveExecuted))await this.close();throw error;}
  }

  private async pointTarget(point:{x:number;y:number},reference:GestureReference,signal:AbortSignal){
    this.checkAlive();if(signal.aborted)throw new AdlError('E_CANCELLED');
    const proof=reference.surface_epoch?this.captureGeometry.get(reference.surface_epoch):undefined;
    if(!proof?.pointNonce||proof.generation!==this.documentGeneration||reference.coordinate_space!=='viewport_css_pixels')throw new AdlError('E_STALE_STATE');
    const cdp=await this.context.newCDPSession(this.page);
    try{
      const hit=await cdp.send('DOM.getNodeForLocation',{x:Math.floor(point.x),y:Math.floor(point.y),includeUserAgentShadowDOM:true});
      const tree=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});
      const pending=[{node:tree.root,closed:false}];let visited=0,found=false;
      while(pending.length){const item=pending.pop()!;if(++visited>10000)throw new AdlError('E_RESOURCE_LIMIT');const closed=item.closed||item.node.shadowRootType==='closed';
        if(item.node.backendNodeId===hit.backendNodeId){found=true;if(closed)throw new AdlError('E_PRIVACY_BLOCKED');break;}
        for(const node of [...(item.node.children??[]),...(item.node.shadowRoots??[])])pending.push({node,closed});
      }
      if(!found)throw new AdlError('E_STALE_STATE');
    }catch(error){if(error instanceof AdlError)throw error;throw new AdlError('E_STALE_STATE');}finally{await cdp.detach().catch(()=>undefined);}
    if(signal.aborted)throw new AdlError('E_CANCELLED');
    return this.page.locator(pointSelector('point',proof.pointNonce,point.x,point.y));
  }
  async resolvePoint(point:{x:number;y:number},reference:GestureReference,signal:AbortSignal){
    const locator=await this.pointTarget(point,reference,signal);if(await locator.count()!==1)throw new AdlError('E_STALE_STATE');
    const node=await locator.elementHandle();if(!node)throw new AdlError('E_STALE_STATE');
    try{return await this.store!.evaluate((store,args)=>{let e:Element|null=args.node as Element,depth=0;while(e&&depth++<128){for(const [id,node]of store.nodes)if(node===e)return id;e=e.parentElement??(e.getRootNode() as ShadowRoot).host??null;}return undefined;},{node});}
    finally{await node.dispose();}
  }
  async clickPoint(point:{x:number;y:number},reference:GestureReference,signal:AbortSignal,onDispatch:()=>void){
    await this.assertIntegrity(signal);
    if(!this.policy.allowAllOperations)throw new AdlError('E_APPROVAL_REQUIRED','operation_not_granted');
    const locator=await this.pointTarget(point,reference,signal);if(await locator.count()!==1)throw new AdlError('E_STALE_STATE');
    if(signal.aborted)throw new AdlError('E_CANCELLED');
    await this.page.mouse.move(point.x,point.y);if(await locator.count()!==1)throw new AdlError('E_STALE_STATE');
    await this.assertIntegrity(signal);
    let sent=false;try{onDispatch();sent=true;await this.page.mouse.click(point.x,point.y);await this.settleRedirect();}
    catch(error){const safe=error instanceof AdlError?error:new AdlError('E_INTERNAL');safe.mayHaveExecuted=sent;throw safe;}
  }

  async prepareAction(action:Action,signal:AbortSignal){
    this.checkAlive();if(signal.aborted)throw new AdlError('E_CANCELLED');
    await this.assertIntegrity(signal);
    const id=action.element_id;if(!id)throw new AdlError('E_TARGET_NOT_FOUND');
    let target=this.store;if(!id.startsWith(this.prefix+'-')){target=null;for(const store of this.frameStores.values())if(await store.evaluate((value,key)=>value.nodes.has(key),id)){target=store;break;}}
    if(!target)throw new AdlError('E_TARGET_NOT_FOUND');
    const handle=await target.evaluateHandle((store:Store,key:string)=>{const node=store.nodes.get(key);return node&&(node as Node).isConnected?node as Element:null;},id);
    try{const element=handle.asElement();if(!element)throw new AdlError('E_TARGET_NOT_FOUND');await element.scrollIntoViewIfNeeded({timeout:this.policy.actionTimeoutMs});if(signal.aborted)throw new AdlError('E_CANCELLED');return await inspectBrowserAction(element,action);}
    catch(error){if(error instanceof AdlError)throw error;throw new AdlError('E_STALE_STATE');}
    finally{await handle.dispose().catch(()=>undefined);}
  }

  async handoff(paused:boolean,signal:AbortSignal,expiresAt?:number){
    this.checkAlive();if(this.policy.browserHeadless!==false)throw new AdlError('E_UNSUPPORTED_ACTION');
    if(signal.aborted)throw new AdlError('E_CANCELLED');
    this.manualNetworkGeneration++;this.manualNetworkExpires=0;
    try{
      if(paused){if(!expiresAt||expiresAt<=Date.now()||expiresAt>Date.now()+120000)throw new AdlError('E_POLICY_DENIED');this.manualNetworkExpires=expiresAt;await this.page.bringToFront();}
      if(signal.aborted)throw new AdlError('E_CANCELLED');
    }catch(error){this.manualNetworkGeneration++;this.manualNetworkExpires=0;throw error;}
  }

  async act(action: Action, signal: AbortSignal,onDispatch?:()=>void,authorization?:ActionAuthorization): Promise<void> {
    this.checkAlive();
    if(signal.aborted)throw new AdlError('E_CANCELLED');
    let dispatched=false;
    const local=new AbortController();
    const combined=AbortSignal.any([signal,local.signal]);
    const mark=()=>{if(combined.aborted)throw new AdlError('E_CANCELLED');if(authorization?.approved&&(!authorization.expires_at||authorization.expires_at<=Date.now()))throw new AdlError('E_POLICY_DENIED');onDispatch?.();dispatched=true;};
    let timer:ReturnType<typeof setTimeout>|undefined;
    let onAbort:()=>void=()=>{};
    const stopped=new Promise<never>((_,reject)=>{
      onAbort=()=>reject(new AdlError('E_CANCELLED'));
      combined.addEventListener('abort',onAbort,{once:true});
      timer=setTimeout(()=>{local.abort();reject(new AdlError('E_TIMEOUT'));},this.policy.actionTimeoutMs);
    });
    try{await Promise.race([(async()=>{await this.runAction(action,combined,mark,authorization);await this.settleRedirect();})(),stopped]);}
    catch(error){const safe=error instanceof AdlError?error:new AdlError(error instanceof Error&&error.message.includes('ADL_UNTRUSTED_DOM')?'E_PRIVACY_BLOCKED':'E_INTERNAL',error instanceof Error&&error.message.includes('ADL_UNTRUSTED_DOM')?'untrusted_dom_api':undefined);safe.mayHaveExecuted=dispatched;if(dispatched)await this.close();throw safe;}
    finally{this.approvedRequest=undefined;if(timer)clearTimeout(timer);combined.removeEventListener('abort',onAbort);}
  }

  private async runAction(action: Action, signal:AbortSignal,onDispatch:()=>void,authorization?:ActionAuthorization): Promise<void> {
    await this.assertIntegrity(signal);
    if(new URL(this.page.url()).origin!==this.origin){await this.close();throw new AdlError('E_POLICY_DENIED');}
    const assertEvidence=async()=>{
      if(!authorization?.actionEvidence)return;
      if(signal.aborted)throw new AdlError('E_CANCELLED');
      const current=(await this.snapshot(signal)).actionEvidence,expected=authorization.actionEvidence;
      if(!current||current.navigation!==expected.navigation||expected.element!==undefined&&(!action.element_id||current.elements[action.element_id]!==expected.element))throw new AdlError('E_STALE_STATE');
    };
    if(action.action==='back'){
      const protocol=await this.context.newCDPSession(this.page);
      try{
        const history=await protocol.send('Page.getNavigationHistory');
        const previous=history.entries[history.currentIndex-1];
        if(!previous)throw new AdlError('E_TARGET_NOT_FOUND');
        if(!this.policy.allowAllOperations&&new URL(previous.url).origin!==this.origin)throw new AdlError('E_POLICY_DENIED','origin_not_allowed');
        await this.owner.callGuard(previous.url);await resolveAllowedAddresses(previous.url,this.policy);
        await assertEvidence();await this.assertIntegrity(signal);onDispatch();await this.page.goBack({waitUntil:'domcontentloaded'});
        await this.settleRedirect();await this.freshStoreAssign();return;
      }finally{await protocol.detach().catch(()=>undefined);}
    }
    if (action.action === 'navigate') {
      let u: URL;
      try {
        u = new URL(String(action.url));
      } catch {
        deny();
      }
      if (!this.policy.allowAllOperations&&u.origin !== this.origin) throw new AdlError('E_POLICY_DENIED','origin_not_allowed');
      try {
        await this.owner.callGuard(u.href);
        await resolveAllowedAddresses(u.href, this.policy);
      } catch (e) {
        if (e instanceof AdlError && e.code === 'E_POLICY_DENIED') throw e;
        deny();
      }
      await assertEvidence();
      await this.assertIntegrity(signal);
      try {
        onDispatch();
        await this.page.goto(u.href, {waitUntil: 'domcontentloaded'});
      } catch {
        this.checkAlive();
        deny();
      }
      await this.settleRedirect();
      await this.freshStoreAssign();
      return;
    }
    if (action.action === 'read_state' || action.action === 'wait_for') throw new AdlError('E_UNSUPPORTED_ACTION');
    const id = action.element_id;
    if (!id || !(id.startsWith(this.prefix + '-')||id.startsWith(this.prefix+'_f'))) throw new AdlError('E_TARGET_NOT_FOUND');
    let targetStore=this.store!;let targetFrame:Frame|undefined;
    if(!id.startsWith(this.prefix+'-')){const found=[...this.frameStores.values()];let match:JSHandle<Store>|undefined;for(const store of found)if(await store.evaluate((value,key)=>value.nodes.has(key),id)){match=store;break;}if(!match)throw new AdlError('E_TARGET_NOT_FOUND');targetStore=match;targetFrame=[...this.frameStores].find(([,store])=>store===match)?.[0];}
    const handle = await targetStore.evaluateHandle((store: Store, id:string) => {
      if(!store.integrity.check())throw new Error('ADL_UNTRUSTED_DOM');
      const n = store.nodes.get(id);
      if (!n || !(n as Node).isConnected) return null;
      return n as Element;
    }, id);
    const el = handle.asElement();
    if (!el) {
      await handle.dispose().catch(() => undefined);
      throw new AdlError('E_TARGET_NOT_FOUND');
    }
    try {
      const permitted=this.policy.allowAllOperations===true||authorization?.normalOperations===true;
      // All modes must protect the iframe host and target through the isolated
      // world; page-world preflight getters are not privacy evidence.
      const assertFramePublic=async()=>{
        if(!targetFrame||authorization?.normalOperations)return;
        // The compatibility permission is limited to configured origins and
        // requires every ancestor frame to pass the network policy guard.
        const crossAllowed=this.policy.allowAllOperations===true||this.policy.operationMode===undefined;
        const allowedFrameOrigins=crossAllowed?this.policy.allowedOrigins:[];
        const priorFrames:{frame:Frame;url:string}[]=[];
        for(let frame:Frame|null=targetFrame;frame?.parentFrame();frame=frame.parentFrame()){
          let effective=frame;while(effective.url().startsWith('about:')&&effective.parentFrame())effective=effective.parentFrame()!;
          const url=effective.url();
          if(new URL(url).origin!==this.origin&&!allowedFrameOrigins.includes(new URL(url).origin))throw new AdlError('E_POLICY_DENIED','iframe_action_proof_unavailable');
          await this.owner.callGuard(url);priorFrames.push({frame,url:frame.url()});
        }
        const publicTarget=await isolatedCollect(el,(node,rules:typeof BROWSER_PRIVACY_RULES)=>{
          let current:Element|null=node,depth=0;
          while(current&&depth++<rules.ancestorCap){if(current.matches(rules.regionSelector))return {allowed:false};current=current.parentElement??(current.getRootNode() as ShadowRoot).host??null;}
          return {allowed:current===null&&node.isConnected};
        },BROWSER_PRIVACY_RULES,allowedFrameOrigins);
        if(priorFrames.some(item=>item.frame.isDetached()||item.frame.url()!==item.url))throw new AdlError('E_STALE_STATE');
        if(!publicTarget.allowed)throw new AdlError('E_PRIVACY_BLOCKED');
      };
      await assertFramePublic();
      if(authorization?.normalOperations){const fresh=await inspectBrowserAction(el,action);if(!authorization.approvalProof||fresh.proof!==authorization.approvalProof)throw new AdlError('E_STALE_STATE');}
      const info = await el.evaluate((node, {secretLabelPattern,privacyRules,integrityKey}:{secretLabelPattern:string;privacyRules:typeof BROWSER_PRIVACY_RULES;integrityKey:string}) => {
        if(!(window as unknown as Record<string,BrowserIntegrity>)[integrityKey]?.check())throw new Error('ADL_UNTRUSTED_DOM');
        const e = node as HTMLElement;
        const tag = e.tagName.toLowerCase();
        const type = tag === 'input' ? ((e as HTMLInputElement).type || 'text').toLowerCase() : '';
        const sensitiveLabel=(text:string)=>text.length>=512||new RegExp(secretLabelPattern,'iu').test(text.normalize('NFKC').replace(/([A-Z])([A-Z][a-z])/g,'$1 $2').replace(/([a-z0-9])([A-Z])/g,'$1 $2').replace(/([A-Za-z])([0-9])/g,'$1 $2').replace(/([0-9])([A-Za-z])/g,'$1 $2'));
        const CONSEQUENTIAL_RE = /(delete|remove|upload|send|submit|purchase|checkout|pay|payment|login|log in|sign in|sign up|register|withdraw|transfer)/i;
        const form = e.closest('form');
        const name = e.getAttribute('aria-label') || e.id || '';
        const nameAttr = e.getAttribute('name') || '';
        const inSensitiveRegion=(element:Element):boolean=>{
          let node:Element|null=element,depth=0;
          while(node&&depth++<privacyRules.ancestorCap){if(node.matches(privacyRules.regionSelector))return true;node=node.parentElement??(node.getRootNode() as ShadowRoot).host??null;}
          return node!==null;
        };
        const textOf=(element:Element):string=>{
          if(inSensitiveRegion(element))return "x".repeat(512);
          let scanned=0, exhausted=false;
          const walker=document.createTreeWalker(element,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT,{acceptNode:node=>{if(++scanned>128){exhausted=true;return NodeFilter.FILTER_ACCEPT;}return node.nodeType===1&&(node as Element).matches(privacyRules.textSkipSelector+","+privacyRules.regionSelector)?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT;}});
          let node=walker.nextNode(),text='',visits=0;
          while(node&&!exhausted&&visits++<128&&text.length<512){if(node.nodeType===3&&!node.parentElement?.closest('script,style'))text+=(node.textContent??'').slice(0,512-text.length);node=walker.nextNode();}
          return node?'x'.repeat(512):text.trim();
        };
        const hints=[name,e.id,nameAttr,e.getAttribute('placeholder')||'',e.getAttribute('title')||'',e.getAttribute('autocomplete')||''];
        const label=(e as HTMLInputElement).labels?.[0];if(label)hints.push(textOf(label));
        const refs=e.getAttribute('aria-labelledby')||'';
        if(refs.length>4096||refs.trim().split(/\s+/).length>16)hints.push('x'.repeat(512));
        else for(const id of refs.trim().split(/\s+/).filter(Boolean).slice(0,16)){const reference=(e.getRootNode() as Document|ShadowRoot).getElementById(id);if(reference)hints.push(textOf(reference));}
        return {
          tag,
          type,
          protected:inSensitiveRegion(e),
          sensitive: (tag === 'input' && type === 'password') || inSensitiveRegion(e) || hints.some(sensitiveLabel),
          consequential: CONSEQUENTIAL_RE.test(name) || CONSEQUENTIAL_RE.test(nameAttr) || (tag === 'button' && (e.getAttribute('type') || 'submit') === 'submit' && !!form) || (tag === 'input' && type === 'submit'),
        };
      },{secretLabelPattern:SECRET_LABEL_PATTERN,privacyRules:BROWSER_PRIVACY_RULES,integrityKey:this.integrityKey});
      const authorized = permitted||action.action==='scroll' ? await el.evaluate((node,key)=>{
        if(!(window as unknown as Record<string,BrowserIntegrity>)[key]?.check())throw new Error('ADL_UNTRUSTED_DOM');
        // Derive an exact selector from the retained element without modifying the page.
        const parts:string[]=[];let current:Element|null=node;
        while(current){const parent:Element|null=current.parentElement;const root=current.getRootNode();const siblings=parent?.children??(root instanceof ShadowRoot?root.children:undefined);const index=siblings?Array.from(siblings).indexOf(current)+1:1;parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);current=parent;}
        return parts.join(' > ');
      },this.integrityKey) : await el.evaluate((node, arg: {rules: {selector: string; actions: string[]}[]; action: string;integrityKey:string}) => {
        if(!(window as unknown as Record<string,BrowserIntegrity>)[arg.integrityKey]?.check())throw new Error('ADL_UNTRUSTED_DOM');
        const e = node as HTMLElement;
        // Rule order must not decide the outcome: a rule authorizes only when
        // its selector resolves to exactly this element and lists the requested
        // action. Ambiguous or unrelated rules are skipped, never fatal, and
        // duplicates never authorize.
        for (const rule of arg.rules) {
          const sel = rule.selector;
          try {
            if (!e.matches(sel) || !rule.actions.includes(arg.action)) continue;
            const walker = document.createTreeWalker(e.getRootNode(), NodeFilter.SHOW_ELEMENT);
            let n: Node | null = walker.nextNode();
            let visits = 0;
            let found = 0;
            while (n && visits++ < 5000) {
              if ((n as Element).matches(sel) && ++found > 1) break;
              n = walker.nextNode();
            }
            // Uniqueness is proven only by exhausting the tree: a visit-cap exit
            // leaves n non-null, so unseen duplicates can never authorize.
            if (found === 1 && !n && (e.getRootNode() as Document|ShadowRoot).querySelector(sel) === e) return sel;
          } catch {
            /* invalid selector: never authorizes */
          }
        }
        return '';
      }, {rules: this.controls, action: action.action,integrityKey:this.integrityKey});
      if (!authorized) throw new AdlError('E_APPROVAL_REQUIRED','operation_not_granted');
      // The page side already required the rule to allow this action; select the
      // matching rule (not merely the first rule with that selector) so duplicate
      // selectors with different action lists resolve per action.
      const rule = this.controls.find((c) => c.selector === authorized && c.actions.includes(action.action));
      if (!permitted&&action.action!=='scroll'&&!rule) throw new AdlError('E_APPROVAL_REQUIRED','operation_not_granted');
      if(info.protected)throw new AdlError('E_PRIVACY_BLOCKED');
      if(info.type==='file')throw new AdlError('E_PRIVACY_BLOCKED');
      if (!permitted&&info.sensitive) throw new AdlError('E_PRIVACY_BLOCKED');
      if (!permitted&&action.action!=='scroll'&&info.consequential) throw new AdlError('E_APPROVAL_REQUIRED','consequential_operation');
      if(['click','fill','press','hover'].includes(action.action)){
        const generation=this.documentGeneration;
        const assertCurrent=()=>{this.checkAlive();if(generation!==this.documentGeneration)throw new AdlError('E_STALE_STATE');if(new URL(this.page.url()).origin!==this.origin)throw new AdlError('E_POLICY_DENIED');};
        await preflightBrowserInput(this.page,el,action,authorized,signal,assertCurrent,permitted,action.action==='hover'?onDispatch:undefined,this.integrityKey);
        assertCurrent();if(signal.aborted)throw new AdlError('E_CANCELLED');
      }
      await assertFramePublic();
      if(authorization?.normalOperations){const fresh=await inspectBrowserAction(el,action);if(fresh.proof!==authorization.approvalProof)throw new AdlError('E_STALE_STATE');if(authorization.approved&&fresh.network)this.approvedRequest={...fresh.network,frame:targetFrame??this.page.mainFrame(),expires:Math.min(Date.now()+5000,authorization.expires_at??0)};}
      if(targetFrame){
        await this.owner.callGuard(targetFrame.url().startsWith('about:')?targetFrame.parentFrame()?.url()??'':targetFrame.url());
        for(let frame:Frame|null=targetFrame;frame?.parentFrame();frame=frame.parentFrame()){
          const host=await frame.frameElement();
          try{if(await host.evaluate((element,rules)=>{let node:Element|null=element as Element,depth=0;while(node&&depth++<rules.ancestorCap){if(node.matches(rules.regionSelector))return true;node=node.parentElement??(node.getRootNode() as ShadowRoot).host??null;}return node!==null;},BROWSER_PRIVACY_RULES))throw new AdlError('E_PRIVACY_BLOCKED');}finally{await host.dispose();}
        }
      }
      const opts = {timeout: Math.max(1000, this.policy.actionTimeoutMs - 500)};
      if(action.action==='hover')return;
      await assertEvidence();
      await this.assertIntegrity(signal);
      if(action.action==='press'){if(!['Enter','Escape','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown','Space'].includes(action.value??''))throw new AdlError('E_INVALID_ARGUMENT');onDispatch();await el.press(action.value!,opts);}
      else if (action.action === 'fill') {
        if (typeof action.value !== 'string') throw new AdlError('E_INVALID_ARGUMENT');
        onDispatch();await el.fill(action.value.slice(0, 4096), opts);
      } else if (action.action === 'click') {
        if(action.point){
          if(!authorization?.pointReference)throw new AdlError('E_STALE_STATE');
          await this.page.mouse.move(action.point.x,action.point.y);
          const hit=await (await this.pointTarget(action.point,authorization.pointReference,signal)).elementHandle({timeout:1000});
          try{if(!hit||!await el.evaluate((e,actual)=>e===actual,hit))throw new AdlError('E_STALE_STATE');}finally{await hit?.dispose();}
          if(authorization.normalOperations&&(await inspectBrowserAction(el,action)).proof!==authorization.approvalProof)throw new AdlError('E_STALE_STATE');
          await this.assertIntegrity(signal);
          onDispatch();await this.page.mouse.click(action.point.x,action.point.y);
        }else{onDispatch();await el.click(opts);}
      } else if (action.action === 'check') {
        onDispatch();await el.setChecked(!!action.checked, opts);
      } else if (action.action === 'select') {
        onDispatch();await el.selectOption(String(action.value ?? ''), opts);
      } else if (action.action === 'scroll') {
        if (action.direction) {
          const scrollTarget=await el.evaluateHandle((node,key)=>{
            if(!(window as unknown as Record<string,BrowserIntegrity>)[key]?.check())throw new Error('ADL_UNTRUSTED_DOM');
            let current:Element|null=node;
            while(current){
              const element=current as HTMLElement, style=getComputedStyle(element);
              if(element.clientHeight>0&&element.scrollHeight>element.clientHeight&&/(auto|scroll|overlay)/.test(style.overflowY))return element;
              current=current.parentElement??(current.getRootNode() as ShadowRoot).host??null;
            }
            const doc=node.ownerDocument, scrolling=doc.scrollingElement;
            return scrolling&&scrolling.scrollHeight>scrolling.clientHeight?scrolling:null;
          },this.integrityKey);
          try{
            const element=scrollTarget.asElement();if(!element)throw new AdlError('E_UNSUPPORTED_ACTION');
            onDispatch();await element.evaluate((node,args)=>{if(!(window as unknown as Record<string,BrowserIntegrity>)[args.key]?.check())throw new Error('ADL_UNTRUSTED_DOM');const element=node as HTMLElement;element.scrollBy({top:(args.direction==='down'?1:-1)*Math.max(1,element.clientHeight*0.8),behavior:'instant'});},{direction:action.direction,key:this.integrityKey});
          }finally{await scrollTarget.dispose();}
        } else {onDispatch();await el.scrollIntoViewIfNeeded(opts);}
      } else {
        throw new AdlError('E_UNSUPPORTED_ACTION');
      }
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  markClosed(): void {
    this.closed = true;
    this.controller.abort();
    this.transportPool.destroy();
    this.resourceCache.clear();
  }

  close(): Promise<void> {
    if(this.closing)return this.closing;
    this.closed = true;
    this.openAbortCleanup?.();
    this.openAbortCleanup = undefined;
    this.controller.abort();
    this.transportPool.destroy();
    this.resourceCache.clear();
    const store = this.store;
    this.store = null;
    this.closing=(async()=>{
      this.manualNetworkGeneration++;this.manualNetworkExpires=0;
      await this.context.close();
      await store?.dispose().catch(()=>{});
      for(const child of this.frameStores.values())await child.dispose().catch(()=>{});this.frameStores.clear();this.captureGeometry.clear();
      this.owner.forget(this);
    })();
    return this.closing;
  }
}

export class BrowserAdapter implements Adapter {
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private closed=false;
  private readonly sessions = new Set<BrowserSession>();

  constructor(private readonly policy: PolicyConfig, private readonly guard: (url: string,purpose?:'navigation'|'resource') => Promise<void>) {}

  async callGuard(url: string,purpose:'navigation'|'resource'='navigation'): Promise<void> {
    try {
      await this.guard(url,purpose);
    } catch (e) {
      if (e instanceof AdlError) throw e;
      deny();
    }
  }

  forget(session: BrowserSession): void {
    this.sessions.delete(session);
  }

  private async ensureBrowser(): Promise<Browser> {
    if(this.closed)throw new AdlError('E_CANCELLED');
    if (this.browser) return this.browser;
    if (!this.launching) {
      this.launching = chromium.launch({headless: this.policy.browserHeadless!==false, chromiumSandbox: true,
        ...(process.env.ADL_BROWSER_EXECUTABLE ? {executablePath:process.env.ADL_BROWSER_EXECUTABLE} : {}),
      }).then(async (b) => {
        if(this.closed){await b.close();throw new AdlError('E_CANCELLED');}
        b.on('disconnected', () => {
          this.browser = null;
          this.launching = null;
          for (const s of Array.from(this.sessions)) s.markClosed();
          this.sessions.clear();
        });
        this.browser = b;
        return b;
      }).catch((e: unknown) => {
        this.launching = null;
        throw e instanceof AdlError?e:new AdlError('E_BACKEND_UNAVAILABLE');
      });
    }
    return this.launching;
  }

  async open(target: Target, mode: Mode, signal: AbortSignal): Promise<AdapterSession> {
    if(this.closed)throw new AdlError('E_CANCELLED');
    if (mode !== 'strict_isolated') throw new AdlError('E_INTERFERENCE_RISK');
    if (signal.aborted) throw new AdlError('E_CANCELLED');
    const config = this.policy.browserTargets.find((t) => t.id === target.application_id);
    if (!config) throw new AdlError('E_TARGET_NOT_FOUND');
    if (config.classification !== 'PUBLIC' && config.classification !== 'INTERNAL') deny();
    if (target.policy_class !== 'PUBLIC' && target.policy_class !== 'INTERNAL') deny();
    let origin: string;
    try {
      origin = new URL(config.url).origin;
    } catch {
      deny();
    }
    if ((!this.policy.allowAllOperations||this.policy.restrictTargets)&&!this.policy.allowedOrigins.includes(origin)) deny();
    if (this.sessions.size >= this.policy.maxSessions) throw new AdlError('E_RESOURCE_LIMIT');
    // Vet the configured origin (guard + DNS + IP ranges) before launch.
    await this.callGuard(origin + '/');
    await resolveAllowedAddresses(config.url, this.policy);
    let context: BrowserContext;
    let page: Page;
    let session: BrowserSession | null = null;
    try {
      await ensureBrowserPrivacySelectors();
      // Register before the first page can initialize Playwright's injected
      // selector engine (e.g. during fill). Late registration misses that cache.
      await ensurePointSelector();
      const browser = await this.ensureBrowser();
      if(signal.aborted||this.closed)throw new AdlError('E_CANCELLED');
      context = await browser.newContext({serviceWorkers: 'block',acceptDownloads:this.policy.allowAllOperations===true,hasTouch:config.gestures?.enabled===true});
      const installation=await installBrowserIntegrity(context);
      session = new BrowserSession(this, this.policy, context, origin, config.controls ?? [],config.visual,config.gestures,installation.key,installation.registrationSecret);
      this.sessions.add(session);
      const active = session;
      const onAbort=()=>void active.close();
      signal.addEventListener('abort',onAbort,{once:true});
      active.openAbortCleanup=()=>signal.removeEventListener('abort',onAbort);
      // Hard network boundary, installed before the first page exists.
      if(!this.policy.allowAllOperations||this.policy.restrictTargets||this.policy.browserProxyServer){
      await context.route('**/*', async (route: Route) => {
        const block=async(code:string,origin?:string)=>{
          active.recordNetworkBlock(code,origin);
          await route.abort().catch(()=>undefined);
        };
        try {
          const req = route.request();
          if(active.controller.signal.aborted||req.frame().page()!==page)return route.abort();
          const rawUrl = req.url();
          let u: URL;
          try {
            u = new URL(rawUrl);
          } catch {
            return block('request_denied');
          }
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return block('request_denied');
          const method = req.method().toUpperCase();
          const resource=!req.isNavigationRequest()&&req.resourceType()!=='document';
          if (!this.policy.allowAllOperations && u.origin !== active.origin){
            const permitted=resource&&['GET','HEAD'].includes(method)&&[...this.policy.allowedOrigins,...(this.policy.resourceOrigins??[])].includes(u.origin);
            if(!permitted)return block('origin_denied',u.origin);
          }
          const body=req.postDataBuffer()??undefined;
          let manualGeneration:number|undefined,approvedExpires:number|undefined;
          if (!this.policy.allowAllOperations && method !== 'GET' && method !== 'HEAD') {
            const permit=active.approvedRequest;
            manualGeneration=active.manualRequestGeneration(req);
            if(manualGeneration===undefined){
              if(!permit||permit.expires<Date.now()||permit.frame!==req.frame()||!req.isNavigationRequest()||req.resourceType()!=='document'||permit.method!==method||permit.url!==rawUrl||!body||!body.equals(Buffer.from(permit.body))||(req.headers()['content-type']??'').split(';')[0]?.trim().toLowerCase()!=='application/x-www-form-urlencoded')return block('request_denied');
              approvedExpires=permit.expires;
              active.approvedRequest=undefined;
            }
          }
          if(!['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(method))return block('request_denied');
          if(body&&body.length>MAX_BODY)return block('request_denied');
          const headers = await req.allHeaders().catch(() => ({} as Record<string, string>));
          // Playwright does not route requests followed internally from a
          // fulfilled redirect. Follow read-only redirects here so each hop is
          // vetted and DNS-pinned, instead of letting Chromium bypass the route.
          let current=u;
          let res:Awaited<ReturnType<typeof pinnedFetch>>;
          for(let hops=0;;hops++){
            await this.callGuard(current.href,resource?'resource':'navigation');
            const ips=await resolveAllowedAddresses(current.href,this.policy,undefined,resource?'resource':'navigation');
            // A grant checked before headers, guard or DNS may be revoked while
            // those awaits run. Recheck the exact generation at network dispatch.
            if(active.controller.signal.aborted||manualGeneration!==undefined&&!active.manualRequestCurrent(req,manualGeneration)||approvedExpires!==undefined&&approvedExpires<=Date.now())return block('request_denied');
            const cacheKey=active.resourceCache.key(current,ips[0]!,method,req.resourceType(),headers);
            const cached=active.resourceCache.get(cacheKey);
            res=cached??await pinnedFetch(current,ips[0]!,method,headers,active.controller.signal,body,this.policy.browserProxyServer,{resourceType:req.resourceType(),pool:active.transportPool});
            if(!cached)active.resourceCache.put(cacheKey,res);
            if(res.status<300||res.status>=400||!res.headers.location)break;
            if(hops>=9||!['GET','HEAD'].includes(method))return block('response_blocked');
            let next:URL;
            try{next=new URL(res.headers.location,current);}catch{return block('response_blocked');}
            if(next.origin!==current.origin||next.username||next.password)return block('redirect_origin_not_allowed',next.origin);
            if(req.resourceType()==='stylesheet'&&method==='GET'){
              if(++active.stylesheetRedirects>64)return block('response_blocked');
              return route.fulfill({status:200,contentType:'text/css',headers:{'cache-control':'no-store'},body:redirectStylesheet(next)});
            }
            if(req.isNavigationRequest()&&req.frame()===page.mainFrame()){
              if(++active.documentRedirects>10)return block('response_blocked');
              active.pendingDocumentRedirect=next.href;
              const escaped=next.href.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
              return route.fulfill({status:200,contentType:'text/html',body:`<!doctype html><meta http-equiv="refresh" content="0;url=${escaped}">`});
            }
            current=next;
          }
          if(req.isNavigationRequest()&&req.frame()===page.mainFrame()){active.pendingDocumentRedirect=undefined;active.documentRedirects=0;}
          const outHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (HOP_RE.test(k) || v === undefined) continue;
            outHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
          }
          const setCookie = res.headers['set-cookie'];
          if (Array.isArray(setCookie)) outHeaders['set-cookie'] = setCookie.join('\n');
          return route.fulfill({status: res.status || 599, headers: outHeaders, body: res.body});
        } catch (error) {
          await block(error instanceof AdlError?(error.reason??(error.code==='E_RESOURCE_LIMIT'?'response_blocked':'network_error')):'network_error');
        }
      });
      await context.routeWebSocket('**/*', (ws) => {
        active.recordNetworkBlock('request_denied');
        ws.close({code: 1008, reason: 'policy'});
      });
      }
      page = await context.newPage();
      context.on('page', (p) => {
        if (p !== page) void p.close().catch(() => undefined);
      });
      page.on('popup', (p) => void p.close().catch(() => undefined));
      page.on('download', (d) => void d.cancel().catch(() => undefined));
      page.on('dialog', (d) => void d.dismiss().catch(() => undefined));
      await session.attach(page);
      await page.goto(config.url, {waitUntil: 'domcontentloaded'});
      await session.sessionReady();
      if (signal.aborted) throw new AdlError('E_CANCELLED');
      return active;
    } catch (e) {
      if (session) await session.close().catch(() => undefined);
      if (e instanceof AdlError) throw e;
      throw new AdlError('E_POLICY_DENIED');
    }
  }

  async close(): Promise<void> {
    this.closed=true;
    for (const s of Array.from(this.sessions)) {
      await s.close().catch(() => undefined);
    }
    this.sessions.clear();
    const b = this.browser??await this.launching?.catch(()=>null);
    this.browser = null;
    this.launching = null;
    if (b) await b.close().catch(() => undefined);
  }
}
