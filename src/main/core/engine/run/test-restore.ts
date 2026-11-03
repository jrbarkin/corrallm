import { deepStrictEqual } from 'node:assert';

import type { CanvasNode } from '../../../../shared/model/canvas';
import type { EngineCatalog } from '../../../../shared/model/catalog';
import { RunStore } from './runner';
import type { RunIO, RunTasks } from './runner';

/*
 * For the run's tests: whatever a run holds, its checkpoint keeps. Each test's runs are made with
 * `liveRun`, and every test file checks after each test (`afterEach(expectRestorable)`) that each
 * run, paused as quitting pauses it, restores from its checkpoint into a new run on the same canvas
 * exactly as it was: the same snapshot, and the same checkpoint again. A run given what its canvas's
 * mailbox holds of its tasks' asks (RunIO.tasks, B21 C7) is restored over the same rows: they and
 * its checkpoint commit together.
 */

/** A run a test made: what it was made with, and the canvas's nodes it was last given. */
interface Live {
  store: RunStore;
  catalog: EngineCatalog;
  now: () => number;
  nodes: readonly CanvasNode[];
  tasks: RunTasks | undefined;
}

const live = new Set<Live>();

/** A run, as `new RunStore(catalog, io)`, kept to check that it restores (expectRestorable). */
export function liveRun(catalog: EngineCatalog, io: RunIO): RunStore {
  return liveRunOf(new RunStore(catalog, io), catalog, io.now, io.tasks);
}

/**
 * A run made elsewhere (an Engine's: `engine.run`), before it is given its nodes, kept to check
 * that it restores as `liveRun`'s are (expectRestorable), over its canvas's mailbox (`tasks`) where
 * it was given one.
 */
export function liveRunOf(
  store: RunStore,
  catalog: EngineCatalog,
  now: () => number,
  tasks?: RunTasks,
): RunStore {
  const run: Live = { store, catalog, now, nodes: [], tasks };
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
  for (const { store, catalog, now, nodes, tasks } of runs) {
    store.pause();
    const restored = new RunStore(catalog, {
      send: () => () => undefined,
      tell: () => undefined,
      later: () => () => undefined,
      now,
      ...(tasks === undefined ? {} : { tasks }),
    });
    restored.update(nodes);
    restored.restore(store.checkpoint());
    deepStrictEqual(restored.snapshot(), store.snapshot(), 'the run, restored from its checkpoint');
    deepStrictEqual(
      JSON.parse(restored.checkpoint()),
      JSON.parse(store.checkpoint()),
      'its checkpoint, once restored',
    );
  }
}
