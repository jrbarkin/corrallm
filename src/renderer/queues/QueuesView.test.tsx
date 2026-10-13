import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

afterEach(() => {
  vi.useRealTimers();
});

describe('the queues view', () => {
  it("shows every agent's queue in a lane, with ribbons for its waits and the work it hands on", () => {
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
    // A ribbon for the wait, and one for the message a hands b.
    const ribbons = [...queues().querySelectorAll('[data-link]')];
    expect(ribbons.map((ribbon) => ribbon.getAttribute('data-kind')).sort()).toEqual([
      'handoff',
      'wait',
    ]);
    // Pointing at the wait shows its ribbon over the other.
    fireEvent.pointerOver(
      within(view.getByRole('group', { name: 'b: Wait for a: Workflow' })).getByText('Wait for'),
    );
    expect(
      ribbons
        .filter((ribbon) => ribbon.hasAttribute('data-active'))
        .map((r) => r.getAttribute('data-kind')),
    ).toEqual(['wait']);
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

  it('edits each queue in its lane', () => {
    const { queues } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Show all queues' }));
    const view = within(queues());
    // a's message, rewritten in place; b's Edit, removed.
    const message = within(
      view.getByRole('group', { name: 'a: Message “Here is what I found” → b' }),
    ).getByRole('textbox', { name: 'Message to the agent' });
    fireEvent.change(message, { target: { value: 'Notes are in NOTES.md' } });
    fireEvent.click(view.getByRole('button', { name: 'Remove Edit' }));
    // A message added at the end of b's lane.
    fireEvent.click(view.getByRole('button', { name: "Add to b's queue" }));
    fireEvent.click(view.getByRole('option', { name: /^Message/ }));
    const text = view.getByRole('textbox', { name: 'New message to the agent' });
    fireEvent.change(text, { target: { value: 'Ship it' } });
    fireEvent.keyDown(text, { key: 'Enter' });
    expect(view.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual([
      'a: Workflow',
      'a: Message “Notes are in NOTES.md” → b',
      'b: Wait for a: Workflow',
      'b: Message “Cross-check”',
      'b: Message “Ship it”',
    ]);
  });

  it("picks what a wait waits for by clicking it in the other agent's lane", () => {
    const { queues } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Show all queues' }));
    const view = within(queues());
    const change = () =>
      view.getByRole('button', { name: 'Change what it waits for: a: Workflow' });
    // Escape lets go of the pick, and leaves the view open.
    fireEvent.click(change());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(view.queryByRole('button', { name: 'Wait for a: Workflow' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'All queues' })).toBeTruthy();

    fireEvent.click(change());
    fireEvent.click(view.getByRole('button', { name: 'Wait for a: “Here is what I found”' }));
    expect(view.getByRole('group', { name: /^b: Wait for/ }).getAttribute('aria-label')).toBe(
      'b: Wait for a: “Here is what I found”',
    );
    // Its end: all of a's work.
    fireEvent.click(view.getByRole('button', { name: /^Change what it waits for/ }));
    fireEvent.click(view.getByRole('button', { name: "Wait for all of a's work" }));
    expect(view.getByRole('group', { name: /^b: Wait for/ }).getAttribute('aria-label')).toBe(
      'b: Wait for a',
    );
  });

  it('runs the queues, marking the task each agent is on, until stopped', () => {
    const { queues } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Show all queues' }));
    const view = within(queues());
    const run = (name: string) =>
      view.getByRole('group', { name }).querySelector('[data-run]')?.getAttribute('data-run');
    fireEvent.click(view.getByRole('button', { name: 'Run' }));
    // a does its Workflow; b builds, and waits for a's Workflow after.
    expect(run('a: Workflow')).toBe('running');
    expect(run('b: Edit')).toBe('running');
    expect(view.getByRole('status').textContent).toBe('2 working · 0 waiting');
    fireEvent.click(view.getByRole('button', { name: 'Stop' }));
    expect(run('a: Workflow')).toBe('stopped');
    expect(view.getByRole('status').textContent).toBe('Stopped');
    // Run again: an agent's own queue marks the task it is on too.
    fireEvent.click(view.getByRole('button', { name: 'Run' }));
    fireEvent.click(view.getByRole('button', { name: 'Open a' }));
    const own = within(screen.getByRole('dialog', { name: 'a' })).getByRole('button', {
      name: 'Move Workflow',
    });
    expect(own.closest('[data-run]')?.getAttribute('data-run')).toBe('running');
  });

  it('shows when the run needs the user: an agent asks permission, and the lane opens it', () => {
    const { queues } = setup({
      nodes: [agent('a', 0, [{ id: 'fix', message: 'Fix the flaky test' }])],
      edges: [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show all queues' }));
    const view = within(queues());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    fireEvent.click(view.getByRole('button', { name: 'Run' }));
    // The message's turn plays in a's session until it asks before editing (manual mode).
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    const task = view.getByRole('group', { name: 'a: Message “Fix the flaky test”' });
    expect(task.querySelector('[data-run]')?.getAttribute('data-run')).toBe('asking');
    expect(view.getByRole('status').textContent).toBe('0 working · 0 waiting · 1 needs you');
    fireEvent.click(view.getByRole('button', { name: 'Answer a' }));
    expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();
  });

  it('counts down a delay the run holds a lane at, and goes on from it when told', () => {
    const { queues } = setup({
      nodes: [
        agent('a', 0, [
          { id: 'pause', delay: { seconds: 60 } },
          { id: 'next', action: 'Read' },
        ]),
      ],
      edges: [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show all queues' }));
    const view = within(queues());
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    fireEvent.click(view.getByRole('button', { name: 'Run' }));
    const pause = view.getByRole('group', { name: 'a: Wait 1 minute' });
    const run = (name: string) =>
      view.getByRole('group', { name }).querySelector('[data-run]')?.getAttribute('data-run');
    expect(run('a: Wait 1 minute')).toBe('waiting');
    const timer = within(pause).getByRole('timer');
    expect(timer.textContent).toBe('1:00 left');
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(timer.textContent).toBe('0:59 left');
    expect(view.getByRole('status').textContent).toBe('0 working · 1 waiting');

    fireEvent.click(within(pause).getByRole('button', { name: 'Go on now: Wait 1 minute' }));
    expect(run('a: Wait 1 minute')).toBe('succeeded');
    expect(run('a: Read')).toBe('running');
    expect(within(pause).queryByRole('timer')).toBeNull();
    expect(within(pause).queryByRole('button', { name: /^Go on now/ })).toBeNull();
  });

  it('goes on without what a wait waits for once its time limit passes, its ribbon dashed', () => {
    const { queues } = setup({
      nodes: [
        agent('a', 0, [{ id: 'slow', message: 'Take your time' }]),
        agent('b', 100, [
          { id: 'w', waitFor: [{ agent: 'a' }], timeout: { seconds: 2 } },
          { id: 'next', action: 'Read' },
        ]),
      ],
      edges: [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show all queues' }));
    const view = within(queues());
    const name = 'b: Wait for a, at most 2 seconds';
    const run = (task: string) =>
      view.getByRole('group', { name: task }).querySelector('[data-run]')?.getAttribute('data-run');
    expect(queues().querySelector('g[data-kind="wait"]')?.hasAttribute('data-timed')).toBe(true);
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    fireEvent.click(view.getByRole('button', { name: 'Run' }));
    expect(run(name)).toBe('waiting');
    expect(within(view.getByRole('group', { name })).getByRole('timer').textContent).toBe(
      '0:02 left',
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(run(name)).toBe('timedOut');
    expect(run('a: Message “Take your time”')).toBe('running');
    expect(run('b: Read')).toBe('running');
  });
});
