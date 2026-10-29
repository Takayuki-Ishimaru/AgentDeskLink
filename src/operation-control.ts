import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface OperationState {
  epoch: string;
  stopped: boolean;
}
export function readOperationState(file: string): OperationState | undefined {
  try {
    const text = readFileSync(file, 'utf8');
    if (text.length > 512) return;
    const value = JSON.parse(text);
    if (typeof value?.epoch === 'string' && /^[a-f0-9-]{36}$/.test(value.epoch) && typeof value.stopped === 'boolean')
      return { epoch: value.epoch, stopped: value.stopped };
  } catch {}
  return undefined;
}
export function initializeOperationState(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, JSON.stringify({ epoch: randomUUID(), stopped: false }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}
// Windows can briefly refuse to replace a file that another process (a server
// reading the state, an antivirus scan) holds open. The emergency stop must not
// fail on that transient refusal, so the replacement is retried for about 1 s.
const TRANSIENT_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);
export function replaceFileSync(
  temporary: string,
  file: string,
  rename: (from: string, to: string) => void = renameSync,
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(temporary, file);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME.has((error as NodeJS.ErrnoException).code ?? '') || attempt >= 40) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
export function writeOperationState(file: string, stopped: boolean): OperationState {
  mkdirSync(dirname(file), { recursive: true });
  const state = { epoch: randomUUID(), stopped },
    temporary = `${file}.${state.epoch}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    replaceFileSync(temporary, file);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
  return state;
}
// Any generation change permanently revokes this process, including a rapid stop/resume.
// A resumed extension must provide a fresh definition; an old process never resumes work.
export function watchOperationControl(
  file: string,
  epoch: string,
  stop: () => void,
): { check: () => boolean; dispose: () => void } {
  let revoked = false;
  const check = () => {
    if (revoked) return false;
    const state = readOperationState(file);
    if (!state || state.stopped || state.epoch !== epoch) {
      revoked = true;
      stop();
      return false;
    }
    return true;
  };
  const timer = setInterval(check, 50);
  timer.unref();
  check();
  return { check, dispose: () => clearInterval(timer) };
}
