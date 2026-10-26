import * as http from 'node:http';
import * as https from 'node:https';
import * as crypto from 'node:crypto';
import {chromium, type Browser, type BrowserContext, type JSHandle, type Page, type Route} from 'playwright';
import {resolveAllowedAddresses} from './policy.js';
import {captureBrowserImage} from './browser-visual.js';
import {runBrowserGesture} from './browser-gesture.js';
import {preflightBrowserInput} from './browser-preflight.js';
import {SECRET_LABEL_PATTERN, BROWSER_PRIVACY_RULES} from './privacy.js';
import {ensureBrowserPrivacySelectors} from './browser-privacy.js';
import type {GesturePolicy,GesturePlan,GestureReference,GestureExecution} from './gesture-types.js';
import type {CapturedImage,VisualPolicy} from './visual-types.js';
import {AdlError, type Action, type Adapter, type AdapterSession, type Element as ElementInfo, type Mode, type PolicyConfig, type RawSnapshot, type Target} from './types.js';

const MAX_BODY = 2 * 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 5000;
const HOP_RE = /^(connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade|content-length|content-encoding|host|set-cookie)$/i;

function deny(): never {
  throw new AdlError('E_POLICY_DENIED');
}

interface FetchResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

// Fetch with the vetted IP pinned via a custom lookup callback (never
// route.fetch: DNS rebinding). Original Host header and TLS SNI/cert
// validation preserved; redirects are never followed. The 5s response
// deadline starts before the connection is made.
function pinnedFetch(url: URL, ip: string, method: string, headers: Record<string, string>, signal: AbortSignal, body?:Buffer,allowRedirects=false): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const outHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (!HOP_RE.test(k)) outHeaders[k] = v;
    }
    outHeaders['host'] = url.host;
    outHeaders['accept-encoding'] = 'identity';
    const options: https.RequestOptions = {
      hostname: url.hostname.replace(/^\[|\]$/g,''),
      port: url.port !== '' ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80),
      path: (url.pathname || '/') + (url.search || ''),
      method,
      headers: outHeaders,
      agent: false,
      lookup: (_h, options, cb) => {
        const family=ip.includes(':')?6:4;
        if(typeof options==='object'&&options.all) (cb as unknown as (err:null,addresses:{address:string;family:number}[])=>void)(null,[{address:ip,family}]);
        else (cb as unknown as (err:null,address:string,family:number)=>void)(null,ip,family);
      },
      servername: url.hostname.replace(/^\[|\]$/g,''),
      rejectUnauthorized: true,
      signal,
    };
    let settled = false;
    const fail = (e: Error) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    };
    const done = (r: FetchResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    const timer = setTimeout(() => {
      req.destroy();
      fail(new AdlError('E_TIMEOUT'));
    }, RESPONSE_TIMEOUT_MS);
    const req = lib.request(options, (res) => {
      const status = res.statusCode ?? 0;
      if (!allowRedirects && status >= 300 && status < 400) {
        res.destroy();
        clearTimeout(timer);
        return fail(new AdlError('E_POLICY_DENIED'));
      }
      if (res.headers['content-encoding']) {
        res.destroy();
        clearTimeout(timer);
        return fail(new AdlError('E_POLICY_DENIED'));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          req.destroy();
          clearTimeout(timer);
          return fail(new AdlError('E_RESOURCE_LIMIT'));
        }
        chunks.push(c);
      });
      res.on('end', () => {
        clearTimeout(timer);
        done({status, headers: res.headers, body: Buffer.concat(chunks)});
      });
      res.on('error', () => {
        clearTimeout(timer);
        fail(new AdlError('E_POLICY_DENIED'));
      });
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      fail(e instanceof AdlError ? e : new AdlError('E_POLICY_DENIED'));
    });
    req.end(body);
  });
}

type Store = {ids: WeakMap<object, string>; nodes: Map<string, object>; seq: number; prefix: string; seen: Set<string>};

