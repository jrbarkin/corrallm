import { useCallback, useSyncExternalStore } from 'react';

import type { Change, TopicKey, TopicSnapshot, TopicStates } from '../../shared/api/topics';
import type { GuiApi } from '../../shared/gui-link';
import { ipcErrorMessage } from '../ipc-error';
import { api } from './client';

export type TopicSource = Pick<
  GuiApi,
  'topicsSubscribe' | 'topicsUnsubscribe' | 'topicsOnChange' | 'topicsOnEpoch'
>;

interface Mirrored {
  topic: TopicKey;
  state?: TopicSnapshot['state'];
  rev?: number;
  listeners: Set<() => void>;
  live: boolean;
  pending: boolean;
  generation: number;
  buffered: Change[];
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

  subscribe(topic: TopicKey, listener: () => void): () => void {
    let entry = this.#topics.get(topic);
    if (!entry) {
      entry = {
        topic,
        listeners: new Set(),
        live: false,
        pending: false,
        generation: 0,
        buffered: [],
      };
      this.#topics.set(topic, entry);
    }
    entry.listeners.add(listener);
    entry.live = true;
    this.#listen();
    if (this.#epoch !== undefined && entry.rev === undefined) this.#read(entry);
    const mirrored = entry;
    return () => {
      mirrored.listeners.delete(listener);
      // StrictMode's immediate cleanup and re-subscription keep the one subscription.
      queueMicrotask(() => {
        if (mirrored.listeners.size > 0 || !mirrored.live) return;
        this.#unsubscribe(mirrored);
        if (![...this.#topics.values()].some(({ live }) => live)) this.#stop();
      });
    };
  }

  dispose(): void {
    for (const entry of this.#topics.values()) {
      entry.listeners.clear();
      if (entry.live) this.#unsubscribe(entry);
    }
    this.#stop();
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
        this.#epoch = epoch;
        for (const entry of this.#topics.values()) {
          if (!entry.live) continue;
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
    this.#source.topicsSubscribe({ topic: entry.topic }).then(
      (snapshot) => {
        if (!entry.live || entry.generation !== generation) return;
        if (this.#epoch !== undefined && snapshot.epoch !== this.#epoch) return;
        this.#epoch = snapshot.epoch;
        entry.state = snapshot.state as TopicSnapshot['state'];
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
    entry.state = change.replace;
    entry.rev = change.rev;
    this.#tell(entry);
  }

  #unsubscribe(entry: Mirrored): void {
    entry.live = false;
    entry.generation++;
    entry.pending = false;
    entry.buffered = [];
    delete entry.rev;
    void this.#source.topicsUnsubscribe({ topic: entry.topic }).catch((error: unknown) => {
      console.error('Could not unsubscribe from a topic:', ipcErrorMessage(error));
    });
  }

  #tell(entry: Mirrored): void {
    for (const listener of entry.listeners) listener();
  }

  #stop(): void {
    for (const stop of this.#stops ?? []) stop();
    this.#stops = undefined;
    this.#epoch = undefined;
  }
}

export const topics = new TopicMirror(api);

/** The latest pushed state: undefined until the core answers the first subscription. */
export function useTopic<K extends TopicKey>(topic: K): TopicStates[K] | undefined {
  const subscribe = useCallback(
    (listener: () => void) => topics.subscribe(topic, listener),
    [topic],
  );
  const snapshot = useCallback(() => topics.snapshot(topic), [topic]);
  return useSyncExternalStore(subscribe, snapshot);
}
