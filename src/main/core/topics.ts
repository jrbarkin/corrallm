import { randomUUID } from 'node:crypto';

import { SURFACE } from '../../shared/api/surface';
import type { OpName, Surface, TopicKind } from '../../shared/api/surface';
import { canvasOfTopic, topicKey, topicRequest } from '../../shared/api/topics';
import type { Change, TopicKey, TopicName, TopicSnapshot } from '../../shared/api/topics';
import type { CanvasId } from '../../shared/canvas';
import type { EntityKey } from '../../shared/model/rows';
import type { Entities, Entity } from '../../shared/model/state';
import type { OpContext, Dispatcher } from './call';
import { OpFailure } from './call';
import { callerKey } from './caller';
import type { Caller } from './caller';
import type { CanvasChange } from './canvas/states';
import type { WindowId } from './host';

/*
 * The topics (Core Server §5.1–5.2, B9 Design §7): a subscriber gets the very state its read
 * operation gives it, through that operation's dispatcher and audience, and the changes after it,
 * batched per subscriber every 16 ms. A window subscribes through `topics.subscribe`, as you; any
 * other caller only through `follow` (no transport serves it: tokens get no topics, D5), which T3c
 * reads what a token's subscription would carry with.
 *
 * `usage`, `settings`, `canvases` and a canvas's `needs:<c>` are replaced whole: when their source
 * says it changed, they are read again through their op, once for each caller who sees them alike
 * (you, in every window, as one), and a change goes out only if what was read differs. A canvas's
 * `canvas:<c>` is keyed: each change is the commit's diff (canvas/states.ts), at the commit's
 * revision, never a re-read, which goes out as it is to whoever sees the whole canvas, and as what
 * it changed of what each other subscriber sees (canvas/view.ts) to them, so a topic is never a
 * second way to reach anything. Revisions are per topic (a canvas's is its document's); sequence
 * numbers are a canvas's for its topics, and the global ones share theirs. A new core has a new
 * epoch; no subscription outlives its subscriber.
 */

/** Who subscribes: a window, or a follower in the core. */
type SubscriberId = WindowId | symbol;

interface Subscription {
  caller: Caller;
  /** For a keyed topic seen in part: the entities it was last told of. */
  seen?: Entities;
}

export interface TopicsDeps {
  /** Calls a topic's read op as a subscriber: its state, through its audience and reach. */
  read: Dispatcher['call'];
  /**
   * A canvas's entities as `caller` sees them now (it read the canvas through `canvas.get` first),
   * at its revision, and whether it sees them all.
   */
  view?: (canvas: CanvasId, caller: Caller) => { rev: number; entities: Entities; all: boolean };
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

export class Topics {
  readonly epoch = randomUUID();
  readonly #deps: TopicsDeps;
  /** Each replaced topic's state as last read, by topic and by who sees it alike. */
  readonly #states = new Map<TopicKey, Map<string, TopicSnapshot>>();
  /** Each replaced topic's revision, by who sees it alike. */
  readonly #revs = new Map<TopicKey, Map<string, number>>();
  readonly #subscriptions = new Map<SubscriberId, Map<TopicKey, Subscription>>();
  readonly #listeners = new Map<SubscriberId, (changes: Change[]) => void>();
  readonly #pending = new Map<SubscriberId, Change[]>();
  /** The replaced topics whose re-read is asked for and hasn't begun. */
  readonly #dirty = new Set<TopicKey>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  /** The global topics' sequence, and each canvas's. */
  #seq = 0;
  readonly #seqs = new Map<CanvasId, number>();
  #closed = false;

  constructor(deps: TopicsDeps) {
    this.#deps = deps;
  }

  /** Subscribes a window to a topic, as you (the op's caller): its state now, and its revision. */
  subscribe(
    window: WindowId,
    request: { topic: TopicName; canvas?: string | undefined },
    ctx: OpContext,
  ): Promise<TopicSnapshot> {
    if (ctx.caller.kind !== 'human') {
      return Promise.reject(new OpFailure('human-only', 'Only the user may subscribe to topics.'));
    }
    return this.#subscribe(window, this.#keyOf(request), ctx.caller, ctx.signal);
  }

