import { randomUUID } from 'node:crypto';
import { AdlError } from './types.js';

/** Technical proof that a confirmation was issued for the current target of one session. */
export type InputProofAction = 'click' | 'fill';

export interface InputProofTarget {
  role: string;
  name: string;
}

export interface InputProofRequest {
  session_id: string;
  native_id: string;
  action: InputProofAction;
  revision: number;
  target: InputProofTarget;
  ttl_ms: number;
  started_at: number;
}

export interface InputProofTicket {
  confirmation_id: string;
  expires_in_ms: number;
}

export interface InputProof {
  session_id: string;
  native_id: string;
  action: InputProofAction;
  revision: number;
  target: InputProofTarget;
  expires_at_ms: number;
}

const MAX_ID_LENGTH = 128;
const MAX_ROLE_LENGTH = 100;
const MAX_NAME_LENGTH = 512;
const MAX_TTL_MS = 30000;
const DEFAULT_MAX_PROOFS = 32;

function reject(): never {
  throw new AdlError('E_INVALID_ARGUMENT');
}

function rejectStale(): never {
  throw new AdlError('E_STALE_STATE');
}

function requireBoundedString(value: unknown, max: number, allowEmpty: boolean): string {
  if (typeof value !== 'string' || value.length > max) reject();
  if (!allowEmpty && value.length === 0) reject();
  return value;
}

function requireAction(value: unknown): InputProofAction {
  if (value === 'click' || value === 'fill') return value;
  reject();
}

function requirePositiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) reject();
  return value;
}

function requireTarget(value: unknown): InputProofTarget {
  if (typeof value !== 'object' || value === null) reject();
  const target = value as Record<string, unknown>;
  return {
    role: requireBoundedString(target.role, MAX_ROLE_LENGTH, false),
    name: requireBoundedString(target.name, MAX_NAME_LENGTH, true),
  };
}

interface ProofEntry {
  readonly confirmation_id: string;
  readonly session_id: string;
  readonly native_id: string;
  readonly action: InputProofAction;
  readonly revision: number;
  readonly target: InputProofTarget;
  readonly expires_at_ms: number;
}

export class InputProofStore {
  readonly #now: () => number;
  readonly #maxProofs: number;
  readonly #proofs = new Map<string, ProofEntry>();

  constructor(options: { now?: () => number; max_proofs?: number } = {}) {
    const now = options.now ?? performance.now.bind(performance);
    if (typeof now !== 'function') reject();
    const maxProofs = options.max_proofs ?? DEFAULT_MAX_PROOFS;
    if (!Number.isSafeInteger(maxProofs) || maxProofs < 1) reject();
    this.#now = now;
    this.#maxProofs = maxProofs;
  }

  issue(request: InputProofRequest): InputProofTicket {
    if (typeof request !== 'object' || request === null) reject();
    const candidate = request as unknown as Record<string, unknown>;
    const sessionId = requireBoundedString(candidate.session_id, MAX_ID_LENGTH, false);
    const nativeId = requireBoundedString(candidate.native_id, MAX_ID_LENGTH, false);
    const action = requireAction(candidate.action);
    const revision = requirePositiveInteger(candidate.revision);
    const target = requireTarget(candidate.target);
    const ttl = requirePositiveInteger(candidate.ttl_ms);
    if (ttl > MAX_TTL_MS) reject();
    const startedAt = candidate.started_at;
    if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) reject();

    const now = this.#now();
    const expiresAtMs = startedAt + ttl;
    // A preparation window that already ran out is stale state even when its start time is malformed.
    if (expiresAtMs <= now) rejectStale();
    if (startedAt > now) reject();

    this.prune();
    if (!this.#proofs.has(sessionId) && this.#proofs.size >= this.#maxProofs) {
      throw new AdlError('E_RESOURCE_LIMIT');
    }
    const confirmationId = `c_${randomUUID()}`;
    this.#proofs.set(sessionId, {
      confirmation_id: confirmationId,
      session_id: sessionId,
      native_id: nativeId,
      action,
      revision,
      target,
      expires_at_ms: expiresAtMs,
    });
    return { confirmation_id: confirmationId, expires_in_ms: expiresAtMs - now };
  }

  consume(sessionId: unknown, confirmationId: unknown): InputProof {
    if (typeof sessionId !== 'string' || typeof confirmationId !== 'string') {
      throw new AdlError('E_TARGET_NOT_FOUND');
    }
    const entry = this.#proofs.get(sessionId);
    if (entry === undefined) throw new AdlError('E_TARGET_NOT_FOUND');
    if (entry.expires_at_ms <= this.#now()) {
      this.#proofs.delete(sessionId);
      throw new AdlError('E_STALE_STATE');
    }
    if (entry.confirmation_id !== confirmationId) throw new AdlError('E_TARGET_NOT_FOUND');
    this.#proofs.delete(sessionId);
    return {
      session_id: entry.session_id,
      native_id: entry.native_id,
      action: entry.action,
      revision: entry.revision,
      target: { role: entry.target.role, name: entry.target.name },
      expires_at_ms: entry.expires_at_ms,
    };
  }

  invalidateSession(sessionId: unknown): void {
    if (typeof sessionId === 'string') this.#proofs.delete(sessionId);
  }

  clear(): void {
    this.#proofs.clear();
  }

  prune(): number {
    const now = this.#now();
    let removed = 0;
    for (const [key, entry] of this.#proofs) {
      if (entry.expires_at_ms <= now) {
        this.#proofs.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
