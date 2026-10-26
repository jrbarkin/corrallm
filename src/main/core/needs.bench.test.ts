import { expect, it } from 'vitest';

import type { CanvasId } from '../../shared/canvas';
import type { AgentNode } from '../../shared/model/canvas';
import { SessionStore } from './engine/delivery/mailbox';
import { needsOf } from '../../shared/model/needs-selectors';
import { fakeBackend } from './engine/test-backend';
import { TEST_ENGINE } from './engine/test-engine';

// Opt-in measurement, never a timing assertion: CORRALLM_BENCH=1 pnpm exec vitest run ...
it.skipIf(process.env.CORRALLM_BENCH !== '1')(
  'measures needsOf over 12 sessions of 2,000 entries',
  async () => {
    const { backend, emit } = fakeBackend();
    const store = new SessionStore(TEST_ENGINE, backend);
    const nodes: AgentNode[] = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      type: 'agent',
      position: { x: 0, y: 0 },
      data: { label: String(i) },
    }));
    store.sync(nodes.map(({ id }) => ({ id, connection: 'claude-code.sdk' })));
    await Promise.all(nodes.map(({ id }) => store.ready(id)));
    for (const { id } of nodes) {
      emit(id, 'claude-code.sdk', {
        type: 'history',
        events: Array.from({ length: 1998 }, (_, i) => ({
          type: 'text',
          id: `${id}/${String(i)}`,
          text: 'Past output',
        })),
      });
      for (let i = 0; i < 2; i++)
        emit(id, 'claude-code.sdk', {
          type: 'permission',
          id: `${id}/prompt/${String(i)}`,
          tool: 'Read',
          summary: 'notes',
          always: null,
        });
    }
    const input = {
      canvas: 'canvas' as CanvasId,
      nodes,
      sessions: store.snapshot(),
      catalog: TEST_ENGINE,
      run: { running: false, agents: {} },
    };
    try {
      expect(needsOf(input)).toHaveLength(24);
      const samples: number[] = [];
      for (let i = 0; i < 200; i++) needsOf(input);
      let count = 0;
      for (let sample = 0; sample < 7; sample++) {
        const began = performance.now();
        for (let i = 0; i < 2000; i++) count += needsOf(input).length;
        samples.push(((performance.now() - began) * 1000) / 2000);
      }
      expect(count).toBe(7 * 2000 * 24);
      console.log(
        `needsOf (12 × 2,000 entries, 24 open): median ${String(samples.sort((a, b) => a - b)[3])} µs/pass`,
      );
    } finally {
      store.reset();
    }
  },
);
