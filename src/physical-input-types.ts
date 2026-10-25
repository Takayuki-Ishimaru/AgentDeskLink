import type {ImageRegion,VisualObservation} from './visual-types.js';
import type {GestureKind} from './gesture-types.js';

export type NativeGestureBackend='mouse_drag'|'scroll_swipe'|'touch_swipe';
export interface InteractivePolicy {
  enabled:boolean;
  surfaces:{id:string;region:ImageRegion;kinds:GestureKind[];swipe_backend?:'scroll'|'touch'}[];
}
export interface ExpectedTarget {role?:string;name?:string}
export interface PrepareInput {
  action:'click'|'fill';point:{x:number;y:number};expected_target?:ExpectedTarget;
}
export interface PrepareInputRequest extends PrepareInput {frame_id:string;expected_revision:number;include_image?:boolean}
export interface PreparedInput {
  confirmation_id:string;expires_in_ms:number;action:'click'|'fill';
  target:{role:string;name:string;enabled:boolean;focused:boolean;editable:boolean;selection?:{start:number;length:number}};
  pointer_on_target:true;focus_matches_target:boolean;
}
export interface PreparedObservation {metadata:PreparedInput&{ok:true;session_id:string;revision:number};image?:VisualObservation}
export interface InputExecution {released_input:true;verified:'input_sequence_completed';action:'click'|'fill'}
export interface CommitInputRequest {confirmation_id:string;value?:string}
