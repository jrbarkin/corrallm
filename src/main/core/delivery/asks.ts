import { MAX_MESSAGE_BYTES, MAX_OPEN_ASKS, MAX_WAITING } from '../../../shared/api/limits';
import type { CanvasId } from '../../../shared/canvas';
import { askStateOf } from '../../../shared/model/asks';
import type {
  AskOutcome,
  AskQuestion,
  AskQuestionColumn,
  AskSettlement,
  AskWithdrawal,
} from '../../../shared/model/asks';
import type { CanvasNode } from '../../../shared/model/canvas';
import {
  agentOf,
  isContinuation,
  isOpenAsk,
  isOpenToYou,
  isMessageToYou,
  outsideOf,
} from '../../../shared/model/messages';
import type { Message, PartyId } from '../../../shared/model/messages';
import type { NeedsItem } from '../../../shared/model/needs';
import type { QuestionAnswers } from '../../../shared/model/prompts';
import { threadTitle } from '../../../shared/model/session';
import type { TaskMessage, TurnResult } from '../../../shared/session';
import { partyName, partyText, quotedName, quotedParty } from '../parties';
import { DeliveryError } from './errors';
import { capBody } from './messages';
import type { MessageStore } from './messages';
import { continuationsOf, openAsksOf } from './tasks';

/*
 * Asks and messages to you (B21 Design §9.2 C5, C6), on one canvas: no second inbox, only typed
 * rows of its message store and the Needs items they make.
 *
 * - A party's message to you (`message { to: { party: 'you' } }`, or to its manager, which is you
 *   until B24 grants a lead questions) is a record to you, `delivered`, and a Needs item
 *   `message/<id>` that only you answer: Dismiss settles it, with no record to its sender; Reply
 *   sends yours, to an agent as yours (a turn), to an outside party as a record for `wait`. A
 *   sender keeps at most MAX_WAITING of them open.
 * - An ask is a message of kind `prompt` from its asker to its recipient, its questions and
 *   deadline in its `ask` column, on disk before `ask` returns. To an agent, delivery delivers it as
 *   a turn, framed (`askFrame`); to you, it is `delivered` and a Needs item `ask/<id>`. Its
 *   recipient and you answer it (`reply`, every question at once), and the first answer wins: the
 *   ask's row becomes `answered` with a value-free settlement, and the asker is sent an answer row
 *   in the same write. An ask's turn that ends completed with no structured answer is answered by
 *   its reply text; one that failed, was cancelled or said nothing leaves it open, the asker told
 *   once. Its deadline expires it (by wall clock, downtime included); its recipient leaving
 *   withdraws it; each sends the asker a `settled` record. Its asker leaving, or its canvas closing,
 *   withdraws it with nothing sent. One open ask per asker and recipient, MAX_OPEN_ASKS a canvas.
 *
 * Every row an asker is sent goes to an agent as an ordinary turn (making no reply of its own) and
 * to an outside party as a record. B21 C5 (§9.2 C7) builds a task's asks on these rows: an ask made
 * during one of a task's attempt's own turns keeps that attempt in its column (`task`), and what it
 * sends its asker carries it (`Message.task`: a continuation, which delivery sends first in line, as
 * the attempt's own turn). The attempt stopped (Stop, Kill, its turn failing natively, Run again,
 * a restart that holds it uncertain) or completed (`complete`), its open asks are withdrawn with
 * nothing sent (`withdrawTask`), a note for an agent recipient it had reached, and its continuations
 * still to come with them.
 */

export interface AsksDeps {
  canvas: CanvasId;
  store: MessageStore;
  /** The canvas's nodes now. */
  nodes: () => readonly CanvasNode[];
  now: () => number;
  later: (run: () => void, ms: number) => () => void;
  /** What waits for an answer changed without a call (an ask expired, its party left). */
  changed: () => void;
  /** Delivery looks again at what waits: an asker was sent a row. */
  schedule: () => void;
  /** How many messages `from` has waiting for agent `agent` (delivery's MAX_WAITING counts asks). */
  waiting: (agent: string, from: PartyId) => number;
  /** Sends agent `agent` your message replying to `replyTo`, as yours: a turn, unframed. */
  sendYours: (agent: string, body: string, replyTo: string) => Promise<Message>;
  /**
   * B21 C7: whether a task's attempt still runs (its agent's current task's last attempt, running):
   * the asks of one that doesn't, and its continuations still to come, are withdrawn (`sweep`).
   */
  running: (task: TaskMessage) => boolean;
  /**
   * B21 C6: you gave these agents input (the loop breaker's reset): in memory at once, on disk
   * with the write that holds the answer, dismissal or reply that was it.
   */
  heard: (agents: readonly string[]) => void;
}

