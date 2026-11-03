import type { EffectiveFeatures } from '../../../shared/features';

/**
 * What Codex does (B16 C1): appends an agent's role on every launch, while a resumed thread keeps
 * the developer instructions it started with (openai/codex#19045); continues a remembered thread;
 * lists none for /resume. Its descriptor declares these, and both its connections report them
 * with `started`.
 */
export const CODEX_FEATURES = {
  role: 'append-new',
  resume: true,
  list: false,
} as const satisfies EffectiveFeatures;
