import { randomUUID } from 'node:crypto';
import { AdlError, type Element, type RawSnapshot } from './types.js';
import { redactElement,redactString } from './policy.js';

export type Representation = 'auto' | 'full' | 'delta';
export type ObservationFormat = 'json' | 'compact' | 'lines';
export interface ObserveOptions {
  token_budget: number;
  /** Internal per-response element limit; storage retains later scoped elements. */
  element_limit?:number;
  since_revision?: number;
  cursor?: string;
  scope?: string;
  depth?: number;
  include?: string[];
  representation?: Representation;
  format?:ObservationFormat;
  text?:{element_id:string;offset?:number;length?:number};
}
export interface SnapshotChange { op: 'added' | 'removed' | 'changed'; id: string; element?: Element }
export interface ObserveResult {
  text?:{element_id:string;offset:number;content:string;total_length:number;next_offset:number|null;truncated:boolean};
  format?:'compact'|'lines';
  defaults?:{enabled:true;value:''};
  lines?:string[];
  url?:string;
  title?:string;
  warnings?:{code:string;count:number;origin?:string}[];
  ok: true;
  session_id: string;
  revision: number;
  elements?: Element[];
  changes?: SnapshotChange[];
  redactions: number;
  truncated: boolean;
  next_cursor: string | null;
  representation?: 'full' | 'delta';
  reset?: boolean;
}

const MAX_SESSIONS = 32;
const MAX_REVISIONS = 8;
const MAX_ELEMENTS = 20_000;
const MAX_CURSORS = 128;
const CURSOR_TTL_MS = 60_000;
const MIN_BUDGET = 256;
const MAX_BUDGET = 8_000;
const NAME_CAP = 48;
const VALUE_CAP = 96;

const FIELDS = ['id', 'role', 'name', 'value', 'enabled', 'checked', 'selected', 'expanded', 'options', 'parent_id','name_truncated','text_length'] as const;
type Field = (typeof FIELDS)[number];
const INCLUDE_KEYS = new Map(FIELDS.map((f) => [f.toLowerCase(), f]));
const SCOPE_KEYS = new Map([
  ['role', 'role'], ['name', 'name'], ['id', 'id'],
  ['element_id', 'id'], ['elementid', 'id'],
].map(([k, v]) => [k, v as 'role' | 'name' | 'id']));

interface Stored { revision: number; elements: Element[]; truncated: boolean; redactions:number; metadata:Pick<ObserveResult,'url'|'title'|'warnings'>; }
interface Cursor {
  sessionId: string; revision: number; budget: number; since: number | null;
  optionsKey: string; offset: number; expires: number;
  representation: 'full' | 'delta' | null; reset: boolean;
}

function deny(code: 'E_INVALID_ARGUMENT' | 'E_STALE_STATE' | 'E_TARGET_NOT_FOUND' | 'E_RESOURCE_LIMIT'): never {
  throw new AdlError(code);
}

function normalizeInclude(include?: string[]): Field[] | null {
  if (include === undefined) return null;
  if (!Array.isArray(include)) deny('E_INVALID_ARGUMENT');
  const out: Field[] = [];
  for (const raw of include) {
    if (typeof raw !== 'string') deny('E_INVALID_ARGUMENT');
    const field = INCLUDE_KEYS.get(raw.trim().toLowerCase());
    if (!field) deny('E_INVALID_ARGUMENT');
    if (!out.includes(field)) out.push(field);
  }
  return out;
}

function matchesDepth(element: Element, depth: number | undefined): boolean {
  if (depth === undefined) return true;
  return element.depth === undefined || element.depth <= depth;
}

function matchesScope(element: Element, scope: string | undefined): boolean {
  if (scope === undefined) return true;
  const parts = scope.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return true;
  return parts.every((part) => {
    const at = part.search(/[:=]/);
    if (at < 0) {
      const needle = part.toLowerCase();
      return element.id.toLowerCase() === needle || element.role.toLowerCase() === needle
        || element.name.toLowerCase() === needle || JSON.stringify(element).toLowerCase().includes(needle);
    }
    const key = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).trim().toLowerCase();
    const field = SCOPE_KEYS.get(key);
    if (!field) deny('E_INVALID_ARGUMENT');
    const actual = element[field];
    return typeof actual === 'string' && actual.toLowerCase() === value;
  });
}

