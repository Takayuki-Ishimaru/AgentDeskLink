import { randomUUID } from 'node:crypto';
import { AdlError, type Element, type RawSnapshot } from './types.js';
import { redactElement } from './policy.js';

export interface ObserveOptions {
  token_budget: number;
  since_revision?: number;
  cursor?: string;
  scope?: string;
  depth?: number;
  include?: string[];
}
export interface SnapshotChange { op: 'added' | 'removed' | 'changed'; id: string; element?: Element }
export interface ObserveResult {
  ok: true;
  session_id: string;
  revision: number;
  elements?: Element[];
  changes?: SnapshotChange[];
  redactions: number;
  truncated: boolean;
  next_cursor: string | null;
}

const MAX_SESSIONS = 32;
const MAX_REVISIONS = 8;
const MAX_ELEMENTS = 1_000;
const MAX_CURSORS = 128;
const CURSOR_TTL_MS = 60_000;
const MIN_BUDGET = 256;
const MAX_BUDGET = 8_000;
const NAME_CAP = 48;
const VALUE_CAP = 96;

const FIELDS = ['id', 'role', 'name', 'value', 'enabled', 'checked', 'selected'] as const;
type Field = (typeof FIELDS)[number];
const INCLUDE_KEYS = new Map(FIELDS.map((f) => [f.toLowerCase(), f]));
const SCOPE_KEYS = new Map([
  ['role', 'role'], ['name', 'name'], ['id', 'id'],
  ['element_id', 'id'], ['elementid', 'id'],
].map(([k, v]) => [k, v as 'role' | 'name' | 'id']));

interface Stored { revision: number; elements: Element[]; truncated: boolean; redactions:number; }
interface Cursor {
  sessionId: string; revision: number; budget: number; since: number | null;
  optionsKey: string; offset: number; expires: number;
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
  if (!include) return element;
  const out: Record<string, unknown> = {};
  for (const field of include) if (element[field] !== undefined) out[field] = element[field];
  return out as unknown as Element;
}

function cap(element: Element, nameCap: number, valueCap: number): Element {
  const out: Element = { ...element };
  if (typeof out.name === 'string' && out.name.length > nameCap) out.name = `${out.name.slice(0, nameCap)}...`;
  if (typeof out.value === 'string' && out.value.length > valueCap) out.value = `${out.value.slice(0, valueCap)}...`;
  return out;
}

function changeKey(change: SnapshotChange): string {
  return `${change.op}\u0000${change.id}`;
}

export class SnapshotStore {
  private readonly sessions = new Map<string, Stored[]>();
  private readonly cursors = new Map<string, Cursor>();

  record(sessionId: string, revision: number, snapshot: RawSnapshot): void {
    if (typeof sessionId !== 'string' || sessionId.length === 0) deny('E_INVALID_ARGUMENT');
    if (!Number.isInteger(revision) || revision < 0) deny('E_INVALID_ARGUMENT');
    if (!snapshot || !Array.isArray(snapshot.elements)) deny('E_INVALID_ARGUMENT');
    const elements = snapshot.elements.slice(0, MAX_ELEMENTS).map((e) => redactElement(e) as Element);
    const redactions=elements.reduce((count,e,i)=>count+(e.name!==snapshot.elements[i]!.name?1:0)+(e.value!==snapshot.elements[i]!.value?1:0),0);
    const stored: Stored = { revision, elements, truncated: snapshot.truncated === true || snapshot.elements.length>MAX_ELEMENTS,redactions };
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
    if (options.depth !== undefined && (!Number.isInteger(options.depth) || options.depth < 0)) deny('E_INVALID_ARGUMENT');
    const scope = options.scope;
    const items = this.items(current, base, include, scope);
    const key = this.optionsKey(options, include, scope);
    let offset = 0;
    if (options.cursor !== undefined) {
      const cursor = this.takeCursor(options.cursor, sessionId, revision, budget, since ?? null, key);
      offset = cursor.offset;
    }
    return this.pack(sessionId, revision, items, offset, budget, base !== null, current.truncated, key, since ?? null,current.redactions);
  }

  close(sessionId: string): void { this.dropSession(sessionId); }

  clear(): void { this.sessions.clear(); this.cursors.clear(); }

