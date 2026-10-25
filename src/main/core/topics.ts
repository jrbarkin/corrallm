import { randomUUID } from 'node:crypto';

import type { OpResult } from '../../shared/api/errors';
import { SURFACE } from '../../shared/api/surface';
import type { OpName, Surface, TopicKind } from '../../shared/api/surface';
import {
  canvasOfTopic,
  isRuntimeTopic,
  RuntimeTopic,
  topicKey,
  topicRequest,
} from '../../shared/api/topics';
import type {
  Change,
  RuntimeSnapshotFrame,
  RuntimeTopicKey,
  RuntimeTopicRequest,
  TopicKey,
  TopicName,
  TopicSnapshot,
  TopicUpdate,
} from '../../shared/api/topics';
import type { CanvasId } from '../../shared/canvas';
import type { PartyId } from '../../shared/model/messages';
import type { EntityKey } from '../../shared/model/rows';
import type { Entities, Entity } from '../../shared/model/state';
import { projectData } from '../../shared/model/views';
import type { OpContext, Dispatcher, Publication, ReceiptTopic } from './call';
import { OpFailure } from './call';
import { callerKey } from './caller';
import type { Caller } from './caller';
import type { CanvasChange } from './canvas/states';
import type { WindowId } from './host';
import {
  argsOf,
  bytesOf,
  divide,
  emptyBody,
  kindOf,
  partsOf,
  TOPIC_BUDGET,
  viewDiff,
} from './runtime-topics';
import type { RuntimeBody, RuntimeSource, RuntimeState } from './runtime-topics';

/*
 * The topics (Core Server §5.1–5.2, B9 Design §7, B11 §5 and §16): the common publisher. A
 * subscriber gets the very state its read gives it, through the dispatcher and audience of the op
 * that `reads` the topic, and the changes after it, batched per subscriber every 16 ms, each batch
 * within a topic frame (MAX_TOPIC_FRAME, less room for the port's envelope; one change too big
 * alone goes alone). A window subscribes through `topics.subscribe`, as you; any other caller only
 * through `follow` (no transport serves it: tokens get no topics, D5), which T3c reads what a
 * token's subscription would carry with.
 *
 * `usage`, `settings`, `canvases` and a canvas's `needs:<c>` are replaced whole: when their source
 * says it changed, they are read again through their op, once for each caller who sees them alike
 * (you, in every window, as one), and a change goes out only if what was read differs. A canvas's
 * `canvas:<c>` is keyed: each change is the commit's diff (canvas/states.ts), at the commit's
 * revision, never a re-read, which goes out as it is to whoever sees the whole canvas, and as what
 * it changed of what each other subscriber sees (canvas/view.ts) to them, so a topic is never a
 * second way to reach anything.
 *
 * A canvas's runtime topics (`run:<c>`, `sessions:<c>`, `session:<c>:<agent>`, `messages:<c>`:
 * runtime-topics.ts) are keyed too. Each has one canonical state, yours, and its revision moves at
 * each change of it as it is taken from its source, whether or not anyone subscribes: you are sent
 * that change; whoever sees less (a token's copy) reads its own copy again through the topic's
 * projection and is sent what changed of it, at the same revision (empty, if nothing did), so no
 * copy skips one. A change too big for a frame goes as several, at consecutive revisions. A snapshot
 * that fits a frame is answered whole; one that doesn't is a transfer (B11 §16.3a): its `begin`,
 * with the topic's bounded summary and the number of chunks, answers the subscription (a summary
 * too big for its frame refuses it, before anything is sent), and its indexed chunks, the entries
 * in order, then its `end` with the revision, follow on the subscriber's port before any change.
 *
 * A write's receipts (call.ts' `published`): once the op is done, what changed of each topic it
 * names is published, and its revision (yours, for a replaced one) is in the call's `revs`, if it
 * moved since the op began. Revisions are per topic (a canvas's is its document's); sequence numbers
 * are a canvas's for its topics, and the global ones share theirs. Every subscription, snapshot and
 * publication takes its turn in one queue, so no change falls between a snapshot and its
 * subscription. A new core has a new epoch, its revisions new; no subscription outlives its
 * subscriber.
 */

/** Who subscribes: a window, or a follower in the core. */
type SubscriberId = WindowId | symbol;

/** Any topic's key: a global one's, a canvas's, or a canvas's runtime one's. */
export type AnyTopic = TopicKey | RuntimeTopicKey;

/** What every runtime change says first. */
interface Head {
  topic: RuntimeTopicKey;
  epoch: string;
  rev: number;
  seq: number;
  by: PartyId | 'cli';
  at: number;
}

/** A runtime topic's snapshot, when it fits one frame. */
export interface RuntimeSnapshot {
  epoch: string;
  rev: number;
  state: RuntimeState;
}

/** What a subscription answers: the topic's state now, or the `begin` of its transfer. */
export type Subscribed = TopicSnapshot | RuntimeSnapshot | RuntimeSnapshotFrame;

interface Subscription {
  caller: Caller;
  release?: () => void;
  /** For a keyed topic seen in part: the entities it was last told of. */
  seen?: Entities;
  /** For a runtime topic seen in part (a token's): its copy, as its projection last read it. */
  view?: RuntimeState;
  access?: { world: object | undefined; lead: boolean };
}