function project(element: Element, include: Field[] | null): Element {
  if (!include) {
    if (!('depth' in element)) return element;
    const { depth: _depth, ...rest } = element;
    return rest as Element;
  }
  const out: Record<string, unknown> = {};
  for (const field of include) if (element[field] !== undefined) out[field] = element[field];
  if (include.includes('options') && element.options_truncated) out.options_truncated = true;
  return out as unknown as Element;
}

function compactElement(element:Element):Element{
  const out={...element} as Partial<Element>;
  if(out.enabled===true)delete out.enabled;
  if(out.value==='')delete out.value;
  return out as Element;
}

// All page-controlled strings are JSON-escaped; a newline cannot forge a row.
function row(change:SnapshotChange,delta:boolean):string{
  const prefix=delta?({added:'+',removed:'-',changed:'~'} as const)[change.op]+' ':'';
  if(!change.element)return prefix+JSON.stringify(change.id);
  const e=compactElement(change.element),parts=[JSON.stringify(e.id??change.id),JSON.stringify(e.role??''),JSON.stringify(e.name??'')];
  for(const [key,value]of Object.entries(e))if(!['id','role','name'].includes(key))parts.push(key+'='+JSON.stringify(value));
  return prefix+parts.join(' ');
}

function cap(element: Element, nameCap: number, valueCap: number): Element {
  const out: Element = { ...element };
  if (typeof out.name === 'string' && out.name.length > nameCap) out.name = `${out.name.slice(0, nameCap)}...`;
  if (out.name !== element.name) out.name_truncated=true;
  if (typeof out.value === 'string' && out.value.length > valueCap) out.value = `${out.value.slice(0, valueCap)}...`;
  return out;
}

function changeKey(change: SnapshotChange): string {
  return `${change.op}\u0000${change.id}`;
}

export class SnapshotStore {
  constructor(private readonly allowPersonalData=false){}
  private readonly sessions = new Map<string, Stored[]>();
  private readonly cursors = new Map<string, Cursor>();

