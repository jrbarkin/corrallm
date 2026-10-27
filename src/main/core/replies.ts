import type { z } from 'zod';

import type { ReplyAnswer } from '../../shared/api/ops/conversation';
import type { CanvasId } from '../../shared/canvas';
import type { NeedsItem } from '../../shared/model/needs';
import { andList } from '../../shared/model/words';
import { OpFailure } from './call';
import type { OpContext } from './call';
import { partyIdOf } from './caller';
import { partyText } from './parties';

/*
 * The reply router (B11 Design §7, §15's "Reply / shared-tree effects"; B9a Design §7, §13): one
 * path for every answer to what waits on a canvas, whatever it is. It finds the item an answer
 * names as it waits now, then validates, in this order, before anything acts:
 *
 * 1. It waits now, at the generation its id names: a hold or a prompt asked again since (a reused
 *    textual id), a setup card raised anew, a workspace change planned again, is a conflict; one
 *    settled is a conflict naming who settled it (the who-decided record: decisions.ts); one a
 *    pause holds is refused, saying whose pause (R9: a reply never releases a pause).
 * 2. Self (R6): an agent never answers what waits on itself, whoever `by` names.
 * 3. `by` (R3's first half): the caller must be one the item names to answer it now. Until B24 that
 *    is you alone for every run hold and prompt; setup, a workspace change and a cleanup are yours
 *    alone for good.
 * 4. The answer is one the item takes (a choice it offers, words where it takes words, the
 *    questions it asks, a plan's or a form's answer), and a choice only you may make (`humanOnly`)
 *    is yours (R3's second half; rules.ts checks it of a token's call before it runs, too).
 *
 * Then the item's typed handler acts: a proposal's Allow or Refuse (canvas/proposals.ts), a file
 * review's Apply or Keep, a stalled turn's Interrupt, a setup card's choice (workspaces/setup.ts),
 * a run's hold (run-replies.ts), a session's prompt, a workspace change's Switch (workspaces/
 * rebind.ts). No handler waits on a person while it holds a repository's or an agent's lock: every
 * person's decision is this call, made once they decided.
 */

/** A typed answer (B11 Design §7): a choice, words, a question's answers, a permission, a plan or a form. */
export type Answer = z.infer<typeof ReplyAnswer>;

/** What `reply` returns: how the item was settled, and the record or new item it made. */
export interface ReplyResult {
  id?: string;
  canvas?: string;
  outcome?:
    | 'allowed'
    | 'refused'
    | 'stale'
    | 'applied'
    | 'kept'
    | 'superseded'
    | 'answered'
    | 'started'
    | 'skipped'
    | 'stopped'
    | 'completed'
    | 'retained'
    /** A terminal's wait you said isn't one (B13 C7's Not waiting): nothing is recorded. */
    | 'dismissed';
  raised?: string;
}

/** One kind of Needs item, as the router answers it. */
export interface ReplyHandler {
  /** The ids it answers: those starting with one of these and a slash. */
  readonly prefixes: readonly string[];
  /** The item `to` names, as it waits now on the canvas, as you see it: none if none does. */
  current(canvas: CanvasId, to: string): NeedsItem | undefined | Promise<NeedsItem | undefined>;
  /**
   * Why `to` doesn't wait now, if it did (settled, asked again, held by a pause): the failure the
   * router throws. None: not found.
   */
  gone?(canvas: CanvasId, to: string): OpFailure | undefined;
  /**
   * Why `answer` isn't one the item takes, if it isn't (invalid). None given: it takes one of its
   * choices, with words only where it takes words.
   */
  fits?(item: NeedsItem, answer: Answer): string | undefined;
  /** Acts on an answer the router validated: how the item was settled. */
  act(canvas: CanvasId, item: NeedsItem, answer: Answer, ctx: OpContext): Promise<ReplyResult>;
}

/** The choice an answer picks, as an item's choices name it: what R3's humanOnly is read of. */
export function picked(answer: Answer): string | undefined {
  if ('choice' in answer) return answer.choice;
  if ('permission' in answer) return answer.permission;
  return undefined;
}

/** Why an answer isn't one of an item's choices (with words only where it takes them), if it isn't. */
export function fitsChoices(item: NeedsItem, answer: Answer): string | undefined {
  const offered = () =>
    item.choices.length === 0
      ? `${item.id} offers no choice to make here`
      : `${item.id} takes ${item.choices.map(({ value }) => `"${value}"`).join(' or ')}`;
  if ('choice' in answer) {
    if (!item.choices.some(({ value }) => value === answer.choice)) {
      return `${offered()}, not "${answer.choice}".`;
    }
    if (answer.text !== undefined && item.text === undefined) {
      return `${item.id} takes no words with a choice.`;
    }
    return undefined;
  }
  if ('text' in answer) {
    return item.text === undefined ? `${item.id} takes no answer in words.` : undefined;
  }
  return `${offered()}.`;
}

/** Whether `text` holds anything but white space. */
export function said(text: string): boolean {
  return text.trim() !== '';
}

export class ReplyRouter {
  readonly #handlers: readonly ReplyHandler[];

  constructor(handlers: readonly ReplyHandler[]) {
    this.#handlers = handlers;
  }

  /** Answers the item `to` on the canvas with `answer`, as `ctx`'s caller: how it was settled. */
  async reply(
    { canvas, to, answer }: { canvas?: string | undefined; to: string; answer: Answer },
    ctx: OpContext,
  ): Promise<ReplyResult> {
    if (canvas === undefined) throw new OpFailure('invalid', 'Name the canvas the item is on.');
    const id = canvas as CanvasId;
    const handler = this.#handlers.find(({ prefixes }) =>
      prefixes.some((prefix) => to.startsWith(`${prefix}/`)),
    );
    if (handler === undefined) throw notFound(to);
    const item = await handler.current(id, to);
    if (item === undefined) throw handler.gone?.(id, to) ?? notFound(to);
    const { caller } = ctx;
    const by = partyIdOf(caller);
    // R6: what waits on an agent is never that agent's to answer, whoever may answer it.
    if (caller.kind === 'agent' && caller.canvas === id && item.agent === caller.agent) {
      throw new OpFailure(
        'refused',
        `An agent never answers what waits on itself: ${item.title} is for ${andList(item.by.map((party) => partyText([], party)))}.`,
      );
    }
    // R3: the item's `by`, then a choice only you may make.
    if (!item.by.includes(by)) {
      throw new OpFailure(
        'refused',
        `Only ${andList(item.by.map((party) => (party === 'you' ? 'the user' : partyText([], party))))} may answer ${to}: ${item.title}.`,
      );
    }
    const unfit = (handler.fits ?? fitsChoices)(item, answer);
    if (unfit !== undefined) throw new OpFailure('invalid', unfit);
    const choice = item.choices.find(({ value }) => value === picked(answer));
    if (choice?.humanOnly !== undefined && by !== 'you') {
      throw new OpFailure(
        'refused',
        `Only the user may choose ${choice.label}: ${choice.humanOnly}`,
      );
    }
    return handler.act(id, item, answer, ctx);
  }
}

/** There is no item `to` on the canvas. */
export function notFound(to: string): OpFailure {
  return new OpFailure('not-found', `There is no Needs item ${to} on this canvas.`);
}
