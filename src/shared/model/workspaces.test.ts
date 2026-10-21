import { describe, expect, it } from 'vitest';

import { newCanvasId } from '../canvas';
import type { AgentNode, CanvasDocument, CanvasNode } from './canvas';
import { remove } from './structure';
import {
  bindingPlan,
  deletionFingerprint,
  rebindFingerprint,
  workspaceOwner,
  workspaceOwners,
} from './workspaces';
import type { Binding, RepositoryRevision, Workspace, WorkspaceObservation } from './workspaces';

const canvas = newCanvasId();
const repo: RepositoryRevision = {
  id: 'repo',
  generation: 1,
  ref: 'refs/heads/base',
  revision: 'base',
};
const agent = (id: string, parentId?: string): AgentNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id },
  ...(parentId === undefined ? {} : { parentId }),
});
const frame = (id: string, parentId?: string): CanvasNode => ({
  ...agent(id, parentId),
  type: 'frame',
  data: { label: id },
});
const doc = (...nodes: CanvasNode[]): CanvasDocument => ({
  id: canvas,
  arrange: false,
  nodes,
  links: [],
});
const workspace = (
  id: string,
  owner: Workspace['owner'],
  extra: Partial<Workspace> = {},
): Workspace => ({
  id,
  canvas,
  repository: repo.id,
  owner,
  revision: 'base',
  active: true,
  ...extra,
});
const binding = (agent: string, workspace: string, generation = 1): Binding => ({
  agent,
  workspace,
  generation,
});
const observed = (
  workspace: string,
  extra: Partial<WorkspaceObservation> = {},
): WorkspaceObservation => ({
  workspace,
  generation: 1,
  identity: 'verified-identity',
  branch: `refs/heads/${workspace}`,
  head: 'base',
  status: 'clean',
  merged: true,
  sessions: [],
  setup: null,
  ...extra,
});

describe('workspace owners', () => {
  it('gives independent agents distinct owners, with encoded keys rather than path fragments', () => {
    const model = doc(agent('a/b'), agent('a%2Fb'), agent('..'));
    expect(workspaceOwners(model)).toEqual([
      { key: 'agent/a%2Fb', kind: 'agent', node: 'a/b', agents: ['a/b'] },
      { key: 'agent/a%252Fb', kind: 'agent', node: 'a%2Fb', agents: ['a%2Fb'] },
      { key: 'agent/..', kind: 'agent', node: '..', agents: ['..'] },
    ]);
  });

  it('shares the outermost frame through nested frames and parent agents, without widening to siblings', () => {
    const model = doc(
      frame('outer'),
      frame('inner', 'outer'),
      agent('lead', 'inner'),
      agent('worker', 'lead'),
      frame('other'),
      agent('b', 'other'),
    );
    expect(workspaceOwners(model)).toEqual([
      { key: 'group/outer', kind: 'group', node: 'outer', agents: ['lead', 'worker'] },
      { key: 'group/other', kind: 'group', node: 'other', agents: ['b'] },
    ]);
    expect(workspaceOwner(model, 'worker')).toEqual(workspaceOwner(model, 'lead'));
  });

  it('includes a parent agent in the group it heads and ignores empty frames', () => {
    expect(workspaceOwners(doc(agent('lead'), agent('a', 'lead'), frame('empty')))).toEqual([
      { key: 'group/lead', kind: 'group', node: 'lead', agents: ['lead', 'a'] },
    ]);
  });

  it('does not infer sharing from links, queues, labels or adapters', () => {
    const model = doc(agent('a'), agent('b'));
    model.links.push({ source: 'a', target: 'b' });
    model.nodes[0] = {
      ...agent('a'),
      data: { label: 'b', queue: [{ id: 'wait', waitFor: [{ agent: 'b' }] }] },
    };
    expect(workspaceOwners(model).map(({ key }) => key)).toEqual(['agent/a', 'agent/b']);
  });

  it('accepts child-before-parent input without changing its member order', () => {
    expect(workspaceOwners(doc(agent('b', 'F'), agent('a', 'F'), frame('F')))[0]?.agents).toEqual([
      'b',
      'a',
    ]);
  });

  it.each([
    ['duplicate', doc(agent('a'), agent('a'))],
    ['missing parent', doc(agent('a', 'missing'))],
    ['cycle', doc(frame('F', 'G'), frame('G', 'F'), agent('a', 'F'))],
    ['self parent', doc(agent('a', 'a'))],
  ])('refuses an invalid hierarchy: %s', (_name, model) => {
    expect(() => workspaceOwners(model)).toThrow();
  });

  it('refuses a missing agent and a frame named as an agent', () => {
    const model = doc(frame('F'), agent('a', 'F'));
    expect(() => workspaceOwner(model, 'missing')).toThrow(/missing/);
    expect(() => workspaceOwner(model, 'F')).toThrow(/agent/);
  });
});

