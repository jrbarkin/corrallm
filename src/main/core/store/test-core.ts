import { vi } from 'vitest';

import { createCore as compose } from '../core';
import type { Core } from '../core';
import * as Opening from './open';
import type { Store } from './store';

/** Test composition retains the actual store for faults queued through its own lane. */
const databases = new WeakMap<Core, Store>();
const opened = new Map<string, Store>();
let listeners = 0;
let restore: (() => void) | undefined;

/** As production creates a core, observing its store without adding a production test seam. */
export async function createCore(...args: Parameters<typeof compose>): Promise<Core> {
  if (listeners++ === 0) {
    const open = Opening.openStore;
    const spy = vi.spyOn(Opening, 'openStore').mockImplementation(async (...opening) => {
      const result = await open(...opening);
      if (result.store !== undefined) opened.set(opening[0], result.store);
      return result;
    });
    restore = () => {
      spy.mockRestore();
    };
  }
  try {
    const core = await compose(...args);
    const store = opened.get(args[0].profile);
    if (store === undefined) throw new Error('No store for this test core');
    databases.set(core, store);
    return core;
  } finally {
    if (--listeners === 0) {
      restore?.();
      restore = undefined;
      opened.clear();
    }
  }
}

export function databaseOf(core: Core | undefined): Store {
  const store = core === undefined ? undefined : databases.get(core);
  if (store === undefined) throw new Error('No store for this test core');
  return store;
}