/** An ask's answer: the answers by question id, or the text that answered it. */
export type AskAnswer = { answers: QuestionAnswers } | { text: string };

/** The told key an ask is kept with, by which a repeat of its request finds it (across restarts). */
export function askRequestKey(from: PartyId, request: string): string {
  return `ask:${encodeURIComponent(from)}:${request}`;
}

/** The longest title of an ask or a message to you, and of what a notice quotes of a name. */
const TITLE = 120;

/** The Needs id of an open ask, and of a party's message to you. */
export const askNeed = (id: string): string => `ask/${id}`;
export const messageNeed = (id: string): string => `message/${id}`;

export class Asks {
  readonly #deps: AsksDeps;
  /** The open asks, by id: rebuilt from the store as the canvas opens, kept as each changes. */
  readonly #open = new Set<string>();
  /** The parties' messages to you that wait on you, by id. */
  readonly #toYou = new Set<string>();
  #unwatch: () => void;
  #alarm: { at: number; cancel: () => void } | undefined;
  #started = false;

  constructor(deps: AsksDeps) {
    this.#deps = deps;
    for (const message of deps.store.all()) this.#index(message.id);
    this.#unwatch = deps.store.watch((id) => {
      this.#index(id);
    });
  }

  /**
   * As delivery starts (the canvas opens): every ask whose deadline passed meanwhile expires now,
   * and the next deadline is watched for.
   */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.sweep();
    this.#expire();
  }

  /** As delivery stops: nothing is watched for any more (the asks stay open, on disk). */
  close(): void {
    this.#started = false;
    this.#unwatch();
    this.#unwatch = () => undefined;
    this.#alarm?.cancel();
    this.#alarm = undefined;
  }

  /** The canvas closes for good (canvas.close): its open asks are withdrawn, nothing sent. */
  closing(): void {
    for (const ask of this.#asks()) this.#settle(ask, withdrawn('closed'), 'corrallm', 'none');
  }

  /**
   * Admits an ask from `from` to `to` (an agent, or you), asked through `via` (`manager`, resolved
   * to you until B24), with `questions` and a deadline `seconds` from now: on disk before it
   * resolves, delivered to an agent once nothing holds it. A repeat of `request` from the same
   * party is the first ask, whose questions and recipient must be the same. Throws, saying why, a
   * second open ask to the same recipient, one past the canvas's MAX_OPEN_ASKS, or one past the
   * recipient agent's MAX_WAITING from its asker; and 'unavailable' if its record can't be kept.
   */
  async ask({
    from,
    to,
    via,
    questions,
    seconds,
    request,
    task,
  }: {
    from: PartyId;
    to: PartyId;
    via?: 'manager';
    questions: readonly AskQuestion[];
    seconds: number;
    request?: string;
    /** B21 C7: the task attempt whose own turn its asker was on as it asked (`ownTurn`). */
    task?: TaskMessage;
  }): Promise<Message> {
    const { store } = this.#deps;
    this.sweep();
    const told = request === undefined ? undefined : askRequestKey(from, request);
    const before = told === undefined ? undefined : store.toldAs(told);
    if (before !== undefined) {
      const kept = before.ask?.type === 'question' ? before.ask : undefined;
      if (
        kept === undefined ||
        before.to !== to ||
        JSON.stringify(kept.questions) !== JSON.stringify(questions)
      ) {
        throw new DeliveryError('conflict', 'That request id was used for another ask.');
      }
      return before;
    }
    const open = this.#asks();
    const pair = open.find((one) => one.from === from && one.to === to);
    if (pair !== undefined) {
      throw new DeliveryError(
        'conflict',
        `You already have question ${pair.id} open to ${this.#name(to)}: wait for its answer or its deadline.`,
      );
    }
    if (open.length >= MAX_OPEN_ASKS) {
      throw new DeliveryError(
        'refused',
        `This canvas already has ${String(MAX_OPEN_ASKS)} questions open; ask again once one of them ends.`,
      );
    }
    const agent = agentOf(to);
    if (agent !== undefined && this.#deps.waiting(agent, from) >= MAX_WAITING) {
      throw new DeliveryError(
        'refused',
        `${this.#name(to)} already has ${String(MAX_WAITING)} of your messages waiting; ask once one of them goes.`,
      );
    }
    const column: AskQuestionColumn = {
      v: 1,
      type: 'question',
      questions: [...questions],
      deadline: this.#deps.now() + seconds * 1000,
      ...(via === undefined ? {} : { via }),
      ...(task === undefined
        ? {}
        : { task: { owner: task.agent, item: task.item, attempt: task.attempt } }),
    };
    const message = store.add(
      {
        from,
        to,
        kind: 'prompt',
        origin: 'party',
        body: askTitle(this.#deps.nodes(), from, questions),
        // To an agent it waits to be delivered; to you it is yours to read now.
        state: agent === undefined ? 'delivered' : 'pending',
        ask: column,
      },
      told,
    );
    try {
      await store.durable();
    } catch (error) {
      // Never open, never sent: its record didn't reach the disk.
      if (store.get(message.id)?.settled === undefined)
        store.update(message.id, {
          state: 'unresolved',
          settled: settlement(column, withdrawn('asker')),
        });
      throw new DeliveryError('unavailable', unsaved('question', error));
    }
    this.#arm();
    if (agent !== undefined) this.#deps.schedule();
    return store.get(message.id) ?? message;
  }

  /**
   * Keeps `from`'s message to you (`via` its manager, which is you until B24): a record, on disk
   * before it resolves, waiting on you in Needs until you dismiss or answer it. Throws, saying why,
   * one past MAX_WAITING of `from`'s open, and 'unavailable' if it can't be kept.
   */
  async toYou({
    from,
    body,
    replyTo,
    via,
  }: {
    from: PartyId;
    body: string;
    replyTo?: string;
    via?: 'manager';
  }): Promise<Message> {
    const { store } = this.#deps;
    const open = [...this.#toYou].filter((id) => store.get(id)?.from === from).length;
    if (open >= MAX_WAITING) {
      throw new DeliveryError(
        'refused',
        `The user already has ${String(MAX_WAITING)} of your messages open; send another once they dismiss or answer one.`,
      );
    }
    const message = store.add({
      from,
      to: 'you',
      kind: 'text',
      origin: 'party',
      ...(via === undefined ? {} : { display: { via } }),
      body,
      state: 'delivered',
      ...(replyTo === undefined ? {} : { replyTo }),
    });
    try {
      await store.durable();
    } catch (error) {
      store.update(message.id, { state: 'unresolved', by: 'corrallm' });
      throw new DeliveryError('unavailable', unsaved('message', error));
    }
    return store.get(message.id) ?? message;
  }

  /**
   * What waits on the canvas's asks and messages to you, as you see it: never an ask whose party
   * left, which the next sweep withdraws (a read settles nothing).
   */
  items(): NeedsItem[] {
    const { store } = this.#deps;
    const here = this.#here();
    return [
      ...this.#asks()
        .filter((ask) => stays(ask, here))
        .map((ask) => this.#askItem(ask)),
      ...[...this.#toYou].flatMap((id) => {
        const message = store.get(id);
        return message === undefined ? [] : [this.#messageItem(message)];
      }),
    ];
  }

  /** The open ask `ask/<id>` names, as you see it in Needs, if it is open. */
  askItem(need: string): NeedsItem | undefined {
    const ask = this.#openAsk(need);
    return ask === undefined || !stays(ask, this.#here()) ? undefined : this.#askItem(ask);
  }

  /** The party's message to you `message/<id>` names, as you see it in Needs, if it waits. */
  messageItem(need: string): NeedsItem | undefined {
    const id = need.startsWith('message/') ? need.slice('message/'.length) : undefined;
    const message = id === undefined || !this.#toYou.has(id) ? undefined : this.#deps.store.get(id);
    return message === undefined ? undefined : this.#messageItem(message);
  }

  /** The asker of open ask `need`, and its questions, if it is open. */
  askOf(need: string): { from: PartyId; questions: readonly AskQuestion[] } | undefined {
    const ask = this.#openAsk(need);
    return ask?.ask?.type === 'question'
      ? { from: ask.from, questions: ask.ask.questions }
      : undefined;
  }

  /** Why ask `need` waits no more, if it did: who answered it, or how it ended. */
  askGone(need: string): string | undefined {
    const id = need.startsWith('ask/') ? need.slice('ask/'.length) : undefined;
    const ask = id === undefined ? undefined : this.#deps.store.get(id);
    if (ask?.kind !== 'prompt' || ask.ask?.type !== 'question' || ask.settled === undefined)
      return undefined;
    if (!('ask' in ask.settled)) return undefined;
    const { outcome } = ask.settled;
    const who = ask.by === undefined ? 'someone' : partyText(this.#deps.nodes(), ask.by);
    switch (outcome.type) {
      case 'answers':
      case 'text':
        return `${need} is answered already: ${who} answered it.`;
      case 'dismissed':
        return `${need} is settled already: the user dismissed it.`;
      case 'expired':
        return `${need} expired unanswered.`;
      case 'withdrawn':
        return `${need} was withdrawn: ${WITHDRAWN_WORDS[outcome.why]}.`;
    }
  }

  /** Why a party's message to you `need` waits no more, if it did: how you settled it. */
  messageGone(need: string): string | undefined {
    const id = need.startsWith('message/') ? need.slice('message/'.length) : undefined;
    const message = id === undefined ? undefined : this.#deps.store.get(id);
    if (message === undefined || !isMessageToYou(message) || message.by !== 'you') return undefined;
    const replied = this.#deps.store.all().some((one) => one.replyTo === id && one.from === 'you');
    return `${need} is settled already: the user ${replied ? 'replied to' : 'dismissed'} it.`;
  }

  /**
   * Answers open ask `need` for `by` (its recipient, or you): its row answered, with a value-free
   * settlement, and the answer sent its asker, in one write, on disk before it resolves. Throws a
   * conflict, saying who answered, for an ask answered or ended meanwhile; 'unavailable' if the
   * answer can't be kept (it stands, but may not survive a restart). The answer row's id.
   */
  async answer(need: string, by: PartyId, answer: AskAnswer): Promise<Message> {
    const ask = this.#openOrGone(need);
    const row = this.#settle(
      ask,
      'answers' in answer
        ? { type: 'answers', count: Object.keys(answer.answers).length }
        : { type: 'text' },
      by,
      'answer',
      answer,
    );
    // Your answer is input to its asker and to the agent it was asked of (B21 C6).
    if (by === 'you') this.#heard(ask.from, ask.to);
    await this.#saved('answer');
    if (row === undefined) throw new Error('An answer makes a row.');
    return row;
  }

  /** You dismiss open ask `need` to you: its asker is sent a record. The record's id, if any. */
  async dismiss(need: string): Promise<Message | undefined> {
    const ask = this.#openOrGone(need);
    const record = this.#settle(ask, { type: 'dismissed' }, 'you', 'record');
    this.#heard(ask.from);
    await this.#saved('dismissal');
    return record;
  }

  /** You dismiss a party's message to you: settled, with no record to its sender. */
  async dismissMessage(need: string): Promise<void> {
    const message = this.#waitingOn(need);
    this.#deps.store.update(message.id, { state: 'answered', by: 'you' });
    this.#heard(message.from);
    await this.#saved('dismissal');
  }

  /**
   * You reply to a party's message to you: yours to an agent is sent as yours (a turn), to an
   * outside party a record for its `wait`; the message settled. Your reply's id.
   */
  async replyToMessage(need: string, text: string): Promise<Message> {
    const { store } = this.#deps;
    const message = this.#waitingOn(need);
    const agent = agentOf(message.from);
    if (agent !== undefined && !this.#here().has(agent)) {
      throw new DeliveryError(
        'conflict',
        `${quotedParty(this.#deps.nodes(), message.from)} is no longer on the canvas: dismiss its message instead.`,
      );
    }
    // An outside orchestrator reads whole messages of at most 16 KiB (MAX_MESSAGE_BYTES).
    if (agent === undefined && new TextEncoder().encode(text).length > MAX_MESSAGE_BYTES) {
      throw new DeliveryError(
        'refused',
        'An outside orchestrator reads at most 16 KB of text in one message: reply in fewer words.',
      );
    }
    store.update(message.id, { state: 'answered', by: 'you' });
    this.#heard(message.from);
    if (agent !== undefined) return this.#deps.sendYours(agent, text, message.id);
    const reply = store.add({
      from: 'you',
      to: message.from,
      kind: 'text',
      origin: 'manual',
      body: text,
      replyTo: message.id,
      state: 'delivered',
    });
    await this.#saved('reply');
    return store.get(reply.id) ?? reply;
  }

  /**
   * An ask's turn ended, its agent having said `reply` (delivery's #ended, for an ask still open):
   * completed with something said, that answers it (capped, as replies are); otherwise it stays
   * open, its turn over, and its asker is told once.
   */
  turnEnded(ask: Message, reply: string, result: TurnResult): void {
    const { store } = this.#deps;
    if (!isOpenAsk(ask)) return;
    if (result.status === 'completed' && reply.trim() !== '') {
      this.#settle(ask, { type: 'text' }, ask.to, 'answer', {
        text: capBody(reply.trim(), 'reply'),
      });
      return;
    }
    store.update(ask.id, { state: 'replied', turn: result });
    const key = `ask-open:${ask.id}`;
    if (store.hasTold(key)) return;
    const how =
      result.status === 'completed'
        ? 'its turn ended without a reply'
        : result.status === 'failed'
          ? 'its turn failed'
          : 'its turn was cancelled';
    store.add(
      {
        from: 'corrallm',
        to: ask.from,
        kind: 'notice',
        origin: 'party',
        body: `${this.#name(ask.to)} didn’t answer your question ${ask.id}: ${how}. It stays open for ${this.#name(ask.to)} or the user to answer until its deadline.`,
        replyTo: ask.id,
        state: 'delivered',
      },
      key,
    );
  }

  /**
   * B21 C7, C8: withdraws the open asks a task's attempt made, and the continuations of it still to
   * be delivered (`why`: its task stopped, or its agent completed it), nothing sent its asker. An ask
   * that had reached its agent recipient leaves that agent a note, told with its next message; its
   * turn going on isn't interrupted, and its late answer is a conflict saying why. Whether any was.
   */
  withdrawTask(task: TaskMessage, why: 'stopped' | 'completed'): boolean {
    const { store } = this.#deps;
    let changed = false;
    for (const ask of openAsksOf(store, task)) {
      const reached =
        agentOf(ask.to) !== undefined &&
        (ask.state === 'delivering' || ask.state === 'delivered' || ask.state === 'replied');
      this.#settle(ask, withdrawn(why), 'corrallm', 'none');
      if (reached) store.update(ask.id, {}, this.#withdrawalNote(ask, why));
      changed = true;
    }
    for (const message of continuationsOf(store, task)) {
      if (message.state !== 'pending') continue;
      store.update(message.id, { state: 'withdrawn', by: 'corrallm' });
      changed = true;
    }
    if (changed) {
      this.#deps.schedule();
      queueMicrotask(this.#deps.changed);
    }
    return changed;
  }

  /**
   * Withdraws each open ask whose asker or recipient is an agent no longer on the canvas: its
   * asker's with nothing sent; its recipient's, its asker sent a record of it. And (B21 C7) the
   * asks of a task's attempt no longer running, with its continuations still to come: its task
   * stopped (Stop, Kill, a native failure, Run again, a restart that holds it uncertain).
   */
  sweep(): void {
    const here = this.#here();
    let changed = false;
    for (const ask of this.#asks()) {
      if (gone(ask.from, here)) this.#settle(ask, withdrawn('asker'), 'corrallm', 'none');
      else if (gone(ask.to, here)) this.#settle(ask, withdrawn('recipient'), 'corrallm', 'record');
      else continue;
      changed = true;
    }
    const stopped = new Map<string, TaskMessage>();
    for (const ask of this.#asks()) {
      const task = taskOf(ask);
      if (task !== undefined && !this.#deps.running(task)) stopped.set(task.attempt, task);
    }
    for (const message of this.#deps.store.active()) {
      const { task } = message;
      if (
        task !== undefined &&
        message.state === 'pending' &&
        isContinuation(message) &&
        !this.#deps.running(task)
      )
        stopped.set(task.attempt, task);
    }
    for (const task of stopped.values()) this.withdrawTask(task, 'stopped');
    if (changed) {
      this.#deps.schedule();
      queueMicrotask(this.#deps.changed);
    }
  }

  /**
   * What an agent recipient an ask had reached is told of it withdrawn, with its next message: whose
   * question, why, and not to answer it. Names only parties, capped as notices cap them.
   */
  #withdrawalNote(ask: Message, why: AskWithdrawal): string {
    return `Question ${ask.id} from ${quotedParty(this.#deps.nodes(), ask.from)} was withdrawn after it reached you: ${WITHDRAWN_WORDS[why]}. Do not answer it. Anything already done is left as it is.`;
  }

  /** The open ask `need` names: one answered or ended meanwhile is a conflict saying how. */
  #openOrGone(need: string): Message {
    this.sweep();
    const ask = this.#openAsk(need);
    if (ask !== undefined) return ask;
    throw new DeliveryError('conflict', this.askGone(need) ?? `There is no Needs item ${need}.`);
  }

  /** The party's message to you `need` names, still waiting on you: else a conflict saying how. */
  #waitingOn(need: string): Message {
    const id = need.slice('message/'.length);
    const message = this.#toYou.has(id) ? this.#deps.store.get(id) : undefined;
    if (message !== undefined) return message;
    throw new DeliveryError(
      'conflict',
      this.messageGone(need) ?? `There is no Needs item ${need}.`,
    );
  }

  #openAsk(need: string): Message | undefined {
    const id = need.startsWith('ask/') ? need.slice('ask/'.length) : undefined;
    return id === undefined || !this.#open.has(id) ? undefined : this.#deps.store.get(id);
  }

  /** Every open ask, in the store's order. */
  #asks(): Message[] {
    const { store } = this.#deps;
    return [...this.#open]
      .flatMap((id) => store.get(id) ?? [])
      .sort((a, b) => (store.seqOf(a.id) ?? 0) - (store.seqOf(b.id) ?? 0));
  }

  /**
   * Ends `ask` with `outcome`, by `by`, in one write with what its asker is sent: an answer row
   * (`answer`), a record from corrallm (`record`), or nothing (`none`). What it sent, if anything.
   */
  #settle(
    ask: Message,
    outcome: AskOutcome,
    by: PartyId,
    send: 'answer' | 'record' | 'none',
    answer?: AskAnswer,
  ): Message | undefined {
    const { store } = this.#deps;
    const column = ask.ask?.type === 'question' ? ask.ask : undefined;
    if (column === undefined) return undefined;
    const settled = settlement(column, outcome);
    store.update(ask.id, { state: askStateOf(outcome), by, settled });
    if (send === 'none') return undefined;
    // An agent is sent it as a turn; an outside party keeps it as a record.
    const state = agentOf(ask.from) === undefined ? 'delivered' : 'pending';
    // B21 C7: an ask of a task's attempt continues that task, carrying it.
    const task = taskOf(ask);
    const carried = task === undefined ? {} : { task };
    const row =
      send === 'answer' && answer !== undefined
        ? store.add({
            from: by,
            to: ask.from,
            kind: 'text',
            origin: 'party',
            body: capBody(answerBody(ask.id, column.questions, answer), 'reply'),
            replyTo: ask.id,
            state,
            ...carried,
            ask:
              'answers' in answer
                ? { v: 1, type: 'answer', of: ask.id, answers: answer.answers }
                : { v: 1, type: 'answer', of: ask.id, text: answer.text },
          })
        : store.add({
            from: 'corrallm',
            to: ask.from,
            kind: 'settled',
            origin: 'party',
            body: this.#settledBody(ask, outcome),
            replyTo: ask.id,
            state,
            ...carried,
            settled,
          });
    if (state === 'pending') this.#deps.schedule();
    return row;
  }

  /** What an asker is told of its ask ended unanswered, in corrallm's words. */
  #settledBody(ask: Message, outcome: AskOutcome): string {
    const to = this.#name(ask.to);
    switch (outcome.type) {
      case 'expired':
        return `Your question ${ask.id} to ${to} expired unanswered.`;
      case 'dismissed':
        return `The user dismissed your question ${ask.id}, unanswered.`;
      case 'withdrawn':
        return `Your question ${ask.id} to ${to} was withdrawn unanswered: ${WITHDRAWN_WORDS[outcome.why]}.`;
      default:
        return `Your question ${ask.id} to ${to} was answered.`;
    }
  }

  /** Waits for every write so far, saying what couldn't be kept as 'unavailable'. */
  async #saved(what: string): Promise<void> {
    try {
      await this.#deps.store.durable();
    } catch (error) {
      throw new DeliveryError(
        'unavailable',
        `The ${what} stands now, but it could not be saved and may not survive a restart (${reasonOf(error)}).`,
      );
    }
  }

  /** Keeps message `id` in the open asks or the messages to you, as it is now. */
  #index(id: string): void {
    const message = this.#deps.store.get(id);
    const was = this.#open.has(id);
    const open = message !== undefined && isOpenAsk(message);
    if (open) this.#open.add(id);
    else this.#open.delete(id);
    if (open !== was) this.#arm();
    if (message !== undefined && isOpenToYou(message)) this.#toYou.add(id);
    else this.#toYou.delete(id);
  }

  /** Expires every open ask whose deadline passed, then watches for the next. */
  #expire(): void {
    const now = this.#deps.now();
    let expired = false;
    for (const ask of this.#asks()) {
      if (ask.ask?.type !== 'question' || ask.ask.deadline > now) continue;
      this.#settle(ask, { type: 'expired' }, 'corrallm', 'record');
      expired = true;
    }
    this.#arm();
    if (expired) {
      this.#deps.schedule();
      this.#deps.changed();
    }
  }

  /** Wakes at the next open ask's deadline, once started. */
  #arm(): void {
    if (!this.#started) return;
    let at: number | undefined;
    for (const ask of this.#asks())
      if (ask.ask?.type === 'question') at = Math.min(at ?? ask.ask.deadline, ask.ask.deadline);
    if (this.#alarm?.at === at) return;
    this.#alarm?.cancel();
    this.#alarm = undefined;
    if (at === undefined) return;
    const cancel = this.#deps.later(
      () => {
        this.#alarm = undefined;
        this.#expire();
      },
      Math.max(0, at - this.#deps.now()) + 1,
    );
    this.#alarm = { at, cancel };
  }

  #askItem(ask: Message): NeedsItem {
    const column = ask.ask?.type === 'question' ? ask.ask : undefined;
    const yours = ask.to === 'you';
    return {
      id: askNeed(ask.id),
      canvas: this.#deps.canvas,
      kind: 'prompt',
      for: ask.to,
      by: yours ? ['you'] : [ask.to, 'you'],
      title: ask.body,
      ...(column === undefined ? {} : { until: column.deadline }),
      choices: yours
        ? [{ value: 'dismiss', label: 'Dismiss', humanOnly: 'Only you dismiss a question to you.' }]
        : [],
      questions: (column?.questions ?? []).map((question) => ({
        id: question.id,
        header: question.header,
        text: question.text,
        options: question.options.map(({ label, description }) => ({
          label,
          ...(description === undefined ? {} : { description }),
        })),
        multiple: question.multiple,
        other: question.other,
      })),
      answerIn: 'api',
    };
  }

  #messageItem(message: Message): NeedsItem {
    const via = this.#deps.store.displayOf(message.id)?.via === 'manager';
    return {
      id: messageNeed(message.id),
      canvas: this.#deps.canvas,
      kind: 'message',
      for: 'you',
      by: ['you'],
      title: `Message from ${partyName(this.#deps.nodes(), message.from)}${via ? ' to its manager' : ''}`,
      detail: message.body,
      choices: [{ value: 'dismiss', label: 'Dismiss' }],
      text: { placeholder: 'Reply' },
      answerIn: 'api',
    };
  }

  /** You gave these parties input: those that are agents start their pairs again (B21 C6). */
  #heard(...parties: PartyId[]): void {
    this.#deps.heard(parties.flatMap((party) => agentOf(party) ?? []));
  }

  /** The agents on the canvas now. */
  #here(): Set<string> {
    return new Set(this.#deps.nodes().flatMap((node) => (node.type === 'agent' ? [node.id] : [])));
  }

  /** A party, as a notice or a record names it. */
  #name(party: PartyId): string {
    return partyText(this.#deps.nodes(), party);
  }
}