  record(sessionId: string, revision: number, snapshot: RawSnapshot): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) deny('E_INVALID_ARGUMENT');
    if (!Number.isInteger(revision) || revision < 0) deny('E_INVALID_ARGUMENT');
    if (!snapshot || !Array.isArray(snapshot.elements)) deny('E_INVALID_ARGUMENT');
    const elements = snapshot.elements.slice(0, MAX_ELEMENTS).map((e) => redactElement(e,this.allowPersonalData) as Element);
    const redactions=elements.reduce((count,e,i)=>{
      const raw=snapshot.elements[i]!;
      return count+(e.name!==raw.name?1:0)+(e.value!==raw.value?1:0)+(e.options??[]).reduce((n,option,index)=>n+(option.label!==raw.options?.[index]?.label?1:0)+(option.value!==raw.options?.[index]?.value?1:0),0);
    },0);
    const stored: Stored = { revision, elements, truncated: snapshot.truncated === true || snapshot.elements.length>MAX_ELEMENTS,redactions,metadata:{...(snapshot.url?{url:redactString(snapshot.url,this.allowPersonalData).slice(0,512)}:{}),...(snapshot.title?{title:redactString(snapshot.title,this.allowPersonalData).slice(0,512)}:{}),...(snapshot.warnings?{warnings:snapshot.warnings.slice(0,8)}:{})} };
    let history = this.sessions.get(sessionId);
    if (!history) {
      if (this.sessions.size >= MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest === undefined) deny('E_RESOURCE_LIMIT');
        this.dropSession(oldest);
      }
      history = [];
      this.sessions.set(sessionId, history);
    }
    const at = history.findIndex((s) => s.revision >= revision);
    if (at === -1) history.push(stored);
    else if (history[at]!.revision === revision) history[at] = stored;
    else history.splice(at, 0, stored);
    while (history.length > MAX_REVISIONS) history.shift();
    for (const [token, cursor] of this.cursors) {
      if (cursor.sessionId === sessionId && cursor.revision !== revision) this.cursors.delete(token);
    }
  }

  observe(sessionId: string, revision: number, options: ObserveOptions): ObserveResult {
    const budget = this.checkOptions(options);
    const history = this.sessions.get(sessionId);
    if (!history) deny('E_TARGET_NOT_FOUND');
    const current = history.find((s) => s.revision === revision);
    if (!current) deny('E_STALE_STATE');
    const since = options.since_revision;
    let base: Stored | null = null;
    if (since !== undefined) {
      if (!Number.isInteger(since) || since < 0) deny('E_INVALID_ARGUMENT');
      base = history.find((s) => s.revision === since) ?? deny('E_STALE_STATE');
    }
    const include = normalizeInclude(options.include);
    if (options.scope !== undefined && typeof options.scope !== 'string') deny('E_INVALID_ARGUMENT');
    if (options.depth !== undefined && (!Number.isInteger(options.depth) || options.depth < 1 || options.depth > 12)) deny('E_INVALID_ARGUMENT');
    const representation = options.representation;
    if (representation !== undefined && representation !== 'auto' && representation !== 'full' && representation !== 'delta') deny('E_INVALID_ARGUMENT');
    const format=options.format??'json';
    if(!['json','compact','lines'].includes(format))deny('E_INVALID_ARGUMENT');
    const scope = options.scope;
    const depth = options.depth;
    const key = this.optionsKey(options, include, scope);
    let offset = 0;
    let carried: Cursor | null = null;
    if (options.cursor !== undefined) {
      carried = this.takeCursor(options.cursor, sessionId, revision, budget, since ?? null, key);
      offset = carried.offset;
    }
    let items: SnapshotChange[] | null = null;
    let mode: 'full' | 'delta';
    let reset: boolean;
    if (carried && carried.representation !== null) {
      mode = carried.representation;
      reset = carried.reset;
    } else if (representation === undefined) {
      mode = base !== null ? 'delta' : 'full';
      reset = false;
    } else if (representation === 'delta') {
      mode = base !== null ? 'delta' : 'full';
      reset = false;
    } else if (representation === 'full') {
      mode = 'full';
      reset = base !== null;
    } else {
      items = this.items(current, base, include, scope, depth);
      const deltaItems = items;
      const fullItems = this.items(current, null, include, scope, depth);
      const deltaBytes = this.payloadBytes(sessionId, revision, deltaItems, false, current.redactions, 'delta', false,format);
      const fullBytes = this.payloadBytes(sessionId, revision, fullItems, true, current.redactions, 'full', base !== null,format);
      mode = base === null ? 'full' : (fullBytes < deltaBytes ? 'full' : 'delta');
      reset = mode === 'full' && base !== null;
      items = mode === 'full' ? fullItems : deltaItems;
    }
    if (items === null) items = this.items(current, mode === 'full' ? null : base, include, scope, depth);
    const advertised = representation === undefined ? null : mode;
    return this.pack(sessionId, revision, items, offset, budget, mode === 'delta', current.truncated, key, since ?? null, current.redactions, advertised, reset, options.element_limit,current.metadata,format);
  }

  close(sessionId: string): void { this.dropSession(sessionId); }

  clear(): void { this.sessions.clear(); this.cursors.clear(); }

  private checkOptions(options: ObserveOptions): number {
    if (!options || typeof options !== 'object') deny('E_INVALID_ARGUMENT');
    const budget = options.token_budget;
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < MIN_BUDGET || budget > MAX_BUDGET) deny('E_INVALID_ARGUMENT');
    return Math.floor(budget);
  }

  private items(current: Stored, base: Stored | null, include: Field[] | null, scope: string | undefined, depth: number | undefined): SnapshotChange[] {
    if (!base) {
      return current.elements
        .filter((e) => matchesScope(e, scope) && matchesDepth(e, depth))
        .map((element) => ({ op: 'added' as const, id: element.id, element: project(element, include) }));
    }
    const before = new Map(base.elements.filter((e) => matchesScope(e, scope) && matchesDepth(e, depth)).map((e) => [e.id, e]));
    const after = new Map(current.elements.filter((e) => matchesScope(e, scope) && matchesDepth(e, depth)).map((e) => [e.id, e]));
    const changes: SnapshotChange[] = [];
    for (const [id, element] of after) {
      const old = before.get(id);
      if (!old) changes.push({ op: 'added', id, element });
      else if (JSON.stringify(old) !== JSON.stringify(element)) changes.push({ op: 'changed', id, element });
    }
    for (const id of before.keys()) if (!after.has(id)) changes.push({ op: 'removed', id });
    return changes.map((c) => (c.element ? { ...c, element: project(c.element, include) } : c)).sort((a, b) => (changeKey(a) < changeKey(b) ? -1 : 1));
  }

  private payloadBytes(sessionId: string, revision: number, items: SnapshotChange[], full: boolean, redactions: number, mode: 'full' | 'delta', reset: boolean,format:ObservationFormat='json'): number {
    const envelope: Record<string, unknown> = { ok: true, session_id: sessionId, revision, representation: mode, redactions, truncated: false, next_cursor: null };
    if (reset) envelope.reset = true;
    if(format!=='json'){envelope.format=format;envelope.defaults={enabled:true,value:''};}
    const transformed=format==='compact'?items.map(c=>({...c,...(c.element?{element:compactElement(c.element)}:{})})):items;
    envelope[format==='lines'?'lines':full?'elements':'changes']=format==='lines'?items.map(c=>row(c,!full)):full?transformed.map(c=>c.element):transformed;
    return Buffer.byteLength(JSON.stringify(envelope) ?? '', 'utf8');
  }

  private pack(sessionId: string, revision: number, items: SnapshotChange[], offset: number, budget: number, delta: boolean, sourceTruncated: boolean, key: string, since: number | null,redactions:number,mode:'full'|'delta'|null=null,reset=false,elementLimit=MAX_ELEMENTS,metadata:Stored['metadata']={},format:ObservationFormat='json'): ObserveResult {
    const limit = budget * 4;
    if(budget<512)metadata={...metadata,...(metadata.url?{url:metadata.url.slice(0,128)}:{}),...(metadata.title?{title:metadata.title.slice(0,64)}:{})};
    const head = (redactions: number, truncated: boolean, cursor: string | null): ObserveResult => ({
      ...metadata,ok: true, session_id: sessionId, revision,
      ...(format!=='json'?{format,defaults:{enabled:true,value:''}}:{}),
      ...(mode ? { representation: mode, ...(reset ? { reset: true } : {}) } : {}),
      ...(format==='lines'?{lines:[]}:delta ? { changes: [] as SnapshotChange[] } : { elements: [] as Element[] }),
      redactions, truncated, next_cursor: cursor,
    } as unknown as ObserveResult);
    const size = (list: SnapshotChange[], redactions: number, cursor: string | null): number => {
      const base = head(redactions, false, cursor);
      const transformed=format==='compact'?list.map(c=>({...c,...(c.element?{element:compactElement(c.element)}:{})})):list;
      const payload=format==='lines'?list.map(c=>row(c,delta)):delta?transformed:transformed.map(c=>c.element);
      return Buffer.byteLength(JSON.stringify({ ...base, [format==='lines'?'lines':delta?'changes':'elements']: payload }) ?? '', 'utf8');
    };
    const emit = (list: SnapshotChange[], redactions: number, truncated: boolean, cursor: string | null): ObserveResult => {
      const transformed=format==='compact'?list.map(c=>({...c,...(c.element?{element:compactElement(c.element)}:{})})):list;
      const payload=format==='lines'?list.map(c=>row(c,delta)):delta?transformed:transformed.map(c=>c.element);
      return { ...head(redactions, truncated, cursor), [format==='lines'?'lines':delta?'changes':'elements']: payload } as ObserveResult;
    };
    // Leave room for an actual item and its continuation, rather than returning
    // an empty terminal page when multi-byte metadata fills a small budget.
    const first=items[Math.min(Math.max(offset,0),items.length)];
    while(size(first?[this.minimal(first)]:[],redactions,'x'.repeat(36))>limit){
      if(metadata.title&&metadata.title.length>8)metadata={...metadata,title:metadata.title.slice(0,Math.floor(metadata.title.length/2))};
      else if(metadata.url&&metadata.url.length>16)metadata={...metadata,url:metadata.url.slice(0,Math.floor(metadata.url.length/2))};
      else if(metadata.warnings?.length)metadata={...metadata,warnings:metadata.warnings.slice(0,-1)};
      else deny('E_RESOURCE_LIMIT');
    }
    const chosen: SnapshotChange[] = [];
    let shortened=false;
    let i = Math.min(Math.max(offset, 0), items.length);
    while (i < items.length && chosen.length < elementLimit) {
      if (size([...chosen, items[i]!], redactions, null) <= limit) { chosen.push(items[i]!); i += 1; continue; }
      // Move an otherwise complete element to the next page before discarding fields.
      const shrunk = size([items[i]!], redactions, 'x'.repeat(36)) > limit
        ? [this.shrink(items[i]!, true), this.shrink(items[i]!)].find(candidate => candidate && size([...chosen, candidate], redactions, null) <= limit)
        : null;
      if (shrunk) { chosen.push(shrunk); shortened=true; i += 1; continue; }
      break;
    }
    const truncated = i < items.length || sourceTruncated || shortened;
    if (i >= items.length) return emit(chosen, redactions, truncated, null);
    const token = this.issue(sessionId, revision, budget, since, key, i, mode, reset);
    const cursor = this.cursors.get(token)!;
    while (chosen.length > 0 && size(chosen, redactions, token) > limit) { chosen.pop(); i -= 1; }
    cursor.offset = i;
    if (chosen.length === 0) {
      let progressed = false;
      for (const candidate of [this.shrink(items[i]!, true), this.shrink(items[i]!), this.minimal(items[i]!)]) {
        if (!candidate) continue;
        cursor.offset = i + 1;
        if (size([candidate], redactions, token) <= limit) { chosen.push(candidate); shortened=true; progressed = true; break; }
      }
      if (!progressed) { this.cursors.delete(token); deny('E_RESOURCE_LIMIT'); }
    }
    if(cursor.offset>=items.length){this.cursors.delete(token);return emit(chosen,redactions,sourceTruncated||shortened,null);}
    return emit(chosen, redactions, true, token);
  }

  private shrink(item: SnapshotChange, preserveText = false): SnapshotChange | null {
    if (!item.element) return null;
    // Candidate lists are optional detail. Keep the control's identity and live
    // state, and make omission explicit even when later cursor pages are complete.
    const {options, ...core} = item.element;
    const compact = options ? {...core, options_truncated: true} : item.element;
    const capped = preserveText ? compact : cap(compact, NAME_CAP, VALUE_CAP);
    return JSON.stringify(capped) === JSON.stringify(item.element) ? null : { ...item, element: capped };
  }

  private minimal(item: SnapshotChange): SnapshotChange {
    if (!item.element) return item;
    return { op: item.op, id: item.id, element: { id: item.element.id, role: item.element.role??'', name: '', enabled: item.element.enabled??false } };
  }

  private optionsKey(options: ObserveOptions, include: Field[] | null, scope: string | undefined): string {
    return JSON.stringify([scope ?? null, options.depth ?? null, include ?? null, options.representation ?? null,options.element_limit??null,options.format??'json']);
  }

  private issue(sessionId: string, revision: number, budget: number, since: number | null, key: string, offset: number, representation: 'full' | 'delta' | null = null, reset = false): string {
    this.pruneCursors();
    const token = randomUUID();
    this.cursors.set(token, { sessionId, revision, budget, since, optionsKey: key, offset, expires: Date.now() + CURSOR_TTL_MS, representation, reset });
    return token;
  }

  private takeCursor(token: string, sessionId: string, revision: number, budget: number, since: number | null, key: string): Cursor {
    if (typeof token !== 'string') deny('E_INVALID_ARGUMENT');
    this.pruneCursors();
    const cursor = this.cursors.get(token);
    if (!cursor) deny('E_INVALID_ARGUMENT');
    if (cursor.sessionId !== sessionId || cursor.revision !== revision || cursor.budget !== budget
      || cursor.since !== since || cursor.optionsKey !== key) deny('E_STALE_STATE');
    this.cursors.delete(token);
    return cursor;
  }

  private pruneCursors(): void {
    const now = Date.now();
    for (const [token, cursor] of this.cursors) if (cursor.expires <= now) this.cursors.delete(token);
    while (this.cursors.size >= MAX_CURSORS) {
      const oldest = this.cursors.keys().next().value;
      if (oldest === undefined) break;
      this.cursors.delete(oldest);
    }
  }

  private dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    for (const [token, cursor] of this.cursors) if (cursor.sessionId === sessionId) this.cursors.delete(token);
  }
}
