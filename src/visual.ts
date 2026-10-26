import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {AdlError} from './types.js';
import type {ErrorCode} from './types.js';
import type {CapturedImage, ImageRegion, VisualMetadata, VisualObservation, VisualOwner, VisualViewOptions} from './visual-types.js';
import {MAX_VISUAL_OUTPUT_BYTES} from './visual-types.js';

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 4_194_304;
const DEFAULT_MAX_FRAMES = 16;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_TTL_MS = 60_000;
const UUID_RE = /^f_[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

export interface VisualStoreOptions {
  max_frames?: number;
  max_bytes?: number;
  ttl_ms?: number;
  now?: () => number;
}

interface Frame {
  id: string;
  session_id: string;
  target_id: string;
  revision: number;
  png: Buffer;
  bytes: number;
  width: number;
  height: number;
  captured_at: string;
  expires_ms: number;
  expires_at: string;
  viewport: CapturedImage['viewport'];
  redacted: boolean;
  redaction?:CapturedImage['redaction'];
  coordinate_space:CapturedImage['coordinate_space'];
  source_to_desktop?:CapturedImage['source_to_desktop'];
  surface_epoch?:string;
  input_token?:string;
  retained_at:number;
}

function fail(code: ErrorCode): never { throw new AdlError(code); }
const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const isStr = (s: unknown): s is string => typeof s === 'string' && s.length > 0;
const MAX_DIMENSION = 4096;

export class VisualStore {
  private readonly max_frames: number;
  private readonly max_bytes: number;
  private readonly ttl_ms: number;
  private readonly now: () => number;
  private readonly frames = new Map<string, Frame>();
  private total_bytes = 0;
  private readonly pending = new Set<{session_id:string;cancelled:boolean}>();

  constructor(options: VisualStoreOptions = {}) {
    const {max_frames = DEFAULT_MAX_FRAMES, max_bytes = DEFAULT_MAX_BYTES, ttl_ms = DEFAULT_TTL_MS, now = Date.now} = options;
    if (!isInt(max_frames) || max_frames < 1) fail('E_INVALID_ARGUMENT');
    if (!isNum(max_bytes) || max_bytes < 1) fail('E_INVALID_ARGUMENT');
    if (!isNum(ttl_ms) || ttl_ms < 1) fail('E_INVALID_ARGUMENT');
    if (typeof now !== 'function') fail('E_INVALID_ARGUMENT');
    this.max_frames = max_frames;
    this.max_bytes = max_bytes;
    this.ttl_ms = ttl_ms;
    this.now = now;
  }

  async record(owner: VisualOwner, image: CapturedImage, signal?: AbortSignal): Promise<string> {
    this.checkActive(signal);
    if (owner === null || typeof owner !== 'object') fail('E_INVALID_ARGUMENT');
    if (!isStr(owner.session_id) || !isStr(owner.target_id) || !isInt(owner.revision) || owner.revision < 1) fail('E_INVALID_ARGUMENT');
    this.validateImage(image);
    // Snapshot everything mutable before the first await: callers may reuse or alter the input while we decode.
    const session_id = owner.session_id;
    const target_id = owner.target_id;
    const revision = owner.revision;
    const captured_at = image.captured_at;
    const redacted = image.redacted;
    const vp = {...image.viewport};
    const coordinate_space=image.coordinate_space;
    const source_to_desktop=image.source_to_desktop?{...image.source_to_desktop}:undefined;
    const surface_epoch=image.surface_epoch;
    const input_token=image.input_token;
    if (image.png.length > MAX_SOURCE_BYTES) fail('E_RESOURCE_LIMIT');
    const source_png = Buffer.from(image.png);
    const operation={session_id,cancelled:false};this.pending.add(operation);
    try {
    // Read only the header first; enforce geometry before the bounded full decode below.
    const meta = await sharp(source_png, {limitInputPixels:false}).metadata().catch(() => fail('E_INVALID_ARGUMENT') as never);
    this.checkOperation(operation,signal);
    if (meta.format !== 'png' || !isInt(meta.width) || !isInt(meta.height) || meta.width < 1 || meta.height < 1) fail('E_INVALID_ARGUMENT');
    if (meta.width * meta.height > MAX_SOURCE_PIXELS || meta.width > MAX_DIMENSION || meta.height > MAX_DIMENSION) fail('E_RESOURCE_LIMIT');
    // The browser captures in CSS pixels, so the PNG must match the viewport exactly.
    if (meta.width !== vp.width || meta.height !== vp.height) fail('E_INVALID_ARGUMENT');
    // Fully decode and re-encode so the retained original is a valid PNG; malformed data fails here.
    const png = await sharp(source_png, {limitInputPixels: MAX_SOURCE_PIXELS}).png().toBuffer().catch(() => fail('E_INVALID_ARGUMENT') as never);
    this.checkOperation(operation,signal);
    if (png.length > MAX_SOURCE_BYTES || png.length > this.max_bytes) fail('E_RESOURCE_LIMIT');
    const expires_ms = this.now() + this.ttl_ms;
    const frame: Frame = {
      id: `f_${randomUUID()}`,
      session_id,
      target_id,
      revision,
      png,
      bytes: png.length,
      width: vp.width,
      height: vp.height,
      captured_at,
      expires_ms,
      expires_at: new Date(expires_ms).toISOString(),
      viewport: vp,
      redacted,
      ...(image.redaction?{redaction:structuredClone(image.redaction)}:{}),
      coordinate_space,source_to_desktop,surface_epoch,input_token,retained_at:this.now(),
    };
    this.evict(frame.bytes);
    this.frames.set(frame.id, frame);
    this.total_bytes += frame.bytes;
    return frame.id;
    }finally{this.pending.delete(operation);}
  }

  async view(session_id: string, frame_id: string, options: VisualViewOptions = {}, signal?: AbortSignal): Promise<VisualObservation> {
    this.checkActive(signal);
    if (!isStr(session_id) || !isStr(frame_id) || !UUID_RE.test(frame_id)) fail('E_TARGET_NOT_FOUND');
    if (options === null || typeof options !== 'object') fail('E_INVALID_ARGUMENT');
    const {region, max_dimension = 1024, max_pixels = 1_048_576} = options;
    if (!isInt(max_dimension) || max_dimension < 64 || max_dimension > 2048) fail('E_INVALID_ARGUMENT');
    if (!isInt(max_pixels) || max_pixels < 4096 || max_pixels > MAX_SOURCE_PIXELS) fail('E_INVALID_ARGUMENT');
    if (region !== undefined) {
      const {x, y, width, height} = region ?? {};
      if (!isInt(x) || !isInt(y) || !isInt(width) || !isInt(height) || x < 0 || y < 0 || width < 1 || height < 1) fail('E_INVALID_ARGUMENT');
    }
    const frame = this.frames.get(frame_id);
    if (!frame || frame.session_id !== session_id) fail('E_TARGET_NOT_FOUND');
    if (this.now() >= frame.expires_ms) { this.remove(frame); fail('E_TARGET_NOT_FOUND'); }
    const source: ImageRegion = {...(region ?? {x: 0, y: 0, width: frame.width, height: frame.height})};
    if (source.x + source.width > frame.width || source.y + source.height > frame.height) fail('E_INVALID_ARGUMENT');
    let pipeline = sharp(frame.png, {failOn: 'none'}).extract({left: source.x, top: source.y, width: source.width, height: source.height});
    const scale = Math.min(1, max_dimension / source.width, max_dimension / source.height, Math.sqrt(max_pixels / (source.width * source.height)));
    const out_width = Math.max(1, Math.floor(source.width * scale));
    const out_height = Math.max(1, Math.floor(source.height * scale));
    if (out_width !== source.width || out_height !== source.height) {
      pipeline = pipeline.resize({width: out_width, height: out_height, fit: 'fill', withoutEnlargement: true});
    }
    const operation={session_id,cancelled:false};this.pending.add(operation);
    try{
    const png = await pipeline.png().toBuffer().catch(() => fail('E_INTERNAL') as never);
    if (png.length > MAX_VISUAL_OUTPUT_BYTES) fail('E_RESOURCE_LIMIT');
    this.checkOperation(operation,signal);
    if (this.frames.get(frame_id) !== frame) fail('E_TARGET_NOT_FOUND');
    if (this.now() >= frame.expires_ms) { this.remove(frame); fail('E_TARGET_NOT_FOUND'); }
    const metadata: VisualMetadata = {
      ok: true,
      session_id: frame.session_id,
      target_id: frame.target_id,
      revision: frame.revision,
      frame_id,
      captured_at: frame.captured_at,
      expires_at: frame.expires_at,
      media_type: 'image/png',
      coordinate_space: frame.coordinate_space,
      ...(frame.source_to_desktop?{source_to_desktop:{...frame.source_to_desktop}}:{}),
      ...(frame.surface_epoch?{surface_epoch:frame.surface_epoch}:{}),
      ...(frame.input_token?{input_token:frame.input_token}:{}),
      viewport: {...frame.viewport},
      source: {width: frame.width, height: frame.height},
      region: {...source},
      output: {
        width: out_width,
        height: out_height,
        source_pixels_per_output_x: source.width / out_width,
        source_pixels_per_output_y: source.height / out_height,
      },
      redacted: frame.redacted,
      ...(frame.redaction?{redaction:structuredClone(frame.redaction)}:{}),
      estimated_patch_tokens: Math.ceil(out_width / 32) * Math.ceil(out_height / 32),
      token_estimate_basis: '32px_grid_not_model_billing',
    };
    return {metadata, png};
    }finally{this.pending.delete(operation);}
  }

  dropSession(session_id: string): void {
    for(const operation of this.pending)if(operation.session_id===session_id)operation.cancelled=true;
    for (const frame of [...this.frames.values()]) {
      if (frame.session_id === session_id) this.remove(frame);
    }
  }

  /** Validate references without decoding another image; gesture freshness uses local monotonic retention age. */
  assertRetained(session_id:string,frame_id:string,maxAge?:number):void{
    const frame=this.frames.get(frame_id);if(!frame||frame.session_id!==session_id||this.now()>=frame.expires_ms)fail('E_TARGET_NOT_FOUND');
    if(maxAge!==undefined&&this.now()-frame.retained_at>maxAge)fail('E_STALE_STATE');
  }

  discard(session_id:string,frame_id:string):void{const frame=this.frames.get(frame_id);if(frame?.session_id===session_id)this.remove(frame);}

  clear(): void {
    for(const operation of this.pending)operation.cancelled=true;
    this.frames.clear();
    this.total_bytes = 0;
  }

  /** Called by Engine maintenance even when no further image requests arrive. */
  prune():void{
    const now=this.now();for(const frame of this.frames.values())if(now>=frame.expires_ms)this.remove(frame);
  }

  private checkActive(signal?: AbortSignal): void {
    if (signal?.aborted) fail('E_CANCELLED');
  }

  private checkOperation(operation:{cancelled:boolean},signal?:AbortSignal):void{
    this.checkActive(signal);if(operation.cancelled)fail('E_CANCELLED');
  }

  private validateImage(image: CapturedImage): void {
    if (image === null || typeof image !== 'object') fail('E_INVALID_ARGUMENT');
    if (!Buffer.isBuffer(image.png) || image.png.length === 0) fail('E_INVALID_ARGUMENT');
    if (!['viewport_css_pixels','window_pixels'].includes(image.coordinate_space)) fail('E_INVALID_ARGUMENT');
    if(image.surface_epoch!==undefined&&(!isStr(image.surface_epoch)||image.surface_epoch.length>256))fail('E_INVALID_ARGUMENT');
    if(image.input_token!==undefined&&(!isStr(image.input_token)||image.input_token.length>128))fail('E_INVALID_ARGUMENT');
    const t=image.source_to_desktop;
    if(image.coordinate_space==='window_pixels'&&!t)fail('E_INVALID_ARGUMENT');
    if(t&&(!isNum(t.origin_x)||!isNum(t.origin_y)||!isNum(t.scale_x)||!isNum(t.scale_y)||t.scale_x<=0||t.scale_y<=0||!['desktop_points_top_left','desktop_physical_pixels'].includes(t.coordinate_space)))fail('E_INVALID_ARGUMENT');
    if (image.redacted !== true && image.redacted !== false) fail('E_INVALID_ARGUMENT');
    const redaction=image.redaction;
    if(redaction!==undefined){
      const methods=new Set(['controls','frames','sensitive_labels','text_patterns','configured_selectors','native_controls','configured_regions']);
      if(!redaction||typeof redaction!=='object'||Object.keys(redaction).some(key=>!['scope','methods','complete'].includes(key))||!['detected_regions','configured_regions','unredacted'].includes(redaction.scope)||redaction.complete!==false||!Array.isArray(redaction.methods)||redaction.methods.length>8||redaction.methods.some(method=>!methods.has(method)))fail('E_INVALID_ARGUMENT');
    }
    if (!isStr(image.captured_at) || Number.isNaN(Date.parse(image.captured_at))) fail('E_INVALID_ARGUMENT');
    const vp = image.viewport;
    if (vp === null || typeof vp !== 'object') fail('E_INVALID_ARGUMENT');
    if (!isInt(vp.width) || !isInt(vp.height) || vp.width < 1 || vp.height < 1) fail('E_INVALID_ARGUMENT');
    if (vp.width > MAX_DIMENSION || vp.height > MAX_DIMENSION || vp.width*vp.height>MAX_SOURCE_PIXELS) fail('E_RESOURCE_LIMIT');
    if (!isNum(vp.scroll_x) || !isNum(vp.scroll_y)) fail('E_INVALID_ARGUMENT');
    if (!isNum(vp.device_scale_factor) || vp.device_scale_factor <= 0) fail('E_INVALID_ARGUMENT');
  }

  private remove(frame: Frame): void {
    this.frames.delete(frame.id);
    this.total_bytes -= frame.bytes;
  }

  private evict(incoming_bytes: number): void {
    const now = this.now();
    for (const frame of [...this.frames.values()]) {
      if (now >= frame.expires_ms) this.remove(frame);
    }
    while (this.frames.size + 1 > this.max_frames) {
      const oldest = this.frames.keys().next();
      if (oldest.done) break;
      this.remove(this.frames.get(oldest.value)!);
    }
    while (this.total_bytes + incoming_bytes > this.max_bytes) {
      const oldest = this.frames.keys().next();
      if (oldest.done) break;
      this.remove(this.frames.get(oldest.value)!);
    }
  }
}