  private checkOptions(options: ObserveOptions): number {
    if (!options || typeof options !== 'object') deny('E_INVALID_ARGUMENT');
    const budget = options.token_budget;
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < MIN_BUDGET || budget > MAX_BUDGET) deny('E_INVALID_ARGUMENT');
    return Math.floor(budget);
  }

  private items(current: Stored, base: Stored | null, include: Field[] | null, scope: string | undefined): SnapshotChange[] {
    if (!base) {
      return current.elements
        .filter((e) => matchesScope(e, scope))
        .map((element) => ({ op: 'added' as const, id: element.id, element: project(element, include) }));
    }
    const before = new Map(base.elements.map((e) => [e.id, e]));
    const after = new Map(current.elements.map((e) => [e.id, e]));
    const changes: SnapshotChange[] = [];
    for (const [id, element] of after) {
      const old = before.get(id);
      if (!old) changes.push({ op: 'added', id, element });
      else if (JSON.stringify(old) !== JSON.stringify(element)) changes.push({ op: 'changed', id, element });
    }
    for (const id of before.keys()) if (!after.has(id)) changes.push({ op: 'removed', id });
    return changes.filter((c) => {
      if (c.element) return matchesScope(c.element, scope);
      const old = before.get(c.id);
      return old ? matchesScope(old, scope) : true;
    }).map(c=>c.element?{...c,element:project(c.element,include)}:c).sort((a, b) => (changeKey(a) < changeKey(b) ? -1 : 1));
  }

  private pack(sessionId: string, revision: number, items: SnapshotChange[], offset: number, budget: number, delta: boolean, sourceTruncated: boolean, key: string, since: number | null,redactions:number): ObserveResult {
    const limit = budget * 4;
    const head = (redactions: number, truncated: boolean, cursor: string | null): ObserveResult => delta
      ? { ok: true, session_id: sessionId, revision, changes: [], redactions, truncated, next_cursor: cursor }
      : { ok: true, session_id: sessionId, revision, elements: [], redactions, truncated, next_cursor: cursor };
    const size = (list: SnapshotChange[], redactions: number, cursor: string | null): number => {
      const base = head(redactions, false, cursor);
      const payload = delta ? (list as unknown[]) : list.map((c) => c.element as Element);
      return Buffer.byteLength(JSON.stringify({ ...base, [delta ? 'changes' : 'elements']: payload }) ?? '', 'utf8');
    };
    const emit = (list: SnapshotChange[], redactions: number, truncated: boolean, cursor: string | null): ObserveResult => {
      const payload = delta ? list : list.map((c) => c.element as Element);
      return { ...head(redactions, truncated, cursor), [delta ? 'changes' : 'elements']: payload } as ObserveResult;
    };
    const chosen: SnapshotChange[] = [];
    let shortened=false;
    let i = Math.min(Math.max(offset, 0), items.length);
    while (i < items.length) {
      if (size([...chosen, items[i]!], redactions, null) <= limit) { chosen.push(items[i]!); i += 1; continue; }
      const shrunk = this.shrink(items[i]!);
      if (shrunk && size([...chosen, shrunk], redactions, null) <= limit) { chosen.push(shrunk); shortened=true; i += 1; continue; }
      break;
    }
    const truncated = i < items.length || sourceTruncated || shortened;
    if (i >= items.length) return emit(chosen, redactions, truncated, null);
    const token = this.issue(sessionId, revision, budget, since, key, i);
    const cursor = this.cursors.get(token)!;
    while (chosen.length > 0 && size(chosen, redactions, token) > limit) { chosen.pop(); i -= 1; }
    cursor.offset = i;
    if (chosen.length === 0) {
      let progressed = false;
      for (const candidate of [this.shrink(items[i]!), this.minimal(items[i]!)]) {
        if (!candidate) continue;
        cursor.offset = i + 1;
        if (size([candidate], redactions, token) <= limit) { chosen.push(candidate); shortened=true; progressed = true; break; }
      }
      if (!progressed) { this.cursors.delete(token); return emit([], redactions, true, null); }
    }
    if(cursor.offset>=items.length){this.cursors.delete(token);return emit(chosen,redactions,sourceTruncated||shortened,null);}
    return emit(chosen, redactions, true, token);
  }

  private shrink(item: SnapshotChange): SnapshotChange | null {
    if (!item.element) return null;
    const capped = cap(item.element, NAME_CAP, VALUE_CAP);
    return JSON.stringify(capped) === JSON.stringify(item.element) ? null : { ...item, element: capped };
  }

  private minimal(item: SnapshotChange): SnapshotChange {
    if (!item.element) return item;
    return { op: item.op, id: item.id, element: { id: item.element.id, role: item.element.role??'', name: '', enabled: item.element.enabled??false } };
  }

  private optionsKey(options: ObserveOptions, include: Field[] | null, scope: string | undefined): string {
    return JSON.stringify([scope ?? null, options.depth ?? null, include ?? null]);
  }

  private issue(sessionId: string, revision: number, budget: number, since: number | null, key: string, offset: number): string {
    this.pruneCursors();
    const token = randomUUID();
    this.cursors.set(token, { sessionId, revision, budget, since, optionsKey: key, offset, expires: Date.now() + CURSOR_TTL_MS });
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
