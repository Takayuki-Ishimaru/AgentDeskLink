import { randomUUID } from 'node:crypto';
import { AdlError, type ErrorCode } from './types.js';
import { MAX_VISUAL_OUTPUT_BYTES, type VisualObservation } from './visual-types.js';
import type { SequenceHooks, SequenceObservation, SequenceOptions } from './sequence-types.js';

const MIN_FRAMES = 2,
  MAX_FRAMES = 16,
  DEFAULT_FRAMES = 8;
const MIN_INTERVAL_MS = 50,
  MAX_INTERVAL_MS = 2000,
  DEFAULT_INTERVAL_MS = 250;
const MAX_SPAN_MS = 6000;
const MIN_MAX_DIMENSION = 64,
  MAX_MAX_DIMENSION = 1024,
  DEFAULT_MAX_DIMENSION = 512;
const MIN_MAX_PIXELS = 4096,
  MAX_MAX_PIXELS = 1048576,
  DEFAULT_MAX_PIXELS = 262144;
const ALLOWED_KEYS = ['frame_count', 'interval_ms', 'max_dimension', 'max_pixels'];

function invalid(): never {
  throw new AdlError('E_INVALID_ARGUMENT');
}
function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

interface Limits {
  frame_count: number;
  interval_ms: number;
  max_dimension: number;
  max_pixels: number;
}

/** SequenceOptions borrows the visual limits but a sequence always frames the whole surface. */
function validate(options: SequenceOptions): Limits {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) invalid();
  const given = options as Record<string, unknown>;
  for (const key of Object.keys(given)) {
    if (key === 'region' || !ALLOWED_KEYS.includes(key)) invalid();
  }
  const frame_count = given.frame_count === undefined ? DEFAULT_FRAMES : given.frame_count;
  const interval_ms = given.interval_ms === undefined ? DEFAULT_INTERVAL_MS : given.interval_ms;
  const max_dimension = given.max_dimension === undefined ? DEFAULT_MAX_DIMENSION : given.max_dimension;
  const max_pixels = given.max_pixels === undefined ? DEFAULT_MAX_PIXELS : given.max_pixels;
  if (!isInt(frame_count) || !isInt(interval_ms) || !isInt(max_dimension) || !isInt(max_pixels)) invalid();
  if ((frame_count as number) < MIN_FRAMES || (frame_count as number) > MAX_FRAMES) invalid();
  if ((interval_ms as number) < MIN_INTERVAL_MS || (interval_ms as number) > MAX_INTERVAL_MS) invalid();
  if (((frame_count as number) - 1) * (interval_ms as number) > MAX_SPAN_MS) invalid();
  if ((max_dimension as number) < MIN_MAX_DIMENSION || (max_dimension as number) > MAX_MAX_DIMENSION) invalid();
  if ((max_pixels as number) < MIN_MAX_PIXELS || (max_pixels as number) > MAX_MAX_PIXELS) invalid();
  return {
    frame_count: frame_count as number,
    interval_ms: interval_ms as number,
    max_dimension: max_dimension as number,
    max_pixels: max_pixels as number,
  };
}

function cancelled(): never {
  throw new AdlError('E_CANCELLED');
}

/** The caller's sleeper may ignore the signal, so every await is bracketed by an explicit check. */
function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AdlError('E_CANCELLED'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AdlError('E_CANCELLED'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export async function recordSequence(
  hooks: SequenceHooks,
  options: SequenceOptions,
  signal: AbortSignal,
): Promise<SequenceObservation> {
  const limits = validate(options);
  if (signal.aborted) cancelled();
  const now = hooks.now ?? (() => performance.now());
  const sleep = hooks.sleep ?? defaultSleep;
  const start = now();
  const frames: VisualObservation[] = [];
  const captured: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  const elapsedMs: number[] = [];

  const drop = async (code: ErrorCode): Promise<never> => {
    try {
      hooks.discard(captured);
    } catch {
      /* a failed discard must not mask the cause */
    }
    throw new AdlError(code);
  };

  try {
    for (let i = 0; i < limits.frame_count; i++) {
      if (i > 0) {
        // Pace the intended start times; capture latency eats the wait and can lower the actual fps.
        const remaining = start + i * limits.interval_ms - now();
        if (remaining > 0) await sleep(remaining, signal);
        if (signal.aborted) cancelled();
      }
      if (signal.aborted) cancelled();
      const image = await hooks.capture({ max_dimension: limits.max_dimension, max_pixels: limits.max_pixels }, signal);
      captured.push(image.metadata.frame_id);
      if (signal.aborted) cancelled();
      if (i === 0) {
        if (image.metadata.ok !== true) return await drop('E_INTERNAL');
      } else if (
        image.metadata.session_id !== frames[0]!.metadata.session_id ||
        image.metadata.target_id !== frames[0]!.metadata.target_id
      ) {
        return await drop('E_STALE_STATE');
      }
      if (seen.has(image.metadata.frame_id)) return await drop('E_STALE_STATE');
      seen.add(image.metadata.frame_id);
      totalBytes += image.png.length;
      if (totalBytes > MAX_VISUAL_OUTPUT_BYTES) return await drop('E_RESOURCE_LIMIT');
      elapsedMs.push(now() - start);
      frames.push(image);
    }
    // A successful reference must not point at a frame the source cache already evicted.
    for (const frame of frames) {
      await hooks.assertRetained(frame.metadata.frame_id, signal);
      if (signal.aborted) cancelled();
    }
    if (signal.aborted) cancelled();
  } catch (error) {
    const code: ErrorCode = error instanceof AdlError ? error.code : 'E_INTERNAL';
    try {
      hooks.discard(captured);
    } catch {
      /* ignore */
    }
    throw new AdlError(code);
  }

  const elapsed = now() - start;
  return {
    metadata: {
      ok: true,
      sequence_id: `q_${randomUUID()}`,
      session_id: frames[0]!.metadata.session_id,
      target_id: frames[0]!.metadata.target_id,
      encoding: 'timestamped_png_sequence',
      audio: false,
      requested_interval_ms: limits.interval_ms,
      elapsed_ms: elapsed,
      sampling: 'discrete_frames_unsampled_intervals',
      frames: frames.map((frame, i) => ({ ...frame.metadata, elapsed_ms: elapsedMs[i]! })),
    },
    frames,
  };
}
