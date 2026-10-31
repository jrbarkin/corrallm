import type { SessionAvailability } from '../../../shared/session';
import { randomUUID } from 'node:crypto';

import { MAX_WAITING } from '../../../shared/api/limits';
import type { AdapterId, ConnectionId } from '../../../shared/adapter';
import type { CanvasId } from '../../../shared/canvas';
import { needsItem, needsOf } from '../../../shared/model/needs-selectors';
import type { NeedsInput, UnaskingWhy } from '../../../shared/model/needs-selectors';
import { needFor } from '../../../shared/model/prompt-views';
import type { Engine } from '../engine/engine';
import type { PauseCause } from '../engine/run/runner';
import type { AgentNode, CanvasNode } from '../../../shared/model/canvas';
import { agentOf, agentParty, outsideOf } from '../../../shared/model/messages';
import type { Session } from '../../../shared/model/session';
import type { Message, PartyId } from '../../../shared/model/messages';
import { threadTitle } from '../../../shared/model/session';
import { holdText, resetTime } from '../../../shared/model/words';
import { isSessionMode } from '../../../shared/session';
import type { TurnReason, TurnResult, UserMessage } from '../../../shared/session';
import type { UsageHold } from '../../../shared/usage';
import type { UsageReadings } from '../../usage';
import {
  nameOf,
  partyName,
  partyText,
  pausesText,
  quotedName,
  quotedParty,
  RELEASES,
} from '../parties';
import { capBody, sentByRun } from './messages';
import type { MessageStore } from './messages';

/*
 * Delivering a canvas's messages (API Spec §5.5 to §5.7, Core Server §5.9). A message to an agent
 * waits until the agent is idle (no turn going, nothing asked, nothing queued in its session, nor
 * on its way there from the run) and nothing holds it: its own or its group's pause (a kill too), a
 * session that would not start (it stays first in line), a session that would act on it without
 * asking (#asking: one that runs, or would start, in a mode that never asks, or that corrallm
 * can't tell asks), or its backend's usage rule. Then it is journaled as delivering, with the id
 * it will be sent under, committed, and only then sent, whether or not a run is going: a
 * whole-run Stop, and the paused state a run restores in, hold only the run's own sends. What you
 * send goes past those holds into the session's queue, as you typed it; anything else reaches the
 * agent behind a first line saying whom it is from, so the agent's CLI never takes it for its
 * user's. When a message's turn ends, what the agent replied is a message to its sender, with how
 * the turn ended: delivered to an agent as a turn, kept for anyone else to read, and never answered
 * by another reply. corrallm tells a sender once when its message waits on something (a pause, a
 * session that won't start, one that would act without asking, a usage window) or its turn waits
 * for you, and when it ends withdrawn or unresolved.
 */

export interface DeliveryDeps {
  canvas: CanvasId;
  engine: Engine;
  store: MessageStore;
  /** The canvas's nodes now. */
  nodes: () => readonly CanvasNode[];
  usage: Pick<UsageReadings, 'exhausted'>;
  now: () => number;
  later: (run: () => void, ms: number) => () => void;
  /** Delivery's clock released a hold: needs may have changed without a session event. */
  changed: () => void;
  /** The locale times of day are told in (the host's): the runtime's own, when none. */
  locale?: string;
  /**
   * Whether the user's own default for agents of `adapter` (what a session given no mode starts
   * in) asks before it acts, as its CLI's settings say in the canvas's project folder: undefined
   * where that can't be told. Read once a session (#default).
   */
  availability?: (agent: string) => Promise<SessionAvailability>;
  defaultAsks: (adapter: AdapterId, agent?: string) => Promise<boolean | undefined>;
}

/**
 * Whether an agent's session asks before it acts on what it is sent, now or as it would start:
 * 'asks', or why a party's text would act unchecked (UnaskingWhy), or 'reading' while its CLI's
 * default is read or an unreported Terminal is within its startup grace.
 */
type Asking = 'asks' | 'reading' | UnaskingWhy;

/**
 * What an agent's CLI defaults to, as read for the session it runs or would start: the connection
 * it was read for, when, whether it asks (undefined: corrallm can't tell; 'reading' until it is
 * read), and whether a session of the agent's has run since.
 */
interface Default {
  connection: ConnectionId;
  at: number;
  asks: boolean | undefined | 'reading';
  ran: boolean;
}

/** Why an agent's session won't start, and what would let it. */
interface Unstartable {
  text: string;
  clears: string;
}

/** What holds a message to an agent, if anything does. */
type Hold =
  | { kind: 'busy' }
  | { kind: 'workspace'; sentence: string }
  | { kind: 'paused'; holding: PauseCause[] }
  | ({ kind: 'stuck' } & Unstartable)
  | { kind: 'unasking'; why: UnaskingWhy }
  | { kind: 'limited'; backend: string; until: number }
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

