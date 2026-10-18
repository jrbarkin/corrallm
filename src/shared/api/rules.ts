import type { Rule } from './surface';

/*
 * The rules that narrow what a token may do (Core Server §3.6), one row per rule key an operation
 * carries: each lands with the first operation it guards. A rule applies to the same operation on
 * both surfaces; you are never refused by one. Argument rules are checked in core.call before the
 * op runs, change rules on the change itself at commit, whatever op made it. A met rule refuses a
 * token, except R4 and R5 (`discard`, `restore-code`), which make its call a proposal for you.
 */

export interface RuleRow {
  /** Where it is checked: on the arguments, on the change at commit, or both. */
  kind: 'argument' | 'change' | 'argument+change';
  /** What it keeps tokens from, in one sentence: what a refused token is told. */
  sentence: string;
}

/** Each rule key some operation carries. */
export const RULES = {
  'shell-text': {
    kind: 'argument',
    sentence:
      'Only you may send an agent text its connection runs as a shell command (its shell prefix).',
  },
  sticky: {
    kind: 'argument',
    sentence:
      'A token releases only the pauses its own party set; yours stay until you release them.',
  },
} as const satisfies Partial<Record<Rule, RuleRow>>;
