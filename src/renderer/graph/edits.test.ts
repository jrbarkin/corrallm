import { afterEach, expect, it, vi } from 'vitest';

import { newCanvasId } from '../../shared/canvas';
import type { CanvasDocument } from '../../shared/model/canvas';
import { expectOneOp, fakeCore } from '../test-api';
import { editsOf, operationEdits } from './edits';

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((stop) => {
    stop();
  });
});
function setup() {
  const core = fakeCore();
  cleanups.push(() => {
    core.dispose();
  });
  core.respond('queue.add', { id: 'from-core', revs: {} });
  const doc: CanvasDocument = {
    id: newCanvasId(),
    arrange: false,
    links: [],
    nodes: [
      {
        id: 'a',
        type: 'agent',
        position: { x: 0, y: 0 },
        data: {
          label: 'a',
          queue: [
            { id: 'one', action: 'Read' },
            { id: 'two', action: 'Bash' },
            {
              id: 'if',
              if: { kind: 'succeeded' },
              then: [
                { id: 'i1', action: 'Read' },
                { id: 'i2', action: 'Bash' },
              ],
            },
            {
              id: 'repeat',
              repeat: [
                { id: 'r1', action: 'Read' },
                { id: 'r2', action: 'Bash' },
              ],
              until: { kind: 'failed' },
              rounds: 2,
              otherwise: 'ask',
            },
          ],
        },
      },
    ],
  };
  const goOn = vi.fn();
  const decide = vi.fn();
  const failed = vi.fn();
  const edits = operationEdits(core.api, doc.id, { goOn, decide }, failed);
  return { core, doc, edits, own: editsOf(edits, 'a'), goOn, decide, failed };
}

it('adds once and returns the core id, including an initial container', async () => {
  const { core, doc, own } = setup();
  const entry = {
    repeat: [{ action: 'Read' }],
    until: { kind: 'failed' as const },
    rounds: 2,
    otherwise: 'ask' as const,
  };
  expect(await own.onAdd(entry)).toBe('from-core');
  expectOneOp(core, 'queue.add', { canvas: doc.id, agent: 'a', entry });
});
it('adds into a container with one operation', async () => {
  const { core, doc, own } = setup();
  await own.onAdd({ message: 'Check' }, 'repeat');
  expectOneOp(core, 'queue.add', {
    canvas: doc.id,
    agent: 'a',
    entry: { message: 'Check' },
    into: 'repeat',
  });
});
it('removes once', async () => {
  const { core, doc, own } = setup();
  await own.onRemove('one');
  expectOneOp(core, 'queue.remove', { canvas: doc.id, agent: 'a', item: 'one' });
});
it.each([
  ['one', 'if'],
  ['two', 'one'],
  ['one', null],
  ['i1', null],
  ['r2', 'r1'],
] as const)('moves %s before its sibling %s in one operation', async (item, before) => {
  const { core, doc, own } = setup();
  await own.onMove(item, before);
  expectOneOp(core, 'queue.move', { canvas: doc.id, agent: 'a', item, before });
});
const updates = [
  {
    call: (e: ReturnType<typeof editsOf>) => e.onRetarget('one', 'b'),
    change: { kind: 'target', target: 'b' },
  },
  {
    call: (e: ReturnType<typeof editsOf>) => e.onRetarget('one', undefined),
    change: { kind: 'target', target: null },
  },
  {
    call: (e: ReturnType<typeof editsOf>) => e.onEditMessage('one', 'Text'),
    change: { kind: 'message', message: 'Text' },
  },
  {
    call: (e: ReturnType<typeof editsOf>) => e.onInstruction('one', ''),
    change: { kind: 'instruction', instruction: null },
  },
  {
    call: (e: ReturnType<typeof editsOf>) => e.onInstruction('one', 'Test'),
    change: { kind: 'instruction', instruction: 'Test' },
  },
  {
    call: (e: ReturnType<typeof editsOf>) => e.onExpect('one', 'fails'),
    change: { kind: 'expect', expect: 'fails' },
  },
  {
    call: (e: ReturnType<typeof editsOf>) => e.onExpect('one', undefined),
    change: { kind: 'expect', expect: null },
  },
  {
    call: (e: ReturnType<typeof editsOf>) => e.onCondition('one', { kind: 'failed' }),
    change: { kind: 'condition', condition: { kind: 'failed' } },
  },
  {
    call: (e: ReturnType<typeof editsOf>) => e.onWaitFor('one', [{ agent: 'b', item: 'work' }]),
    change: { kind: 'waitFor', waitFor: [{ agent: 'b', item: 'work' }] },
  },
  {
    call: (e: ReturnType<typeof editsOf>) => e.onTime('one', { seconds: 60 }),
    change: { kind: 'time', time: { seconds: 60 } },
  },
  {
    call: (e: ReturnType<typeof editsOf>) => e.onTime('one', undefined),
    change: { kind: 'time', time: null },
  },
  {
    call: (e: ReturnType<typeof editsOf>) => e.onApproval('one', 'Review'),
    change: { kind: 'approve', approve: 'Review' },
  },
  {
    call: (e: ReturnType<typeof editsOf>) => e.onRepeat('one', { rounds: 5, otherwise: 'goOn' }),
    change: { kind: 'repeat', rounds: 5, otherwise: 'goOn' },
  },
];
it.each(updates)('sends one update for $change', async ({ call, change }) => {
  const { core, doc, own } = setup();
  await call(own);
  expectOneOp(core, 'queue.update', { canvas: doc.id, agent: 'a', item: 'one', change });
});
it('reports refusals and sends no follow-up operation', async () => {
  const { core, own, failed } = setup();
  core.reply('queue.add', { ok: false, error: { code: 'refused', sentence: 'Held by the run.' } });
  expect(await own.onAdd({ action: 'Read' })).toBeUndefined();
  expect(failed).toHaveBeenCalledOnce();
  expect(core.operations).toHaveLength(1);
});
it('keeps goOn and decide on the renderer run', () => {
  const { core, own, goOn, decide } = setup();
  own.onGoOn('one');
  own.onDecide('one', { choice: 'continue' });
  expect(goOn).toHaveBeenCalledExactlyOnceWith('a', 'one');
  expect(decide).toHaveBeenCalledExactlyOnceWith('a', 'one', { choice: 'continue' });
  expect(core.operations).toEqual([]);
});