// Runs inside the page against the private store kept in the JSHandle
// closure (WeakMap/Map not on window, unreachable from page scripts).
// Bounded TreeWalker traversal: visit cap, depth cap, output cap; only
// bounded text nodes are read (never textContent on huge subtrees).
function snapshotPageFn(store: Store, cfg: {maxOut: number; visitCap: number; maxDepth: number; fieldMax: number; secretLabelPattern:string; privacyRules:typeof BROWSER_PRIVACY_RULES}): {elements: ElementInfo[]; sig: string; truncated: boolean} {
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
      node=node.parentElement;
    }
    return node!==null; // Incomplete ancestry cannot establish a public region.
  };
  const descendantText=(el:Element,includeHidden=false):string=>{
    if(inSensitiveRegion(el))return "x".repeat(cfg.fieldMax);
    let scanned=0, exhausted=false;
    const walker=document.createTreeWalker(el,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT,{acceptNode:node=>{if(++scanned>128){exhausted=true;return NodeFilter.FILTER_ACCEPT;}return node.nodeType===1&&(node as Element).matches(cfg.privacyRules.textSkipSelector+","+cfg.privacyRules.regionSelector)?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT;}});
    let node:Node|null=walker.nextNode(),text='',visits=0;
    while(node&&!exhausted&&visits++<128&&text.length<cfg.fieldMax){
      if(node.nodeType===3&&!node.parentElement?.closest('script,style')&&(includeHidden||!node.parentElement?.closest('[hidden],[aria-hidden="true"]')))text+=node.textContent?.slice(0,cfg.fieldMax-text.length)??'';
      node=walker.nextNode();
    }
    // An incomplete naming hint cannot establish that a field is public.
    return node?'x'.repeat(cfg.fieldMax):text.trim();
  };
  const referencedName=(el:Element):string=>{
    const refs=el.getAttribute('aria-labelledby');if(!refs)return '';
    if(refs.length>4096)throw new Error('Snapshot field limit');
    const ids=refs.trim().split(/\s+/);if(ids.length>16)return 'x'.repeat(cfg.fieldMax);
    return ids.map(id=>{const label=document.getElementById(id);return label?descendantText(label,true):'';}).join(' ').slice(0,cfg.fieldMax).trim();
  };
  const CONSEQUENTIAL_RE = /(delete|remove|upload|send|submit|purchase|checkout|pay|payment|login|log in|sign in|sign up|register|withdraw|transfer)/i;
  const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea']);
  const elements: ElementInfo[] = [];
  const sigParts: string[] = [];
  let visited = 0;
  let truncated = false;
  const root = document.body || document.documentElement;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let cur = walker.currentNode as HTMLElement;
  let depth = 0;
  const depthOf = (el: HTMLElement): number => {
    let d = 0;
    let p: HTMLElement | null = el;
    while (p && p !== root) {
      p = p.parentElement;
      d++;
    }
    return d;
  };
  while (cur) {
    if (visited++ >= cfg.visitCap) {
      truncated = true;
      break;
    }
    depth = depthOf(cur);
    const skipChildren = depth >= cfg.maxDepth;
    if(skipChildren&&cur.firstElementChild)truncated=true;
    const tag = cur.tagName.toLowerCase();
    const type = tag === 'input' ? ((cur as HTMLInputElement).type || 'text').toLowerCase() : '';
    const roleAttr = cur.getAttribute('role');
    if((roleAttr?.length??0)>100||cur.id.length>512)throw new Error('Snapshot field limit');
    const isInteractive = INTERACTIVE.has(tag) && (tag !== 'a' || cur.hasAttribute('href')) && type !== 'hidden';
    const isStatus = roleAttr === 'status' || roleAttr === 'alert' || cur.hasAttribute('aria-live');
    const isText=/^(p|span|legend|h[1-6]|td|li)$/.test(tag)&&!!directText(cur);
    const interesting = (isInteractive || isStatus || roleAttr || isText) && visible(cur);
    if (interesting) {
      if (elements.length >= cfg.maxOut) {
        truncated = true;
        break;
      }
      let role = roleAttr || '';
      if (!role) {
        if (tag === 'button') role = 'button';
        else if (tag === 'a') role = 'link';
        else if (tag === 'select') role = 'combobox';
        else if (tag === 'textarea') role = 'textbox';
        else if (tag === 'input') role = type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'submit' ? 'button' : type === 'file' ? 'file' : 'textbox';
        else role = /^h[1-6]$/.test(tag)?'heading':isText?'text':'generic';
      }
      const form = cur.closest('form');
      const labelEl = (tag === 'input' || tag === 'textarea' || tag === 'select') ? (cur as HTMLInputElement).labels?.[0] : undefined;
      const ownText = directText(cur);
      const labelText=labelEl?descendantText(labelEl):'';
      const referenceText=referencedName(cur);
      const rawName=referenceText || cur.getAttribute('aria-label') || labelText || (role === 'button' || role === 'link' || role === 'status' || role === 'alert' ||isText ? descendantText(cur) : '') || cur.getAttribute('placeholder') || cur.getAttribute('title') || cur.id || '';
      if(rawName.length>4096)throw new Error('Snapshot field limit');
      const name = clip(rawName);
      const isPassword = tag === 'input' && type === 'password';
      const rawNameAttr = cur.getAttribute('name') || '';
      if(rawNameAttr.length>512)throw new Error('Snapshot field limit');
      const hints=[rawName,labelText,...(labelEl?[descendantText(labelEl,true)]:[]),referenceText,cur.getAttribute('aria-label')||'',cur.getAttribute('placeholder')||'',cur.getAttribute('title')||'',cur.getAttribute('autocomplete')||'',cur.id,rawNameAttr];
      if(hints.some(hint=>hint.length>4096))throw new Error('Snapshot field limit');
      let sensitive = isPassword || inSensitiveRegion(cur) || hints.some(hint=>hint.length>=cfg.fieldMax||sensitiveLabel(hint));
      let rawVal = '';
      if (tag === 'input' || tag === 'textarea') rawVal = (cur as HTMLInputElement).value ?? '';
      else if (tag === 'select') {
        const sel = cur as HTMLSelectElement;
        rawVal = sel.options[sel.selectedIndex]?.value ?? '';
        if(sel.selectedIndex>=0&&(inSensitiveRegion(sel.options[sel.selectedIndex]!)||sensitiveLabel(sel.options[sel.selectedIndex]?.label??'')))sensitive=true;
      }
      if(rawVal.length>4096)throw new Error('Snapshot field limit');
      const value = isPassword ? undefined : clip(rawVal);
      const enabled = !(cur as HTMLButtonElement).disabled && !cur.closest('fieldset:disabled') && cur.getAttribute('aria-disabled')!=='true';
      const checked = tag === 'input' && (type === 'checkbox' || type === 'radio') ? (cur as HTMLInputElement).checked : undefined;
      const selected = tag === 'select' ? (cur as HTMLSelectElement).selectedIndex >= 0 : undefined;
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
      sigParts.push(JSON.stringify([id, role, rawName, enabled, checked, selected, type, consequential, href, actionAttr, rawVal,ownText,sensitive,options,optionsTruncated,depth]));
      elements.push({id, role, name, depth, ...(options?{options,...(optionsTruncated?{options_truncated:true}:{})}:{}), ...(value !== undefined ? {value} : {}), enabled, ...(checked !== undefined ? {checked} : {}), ...(selected !== undefined ? {selected} : {}), ...(sensitive ? {sensitive: true} : {})});
    }
    // Only a depth skip continues (with later siblings); the visit and output
    // caps above set the flag and break out of the traversal immediately.
    let next: HTMLElement | null = skipChildren ? null : cur.firstElementChild as HTMLElement | null;
    if (!next) {
      if (depth === 0) break;
      next = cur.nextElementSibling as HTMLElement | null;
      while (!next && cur.parentElement && cur.parentElement !== root) {
        cur = cur.parentElement;
        next = cur.nextElementSibling as HTMLElement | null;
      }
      if (!next) break;
    }
    cur = next;
  }
  return {elements, sig: JSON.stringify(sigParts), truncated};
}

