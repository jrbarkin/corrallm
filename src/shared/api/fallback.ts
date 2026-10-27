import { z } from 'zod';
import { FallbackInputSchema, HandoffInputSchema } from '../model/fallback';
import { AgentId, OpCanvas } from './ids';

/** Prepared B11a inputs only; no operation, authority rule or runtime service is registered. */
export const SetFallbackInput = z.strictObject({
  canvas: OpCanvas,
  agent: AgentId,
  fallback: FallbackInputSchema.nullable(),
});
export type SetFallbackInput = z.infer<typeof SetFallbackInput>;
export const SetHandoffInput = z.strictObject({
  canvas: OpCanvas,
  agent: AgentId,
  handoff: HandoffInputSchema.nullable(),
});
export type SetHandoffInput = z.infer<typeof SetHandoffInput>;
