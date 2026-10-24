import { describe, expect, it } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import { OpFailure } from '../call';
import { WorkspaceGate } from './gate';
import type { TreeKey } from './gate';

/*
 * The workspace mutation gate: a change of a tree's files refused while any agent working there may
 * be writing, one at a time per tree, holding new work for its other members until it is done.
 */

const CANVAS = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d' as CanvasId;
const SHARED: TreeKey = 'folder:/work/app';
const OWN: TreeKey = 'workspace:w-c';

function gateOf(writing = new Map<string, string>()) {
  // a and b share the project folder; c works in a tree of its own.
  const trees: Record<string, TreeKey[]> = { a: [SHARED], b: [SHARED], c: [OWN] };
  return new WorkspaceGate({
    agents: () => ['a', 'b', 'c'],
    session: (_canvas, agent) => trees[agent]?.[0],
    trees: (_canvas, agent) => Promise.resolve(trees[agent] ?? []),
    writing: (_canvas, agent) => writing.get(agent),
    nameOf: (_canvas, agent) => agent.toUpperCase(),
  });
}

describe('the workspace mutation gate', () => {
  it('refuses while another member of the tree may be writing, naming it, and runs nothing', async () => {
    const gate = gateOf(new Map([['b', 'has a turn going on']]));
    let ran = false;
    const refused = gate.mutate(CANVAS, 'a', () => {
      ran = true;
      return Promise.resolve();
    });
    await expect(refused).rejects.toBeInstanceOf(OpFailure);
    await expect(refused).rejects.toThrow(/B has a turn going on/);
    expect(ran).toBe(false);
  });

  it('ignores agents of other trees, and tells the work its members', async () => {
    const gate = gateOf(new Map([['c', 'has a turn going on']]));
    await expect(gate.mutate(CANVAS, 'a', (members) => Promise.resolve(members))).resolves.toEqual([
      'a',
      'b',
    ]);
  });

  it('holds new work for the tree’s other members until it is done, never its own', async () => {
    const gate = gateOf();
    const done = Promise.withResolvers<undefined>();
    const mutating = gate.mutate(CANVAS, 'a', () => done.promise);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await gate.holding(CANVAS, 'b')).toMatch(/being restored/);
    expect(await gate.holding(CANVAS, 'a')).toBeUndefined();
    expect(await gate.holding(CANVAS, 'c')).toBeUndefined();
    let passed = false;
    const passing = gate.pass(CANVAS, 'b').then(() => {
      passed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(passed).toBe(false);
    // One at a time per tree: another change of it meanwhile is refused, not queued.
    await expect(gate.mutate(CANVAS, 'b', () => Promise.resolve())).rejects.toThrow(
      /another agent’s restore/,
    );
    done.resolve(undefined);
    await mutating;
    await passing;
    expect(passed).toBe(true);
    expect(await gate.holding(CANVAS, 'b')).toBeUndefined();
  });

  it('refuses an agent with no session running', async () => {
    const gate = new WorkspaceGate({
      agents: () => ['a'],
      session: () => undefined,
      trees: () => Promise.resolve([]),
      writing: () => undefined,
      nameOf: (_canvas, agent) => agent,
    });
    await expect(gate.mutate(CANVAS, 'a', () => Promise.resolve())).rejects.toThrow(
      /isn’t running/,
    );
  });
});
