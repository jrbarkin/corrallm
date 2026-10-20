import type { EffortChoice } from '../../../shared/session';

/** Codex's reasoning efforts, as its model picker names them. */
const NAMES: Readonly<Record<string, string>> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

/** An effort the app server offers, with its description and Codex's label. */
export function effortChoice(value: string, description?: string): EffortChoice {
  return {
    value,
    label: (Object.hasOwn(NAMES, value) ? NAMES[value] : undefined) ?? value,
    ...(description === undefined ? {} : { description }),
  };
}
