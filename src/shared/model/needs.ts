import type { CanvasId } from '../canvas';
import type { JsonSchema } from '../session';
import type { PartyId } from './messages';

/*
 * What waits for someone (API Spec §5.9): one shape for a hold the run has for you, a prompt an
 * agent's session shows, and, in later phases, a message to you, a token's proposal and a canvas
 * file changed on disk. The engine words each once (src/shared/engine/needs.ts), in the host's
 * locale, so the GUI and every party read the same sentences.
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process.
 */

/**
 * hold: a hold the run has for you (an OK, a usage ask, a problem decision, a condition's yes or
 * no, a session that would not start). prompt: what an agent's session asks (a permission, its
 * questions, a plan, an MCP server's request), or what a Terminal agent's CLI asks in its terminal.
 * message, proposal, file: a message to you, a token's delete or discard, a canvas file changed on
 * disk (later phases).
 */
export const NEED_KINDS = ['hold', 'prompt', 'message', 'proposal', 'file'] as const;
export type NeedKind = (typeof NEED_KINDS)[number];

/** A question a prompt asks: its answers by label, and whether several or one of its own may be given. */
export interface NeedQuestion {
  id: string;
  header: string;
  text: string;
  options: { label: string; description?: string }[];
  multiple: boolean;
  other: boolean;
}

/** One way to answer: `value` is what an answer names, `humanOnly` why only you may pick it. */
export interface NeedChoice {
  value: string;
  label: string;
  /** What it means, when that needs saying. */
  description?: string;
  humanOnly?: string;
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
}
