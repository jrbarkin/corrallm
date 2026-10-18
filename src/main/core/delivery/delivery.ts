import { randomUUID } from 'node:crypto';

import { MAX_MESSAGE_BYTES } from '../../../shared/api/limits';
import type { CanvasId } from '../../../shared/canvas';
import { needs } from '../../../shared/engine/needs';
import type { Engine } from '../../../shared/engine/engine';
import type { AgentNode, CanvasNode } from '../../../shared/model/canvas';
import { agentOf, agentParty } from '../../../shared/model/messages';
import type { Message, PartyId } from '../../../shared/model/messages';
import { agentName } from '../../../shared/model/queries';
import { holdText, resetTime } from '../../../shared/model/words';
import { turnResult } from '../../../shared/session';
import type { TurnResult } from '../../../shared/session';
import type { UsageHold } from '../../../shared/usage';
import type { MessageStore } from './messages';

/*
 * Delivering a canvas's messages (API Spec §5.5 to §5.7, Core Server §5.9). A message to an agent
 * waits until the agent is idle (no turn going, nothing asked, nothing queued in its session) and
 * nothing holds it: its own or its group's pause (a kill too), a session that would not start (it
 * stays first in line), or its backend's usage rule. Then it is journaled as delivering, with the
 * id it will be sent under, forced to disk, and only then sent, whether or not a run is going: a
 * whole-run Stop, and the paused state a run restores in, hold only the run's own sends. What you
 * send goes past those holds into the session's queue, as you typed it; anything else reaches the
 * agent behind a first line saying whom it is from, so the agent's CLI never takes it for its
 * user's. When a message's turn ends, what the agent replied is a message to its sender, with how
 * the turn ended: delivered to an agent as a turn, kept for anyone else to read, and never answered
 * by another reply. corrallm tells a sender once when its message waits on something (a session
 * that won't start, a usage window) or its turn waits for you, and when it ends withdrawn or
 * unresolved.
 */

export interface DeliveryDeps {
  canvas: CanvasId;
  engine: Engine;
  store: MessageStore;
  /** The canvas's nodes now. */
  nodes: () => readonly CanvasNode[];
  now: () => number;
  later: (run: () => void, ms: number) => () => void;
  /** The locale times of day are told in (the host's): the runtime's own, when none. */
  locale?: string;
}

/** What holds a message to an agent, if anything does. */
type Hold =
  | { kind: 'paused' | 'busy' }
  | { kind: 'stuck'; text: string }
  | { kind: 'usage'; hold: UsageHold };

/** Why a session would not start, and the connection it would not start on. */
interface Stuck {
  connection: string;
  text: string;
}

/** What an agent with no connection this build runs is told. */
const NO_CONNECTION = 'it has no connection corrallm can run.';
/** What a message cut off is said to have been. */
const CUT_OFF: TurnResult = { status: 'cancelled', reason: 'connection-closed' };
/** What a message taken back is said to have been. */
const TAKEN_BACK: TurnResult = { status: 'cancelled', reason: 'taken-back' };
/** How a reply cut to the most a message holds is marked. */
const CUT = '\n\n[corrallm: cut here; the whole reply is in its transcript]';

export class Delivery {
  readonly #deps: DeliveryDeps;
  /** What takes each message being delivered back from its agent's session, by the message's id. */
  readonly #sent = new Map<string, () => void>();
  /** The agents a message is being journaled for, before it is sent: nothing else starts meanwhile. */
  readonly #writing = new Set<string>();
  /** Who asked for each message whose turn is going to be taken back, by its id. */
  readonly #withdrawing = new Map<string, PartyId>();
  /** What each party was told, so that it is told once. */
  readonly #told = new Set<string>();
  /** The agents whose sessions would not start, by id. */
  readonly #stuck = new Map<string, Stuck>();
  /** What wakes delivery when a usage window resets. */
  #alarm: { at: number; cancel: () => void } | undefined;
  #scheduled = false;
  #closed = false;
  readonly #stop: (() => void)[];

