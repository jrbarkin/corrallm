import { randomUUID } from 'node:crypto';

import { MAX_MESSAGE_BYTES, MAX_WAITING } from '../../../shared/api/limits';
import type { CanvasId } from '../../../shared/canvas';
import { needsItem, needsOf } from '../../../shared/engine/needs';
import type { NeedsInput } from '../../../shared/engine/needs';
import type { Engine } from '../../../shared/engine/engine';
import type { PauseCause } from '../../../shared/engine/run/runner';
import type { AgentNode, CanvasNode } from '../../../shared/model/canvas';
import { agentOf, agentParty, outsideOf } from '../../../shared/model/messages';
import type { Message, PartyId } from '../../../shared/model/messages';
import { threadTitle } from '../../../shared/model/session';
import { holdText, resetTime } from '../../../shared/model/words';
import { turnResult } from '../../../shared/session';
import type { TurnReason, TurnResult } from '../../../shared/session';
import type { UsageHold } from '../../../shared/usage';
import { nameOf, partyName, partyText, pausesText, RELEASES } from '../parties';
import type { MessageStore } from './messages';

/*
 * Delivering a canvas's messages (API Spec §5.5 to §5.7, Core Server §5.9). A message to an agent
 * waits until the agent is idle (no turn going, nothing asked, nothing queued in its session) and
 * nothing holds it: its own or its group's pause (a kill too), a session that would not start (it
 * stays first in line), a session running in a mode that never asks (which no party's text drives),
 * or its backend's usage rule. Then it is journaled as delivering, with the id it will be sent
 * under, forced to disk, and only then sent, whether or not a run is going: a whole-run Stop, and
 * the paused state a run restores in, hold only the run's own sends. What you send goes past those
 * holds into the session's queue, as you typed it; anything else reaches the agent behind a first
 * line saying whom it is from, so the agent's CLI never takes it for its user's. When a message's turn ends, what the agent replied is a message to its sender, with how
 * the turn ended: delivered to an agent as a turn, kept for anyone else to read, and never answered
 * by another reply. corrallm tells a sender once when its message waits on something (a pause, a
 * session that won't start, a mode that never asks, a usage window) or its turn waits for you, and
 * when it ends withdrawn or unresolved.
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

/** Why an agent's session won't start, and what would let it. */
interface Unstartable {
  text: string;
  clears: string;
}

/** What holds a message to an agent, if anything does. */
type Hold =
  | { kind: 'busy' }
  | { kind: 'paused'; holding: PauseCause[] }
  | ({ kind: 'stuck' } & Unstartable)
  | { kind: 'unasking' }
  | { kind: 'usage'; hold: UsageHold; until: number };

/**
 * Why a session would not start, the connection it would not start on, when it refused, and
 * whether a message sent since is trying it again.
 */
interface Stuck {
  connection: string;
  text: string;
  at: number;
  retrying: boolean;
}

/** What an agent with no connection this build runs is told. */
const NO_CONNECTION = 'it has no connection corrallm can run.';
/** What lets such an agent start. */
const SWITCH = 'It starts once it is switched to another connection in the corrallm app.';
/** How long after its session refused to start the next message sent an agent tries it again. */
const RETRY_AFTER = 60 * 1000;
/** What lets a session that refused to start go (RETRY_AFTER, in words). */
const RETRIES =
  'It tries to start again with the next message sent to it a minute or more after it refused, or once it is switched to another connection in the corrallm app.';
/** What a message cut off is said to have been. */
const CUT_OFF: TurnResult = { status: 'cancelled', reason: 'connection-closed' };
/** What a message taken back is said to have been. */
const TAKEN_BACK: TurnResult = { status: 'cancelled', reason: 'taken-back' };
/**
 * The most characters of a prompt's title, or an agent's name, a notice quotes, on one line and
 * cut at a word: a capped title, never a whole command (API Spec §5.8).
 */
const TITLE = 120;
/**
 * The most characters of why a session won't start, or a message couldn't be recorded, a notice
 * quotes: with its titles and names, a notice stays far within MAX_MESSAGE_BYTES.
 */
const REASON = 1000;
/** How a reply cut to the most a message holds is marked. */
const CUT = '\n\n[corrallm: cut here; the whole reply is in its transcript]';
/** How long after a delivering record couldn't be forced to disk delivery tries again. */
const RECORD_RETRY = 1000;

