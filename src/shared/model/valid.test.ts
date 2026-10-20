import { describe, expect, it } from 'vitest';

import type { CanvasId } from '../canvas';
import { TEST_CATALOG } from '../engine/test-engine';
import type { AgentData, CanvasDocument, CanvasNode } from './canvas';
import type { QueueItem } from './queue';
import { diffRows, toRows } from './rows';
import type { EntityKey, Row } from './rows';
import { editFault } from './valid';

/*
 * What a change to a canvas's document must hold to, whoever makes it (revision R34, B9 Design §4):
 * what it touched as a file would hold it, each step it wrote naming an action its agent's adapter
 * declares, and what each item it wrote names there.
 */

const CANVAS = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' as CanvasId;

const agent = (id: string, data: Partial<AgentData> = {}): CanvasNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, adapter: 'codex', ...data },
});
const BEFORE: CanvasDocument = {
  id: CANVAS,
  arrange: false,
  nodes: [
    agent('a', {
      queue: [
        { id: 'step', action: 'exec_command' },
        // An action no adapter declares, as an older file may hold one.
        { id: 'old', action: 'Bash' },
        {
          id: 'loop',
          repeat: [{ id: 'inner', message: 'Again' }],
          until: { kind: 'succeeded' },
          rounds: 2,
          otherwise: 'ask',
        },
      ],
    }),
    agent('b'),
    agent('ghostly', { adapter: 'gemini', queue: [{ id: 'any', action: 'Anything' }] }),
    { id: 'frame', type: 'frame', position: { x: 0, y: 0 }, data: { label: 'Frame' } },
  ],
  links: [],
};

/** Agent `id`'s queue in `document`, changed by `change`. */
function withQueue(
  id: string,
  change: (queue: QueueItem[]) => QueueItem[],
  document: CanvasDocument = BEFORE,
): CanvasDocument {
  return {
    ...document,
    nodes: document.nodes.map((node) =>
      node.id === id && node.type === 'agent'
        ? { ...node, data: { ...node.data, queue: change(node.data.queue ?? []) } }
        : node,
    ),
  };
}
const adding = (id: string, item: QueueItem) => withQueue(id, (queue) => [...queue, item]);

/** Why `next`, changed from BEFORE, can't be kept. */
function faultOf(next: CanvasDocument): string | undefined {
  const before = toRows(BEFORE);
  const { rows, changed } = diffRows(before, next, BEFORE);
  const entities = new Map<EntityKey, { before: Row | null; after: Row | null }>(
    changed.map((key) => [key, { before: before[key] ?? null, after: rows[key] ?? null }]),
  );
  return editFault(next, entities, TEST_CATALOG, 'claude-code');
}

describe('editFault', () => {
  it('passes a change a file would hold, naming declared actions and what is there', () => {
    expect(faultOf(adding('a', { id: 'new', action: 'apply_patch', target: 'b' }))).toBeUndefined();
    expect(
      faultOf(
        adding('a', {
          id: 'w',
          waitFor: [{ agent: 'b' }, { agent: 'a', item: 'inner' }],
        }),
      ),
    ).toBeUndefined();
    expect(
      faultOf(
        adding('b', {
          id: 'with',
          repeat: [{ id: 'once', message: 'Go' }],
          until: { kind: 'repeatEnds', agent: 'a', item: 'loop' },
          rounds: 2,
          otherwise: 'ask',
        }),
      ),
    ).toBeUndefined();
  });

  it('refuses what a file couldn’t hold on what it touched', () => {
    const neverAsks = {
      ...BEFORE,
      nodes: BEFORE.nodes.map((node) =>
        node.id === 'b' && node.type === 'agent'
          ? { ...node, data: { ...node.data, settings: { codex: { mode: 'full-access' } } } }
          : node,
      ),
    };
    expect(faultOf(neverAsks)).toMatch(/mode must be one of/);
  });

  it('refuses a step naming an action its agent’s adapter doesn’t declare', () => {
    expect(faultOf(adding('a', { id: 'new', action: 'Bash' }))).toMatch(/"Bash"/);
    expect(
      faultOf(
        withQueue('a', (queue) =>
          queue.map((item) =>
            item.id === 'loop' && 'repeat' in item
              ? { ...item, repeat: [...item.repeat, { id: 'deep', action: 'Read' }] }
              : item,
          ),
        ),
      ),
    ).toMatch(/"Read"/);
    // An adapter this build lacks declares nothing it can read: any action is kept.
    expect(faultOf(adding('ghostly', { id: 'new', action: 'Whatever' }))).toBeUndefined();
  });

  it('refuses a target, a wait or a repeat to go round with that isn’t there', () => {
    const faults = [
      { id: 'n', message: 'Hand over', target: 'ghost' },
      { id: 'n', action: 'exec_command', target: 'frame' },
      { id: 'n', waitFor: [{ agent: 'ghost' }] },
      { id: 'n', waitFor: [{ agent: 'b', item: 'ghost' }] },
      {
        id: 'n',
        repeat: [],
        until: { kind: 'repeatEnds', agent: 'ghost', item: 'loop' },
        rounds: 2,
        otherwise: 'ask',
      },
      {
        id: 'n',
        repeat: [],
        until: { kind: 'repeatEnds', agent: 'a', item: 'step' },
        rounds: 2,
        otherwise: 'ask',
      },
    ] satisfies QueueItem[];
    for (const item of faults)
      expect(faultOf(adding('a', item)), JSON.stringify(item)).toBeDefined();
  });

  it('reads only what the change wrote: an item moved or left as it was is kept as it is', () => {
    // The old step, moved, is what it was.
    expect(faultOf(withQueue('a', (queue) => [...queue].reverse()))).toBeUndefined();
    // Beside it, a new item is read alone.
    expect(faultOf(adding('a', { id: 'new', message: 'Fine' }))).toBeUndefined();
    // Its text rewritten, it is read.
    expect(
      faultOf(
        withQueue('a', (queue) =>
          queue.map((item) => (item.id === 'old' ? { ...item, instruction: 'Run it' } : item)),
        ),
      ),
    ).toMatch(/"Bash"/);
  });
});
