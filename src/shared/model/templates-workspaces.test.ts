import { compileExample } from './test-template';
import { describe, expect, it } from 'vitest';

import { EXAMPLES } from '../examples';
import { TEST_CATALOG } from '../test-model';
import type { QueueItem } from './queue';
import { workspaceOwners } from './workspaces';
import identities from './test-templates-identity.json';

const labels: Record<string, string> = {
  'Spec first': 'Spec and implementation',
  'Fan-out research': 'Research and report',
};
const walk = (items: readonly QueueItem[]): QueueItem[] =>
  items.flatMap((item) => [
    item,
    ...('repeat' in item ? walk(item.repeat) : 'then' in item ? walk(item.then) : []),
  ]);

describe.each(EXAMPLES)('$name workspaces', (example) => {
  const document = compileExample(example, TEST_CATALOG, 'claude-code');
  const agents = document.nodes.filter((node) => node.type === 'agent');
  it('shares handoff files in one outer frame, except the three independent competitors/judge trees', () => {
    const owners = workspaceOwners(document);
    if (example.name === 'Head to head') {
      expect(owners.map(({ key, agents }) => ({ key, agents }))).toEqual([
        { key: 'agent/a', agents: ['a'] },
        { key: 'agent/b', agents: ['b'] },
        { key: 'agent/judge', agents: ['judge'] },
      ]);
    } else {
      expect(owners).toHaveLength(1);
      expect(owners[0]).toMatchObject({ kind: 'group', agents: agents.map(({ id }) => id) });
      const frame = document.nodes.find((node) => node.id === owners[0]?.node);
      expect(frame).toMatchObject({
        type: 'frame',
        data: { label: labels[example.name] ?? example.name },
      });
    }
  });

  it('preserves every original node, queue id, link and existing Lead/nested parenting', () => {
    const original = identities[document.id as keyof typeof identities];
    expect(document.links).toEqual(original.links);
    for (const old of original.nodes) {
      const renamed =
        example.name === 'Head to head'
          ? (({ claude: 'a', codex: 'b' } as Record<string, string>)[old.id] ?? old.id)
          : old.id;
      const node = document.nodes.find(({ id }) => id === renamed);
      expect(node).toBeDefined();
      expect(node?.type).toBe(old.kind === 'group' ? 'frame' : 'agent');
      expect(
        walk(node?.type === 'agent' ? (node.data.queue ?? []) : []).map(({ id }) => id),
      ).toEqual(old.items);
      expect(node?.parentId).toBe(
        'parent' in old
          ? old.parent
          : example.name === 'Head to head'
            ? undefined
            : workspaceOwners(document)[0]?.node,
      );
    }
    expect(agents.map(({ id }) => id)).toEqual(
      original.nodes
        .filter(({ kind }) => kind === 'agent')
        .map(({ id }) =>
          example.name === 'Head to head'
            ? (({ claude: 'a', codex: 'b' } as Record<string, string>)[id] ?? id)
            : id,
        ),
    );
  });

  it('never asks a CLI to allocate a second native worktree', () => {
    for (const node of agents)
      for (const item of walk(node.data.queue ?? []))
        if ('action' in item) expect(item.action).not.toMatch(/^(?:EnterWorktree|\/worktree)$/);
  });
});

it('Head to head exchanges committed refs/feedback and reports a winner for review', () => {
  const example = EXAMPLES.find(({ name }) => name === 'Head to head');
  if (!example) throw new Error('Missing template');
  const doc = compileExample(example, TEST_CATALOG, 'claude-code');
  for (const id of ['a', 'b']) {
    const node = doc.nodes.find((node) => node.id === id);
    const queue = walk(node?.type === 'agent' ? (node.data.queue ?? []) : []);
    const build = queue.find((item) => item.id === 'build');
    expect(build).toHaveProperty('message', expect.stringContaining('git show'));
    expect(build).toHaveProperty('message', expect.stringContaining(`.compete/feedback-${id}.md`));
    expect(JSON.stringify(queue)).not.toMatch(
      /compete\/(?:claude|codex)|main checkout|git worktree list/,
    );
  }
  const judgeNode = doc.nodes.find((node) => node.id === 'judge');
  const judge = walk(judgeNode?.type === 'agent' ? (judgeNode.data.queue ?? []) : []);
  const scoring = judge.find((item) => item.id === 'judge');
  expect(scoring).toHaveProperty('message', expect.stringContaining('commit'));
  expect(scoring).toHaveProperty('message', expect.stringContaining('missing'));
  expect(judge.find((item) => item.id === 'merge')).toHaveProperty(
    'message',
    expect.stringContaining('Report the winning role, ref and reason for review'),
  );
});