export class Delivery {
  readonly #deps: DeliveryDeps;
  /** What takes each message being delivered back from its agent's session, by the message's id. */
  readonly #sent = new Map<string, () => void>();
  /** The agents a message is being journaled for, before it is sent: nothing else starts meanwhile. */
  readonly #writing = new Set<string>();
  /** The messages sent whose records are on their way to disk: none goes before it is there. */
  readonly #recording = new Set<string>();
  /** Who asked for each message whose turn is going to be taken back, by its id. */
  readonly #withdrawing = new Map<string, PartyId>();
  /** What each party was told, so that it is told once (kept with each notice, by its key). */
  readonly #told = new Set<string>();
  /** The agents whose sessions would not start, by id. */
  readonly #stuck = new Map<string, Stuck>();
  /** What wakes delivery when a usage window resets. */
  #alarm: { at: number; cancel: () => void } | undefined;
  /**
   * While a delivering record couldn't be forced to disk: what tries again (RECORD_RETRY later).
   * Nothing is delivered meanwhile.
   */
  #unrecordable: (() => void) | undefined;
  #scheduled = false;
  /** Whether it delivers yet: not until it starts, though messages may be sent before. */
  #started = false;
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
   * Starts delivering, as the canvas opens (or once its host says, Engines.deliver): a message
   * that was being delivered, or delivered with
   * no turn end, when the core last stopped is unresolved (its sender told so), and never sent
   * again, and so is one that waited in a log the store set aside as broken with no record read
   * after the broken line (it may have gone); what was waiting, or was sent before it started,
   * goes once it can. Once only.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const { store } = this.#deps;
    // What its senders were told before, they were told once.
    for (const key of store.told()) this.#told.add(key);
    for (const message of store.all()) {
      if (this.#inFlight(message)) this.#cutOff(message);
      else if (message.state === 'pending' && store.doubtful.has(message.id)) this.#unread(message);
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
    this.#unrecordable?.();
    this.#unrecordable = undefined;
    for (const message of this.#deps.store.all()) {
      if (this.#inFlight(message)) this.#cutOff(message);
    }
    await this.#deps.store.durable();
  }

  /** Looks again, soon, at what waits: once, however often asked before then. */
  schedule(): void {
    if (this.#scheduled || !this.#started || this.#closed) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      this.#pump();
    });
  }

  /**
   * Sends agent `to` a message from `from`, once its record is on disk: delivered at once if it
   * can be, and otherwise held, its sender told why. A message sent RETRY_AFTER or more after the
   * agent's session refused to start tries it again. Resolves with it, as kept; rejects, the message
   * unresolved and never sent, if its record can't reach the disk. Throws, saying why, a message
   * from a party (anyone but you) that has MAX_WAITING waiting for that agent already.
   */
  async send(from: PartyId, to: string, body: string, replyTo?: string): Promise<Message> {
    const { store } = this.#deps;
    if (
      from !== 'you' &&
      this.#waiting(to).filter((message) => message.from === from).length >= MAX_WAITING
    ) {
      throw new DeliveryError(
        'refused',
        `${this.#name(to)} already has ${String(MAX_WAITING)} of your messages waiting; send another once one of them goes.`,
      );
    }
    const message = store.add({
      from,
      to: agentParty(to),
      kind: 'text',
      body,
      state: 'pending',
      ...(replyTo === undefined ? {} : { replyTo }),
    });
    this.#recording.add(message.id);
    try {
      await store.durable();
    } catch (error) {
      store.update(message.id, { state: 'unresolved', turn: unrecorded(error) });
      throw error;
    } finally {
      this.#recording.delete(message.id);
    }
    const stuck = this.#stuck.get(to);
    if (stuck && this.#deps.now() - stuck.at >= RETRY_AFTER) stuck.retrying = true;
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
    if (message.kind !== 'text') {
      throw new DeliveryError(
        'conflict',
        'That message is a record; records are never delivered, so there is nothing to take back.',
      );
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

  /**
   * The agents whose sessions won't start while parties' messages to them wait, why, and what
   * would let them.
   */
  stuck(): ({ agent: string } & Unstartable)[] {
    return this.#deps.nodes().flatMap((node) => {
      const stuck = node.type === 'agent' ? this.#stuckOf(node) : undefined;
      return stuck !== undefined && this.#waiting(node.id).length > 0
        ? [{ agent: node.id, ...stuck }]
        : [];
    });
  }

  /** The agents whose sessions run in a mode that never asks while parties' messages to them wait. */
  unasking(): string[] {
    return this.#deps
      .nodes()
      .flatMap((node) =>
        node.type === 'agent' &&
        this.#unasking(node) &&
        this.#waiting(node.id).some(({ from }) => from !== 'you')
          ? [node.id]
          : [],
      );
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
   * Delivers what can be: for each agent, the first message waiting that nothing holds (yours go
   * past what holds everyone else's); and tells each sender, once, what holds its messages, and
   * what its turn waits for. What waited for an agent no longer on the canvas, or from one, is
   * withdrawn first.
   */
  #pump(): void {
    if (!this.#started || this.#closed) return;
    const { engine, store } = this.#deps;
    this.#withdrawGone();
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
      if (agent === undefined || message.state !== 'pending' || this.#recording.has(message.id)) {
        continue;
      }
      waiting.set(agent, [...(waiting.get(agent) ?? []), message]);
    }
    this.#tellWaiting(messages);
    let alarm: number | undefined;
    for (const node of this.#deps.nodes()) {
      if (node.type !== 'agent') continue;
      this.#forgetReleased(node);
      const waits = waiting.get(node.id);
      if (!waits || this.#writing.has(node.id)) continue;
      // Yours go past the run's holds, into its session's queue, unless that won't start; what
      // holds a party's message holds every party's behind it.
      const holds = {
        yours: this.#stuckHold(node),
        theirs: waits.some(({ from }) => from !== 'you') ? this.#holdOf(node) : undefined,
      };
      let next: Message | undefined;
      for (const message of waits) {
        const hold = message.from === 'you' ? holds.yours : holds.theirs;
        if (!hold) {
          next ??= message;
          continue;
        }
        if (hold.kind === 'paused') {
          const causes = hold.holding.map(({ id, by }) => `${id}/${by}`).join(',');
          this.#tell(
            holdKey('paused', node.id, causes, message.from),
            message,
            `${this.#name(node.id)} is paused by ${pausesText(this.#deps.nodes(), node.id, hold.holding)}, so your message waits until it is released: ${RELEASES}`,
          );
        }
        if (hold.kind === 'stuck') {
          this.#tell(
            holdKey('stuck', node.id, message.from),
            message,
            `${this.#name(node.id)} can’t start, so your message waits: ${threadTitle(hold.text, REASON)} ${hold.clears}`,
          );
        }
        if (hold.kind === 'unasking') {
          this.#tell(
            holdKey('unasking', node.id, message.from),
            message,
            `${this.#name(node.id)} runs in a mode that never asks before it acts, so your message waits until it runs in one that asks again: only the user can switch it.`,
          );
        }
        if (hold.kind === 'usage') {
          const { until } = hold;
          alarm = Math.min(alarm ?? until, until);
          this.#tell(
            holdKey('usage', node.id, String(until), message.from),
            message,
            `${holdText(hold.hold, engine.catalog)}, so your message to ${this.#name(node.id)} waits until it resets at ${resetTime(until, this.#deps.now(), this.#deps.locale)}.`,
          );
        }
      }
      if (next === undefined || this.#unrecordable) continue;
      if (next.from !== 'you') this.#warnUsage(node);
      this.#deliver(node, next);
    }
    this.#arm(alarm);
  }

  /**
   * Withdraws (for corrallm) each message waiting for an agent no longer on the canvas, telling its
   * sender, and each one waiting from such an agent (API Spec §7.2).
   */
  #withdrawGone(): void {
    const here = new Set(
      this.#deps.nodes().flatMap((node) => (node.type === 'agent' ? [node.id] : [])),
    );
    const gone = (party: PartyId) => {
      const agent = agentOf(party);
      return agent !== undefined && !here.has(agent) ? agent : undefined;
    };
    for (const message of this.#deps.store.all()) {
      if (message.kind !== 'text' || message.state !== 'pending') continue;
      const to = gone(message.to);
      if (to === undefined && gone(message.from) === undefined) continue;
      this.#deps.store.update(message.id, { state: 'withdrawn', by: 'corrallm' });
      if (to !== undefined && gone(message.from) === undefined) {
        this.#notice(
          message,
          `Your message was withdrawn: the agent it was for, ${threadTitle(to, TITLE)}, is no longer on the canvas.`,
          TAKEN_BACK,
        );
      }
    }
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
    const stuck = this.#stuckOf(node);
    return stuck === undefined ? undefined : { kind: 'stuck', ...stuck };
  }

  /** What holds a message from a party (anyone but you) to agent `node` now, if anything. */
  #holdOf(node: AgentNode): Hold | undefined {
    const { engine } = this.#deps;
    const holding = engine.run.holding({ agent: node.id });
    if (holding.length > 0) return { kind: 'paused', holding };
    const stuck = this.#stuckHold(node);
    if (stuck !== undefined) return stuck;
    if (this.#unasking(node)) return { kind: 'unasking' };
    const session = engine.sessions.of(node.id);
    if (
      session.status !== 'idle' ||
      session.queued.length > 0 ||
      (session.asking?.length ?? 0) > 0
    ) {
      return { kind: 'busy' };
    }
    // A usage hold the run set (AgentRun.usage) is this rule, with your Go on or Wait for the reset,
    // read now: so one a stopped run left, or whose window has reset, holds nothing.
    const rule = this.#holdingRule(node);
    // With no one to ask headless, a rule that asks holds the message until the window resets.
    return rule === undefined
      ? undefined
      : { kind: 'usage', hold: rule.hold, until: rule.hold.resetsAt };
  }

  /**
   * Whether agent `node`'s session runs, now, in a mode its adapter says never asks: it acts on
   * whatever it is sent, so a party's text would act unchecked. One that doesn't run starts in its
   * own mode, which always asks.
   */
  #unasking(node: AgentNode): boolean {
    const { catalog, sessions } = this.#deps.engine;
    const session = sessions.of(node.id);
    return (
      session.running !== undefined &&
      catalog.neverAsks(catalog.connectionOf(node.data), session.mode)
    );
  }

  /**
   * The usage rule that holds a party's message to agent `node` now, if one does: one over its
   * share that doesn't only warn, whose window's reset is known. Headless, nothing reads a
   * backend's usage again while its agents' messages wait (only a running session reads it), so a
   * window whose reset isn't known would hold them for good: such a rule warns instead.
   */
  #holdingRule(node: AgentNode): { hold: UsageHold & { resetsAt: number } } | undefined {
    const rule = this.#deps.engine.run.usageRule(node.id, this.#deps.now());
    if (rule === undefined || rule.action === 'warn') return undefined;
    const { hold } = rule;
    return hold.resetsAt === null ? undefined : { hold: { ...hold, resetsAt: hold.resetsAt } };
  }

  /**
   * Warns agent `node`, once a window, as a party's message starts over its rule's share: a rule
   * set to warn, or one whose window's reset isn't known (#holdingRule).
   */
  #warnUsage(node: AgentNode): void {
    const { engine } = this.#deps;
    const rule = engine.run.usageRule(node.id, this.#deps.now());
    if (rule !== undefined && this.#holdingRule(node) === undefined) {
      engine.run.warnUsage(node.id, rule.hold, this.#deps.now());
    }
  }

  /**
   * Why agent `node`'s session won't start, if it won't, and what would let it: it has no
   * connection this build runs, or it refused to start on the connection it runs, hasn't started
   * since, and no message sent since is trying it again.
   */
  #stuckOf(node: AgentNode): Unstartable | undefined {
    const { engine } = this.#deps;
    const connection = engine.catalog.connectionOf(node.data);
    if (connection === 'unavailable') return { text: NO_CONNECTION, clears: SWITCH };
    const stuck = this.#stuck.get(node.id);
    if (!stuck) return undefined;
    if (stuck.connection === connection && engine.sessions.of(node.id).running === undefined) {
      // Tried again, the first in line goes, and starts it.
      return stuck.retrying ? undefined : { text: stuck.text, clears: RETRIES };
    }
    // It runs another way now, or started after all: what waited on it goes.
    this.#stuck.delete(node.id);
    this.#forget('stuck', node.id);
    return undefined;
  }

  /**
   * Forgets what senders were told of a hold on agent `node` that is gone, so that they are told
   * again should it hold again: a pause, once nothing pauses it; a session that wouldn't start, once
   * it has started (after a restart too, when only the notices kept say it refused); a mode that
   * never asks, once it runs in none.
   */
  #forgetReleased(node: AgentNode): void {
    const { engine } = this.#deps;
    if (engine.run.holding({ agent: node.id }).length === 0) this.#forget('paused', node.id);
    if (engine.sessions.of(node.id).running !== undefined) this.#forget('stuck', node.id);
    if (!this.#unasking(node)) this.#forget('unasking', node.id);
  }

  /** Forgets what each sender was told of a hold of `kind` on agent `agent`. */
  #forget(kind: HoldKind, agent: string): void {
    const prefix = holdKey(kind, agent, '');
    for (const key of [...this.#told]) {
      if (key.startsWith(prefix)) this.#told.delete(key);
    }
  }

  /**
   * Delivers a message: journaled as delivering, with the id it will be sent under, forced to disk,
   * then sent to its agent's session. If that record can't reach the disk, it was never sent, and
   * its pending record is there: it waits again, first in line, and nothing is delivered on the
   * canvas until delivery tries again, RECORD_RETRY later, so a passing disk error costs a delay,
   * never the messages.
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
        if (this.#closed) return;
        // Taken back while it was journaled, it is never sent: what waits behind it goes.
        if (this.#deps.store.get(message.id)?.state !== 'delivering') this.schedule();
        else this.#hand(node, message, as);
      },
      (error: unknown) => {
        this.#writing.delete(node.id);
        if (this.#closed || this.#deps.store.get(message.id)?.state !== 'delivering') return;
        console.error('Could not record a message as delivering:', error);
        this.#deps.store.update(message.id, { state: 'pending' });
        this.#unrecordable ??= this.#deps.later(() => {
          this.#unrecordable = undefined;
          this.schedule();
        }, RECORD_RETRY);
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
      yours
        ? { id: as }
        : {
            id: as,
            from: { party: message.from, name: partyName(this.#deps.nodes(), message.from) },
          },
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
   * line, until the agent runs another way, or a message sent RETRY_AFTER or more from now tries the
   * session again and it starts.
   */
  #refused(node: AgentNode, id: string, text: string): void {
    if (this.#closed || this.#deps.store.get(id)?.state !== 'delivering') return;
    this.#deps.store.update(id, { state: 'pending' });
    this.#stuck.set(node.id, {
      connection: this.#deps.engine.catalog.connectionOf(node.data),
      text,
      at: this.#deps.now(),
      retrying: false,
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

  /** A message that waited in a log set aside as broken: unresolved, never sent, its sender told. */
  #unread(message: Message): void {
    const text = `Your message to ${this.#nameOf(message.to)} couldn’t be read back when corrallm opened the canvas, so it won’t be sent.`;
    const turn: TurnResult = { status: 'failed', reason: 'error', message: text };
    this.#deps.store.update(message.id, { state: 'unresolved', turn });
    this.#notice(message, text, turn);
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

  /**
   * Tells each party whose message's turn waits for you so, once: by what the turn itself waits
   * on, its session's prompt or what its CLI asks in its terminal; never a hold of the run's on its
   * agent, which holds no party's message.
   */
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
      // Its turn has started (the session has it), and waits on the user.
      const { entries, status } = engine.sessions.of(agent);
      return status === 'waiting' && entries.some((entry) => entry.id === message.delivery?.as)
        ? [{ agent, message }]
        : [];
    });
    if (turns.length === 0) return;
    const input: NeedsInput = {
      canvas: this.#deps.canvas,
      nodes: this.#deps.nodes(),
      run: engine.run.snapshot(),
      sessions: engine.sessions.snapshot(),
      catalog: engine.catalog,
      now: this.#deps.now(),
      ...(this.#deps.locale === undefined ? {} : { locale: this.#deps.locale }),
    };
    const asked = needsOf(input).filter((need) => need.kind === 'prompt' || need.kind === 'ask');
    for (const { agent, message } of turns) {
      const need = asked.find((one) => one.agent.id === agent);
      if (need) {
        this.#tell(
          `waiting:${message.id}`,
          message,
          `${this.#name(agent)} is waiting for the user: ${threadTitle(needsItem(need, input).title, TITLE)}`,
        );
      }
    }
  }

  /** Tells a message's sender `text`, once for `key`: kept with the notice, across restarts. */
  #tell(key: string, message: Message, text: string): void {
    if (this.#told.has(key)) return;
    this.#told.add(key);
    this.#notice(message, text, undefined, key);
  }

  /** A notice to a message's sender, about it: a record, never delivered as a turn. */
  #notice(message: Message, text: string, turn?: TurnResult, key?: string): void {
    if (message.from === 'corrallm') return;
    this.#deps.store.add(
      {
        from: 'corrallm',
        to: message.from,
        kind: 'notice',
        body: text,
        replyTo: message.id,
        ...(turn === undefined ? {} : { turn }),
        state: 'delivered',
      },
      key,
    );
  }

  /**
   * A message from anyone but you, as its agent is told it: behind a first line saying whom it is
   * from (and, for a reply, what it replies to, and how that turn ended if it didn't complete), so
   * the agent never takes it for its user's.
   */
  #frame(message: Message): string {
    const { from, id, replyTo, turn, body } = message;
    const agent = agentOf(from);
    const outside = outsideOf(from);
    const [who, what] =
      agent !== undefined
        ? [`agent "${this.#name(agent)}"`, 'an agent']
        : outside !== undefined
          ? [`"${outside}"`, 'an orchestrator outside corrallm']
          : ['corrallm', 'corrallm itself'];
    const about =
      turn !== undefined && replyTo !== undefined
        ? `Reply from ${who} (${what}, not the user; message ${id}, replying to your message ${replyTo}${this.#ending(turn)})`
        : `Message from ${who} (${what}, not the user; message ${id})`;
    return `[corrallm] ${about}:\n${body}`;
  }

  /**
   * How a reply's turn ended, as its frame tells it, if it didn't complete: "; its turn failed: a
   * usage limit, until 18:00".
   */
  #ending({ status, reason, message, resetsAt }: TurnResult): string {
    if (status === 'completed') return '';
    const until =
      resetsAt === undefined
        ? ''
        : `, until ${resetTime(resetsAt, this.#deps.now(), this.#deps.locale)}`;
    const why = message === undefined ? '' : ` (${threadTitle(message, REASON)})`;
    return `; its turn ${status === 'failed' ? 'failed' : 'was cancelled'}: ${REASON_WORDS[reason]}${until}${why}`;
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

  /** An agent's name, as a notice or a frame quotes it: on one line, capped. */
  #name(agent: string): string {
    return nameOf(this.#deps.nodes(), agent);
  }

  /** A party, as a notice names it. */
  #nameOf(party: PartyId): string {
    return partyText(this.#deps.nodes(), party);
  }
}

