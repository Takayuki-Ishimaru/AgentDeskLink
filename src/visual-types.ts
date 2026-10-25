/** Base64 plus metadata stays below the MCP SDK's default 10 MiB stdio message limit. */
export const MAX_VISUAL_OUTPUT_BYTES=6*1024*1024;
/** Visual frames have their own identity: a semantic revision does not describe pixels. */
export interface ImageRegion { x: number; y: number; width: number; height: number }
export interface VisualPolicy { enabled: boolean; maskSelectors: string[] }
/** allowUnredacted is required for macOS capture-only targets, which cannot use AX control masks. */
export interface DesktopVisualPolicy { enabled:boolean; allowUnredacted:boolean; maskRegions:ImageRegion[] }
export interface DesktopTransform {origin_x:number;origin_y:number;scale_x:number;scale_y:number;coordinate_space:'desktop_points_top_left'|'desktop_physical_pixels'}
export interface CapturedImage {
  png: Buffer;
  captured_at: string;
  coordinate_space: 'viewport_css_pixels'|'window_pixels';
  source_to_desktop?:DesktopTransform;
  surface_epoch?:string;
  input_token?:string;
  viewport: { width: number; height: number; scroll_x: number; scroll_y: number; device_scale_factor: number };
  redacted: boolean;
}
export interface VisualViewOptions {
  /** Coordinates refer to the retained source frame, before any overview resizing. */
  region?: ImageRegion;
  max_dimension?: number;
  max_pixels?: number;
}
export interface VisualRequest extends VisualViewOptions { frame_id?: string }
export interface VisualOwner { session_id: string; target_id: string; revision: number }
export interface VisualMetadata extends VisualOwner {
  ok: true;
  frame_id: string;
  captured_at: string;
  expires_at: string;
  media_type: 'image/png';
  coordinate_space: 'viewport_css_pixels'|'window_pixels';
  source_to_desktop?:DesktopTransform;
  surface_epoch?:string;
  input_token?:string;
  viewport: CapturedImage['viewport'];
  source: { width: number; height: number };
  region: ImageRegion;
  output: { width: number; height: number; source_pixels_per_output_x: number; source_pixels_per_output_y: number };
  redacted: boolean;
  /** Geometry estimate only, never a model's billed token count. */
  estimated_patch_tokens: number;
  token_estimate_basis: '32px_grid_not_model_billing';
}
export interface VisualObservation { metadata: VisualMetadata; png: Buffer }