const STORE_INIT = () => ({ids: new WeakMap<object, string>(), nodes: new Map<string, object>(), seq: 0, prefix: '', seen: new Set<string>()});

class BrowserSession implements AdapterSession {
  private closed = false;
  private closing:Promise<void>|undefined;
  private store: JSHandle<Store> | null = null;
  private pageValue: Page | null = null;
  private documentGeneration=0;
  private storeGeneration=0;
  private readonly visualEpoch=crypto.randomUUID();
  openAbortCleanup: (() => void) | undefined;
  prefix = crypto.randomBytes(16).toString('hex');
  readonly controller = new AbortController();

  constructor(
    private readonly owner: BrowserAdapter,
    private readonly policy: PolicyConfig,
    readonly context: BrowserContext,
    private readonly initialOrigin: string,
    private readonly controls: {selector: string; actions: string[]}[],
    private readonly visual?:VisualPolicy,
    private readonly gestures?:GesturePolicy,
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
    await this.freshStoreAssign();
  }

  private async freshStore(): Promise<JSHandle<Store>> {
    if (!this.pageValue) throw new AdlError('E_TARGET_NOT_FOUND');
    this.prefix=crypto.randomBytes(16).toString('hex');
    const handle = await this.pageValue.evaluateHandle(STORE_INIT);
    await handle.evaluate((s: Store, prefix: string) => {
      s.prefix = prefix;
    }, this.prefix);
    return handle as JSHandle<Store>;
  }