/**
 * What taking a message back did, rather than what its recorded delivery state implied: whether
 * its CLI had it, and so whether its turn is (or was) interrupted.
 */
interface Withdrawal {
  reached: boolean;
  interrupted: boolean;
}

/**
 * Why a message was taken back, as its recipient is told should it have reached it: its sender
 * withdrew it, or a kill of its recipient (or else of its sender) took it back.
 */
type TakeBackWhy = 'withdrawn' | 'recipient killed' | 'sender killed';

interface TakingBack {
  by: PartyId;
  why: TakeBackWhy;
  reached: boolean;
  /** What it did, once its turn has ended (or it came off its session's queue). */
  ended?: Withdrawal;
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
/** What a withdrawal whose record can't reach the disk says. */
const WITHDRAWAL_UNSAVED =
  'The message is taken back now, but its withdrawal could not be saved and may not survive a restart.';
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
/** How long after a delivering record couldn't be committed delivery tries again. */
const RECORD_RETRY = 1000;
/** A Terminal with hooks enabled may still be starting; do not raise a false permission hold. */
const PERMISSION_STARTUP_MS = 30_000;

export class Delivery {
  readonly #deps: DeliveryDeps;
  readonly #directories = new Map<string, SessionAvailability>();
  readonly #checkingDirectories = new Map<string, object>();

  availabilityChanged(): void {
    this.#directories.clear();
    this.#checkingDirectories.clear();
    for (const agent of this.#defaults.keys())
      if (this.#deps.engine.sessions.of(agent).running === undefined) this.#defaults.delete(agent);
    this.schedule();
  }

  #directoryHold(agent: string): Hold | undefined {
    const read = this.#deps.availability;
    if (read === undefined) return undefined;
    const result = this.#directories.get(agent);
    if (result !== undefined)
      return result.ready
        ? undefined
        : {
            kind: 'workspace',
            sentence: result.sentence,
          };
    if (!this.#checkingDirectories.has(agent)) {
      const token = {};
      this.#checkingDirectories.set(agent, token);
      void read(agent).then(
        (next) => {
          if (this.#closed || this.#checkingDirectories.get(agent) !== token) return;
          this.#checkingDirectories.delete(agent);
          this.#directories.set(agent, next);
          this.schedule();
        },
        (error: unknown) => {
          if (this.#closed || this.#checkingDirectories.get(agent) !== token) return;
          this.#checkingDirectories.delete(agent);
          this.#directories.set(agent, {
            ready: false,
            sentence:
              error instanceof Error
                ? error.message
                : 'Its working directory could not be checked.',
          });
          this.schedule();
        },
      );
    }
    return { kind: 'busy' };
  }
  /** What takes each message being delivered back from its agent's session, by the message's id. */
  readonly #sent = new Map<string, () => void>();
  /** The agents a message is being journaled for, before it is sent: nothing else starts meanwhile. */
  readonly #writing = new Set<string>();
  /** The messages sent whose records are on their way to disk: none goes before it is there. */
  readonly #recording = new Set<string>();
  /** Who asked for each message whose turn is going to be taken back, by its id. */
  readonly #withdrawing = new Map<string, TakingBack>();
  /** What each party was told, so that it is told once (kept with each notice, by its key). */
  readonly #told = new Set<string>();
  /** The agents whose sessions would not start, by id. */
  readonly #stuck = new Map<string, Stuck>();
  /**
   * What each agent's CLI defaults to, by the agent's id: read once a session (again once it ends,
   * or with the next message sent it RETRY_AFTER or more after a read that held its messages).
   */
  readonly #defaults = new Map<string, Default>();
  readonly #permissionWaits = new Map<
    string,
    {
      running: NonNullable<Session['running']>;
      until: number;
    }
  >();
  /** What wakes delivery when a usage window resets. */
  #alarm: { at: number; cancel: () => void } | undefined;
  /**
   * While a delivering record couldn't be committed: what tries again (RECORD_RETRY later).
   * Nothing is delivered meanwhile.
   */
  #unrecordable: (() => void) | undefined;
  readonly #images = new Map<string, NonNullable<UserMessage['images']>>();
  #scheduled = false;
  /** Whether it delivers yet: not until it starts, though messages may be sent before. */
  #started = false;
  #closed = false;
  /** Whether the core's shutdown barrier holds it: nothing starts being delivered meanwhile. */
  #frozen = false;
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
   * that was being delivered, or delivered with no turn end, when the core last stopped is
   * unresolved (its sender told so), and never sent again; what was waiting, or was sent before it
   * started, goes once it can. Once only.
   */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const { store } = this.#deps;
    // What its senders were told before, they were told once.
    for (const key of store.told()) this.#told.add(key);
    for (const message of store.active()) {
      // A send the live run made before delivery started (serve held, a passive runtime) is the
      // run's own to settle as its turn ends: only what the core last left out is cut off.
      if (this.#inFlight(message) && !this.#runSending(message)) this.#cutOff(message);
    }
    await this.#deps.store.durable();
    this.schedule();
  }

  /** Whether a message is the live run's send of an attempt it still runs (its own to settle). */
  #runSending(message: Message): boolean {
    const { task } = message;
    if (!sentByRun(message) || task === undefined) return false;
    const last = this.#deps.engine.run.snapshot().agents[task.agent]?.attempts?.[task.item]?.at(-1);
    return last?.id === task.attempt && last.status === 'running';
  }

