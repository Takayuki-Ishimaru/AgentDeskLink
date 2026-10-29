import type { RawSnapshot } from './types.js';

/** Upper bound of live aliases per session. Past it, aliases of ids outside the retained snapshots go first, then the oldest. */
export const ALIAS_CAP = 50_000;

/**
 * Per-session public element ids ("e1", "e2", ...). The counter only grows, so an alias is never issued twice in a session:
 * an alias of an element from an old document stays bound to that old internal id (which then fails as not found/stale)
 * and a client can never act on a different element by reusing it. Evicted aliases simply stop resolving.
 * Adapters, approval bindings and action evidence keep using internal ids.
 */
export class AliasMap {
  private next = 1;
  private readonly byInternal = new Map<string, string>();
  private readonly byAlias = new Map<string, string>();

  alias(internal: string): string {
    let a = this.byInternal.get(internal);
    if (a === undefined) {
      a = `e${this.next++}`;
      this.byInternal.set(internal, a);
      this.byAlias.set(a, internal);
    }
    return a;
  }

  resolve(alias: unknown): string | undefined {
    return typeof alias === 'string' ? this.byAlias.get(alias) : undefined;
  }

  get size(): number {
    return this.byAlias.size;
  }

  /** Returns a copy whose element ids and parent ids are aliases; evicts when over the cap, keeping aliases for `retained` (public ids still in stored snapshots). */
  project(raw: RawSnapshot, retained: () => ReadonlySet<string>): RawSnapshot {
    const elements = raw.elements.map(e => ({ ...e, id: this.alias(e.id) }));
    raw.elements.forEach((e, i) => {
      if (e.parent_id !== undefined) elements[i]!.parent_id = this.alias(e.parent_id);
    });
    if (this.byAlias.size > ALIAS_CAP) this.evict(retained(), new Set(elements.map(e => e.id)));
    return { ...raw, elements };
  }

  private evict(retained: ReadonlySet<string>, current: ReadonlySet<string>): void {
    const drop = (a: string): void => {
      const i = this.byAlias.get(a);
      this.byAlias.delete(a);
      if (i !== undefined) this.byInternal.delete(i);
    };
    for (const a of [...this.byAlias.keys()]) {
      if (this.byAlias.size <= ALIAS_CAP) return;
      if (!retained.has(a) && !current.has(a)) drop(a);
    }
    for (const a of [...this.byAlias.keys()]) {
      if (this.byAlias.size <= ALIAS_CAP) return;
      if (!current.has(a)) drop(a);
    }
  }
}
