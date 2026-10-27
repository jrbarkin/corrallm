import type { ModeDescriptor } from '../../../shared/adapter';
import type { AdapterPrompt, Choice, CoreChoice } from '../../../shared/model/prompts';

/*
 * B13 C4's classifier (Core Server R3, B13 Design §2.5, §9.2 C4): which prompts, and which of their
 * choices, only you may answer. One pure function over the adapter's structured facts (a prompt's
 * kind, subject type, secret questions, native signals; a choice's hint and declared effects), the
 * catalog's modes and the generation's effective start mode. It never reads a title, a label, a
 * reason or any other words a prompt carries, which are the agent's or a server's: no text marks a
 * prompt anyone's to answer.
 *
 * - A whole prompt is yours: a trust or consent subject, any secret question, every form (a link's
 *   too), and any native ask-rule, safety-check or requires-a-person signal.
 * - A choice is yours: every `allow_always` and `reject_always`; effects unknown (absent) on any
 *   choice but a `reject_once`; any rules effect (each is scoped to a session, a project or the
 *   user); a network effect beyond this turn; any directories effect; a mode that never asks, ranks
 *   above the mode the session started in, or isn't one its adapter lists; and any mode at all
 *   while that start mode is unknown.
 *
 * Not yours is not anyone else's: until B24's grants every native prompt is yours alone (`by`),
 * whatever this says. What it marks is what B24 may never grant.
 */

/** Why only you may answer, in the core's words. */
export const YOURS = {
  trust: 'Only you decide whether to trust a folder.',
  consent: 'Only you give consent.',
  secret: 'Only you answer a secret question.',
  form: 'Only you fill in a form or open its link.',
  askRule: 'Only you answer what one of its CLI’s ask rules asks.',
  safetyCheck: 'Only you approve what its CLI’s safety check stopped.',
  requiresUser: 'Its CLI says only a person may answer this.',
  always: 'Only you decide for more than this one request.',
  unknown: 'Only you choose this: corrallm can’t tell all it would do.',
  rules: 'Only you change the rules its CLI keeps.',
  network: 'Only you open or close network access beyond this turn.',
  directories: 'Only you let it work in another folder.',
  neverAsks: 'Only you let it run in a mode that never asks.',
  asksLess: 'Only you let it ask less than it started to.',
  unknownMode: 'Only you change its mode: corrallm doesn’t know the mode its session started in.',
  unlistedMode: 'Only you switch it to a mode corrallm doesn’t know.',
} as const;

/** What the classifier reads besides the prompt's structure. */
export interface ClassifyFacts {
  /** The modes of the adapter whose session raised it, as the catalog classifies them. */
  modes: readonly ModeDescriptor[];
  /**
   * The mode the generation reported in its first `started`, captured once: none (null, or not
   * reported yet) or one its adapter doesn't list is unknown.
   */
  startMode: string | null | undefined;
}

/** What the core adds to a prompt: why only you may answer it, and each choice's reason. */
export interface Classified {
  humanOnly?: string;
  /** For an approval or a plan: its choices as offered, each marked where only you may pick it. */
  choices?: CoreChoice[];
}

export function classify(prompt: AdapterPrompt, facts: ClassifyFacts): Classified {
  const humanOnly = wholeReason(prompt);
  const whole = humanOnly === undefined ? {} : { humanOnly };
  if (prompt.kind !== 'approval' && prompt.kind !== 'plan') return whole;
  return {
    ...whole,
    choices: prompt.choices.map((choice): CoreChoice => {
      const reason = choiceReason(choice, facts);
      return reason === undefined ? { ...choice } : { ...choice, humanOnly: reason };
    }),
  };
}

/** Why only you may answer the whole prompt, if only you may. */
function wholeReason(prompt: AdapterPrompt): string | undefined {
  if (prompt.kind === 'approval') {
    if (prompt.subject?.type === 'trust') return YOURS.trust;
    if (prompt.subject?.type === 'consent') return YOURS.consent;
  }
  if (prompt.kind === 'form') return YOURS.form;
  if (prompt.kind === 'question' && prompt.questions.some((question) => question.secret === true))
    return YOURS.secret;
  const { signals } = prompt;
  if (signals?.askRule === true) return YOURS.askRule;
  if (signals?.safetyCheck === true) return YOURS.safetyCheck;
  if (signals?.requiresUser === true) return YOURS.requiresUser;
  return undefined;
}

/** Why only you may pick `choice`, if only you may. */
function choiceReason(choice: Choice, { modes, startMode }: ClassifyFacts): string | undefined {
  if (choice.hint === 'allow_always' || choice.hint === 'reject_always') return YOURS.always;
  const { effects } = choice;
  if (effects === undefined) return choice.hint === 'reject_once' ? undefined : YOURS.unknown;
  if (effects.rules !== undefined && effects.rules.length > 0) return YOURS.rules;
  if (effects.network !== undefined && effects.network.scope !== 'turn') return YOURS.network;
  if (effects.directories !== undefined && effects.directories.length > 0) return YOURS.directories;
  if (effects.mode !== undefined) {
    const target = modes.find(({ id }) => id === effects.mode);
    if (target === undefined) return YOURS.unlistedMode;
    if (!target.asks) return YOURS.neverAsks;
    const start = modes.find(({ id }) => id === startMode);
    if (start === undefined) return YOURS.unknownMode;
    if (target.rank > start.rank) return YOURS.asksLess;
  }
  return undefined;
}
