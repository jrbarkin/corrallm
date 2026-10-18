import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useState } from 'react';
import type { ComponentProps } from 'react';

import { GraphEditor as NativeGraphEditor } from '../graph/GraphEditor';
import { automaticBackend } from '../../shared/engine/test-backend';
import type { Graph, GraphNode } from '../graph/graph';
import type { QueueItem, QueueRepeat } from '../../shared/model/queue';

/** Native session events from a test backend; production never fabricates replies. */
function GraphEditor(props: ComponentProps<typeof NativeGraphEditor>) {
  const [backend] = useState(() => automaticBackend().backend);
  const initialGraph = props.initialGraph && {
    ...props.initialGraph,
    nodes: props.initialGraph.nodes.map((node) =>
      node.type === 'agent'
        ? {
            ...node,
            data: {
              ...node.data,
              connection:
                node.data.connection ??
                (node.data.adapter === 'codex'
                  ? ('codex.app-server' as const)
                  : ('claude-code.sdk' as const)),
            },
          }
        : node,
    ),
  };
  return (
    <NativeGraphEditor
      {...props}
      {...(initialGraph ? { initialGraph } : {})}
      sessionBackend={backend}
    />
  );
}

vi.mock('../terminal/screen', async () => {
  const { fakeScreens } = await import('../terminal/test-screen');
  return { createScreen: fakeScreens.create };
});

const agent = (id: string, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id },
  ...extra,
});

/** Opens agent `a` in its view; returns the view and its composer. */
function open(graph: Graph = { nodes: [agent('a')], edges: [] }) {
  const { container } = render(<GraphEditor initialGraph={graph} />);
  const card = container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
  if (!card) throw new Error('no agent');
  fireEvent.doubleClick(card);
  const view = within(screen.getByRole('dialog', { name: 'a' }));
  const composer = view.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message a' });
  const send = (text: string) => {
    fireEvent.change(composer, { target: { value: text } });
    fireEvent.keyDown(composer, { key: 'Enter' });
  };
  const transcript = within(view.getByRole('log', { name: 'Transcript' }));
  return { container, card, view, composer, send, transcript };
}

/** The agent view shown, by its agent's name. */
const shown = (name: string) => within(screen.getByRole('dialog', { name }));
/** The agents stacked in the view shown, top first. */
const stacked = () =>
  within(screen.getByRole('dialog'))
    .queryAllByRole('button', { name: /^Switch to / })
    .map((button) => button.getAttribute('aria-label'));

/** Advances the native test backend’s turn timers. */
const play = (ms = 10_000) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

