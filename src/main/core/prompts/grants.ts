import type { LeadGrants } from '../../../shared/api/ops/leads';
import type { Prompt } from '../../../shared/model/prompts';

/*
 * B24 C4's one allowance: what a party other than you may answer of a native prompt. A pure
 * function of the prompt as the owner classified it, whether its connection reports why only a
 * person may answer (`signals`, the descriptor's), and who answers. Every boundary asks it, none
 * re-derives it: the Needs selector (what a party sees to pick), R3 (rules.ts), the reply router
 * and the prompt owner, which asks it again after its record is on disk.
 *
 * - You: everything the prompt takes (the classifier marks nothing against you).
 * - A routed lead: the kinds its grants name. Choices that are `allow_once` or `reject_once` and not
 *   marked human-only (by the classifier: trust, consent, secrets, forms, signals, always, unknown
 *   effects, rules, network beyond the turn, directories, modes that ask less), taking no required
 *   feedback, and none of the words a choice might take: no feedback, no own-words answer, no
 *   form. A question is answered by the labels it offers. Where its connection reports no
 *   signals, only a rejection, and no question answer; and the core's Hand back, where anything
 *   is its to answer.
 * - An outside grantee (Q3): approvals only, once, as a lead's, with no Hand back: it can simply
 *   not answer.
 * - Nobody else.
 */

/** The core's own choice a routed lead may pick: it settles nothing and moves the route up. */
export const HAND_BACK = 'hand-back';

/** Who answers, as the allowance reads them. */
export type Answerer = { kind: 'you' } | { kind: 'lead'; grants: LeadGrants } | { kind: 'outside' };

/** What an answerer may answer of one prompt. */
export interface Allowance {
  /** The values of the prompt's choices it may pick (an approval's or a plan's). */
  readonly choices: readonly string[];
  /** Whether it may answer a question by its offered labels. */
  readonly answers: boolean;
  /** Whether it may hand the prompt back. */
  readonly handBack: boolean;
  /** Whether `answer`, as `reply` takes it, is one it may give. */
  allows(answer: unknown): boolean;
}

const YOURS: Allowance = {
  choices: [],
  answers: true,
  handBack: false,
  allows: () => true,
};

const NONE: Allowance = {
  choices: [],
  answers: false,
  handBack: false,
  allows: () => false,
};

/** What `answerer` may answer of `prompt` on a connection that reports `signals` or not. */
export function allowance(prompt: Prompt, signals: boolean, answerer: Answerer): Allowance {
  if (answerer.kind === 'you') return YOURS;
  if (prompt.answerIn === 'terminal') return NONE;
  const granted =
    answerer.kind === 'outside'
      ? prompt.kind === 'approval'
      : (prompt.kind === 'approval' && answerer.grants.approvals) ||
        (prompt.kind === 'plan' && answerer.grants.plans) ||
        (prompt.kind === 'question' && answerer.grants.questions);
  if (!granted) return NONE;
  const choices =
    prompt.kind === 'approval' || prompt.kind === 'plan'
      ? prompt.choices
          .filter((choice) => {
            if (choice.value === HAND_BACK) return false;
            if ((choice.humanOnly ?? prompt.humanOnly) !== undefined) return false;
            if (choice.feedback === 'required') return false;
            return signals
              ? choice.hint === 'allow_once' || choice.hint === 'reject_once'
              : choice.hint === 'reject_once';
          })
          .map(({ value }) => value)
      : [];
  const answers =
    prompt.kind === 'question' &&
    signals &&
    prompt.humanOnly === undefined &&
    prompt.questions.every((question) => question.secret !== true);
  // Hand back is the lead's to give wherever its kind is granted and the prompt isn't yours whole;
  // whether it is routed at all asks for something it could answer (`answerable`).
  const handBack = answerer.kind === 'lead' && prompt.humanOnly === undefined;
  return {
    choices,
    answers,
    handBack,
    allows: (answer) => {
      if (!isRecord(answer)) return false;
      const keys = Object.keys(answer);
      if (keys.length === 1 && 'choice' in answer) {
        return (
          typeof answer.choice === 'string' &&
          ((handBack && answer.choice === HAND_BACK) || choices.includes(answer.choice))
        );
      }
      if (keys.length === 1 && 'answers' in answer) {
        return (
          answers &&
          isRecord(answer.answers) &&
          Object.values(answer.answers).every(
            (one) => isRecord(one) && Object.keys(one).length === 1 && 'picked' in one,
          )
        );
      }
      return false;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Whether `may` gives its party anything to answer: what a route to it needs. */
export function answerable(may: Allowance): boolean {
  return may.choices.length > 0 || may.answers;
}
