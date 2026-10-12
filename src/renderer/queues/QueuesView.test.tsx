import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { GraphEditor } from '../graph/GraphEditor';
import type { Graph, GraphNode } from '../graph/graph';
import type { QueueItem } from '../graph/queue';

const agent = (id: string, y: number, queue: QueueItem[] = []): GraphNode => ({
  id,
  type: 'agent',
  position: { x: 0, y },
  data: { label: id, queue },
});

/** a researches and hands b a message; b builds, waits for a's research, then checks. */
const graph: Graph = {
  nodes: [
    agent('a', 0, [
      { id: 'research', action: 'Workflow' },
      { id: 'hand', message: 'Here is what I found', target: 'b' },
    ]),
    agent('b', 100, [
      { id: 'build', action: 'Edit' },
      { id: 'w', waitFor: [{ agent: 'a', item: 'research' }] },
      { id: 'check', message: 'Cross-check' },
    ]),
  ],
  edges: [],
};

function setup(initial: Graph = graph) {
  const { container } = render(<GraphEditor initialGraph={initial} />);
  const card = (id: string) => {
    const element = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
    if (!element) throw new Error(`no node ${id}`);
    return element;
  };
  const queues = () => screen.getByRole('dialog', { name: 'All queues' });
  return { card, queues };
}

describe('the queues view', () => {
  it("shows every agent's queue in a lane, with lines for its waits and the work it hands on", () => {
    const { queues } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Show all queues' }));
    const view = within(queues());
    expect(view.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual([
      'a: Workflow',
      'a: Message “Here is what I found” → b',
      'b: Edit',
      'b: Wait for a: Workflow',
      'b: Message “Cross-check”',
    ]);
    // A line for the wait, and a dashed one for the message a hands b.
    const lines = [...queues().querySelectorAll<SVGPathElement>('path[data-link]')];
    expect(lines.map((line) => line.dataset.kind).sort()).toEqual(['handoff', 'wait']);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'All queues' })).toBeNull();
  });

  it('opens from inside an agent, and opens an agent from its lane', () => {
    const { card, queues } = setup();
    fireEvent.doubleClick(card('b'));
    const b = within(screen.getByRole('dialog', { name: 'b' }));
    fireEvent.click(b.getByRole('button', { name: 'All queues' }));
    // Escape closes the queues, not the agent under them.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: 'b' })).toBeTruthy();
    fireEvent.click(b.getByRole('button', { name: 'All queues' }));
    fireEvent.click(within(queues()).getByRole('button', { name: 'Open a' }));
    expect(screen.queryByRole('dialog', { name: 'All queues' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();
  });

  it('marks waits that wait on each other as stuck', () => {
    const { queues } = setup({
      nodes: [
        agent('a', 0, [{ id: 'w', waitFor: [{ agent: 'b', item: 'w' }] }]),
        agent('b', 100, [{ id: 'w', waitFor: [{ agent: 'a', item: 'w' }] }]),
      ],
      edges: [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show all queues' }));
    expect(
      within(queues())
        .getAllByRole('group')
        .map((g) => g.getAttribute('aria-label')),
    ).toEqual(['a: Wait for b: its wait (stuck)', 'b: Wait for a: its wait (stuck)']);
  });
});