  private checkAlive(): void {
    if (this.closed) throw new AdlError('E_TARGET_NOT_FOUND');
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

  async snapshot(): Promise<RawSnapshot> {
    this.checkAlive();
    if(new URL(this.page.url()).origin!==this.origin){await this.close();throw new AdlError('E_POLICY_DENIED');}
    const maxOut = this.policy.maxElements > 0 ? this.policy.maxElements : 5000;
    const cfg = {maxOut, visitCap: Math.min(maxOut * 8, 5000), maxDepth: 12, fieldMax: 512,secretLabelPattern:SECRET_LABEL_PATTERN,privacyRules:BROWSER_PRIVACY_RULES};
    let res: {elements: ElementInfo[]; sig: string; truncated: boolean};
    try {
      res = await this.store!.evaluate(snapshotPageFn, cfg);
    } catch (e) {
      if (e instanceof AdlError) throw e;
      if(e instanceof Error&&e.message.includes('Snapshot field limit'))throw new AdlError('E_RESOURCE_LIMIT');
      this.checkAlive();
      // Bounded lazy recovery: a same-origin document replacement (link click)
      // destroys the store handle's context; rebuild once, only when confirmed.
      if (!(await this.storeContextGone())) {this.checkAlive();throw new AdlError('E_INTERNAL');}
      if(new URL(this.page.url()).origin!==this.origin){await this.close();throw new AdlError('E_POLICY_DENIED');}
      await this.freshStoreAssign();
      this.checkAlive();
      try {
        res = await this.store!.evaluate(snapshotPageFn, cfg);
      } catch (e2) {
        if (e2 instanceof AdlError) throw e2;
        if(e2 instanceof Error&&e2.message.includes('Snapshot field limit'))throw new AdlError('E_RESOURCE_LIMIT');
        this.checkAlive();
        throw new AdlError('E_INTERNAL');
      }
    }
    this.checkAlive();
    if(new URL(this.page.url()).origin!==this.origin){await this.close();throw new AdlError('E_POLICY_DENIED');}
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
    const fingerprint = crypto.createHash('sha256').update(res.sig).digest('hex');
    return {elements: res.elements, fingerprint, truncated: res.truncated};
  }

  async capture(signal:AbortSignal):Promise<CapturedImage>{
    this.checkAlive();
    if(signal.aborted){await this.close();throw new AdlError('E_CANCELLED');}
    const onAbort=()=>{void this.close();};
    signal.addEventListener('abort',onAbort,{once:true});
    let timer:NodeJS.Timeout|undefined;
    const generation=this.documentGeneration;
    try{
      const image=await Promise.race([
        captureBrowserImage(this.page,this.origin,this.visual,signal),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>{void this.close();reject(new AdlError('E_TIMEOUT'));},this.policy.actionTimeoutMs);}),
      ]);
      if(generation!==this.documentGeneration)throw new AdlError('E_STALE_STATE');
      return {...image,surface_epoch:`${this.visualEpoch}:${generation}`};
    }catch(error){if(error instanceof AdlError&&['E_TIMEOUT','E_CANCELLED'].includes(error.code))await this.close();throw error;}
    finally{if(timer)clearTimeout(timer);signal.removeEventListener('abort',onAbort);}
  }

  async gesture(plan:GesturePlan,reference:GestureReference,signal:AbortSignal):Promise<GestureExecution>{
    this.checkAlive();
    const epoch=`${this.visualEpoch}:${this.documentGeneration}`;
    const assertCurrent=()=>{this.checkAlive();if(reference.surface_epoch!==epoch||epoch!==`${this.visualEpoch}:${this.documentGeneration}`)throw new AdlError('E_STALE_STATE');if(new URL(this.page.url()).origin!==this.origin)throw new AdlError('E_POLICY_DENIED');};
    assertCurrent();
    try{return await runBrowserGesture(this.page,plan,this.gestures??{enabled:false,surfaces:[]},reference,signal,assertCurrent,this.policy.allowAllOperations);}
    catch(error){if(signal.aborted||(error instanceof AdlError&&error.mayHaveExecuted))await this.close();throw error;}
  }

  async act(action: Action, signal: AbortSignal): Promise<void> {
    this.checkAlive();
    if (signal.aborted) {
      await this.close();
      throw new AdlError('E_CANCELLED');
    }
    let onAbort: (() => void) | undefined;
    const timeout = this.policy.actionTimeoutMs > 0 ? this.policy.actionTimeoutMs : 30000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.runAction(action,signal),
        new Promise<never>((_, reject) => {
          onAbort = () => {
            void this.close();
            reject(new AdlError('E_CANCELLED'));
          };
          signal.addEventListener('abort', onAbort, {once: true});
          timer = setTimeout(() => {
            void this.close();
            reject(new AdlError('E_TIMEOUT'));
          }, timeout);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private async runAction(action: Action, signal:AbortSignal): Promise<void> {
    if(new URL(this.page.url()).origin!==this.origin){await this.close();throw new AdlError('E_POLICY_DENIED');}
    if (action.action === 'navigate') {
      let u: URL;
      try {
        u = new URL(String(action.url));
      } catch {
        deny();
      }
      if (!this.policy.allowAllOperations&&u.origin !== this.origin) deny();
      try {
        await this.owner.callGuard(u.href);
        await resolveAllowedAddresses(u.href, this.policy);
      } catch (e) {
        if (e instanceof AdlError && e.code === 'E_POLICY_DENIED') throw e;
        deny();
      }
      try {
        await this.page.goto(u.href, {waitUntil: 'domcontentloaded'});
      } catch {
        this.checkAlive();
        deny();
      }
      await this.freshStoreAssign();
      return;
    }
    if (action.action === 'read_state' || action.action === 'wait_for') throw new AdlError('E_UNSUPPORTED_ACTION');
    const id = action.element_id;
    if (!id || !id.startsWith(this.prefix + '-')) throw new AdlError('E_TARGET_NOT_FOUND');
    const handle = await this.page.evaluateHandle((arg: {store: Store; id: string}) => {
      const n = arg.store.nodes.get(arg.id);
      if (!n || !(n as Node).isConnected) return null;
      return n as Element;
    }, {store: this.store!, id});
    const el = handle.asElement();
    if (!el) {
      await handle.dispose().catch(() => undefined);
      throw new AdlError('E_TARGET_NOT_FOUND');
    }
    try {
      const info = await el.evaluate((node, {secretLabelPattern,privacyRules}:{secretLabelPattern:string;privacyRules:typeof BROWSER_PRIVACY_RULES}) => {
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
          while(node&&depth++<privacyRules.ancestorCap){if(node.matches(privacyRules.regionSelector))return true;node=node.parentElement;}
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
        else for(const id of refs.trim().split(/\s+/).filter(Boolean).slice(0,16)){const reference=document.getElementById(id);if(reference)hints.push(textOf(reference));}
        return {
          tag,
          type,
          sensitive: (tag === 'input' && type === 'password') || inSensitiveRegion(e) || hints.some(sensitiveLabel),
          consequential: CONSEQUENTIAL_RE.test(name) || CONSEQUENTIAL_RE.test(nameAttr) || (tag === 'button' && (e.getAttribute('type') || 'submit') === 'submit' && !!form) || (tag === 'input' && type === 'submit'),
        };
      },{secretLabelPattern:SECRET_LABEL_PATTERN,privacyRules:BROWSER_PRIVACY_RULES});
      const authorized = this.policy.allowAllOperations ? await el.evaluate(node=>{
        // Derive an exact selector from the retained element without modifying the page.
        const parts:string[]=[];let current:Element|null=node;
        while(current){const parent:Element|null=current.parentElement;const index=parent?Array.from(parent.children).indexOf(current)+1:1;parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);current=parent;}
        return parts.join(' > ');
      }) : await el.evaluate((node, arg: {rules: {selector: string; actions: string[]}[]; action: string}) => {
        const e = node as HTMLElement;
        // Rule order must not decide the outcome: a rule authorizes only when
        // its selector resolves to exactly this element and lists the requested
        // action. Ambiguous or unrelated rules are skipped, never fatal, and
        // duplicates never authorize.
        for (const rule of arg.rules) {
          const sel = rule.selector;
          try {
            if (!e.matches(sel) || !rule.actions.includes(arg.action)) continue;
            const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
            let n: Node | null = walker.currentNode;
            let visits = 0;
            let found = 0;
            while (n && visits++ < 5000) {
              if ((n as Element).matches(sel) && ++found > 1) break;
              n = walker.nextNode();
            }
            // Uniqueness is proven only by exhausting the tree: a visit-cap exit
            // leaves n non-null, so unseen duplicates can never authorize.
            if (found === 1 && !n && document.querySelector(sel) === e) return sel;
          } catch {
            /* invalid selector: never authorizes */
          }
        }
        return '';
      }, {rules: this.controls, action: action.action});
      if (!authorized) throw new AdlError('E_APPROVAL_REQUIRED');
      // The page side already required the rule to allow this action; select the
      // matching rule (not merely the first rule with that selector) so duplicate
      // selectors with different action lists resolve per action.
      const rule = this.controls.find((c) => c.selector === authorized && c.actions.includes(action.action));
      if (!this.policy.allowAllOperations&&!rule) throw new AdlError('E_APPROVAL_REQUIRED');
      if (!this.policy.allowAllOperations&&(info.sensitive || info.type === 'file')) throw new AdlError('E_PRIVACY_BLOCKED');
      if (!this.policy.allowAllOperations&&info.consequential) throw new AdlError('E_APPROVAL_REQUIRED');
      if(action.action==='click'||action.action==='fill'){
        const generation=this.documentGeneration;
        const assertCurrent=()=>{this.checkAlive();if(generation!==this.documentGeneration)throw new AdlError('E_STALE_STATE');if(new URL(this.page.url()).origin!==this.origin)throw new AdlError('E_POLICY_DENIED');};
        await preflightBrowserInput(this.page,el,action,authorized,signal,assertCurrent,this.policy.allowAllOperations);
        assertCurrent();if(signal.aborted)throw new AdlError('E_CANCELLED');
      }
      const opts = {timeout: Math.max(1000, this.policy.actionTimeoutMs - 500)};
      if (action.action === 'fill') {
        if (typeof action.value !== 'string') throw new AdlError('E_INVALID_ARGUMENT');
        await el.fill(action.value.slice(0, 4096), opts);
      } else if (action.action === 'click') {
        await el.click(opts);
      } else if (action.action === 'check') {
        await el.setChecked(!!action.checked, opts);
      } else if (action.action === 'select') {
        await el.selectOption(String(action.value ?? ''), opts);
      } else if (action.action === 'scroll') {
        if (action.direction) {
          const supported = await el.evaluate((node, direction) => {
            const element = node as HTMLElement;
            if (element.scrollHeight <= element.clientHeight || element.clientHeight <= 0) return false;
            element.scrollBy({top: (direction === 'down' ? 1 : -1) * Math.max(1, element.clientHeight * 0.8), behavior:'instant'});
            return true;
          }, action.direction);
          if (!supported) throw new AdlError('E_UNSUPPORTED_ACTION');
        } else await el.scrollIntoViewIfNeeded(opts);
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
  }

  close(): Promise<void> {
    if(this.closing)return this.closing;
    this.closed = true;
    this.openAbortCleanup?.();
    this.openAbortCleanup = undefined;
    this.controller.abort();
    const store = this.store;
    this.store = null;
    this.closing=(async()=>{
      await this.context.close();
      await store?.dispose().catch(()=>{});
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

  constructor(private readonly policy: PolicyConfig, private readonly guard: (url: string) => Promise<void>) {}

  async callGuard(url: string): Promise<void> {
    try {
      await this.guard(url);
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
      this.launching = chromium.launch({headless: true, chromiumSandbox: true,
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
      const browser = await this.ensureBrowser();
      if(signal.aborted||this.closed)throw new AdlError('E_CANCELLED');
      context = await browser.newContext({serviceWorkers: 'block',acceptDownloads:this.policy.allowAllOperations===true,hasTouch:config.gestures?.enabled===true});
      session = new BrowserSession(this, this.policy, context, origin, config.controls ?? [],config.visual,config.gestures);
      this.sessions.add(session);
      const active = session;
      const onAbort=()=>void active.close();
      signal.addEventListener('abort',onAbort,{once:true});
      active.openAbortCleanup=()=>signal.removeEventListener('abort',onAbort);
      // Hard network boundary, installed before the first page exists.
      if(!this.policy.allowAllOperations||this.policy.restrictTargets){
      await context.route('**/*', async (route: Route) => {
        try {
          const req = route.request();
          if(active.controller.signal.aborted||req.frame().page()!==page)return route.abort();
          const rawUrl = req.url();
          let u: URL;
          try {
            u = new URL(rawUrl);
          } catch {
            return route.abort();
          }
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return route.abort();
          if (!this.policy.allowAllOperations && u.origin !== active.origin) return route.abort();
          const method = req.method().toUpperCase();
          if (!this.policy.allowAllOperations && method !== 'GET' && method !== 'HEAD') return route.abort();
          if(!['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(method))return route.abort();
          const body=req.postDataBuffer()??undefined;
          if(body&&body.length>MAX_BODY)return route.abort();
          await this.callGuard(rawUrl);
          const ips = await resolveAllowedAddresses(rawUrl, this.policy);
          const headers = await req.allHeaders().catch(() => ({} as Record<string, string>));
          const res = await pinnedFetch(u, ips[0]!, method, headers, active.controller.signal,body,this.policy.allowAllOperations===true);
          const outHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (HOP_RE.test(k) || v === undefined) continue;
            outHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
          }
          const setCookie = res.headers['set-cookie'];
          if (Array.isArray(setCookie)) outHeaders['set-cookie'] = setCookie.join('\n');
          return route.fulfill({status: res.status || 599, headers: outHeaders, body: res.body});
        } catch {
          await route.abort().catch(() => undefined);
        }
      });
      await context.routeWebSocket('**/*', (ws) => {
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
