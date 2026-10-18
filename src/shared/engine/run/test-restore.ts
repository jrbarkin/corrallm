import { expect } from 'vitest';

import type { CanvasNode } from '../../model/canvas';
import type { EngineCatalog } from '../catalog';
import { RunStore } from './runner';
import type { RunIO } from './runner';

/*
 * For the run's tests: whatever a run holds, its checkpoint keeps. Each test's runs are made with
 * `liveRun`, and every test file checks after each test (`afterEach(expectRestorable)`) that each
 * run, paused as quitting pauses it, restores from its checkpoint into a new run on the same canvas
 * exactly as it was: the same snapshot, and the same checkpoint again.
 */

/** A run a test made: what it was made with, and the canvas's nodes it was last given. */
interface Live {
  store: RunStore;
  catalog: EngineCatalog;
  now: () => number;
  nodes: readonly CanvasNode[];
}

const live = new Set<Live>();

/** A run, as `new RunStore(catalog, io)`, kept to check that it restores (expectRestorable). */
export function liveRun(catalog: EngineCatalog, io: RunIO): RunStore {
  const store = new RunStore(catalog, io);
  const run: Live = { store, catalog, now: io.now, nodes: [] };
  const update = store.update.bind(store);
  store.update = (nodes) => {
    run.nodes = nodes;
    update(nodes);
  };
  live.add(run);
  return store;
}

/** Each run made since the last check, paused, restores as it was; then they are forgotten. */
export function expectRestorable(): void {
  const runs = [...live];
  live.clear();
  for (const { store, catalog, now, nodes } of runs) {
    store.pause();
    const restored = new RunStore(catalog, {
      send: () => () => undefined,
      tell: () => undefined,
      connect: () => undefined,
      later: () => () => undefined,
      now,
    });
    restored.update(nodes);
    restored.restore(store.checkpoint());
    expect(restored.snapshot(), 'the run, restored from its checkpoint').toEqual(store.snapshot());
    expect(JSON.parse(restored.checkpoint()), 'its checkpoint, once restored').toEqual(
      JSON.parse(store.checkpoint()),
    );
  }
}