  /**
   * Stops delivering, as the canvas closes: a message being delivered, or whose turn is going, is
   * unresolved (its sender told so), before its session closes. Rejects if that can't be journaled.
   */
  async close(): Promise<void> {
    this.#closed = true;
    this.#images.clear();
    for (const stop of this.#stop) stop();
    this.#alarm?.cancel();
    this.#alarm = undefined;
    this.#unrecordable?.();
    this.#unrecordable = undefined;
    for (const message of this.#deps.store.active()) {
      if (!this.#inFlight(message)) continue;
      const taking = this.#withdrawing.get(message.id);
      if (taking) this.#takenBack(message, taking, false);
      else this.#cutOff(message);
    }
    await this.#deps.store.durable();
  }

  /**
   * The core's shutdown barrier (B11 Design §16.5): no message starts being delivered until `thaw`,
   * though messages may be sent meanwhile; one being delivered goes on, and its reply comes back.
   */
  freeze(): void {
    this.#frozen = true;
  }

  /** The barrier lifted (a quit cancelled): what waited goes once it can. */
  thaw(): void {
    if (!this.#frozen) return;
    this.#frozen = false;
    this.schedule();
  }

  images(id: string, images: UserMessage['images']): void {
    if (images?.length) this.#images.set(id, images);
  }

  /** Yours, as you typed it (manual): it goes past the run's holds; your resend waits on them. */
  #yours(message: Message): boolean {
    return this.#deps.store.originOf(message.id) === 'manual';
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
   * from a party (anyone but you) that has MAX_WAITING waiting for that agent already. `images`:
   * pasted with it, live-only (a restart that loses them leaves it unresolved, never sent without
   * them); `told`: the key it is kept with, by which what admitted it once finds it again.
   */
  async send(
    from: PartyId,
    to: string,
    body: string,
    replyTo?: string,
    { images, told }: { images?: UserMessage['images']; told?: string } = {},
  ): Promise<Message> {
    const { store } = this.#deps;
    if (
      from !== 'you' &&
      (this.#waiting().get(to) ?? []).filter((message) => message.from === from).length >=
        MAX_WAITING
    ) {
      throw new DeliveryError(
        'refused',
        `${this.#name(to)} already has ${String(MAX_WAITING)} of your messages waiting; send another once one of them goes.`,
      );
    }
    const pasted = images?.length ?? 0;
    const message = store.add(
      {
        from,
        to: agentParty(to),
        kind: 'text',
        // Yours is yours as you sent it; anyone else's a party's.
        origin: from === 'you' ? 'manual' : 'party',
        // Its images are live-only: once a restart lost them, it is never sent without them.
        ...(pasted > 0 ? { display: { images: pasted, requiresImages: true } } : {}),
        body,
        state: 'pending',
        ...(replyTo === undefined ? {} : { replyTo }),
      },
      told,
    );
    this.images(message.id, images);
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
    // What its CLI defaults to, read for a session yet to start, that held its messages: read again.
    const known = this.#defaults.get(to);
    if (
      known !== undefined &&
      known.asks !== true &&
      known.asks !== 'reading' &&
      this.#deps.engine.sessions.of(to).running === undefined &&
      this.#deps.now() - known.at >= RETRY_AFTER
    ) {
      this.#defaults.delete(to);
    }
    this.#pump();
    return this.#deps.store.get(message.id) ?? message;
  }

  /**
   * Keeps a command your agent view answered itself in a panel (/resume, /mcp, /rewind) as your
   * message to agent `to`, settled at once (its turn completed) and never delivered: no CLI turn.
   * Resolves once it is on disk; rejects, the message unresolved, if it can't reach it.
   */
  async record(to: string, body: string): Promise<Message> {
    const { store } = this.#deps;
    const message = store.add({
      from: 'you',
      to: agentParty(to),
      kind: 'text',
      origin: 'manual',
      body,
      state: 'replied',
      turn: { status: 'completed', reason: 'completed' },
    });
    try {
      await store.durable();
    } catch (error) {
      store.update(message.id, { state: 'unresolved', turn: unrecorded(error) });
      throw error;
    }
    return store.get(message.id) ?? message;
  }

  /**
   * Takes back a message for `by`: one still waiting is withdrawn at once; one being delivered is
   * taken off its session's queue, or its turn interrupted, and is withdrawn once that ends.
   * Returns once the take-back is requested, never waiting for a native turn to end. Any immediate
   * withdrawal is flushed before returning, so a restart never delivers it. Throws, saying why, a
   * message that can't be taken back, and 'unavailable' one taken back whose withdrawal couldn't
   * be written (withdrawn here all the same, it may not survive a restart).
   */
  async withdraw(id: string, by: PartyId): Promise<Withdrawal> {
    const message = this.#deps.store.get(id);
    if (!message) throw new DeliveryError('not-found', 'There is no such message.');
    if (sentByRun(message)) {
      throw new DeliveryError(
        'refused',
        'That message is the run’s own: stop the run, or pause or kill its agent, to take it back.',
      );
    }
    if (by !== 'you' && message.from !== by) {
      throw new DeliveryError('refused', 'Only a message you sent can be taken back.');
    }
    if (message.state === 'pending') {
      this.#withdrawn(message, by);
      this.schedule();
      return this.#saved({ reached: false, interrupted: false });
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
    return this.#saved(this.#takeBack(message, by, 'withdrawn'));
  }

  /** What a withdrawal did, once it is on disk; 'unavailable' if it can't be written. */
  async #saved(result: Withdrawal): Promise<Withdrawal> {
    try {
      await this.#deps.store.durable();
    } catch {
      throw new DeliveryError('unavailable', WITHDRAWAL_UNSAVED);
    }
    return result;
  }

  /**
   * Agents were killed (by `by`, at once, as a group's are): every message to or from them still
   * waiting is withdrawn, and every one being delivered is taken back, its turn interrupted, its
   * recipient told with its next message should it have reached it, as of a withdrawal: one
   * being delivered is withdrawn once its turn has ended, which this never waits for.
   */
  kill(agents: readonly string[], by: PartyId): void {
    const killed = new Set(agents.map(agentParty));
    for (const message of this.#deps.store.active()) {
      // The run's own sends are the run's to take back (its kill holds and withdraws them).
      if (message.kind !== 'text' || sentByRun(message)) continue;
      const why: TakeBackWhy | undefined = killed.has(message.to)
        ? 'recipient killed'
        : killed.has(message.from)
          ? 'sender killed'
          : undefined;
      if (why === undefined) continue;
      if (message.state === 'pending') this.#withdrawn(message, by);
      else if (this.#inFlight(message)) this.#takeBack(message, by, why);
    }
    this.schedule();
  }

  /**
   * The agents whose sessions won't start while parties' messages to them wait, why, and what
   * would let them.
   */
  stuck(): ({ agent: string } & Unstartable)[] {
    // Looked at only once an agent won't start.
    let waiting: Map<string, Message[]> | undefined;
    return this.#deps.nodes().flatMap((node) => {
      const stuck = node.type === 'agent' ? this.#stuckOf(node) : undefined;
      return stuck !== undefined && (waiting ??= this.#waiting()).has(node.id)
        ? [{ agent: node.id, ...stuck }]
        : [];
    });
  }

  /** Every agent spending an exhausted backend, even when no message waits for it. */
  limited(): { agent: string; backend: string; until: number }[] {
    return this.#deps.nodes().flatMap((node) => {
      const hold = node.type === 'agent' ? this.#limited(node) : undefined;
      return hold === undefined
        ? []
        : [{ agent: node.id, backend: hold.backend, until: hold.until }];
    });
  }

  #limited(node: AgentNode): Extract<Hold, { kind: 'limited' }> | undefined {
    const backend = this.#deps.engine.catalog.usageBackendOf(node.data);
    const until =
      backend === undefined ? undefined : this.#deps.usage.exhausted(backend, this.#deps.now());
    return backend === undefined || until === undefined
      ? undefined
      : { kind: 'limited', backend, until };
  }

  /**
   * The agents that would act on parties' messages without asking while those wait (but those whose
   * sessions won't start), and why.
   */
  unasking(): { agent: string; why: UnaskingWhy }[] {
    const waiting = this.#waiting();
    return this.#deps.nodes().flatMap((node) => {
      if (node.type !== 'agent') return [];
      if (!waiting.get(node.id)?.some((message) => !this.#yours(message))) return [];
      if (this.#stuckOf(node) !== undefined) return [];
      const why = this.#asking(node);
      return why === 'asks' || why === 'reading' ? [] : [{ agent: node.id, why }];
    });
  }

  /** The message whose turn an agent is on, if one is. */
  current(agent: string): string | undefined {
    const session = this.#deps.engine.sessions.of(agent);
    return this.#deps.store
      .active()
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
    if (!this.#started || this.#closed || this.#frozen) return;
    const { engine, store } = this.#deps;
    this.#withdrawGone();
    let messages = store.active();
    for (const id of this.#images.keys()) {
      const message = store.get(id);
      if (!message || !['pending', 'delivering'].includes(message.state)) this.#images.delete(id);
    }
    // Each message the session has now is delivered.
    let lostImages = false;
    for (const message of messages) {
      if (
        message.state === 'pending' &&
        store.requiresImages(message) &&
        !this.#images.has(message.id)
      ) {
        const text =
          'This resend could not be sent: its images were not retained after restart. Paste the images again to start a new submission.';
        store.update(message.id, {
          state: 'unresolved',
          turn: { status: 'cancelled', reason: 'interrupted', message: text },
        });
        store.add(
          {
            from: 'corrallm',
            to: message.from,
            kind: 'notice',
            origin: 'party',
            replyTo: message.id,
            body: text,
            state: 'delivered',
          },
          `resend-images-lost:${message.id}`,
        );
        lostImages = true;
        continue;
      }
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
    if (lostImages) messages = store.active();
    /** What waits for each agent, in the order it came, once its record is on disk. */
    const waiting = this.#waiting(messages.filter(({ id }) => !this.#recording.has(id)));
    this.#tellWaiting(messages);
    this.#followDefaults();
    let alarm: number | undefined;
    for (const node of this.#deps.nodes()) {
      if (node.type !== 'agent') continue;
      this.#forgetReleased(node);
      const permission = this.#permissionWaits.get(node.id);
      if (permission !== undefined && permission.until > this.#deps.now())
        alarm = Math.min(alarm ?? permission.until, permission.until);
      const limited = this.#limited(node);
      if (limited !== undefined) alarm = Math.min(alarm ?? limited.until, limited.until);
      const waits = waiting.get(node.id);
      if (!waits || this.#writing.has(node.id)) continue;
      // Yours go past the run's holds, into its session's queue, unless that won't start; what
      // holds a party's message holds every party's behind it.
      const directory = this.#directoryHold(node.id);
      const holds = {
        yours: directory ?? this.#stuckHold(node),
        theirs:
          directory ??
          (waits.some((message) => !this.#yours(message)) ? this.#holdOf(node) : undefined),
      };
      let next: Message | undefined;
      for (const message of waits) {
        const hold = this.#yours(message) ? holds.yours : holds.theirs;
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
        if (hold.kind === 'workspace') {
          this.#tell(
            holdKey('workspace', node.id, hold.sentence, message.from),
            message,
            `${this.#name(node.id)} waits for its workspace, so your message stays queued: ${threadTitle(hold.sentence, REASON)}`,
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
            unaskingText(this.#name(node.id), hold.why),
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
        if (hold.kind === 'limited') {
          this.#tell(
            holdKey('limited', node.id, String(hold.until), message.from),
            message,
            `${this.#name(node.id)}’s ${engine.catalog.backendName(hold.backend)} usage is exhausted until ${resetTime(hold.until, this.#deps.now(), this.#deps.locale)}, so your message waits until then.`,
          );
        }
      }
      if (next === undefined || this.#unrecordable) continue;
      if (!this.#yours(next)) this.#warnUsage(node);
      this.#directories.delete(node.id);
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
    for (const message of this.#deps.store.active()) {
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

  /**
   * The messages waiting for each agent, of `messages` (those delivery acts on, unless given), by
   * its id, each in the order they came: none for an agent nothing waits for.
   */
  #waiting(messages = this.#deps.store.active()): Map<string, Message[]> {
    const waiting = new Map<string, Message[]>();
    for (const message of messages) {
      const agent = agentOf(message.to);
      if (agent === undefined || message.state !== 'pending') continue;
      const waits = waiting.get(agent);
      if (waits) waits.push(message);
      else waiting.set(agent, [message]);
    }
    return waiting;
  }

  /** What holds a message from you to agent `node` now: only a session that won't start. */
  #stuckHold(node: AgentNode): Hold | undefined {
    const stuck = this.#stuckOf(node);
    return stuck === undefined ? undefined : { kind: 'stuck', ...stuck };
  }

  /** What holds a message from a party (anyone but you) to agent `node` now, if anything. */
  #holdOf(node: AgentNode): Hold | undefined {
    const { engine } = this.#deps;
    const limited = this.#limited(node);
    if (limited !== undefined) return limited;
    const holding = engine.run.holding({ agent: node.id });
    if (holding.length > 0) return { kind: 'paused', holding };
    const stuck = this.#stuckHold(node);
    if (stuck !== undefined) return stuck;
    const asking = this.#asking(node);
    // A default read or unreported Terminal startup waits silently, as for a turn.
    if (asking === 'reading') return { kind: 'busy' };
    if (asking !== 'asks') return { kind: 'unasking', why: asking };
    // The run's own message on its way to it goes first, as one in its session's queue would.
    const session = engine.sessions.of(node.id);
    if (
      session.status !== 'idle' ||
      session.queued.length > 0 ||
      (session.asking?.length ?? 0) > 0 ||
      engine.run.sending(node.id)
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
   * Whether agent `node`'s session asks before it acts on what it is sent, now or as it would
   * start: one that never asks acts on whatever it is sent, so a party's text would act unchecked,
   * as would one corrallm can't tell asks. A session that runs says so by its mode (one its adapter
   * says never asks), or, on settings that are none of its modes, by whether they ask. Terminals
   * carry their trusted pre-launch default until a native hook reports; one that still says
   * neither gets a bounded silent startup hold while hooks are on, then an unknown hold.
   * One yet to start starts in
   * its saved start mode, where its connection starts in it (each asks), else its CLI's default.
   * That default is read once a session (#default; not now unless `read`: 'reading').
   */
  #asking(node: AgentNode, read = true): Asking {
    const { catalog, sessions } = this.#deps.engine;
    const connection = catalog.connectionOf(node.data);
    // It runs nothing: a session that won't start holds it (#stuckOf).
    if (connection === 'unavailable') return 'asks';
    const session = sessions.of(node.id);
    if (session.running !== undefined) {
      if (session.mode !== null || session.asks !== undefined)
        this.#permissionWaits.delete(node.id);
      if (session.mode !== null) {
        return catalog.neverAsks(connection, session.mode) ? 'mode' : 'asks';
      }
      if (session.asks !== undefined) return session.asks ? 'asks' : 'mode';
      if (catalog.isTerminal(connection) && session.unheard === undefined) {
        let waiting = this.#permissionWaits.get(node.id);
        if (waiting?.running !== session.running) {
          waiting = { running: session.running, until: this.#deps.now() + PERMISSION_STARTUP_MS };
          this.#permissionWaits.set(node.id, waiting);
        }
        if (this.#deps.now() < waiting.until) return 'reading';
      }
      return 'unknown-running';
    } else {
      const mode = node.data.settings?.[catalog.adapterOf(connection)]?.mode;
      if (mode !== undefined && isSessionMode(mode) && catalog.isStartMode(connection, mode)) {
        return 'asks';
      }
    }
    return this.#default(node.id, connection, read);
  }

  /**
   * What agent `agent`'s CLI defaults to on `connection`, as read for the session it runs or would
   * start: read now (unless not `read`) if it hasn't been for it, 'reading' until it is, then looked
   * at again.
   */
  #default(agent: string, connection: ConnectionId, read: boolean): Asking {
    const known = this.#defaults.get(agent);
    if (known?.connection === connection) {
      if (known.asks === 'reading') return 'reading';
      return known.asks === undefined ? 'unknown' : known.asks ? 'asks' : 'default';
    }
    if (!read) return 'reading';
    const reading: Default = { connection, at: this.#deps.now(), asks: 'reading', ran: false };
    this.#defaults.set(agent, reading);
    void this.#deps
      .defaultAsks(this.#deps.engine.catalog.adapterOf(connection), agent)
      .catch(() => undefined)
      .then((asks) => {
        if (this.#defaults.get(agent) !== reading) return;
        reading.asks = asks;
        this.schedule();
      });
    return 'reading';
  }

  /**
   * Keeps what each agent's CLI defaults to for the session it was read for: through that session,
   * once it runs, and no longer once it ends (the next is read for anew), nor for an agent gone.
   */
  #followDefaults(): void {
    const agents = new Set(
      this.#deps.nodes().flatMap((node) => (node.type === 'agent' ? [node.id] : [])),
    );
    for (const [agent, waiting] of this.#permissionWaits) {
      if (!agents.has(agent) || this.#deps.engine.sessions.of(agent).running !== waiting.running)
        this.#permissionWaits.delete(agent);
    }
    for (const [agent, known] of this.#defaults) {
      if (!agents.has(agent)) {
        this.#defaults.delete(agent);
        continue;
      }
      const running = this.#deps.engine.sessions.of(agent).running !== undefined;
      if (running) known.ran = true;
      else if (known.ran) this.#defaults.delete(agent);
    }
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
   * it has started (after a restart too, when only the notices kept say it refused); acting
   * without asking, once it is known to ask (not while its CLI's default is still to be read).
   */
  #forgetReleased(node: AgentNode): void {
    const { engine } = this.#deps;
    if (engine.run.holding({ agent: node.id }).length === 0) this.#forget('paused', node.id);
    if (engine.sessions.of(node.id).running !== undefined) this.#forget('stuck', node.id);
    if (this.#directories.get(node.id)?.ready === true) this.#forget('workspace', node.id);
    if (this.#asking(node, false) === 'asks') this.#forget('unasking', node.id);
    if (this.#limited(node) === undefined) this.#forget('limited', node.id);
  }

  /** Forgets what each sender was told of a hold of `kind` on agent `agent`. */
  #forget(kind: HoldKind, agent: string): void {
    const prefix = holdKey(kind, agent, '');
    for (const key of [...this.#told]) {
      if (key.startsWith(prefix)) this.#told.delete(key);
    }
  }

  /**
   * Delivers a message: journaled as delivering, with the id it will be sent under, committed,
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
      async () => {
        try {
          if (!this.#yours(message)) {
            try {
              await this.#deps.engine.sessions.ready(node.id);
            } catch (error) {
              this.#refused(
                node,
                message.id,
                error instanceof Error ? error.message : String(error),
              );
              return;
            }
          }
          if (this.#closed) return;
          // Taken back while it was journaled, it is never sent: what waits behind it goes.
          if (this.#deps.store.get(message.id)?.state !== 'delivering') this.schedule();
          else {
            const current = this.#deps
              .nodes()
              .find((one) => one.id === node.id && one.type === 'agent');
            if (
              !this.#yours(message) &&
              (current?.type !== 'agent' ||
                this.#deps.engine.sessions.of(node.id).running === undefined ||
                this.#holdOf(current) !== undefined)
            ) {
              this.#deps.store.update(message.id, { state: 'pending' });
              this.schedule();
            } else this.#hand(node, message, as);
          }
        } finally {
          this.#writing.delete(node.id);
        }
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
      this.#images.get(message.id),
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
    this.#images.delete(message.id);
    this.#sent.set(message.id, takeBack);
  }

  /** A message's turn ended: it was withdrawn, or replied to, its reply a message to its sender. */
  #ended(id: string, _interrupted: boolean, reply: string, result: TurnResult): void {
    this.#sent.delete(id);
    const { store } = this.#deps;
    const message = store.get(id);
    // Cut off as the canvas closed, or back to waiting: its session would not start.
    if (this.#closed || !message || !this.#inFlight(message)) return;
    const taking = this.#withdrawing.get(id);
    if (taking !== undefined) {
      this.#takenBack(message, taking, result.status === 'cancelled');
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
        origin: 'party',
        body: capBody(reply, 'reply'),
        replyTo: id,
        turn: result,
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

  /**
   * Takes back a message being delivered for `by`: withdrawn at once off its session's queue, else
   * once its interrupted turn has ended. What it did as it is asked for: off the queue, what that
   * did; else whether its CLI has it, and so whether its turn is being interrupted. Never waits for
   * the turn's end, so no op waits in its scope on a CLI that ignores the interrupt.
   */
  #takeBack(message: Message, by: PartyId, why: TakeBackWhy): Withdrawal {
    const existing = this.#withdrawing.get(message.id);
    if (existing) return asked(existing.reached || this.#reached(message));
    const takeBack = this.#sent.get(message.id);
    if (!takeBack) {
      // Still being journaled: it is never sent.
      this.#withdrawn(message, by);
      return { reached: false, interrupted: false };
    }
    const taking: TakingBack = { by, why, reached: this.#reached(message) };
    this.#withdrawing.set(message.id, taking);
    takeBack();
    return taking.ended ?? asked(taking.reached);
  }

  /** Whether the CLI has the message: delivering also covers journaling and the session queue. */
  #reached(message: Message): boolean {
    const agent = agentOf(message.to);
    return (
      message.state === 'delivered' ||
      (agent !== undefined &&
        this.#deps.engine.sessions
          .of(agent)
          .entries.some(
            (entry) =>
              entry.id === message.delivery?.as && entry.kind === 'user' && entry.reached === true,
          ))
    );
  }

  /** The take-back ended: keep its note in the same record as the withdrawal, before the next send. */
  #takenBack(message: Message, taking: TakingBack, interrupted: boolean): void {
    this.#withdrawing.delete(message.id);
    const reached = taking.reached || this.#reached(message);
    const result = { reached, interrupted: reached && interrupted };
    const note = reached ? this.#note(message, taking, result.interrupted) : undefined;
    this.#withdrawn(message, taking.by, note);
    taking.ended = result;
  }

  /**
   * What a message's recipient is told of it taken back after it reached it: which message, whom
   * from, who took it back (its sender, or the kill of whom, by whom), and not to carry it out. It
   * quotes nothing of the canvas but parties' names, capped as notices cap them.
   */
  #note(message: Message, { by, why }: TakingBack, interrupted: boolean): string {
    const nodes = this.#deps.nodes();
    const sender =
      message.from === 'you' ? quotedName('the user') : quotedParty(nodes, message.from);
    const turn = interrupted ? ', and its turn was interrupted' : '';
    const how =
      why === 'withdrawn'
        ? `by its sender after it reached you${turn}`
        : `after it reached you${turn}, when ${killedText(nodes, message, by, why)}`;
    return `Message ${message.id} from ${sender} was withdrawn ${how}. Do not carry out what it asked unless someone asks again. Anything it already did is left as it is.`;
  }

  /** Withdraws a message for `by`, telling its sender when someone else did. */
  #withdrawn(message: Message, by: PartyId, note?: string): void {
    this.#deps.store.update(message.id, { state: 'withdrawn', by }, note);
    if (by !== message.from) {
      this.#notice(
        message,
        `Your message to ${this.#nameOf(message.to)} was withdrawn by ${this.#nameOf(by)}.`,
        TAKEN_BACK,
      );
    }
  }

  /**
   * A message cut off as the core stopped: unresolved, never sent again, its sender told (but for
   * the run's own, whose attempt the run restores uncertain, telling no one).
   */
  #cutOff(message: Message): void {
    this.#deps.store.update(message.id, { state: 'unresolved' });
    if (sentByRun(message)) return;
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
        sentByRun(message) ||
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
        // Its sender is a token (yours aren't told): it reads what a token may of the prompt (B13
        // C11's selector).
        const { title } = needFor(needsItem(need, input), 'token');
        this.#tell(
          `waiting:${message.id}`,
          message,
          `${this.#name(agent)} is waiting for the user: ${threadTitle(title, TITLE)}`,
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
        origin: 'party',
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
        ? [`agent ${quotedParty(this.#deps.nodes(), from)}`, 'an agent']
        : outside !== undefined
          ? [quotedName(outside), 'an orchestrator outside corrallm']
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

  /** Wakes delivery for the next usage reset or Terminal permission startup deadline. */
  #arm(at: number | undefined): void {
    if (this.#alarm?.at === at) return;
    this.#alarm?.cancel();
    this.#alarm = undefined;
    if (at === undefined) return;
    const cancel = this.#deps.later(
      () => {
        this.#alarm = undefined;
        this.schedule();
        this.#deps.changed();
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
type HoldKind = 'workspace' | 'paused' | 'stuck' | 'unasking' | 'usage' | 'limited';

/**
 * Whom the kill that took back `message` killed, its recipient or its sender, and who killed it, as
 * the note its recipient is told says ("you were killed by the user", "its sender was killed at its
 * own request").
 */
function killedText(
  nodes: readonly CanvasNode[],
  message: Message,
  by: PartyId,
  why: Exclude<TakeBackWhy, 'withdrawn'>,
): string {
  const [whom, own, killed] =
    why === 'recipient killed'
      ? ['you were', 'your', message.to]
      : ['its sender was', 'its', message.from];
  if (by === killed) return `${whom} killed at ${own} own request`;
  return `${whom} killed by ${by === message.to ? 'you' : quotedParty(nodes, by)}`;
}

/** What a sender is told of its message to agent `name` waiting because it would act without asking. */
function unaskingText(name: string, why: UnaskingWhy): string {
  switch (why) {
    case 'mode':
      return `${name} runs in a mode that never asks before it acts, so your message waits until it runs in one that asks again: only the user can switch it.`;
    case 'default':
      return `${name}’s CLI defaults to a mode that never asks before it acts, so your message waits until ${name} runs in one that asks, which only the user can set.`;
    case 'unknown':
      return `corrallm can’t tell whether ${name}’s CLI defaults to a mode that asks before it acts, so your message waits until ${name} runs in one that asks, which only the user can set.`;
    case 'unknown-running':
      return `corrallm can’t tell whether ${name}’s running session asks before it acts, so your message waits until it reports that it asks: check its terminal and switch it to a mode that asks, or enable its hooks if they are off.`;
  }
}

/**
 * The key of what a sender is told of a hold of `kind` on agent `agent`, and what it is told of
 * (`rest`): the agent's id escaped, so that the keys of one agent's holds start alike, and no other
 * agent's do.
 */
function holdKey(kind: HoldKind, agent: string, ...rest: string[]): string {
  return [kind, encodeURIComponent(agent), ...rest].join(':');
}

/**
 * What taking back a message being delivered does as it is asked for, before its turn ends: if its
 * CLI has it, its turn is being interrupted.
 */
function asked(reached: boolean): Withdrawal {
  return { reached, interrupted: reached };
}

/** Why a message couldn't be sent or taken back: a code, as an operation's failure carries it. */
export class DeliveryError extends Error {
  readonly code: 'not-found' | 'refused' | 'conflict' | 'unavailable';

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

/** How a message whose record couldn't be written ended: failed, saying why (capped). */
function unrecorded(error: unknown): TurnResult & { message: string } {
  const why = error instanceof Error ? error.message : String(error);
  return { status: 'failed', reason: 'error', message: threadTitle(why, REASON) };
}
