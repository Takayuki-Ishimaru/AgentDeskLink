import type {CapturedImage} from './visual-types.js';
export type GestureKind='drag'|'swipe';
export interface GesturePolicy {enabled:boolean;surfaces:{id:string;selector:string;kinds:GestureKind[]}[]}
export interface GesturePoint {x:number;y:number;t_ms:number}
export interface GesturePlan {surface_id:string;kind:GestureKind;points:GesturePoint[];swipe_backend?:'scroll'|'touch'}
export interface GestureRequest extends GesturePlan {frame_id:string;expected_revision:number}
export type GestureReference=Pick<CapturedImage,'coordinate_space'|'viewport'|'surface_epoch'|'source_to_desktop'|'input_token'>;
export interface GestureExecution {released_input:true;kind:GestureKind;points_executed:number;verified:'input_sequence_completed';input_backend?:'mouse_drag'|'scroll_swipe'|'touch_swipe'}
