import type { EffortChoice } from '../../../shared/session';

/** Claude Code's /effort levels, with its own picker words. */
export const CLAUDE_EFFORTS: Readonly<Record<string, { label: string; description: string }>> = {
  low: { label: 'Low', description: 'Quick, straightforward implementation' },
  medium: { label: 'Medium', description: 'Balanced approach with standard testing' },
  high: { label: 'High', description: 'Comprehensive implementation with extensive testing' },
  xhigh: { label: 'Extra high', description: 'Extended reasoning with thorough analysis' },
  max: {
    label: 'Max',
    description: 'Maximum capability with deepest reasoning (this session only)',
  },
};

/** An effort as Claude Code names it; an unknown level keeps its native name. */
export function effortChoice(value: string): EffortChoice {
  return {
    value,
    ...((Object.hasOwn(CLAUDE_EFFORTS, value) ? CLAUDE_EFFORTS[value] : undefined) ?? {
      label: value,
    }),
  };
}
