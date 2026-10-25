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
    canvases: () => [CANVAS],
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

  it('holds new work for the tree’s members until it is done: a send to its own agent too, never its own launch', async () => {
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
    // Its own agent's launch goes past it (its composite reopens it); a send to it waits.
    await gate.pass(CANVAS, 'a');
    let sent = false;
    const sending = gate.pass(CANVAS, 'a', true).then(() => {
      sent = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(passed).toBe(false);
    expect(sent).toBe(false);
    // One at a time per tree: another change of it meanwhile is refused, not queued.
    await expect(gate.mutate(CANVAS, 'b', () => Promise.resolve())).rejects.toThrow(
      /another agent’s restore/,
    );
    done.resolve(undefined);
    await mutating;
    await passing;
    await sending;
    expect(passed).toBe(true);
    expect(sent).toBe(true);
    expect(await gate.holding(CANVAS, 'b')).toBeUndefined();
  });

  it('protects the agents of another canvas working in the same folder, never naming them', async () => {
    const OTHER = '9e8d7c6b-5a4f-4e3d-9c2b-1a0f9e8d7c6b' as CanvasId;
    const writing = new Map([[`${OTHER}/x`, 'has a turn going on']]);
    const trees: Record<string, TreeKey[]> = {
      [`${CANVAS}/a`]: [SHARED],
      [`${OTHER}/x`]: [SHARED],
    };
    const gate = new WorkspaceGate({
      canvases: () => [CANVAS, OTHER],
      agents: (canvas) => (canvas === CANVAS ? ['a'] : ['x']),
      session: (canvas, agent) => trees[`${canvas}/${agent}`]?.[0],
      trees: (canvas, agent) => Promise.resolve(trees[`${canvas}/${agent}`] ?? []),
      writing: (canvas, agent) => writing.get(`${canvas}/${agent}`),
      nameOf: (_canvas, agent) => agent.toUpperCase(),
    });
    await expect(gate.mutate(CANVAS, 'a', () => Promise.resolve())).rejects.toThrow(
      /and an agent on another canvas has a turn going on/,
    );
    writing.clear();
    const done = Promise.withResolvers<undefined>();
    const mutating = gate.mutate(CANVAS, 'a', () => done.promise);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await gate.holding(OTHER, 'x')).toMatch(/being restored/);
    // Another canvas's change of the same folder meanwhile is refused too.
    await expect(gate.mutate(OTHER, 'x', () => Promise.resolve())).rejects.toThrow(
      /another agent’s restore/,
    );
    done.resolve(undefined);
    await mutating;
    expect(await gate.holding(OTHER, 'x')).toBeUndefined();
  });

  it('drains whole trees: refused while any agent of them writes, on any canvas, none exempt', async () => {
    const OTHER = '9e8d7c6b-5a4f-4e3d-9c2b-1a0f9e8d7c6b' as CanvasId;
    const writing = new Map([[`${OTHER}/x`, 'has a turn going on']]);
    const trees: Record<string, TreeKey[]> = {
      [`${CANVAS}/a`]: [OWN],
      [`${CANVAS}/b`]: [SHARED],
      [`${OTHER}/x`]: [OWN],
    };
    const gate = new WorkspaceGate({
      canvases: () => [CANVAS, OTHER],
      agents: (canvas) => (canvas === CANVAS ? ['a', 'b'] : ['x']),
      session: (canvas, agent) => trees[`${canvas}/${agent}`]?.[0],
      trees: (canvas, agent) => Promise.resolve(trees[`${canvas}/${agent}`] ?? []),
      writing: (canvas, agent) => writing.get(`${canvas}/${agent}`),
      nameOf: (_canvas, agent) => agent.toUpperCase(),
    });
    await expect(gate.drain(CANVAS, [OWN], () => Promise.resolve())).rejects.toThrow(
      /and an agent on another canvas has a turn going on/,
    );
    writing.clear();
    const done = Promise.withResolvers<undefined>();
    let heard: readonly string[] = [];
    const draining = gate.drain(CANVAS, [OWN], (members) => {
      heard = members;
      return done.promise;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Every member's new work waits, its own canvas's and another's; the other tree's doesn't.
    expect(heard).toEqual(['a']);
    expect(await gate.holding(CANVAS, 'a')).toMatch(/being restored/);
    expect(await gate.holding(OTHER, 'x')).toMatch(/being restored/);
    expect(await gate.holding(CANVAS, 'b')).toBeUndefined();
    await expect(gate.mutate(OTHER, 'x', () => Promise.resolve())).rejects.toThrow(
      /another agent’s restore/,
    );
    done.resolve(undefined);
    await draining;
    expect(await gate.holding(CANVAS, 'a')).toBeUndefined();
  });

  it('refuses an agent with no session running', async () => {
    const gate = new WorkspaceGate({
      canvases: () => [CANVAS],
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