export interface TopicsDeps {
  /** Calls a topic's read op as a subscriber: its state, through its audience and reach. */
  read: Dispatcher['call'];
  /**
   * A canvas's entities as `caller` sees them now (it read the canvas through `canvas.get` first),
   * at its revision, and whether it sees them all.
   */
  view?: (canvas: CanvasId, caller: Caller) => { rev: number; entities: Entities; all: boolean };
  /**
   * The runtime topics' source (runtime-topics.ts), and how a caller reads one through its
   * projection (core.call's `project`): its audience and reach, the one authorization path.
   */
  runtime?: {
    /** Only admitted GUI transcript subscriptions acquire a session view, never read followers. */
    viewSession?: (window: WindowId, canvas: CanvasId, agent: string) => () => void;
    source: Pick<
      RuntimeSource,
      | 'listen'
      | 'pending'
      | 'touched'
      | 'take'
      | 'taken'
      | 'state'
      | 'isPending'
      | 'available'
      | 'access'
    >;
    project: (
      topic: RuntimeTopicKey,
      caller: Caller,
      signal?: AbortSignal,
    ) => Promise<OpResult<unknown>>;
  };
}

/** The op a topic is read through, by its kind. */
function readOf(kind: TopicKind): OpName {
  const name = (Object.entries(SURFACE) as [OpName, Surface][]).find(
    ([, surface]) => surface.reads === kind,
  )?.[0];
  if (name === undefined) throw new OpFailure('not-found', 'There is no read for that topic.');
  return name;
}

/** Who sees a replaced topic alike: you, in every window, and each token apart. */
function groupOf(caller: Caller): string {
  return caller.kind === 'human' ? 'you' : callerKey(caller);
}

const SUMMARY_TOO_LARGE =
  'This topic’s summary is too large to send in one frame, so it can’t be subscribed to.';

export class Topics implements Publication {
  readonly epoch = randomUUID();
  readonly #deps: TopicsDeps;
  /** Each replaced topic's state as last read, by topic and by who sees it alike. */
  readonly #states = new Map<TopicKey, Map<string, TopicSnapshot>>();
  /** Each replaced topic's revision, by who sees it alike. */
  readonly #revs = new Map<TopicKey, Map<string, number>>();
  readonly #subscriptions = new Map<SubscriberId, Map<AnyTopic, Subscription>>();
  readonly #listeners = new Map<SubscriberId, (updates: TopicUpdate[]) => void>();
  readonly #pending = new Map<SubscriberId, TopicUpdate[]>();
  /** The replaced topics whose re-read is asked for and hasn't begun. */
  readonly #dirty = new Set<TopicKey>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  /** The global topics' sequence, and each canvas's. */
  #seq = 0;
  readonly #seqs = new Map<CanvasId, number>();
  #closed = false;
  /** Each runtime topic's revision: its canonical state's, moved at each change taken. */
  readonly #runtimeRevs = new Map<RuntimeTopicKey, number>();
  /** How far publication had gone as each topic's revision last moved (yours, for a replaced one). */
  readonly #allocated = new Map<string, number>();
  #publication = 0;
  /** The canvases whose runtime topics' publication is queued and hasn't begun. */
  readonly #scheduled = new Set<CanvasId>();
  /** Who made what a runtime topic has waiting to publish, as the op that made it says. */
  readonly #attributed = new Map<string, PartyId>();
  readonly #stopRuntime: (() => void) | undefined;