/** What each withdrawal says of why. */
const WITHDRAWN_WORDS: Readonly<Record<AskWithdrawal, string>> = {
  asker: 'its asker is no longer on the canvas',
  recipient: 'the one it was for is no longer on the canvas',
  stopped: 'its task was stopped',
  completed: 'its task was completed',
  closed: 'its canvas was closed',
};

const withdrawn = (why: AskWithdrawal): AskOutcome => ({ type: 'withdrawn', why });

/** Whether `party` is an agent no longer on the canvas (`here`, its agents now). */
function gone(party: PartyId, here: ReadonlySet<string>): boolean {
  const agent = agentOf(party);
  return agent !== undefined && !here.has(agent);
}

/** Whether an open ask's asker and recipient are both still there. */
function stays(ask: Message, here: ReadonlySet<string>): boolean {
  return !gone(ask.from, here) && !gone(ask.to, here);
}

/** The task attempt an ask was made during, if any (B21 C7), as a task's messages name it. */
function taskOf(ask: Message): TaskMessage | undefined {
  const task = ask.ask?.type === 'question' ? ask.ask.task : undefined;
  return task === undefined
    ? undefined
    : { agent: task.owner, item: task.item, attempt: task.attempt };
}

function settlement(column: AskQuestionColumn, outcome: AskOutcome): AskSettlement {
  return { v: 1, ask: { questions: column.questions.length }, outcome };
}