  constructor(deps: DeliveryDeps) {
    this.#deps = deps;
    const schedule = () => {
      this.schedule();
    };
    this.#stop = [deps.engine.sessions.subscribe(schedule), deps.engine.run.subscribe(schedule)];
  }

  /**
   * Starts delivering, as the canvas opens: a message that was being delivered, or delivered with
   * no turn end, when the core last stopped is unresolved (its sender told so), and never sent
   * again; what was waiting goes once it can.
   */
  async start(): Promise<void> {
    for (const message of this.#deps.store.all()) {
      if (this.#inFlight(message)) this.#cutOff(message);
    }
    await this.#deps.store.durable();
    this.schedule();
  }

  /**
   * Stops delivering, as the canvas closes: a message being delivered, or whose turn is going, is
   * unresolved (its sender told so), before its session closes. Rejects if that can't be journaled.
   */
  async close(): Promise<void> {
    this.#closed = true;
    for (const stop of this.#stop) stop();
    this.#alarm?.cancel();
    this.#alarm = undefined;
    for (const message of this.#deps.store.all()) {
      if (this.#inFlight(message)) this.#cutOff(message);
    }
    await this.#deps.store.durable();
  }

  /** Looks again, soon, at what waits: once, however often asked before then. */
  schedule(): void {
    if (this.#scheduled || this.#closed) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#pump();
    });
  }

  /**
   * Sends agent `to` a message from `from`, once its record is on disk: delivered at once if it
   * can be, and otherwise held, its sender told why. Resolves with it, as kept.
   */
  async send(from: PartyId, to: string, body: string, replyTo?: string): Promise<Message> {
    const message = this.#deps.store.add({
      from,
      to: agentParty(to),
      kind: 'text',
      body,
      state: 'pending',
      ...(replyTo === undefined ? {} : { replyTo }),
    });
    await this.#deps.store.durable();
    this.#pump();
    return this.#deps.store.get(message.id) ?? message;
  }

  /**
   * Takes back a message for `by`: one still waiting is withdrawn at once; one being delivered is
   * taken off its session's queue, or its turn interrupted, and is withdrawn once that ends.
   * Throws, saying why, a message that can't be.
   */
  withdraw(id: string, by: PartyId): void {
    const message = this.#deps.store.get(id);
    if (!message) throw new DeliveryError('not-found', 'There is no such message.');
    if (by !== 'you' && message.from !== by) {
      throw new DeliveryError('refused', 'Only a message you sent can be taken back.');
    }
    if (message.state === 'pending') {
      this.#withdrawn(message, by);
      this.schedule();
      return;
    }
    if (!this.#inFlight(message)) {
      throw new DeliveryError('conflict', `That message is ${stateWords(message)} already.`);
    }
    if (by !== message.from) {
      throw new DeliveryError(
        'refused',
        'Another party’s message can be taken back only while it waits; interrupt its turn instead.',
      );
    }
    this.#takeBack(message, by);
  }