  constructor(deps: TopicsDeps) {
    this.#deps = deps;
    this.#stopRuntime = deps.runtime?.source.listen((canvas) => {
      this.#schedule(canvas);
    });
  }

  /** Subscribes a window to a topic, as you (the op's caller): its state now, and its revision. */
  subscribe(
    window: WindowId,
    request: {
      topic: TopicName | RuntimeTopicRequest['topic'];
      canvas?: string | undefined;
      agent?: string | undefined;
    },
    ctx: OpContext,
  ): Promise<Subscribed> {
    if (ctx.caller.kind !== 'human') {
      return Promise.reject(new OpFailure('human-only', 'Only the user may subscribe to topics.'));
    }
    return this.#subscribe(window, this.#keyOf(request), ctx.caller, ctx.signal);
  }

  unsubscribe(
    window: WindowId,
    request: {
      topic: TopicName | RuntimeTopicRequest['topic'];
      canvas?: string | undefined;
      agent?: string | undefined;
    },
  ): Promise<void> {
    const topic = this.#keyOf(request);
    return this.#serialize(() => {
      this.#forget(window, topic);
    });
  }

  /**
   * What a subscription of `caller` to `topic` carries: its state now (or its transfer's `begin`),
   * then its changes, to `listener`, batched as a window's. No transport serves it to a token (D5);
   * T3c reads what a token's would carry with it. Rejects as reading the topic as `caller` would.
   */
  follow(
    caller: Caller,
    topic: TopicKey,
    listener: (changes: (Change | RuntimeSnapshotFrame)[]) => void,
  ): Promise<{ snapshot: TopicSnapshot | RuntimeSnapshotFrame; stop: () => void }>;
  follow(
    caller: Caller,
    topic: RuntimeTopicKey,
    listener: (updates: TopicUpdate[]) => void,
  ): Promise<{ snapshot: RuntimeSnapshot | RuntimeSnapshotFrame; stop: () => void }>;
  async follow(
    caller: Caller,
    topic: AnyTopic,
    listener:
      ((changes: (Change | RuntimeSnapshotFrame)[]) => void) | ((updates: TopicUpdate[]) => void),
  ): Promise<{ snapshot: Subscribed; stop: () => void }> {
    const id = Symbol('follower');
    // A B9 topic's follower hears only its own changes.
    const stop = this.listen(id, listener as (updates: TopicUpdate[]) => void);
    try {
      return { snapshot: await this.#subscribe(id, topic, caller), stop };
    } catch (error) {
      stop();
      throw error;
    }
  }

  /** A replaced topic's source changed: it is read again, as each caller who subscribes to it. */
  changed(topic: TopicKey, by: Change['by']): void {
    if (this.#closed || this.#dirty.has(topic)) return;
    this.#dirty.add(topic);
    void this.#serialize(async () => {
      this.#dirty.delete(topic);
      if (this.#closed) return;
      const callers = new Map<string, Caller>();
      for (const topics of this.#subscriptions.values()) {
        const one = topics.get(topic);
        if (one) callers.set(groupOf(one.caller), one.caller);
      }
      // What no one subscribes to now is read afresh, at its next revision, by its next subscriber.
      const states = this.#states.get(topic);
      for (const group of states?.keys() ?? []) {
        if (callers.has(group)) continue;
        states?.delete(group);
        this.#bump(topic, group);
      }
      for (const [group, caller] of callers) {
        try {
          this.#replace(topic, group, await this.#state(topic, caller), by);
        } catch (error) {
          // A canvas closed or gone answers no more; its subscribers learn so as they read again.
          console.error('Could not read a changed topic:', error);
        }
      }
    });
  }

  /**
   * A canvas's commit, or a change to its meta, at its revision: said to each subscriber of its
   * `canvas:<c>`, as it is to whoever sees the whole canvas, and as what it changed of what they
   * see to the others.
   */
  publish(canvas: CanvasId, change: CanvasChange): void {
    if (this.#closed) return;
    const topic: TopicKey = `canvas:${canvas}`;
    let seq: number | undefined;
    for (const [id, topics] of this.#subscriptions) {
      const subscription = topics.get(topic);
      if (!subscription) continue;
      seq ??= this.#nextSeq(topic);
      const head = {
        topic,
        epoch: this.epoch,
        rev: change.rev,
        seq,
        by: change.by,
        at: Date.now(),
      };
      if (subscription.seen === undefined) {
        const update: Change = {
          ...head,
          set: change.set,
          ...(change.remove === undefined ? {} : { remove: change.remove }),
        };
        this.#legacyUpdate(id, update, this.#deps.view?.(canvas, subscription.caller).entities);

        continue;
      }
      const view = this.#deps.view?.(canvas, subscription.caller);
      if (!view) continue;
      const { set, remove } = diff(subscription.seen, view.entities);
      subscription.seen = view.entities;
      this.#legacyUpdate(
        id,
        { ...head, set, ...(remove.length === 0 ? {} : { remove }) },
        view.entities,
      );
    }
  }

  /** The one trusted port of a window hears only its subscriptions. */
  listen(id: SubscriberId, listener: (updates: TopicUpdate[]) => void): () => void {
    this.#listeners.set(id, listener);
    return () => {
      if (this.#listeners.get(id) !== listener) return;
      this.#listeners.delete(id);
      for (const topic of this.#subscriptions.get(id)?.keys() ?? []) this.#forget(id, topic);
      this.#subscriptions.delete(id);
      this.#pending.delete(id);
    };
  }

  /**
   * A runtime topic as `caller` may see it now, read through its projection (its audience and
   * reach): what T3c compares each copy with.
   */
  read(topic: RuntimeTopicKey, caller: Caller): Promise<OpResult<unknown>> {
    const runtime = this.#deps.runtime;
    if (!runtime)
      return Promise.resolve({
        ok: false,
        error: { code: 'unavailable', sentence: 'This core publishes no runtime topics.' },
      });
    return runtime.project(topic, caller);
  }

  /** Where publication is now: a write's receipts name what moved after it (call.ts). */
  mark(): number {
    return this.#publication;
  }

  /** An op made what `topic` has waiting to publish: its change is said to be by `by`. */
  attribute(topic: ReceiptTopic, by: PartyId): void {
    if (this.#deps.runtime?.source.isPending(topic) === true) this.#attributed.set(topic, by);
  }

  /**
   * Each of `topics`' revision once what it has waiting is published (yours, for a replaced one),
   * for those whose revision moved after `since`: a write's receipts.
   */
  receipts(
    topics: readonly ReceiptTopic[],
    since: number,
  ): Promise<Readonly<Record<string, number>>> {
    return this.#serialize(async () => {
      const canvases = new Set(
        topics.flatMap((topic) => (isRuntimeTopic(topic) ? [canvasOfTopic(topic)] : [])),
      );
      for (const canvas of canvases) if (canvas !== undefined) await this.#publishRuntime(canvas);
      return Object.fromEntries(
        topics.flatMap((topic) =>
          (this.#allocated.get(topic) ?? 0) > since ? [[topic, this.#revOf(topic)]] : [],
        ),
      );
    });
  }

  close(): void {
    this.#closed = true;
    this.#stopRuntime?.();
    clearTimeout(this.#timer);
    this.#listeners.clear();
    for (const [id, topics] of this.#subscriptions)
      for (const topic of topics.keys()) this.#forget(id, topic);
    this.#subscriptions.clear();
    this.#pending.clear();
    this.#scheduled.clear();
  }

  #keyOf(request: {
    topic: TopicName | RuntimeTopicRequest['topic'];
    canvas?: string | undefined;
    agent?: string | undefined;
  }): AnyTopic {
    try {
      if (isRuntimeTopic(`${request.topic}:`))
        return topicKey(
          RuntimeTopic.parse({
            topic: request.topic,
            canvas: request.canvas,
            ...(request.agent !== undefined ? { agent: request.agent } : {}),
          }),
        );
      return topicKey({
        topic: request.topic as TopicName,
        ...(request.canvas !== undefined ? { canvas: request.canvas } : {}),
      });
    } catch {
      throw new OpFailure('invalid', 'Name the canvas whose topic it is.');
    }
  }

  #subscribe(
    id: SubscriberId,
    topic: AnyTopic,
    caller: Caller,
    signal?: AbortSignal,
  ): Promise<Subscribed> {
    if (isRuntimeTopic(topic)) return this.#subscribeRuntime(id, topic, caller, signal);
    return this.#serialize(async () => {
      const canvas = canvasOfTopic(topic);
      const keyed = topic.startsWith('canvas:') && canvas !== undefined;
      // A keyed topic's state is the canvas's rows, read through canvas.get for its audience and
      // reach; a replaced one's, its op's result.
      const state = keyed
        ? await this.#read('canvas.get', { canvas }, caller)
        : await this.#state(topic, caller);
      signal?.throwIfAborted();
      if (this.#closed) throw new OpFailure('unavailable', 'corrallm’s core is closing.');
      let topics = this.#subscriptions.get(id);
      if (!topics) this.#subscriptions.set(id, (topics = new Map<AnyTopic, Subscription>()));
      if (keyed) {
        const view = this.#deps.view?.(canvas, caller);
        if (!view) throw new OpFailure('unavailable', 'This core keeps no canvas’s document.');
        // At once, so that what is committed next is said to it.
        topics.set(topic, view.all ? { caller } : { caller, seen: view.entities });
        const { first, rest } = this.#framesOf(topic, view.rev, view.entities);
        for (const frame of rest) this.#enqueue(id, frame);
        return first;
      }
      const group = groupOf(caller);
      // A subscribe can observe a change before its source's notification reaches the queue.
      this.#replace(topic, group, state as TopicSnapshot['state'], 'corrallm');
      topics.set(topic, { caller });
      const snapshot = this.#states.get(topic)?.get(group) ?? {
        epoch: this.epoch,
        rev: this.#revs.get(topic)?.get(group) ?? 0,
        state: state as TopicSnapshot['state'],
      };
      const { first, rest } = this.#framesOf(topic, snapshot.rev, snapshot.state);
      for (const frame of rest) this.#enqueue(id, frame);
      return first;
    });
  }

  /**
   * Subscribes to a runtime topic, in the queue's turn: read through its projection as `caller`
   * (refused as that read is), what changed before it published to those subscribed already, then
   * its state at its revision now: yours as the publisher last took it, a token's its projection
   * read again (whatever of it is newer, its next change says again). Answers it whole if it fits
   * a frame, else the `begin` of its transfer, whose chunks and `end` its port carries next.
   */
  #subscribeRuntime(
    id: SubscriberId,
    topic: RuntimeTopicKey,
    caller: Caller,
    signal?: AbortSignal,
  ): Promise<Subscribed> {
    return this.#serialize(async () => {
      const runtime = this.#deps.runtime;
      if (!runtime) throw new OpFailure('unavailable', 'This core publishes no runtime topics.');
      const allowed = await runtime.project(topic, caller, signal);
      if (!allowed.ok) throw new OpFailure(allowed.error.code, allowed.error.sentence);
      await this.#publishRuntime(argsOf(topic).canvas);
      let view: RuntimeState | undefined;
      if (caller.kind !== 'human') {
        const read = await runtime.project(topic, caller, signal);
        if (!read.ok) throw new OpFailure(read.error.code, read.error.sentence);
        view = projectData(read.value as RuntimeState);
      }
      signal?.throwIfAborted();
      if (this.#closed) throw new OpFailure('unavailable', 'corrallm’s core is closing.');
      let state: RuntimeState;
      try {
        state = view ?? runtime.source.state(topic);
      } catch (error) {
        throw new OpFailure('unavailable', error instanceof Error ? error.message : String(error));
      }
      const { first, rest } = this.#framesOf(topic, this.#runtimeRevs.get(topic) ?? 0, state);
      let topics = this.#subscriptions.get(id);
      if (!topics) this.#subscriptions.set(id, (topics = new Map<AnyTopic, Subscription>()));
      const { canvas, agent } = argsOf(topic);
      const release =
        topics.get(topic)?.release ??
        (typeof id === 'number' && caller.kind === 'human' && agent !== undefined
          ? runtime.viewSession?.(id, canvas, agent)
          : undefined);
      topics.set(
        topic,
        view === undefined
          ? { caller, ...(release === undefined ? {} : { release }) }
          : { caller, view, access: runtime.source.access(topic, caller) },
      );
      for (const frame of rest) this.#enqueue(id, frame);
      return first;
    });
  }

  /**
   * A runtime topic's snapshot at `rev`: whole, if it fits a frame; else its transfer, a `begin`
   * with its summary (refused, before any frame, if that alone doesn't fit), its chunks of entries
   * in order, each within a frame (an entry too big alone goes alone), and its `end`.
   */
  #framesOf(
    topic: AnyTopic,
    rev: number,
    state: RuntimeState | TopicSnapshot['state'],
    transfer = false,
  ): { first: Subscribed; rest: RuntimeSnapshotFrame[] } {
    const whole = { epoch: this.epoch, rev, state } as TopicSnapshot | RuntimeSnapshot;
    if (!transfer && bytesOf(whole) <= TOPIC_BUDGET) return { first: whole, rest: [] };
    const { summary, entries } = partsOf(topic, state);
    const base = { topic, epoch: this.epoch, snapshot: randomUUID() };
    const largest = { ...base, kind: 'begin' as const, summary, count: Number.MAX_SAFE_INTEGER };
    if (bytesOf(largest) > TOPIC_BUDGET) throw new OpFailure('unavailable', SUMMARY_TOO_LARGE);
    const chunks: Extract<RuntimeSnapshotFrame, { kind: 'chunk' }>[] = [];
    const empty = bytesOf({ ...base, kind: 'chunk', index: Number.MAX_SAFE_INTEGER, entries: [] });
    let piece: { key: string; value: unknown }[] = [];
    let bytes = empty;
    for (const entry of entries) {
      const size = bytesOf(entry) + 1;
      if (piece.length > 0 && bytes + size > TOPIC_BUDGET) {
        chunks.push({ ...base, kind: 'chunk', index: chunks.length, entries: piece });
        piece = [];
        bytes = empty;
      }
      piece.push(entry);
      bytes += size;
    }
    if (piece.length > 0)
      chunks.push({ ...base, kind: 'chunk', index: chunks.length, entries: piece });
    // Only an entry no frame holds with its envelope may pass one, alone in its chunk (B11 §16.3).
    for (const chunk of chunks)
      if (bytesOf(chunk) > TOPIC_BUDGET && chunk.entries.length > 1)
        throw new Error('A snapshot chunk of several entries passed its frame.');
    return {
      first: { ...base, kind: 'begin', summary, count: chunks.length },
      rest: [...chunks, { ...base, kind: 'end', rev }],
    };
  }

  /** Soon publishes what a canvas's runtime topics have waiting, in the queue's turn. */
  #schedule(canvas: CanvasId): void {
    if (this.#closed || this.#scheduled.has(canvas)) return;
    this.#scheduled.add(canvas);
    void this.#serialize(async () => {
      this.#scheduled.delete(canvas);
      await this.#publishRuntime(canvas);
    }).catch((error: unknown) => {
      console.error('Could not publish a canvas’s runtime topics:', error);
    });
  }

  /**
   * Publishes what a canvas's runtime topics have waiting, within the queue's turn: each topic's
   * canonical change taken from its source (its baseline moves on at once); each copy that sees
   * less read again through its projection (one no longer allowed it is ended); then each topic's
   * revisions allocated, as many as its biggest change needs frames, and each subscriber sent its
   * own change at each, or an empty one.
   */
  async #publishRuntime(canvas: CanvasId): Promise<void> {
    const runtime = this.#deps.runtime;
    if (!runtime || this.#stopped()) return;
    const { source } = runtime;
    const pending = source.pending(canvas);
    const touched = source.touched(canvas);
    if (pending.length === 0 && !touched) return;
    const canonical = new Map<RuntimeTopicKey, { bodies: RuntimeBody[]; by: PartyId | 'cli' }>();
    for (const topic of pending) {
      const taken = source.take(topic);
      if (!taken) continue;
      canonical.set(topic, {
        bodies: divide(topic, taken.body, this.#headBytes(topic)),
        by: this.#attributedBy(topic) ?? taken.by,
      });
    }
    source.taken(canvas);
    for (const kind of ['run', 'sessions', 'messages'])
      this.#attributed.delete(`${kind}:${canvas}`);
    const partial: {
      id: SubscriberId;
      topic: RuntimeTopicKey;
      bodies: RuntimeBody[];
      snapshot: boolean;
    }[] = [];
    for (const [id, topics] of [...this.#subscriptions]) {
      for (const [topic, subscription] of [...topics]) {
        if (!isRuntimeTopic(topic) || canvasOfTopic(topic) !== canvas) continue;
        if (!source.available(topic)) {
          this.#forget(id, topic);
          continue;
        }
        if (subscription.view === undefined) continue;
        const access = source.access(topic, subscription.caller);
        if (sameAccess(subscription.access, access) && !canonical.has(topic)) continue;
        const snapshot = !sameAccess(subscription.access, access);
        const read = await runtime.project(topic, subscription.caller);
        if (this.#stopped()) return;
        if (this.#subscriptions.get(id)?.get(topic) !== subscription) continue;
        if (!read.ok) {
          // It no longer reaches what it subscribed to: its subscription ends.
          this.#forget(id, topic);
          continue;
        }
        const next = projectData(read.value as RuntimeState, subscription.view);
        const body = viewDiff(topic, subscription.view, next);
        subscription.view = next;
        subscription.access = access;
        if (snapshot && !body) {
          try {
            const { first, rest } = this.#framesOf(
              topic,
              this.#runtimeRevs.get(topic) ?? 0,
              next,
              true,
            );
            this.#transfer(id, topic, [first as RuntimeSnapshotFrame, ...rest], false);
          } catch {
            this.#forget(id, topic);
          }
        }
        partial.push({
          snapshot,
          id,
          topic,
          bodies: body
            ? !snapshot && appendsOnly(topic, canonical.get(topic)?.bodies)
              ? (canonical.get(topic)?.bodies ?? [])
              : divide(topic, body, this.#headBytes(topic))
            : [],
        });
      }
    }
    const changed = new Set([
      ...canonical.keys(),
      ...partial.flatMap(({ topic, bodies }) => (bodies.length > 0 ? [topic] : [])),
    ]);
    for (const topic of changed) {
      const mine = canonical.get(topic);
      const theirs = partial.filter((one) => one.topic === topic);
      const oversize = (bodies: readonly RuntimeBody[]) =>
        bodies.some((body) => this.#headBytes(topic) + bytesOf(body) > TOPIC_BUDGET);
      const mineSnapshot = oversize(mine?.bodies ?? []);
      const theirsSnapshot = new Set(
        theirs.filter(({ bodies, snapshot }) => snapshot || oversize(bodies)).map(({ id }) => id),
      );
      const count = Math.max(
        mine?.bodies.length ?? 0,
        ...theirs.map(({ bodies }) => bodies.length),
      );
      for (let index = 0; index < count; index++) {
        const rev = this.#allocate(topic);
        // One sequence number for the change, taken once someone is sent it.
        let head: Head | undefined;
        const headOf = (): Head =>
          (head ??= {
            topic,
            epoch: this.epoch,
            rev,
            seq: this.#nextCanvasSeq(canvas),
            by: mine?.by ?? 'corrallm',
            at: Date.now(),
          });
        for (const [id, topics] of this.#subscriptions) {
          const subscription = topics.get(topic);
          if (!subscription || subscription.view !== undefined) continue;
          this.#runtimeUpdate(
            id,
            topic,
            headOf(),
            mine?.bodies[index] ?? emptyBody(topic),
            () => source.state(topic),
            mineSnapshot,
            index === count - 1,
            true,
          );
        }
        for (const { id, bodies, snapshot } of theirs) {
          const subscription = this.#subscriptions.get(id)?.get(topic);
          const view = subscription?.view;
          if (view === undefined) continue;
          this.#runtimeUpdate(
            id,
            topic,
            headOf(),
            bodies[index] ?? emptyBody(topic),
            () => view,
            theirsSnapshot.has(id),
            index === count - 1,
            // What waits for a copy whose authority changed was read under the old.
            !snapshot,
          );
        }
      }
    }
  }

  /**
   * Oversized entries and authoritative orders use the same atomic transfer as subscribe.
   * `keep`: whether what waits to be sent of the topic is still the subscriber's to see.
   */
  #runtimeUpdate(
    id: SubscriberId,
    topic: RuntimeTopicKey,
    head: Head,
    body: RuntimeBody,
    state: () => RuntimeState,
    snapshot: boolean,
    last: boolean,
    keep: boolean,
  ): void {
    if (!snapshot) {
      this.#enqueue(id, { ...head, ...body } as TopicUpdate);
      return;
    }
    if (!last) {
      this.#enqueue(id, { ...head, ...emptyBody(topic) } as TopicUpdate);
      return;
    }
    try {
      const { first, rest } = this.#framesOf(topic, head.rev, state(), true);
      this.#transfer(id, topic, [first as RuntimeSnapshotFrame, ...rest], keep);
    } catch {
      // A refused projection must not leak data or its reason through a subscriber's copy.
      this.#forget(id, topic);
    }
  }

  /**
   * Replaces what waits to be sent `id` of `topic` with a transfer of it, `frames`, none of what it
   * replaces ever sent, but for the rest of a transfer whose `begin` it was sent already (its
   * subscription's answer, or an earlier batch): that ends first, as its copy expects, the new one
   * after it. A copy whose authority changed (`keep` false) can't be sent that rest, read under the
   * old, nor be left mid-transfer: its subscription ends.
   */
  #transfer(
    id: SubscriberId,
    topic: AnyTopic,
    frames: readonly RuntimeSnapshotFrame[],
    keep: boolean,
  ): void {
    const pending = this.#pending.get(id) ?? [];
    const begun = new Set(begunIn(pending, topic));
    const sent = (update: TopicUpdate) =>
      update.topic === topic && 'kind' in update && !begun.has(update.snapshot);
    if (!keep && pending.some(sent)) {
      this.#forget(id, topic);
      return;
    }
    this.#pending.set(
      id,
      pending.filter((update) => update.topic !== topic || sent(update)),
    );
    for (const frame of frames) this.#enqueue(id, frame);
  }

  /** Whether it has closed (read anew after an await). */
  #stopped(): boolean {
    return this.#closed;
  }

  /** The most bytes a change's head takes, for its body to fit a frame beside it. */
  #headBytes(topic: RuntimeTopicKey): number {
    return bytesOf({
      topic,
      epoch: this.epoch,
      rev: Number.MAX_SAFE_INTEGER,
      seq: Number.MAX_SAFE_INTEGER,
      by: 'x'.repeat(320),
      at: Number.MAX_SAFE_INTEGER,
    });
  }

  /** Who the op that made what a runtime topic has waiting said made it, if one did. */
  #attributedBy(topic: RuntimeTopicKey): PartyId | undefined {
    const canvas = canvasOfTopic(topic);
    const kind = kindOf(topic);
    return this.#attributed.get(`${kind === 'session' ? 'sessions' : kind}:${canvas ?? ''}`);
  }

  /** A runtime topic's next revision, at the next step of publication. */
  #allocate(topic: RuntimeTopicKey): number {
    const rev = (this.#runtimeRevs.get(topic) ?? 0) + 1;
    this.#runtimeRevs.set(topic, rev);
    this.#allocated.set(topic, ++this.#publication);
    return rev;
  }

  /** A topic's revision now: a runtime one's, or yours of a replaced one. */
  #revOf(topic: ReceiptTopic): number {
    return isRuntimeTopic(topic)
      ? (this.#runtimeRevs.get(topic) ?? 0)
      : (this.#revs.get(topic)?.get('you') ?? 0);
  }

  #forget(id: SubscriberId, topic: AnyTopic): void {
    this.#subscriptions.get(id)?.get(topic)?.release?.();
    this.#subscriptions.get(id)?.delete(topic);
    const pending = this.#pending.get(id);
    if (pending)
      this.#pending.set(
        id,
        pending.filter((change) => change.topic !== topic),
      );
  }

  /** A replaced topic's state, read through its op as `caller`. */
  async #state(topic: TopicKey, caller: Caller): Promise<TopicSnapshot['state']> {
    const request = topicRequest(topic);
    const args = 'canvas' in request ? { canvas: request.canvas } : {};
    return (await this.#read(readOf(request.topic), args, caller)) as TopicSnapshot['state'];
  }

  async #read(name: OpName, args: unknown, caller: Caller): Promise<unknown> {
    const result = await this.#deps.read(name, args, caller);
    if (!result.ok) throw new OpFailure(result.error.code, result.error.sentence);
    return result.value;
  }

  #replace(topic: TopicKey, group: string, state: TopicSnapshot['state'], by: Change['by']): void {
    let states = this.#states.get(topic);
    if (!states) this.#states.set(topic, (states = new Map<string, TopicSnapshot>()));
    const previous = states.get(group);
    if (previous && JSON.stringify(previous.state) === JSON.stringify(state)) return;
    const rev = previous ? this.#bump(topic, group) : (this.#revs.get(topic)?.get(group) ?? 0);
    states.set(group, { epoch: this.epoch, rev, state });
    if (!previous) return;
    const change = {
      topic,
      epoch: this.epoch,
      rev,
      seq: this.#nextSeq(topic),
      by,
      at: Date.now(),
      replace: state,
    } as Change;
    for (const [id, topics] of this.#subscriptions) {
      const one = topics.get(topic);
      if (one && groupOf(one.caller) === group) this.#legacyUpdate(id, change, state);
    }
  }

  /** Existing topics use the identical transfer when their snapshot or a live change is large. */
  #legacyUpdate(id: SubscriberId, change: Change, state: TopicSnapshot['state'] | undefined): void {
    if (bytesOf(change) <= TOPIC_BUDGET) {
      this.#enqueue(id, change);
      return;
    }
    if (state === undefined) {
      this.#forget(id, change.topic);
      return;
    }
    try {
      const { first, rest } = this.#framesOf(change.topic, change.rev, state, true);
      this.#transfer(id, change.topic, [first as RuntimeSnapshotFrame, ...rest], true);
    } catch {
      this.#forget(id, change.topic);
    }
  }

  /** A replaced topic's next revision for those who see it alike. */
  #bump(topic: TopicKey, group: string): number {
    let revs = this.#revs.get(topic);
    if (!revs) this.#revs.set(topic, (revs = new Map<string, number>()));
    const rev = (revs.get(group) ?? 0) + 1;
    revs.set(group, rev);
    if (group === 'you') this.#allocated.set(topic, ++this.#publication);
    return rev;
  }

  /** The next sequence number: the canvas's, for a canvas's topic; the global one's otherwise. */
  #nextSeq(topic: TopicKey): number {
    const canvas = canvasOfTopic(topic);
    return canvas === undefined ? ++this.#seq : this.#nextCanvasSeq(canvas);
  }

  #nextCanvasSeq(canvas: CanvasId): number {
    const seq = (this.#seqs.get(canvas) ?? 0) + 1;
    this.#seqs.set(canvas, seq);
    return seq;
  }

  #enqueue(id: SubscriberId, update: TopicUpdate): void {
    let pending = this.#pending.get(id);
    if (!pending) this.#pending.set(id, (pending = []));
    pending.push(update);
    this.#timer ??= setTimeout(() => {
      void this.#serialize(() => this.#flush()).catch((error: unknown) => {
        console.error('Could not flush topic changes:', error);
      });
    }, 16);
  }

  /** Sends each subscriber what waits for it, in order, in batches that each fit a frame. */
  async #flush(): Promise<void> {
    this.#timer = undefined;
    const pending = [...this.#pending];
    this.#pending.clear();
    for (const [id, queued] of pending) {
      let updates = queued;
      const listener = this.#listeners.get(id);
      if (!listener || updates.length === 0) continue;
      const runtime = this.#deps.runtime;
      // Nothing can interleave between the final synchronous stamp check and sending the batch.
      // If reach changed during the batching delay, replace all older frames with a fresh copy.
      if (runtime) {
        for (;;) {
          let refreshed = false;
          for (const topic of new Set(updates.map((update) => update.topic))) {
            if (!isRuntimeTopic(topic)) continue;
            const subscription = this.#subscriptions.get(id)?.get(topic);
            if (!subscription) {
              updates = updates.filter((update) => update.topic !== topic);
              continue;
            }
            if (subscription.view === undefined) {
              if (!runtime.source.available(topic)) {
                this.#forget(id, topic);
                updates = updates.filter((update) => update.topic !== topic);
              }
              continue;
            }
            const access = runtime.source.access(topic, subscription.caller);
            if (sameAccess(subscription.access, access)) continue;
            refreshed = true;
            const read = await runtime.project(topic, subscription.caller);
            // The rest of a transfer begun in an earlier batch was read under the old authority:
            // never sent, it leaves the copy mid-transfer, so its subscription ends.
            const begun = new Set(begunIn(updates, topic));
            const midway = updates.some(
              (update) => update.topic === topic && 'kind' in update && !begun.has(update.snapshot),
            );
            updates = updates.filter((update) => update.topic !== topic);
            this.#pending.set(
              id,
              (this.#pending.get(id) ?? []).filter((update) => update.topic !== topic),
            );
            if (!read.ok || midway) {
              this.#forget(id, topic);
              continue;
            }
            subscription.view = projectData(read.value as RuntimeState, subscription.view);
            subscription.access = access;
            try {
              const { first, rest } = this.#framesOf(
                topic,
                this.#runtimeRevs.get(topic) ?? 0,
                subscription.view,
                true,
              );
              updates.push(first as RuntimeSnapshotFrame, ...rest);
            } catch {
              this.#forget(id, topic);
            }
          }
          if (!refreshed) break;
        }
      }
      if (this.#closed || this.#listeners.get(id) !== listener) continue;
      for (const batch of batches(updates)) listener(batch);
    }
  }

  #serialize<T>(run: () => T | Promise<T>): Promise<T> {
    const result = this.#queue.then(run);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}