/** An ask's title, in corrallm's words: who asks, and its first question's header (or its text). */
export function askTitle(
  nodes: readonly CanvasNode[],
  from: PartyId,
  questions: readonly AskQuestion[],
): string {
  const [first] = questions;
  const about = first === undefined ? '' : first.header.trim() || first.text;
  return threadTitle(`${partyName(nodes, from)} asks: ${about}`, TITLE);
}

/**
 * How an agent is sent an ask: behind a first line saying who asks (never the user), the ask's id
 * and the reply call that answers it, then its questions, each quoted as the asker's words.
 */
export function askFrame(nodes: readonly CanvasNode[], ask: Message): string {
  const column = ask.ask?.type === 'question' ? ask.ask : undefined;
  const agent = agentOf(ask.from);
  const outside = outsideOf(ask.from);
  const [who, what] =
    agent !== undefined
      ? [`agent ${quotedParty(nodes, ask.from)}`, 'an agent']
      : outside !== undefined
        ? [quotedName(outside), 'an orchestrator outside corrallm']
        : ['corrallm', 'corrallm itself'];
  const first = `[corrallm] Question from ${who} (${what}, not the user; question ${ask.id}). Answer with the reply tool: reply { to: "ask/${ask.id}", answer: { answers: { "<question id>": { picked: [...] } | { text } } } }, or in your reply text. Its questions, in the asker’s words:`;
  const questions = (column?.questions ?? []).map((question, i) => {
    const how = [
      question.options.length === 0
        ? undefined
        : question.multiple
          ? 'pick any of its options'
          : 'pick one of its options',
      question.other ? 'or answer in your own words' : undefined,
    ]
      .filter((one) => one !== undefined)
      .join(', ');
    const options = question.options.map(
      ({ label, description }) =>
        `  - ${JSON.stringify(label)}${description === undefined ? '' : `: ${description}`}`,
    );
    return [
      `${String(i + 1)}. Question id ${JSON.stringify(question.id)}, ${JSON.stringify(question.header)} (${how}):`,
      question.text,
      ...options,
    ].join('\n');
  });
  return [first, ...questions].join('\n');
}

