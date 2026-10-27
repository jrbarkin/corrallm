import { z } from 'zod';
import { FallbackInputSchema, HandoffInputSchema } from '../model/fallback';
import { AgentId, OpCanvas } from './ids';

/** B11a inputs: agent.setFallback's (registered, C2) and agent.setHandoff's (C3's, unregistered). */
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
