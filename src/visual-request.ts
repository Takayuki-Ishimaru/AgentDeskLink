import { z } from 'zod';
/** Shared MCP/direct-call validation; a crop always refers to an immutable source frame. */
export const visualRequestSchema = z
  .object({
    frame_id: z.string().min(1).max(100).optional(),
    region: z
      .object({
        x: z.number().int().min(0).max(4096),
        y: z.number().int().min(0).max(4096),
        width: z.number().int().min(1).max(4096),
        height: z.number().int().min(1).max(4096),
      })
      .strict()
      .optional(),
    max_dimension: z.number().int().min(64).max(2048).optional(),
    max_pixels: z.number().int().min(4096).max(4194304).optional(),
  })
  .strict()
  .refine(value => !value.region || !!value.frame_id);