/**
 * `updates` in order, as batches whose JSON each fits a frame beside its envelope: one too big
 * alone (a chunk of one big entry) goes alone.
 */
function batches(updates: readonly TopicUpdate[]): TopicUpdate[][] {
  const out: TopicUpdate[][] = [];
  let batch: TopicUpdate[] = [];
  let bytes = 2;
  for (const update of updates) {
    const size = bytesOf(update) + 1;
    if (batch.length > 0 && bytes + size > TOPIC_BUDGET) {
      out.push(batch);
      batch = [];
      bytes = 2;
    }
    batch.push(update);
    bytes += size;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

/** What changed from the entities `before` to `after`: what to set, and what to remove. */
function diff(
  before: Entities,
  after: Entities,
): { set: Record<EntityKey, Entity>; remove: EntityKey[] } {
  const set: Record<EntityKey, Entity> = {};
  for (const [key, entity] of Object.entries(after)) {
    const was = before[key];
    if (was !== entity && JSON.stringify(was) !== JSON.stringify(entity)) set[key] = entity;
  }
  return { set, remove: Object.keys(before).filter((key) => !Object.hasOwn(after, key)) };
}

function sameAccess(
  previous: Subscription['access'],
  next: NonNullable<Subscription['access']>,
): boolean {
  return previous?.world === next.world && previous?.lead === next.lead;
}

/** The transfers of `topic` whose `begin` is among `updates`, by their snapshot ids. */
function begunIn(updates: readonly TopicUpdate[], topic: AnyTopic): string[] {
  return updates.flatMap((update) =>
    update.topic === topic && 'kind' in update && update.kind === 'begin' ? [update.snapshot] : [],
  );
}

/** Appends contain no caller-specific fields once the session's unchanged reach is authorized. */
function appendsOnly(topic: RuntimeTopicKey, bodies: readonly RuntimeBody[] | undefined): boolean {
  return (
    topic.startsWith('session:') &&
    bodies?.every(
      (body) => 'entries' in body && !body.summary && !body.entries.upsert && !body.entries.order,
    ) === true
  );
}
