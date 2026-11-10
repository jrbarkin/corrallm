import { MAX_WAITING } from '../../../shared/api/limits';
import type { CanvasId } from '../../../shared/canvas';
import { agentParty, isLeadCopy, isLeadNotice } from '../../../shared/model/messages';
import type { Message } from '../../../shared/model/messages';
import { leadCopy, leadNotice } from '../../../shared/model/purpose';
import type { TurnResult } from '../../../shared/session';
import type { RouteChange } from '../prompts/owner';
import type { MessageStore } from './messages';

/*
 * B24 C5's copies and notices: what a routed lead is told, and told once.
 *
 * - A copy is a turn to the lead, from corrallm, whose body is a host-built card: fixed core words
 *   and the prompt's escaped Need id, nothing else. It carries no agent name, title, command, plan,
 *   question or label (names are set by you or by tokens, the rest are the worker's words): the
 *   lead reads the prompt through `needs`, as JSON, and answers it with `reply`. At most one copy
 *   per prompt and lead; none while a lead already has MAX_WAITING open from corrallm.
 * - When the prompt ends, or its route moves away from the lead: a copy still pending is withdrawn
 *   with nothing sent; one already delivering, delivered or unresolved gets one notice, keyed by the
 *   prompt, so a restart or a second end never sends a second.
 * - A core started again holds no open prompts. Loading a canvas's messages again withdraws a
 *   pending copy silently, leaves a delivering one unresolved (never sent again), and gives a
 *   delivered one its one notice.
 */

const COPY = 'lead-copy:';
const NOTICE = 'lead-notice:';

const TAKEN_BACK: TurnResult = {
  status: 'cancelled',
  reason: 'interrupted',
};

/** Why a prompt no longer waits for its lead, in the core's words. */
const ENDED: Readonly<Record<NonNullable<RouteChange['how']> | 'moved' | 'restart', string>> = {
  'by-you': 'the user answered it',
  answered: 'someone else answered it',
  'answered-natively': 'it was answered in its agent’s terminal',
  withdrawn: 'its agent no longer asks it',
  moved: 'it was handed on, or your grants changed',
  restart: 'corrallm restarted, so it no longer waits',
};

export interface LeadCopiesDeps {
  /** The canvas's messages, if the core runs it. */
  messages(canvas: CanvasId): MessageStore | undefined;
  /** What waits in delivery was changed: it looks again. */
  schedule(canvas: CanvasId): void;
  /** The lead a prompt is routed to now, if it still waits (`PromptOwner.routeOf`). */
  routeOf(canvas: CanvasId, need: string): string | undefined;
  /**
   * A lead the prompt is routed to can't be sent its copy (it is full, or the card is refused):
   * the route is withdrawn from it and it is never offered the prompt again (`PromptOwner.unreachable`).
   */
  unreachable(canvas: CanvasId, need: string, lead: string): void;
}

export class LeadCopies {
  readonly #deps: LeadCopiesDeps;

  constructor(deps: LeadCopiesDeps) {
    this.#deps = deps;
  }