describe('binding plans', () => {
  const initial = () => ({
    before: doc(),
    after: doc(agent('a'), agent('b')),
    repository: repo,
    bindings: [] as Binding[],
    workspaces: [] as Workspace[],
  });

  it('describes separate creations from the captured project revision without minting ids', () => {
    const plan = bindingPlan(initial());
    expect(plan.components.map(({ target }) => target)).toEqual([
      { kind: 'create', source: { kind: 'project', revision: 'base' } },
      { kind: 'create', source: { kind: 'project', revision: 'base' } },
    ]);
    expect(plan.components.map(({ owner }) => owner.key)).toEqual(['agent/a', 'agent/b']);
  });

  it('reuses an existing group, including its parent, for an unbound new member', () => {
    const plan = bindingPlan({
      ...initial(),
      before: doc(agent('lead'), agent('a', 'lead')),
      after: doc(agent('lead'), agent('a', 'lead'), agent('b', 'lead')),
      bindings: [binding('lead', 'W'), binding('a', 'W')],
      workspaces: [workspace('W', 'group/lead')],
    });
    expect(plan.components).toMatchObject([
      {
        owner: { agents: ['lead', 'a', 'b'] },
        target: { kind: 'reuse', workspace: 'W' },
        bindings: [
          { agent: 'lead', previous: binding('lead', 'W') },
          { agent: 'a', previous: binding('a', 'W') },
          { agent: 'b', previous: null },
        ],
      },
    ]);
    expect(plan.released).toEqual([]);
  });

  it.each([
    [doc(agent('a')), doc(agent('a'), agent('b', 'a')), 'agent/a'],
    [doc(agent('a'), agent('b', 'a')), doc(agent('a')), 'group/a'],
    [doc(frame('F'), agent('a', 'F')), doc(agent('F'), agent('a', 'F')), 'group/F'],
  ] as const)(
    'keeps the root’s tree when its kind/group-heading changes',
    (before, after, owner) => {
      const plan = bindingPlan({
        ...initial(),
        before,
        after,
        bindings: before.nodes.filter((n) => n.type === 'agent').map((n) => binding(n.id, 'W')),
        workspaces: [workspace('W', owner)],
      });
      expect(plan.components[0]?.target).toEqual({ kind: 'reuse', workspace: 'W' });
    },
  );

  it('keeps bindings through rename, nested grouping and moves within the same outer group', () => {
    const before = doc(frame('F'), agent('a', 'F'), agent('b', 'F'));
    const after = doc(
      { ...frame('F'), data: { label: 'Renamed' } },
      frame('inner', 'F'),
      { ...agent('a', 'inner'), position: { x: 100, y: 200 } },
      agent('b', 'F'),
    );
    const plan = bindingPlan({
      ...initial(),
      before,
      after,
      bindings: [binding('a', 'W'), binding('b', 'W')],
      workspaces: [workspace('W', 'group/F')],
    });
    expect(plan.components[0]?.target).toEqual({ kind: 'reuse', workspace: 'W' });
    expect(plan.released).toEqual([]);
  });

  it('reserves a surviving group’s tree when a child splits off, forking that child from its group tip', () => {
    const before = doc(frame('F'), agent('a', 'F'), agent('b', 'F'));
    const plan = bindingPlan({
      ...initial(),
      before,
      after: doc(agent('a'), frame('F'), agent('b', 'F')),
      bindings: [binding('a', 'W'), binding('b', 'W')],
      workspaces: [workspace('W', 'group/F', { revision: 'group-tip' })],
    });
    expect(plan.components.map(({ target }) => target)).toEqual([
      { kind: 'create', source: { kind: 'workspace', workspace: 'W', revision: 'group-tip' } },
      { kind: 'reuse', workspace: 'W' },
    ]);
    expect(plan.released).toEqual([]);
  });

  it('does not let two split components reuse one tree when their old frame goes', () => {
    const plan = bindingPlan({
      ...initial(),
      before: doc(frame('F'), agent('a', 'F'), agent('b', 'F')),
      after: doc(agent('a'), agent('b')),
      bindings: [binding('a', 'W'), binding('b', 'W')],
      workspaces: [workspace('W', 'group/F')],
    });
    expect(plan.components.every(({ target }) => target.kind === 'create')).toBe(true);
    expect(plan.components.map(({ target }) => target)).toEqual(
      Array.from({ length: 2 }, () => ({
        kind: 'create',
        source: { kind: 'workspace', workspace: 'W', revision: 'base' },
      })),
    );
    expect(plan.released).toEqual(['W']);
  });

  it('chooses the existing destination before the first member’s former tree', () => {
    const before = doc(agent('a'), frame('F'), agent('b', 'F'));
    const plan = bindingPlan({
      ...initial(),
      before,
      after: doc(frame('F'), agent('a', 'F'), agent('b', 'F')),
      bindings: [binding('a', 'A'), binding('b', 'B')],
      workspaces: [workspace('A', 'agent/a'), workspace('B', 'group/F')],
    });
    expect(plan.components[0]?.target).toEqual({ kind: 'reuse', workspace: 'B' });
    expect(plan.released).toEqual(['A']);
  });

  it('uses the root agent’s tree, or the first member’s tree for a new frame, when grouping', () => {
    const before = doc(agent('a'), agent('b'));
    const context = {
      ...initial(),
      before,
      bindings: [binding('a', 'A'), binding('b', 'B')],
      workspaces: [workspace('A', 'agent/a'), workspace('B', 'agent/b')],
    };
    expect(
      bindingPlan({ ...context, after: doc(agent('b', 'a'), agent('a')) }).components[0]?.target,
    ).toEqual({ kind: 'reuse', workspace: 'A' });
    expect(
      bindingPlan({ ...context, after: doc(frame('F'), agent('b', 'F'), agent('a', 'F')) })
        .components[0]?.target,
    ).toEqual({ kind: 'reuse', workspace: 'B' });
  });

  it('forks an independent spawn from its source’s committed revision, including copy chains', () => {
    const plan = bindingPlan({
      ...initial(),
      before: doc(agent('a')),
      after: doc(agent('a'), agent('b'), agent('c')),
      bindings: [binding('a', 'A')],
      workspaces: [workspace('A', 'agent/a', { revision: 'source-tip' })],
      copies: new Map([
        ['b', 'a'],
        ['c', 'b'],
      ]),
    });
    expect(plan.components.slice(1).map(({ target }) => target)).toEqual(
      Array.from({ length: 2 }, () => ({
        kind: 'create',
        source: { kind: 'workspace', workspace: 'A', revision: 'source-tip' },
      })),
    );
  });

  it('joins a spawn’s group instead of creating its own checkout', () => {
    const plan = bindingPlan({
      ...initial(),
      before: doc(agent('lead'), agent('a', 'lead')),
      after: doc(agent('lead'), agent('a', 'lead'), agent('b', 'lead')),
      bindings: [binding('lead', 'W'), binding('a', 'W')],
      workspaces: [workspace('W', 'group/lead')],
      copies: new Map([['b', 'a']]),
    });
    expect(plan.components).toHaveLength(1);
    expect(plan.components[0]?.target).toEqual({ kind: 'reuse', workspace: 'W' });
  });

  it('keeps an unknown source revision unknown rather than falling back to the project', () => {
    const plan = bindingPlan({
      ...initial(),
      before: doc(agent('a')),
      after: doc(agent('a'), agent('b')),
      bindings: [binding('a', 'A')],
      workspaces: [workspace('A', 'agent/a', { revision: null })],
      copies: new Map([['b', 'a']]),
    });
    expect(plan.components[1]?.target).toEqual({
      kind: 'create',
      source: { kind: 'workspace', workspace: 'A', revision: null },
    });
  });

  it('describes a project change without reusing or forking a different repository’s trees', () => {
    const plan = bindingPlan({
      ...initial(),
      before: doc(agent('a')),
      after: doc(agent('a')),
      bindings: [binding('a', 'A')],
      workspaces: [workspace('A', 'agent/a', { repository: 'previous' })],
    });
    expect(plan.components[0]?.target).toEqual({
      kind: 'create',
      source: { kind: 'project', revision: 'base' },
    });
    expect(plan.released).toEqual(['A']);
  });

  it('reports a deleted member but releases a shared tree only when its last use goes', () => {
    const context = {
      ...initial(),
      before: doc(agent('lead'), agent('a', 'lead')),
      bindings: [binding('lead', 'W'), binding('a', 'W')],
      workspaces: [workspace('W', 'group/lead')],
    };
    const one = bindingPlan({ ...context, after: doc(agent('lead')) });
    expect(one.removed).toEqual([{ agent: 'a', binding: binding('a', 'W') }]);
    expect(one.released).toEqual([]);
    const all = bindingPlan({ ...context, after: doc() });
    expect(all.removed.map(({ agent }) => agent)).toEqual(['lead', 'a']);
    expect(all.released).toEqual(['W']);
  });

  it('never selects or releases a retained historical workspace', () => {
    const plan = bindingPlan({
      ...initial(),
      after: doc(agent('a')),
      workspaces: [workspace('old', 'agent/a', { active: false })],
    });
    expect(plan.components[0]?.target.kind).toBe('create');
    expect(plan.released).toEqual([]);
  });

  it('does not mutate documents, bindings, records or copy metadata', () => {
    const input = {
      ...initial(),
      before: doc(agent('a')),
      bindings: [binding('a', 'A')],
      workspaces: [workspace('A', 'agent/a')],
      copies: new Map([['b', 'a']]),
    };
    const saved = structuredClone(input);
    freeze(input);
    expect(bindingPlan(input)).toEqual(bindingPlan(input));
    expect(input).toEqual(saved);
  });

  it('refuses mismatched canvases, duplicate records, missing binding targets and cyclic copies', () => {
    const input = initial();
    expect(() => bindingPlan({ ...input, after: { ...input.after, id: newCanvasId() } })).toThrow(
      /canvas/,
    );
    expect(() =>
      bindingPlan({ ...input, workspaces: [workspace('W', 'agent/a', { canvas: newCanvasId() })] }),
    ).toThrow(/canvas/);
    expect(() =>
      bindingPlan({ ...input, workspaces: [workspace('W', 'agent/a'), workspace('W', 'agent/b')] }),
    ).toThrow(/duplicate/i);
    expect(() => bindingPlan({ ...input, bindings: [binding('a', 'missing')] })).toThrow(/missing/);
    expect(() =>
      bindingPlan({
        ...input,
        copies: new Map([
          ['a', 'b'],
          ['b', 'a'],
        ]),
      }),
    ).toThrow(/cycle/i);
  });
});