  /**
   * An agent was killed (by `by`): every message to or from it still waiting is withdrawn, and
   * every one being delivered is taken back, its turn interrupted.
   */
  kill(agent: string, by: PartyId): void {
    const party = agentParty(agent);
    for (const message of this.#deps.store.all()) {
      if (message.kind !== 'text' || (message.to !== party && message.from !== party)) continue;
      if (message.state === 'pending') this.#withdrawn(message, by);
      else if (this.#inFlight(message)) this.#takeBack(message, by);
    }
    this.schedule();
  }

  /** The agents whose sessions won't start while parties' messages to them wait, and why. */
  stuck(): { agent: string; text: string }[] {
    return this.#deps.nodes().flatMap((node) => {
      const text = node.type === 'agent' ? this.#stuckOf(node) : undefined;
      return text !== undefined && this.#waiting(node.id).length > 0
        ? [{ agent: node.id, text }]
        : [];
    });
  }

  /** The message whose turn an agent is on, if one is. */
  current(agent: string): string | undefined {
    const session = this.#deps.engine.sessions.of(agent);
    return this.#deps.store
      .all()
      .find(
        (message) =>
          message.to === agentParty(agent) &&
          this.#inFlight(message) &&
          session.entries.some((entry) => entry.id === message.delivery?.as),
      )?.id;
  }

  /**
   * Delivers what can be: for each agent, yours at once, then the first message of anyone else's
   * that nothing holds; and tells each sender, once, what holds its message, and what its turn
   * waits for.
   */
  #pump(): void {
    if (this.#closed) return;
    const { engine, store } = this.#deps;
    const messages = store.all();
    // Each message the session has now is delivered.
    for (const message of messages) {
      if (message.state !== 'delivering' || message.delivery === undefined) continue;
      const agent = agentOf(message.to);
      const entry =
        agent === undefined
          ? undefined
          : engine.sessions.of(agent).entries.find(({ id }) => id === message.delivery?.as);
      if (entry?.kind === 'user' && entry.reached === true) {
        store.update(message.id, { state: 'delivered' });
      }
    }
    /** What waits for each agent, in the order it came. */
    const waiting = new Map<string, Message[]>();
    for (const message of messages) {
      const agent = agentOf(message.to);
      if (agent === undefined || message.state !== 'pending') continue;
      waiting.set(agent, [...(waiting.get(agent) ?? []), message]);
    }
    this.#tellWaiting(messages);
    let alarm: number | undefined;
    for (const node of this.#deps.nodes()) {
      if (node.type !== 'agent') continue;
      // Once a party's message is held, the parties' behind it wait their turn; yours go past.
      let held = false;
      for (const message of waiting.get(node.id) ?? []) {
        if (this.#writing.has(node.id)) break;
        const yours = message.from === 'you';
        if (held && !yours) continue;
        // Yours go past the run's holds, into its session's queue, unless that won't start.
        const hold = yours ? this.#stuckHold(node) : this.#holdOf(node);
        if (!hold) {
          this.#deliver(node, message);
          break;
        }
        if (hold.kind === 'stuck') {
          this.#tell(
            `stuck:${node.id}:${message.from}`,
            message,
            `${this.#name(node.id)} can’t start, so your message waits: ${hold.text}`,
          );
        }
        if (hold.kind === 'usage') {
          const until = hold.hold.resetsAt;
          if (until !== null) alarm = Math.min(alarm ?? until, until);
          this.#tell(
            `usage:${node.id}:${String(until)}:${message.from}`,
            message,
            `${holdText(hold.hold, engine.catalog)}, so your message to ${this.#name(node.id)} waits until ${
              until === null
                ? 'its usage is read again'
                : `it resets at ${resetTime(until, this.#deps.now(), this.#deps.locale)}`
            }.`,
          );
        }
        if (yours) break;
        held = true;
      }
    }
    this.#arm(alarm);
  }

  /** The messages waiting for agent `agent`, in the order they came. */
  #waiting(agent: string): Message[] {
    const party = agentParty(agent);
    return this.#deps.store
      .all()
      .filter((message) => message.to === party && message.state === 'pending');
  }

  /** What holds a message from you to agent `node` now: only a session that won't start. */
  #stuckHold(node: AgentNode): Hold | undefined {
    const text = this.#stuckOf(node);
    return text === undefined ? undefined : { kind: 'stuck', text };
  }

  /** What holds a message from a party (anyone but you) to agent `node` now, if anything. */
  #holdOf(node: AgentNode): Hold | undefined {
    const { engine } = this.#deps;
    const at = engine.run.snapshot().agents[node.id];
    if (at?.paused) return { kind: 'paused' };
    const stuck = this.#stuckOf(node);
    if (stuck !== undefined) return { kind: 'stuck', text: stuck };
    const session = engine.sessions.of(node.id);
    if (
      session.status !== 'idle' ||
      session.queued.length > 0 ||
      (session.asking?.length ?? 0) > 0
    ) {
      return { kind: 'busy' };
    }
    if (at?.usage) return { kind: 'usage', hold: at.usage };
    const rule = engine.run.usageRule(node.id, this.#deps.now());
    if (!rule) return undefined;
    if (rule.action === 'warn') {
      engine.run.warnUsage(node.id, rule.hold, this.#deps.now());
      return undefined;
    }
    // With no one to ask headless, a rule that asks holds the message until the window resets.
    return { kind: 'usage', hold: rule.hold };
  }

  /**
   * Why agent `node`'s session won't start, if it won't: it has no connection this build runs, or
   * it refused to start on the connection it runs, and hasn't started since.
   */
  #stuckOf(node: AgentNode): string | undefined {
    const { engine } = this.#deps;
    const connection = engine.catalog.connectionOf(node.data);
    if (connection === 'unavailable') return NO_CONNECTION;
    const stuck = this.#stuck.get(node.id);
    if (!stuck) return undefined;
    if (stuck.connection === connection && engine.sessions.of(node.id).running === undefined) {
      return stuck.text;
    }
    // It runs another way now, or started after all: what waited on it goes.
    this.#stuck.delete(node.id);
    for (const key of [...this.#told]) {
      if (key.startsWith(`stuck:${node.id}:`)) this.#told.delete(key);
    }
    return undefined;
  }

  /**
   * Delivers a message: journaled as delivering, with the id it will be sent under, forced to disk,
   * then sent to its agent's session.
   */
  #deliver(node: AgentNode, message: Message): void {
    const as = randomUUID();
    const attempt = (message.delivery?.attempt ?? 0) + 1;
    this.#deps.store.update(message.id, {
      state: 'delivering',
      delivery: { at: this.#deps.now(), as, attempt },
    });
    this.#writing.add(node.id);
    void this.#deps.store.durable().then(
      () => {
        this.#writing.delete(node.id);
        if (this.#closed || this.#deps.store.get(message.id)?.state !== 'delivering') return;
        this.#hand(node, message, as);
      },
      (error: unknown) => {
        this.#writing.delete(node.id);
        const now = this.#deps.store.get(message.id);
        if (now?.state !== 'delivering') return;
        const why = error instanceof Error ? error.message : String(error);
        this.#deps.store.update(message.id, {
          state: 'unresolved',
          turn: { status: 'failed', reason: 'error', message: why },
        });
        this.#notice(
          message,
          `Your message to ${this.#name(node.id)} wasn’t sent: corrallm couldn’t record it (${why}).`,
          { status: 'failed', reason: 'error', message: why },
        );
        this.schedule();
      },
    );
  }

  /** Hands a message, journaled, to its agent's session: as you typed it, or framed. */
  #hand(node: AgentNode, message: Message, as: string): void {
    const { engine } = this.#deps;
    const yours = message.from === 'you';
    const takeBack = engine.sessions.send(
      node.id,
      node.data.adapter ?? engine.catalog.defaultAdapter,
      yours ? message.body : this.#frame(message),
      (interrupted, reply, result) => {
        this.#ended(message.id, interrupted, reply, result);
      },
      undefined,
      (refusal) => {
        this.#refused(node, message.id, refusal.text);
      },
      yours ? 'user' : 'queue',
      undefined,
      as,
    );
    this.#sent.set(message.id, takeBack);
  }

  /** A message's turn ended: it was withdrawn, or replied to, its reply a message to its sender. */
  #ended(id: string, interrupted: boolean, reply: string, result: TurnResult | undefined): void {
    this.#sent.delete(id);
    const { store } = this.#deps;
    const message = store.get(id);
    // Cut off as the canvas closed, or back to waiting: its session would not start.
    if (this.#closed || !message || !this.#inFlight(message)) return;
    const by = this.#withdrawing.get(id);
    this.#withdrawing.delete(id);
    if (by !== undefined) {
      this.#withdrawn(message, by);
      this.schedule();
      return;
    }
    store.update(id, { state: 'replied' });
    // A reply never makes a reply.
    if (message.turn === undefined) {
      store.add({
        from: message.to,
        to: message.from,
        kind: 'text',
        body: cut(reply),
        replyTo: id,
        turn: result ?? turnResult({ interrupted }),
        state: agentOf(message.from) === undefined ? 'delivered' : 'pending',
      });
    }
    this.schedule();
  }

  /**
   * An agent's session would not start, so a message sent it never went: it waits again, first in
   * line, until the agent runs another way (or its session starts after all).
   */
  #refused(node: AgentNode, id: string, text: string): void {
    if (this.#closed || this.#deps.store.get(id)?.state !== 'delivering') return;
    this.#deps.store.update(id, { state: 'pending' });
    this.#stuck.set(node.id, {
      connection: this.#deps.engine.catalog.connectionOf(node.data),
      text,
    });
    // It waits here, not in its session's queue.
    const takeBack = this.#sent.get(id);
    this.#sent.delete(id);
    takeBack?.();
    this.schedule();
  }

  /** Takes back a message being delivered for `by`: withdrawn once its turn has ended. */
  #takeBack(message: Message, by: PartyId): void {
    const takeBack = this.#sent.get(message.id);
    if (!takeBack) {
      // Still being journaled: it is never sent.
      this.#withdrawn(message, by);
      return;
    }
    this.#withdrawing.set(message.id, by);
    takeBack();
  }

  /** Withdraws a message for `by`, telling its sender when someone else did. */
  #withdrawn(message: Message, by: PartyId): void {
    this.#deps.store.update(message.id, { state: 'withdrawn', by });
    if (by !== message.from) {
      this.#notice(
        message,
        `Your message to ${this.#nameOf(message.to)} was withdrawn by ${this.#nameOf(by)}.`,
        TAKEN_BACK,
      );
    }
  }

  /** A message cut off as the core stopped: unresolved, never sent again, its sender told. */
  #cutOff(message: Message): void {
    this.#deps.store.update(message.id, { state: 'unresolved' });
    this.#notice(
      message,
      `Your message to ${this.#nameOf(message.to)} was cut off when corrallm stopped; it won’t be sent again.`,
      CUT_OFF,
    );
  }

  /** Tells each party whose message's turn waits for you so, once: by what it waits for. */
  #tellWaiting(messages: readonly Message[]): void {
    const { engine } = this.#deps;
    const turns = messages.flatMap((message) => {
      const agent = agentOf(message.to);
      if (
        agent === undefined ||
        message.from === 'you' ||
        !this.#inFlight(message) ||
        this.#told.has(`waiting:${message.id}`)
      ) {
        return [];
      }
      // Its turn has started: the session has it.
      const { entries } = engine.sessions.of(agent);
      return entries.some((entry) => entry.id === message.delivery?.as) ? [{ agent, message }] : [];
    });
    if (turns.length === 0) return;
    const waiting = needs({
      canvas: this.#deps.canvas,
      nodes: this.#deps.nodes(),
      run: engine.run.snapshot(),
      sessions: engine.sessions.snapshot(),
      catalog: engine.catalog,
      now: this.#deps.now(),
      ...(this.#deps.locale === undefined ? {} : { locale: this.#deps.locale }),
    });
    for (const { agent, message } of turns) {
      const waits = waiting.find((item) => item.agent === agent);
      if (waits) {
        this.#tell(
          `waiting:${message.id}`,
          message,
          `${this.#name(agent)} is waiting for you: ${waits.title}`,
        );
      }
    }
  }

  /** Tells a message's sender `text`, once for `key`. */
  #tell(key: string, message: Message, text: string): void {
    if (this.#told.has(key)) return;
    this.#told.add(key);
    this.#notice(message, text);
  }

  /** A notice to a message's sender, about it: a record, never delivered as a turn. */
  #notice(message: Message, text: string, turn?: TurnResult): void {
    if (message.from === 'corrallm') return;
    this.#deps.store.add({
      from: 'corrallm',
      to: message.from,
      kind: 'notice',
      body: text,
      replyTo: message.id,
      ...(turn === undefined ? {} : { turn }),
      state: 'delivered',
    });
  }

  /**
   * A message from anyone but you, as its agent is told it: behind a first line saying whom it is
   * from (and, for a reply, what it replies to), so the agent never takes it for its user's.
   */
  #frame(message: Message): string {
    const { from, id, replyTo, turn, body } = message;
    const agent = agentOf(from);
    const outside = from.startsWith('outside:') ? from.slice('outside:'.length) : undefined;
    const [who, what] =
      agent !== undefined
        ? [`agent "${this.#name(agent)}"`, 'an agent']
        : outside !== undefined
          ? [`"${outside}"`, 'an orchestrator outside corrallm']
          : ['corrallm', 'corrallm itself'];
    const about =
      turn !== undefined && replyTo !== undefined
        ? `Reply from ${who} (${what}, not the user; message ${id}, replying to your message ${replyTo})`
        : `Message from ${who} (${what}, not the user; message ${id})`;
    return `[corrallm] ${about}:\n${body}`;
  }

  /** Whether a message to an agent is in its hands: being delivered, or its turn going on. */
  #inFlight(message: Message): boolean {
    return (
      message.kind === 'text' &&
      agentOf(message.to) !== undefined &&
      (message.state === 'delivering' || message.state === 'delivered')
    );
  }

  /** Wakes delivery when the first usage window it waits on resets. */
  #arm(at: number | undefined): void {
    if (this.#alarm?.at === at) return;
    this.#alarm?.cancel();
    this.#alarm = undefined;
    if (at === undefined) return;
    const cancel = this.#deps.later(
      () => {
        this.#alarm = undefined;
        this.schedule();
      },
      Math.max(0, at - this.#deps.now()) + 1,
    );
    this.#alarm = { at, cancel };
  }

  /** An agent's name. */
  #name(agent: string): string {
    return agentName(this.#deps.nodes(), agent);
  }

  /** A party, as a notice names it. */
  #nameOf(party: PartyId): string {
    const agent = agentOf(party);
    if (agent !== undefined) return this.#name(agent);
    return party === 'you' ? 'you' : party === 'corrallm' ? 'corrallm' : `“${party.slice(8)}”`;
  }
}

/** Why a message couldn't be taken back: a code, as an operation's failure carries it. */
export class DeliveryError extends Error {
  readonly code: 'not-found' | 'refused' | 'conflict';

  constructor(code: DeliveryError['code'], sentence: string) {
    super(sentence);
    this.name = 'DeliveryError';
    this.code = code;
  }
}

/** Where a settled message is, in words: "withdrawn", "answered by its turn's end". */
function stateWords({ state, kind }: Message): string {
  if (kind !== 'text') return 'a record, which is never delivered';
  switch (state) {
    case 'replied':
      return 'replied to';
    case 'delivered':
      return 'delivered';
    default:
      return state;
  }
}

/** A reply cut to the most a message holds, marked where it was cut. */
function cut(reply: string): string {
  const bytes = new TextEncoder().encode(reply);
  if (bytes.length <= MAX_MESSAGE_BYTES) return reply;
  const room = MAX_MESSAGE_BYTES - new TextEncoder().encode(CUT).length;
  // Cut on a character's boundary: the decoder drops a partial last one.
  const kept = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, room));
  return `${kept.replace(/�$/u, '')}${CUT}`;
}
