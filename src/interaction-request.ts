import {z} from 'zod';

export const gestureRequestSchema=z.object({
  frame_id:z.string().min(1).max(100),expected_revision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  surface_id:z.string().min(1).max(100),kind:z.enum(['drag','swipe']),
  swipe_backend:z.enum(['scroll','touch']).optional(),
  points:z.array(z.object({x:z.number().finite().min(0).max(4096),y:z.number().finite().min(0).max(4096),t_ms:z.number().int().min(0).max(5000)}).strict()).min(2).max(64),
}).strict().refine(v=>v.points[0]!.t_ms===0&&v.points.slice(1).every((p,i)=>p.t_ms>v.points[i]!.t_ms));

export const expectedTargetSchema=z.object({role:z.string().min(1).max(100).optional(),name:z.string().min(1).max(512).optional()}).strict().refine(v=>!!(v.role||v.name));
export const prepareInputSchema=z.object({
  frame_id:z.string().min(1).max(100),expected_revision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  action:z.enum(['click','fill']),point:z.object({x:z.number().finite().min(0).max(4096),y:z.number().finite().min(0).max(4096)}).strict(),
  expected_target:expectedTargetSchema.optional(),include_image:z.boolean().optional(),
}).strict();
export const commitInputSchema=z.object({confirmation_id:z.string().min(1).max(128),value:z.string().max(4096).optional()}).strict();

export const sequenceRequestSchema=z.object({
  frame_count:z.number().int().min(2).max(16).optional(),interval_ms:z.number().int().min(50).max(2000).optional(),
  max_dimension:z.number().int().min(64).max(1024).optional(),max_pixels:z.number().int().min(4096).max(1048576).optional(),
}).strict().refine(v=>((v.frame_count??8)-1)*(v.interval_ms??250)<=6000);
