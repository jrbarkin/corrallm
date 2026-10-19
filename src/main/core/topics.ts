import { randomUUID } from 'node:crypto';

import { SURFACE } from '../../shared/api/surface';
import type { OpName, Surface } from '../../shared/api/surface';
import type { Change, TopicKey, TopicSnapshot } from '../../shared/api/topics';
import type { OpContext, Dispatcher } from './call';
import { OpFailure } from './call';
import type { HumanCaller } from './caller';
import type { WindowId } from './host';

/*
 * Global topics (Core Server §5.2): a window gets the very state its read operation gives it,
 * through that operation's dispatcher and audience. Changes keep each topic's revisions and are
 * batched per window every 16 ms. A new core has a new epoch; no subscription outlives a port.
 */

interface Subscription {
  caller: HumanCaller;
}

export class Topics {
  readonly epoch = randomUUID();
  readonly #read: Dispatcher['call'];
  readonly #states = new Map<TopicKey, TopicSnapshot>();
  readonly #revs = new Map<TopicKey, number>();
  readonly #subscriptions = new Map<WindowId, Map<TopicKey, Subscription>>();
  readonly #listeners = new Map<WindowId, (changes: Change[]) => void>();
  readonly #pending = new Map<WindowId, Change[]>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #seq = 0;
  #closed = false;

  constructor(read: Dispatcher['call']) {
    this.#read = read;
  }

  subscribe(window: WindowId, topic: TopicKey, ctx: OpContext): Promise<TopicSnapshot> {
    return this.#serialize(async () => {
      const state = await this.#state(topic, ctx.caller);
      ctx.signal.throwIfAborted();
      if (this.#closed) throw new OpFailure('unavailable', 'corrallm’s core is closing.');
      // A subscribe can observe a change before its source's notification reaches the queue.
      this.#replace(topic, state, 'corrallm');
      let topics = this.#subscriptions.get(window);
      if (!topics) this.#subscriptions.set(window, (topics = new Map<TopicKey, Subscription>()));
      if (ctx.caller.kind !== 'human')
        throw new OpFailure('human-only', 'Only the user may subscribe to topics.');
      topics.set(topic, { caller: ctx.caller });
      return (
        this.#states.get(topic) ?? { epoch: this.epoch, rev: this.#revs.get(topic) ?? 0, state }
      );
    });
  }

  unsubscribe(window: WindowId, topic: TopicKey): Promise<void> {
    return this.#serialize(() => {
      this.#subscriptions.get(window)?.delete(topic);
      this.#pending.set(
        window,
        (this.#pending.get(window) ?? []).filter((change) => change.topic !== topic),
      );
    });
  }

  /** A source changed: read it with a subscriber's caller, through the same op and reach checks. */
  changed(topic: TopicKey, by: Change['by']): void {
    void this.#serialize(async () => {
      if (this.#closed) return;
      const subscriber = [...this.#subscriptions.values()].flatMap((topics) => {
        const one = topics.get(topic);
        return one ? [one] : [];
      })[0];
      if (!subscriber) {
        this.#states.delete(topic);
        this.#revs.set(topic, (this.#revs.get(topic) ?? 0) + 1);
        return;
      }
      this.#replace(topic, await this.#state(topic, subscriber.caller), by);
    }).catch((error: unknown) => {
      console.error('Could not read a changed topic:', error);
    });
  }

  /** The one trusted port of a window hears only its subscriptions. */
  listen(window: WindowId, listener: (changes: Change[]) => void): () => void {
    this.#listeners.set(window, listener);
    return () => {
      if (this.#listeners.get(window) !== listener) return;
      this.#listeners.delete(window);
      this.#subscriptions.delete(window);
      this.#pending.delete(window);
    };
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#listeners.clear();
    this.#subscriptions.clear();
    this.#pending.clear();
  }

  async #state(topic: TopicKey, caller: OpContext['caller']): Promise<TopicSnapshot['state']> {
    const name = (Object.entries(SURFACE) as [OpName, Surface][]).find(
      ([, surface]) => surface.reads === topic,
    )?.[0];
    if (name === undefined) throw new OpFailure('not-found', 'There is no read for that topic.');
    const result = await this.#read(name, {}, caller);
    if (!result.ok) throw new OpFailure(result.error.code, result.error.sentence);
    return result.value as TopicSnapshot['state'];
  }

  #replace(topic: TopicKey, state: TopicSnapshot['state'], by: Change['by']): void {
    const previous = this.#states.get(topic);
    if (previous && JSON.stringify(previous.state) === JSON.stringify(state)) return;
    const rev = (this.#revs.get(topic) ?? 0) + (previous ? 1 : 0);
    this.#revs.set(topic, rev);
    this.#states.set(topic, { epoch: this.epoch, rev, state });
    if (!previous) return;
    const change = {
      topic,
      epoch: this.epoch,
      rev,
      seq: ++this.#seq,
      by,
      at: Date.now(),
      replace: state,
    } as Change;
    for (const [window, topics] of this.#subscriptions) {
      if (!topics.has(topic)) continue;
      this.#pending.set(window, [...(this.#pending.get(window) ?? []), change]);
    }
    if (this.#pending.size > 0)
      this.#timer ??= setTimeout(() => {
        this.#flush();
      }, 16);
  }

  #flush(): void {
    this.#timer = undefined;
    const pending = [...this.#pending];
    this.#pending.clear();
    for (const [window, changes] of pending) {
      if (changes.length > 0) this.#listeners.get(window)?.(changes);
    }
  }

  #serialize<T>(run: () => T | Promise<T>): Promise<T> {
    const result = this.#queue.then(run);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}
