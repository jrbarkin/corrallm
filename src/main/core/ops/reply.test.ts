import { expect, it, vi } from 'vitest';

import { OPS } from '../../../shared/api/registry';
import { SURFACE } from '../../../shared/api/surface';
import type { CanvasDocument } from '../../../shared/model/canvas';
import type { Message } from '../../../shared/model/messages';
import { CATALOG, DEFAULT_ADAPTER } from '../../sessions/adapters';
import { createDispatcher } from '../call';
import type { OpContext } from '../call';
import type { Proposal, Settlement } from '../canvas/proposals';
import { CALLERS, CANVAS, PROPOSAL, testRegistry } from '../test-registry';
import { canvasOps } from './canvas';
import { batchOps } from './batch';
import { replyOps } from './reply';

it.each(['canvas.delete', 'canvas.batch'] as const)(
  'Allow drains and holds the lanes removed by %s until its write finishes',
  async (op) => {
    const registry = testRegistry();
    const order: string[] = [];
    const started = Promise.withResolvers<undefined>();
    const unwind = Promise.withResolvers<undefined>();
    const writing = Promise.withResolvers<undefined>();
    const durable = Promise.withResolvers<undefined>();
    let calls = 0;
    const document: CanvasDocument = {
      id: CANVAS,
      arrange: false,
      nodes: [{ id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'A' } }],
      links: [],
    };
    const proposal: Proposal & { before: Record<string, number> } = {
      id: PROPOSAL,
      canvas: CANVAS,
      op,
      args: {
        canvas: CANVAS,
        ...(op === 'canvas.delete'
          ? { nodes: ['a'] }
          : { ops: [{ op: 'canvas.delete', args: { nodes: ['a'] } }] }),
      },
      by: 'outside:orchestrator',
      touched: { 'node/a': 1 },
      before: { 'node/a': 1 },
      lost: { what: 'delete A', title: 'Delete A' },
      at: 1,
    };
    const record: Message = {
      id: '2c3d4e5f-6071-4829-9bac-1d2e3f4a5b00',
      canvas: CANVAS,
      from: 'corrallm',
      to: proposal.by,
      kind: 'settled',
      body: 'Allowed',
      state: 'delivered',
      at: 1,
    };
    let kept: Message | undefined;
    const settlement: Settlement = {
      get record() {
        return kept;
      },
      within: () => {
        order.push('settled');
        kept = record;
        return {
          reveal: vi.fn(),
          undo() {
            kept = undefined;
          },
        };
      },
    };
    const dispatch = createDispatcher(
      {
        ...registry,
        surface: {
          ...registry.surface,
          'canvas.delete': SURFACE['canvas.delete'],
          'canvas.batch': SURFACE['canvas.batch'],
          reply: SURFACE.reply,
        },
        ops: {
          ...registry.ops,
          'canvas.delete': OPS['canvas.delete'],
          'canvas.batch': OPS['canvas.batch'],
          reply: OPS.reply,
        },
        implementations: {
          ...registry.implementations,
          ...canvasOps({ catalog: CATALOG, defaultAdapter: DEFAULT_ADAPTER }),
          ...batchOps(),
          ...replyOps({
            stalled: { items: () => [], take: () => undefined },
            sessions: { interruptIf: () => Promise.resolve(false) },
            windows: { shownIn: () => undefined },
            needOf: () => undefined,
            // No file is reviewed here.
            reviews: { get: () => undefined, items: () => [], settled: () => undefined },
            documents: {
              applyFile: () => Promise.reject(new Error('No file is reviewed here.')),
              keepFile: () => Promise.reject(new Error('No file is reviewed here.')),
            },
            engines: {
              changed: () => undefined,
              resendAfter: () => Promise.resolve(),
              cancelResend: () => Promise.resolve(),
            },
            // Its proposal touched only entities: no document's or file's fingerprint is read.
            lifecycle: { touched: () => Promise.resolve(undefined) },
            proposals: {
              get: () => proposal,
              items: () => [],
              settled: () => undefined,
              settlement: () => Promise.resolve(settlement),
              settle: () => Promise.resolve(record),
            },
          }),
          'test.hold': async (_args, { signal }: OpContext) => {
            if (++calls > 1) {
              order.push('late started');
              return { stopped: true };
            }
            started.resolve(undefined);
            await new Promise<void>((resolve) => {
              signal.addEventListener(
                'abort',
                () => {
                  order.push('aborted');
                  resolve();
                },
                { once: true },
              );
            });
            await unwind.promise;
            order.push('unwound');
            return { stopped: true };
          },
        },
        rules: {},
      },
      {
        check: true,
        commit: async (_canvas, build, call) => {
          call.noReturn();
          const built = build(document);
          order.push('committing');
          writing.resolve(undefined);
          await durable.promise;
          call.within?.();
          order.push('durable');
          return { result: built.result, rev: 2 };
        },
      },
    );
    const held = dispatch.call('test.hold', { canvas: CANVAS, agent: 'a' }, CALLERS.you);
    await started.promise;
    const reply = dispatch.call(
      'reply',
      { canvas: CANVAS, to: PROPOSAL, answer: { choice: 'allow' } },
      CALLERS.you,
    );
    let late: ReturnType<typeof dispatch.call> | undefined;
    try {
      await vi.waitFor(() => {
        expect(order).toEqual(['aborted']);
      });
      late = dispatch.call('test.hold', { canvas: CANVAS, agent: 'a' }, CALLERS.you);
      unwind.resolve(undefined);
      await writing.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(order).toEqual(['aborted', 'unwound', 'committing']);
    } finally {
      unwind.resolve(undefined);
      durable.resolve(undefined);
    }
    expect(await reply).toMatchObject({
      ok: true,
      value: { outcome: 'allowed', revs: { [`canvas:${CANVAS}`]: 2 } },
    });
    await held;
    await late;
    expect(order).toEqual([
      'aborted',
      'unwound',
      'committing',
      'settled',
      'durable',
      'late started',
    ]);
  },
);
