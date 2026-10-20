import type { Rule } from './surface';

/*
 * The rules that narrow what a token may do (Core Server §3.6), one row per rule key an operation
 * carries: each lands with the first operation it guards. A rule applies to the same operation on
 * both surfaces; you are never refused by one. Argument rules are checked in core.call before the
 * op runs, change rules on the change itself at commit, whatever op made it: an op carries a change
 * rule where a call of its alone can meet it, and every commit of a token's is checked against
 * every change rule. A met rule refuses a token, except R4 and R5 (`discard`, `restore-code`),
 * which make its call a proposal for you.
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
  // R2: on agent.setSettings's arguments, and on every change.
  'mode-permits': {
    kind: 'argument+change',
    sentence:
      'Only you change the mode an agent that exists starts in: a token leaves it out, or passes the saved one.',
  },
  // R6: its declared half is each op's `self`, checked in core.call.
  self: {
    kind: 'change',
    sentence:
      'An agent never changes its own role, settings, adapter, connection or manager, nor removes itself.',
  },
  // R8: the guard behind agent.setType and agent.setConnection being yours alone.
  connection: {
    kind: 'change',
    sentence: 'Only you change the adapter or the connection of an agent that exists.',
  },
  // R12.
  role: {
    kind: 'change',
    sentence:
      'Only you change the role of an agent that exists: a token gives a role only to an agent it creates in the same change.',
  },
  // R13.
  links: {
    kind: 'change',
    sentence:
      'Only you link or unlink agents that both exist: a token links only an agent it creates.',
  },
  // R14, B9 Design §4 (revision R34: never change managers; §12): frames are free.
  managers: {
    kind: 'change',
    sentence: 'Only you change who manages an agent that exists: the agent it is nested in.',
  },
  sticky: {
    kind: 'argument',
    sentence:
      'A token releases only the pauses its own party set; yours stay until you release them.',
  },
} as const satisfies Partial<Record<Rule, RuleRow>>;
