import { expect, it } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import { unopened } from '../store/store';
import { MessageStore, MessageTable } from './messages';

// The unjournaled store isolates CPU spent changing/pruning records, with no disk IO in a sample.
it.skipIf(process.env.CORRALLM_BENCH !== '1')(
  'measures changes with 5,000 kept settled messages',
  { timeout: 30_000 },
  async () => {
    const table = new MessageTable(unopened('benchmark: no disk IO'), { ensure: () => undefined });
    const store = new MessageStore('canvas' as CanvasId, table, () => 1000);
    await store.load();
    let settled = '';
    for (let i = 0; i < 5000; i++) {
      const party = String(Math.floor(i / 100));
      settled = store.add({
        from: `outside:p${party}`,
        to: `agent:a${party}`,
        kind: 'notice',
        origin: 'party',
        state: 'delivered',
        body: 'A completed message',
      }).id;
    }
    const pending = store.add({
      from: 'you',
      to: 'agent:builder',
      kind: 'text',
      origin: 'manual',
      state: 'pending',
      body: 'Waiting',
    }).id;
    expect(store.all()).toHaveLength(5001);
    const measure = (name: string, change: (i: number) => void) => {
      for (let i = 0; i < 100; i++) change(i);
      const samples: number[] = [];
      for (let sample = 0; sample < 7; sample++) {
        const began = performance.now();
        for (let i = 0; i < 300; i++) change(i);
        samples.push(((performance.now() - began) * 1000) / 300);
      }
      console.log(
        `${name} (5,000 settled): median ${String(samples.sort((a, b) => a - b)[3])} µs/change`,
      );
    };
    measure('pending update', (i) => {
      store.update(pending, { body: String(i) });
    });
    measure('settled update', (i) => {
      store.update(settled, { body: String(i) });
    });
    measure('settled add/prune', (i) => {
      store.add({
        from: 'outside:p49',
        to: 'agent:a49',
        kind: 'notice',
        origin: 'party',
        state: 'delivered',
        body: String(i),
      });
    });
    expect(store.all()).toHaveLength(5001);
  },
);