describe('the agent view', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fills the editor, with a back button to the canvas', () => {
    const { view } = open();
    fireEvent.click(view.getByRole('button', { name: 'Back to the canvas' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('adds to the queue from its sidebar, or from right above the message box', () => {
    const { view } = open();
    const session = within(view.getByRole('region', { name: 'Session' }));
    const side = within(view.getByRole('complementary', { name: 'Questions and queue' }));
    expect(side.getByRole('button', { name: 'Add to queue' })).toBeTruthy();
    fireEvent.click(session.getByRole('button', { name: 'Queue something' }));
    fireEvent.click(session.getByRole('option', { name: /^Read / }));
    fireEvent.keyDown(session.getByRole('combobox'), { key: 'Enter' }); // this agent
    expect(side.getByRole('button', { name: 'Move Read' })).toBeTruthy();
  });

  it('shows each submitted message in the queue without a duplicate chat summary', () => {
    const { view, send } = open();
    const side = within(view.getByRole('complementary', { name: 'Questions and queue' }));
    expect(side.queryByRole('group', { name: /^Current chat/ })).toBeNull();
    send('Add rate limiting to the public API and document every endpoint');
    const row = side
      .getByText('Add rate limiting to the public API and document every endpoint')
      .closest('[data-submission]');
    expect(row?.getAttribute('data-run')).toBe('running');
    expect(side.queryByRole('group', { name: /^Current chat/ })).toBeNull();
    send('And a changelog');
    expect(
      side.getByText('And a changelog').closest('[data-submission]')?.getAttribute('data-run'),
    ).toBe('queued');
  });

  it('closes an open menu on Escape, not the view', () => {
    const { view } = open();
    const mode = view.getByRole('button', { name: /^Mode: / });
    fireEvent.click(mode);
    expect(view.getByRole('menu', { name: 'Mode' })).toBeTruthy();
    fireEvent.keyDown(mode, { key: 'Escape' });
    expect(view.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();
  });

  it('queues messages sent while it works; Escape interrupts, then sends them', () => {
    const { card, view, composer, send, transcript } = open();
    send('First');
    expect(card.classList.contains('working')).toBe(true);
    send('Second');
    send('Third');
    const queued = within(view.getByRole('list', { name: 'Queued messages' }));
    expect(queued.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Second',
      'Third',
    ]);
    // ✕ puts a queued message back in the box.
    fireEvent.click(queued.getByRole('button', { name: 'Edit queued message: Third' }));
    expect(composer.value).toBe('Third');

    fireEvent.change(composer, { target: { value: '' } });
    fireEvent.keyDown(composer, { key: 'Escape' });
    expect(transcript.getByText(/^Interrupted/)).toBeTruthy();
    expect(transcript.getByText('Second')).toBeTruthy();
    expect(view.queryByRole('list', { name: 'Queued messages' })).toBeNull();
  });

  it('never switches into bypassing permissions with Shift+Tab', () => {
    const { view, composer } = open();
    const mode = () => view.getByRole('button', { name: /^Mode: / }).getAttribute('aria-label');
    const seen = [mode()];
    for (let i = 0; i < 4; i += 1) {
      fireEvent.keyDown(composer, { key: 'Tab', shiftKey: true });
      seen.push(mode());
    }
    expect(seen).toEqual([
      'Mode: Manual',
      'Mode: Accept edits',
      'Mode: Plan',
      'Mode: Auto',
      'Mode: Manual',
    ]);
  });

  it('bypasses permissions from the mode menu only once it is confirmed', () => {
    const { view, composer } = open();
    const menu = () => view.getByRole('button', { name: /^Mode: / });
    fireEvent.click(menu());
    fireEvent.click(view.getByRole('menuitemradio', { name: /^Bypass permissions/ }));
    const confirm = within(view.getByRole('alertdialog', { name: 'Bypass permissions?' }));
    expect(menu().getAttribute('aria-label')).toBe('Mode: Manual');
    fireEvent.click(confirm.getByRole('button', { name: 'Cancel' }));
    expect(view.queryByRole('alertdialog')).toBeNull();
    expect(menu().getAttribute('aria-label')).toBe('Mode: Manual');

    // Escape says no too, and leaves the view open.
    fireEvent.click(menu());
    fireEvent.click(view.getByRole('menuitemradio', { name: /^Bypass permissions/ }));
    fireEvent.keyDown(view.getByRole('button', { name: 'Bypass permissions' }), { key: 'Escape' });
    expect(view.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();

    fireEvent.click(menu());
    fireEvent.click(view.getByRole('menuitemradio', { name: /^Bypass permissions/ }));
    fireEvent.click(view.getByRole('button', { name: 'Bypass permissions' }));
    expect(menu().getAttribute('aria-label')).toBe('Mode: Bypass permissions');
    // Out of it with Shift+Tab, to Manual.
    fireEvent.keyDown(composer, { key: 'Tab', shiftKey: true });
    expect(menu().getAttribute('aria-label')).toBe('Mode: Manual');
  });

  it('keeps Codex’s Full access out of Shift+Tab, and switches to it once confirmed', () => {
    const { view, composer } = open({
      nodes: [agent('a', { data: { label: 'a', adapter: 'codex' } })],
      edges: [],
    });
    const menu = () => view.getByRole('button', { name: /^Mode: / });
    const seen = [menu().getAttribute('aria-label')];
    for (let i = 0; i < 3; i += 1) {
      fireEvent.keyDown(composer, { key: 'Tab', shiftKey: true });
      seen.push(menu().getAttribute('aria-label'));
    }
    expect(seen).toEqual(['Mode: Default', 'Mode: Plan', 'Mode: Read only', 'Mode: Default']);

    fireEvent.click(menu());
    fireEvent.click(view.getByRole('menuitemradio', { name: /^Full access/ }));
    const confirm = within(view.getByRole('alertdialog', { name: 'Full access?' }));
    expect(menu().getAttribute('aria-label')).toBe('Mode: Default');
    fireEvent.click(confirm.getByRole('button', { name: 'Full access' }));
    expect(menu().getAttribute('aria-label')).toBe('Mode: Full access');
    // Out of it with Shift+Tab, to the first.
    fireEvent.keyDown(composer, { key: 'Tab', shiftKey: true });
    expect(menu().getAttribute('aria-label')).toBe('Mode: Read only');
  });

  it('asks for your OK above the composer while the run holds it, where what you send asks for changes', () => {
    render(
      <GraphEditor
        initialGraph={{
          nodes: [
            agent('a', {
              data: {
                label: 'a',
                queue: [
                  { id: 'ok', approve: 'the spec in SPEC.md' },
                  { id: 'next', action: 'Read' },
                ],
              },
            }),
          ],
          edges: [],
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show all queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    fireEvent.click(queues.getByRole('button', { name: 'Run' }));
    fireEvent.click(queues.getByRole('button', { name: 'Open a' }));
    const view = shown('a');
    const session = within(view.getByRole('region', { name: 'Session' }));
    const side = within(view.getByRole('complementary', { name: 'Questions and queue' }));
    const row = () =>
      side
        .getByRole('button', { name: 'Move Your OK on the spec in SPEC.md' })
        .closest<HTMLElement>('[data-run]');
    const composer = session.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message a' });
    const bar = () => session.queryByRole('group', { name: 'Needs you' });

    expect(row()?.dataset.run).toBe('asking');
    const asks = within(bar() ?? document.body);
    expect(
      asks.getByText(
        'Waits for your OK on the spec in SPEC.md: write below what should change, or',
      ),
    ).toBeTruthy();
    expect(asks.getAllByRole('button').map((b) => b.textContent)).toEqual(['Approve', 'Stop here']);
    expect(composer.placeholder).toBe('What should change?');

    // What is sent from the composer is the changes asked for: the agent works on them.
    fireEvent.change(composer, { target: { value: 'Cover the empty state too' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(row()?.dataset.run).toBe('running');
    expect(bar()).toBeNull();
    expect(composer.placeholder).toBe('Queue a message for a…');
    const transcript = within(view.getByRole('log', { name: 'Transcript' }));
    expect(transcript.getByText('Cover the empty state too')).toBeTruthy();

    // Once its turn ends (here, interrupted), it asks again.
    fireEvent.keyDown(composer, { key: 'Escape' });
    expect(row()?.dataset.run).toBe('asking');
    expect(row()?.querySelector('.graph-queue-ok-asked')?.textContent).toBe(
      'You asked: “Cover the empty state too”',
    );
    fireEvent.click(within(bar() ?? document.body).getByRole('button', { name: 'Approve' }));
    expect(row()?.dataset.run).toBe('succeeded');
    expect(bar()).toBeNull();
    expect(
      side
        .getByRole('button', { name: 'Move Read' })
        .closest('[data-run]')
        ?.getAttribute('data-run'),
    ).toBe('running');
  });

  it('asks above the composer when a repeat is out of rounds, where what you send is what to try next', () => {
    // An empty message is skipped: no round ends with its last step succeeding.
    render(
      <GraphEditor
        initialGraph={{
          nodes: [
            agent('a', {
              data: {
                label: 'a',
                queue: [
                  {
                    id: 'loop',
                    repeat: [{ id: 'note', message: '' }],
                    until: { kind: 'succeeded' },
                    rounds: 1,
                    otherwise: 'ask',
                  },
                  { id: 'next', action: 'Read' },
                ],
              },
            }),
          ],
          edges: [],
        }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show all queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    fireEvent.click(queues.getByRole('button', { name: 'Run' }));
    play(10);
    fireEvent.click(queues.getByRole('button', { name: 'Open a' }));
    const view = shown('a');
    const session = within(view.getByRole('region', { name: 'Session' }));
    const side = within(view.getByRole('complementary', { name: 'Questions and queue' }));
    const card = () =>
      side
        .getByRole('button', { name: 'Move Repeat until its last step succeeds' })
        .closest<HTMLElement>('.graph-queue-repeat');
    const composer = session.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message a' });
    const bar = () => within(session.getByRole('group', { name: 'Needs you' }));

    expect(card()?.dataset.run).toBe('asking');
    expect(
      bar().getByText(
        '1 round done, and still not: its last step succeeds. What should it try next? Write it below, or',
      ),
    ).toBeTruthy();
    expect(
      bar()
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['One more round', 'Go on']);
    expect(composer.placeholder).toBe('What should it try next?');

    // Sent from the composer: it goes to the agent, and one more round runs.
    fireEvent.change(composer, { target: { value: 'Try a smaller fix' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    const transcript = within(view.getByRole('log', { name: 'Transcript' }));
    expect(transcript.getByText('Try a smaller fix')).toBeTruthy();
    play(10);
    expect(card()?.dataset.round).toBe('Round 2 of 2');
    expect(bar().getByText(/^2 rounds done/)).toBeTruthy();

    fireEvent.click(bar().getByRole('button', { name: 'Go on' }));
    expect(card()?.dataset.run).toBe('failed');
    expect(card()?.dataset.round).toBe('2 rounds');
    expect(session.queryByRole('group', { name: 'Needs you' })).toBeNull();
    expect(
      side
        .getByRole('button', { name: 'Move Read' })
        .closest('[data-run]')
        ?.getAttribute('data-run'),
    ).toBe('running');
  });

  it("picks a step inside the other agent's repeat, beside, for a wait inside its own repeat", () => {
    const round = (id: string, repeat: QueueItem[]): QueueItem => ({
      id,
      repeat: repeat as QueueRepeat['repeat'],
      until: { kind: 'succeeded' },
      rounds: 3,
      otherwise: 'ask',
    });
    render(
      <GraphEditor
        initialGraph={{
          nodes: [
            agent('a', {
              data: {
                label: 'a',
                queue: [
                  round('work', [
                    { id: 'implement', action: 'Edit' },
                    { id: 'reviewed', waitFor: [{ agent: 'r' }] },
                  ]),
                ],
              },
            }),
            agent('r', {
              position: { x: 0, y: 100 },
              data: {
                label: 'Reviewer',
                queue: [
                  round('reviewing', [
                    { id: 'ready', waitFor: [{ agent: 'a', item: 'implement' }] },
                    { id: 'review', action: 'Read' },
                  ]),
                ],
              },
            }),
          ],
          edges: [],
        }}
      />,
    );
    const card = document.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
    if (!card) throw new Error('no agent');
    fireEvent.doubleClick(card);
    const view = shown('a');
    fireEvent.click(view.getByRole('button', { name: 'Change what it waits for: Reviewer' }));
    const beside = within(view.getByRole('complementary', { name: "Reviewer's queue" }));
    // Each item inside its repeat picks; its header, the whole repeat.
    expect(
      beside
        .getAllByRole('button', { name: /^Wait for (Reviewer|all)/ })
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      'Wait for Reviewer: its repeat',
      'Wait for Reviewer: its wait',
      'Wait for Reviewer: Read',
      "Wait for all of Reviewer's work",
    ]);
    fireEvent.click(beside.getByRole('button', { name: 'Wait for Reviewer: Read' }));
    expect(
      view.getByRole('button', { name: 'Change what it waits for: Reviewer: Read' }),
    ).toBeTruthy();
    // The two waits in the repeats are linked across the queues, each to what it waits for.
    expect(
      [...screen.getByRole('dialog', { name: 'a' }).querySelectorAll('[data-link]')].map((l) =>
        l.getAttribute('data-link'),
      ),
    ).toEqual(['reviewed>review', 'ready>implement']);
  });

  describe('its rail', () => {
    /** Agent a, a Codex agent, in a group. */
    const grouped: Graph = {
      nodes: [
        {
          id: 'F',
          type: 'frame',
          position: { x: 0, y: 0 },
          data: { label: 'Group 1', color: 3 },
          width: 400,
          height: 300,
        },
        agent('a', {
          parentId: 'F',
          position: { x: 20, y: 52 },
          data: { label: 'a', adapter: 'codex' },
        }),
      ],
      edges: [],
    };

    it('spawns a new agent of its type in its group, not linked, and stacks itself under it', () => {
      const { container, view, send } = open(grouped);
      send('Add rate limiting');
      fireEvent.click(view.getByRole('button', { name: 'New agent' }));

      // The new agent is shown, and on the canvas: a Codex agent in a's group, not linked to a.
      const next = shown('Agent 1');
      expect(screen.queryByRole('dialog', { name: 'a' })).toBeNull();
      const card = screen.getByRole('group', { name: 'Agent 1, Codex · App Server' });
      expect(card.classList.contains('group-color-3')).toBe(true);
      expect(card.classList.contains('selected')).toBe(true);
      expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(0);
      expect(next.getByRole('button', { name: 'Agent: Codex · App Server' })).toBeTruthy();
      // a waits on top of the stack, still working.
      expect(stacked()).toEqual(['Switch to a']);
      expect(next.getByRole('button', { name: 'Switch to a' }).dataset.status).toBe('working');
    });

    it('spawns one linked to the agent shown, from the menu beside its ⊕', () => {
      const { container, view } = open(grouped);
      fireEvent.click(view.getByRole('button', { name: 'Ways to add an agent' }));
      const menu = within(view.getByRole('menu', { name: 'New agent' }));
      fireEvent.click(menu.getByRole('menuitem', { name: 'New agent, linked to a' }));
      const links = () =>
        [...container.querySelectorAll('.react-flow__edge')].map((e) =>
          e.getAttribute('aria-label'),
        );
      expect(links()).toEqual(['a and Agent 1 can talk']);

      // The menu's other choice is the ⊕'s: on its own.
      fireEvent.click(shown('Agent 1').getByRole('button', { name: 'Ways to add an agent' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'New agent' }));
      expect(shown('Agent 2')).toBeTruthy();
      expect(links()).toEqual(['a and Agent 1 can talk']);
    });

    it('switches to a stacked agent, the one shown going on top of the stack', () => {
      const { view } = open();
      fireEvent.click(view.getByRole('button', { name: 'New agent' }));
      fireEvent.click(shown('Agent 1').getByRole('button', { name: 'New agent' }));
      expect(stacked()).toEqual(['Switch to Agent 1', 'Switch to a']);

      fireEvent.click(shown('Agent 2').getByRole('button', { name: 'Switch to a' }));
      expect(shown('a')).toBeTruthy();
      expect(stacked()).toEqual(['Switch to Agent 2', 'Switch to Agent 1']);
      fireEvent.click(shown('a').getByRole('button', { name: 'Switch to Agent 1' }));
      expect(stacked()).toEqual(['Switch to a', 'Switch to Agent 2']);
    });

    it('closes to the canvas from any agent in the stack, which then starts afresh', () => {
      const { container, view } = open();
      fireEvent.click(view.getByRole('button', { name: 'New agent' }));
      fireEvent.click(shown('Agent 1').getByRole('button', { name: 'Back to the canvas' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      // The agent shown last has the keyboard on the canvas.
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Agent 1, Claude · SDK');

      fireEvent.doubleClick(screen.getByRole('group', { name: 'a, Claude · SDK' }));
      expect(stacked()).toEqual([]);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(container.querySelectorAll('.react-flow__node')).toHaveLength(2);
    });
  });
});