  /** The prompt's route moved, or the prompt ended (the owner's `routed`). */
  routed(change: RouteChange & { until?: number }): void {
    const messages = this.#deps.messages(change.canvas);
    if (messages === undefined) return;
    // The party that answered or handed back already had that occurrence's result: no notice.
    if (change.from !== undefined && change.by !== agentParty(change.from)) {
      this.#away(
        messages,
        change.need,
        change.from,
        change.why === 'ended' ? (change.how ?? 'withdrawn') : 'moved',
      );
    }
    if (change.to !== undefined && change.until !== undefined) {
      this.#offer(messages, change.canvas, change.need, change.to, change.until);
    }
    this.#deps.schedule(change.canvas);
  }

  /**
   * B24 C9: a record for an outside orchestrator you let answer approvals (its `wait` returns it):
   * one when an approval it may answer waits, one more if that ends unanswered by it. Fixed core
   * words and the escaped Need id, as the card is.
   */
  wake({
    canvas,
    need,
    name,
    type,
  }: {
    canvas: CanvasId;
    need: string;
    name: string;
    type: 'raised' | 'ended';
  }): void {
    const messages = this.#deps.messages(canvas);
    if (messages === undefined) return;
    const told = `outside-${type}:${need}|${name}`;
    if (messages.toldWith(told).length > 0) return;
    messages.add(
      {
        from: 'corrallm',
        to: `outside:${name}`,
        kind: 'notice',
        origin: 'party',
        body:
          type === 'raised'
            ? `A request from a worker waits for approval, and you may answer it once, as the user allowed (not the user): ${need}. Read it with needs { "canvas": "${canvas}" } and answer it with reply.`
            : `${need} no longer waits for you.`,
        state: 'delivered',
      },
      told,
    );
  }

  /** Whether a copy's prompt still waits on its lead's route: checked just before it is sent. */
  live(message: Message): boolean {
    if (!isLeadCopy(message) || message.purpose?.type !== 'lead-copy') return true;
    const lead = message.to.startsWith('agent:') ? message.to.slice('agent:'.length) : undefined;
    return lead !== undefined && this.#deps.routeOf(message.canvas, message.purpose.need) === lead;
  }

  /**
   * A copy or notice was withdrawn instead of sent. A copy whose card failed its checks (its route
   * still on that lead) loses the route, which moves up and never returns; one withdrawn because
   * its route had moved on already changes nothing.
   */
  refused(message: Message): void {
    if (!isLeadCopy(message) || message.purpose?.type !== 'lead-copy') return;
    const lead = message.to.startsWith('agent:') ? message.to.slice('agent:'.length) : undefined;
    if (lead === undefined) return;
    this.#deps.unreachable(message.canvas, message.purpose.need, lead);
  }

  /** Offers `lead` the prompt `need`: one copy, unless it already has or is full. */
  #offer(
    messages: MessageStore,
    canvas: CanvasId,
    need: string,
    lead: string,
    until: number,
  ): void {
    const to = agentParty(lead);
    const told = `${COPY}${need}|${lead}`;
    if (messages.toldWith(told).some(({ state }) => state !== 'withdrawn')) return;
    const open = messages
      .activeTo(to)
      .filter((one) => one.from === 'corrallm' && isLeadCopy(one) && one.state !== 'replied');
    if (open.length >= MAX_WAITING) {
      // Full: the route passes it by (a route never stays with a lead that was not told).
      this.#deps.unreachable(canvas, need, lead);
      return;
    }
    messages.add(
      {
        from: 'corrallm',
        to,
        kind: 'text',
        origin: 'party',
        body: card(canvas, need, until),
        state: 'pending',
        purpose: leadCopy(need),
      },
      told,
    );
  }

  /** `lead` no longer holds `need`: its pending copy withdrawn, one that reached it noticed once. */
  #away(messages: MessageStore, need: string, lead: string, how: keyof typeof ENDED): void {
    for (const copy of messages.toldWith(`${COPY}${need}|${lead}`)) {
      if (copy.state === 'withdrawn') continue;
      if (copy.state === 'pending') {
        messages.update(copy.id, { state: 'withdrawn', by: 'corrallm', turn: TAKEN_BACK });
      } else notice(messages, copy, need, ENDED[how]);
    }
  }

  /**
   * A canvas's messages loaded again: no prompt is open in a core started again. A pending copy is
   * withdrawn silently, a delivering one becomes unresolved and is never resent, a delivered one
   * gets its one notice. Whether anything changed.
   */
  static recover(messages: MessageStore): boolean {
    let any = false;
    for (const copy of messages.toldStarting(COPY)) {
      if (copy.purpose?.type !== 'lead-copy') continue;
      switch (copy.state) {
        case 'pending':
          messages.update(copy.id, { state: 'withdrawn', by: 'corrallm', turn: TAKEN_BACK });
          any = true;
          break;
        case 'delivering':
          messages.update(copy.id, { state: 'unresolved' });
          notice(messages, copy, copy.purpose.need, ENDED.restart);
          any = true;
          break;
        case 'delivered':
        case 'replied':
          notice(messages, copy, copy.purpose.need, ENDED.restart);
          any = true;
          break;
        default:
          break;
      }
    }
    return any;
  }
}

/** The one notice for `need`'s copy, to the lead that got it: none if it already has one. */
function notice(messages: MessageStore, copy: Message, need: string, why: string): void {
  const told = `${NOTICE}${need}|${copy.to}`;
  if (messages.toldWith(told).length > 0) return;
  messages.add(
    {
      from: 'corrallm',
      to: copy.to,
      kind: 'text',
      origin: 'party',
      body: `${need} no longer waits for you: ${why}. Nothing more is asked of you.`,
      state: 'pending',
      purpose: leadNotice(need),
    },
    told,
  );
}

/**
 * The host-built card (R29): fixed core words and the escaped Need id and canvas id, nothing else.
 */
export function card(canvas: CanvasId, need: string, until: number): string {
  return [
    `A request from your team waits for you to answer, as its lead (not the user): ${need}.`,
    `Read it with needs { "canvas": "${canvas}" } and answer it with reply { "canvas": "${canvas}", "to": "${need}", "answer": { "choice": "<value>" } }, or hand it back with { "choice": "hand-back" }. It is yours to answer until ${new Date(until).toISOString()}; the user can answer it too.`,
  ].join('\n');
}

/** Whether a message is one of the lead copies' or notices' own. */
export function isLeadCopyTurn(message: Message): boolean {
  return isLeadCopy(message) || isLeadNotice(message);
}