  unsubscribe(
    window: WindowId,
    request: { topic: TopicName; canvas?: string | undefined },
  ): Promise<void> {
    const topic = this.#keyOf(request);
    return this.#serialize(() => {
      this.#forget(window, topic);
    });
  }

  /**
   * What a subscription of `caller` to `topic` carries: its state now, then its changes, to
   * `listener`, batched as a window's. No transport serves it to a token (D5); T3c reads what a
   * token's would carry with it. Rejects as reading the topic's op as `caller` would.
   */
  async follow(
    caller: Caller,
    topic: TopicKey,
    listener: (changes: Change[]) => void,
  ): Promise<{ snapshot: TopicSnapshot; stop: () => void }> {
    const id = Symbol('follower');
    const stop = this.listen(id, listener);
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
        this.#enqueue(id, {
          ...head,
          set: change.set,
          ...(change.remove === undefined ? {} : { remove: change.remove }),
        });
        continue;
      }
      const view = this.#deps.view?.(canvas, subscription.caller);
      if (!view) continue;
      const { set, remove } = diff(subscription.seen, view.entities);
      subscription.seen = view.entities;
      this.#enqueue(id, { ...head, set, ...(remove.length === 0 ? {} : { remove }) });
    }
  }

  /** The one trusted port of a window hears only its subscriptions. */
  listen(id: SubscriberId, listener: (changes: Change[]) => void): () => void {
    this.#listeners.set(id, listener);
    return () => {
      if (this.#listeners.get(id) !== listener) return;
      this.#listeners.delete(id);
      this.#subscriptions.delete(id);
      this.#pending.delete(id);
    };
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#listeners.clear();
    this.#subscriptions.clear();
    this.#pending.clear();
  }

  #keyOf(request: { topic: TopicName; canvas?: string | undefined }): TopicKey {
    try {
      return topicKey(request);
    } catch {
      throw new OpFailure('invalid', 'Name the canvas whose topic it is.');
    }
  }

  #subscribe(
    id: SubscriberId,
    topic: TopicKey,
    caller: Caller,
    signal?: AbortSignal,
  ): Promise<TopicSnapshot> {
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
      if (!topics) this.#subscriptions.set(id, (topics = new Map<TopicKey, Subscription>()));
      if (keyed) {
        const view = this.#deps.view?.(canvas, caller);
        if (!view) throw new OpFailure('unavailable', 'This core keeps no canvas’s document.');
        // At once, so that what is committed next is said to it.
        topics.set(topic, view.all ? { caller } : { caller, seen: view.entities });
        return { epoch: this.epoch, rev: view.rev, state: view.entities };
      }
      const group = groupOf(caller);
      // A subscribe can observe a change before its source's notification reaches the queue.
      this.#replace(topic, group, state as TopicSnapshot['state'], 'corrallm');
      topics.set(topic, { caller });
      return (
        this.#states.get(topic)?.get(group) ?? {
          epoch: this.epoch,
          rev: this.#revs.get(topic)?.get(group) ?? 0,
          state: state as TopicSnapshot['state'],
        }
      );
    });
  }

  #forget(id: SubscriberId, topic: TopicKey): void {
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
      if (one && groupOf(one.caller) === group) this.#enqueue(id, change);
    }
  }

  /** A replaced topic's next revision for those who see it alike. */
  #bump(topic: TopicKey, group: string): number {
    let revs = this.#revs.get(topic);
    if (!revs) this.#revs.set(topic, (revs = new Map<string, number>()));
    const rev = (revs.get(group) ?? 0) + 1;
    revs.set(group, rev);
    return rev;
  }

  /** The next sequence number: the canvas's, for a canvas's topic; the global one's otherwise. */
  #nextSeq(topic: TopicKey): number {
    const canvas = canvasOfTopic(topic);
    if (canvas === undefined) return ++this.#seq;
    const seq = (this.#seqs.get(canvas) ?? 0) + 1;
    this.#seqs.set(canvas, seq);
    return seq;
  }

  #enqueue(id: SubscriberId, change: Change): void {
    this.#pending.set(id, [...(this.#pending.get(id) ?? []), change]);
    this.#timer ??= setTimeout(() => {
      this.#flush();
    }, 16);
  }

  #flush(): void {
    this.#timer = undefined;
    const pending = [...this.#pending];
    this.#pending.clear();
    for (const [id, changes] of pending) {
      if (changes.length > 0) this.#listeners.get(id)?.(changes);
    }
  }

  #serialize<T>(run: () => T | Promise<T>): Promise<T> {
    const result = this.#queue.then(run);
    this.#queue = result.catch(() => undefined);
    return result;
  }
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
