import { MAX_CREATED_AGENTS } from './limits';
import type { Rule } from './surface';

/*
 * The rules that narrow what a token may do (Core Server §3.6), one row per rule key an operation
 * carries: each lands with the first operation it guards. A rule applies to the same operation on
 * both surfaces; you are never refused by one but workspace-safety (below). Argument rules are checked in core.call before the
 * op runs, change rules on the change itself at commit, whatever op made it: an op carries a change
 * rule where a call of its alone can meet it, and every commit of a token's is checked against
 * every change rule. A met rule refuses a token, except R4 and R5 (`discard`, `restore-code`),
 * which make its call a proposal for you, and `workspace-safety`, which makes anyone's change a
 * proposal for you, yours too (and is checked on every commit, not only a token's): an op that
 * can't come to you as a proposal is refused it rather than apply it, yours too.
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
  // B11 §16.6 (Q-B11-1): your composer keeps its 200,000 characters and its pasted images; what
  // anyone else sends stays at most 16 KiB of text (MAX_MESSAGE_BYTES), refused, never cut.
  'human-text': {
    kind: 'argument',
    sentence:
      'Only you send an agent more than 16 KB of text, or images: a message from an agent or an outside caller is at most 16 KB of text.',
  },
  'corral-mcp': {
    kind: 'argument',
    sentence:
      'Only you change corrallm’s own MCP server entry: a token may never disconnect an agent from corrallm.',
  },
  // R2: on agent.setSettings's arguments, and on every change.
  'mode-permits': {
    kind: 'argument+change',
    sentence:
      'Only you change the mode an agent that exists starts in: a token leaves it out, or passes the saved one.',
  },
  // R3: as `reply` arrives, the caller must be one the item names to answer it (its `by`), and
  // may pick no choice marked `humanOnly` (a proposal's, a file review's: yours alone); and only
  // you go on past a usage rule's hold (run.goOn).
  'human-choice': {
    kind: 'argument',
    sentence:
      'Only you answer what only you may decide: a choice marked human-only, or Go on past a usage rule.',
  },
  // R4: a token's commit that removes an agent becomes a proposal for you, unless another rule
  // refuses it; and so do, on their arguments, canvas.close and canvas.create's `replace` that
  // would discard edits not saved, or close a canvas a window shows, and a canvas.save that would
  // remove agents its file on disk has.
  discard: {
    kind: 'argument+change',
    sentence:
      'Only you delete an agent or discard work: a token’s call comes to you as a proposal, which you allow or refuse.',
  },
  'restore-code': {
    kind: 'argument',
    sentence:
      'Only you restore an agent’s files to how they were: a token’s code rewind comes to you as a proposal, applied only if nothing it would restore changed since.',
  },
  // R6: its declared half is each op's `self`, checked in core.call.
  self: {
    kind: 'change',
    sentence:
      'An agent never changes its own role, settings, adapter, connection or manager, nor removes itself.',
  },
  // R7, as strict as revision R34 (B9 Design §12): any OK, held or not.
  'human-gate': {
    kind: 'change',
    sentence:
      'Only you remove, move or change an OK or what the run holds for you, move work from behind an OK to before it, or delete an agent whose queue holds one.',
  },
  // R8: the guard behind agent.setType and agent.setConnection being yours alone.
  connection: {
    kind: 'change',
    sentence: 'Only you change the adapter or the connection of an agent that exists.',
  },
  // R11: a party's cap counts the live agents it created, whichever token it called with.
  'new-agent': {
    kind: 'change',
    sentence: `A token’s new agent runs on its adapter’s first connection with no startup mode, unless it copies the agent it was spawned from; and a token’s party keeps at most ${String(MAX_CREATED_AGENTS)} live agents it created.`,
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
  // B9a §7: whatever op builds a change (a single op, a batch, a file's Apply, a revert), whoever
  // makes it, no tree holding work is left with no agent unless you confirm it (a proposal for
  // you, yours too; a file's Apply or a revert keeps it instead), no agent working in a tree is
  // moved to another but by your Switch, and no change of the document runs or approves a setup.
  'workspace-safety': {
    kind: 'change',
    sentence:
      'Only you decide what becomes of a worktree’s work: a change leaving a worktree that holds work with no agent waits for you to confirm it, an agent working in one moves to another only when you switch it, and no change runs or approves a setup.',
  },
  // R9: a token's run.unpause, run.resume and run.start never undo another party's pause, stop
  // or decision.
  sticky: {
    kind: 'argument',
    sentence:
      'A token releases only the pauses and stops its own party set, and never starts the run afresh past your decisions; yours stay until you release them.',
  },
} as const satisfies Partial<Record<Rule, RuleRow>>;