/**
 * How an agent is sent an answer to its ask: behind a first line saying who answers (the user's
 * answer as the user's, never as its own input) and which question it answers.
 */
export function answerFrame(nodes: readonly CanvasNode[], answer: Message): string {
  const of = answer.ask?.type === 'answer' ? answer.ask.of : answer.replyTo;
  const agent = agentOf(answer.from);
  const outside = outsideOf(answer.from);
  const who =
    answer.from === 'you'
      ? 'the user (the user’s answer, given in corrallm'
      : agent !== undefined
        ? `agent ${quotedParty(nodes, answer.from)} (an agent, not the user`
        : outside !== undefined
          ? `${quotedName(outside)} (an orchestrator outside corrallm, not the user`
          : 'corrallm (corrallm itself, not the user';
  return `[corrallm] Answer from ${who}; message ${answer.id}, answering your question ${of ?? ''}):\n${answer.body}`;
}

/**
 * How an agent is sent a continuation of its task (B21 C7): its frame (`framed`: the answer's, or
 * the record's of how its ask ended), then the questions it asked (`ask`, its own words, quoted
 * back), so that a fresh conversation (after a switch) can carry on, and a line saying to.
 */
export function continuationFrame(
  framed: string,
  ask: Message | undefined,
  answered: boolean,
): string {
  const column = ask?.ask?.type === 'question' ? ask.ask : undefined;
  return [
    framed,
    'Your question, asked during your current task:',
    ...(column?.questions ?? []).map(
      (question, i) =>
        `${String(i + 1)}. ${JSON.stringify(question.header || question.id)}: ${question.text}`,
    ),
    answered
      ? 'Carry on with that task now, and end it as its step asked.'
      : 'Carry on with that task now without its answer, and end it as its step asked.',
  ].join('\n');
}

/** An answer's body, in corrallm's words: each question with its answer, quoted. */
function answerBody(of: string, questions: readonly AskQuestion[], answer: AskAnswer): string {
  if ('text' in answer) {
    return [
      `Answer to your question ${of}, in the reply’s own words:`,
      ...questions.map((question) => `- ${JSON.stringify(question.header || question.id)}`),
      answer.text,
    ].join('\n');
  }
  return [
    `Answers to your question ${of}:`,
    ...questions.map((question) => {
      const given = answer.answers[question.id];
      const said =
        given === undefined
          ? 'no answer'
          : 'picked' in given
            ? `picked ${given.picked.map((label) => JSON.stringify(label)).join(', ')}`
            : `in their own words: ${given.text}`;
      return `- ${JSON.stringify(question.header || question.id)} (${JSON.stringify(question.id)}): ${said}`;
    }),
  ].join('\n');
}

function unsaved(what: string, error: unknown): string {
  return `The ${what} could not be saved, so it was not sent (${reasonOf(error)}).`;
}

function reasonOf(error: unknown): string {
  return threadTitle(error instanceof Error ? error.message : String(error), 1000);
}