describe('workspace plan fingerprints', () => {
  const input = () => ({
    before: doc(agent('a'), frame('F'), agent('b', 'F')),
    after: doc(frame('F'), agent('a', 'F'), agent('b', 'F')),
    repository: repo,
    bindings: [binding('a', 'A'), binding('b', 'B')],
    workspaces: [workspace('A', 'agent/a'), workspace('B', 'group/F')],
  });
  const evidence = () => [observed('A'), observed('B')];

  it('is stable across record, evidence, session and object-key order', () => {
    const context = input();
    const sessions = [
      { agent: 'a', id: 'one', generation: 1 },
      { agent: 'b', id: 'two', generation: 2 },
    ];
    const plan = bindingPlan(context);
    const first = [observed('A', { sessions }), observed('B')];
    const again = bindingPlan({
      ...context,
      bindings: [...context.bindings].reverse(),
      workspaces: [...context.workspaces].reverse(),
    });
    const last = observed('A', { sessions: [...sessions].reverse() });
    expect(rebindFingerprint(plan, first)).toBe(
      rebindFingerprint(again, [
        observed('B'),
        {
          setup: last.setup,
          sessions: last.sessions,
          merged: last.merged,
          status: last.status,
          head: last.head,
          branch: last.branch,
          identity: last.identity,
          generation: last.generation,
          workspace: last.workspace,
        },
      ]),
    );
  });

  it.each([
    { head: 'new-commit' },
    { branch: 'refs/heads/another-branch' },
    { branch: null },
    { identity: 'replacement-checkout' },
    { identity: null },
    { status: 'new-dirty-file' },
    { status: null },
    { merged: false },
    { generation: 2 },
    { sessions: [{ agent: 'a', id: 'new-session', generation: 1 }] },
    { setup: { id: 'attempt', generation: 1, state: 'running' } },
  ] satisfies Partial<WorkspaceObservation>[])(
    'changes when workspace observations change: %j',
    (change) => {
      const plan = bindingPlan(input());
      expect(rebindFingerprint(plan, [observed('A', change), observed('B')])).not.toBe(
        rebindFingerprint(plan, evidence()),
      );
    },
  );

  it('changes for a different target, member, binding or project generation', () => {
    const context = input();
    const original = rebindFingerprint(bindingPlan(context), evidence());
    for (const changed of [
      { ...context, repository: { ...repo, generation: 2 } },
      { ...context, repository: { ...repo, ref: 'refs/heads/another-base' } },
      { ...context, bindings: [binding('a', 'A', 2), binding('b', 'B')] },
      { ...context, after: doc(frame('G'), agent('a', 'G'), agent('b', 'G')) },
      { ...context, after: doc(frame('F'), agent('a', 'F'), agent('b', 'F'), agent('c', 'F')) },
    ])
      expect(rebindFingerprint(bindingPlan(changed), evidence())).not.toBe(original);
  });

  it('does not stale a rebind for unrelated labels, positions or queue text', () => {
    const context = input();
    const changed = {
      ...context,
      after: {
        ...context.after,
        nodes: context.after.nodes.map((n) =>
          n.type === 'agent'
            ? {
                ...n,
                position: { x: 50, y: 30 },
                data: {
                  ...n.data,
                  label: 'Changed',
                  queue: [{ id: 'later', message: 'Unrelated queue text' }],
                },
              }
            : { ...n, data: { ...n.data, label: 'Changed' } },
        ),
      },
    };
    expect(rebindFingerprint(bindingPlan(changed), evidence())).toBe(
      rebindFingerprint(bindingPlan(context), evidence()),
    );
  });

  it('captures queue work a deletion would now remove, including changes to its revision alone', () => {
    const context = { ...input(), after: doc(frame('F'), agent('b', 'F')) };
    const original = deletionFingerprint(bindingPlan(context), evidence());
    const node = agent('a');
    const withWork = {
      ...context,
      before: doc(
        { ...node, data: { label: 'a', queue: [{ id: 'work', message: 'Do not lose this' }] } },
        frame('F'),
        agent('b', 'F'),
      ),
    };
    expect(deletionFingerprint(bindingPlan(withWork), evidence())).not.toBe(original);
    expect(deletionFingerprint(bindingPlan(context), evidence(), { 'node/a': 2 })).not.toBe(
      deletionFingerprint(bindingPlan(context), evidence(), { 'node/a': 1 }),
    );
  });

  it('captures newly cleared references and other members retaining a deleted member’s tree', () => {
    const before = doc(agent('lead'), agent('a', 'lead'));
    const context = {
      ...input(),
      before,
      after: doc(agent('lead')),
      bindings: [binding('lead', 'A'), binding('a', 'A')],
      workspaces: [workspace('A', 'group/lead')],
    };
    const original = deletionFingerprint(bindingPlan(context), [observed('A')]);
    expect(
      deletionFingerprint(bindingPlan({ ...context, after: doc() }), [observed('A')]),
    ).not.toBe(original);
    expect(
      deletionFingerprint(bindingPlan(context), [
        observed('A', { sessions: [{ agent: 'lead', id: 'live', generation: 2 }] }),
      ]),
    ).not.toBe(original);
  });

  it('includes references that a rebuilt deletion would newly clear', () => {
    const context = input();
    const before = context.before;
    const first = bindingPlan({ ...context, after: remove(before, { nodes: ['a'] }).next });
    const later = {
      ...before,
      nodes: before.nodes.map((node) =>
        node.id === 'b' && node.type === 'agent'
          ? {
              ...node,
              data: { ...node.data, queue: [{ id: 'new-wait', waitFor: [{ agent: 'a' }] }] },
            }
          : node,
      ),
    };
    const rebuilt = bindingPlan({
      ...context,
      before: later,
      after: remove(later, { nodes: ['a'] }).next,
    });
    expect(deletionFingerprint(rebuilt, evidence())).not.toBe(
      deletionFingerprint(first, evidence()),
    );
  });

  it('ignores observations of a workspace outside the rebind', () => {
    const plan = bindingPlan(input());
    expect(rebindFingerprint(plan, [...evidence(), observed('unrelated')])).toBe(
      rebindFingerprint(plan, [...evidence(), observed('unrelated', { head: 'another-commit' })]),
    );
  });

  it('refuses missing or duplicate observations instead of treating them as safe', () => {
    const plan = bindingPlan(input());
    expect(() => rebindFingerprint(plan, [observed('A')])).toThrow(/B/);
    expect(() => deletionFingerprint(plan, [observed('A'), observed('A'), observed('B')])).toThrow(
      /duplicate/i,
    );
  });
});

function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}
