import { useCallback, useSyncExternalStore } from 'react';

import type { Change, TopicKey, TopicSnapshot, TopicStates } from '../../shared/api/topics';
import { topicRequest } from '../../shared/api/topics';
import type { GuiApi } from '../../shared/gui-link';
import { ipcErrorMessage } from '../ipc-error';
import { ApiError, bridge } from './bridge';

export type TopicSource = Pick<
  GuiApi,
  'topicsSubscribe' | 'topicsUnsubscribe' | 'topicsOnChange' | 'topicsOnEpoch'
>;

interface Mirrored {
  topic: TopicKey;
  state?: TopicSnapshot['state'];
  rev?: number;
  listeners: Set<() => void>;
  waiters: Set<{ rev: number; resolve: () => void; reject: (error: unknown) => void }>;
  live: boolean;
  pending: boolean;
  generation: number;
  buffered: Change[];
}

/** Equal row data keeps its existing objects, even after a fresh snapshot or an equal set. */
function share(previous: unknown, next: unknown): unknown {
  if (Object.is(previous, next)) return previous;
  if (
    typeof previous !== 'object' ||
    previous === null ||
    typeof next !== 'object' ||
    next === null ||
    Array.isArray(previous) !== Array.isArray(next)
  )
    return next;
  const old = previous as Record<string, unknown>;
  const values = Object.entries(next).map(([key, value]) => [key, share(old[key], value)] as const);
  if (
    Object.keys(previous).length === values.length &&
    values.every(([key, value]) => Object.hasOwn(previous, key) && Object.is(old[key], value))
  )
    return previous;
  return Array.isArray(next) ? values.map(([, value]) => value) : Object.fromEntries(values);
}

/** A window's immutable topic snapshots, with one subscription per topic while it is observed. */
export class TopicMirror {
  readonly #source: TopicSource;
  readonly #topics = new Map<TopicKey, Mirrored>();
  #epoch: string | undefined;
  #stops: (() => void)[] | undefined;

  constructor(source: TopicSource) {
    this.#source = source;
  }

  snapshot<K extends TopicKey>(topic: K): TopicStates[K] | undefined {
    return this.#topics.get(topic)?.state as TopicStates[K] | undefined;
  }

  /** The revision of the topic's snapshot: none before its first. */
  revision(topic: TopicKey): number | undefined {
    return this.#topics.get(topic)?.rev;
  }

  subscribe(topic: TopicKey, listener: () => void): () => void {
    const entry = this.#entry(topic);
    entry.listeners.add(listener);
    this.#activate(entry);
    return () => {
      entry.listeners.delete(listener);
      this.#release(entry);
    };
  }

  /** An operation can await its changes even if no view currently observes that topic. */
  whenAt(topic: TopicKey, rev: number): Promise<void> {
    const entry = this.#entry(topic);
    if (entry.live && entry.rev !== undefined && entry.rev >= rev) return Promise.resolve();
    const waiting = new Promise<void>((resolve, reject) =>
      entry.waiters.add({ rev, resolve, reject }),
    );
    this.#activate(entry);
    return waiting;
  }

