import type { EffectiveFeatures } from '../../../shared/features';

/**
 * What Claude Code does (B16 C1): appends an agent's role on every launch (`--append-system-prompt`,
 * the Agent SDK's preset), continues a remembered conversation and lists its folder's. Its
 * descriptor declares these, and both its connections report them with `started`.
 */
export const CLAUDE_FEATURES = {
  role: 'append',
  resume: true,
  list: true,
} as const satisfies EffectiveFeatures;
