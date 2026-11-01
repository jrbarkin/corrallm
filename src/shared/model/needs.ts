import type { CanvasId } from '../canvas';
import type { JsonSchema } from '../session';
import type { PartyId } from './messages';
import type { Choice, PromptNeedView } from './prompts';

/*
 * What waits for someone (API Spec §5.9): one shape for a hold the run has for you, a prompt an
 * agent's session shows, a token's proposal and a canvas file changed on disk (the core's: B9), and,
 * in a later phase, a message to you. The engine words holds and prompts once
 * (src/shared/model/needs-selectors.ts), in the host's locale, and the core its proposals and file reviews
 * (core/canvas/proposals.ts, reviews.ts), so the GUI and every party read the same sentences.
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process.
 */

/**
 * hold: a hold the run has for you (an OK, a usage ask, a problem decision, a condition's yes or
 * no, a session that would not start). prompt: what an agent's session asks (a permission, its
 * questions, a plan, an MCP server's request), what a Terminal agent's CLI asks in its terminal,
 * or the core's warning of a stalled turn (Interrupt, only by you).
 * proposal: a token's delete or discard. file: a canvas file changed on disk, which you apply or
 * keep corrallm's canvas over. worktree: a workspace's setup (B9a), which only you run, skip or
 * stop; it names no agent, so no token's view of Needs holds it. message: a message to you (a
 * later phase).
 */
export const NEED_KINDS = ['hold', 'prompt', 'message', 'proposal', 'file', 'worktree'] as const;
export type NeedKind = (typeof NEED_KINDS)[number];

/**
 * A question a prompt asks: its answers by label (each with a preview, where its CLI shows one),
 * whether several or one of its own may be given, and whether its answer is secret (B13 C1).
 */
export interface NeedQuestion {
  id: string;
  header: string;
  text: string;
  options: { label: string; description?: string; preview?: string }[];
  multiple: boolean;
  other: boolean;
  secret?: boolean;
}

/**
 * One way to answer: `value` is what an answer names, `humanOnly` why only you may pick it. A
 * prompt's choice says what its CLI does with it (B13 C1, C4): its hint, its effects (absent where
 * its adapter can't tell), whether it takes words, and whether it ends the turn.
 */
export interface NeedChoice {
  value: string;
  label: string;
  /** What it means, when that needs saying. */
  description?: string;
  humanOnly?: string;
  hint?: Choice['hint'];
  effects?: Choice['effects'];
  feedback?: Choice['feedback'];
  endsTurn?: boolean;
}

/**
 * Something that waits for someone. `for`: whom it is addressed to; `by`: who may answer it now.
 * `choices` are in order, the one most expected first; `text`, an answer in one's own words.
 * `until`: a deadline or a reset (epoch ms), for a live countdown. `answerIn`: where it is answered
 * (a Terminal agent's CLI is answered in its terminal).
 */
export interface NeedsItem {
  id: string;
  canvas: CanvasId;
  /** Absent for what concerns the whole canvas. */
  agent?: string;
  kind: NeedKind;
  for: PartyId;
  by: PartyId[];
  title: string;
  detail?: string;
  until?: number;
  choices: NeedChoice[];
  text?: { placeholder: string };
  questions?: NeedQuestion[];
  form?: { schema: JsonSchema } | { url: string };
  answerIn: 'api' | 'terminal' | 'both';
  /**
   * A prompt the core's prompt owner holds, beyond the generic fields (B13 C1): its PromptId, kind,
   * when it was raised, its words, its subject, a plan's first lines, whether it was cut, and why
   * only you may answer it; as each reader may see it (C11: shared/model/prompt-views.ts).
   */
  prompt?: PromptNeedView;
}