  #entry(topic: TopicKey): Mirrored {
    let entry = this.#topics.get(topic);
    if (!entry) {
      entry = {
        topic,
        listeners: new Set(),
        waiters: new Set(),
        live: false,
        pending: false,
        generation: 0,
        buffered: [],
      };
      this.#topics.set(topic, entry);
    }
    return entry;
  }

  #activate(entry: Mirrored): void {
    entry.live = true;
    this.#listen();
    if (this.#epoch !== undefined && entry.rev === undefined) this.#read(entry);
  }

  #release(entry: Mirrored): void {
    // StrictMode's immediate cleanup and re-subscription keep the one subscription.
    queueMicrotask(() => {
      if (entry.listeners.size > 0 || entry.waiters.size > 0 || !entry.live) return;
      this.#unsubscribe(entry);
      if (![...this.#topics.values()].some(({ live }) => live)) this.#stop();
    });
  }

  dispose(): void {
    for (const entry of this.#topics.values()) {
      entry.listeners.clear();
      this.#reject(
        entry,
        new ApiError({ code: 'unavailable', sentence: 'The topic mirror is closed.' }),
      );
      if (entry.live) this.#unsubscribe(entry);
    }
    this.#stop();
    this.#topics.clear();
  }

  #listen(): void {
    if (this.#stops) return;
    this.#stops = [];
    this.#stops.push(
      this.#source.topicsOnChange((changes) => {
        for (const change of changes) this.#change(change);
      }),
    );
    this.#stops.push(
      this.#source.topicsOnEpoch((epoch) => {
        if (epoch === this.#epoch) return;
        const restarted = this.#epoch !== undefined;
        this.#epoch = epoch;
        for (const entry of this.#topics.values()) {
          if (!entry.live) continue;
          if (restarted)
            this.#reject(
              entry,
              new ApiError({
                code: 'unavailable',
                sentence: 'corrallm’s core restarted before its changes arrived.',
              }),
            );
          delete entry.rev;
          this.#read(entry, true);
        }
      }),
    );
  }

  #read(entry: Mirrored, force = false): void {
    if (entry.pending && !force) return;
    entry.pending = true;
    entry.buffered = [];
    const generation = ++entry.generation;
    this.#source.topicsSubscribe(topicRequest(entry.topic)).then(
      (snapshot) => {
        if (!entry.live || entry.generation !== generation) return;
        if (this.#epoch !== undefined && snapshot.epoch !== this.#epoch) return;
        this.#epoch = snapshot.epoch;
        entry.state = (
          entry.topic.startsWith('canvas:') ? share(entry.state, snapshot.state) : snapshot.state
        ) as TopicSnapshot['state'];
        entry.rev = snapshot.rev;
        entry.pending = false;
        const buffered = entry.buffered;
        entry.buffered = [];
        this.#tell(entry);
        for (const change of buffered) this.#change(change);
      },
      (error: unknown) => {
        if (!entry.live || entry.generation !== generation) return;
        entry.pending = false;
        this.#reject(entry, error);
        console.error('Could not subscribe to a topic:', ipcErrorMessage(error));
      },
    );
  }

  #change(change: Change): void {
    const entry = this.#topics.get(change.topic);
    if (!entry?.live || change.epoch !== this.#epoch) return;
    if (entry.pending) {
      entry.buffered.push(change);
      return;
    }
    if (entry.rev !== undefined && change.rev <= entry.rev) return;
    if (entry.rev === undefined || change.rev !== entry.rev + 1) {
      this.#read(entry);
      entry.buffered.push(change);
      return;
    }
    if ('replace' in change)
      entry.state = (
        entry.topic.startsWith('canvas:') ? share(entry.state, change.replace) : change.replace
      ) as TopicSnapshot['state'];
    else {
      const previous = entry.state as Record<string, unknown>;
      let state = previous;
      for (const [key, value] of Object.entries(change.set)) {
        const next = share(previous[key], value);
        if (Object.hasOwn(previous, key) && Object.is(previous[key], next)) continue;
        if (state === previous) state = { ...previous };
        state[key] = next;
      }
      for (const key of change.remove ?? []) {
        if (!Object.hasOwn(state, key)) continue;
        if (state === previous) state = { ...previous };
        Reflect.deleteProperty(state, key);
      }
      entry.state = state as TopicSnapshot['state'];
    }
    entry.rev = change.rev;
    this.#tell(entry);
  }

  #unsubscribe(entry: Mirrored): void {
    entry.live = false;
    entry.generation++;
    entry.pending = false;
    entry.buffered = [];
    delete entry.rev;
    void this.#source.topicsUnsubscribe(topicRequest(entry.topic)).catch((error: unknown) => {
      console.error('Could not unsubscribe from a topic:', ipcErrorMessage(error));
    });
  }

  #tell(entry: Mirrored): void {
    for (const listener of entry.listeners) listener();
    for (const waiter of entry.waiters) {
      if (entry.rev === undefined || entry.rev < waiter.rev) continue;
      entry.waiters.delete(waiter);
      waiter.resolve();
    }
    this.#release(entry);
  }

  #reject(entry: Mirrored, error: unknown): void {
    for (const waiter of entry.waiters) waiter.reject(error);
    entry.waiters.clear();
    this.#release(entry);
  }

  #stop(): void {
    for (const stop of this.#stops ?? []) stop();
    this.#stops = undefined;
    this.#epoch = undefined;
  }
}

export const topics = new TopicMirror(bridge);

/** The latest pushed state: undefined until the core answers the first subscription. */
export function useTopic<K extends TopicKey>(
  topic: K,
  mirror: TopicMirror = topics,
): TopicStates[K] | undefined {
  const subscribe = useCallback(
    (listener: () => void) => mirror.subscribe(topic, listener),
    [topic, mirror],
  );
  const snapshot = useCallback(() => mirror.snapshot(topic), [topic, mirror]);
  return useSyncExternalStore(subscribe, snapshot);
}
