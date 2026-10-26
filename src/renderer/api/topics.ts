import { useCallback, useSyncExternalStore } from 'react';

import type {
  Change,
  RuntimeChange,
  RuntimeSnapshotFrame,
  RuntimeTopicStates,
} from '../../shared/api/topics';
import { snapshotFrameFits } from '../../shared/api/topics';
import { MAX_TOPIC_FRAME } from '../../shared/api/limits';
import { projectData } from '../../shared/model/views';
import {
  assembledState,
  checkRuntimeState,
  mirrorRequest,
  runtimePatch,
  runtimeTopic,
} from './topic-wire';
import type {
  MirrorSnapshot,
  MirrorSource,
  MirrorStates,
  MirrorTopicKey,
  MirrorUpdate,
} from './topic-wire';
import type { GuiApi } from '../../shared/gui-link';
import { ipcErrorMessage } from '../ipc-error';
import { ApiError, bridge } from './bridge';

export type TopicSource = Pick<
  GuiApi,
  'topicsSubscribe' | 'topicsUnsubscribe' | 'topicsOnChange' | 'topicsOnEpoch'
>;

interface Mirrored {
  topic: MirrorTopicKey;
  state?: MirrorSnapshot['state'];
  rev?: number;
  error?: string;
  listeners: Set<() => void>;
  waiters: Set<{ rev: number; resolve: () => void; reject: (error: unknown) => void }>;
  live: boolean;
  pending: boolean;
  generation: number;
  buffered: MirrorUpdate[];
  assembly?: {
    id: string;
    summary: unknown;
    count: number;
    nextIndex: number;
    entries: Map<string, unknown>;
    early: (Change | RuntimeChange)[];
  };
  timer?: ReturnType<typeof setTimeout>;
  recovering?: boolean;
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
  readonly #source: MirrorSource;
  readonly #topics = new Map<MirrorTopicKey, Mirrored>();
  #epoch: string | undefined;
  #stops: (() => void)[] | undefined;

  constructor(source: TopicSource | MirrorSource) {
    this.#source = source;
  }

  snapshot<K extends MirrorTopicKey>(topic: K): MirrorStates[K] | undefined {
    return this.#topics.get(topic)?.state as MirrorStates[K] | undefined;
  }

  /** The revision of the topic's snapshot: none before its first. */
  revision(topic: MirrorTopicKey): number | undefined {
    return this.#topics.get(topic)?.rev;
  }

  failure(topic: MirrorTopicKey): string | undefined {
    return this.#topics.get(topic)?.error;
  }

  subscribe(topic: MirrorTopicKey, listener: () => void): () => void {
    const entry = this.#entry(topic);
    entry.listeners.add(listener);
    this.#activate(entry);
    return () => {
      entry.listeners.delete(listener);
      this.#release(entry);
    };
  }

  /** An operation can await its changes even if no view currently observes that topic. */
  whenAt(topic: MirrorTopicKey, rev: number): Promise<void> {
    const entry = this.#entry(topic);
    if (entry.live && entry.rev !== undefined && entry.rev >= rev) return Promise.resolve();
    const waiting = new Promise<void>((resolve, reject) =>
      entry.waiters.add({ rev, resolve, reject }),
    );
    this.#activate(entry);
    return waiting;
  }

