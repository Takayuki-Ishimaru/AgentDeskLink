import type { VisualObservation, VisualViewOptions, VisualMetadata } from './visual-types.js';
export interface SequenceOptions extends VisualViewOptions {
  frame_count?: number;
  interval_ms?: number;
}
export interface SequenceHooks {
  capture: (options: VisualViewOptions, signal: AbortSignal) => Promise<VisualObservation>;
  assertRetained: (frame_id: string, signal: AbortSignal) => Promise<void>;
  discard: (frame_ids: string[]) => void;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
export interface SequenceObservation {
  metadata: {
    ok: true;
    sequence_id: string;
    session_id: string;
    target_id: string;
    encoding: 'timestamped_png_sequence';
    audio: false;
    requested_interval_ms: number;
    elapsed_ms: number;
    sampling: 'discrete_frames_unsampled_intervals';
    frames: (VisualMetadata & { elapsed_ms: number })[];
  };
  frames: VisualObservation[];
}