/** The kinds of hold a sender is told of, by the agent they hold. */
type HoldKind = 'paused' | 'stuck' | 'unasking' | 'usage';

/**
 * The key of what a sender is told of a hold of `kind` on agent `agent`, and what it is told of
 * (`rest`): the agent's id escaped, so that the keys of one agent's holds start alike, and no other
 * agent's do.
 */
function holdKey(kind: HoldKind, agent: string, ...rest: string[]): string {
  return [kind, encodeURIComponent(agent), ...rest].join(':');
}

/** Why a message couldn't be sent or taken back: a code, as an operation's failure carries it. */
export class DeliveryError extends Error {
  readonly code: 'not-found' | 'refused' | 'conflict';

  constructor(code: DeliveryError['code'], sentence: string) {
    super(sentence);
    this.name = 'DeliveryError';
    this.code = code;
  }
}

/** Where a settled text message is, in words: "withdrawn", "replied to". */
function stateWords({ state }: Message): string {
  return state === 'replied' ? 'replied to' : state;
}

/** Why a turn didn't complete, in words. */
const REASON_WORDS: Readonly<Record<TurnReason, string>> = {
  completed: 'it completed',
  interrupted: 'it was interrupted',
  'taken-back': 'it was taken back',
  'usage-limit': 'a usage limit',
  auth: 'a login problem',
  api: 'an API error',
  declined: 'it was declined',
  'start-failed': 'its session wouldn’t start',
  'connection-closed': 'its session closed',
  error: 'an error',
};

/** A reply cut to the most a message holds, marked where it was cut. */
function cut(reply: string): string {
  const bytes = new TextEncoder().encode(reply);
  if (bytes.length <= MAX_MESSAGE_BYTES) return reply;
  const room = MAX_MESSAGE_BYTES - new TextEncoder().encode(CUT).length;
  // Cut on a character's boundary: the decoder ends a character cut in two with U+FFFD, dropped
  // here.
  const kept = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, room));
  return `${kept.replace(/�$/u, '')}${CUT}`;
}

/** How a message whose record couldn't be written ended: failed, saying why (capped). */
function unrecorded(error: unknown): TurnResult & { message: string } {
  const why = error instanceof Error ? error.message : String(error);
  return { status: 'failed', reason: 'error', message: threadTitle(why, REASON) };
}