  #entry(topic: MirrorTopicKey): Mirrored {
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
          delete entry.error;
          if (restarted) this.#tell(entry);
          this.#read(entry, true);
        }
      }),
    );
  }

  #read(entry: Mirrored, force = false): void {
    if ((entry.pending || entry.assembly || entry.recovering) && !force) return;
    this.#clearTransfer(entry);
    entry.pending = true;
    entry.buffered = [];
    const generation = ++entry.generation;
    this.#source.topicsSubscribe(mirrorRequest(entry.topic)).then(
      (snapshot) => {
        if (!entry.live || entry.generation !== generation) return;
        if (this.#epoch !== undefined && snapshot.epoch !== this.#epoch) return;
        this.#epoch = snapshot.epoch;
        entry.pending = false;
        const buffered = entry.buffered;
        entry.buffered = [];
        try {
          if ('kind' in snapshot) {
            if (
              snapshot.kind !== 'begin' ||
              snapshot.topic !== entry.topic ||
              !snapshotFrameFits(snapshot)
            )
              throw new Error('A chunked snapshot must begin with a bounded summary.');
            entry.assembly = {
              id: snapshot.snapshot,
              summary: snapshot.summary,
              count: snapshot.count,
              nextIndex: 0,
              entries: new Map(),
              early: [],
            };
            this.#deadline(entry);
          } else this.#install(entry, snapshot.state, snapshot.rev, true);
          for (const change of buffered) {
            // A gap-triggering delta or an early event may predate the subscribe answer.
            // End's revision decides whether it is already represented by the snapshot.
            if (entry.assembly && !('kind' in change)) entry.assembly.early.push(change);
            else this.#change(change);
          }
        } catch (error) {
          this.#invalid(entry, error);
        }
      },
      (error: unknown) => {
        if (!entry.live || entry.generation !== generation) return;
        entry.pending = false;
        // A closing core refuses a subscribe as unavailable. That is shutdown or a reopen, not a
        // fault: nothing is shown, and the entry stays live, for the next epoch to subscribe afresh.
        const closing = error instanceof ApiError && error.code === 'unavailable';
        if (!closing) entry.error = ipcErrorMessage(error);
        this.#reject(entry, error);
        if (closing) return;
        this.#tell(entry);
        console.error('Could not subscribe to a topic:', ipcErrorMessage(error));
      },
    );
  }

  #install(entry: Mirrored, state: MirrorSnapshot['state'], rev: number, whole = false): void {
    if (!Number.isSafeInteger(rev) || rev < 0 || (entry.rev !== undefined && rev < entry.rev))
      throw new Error('A topic revision must be a nonnegative integer.');
    if (
      whole &&
      new TextEncoder().encode(JSON.stringify({ epoch: this.#epoch, rev, state })).length >
        MAX_TOPIC_FRAME
    )
      throw new Error('An oversized snapshot must be chunked.');
    if (runtimeTopic(entry.topic)) {
      checkRuntimeState(entry.topic, state as RuntimeTopicStates[typeof entry.topic]);
      entry.state = projectData(
        state as RuntimeTopicStates[typeof entry.topic],
        entry.state as RuntimeTopicStates[typeof entry.topic] | undefined,
      );
    } else
      entry.state = (
        entry.topic.startsWith('canvas:') ? share(entry.state, state) : state
      ) as MirrorSnapshot['state'];
    entry.rev = rev;
    delete entry.error;
    this.#tell(entry);
  }

  #change(change: MirrorUpdate): void {
    const entry = this.#topics.get(change.topic);
    if (!entry?.live || change.epoch !== this.#epoch || entry.recovering) return;
    if (entry.pending) {
      entry.buffered.push(change);
      return;
    }
    try {
      if ('kind' in change) {
        if (change.kind === 'begin' && !entry.assembly) {
          if (!snapshotFrameFits(change))
            throw new Error('A replacement summary exceeded its bound.');
          entry.assembly = {
            id: change.snapshot,
            summary: change.summary,
            count: change.count,
            nextIndex: 0,
            entries: new Map(),
            early: [],
          };
          this.#deadline(entry);
          return;
        }
        this.#frame(entry, change);
        return;
      }
      if (entry.assembly) throw new Error('A topic delta arrived before the snapshot ended.');
      if (entry.rev !== undefined && change.rev <= entry.rev) return;
      if (entry.rev === undefined || change.rev !== entry.rev + 1) {
        this.#read(entry);
        entry.buffered.push(change);
        return;
      }
      if (runtimeTopic(change.topic)) {
        entry.state = runtimePatch(
          entry.state as RuntimeTopicStates[typeof change.topic],
          change as RuntimeChange,
        );
      } else {
        const legacy = change as Change;
        if ('replace' in legacy)
          entry.state = (
            entry.topic.startsWith('canvas:') ? share(entry.state, legacy.replace) : legacy.replace
          ) as MirrorSnapshot['state'];
        else {
          const previous = entry.state as Record<string, unknown>;
          let state = previous;
          for (const [key, value] of Object.entries(legacy.set)) {
            const next = share(previous[key], value);
            if (Object.hasOwn(previous, key) && Object.is(previous[key], next)) continue;
            if (state === previous) state = { ...previous };
            Object.defineProperty(state, key, {
              value: next,
              enumerable: true,
              configurable: true,
              writable: true,
            });
          }
          for (const key of legacy.remove ?? []) {
            if (!Object.hasOwn(state, key)) continue;
            if (state === previous) state = { ...previous };
            Reflect.deleteProperty(state, key);
          }
          entry.state = state as MirrorSnapshot['state'];
        }
      }
      entry.rev = change.rev;
      this.#tell(entry);
    } catch (error) {
      this.#invalid(entry, error);
    }
  }

  #frame(entry: Mirrored, frame: RuntimeSnapshotFrame): void {
    const assembly = entry.assembly;
    if (
      !assembly ||
      frame.kind === 'begin' ||
      frame.snapshot !== assembly.id ||
      !snapshotFrameFits(frame)
    )
      throw new Error('A snapshot frame arrived out of sequence or exceeded its bound.');
    if (frame.kind === 'chunk') {
      if (frame.index !== assembly.nextIndex || frame.index >= assembly.count)
        throw new Error('A snapshot chunk index was repeated, skipped or out of order.');
      for (const { key, value } of frame.entries) {
        if (assembly.entries.has(key)) throw new Error('A snapshot repeated an entry key.');
        assembly.entries.set(key, value);
      }
      assembly.nextIndex++;
      this.#deadline(entry);
      return;
    }
    if (assembly.nextIndex !== assembly.count)
      throw new Error('A snapshot ended before all its chunks arrived.');
    const state = assembledState(entry.topic, assembly.summary, [...assembly.entries]);
    this.#clearTransfer(entry);
    this.#install(entry, state, frame.rev);
    for (const change of assembly.early) this.#change(change);
  }

  #deadline(entry: Mirrored): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      this.#invalid(entry, new Error('The snapshot did not end within ten seconds of progress.'));
    }, 10_000);
  }

  #clearTransfer(entry: Mirrored): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    delete entry.timer;
    delete entry.assembly;
    delete entry.recovering;
  }

  #invalid(entry: Mirrored, error: unknown): void {
    this.#clearTransfer(entry);
    entry.pending = false;
    entry.buffered = [];
    entry.generation++;
    entry.recovering = true;
    this.#reject(
      entry,
      new ApiError({
        code: 'unavailable',
        sentence: 'The topic snapshot was incomplete or inconsistent; fetching it again.',
      }),
    );
    console.error('Could not mirror a topic:', ipcErrorMessage(error));
    // A bad publisher must not cause an unbounded microtask resubscription loop.
    entry.timer = setTimeout(() => {
      this.#clearTransfer(entry);
      if (entry.live) this.#read(entry);
    }, 100);
  }

  #unsubscribe(entry: Mirrored): void {
    entry.live = false;
    this.#clearTransfer(entry);
    entry.generation++;
    entry.pending = false;
    entry.buffered = [];
    delete entry.rev;
    void this.#source.topicsUnsubscribe(mirrorRequest(entry.topic)).catch((error: unknown) => {
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
export function useTopic<K extends MirrorTopicKey>(
  topic: K,
  mirror: TopicMirror = topics,
): MirrorStates[K] | undefined {
  const subscribe = useCallback(
    (listener: () => void) => mirror.subscribe(topic, listener),
    [topic, mirror],
  );
  const snapshot = useCallback(() => mirror.snapshot(topic), [topic, mirror]);
  return useSyncExternalStore(subscribe, snapshot);
}
