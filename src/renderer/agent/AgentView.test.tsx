import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphEditor } from '../graph/GraphEditor';
import type { Graph, GraphNode } from '../graph/graph';

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

/** Lets the scripted session play for `ms`. */
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

  it('plays a scripted turn: its reply, tool calls, and permission prompts', () => {
    const { send, transcript } = open();
    send('Add rate limiting');
    expect(transcript.getByText('Add rate limiting')).toBeTruthy();
    play();
    expect(transcript.getByRole('button', { name: /^Read src\/index\.ts/ })).toBeTruthy();

    // Manual mode asks before an edit, then before a command.
    const edit = within(transcript.getByRole('group', { name: 'Edit file: src/index.ts' }));
    fireEvent.click(edit.getByRole('button', { name: 'Yes' }));
    play();
    expect(transcript.getByRole('button', { name: /^Edit src\/index\.ts \+4 −1/ })).toBeTruthy();
    const command = within(transcript.getByRole('group', { name: 'Bash command: npm test' }));
    fireEvent.click(command.getByRole('button', { name: "Yes, and don't ask again for npm test" }));
    play();
    expect(transcript.getByText(/^Worked for \d+s$/)).toBeTruthy();
    expect(transcript.getAllByText(/scripted session/).length).toBeGreaterThan(0);

    // Next turn: it asks about the edit again, but not the command.
    send('Again');
    play();
    const [, again] = transcript.getAllByRole('group', { name: 'Edit file: src/index.ts' });
    if (!again) throw new Error('no second edit prompt');
    fireEvent.click(within(again).getByRole('button', { name: 'Yes' }));
    play();
    expect(transcript.getAllByRole('group', { name: 'Bash command: npm test' })).toHaveLength(1);
    expect(transcript.getAllByText(/^Worked for \d+s$/)).toHaveLength(2);
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

  it('shows the chat as the current item of the queue, named by its first message', () => {
    const { view, send } = open();
    const side = within(view.getByRole('complementary', { name: 'Questions and queue' }));
    expect(side.queryByRole('group', { name: /^Current chat/ })).toBeNull();
    send('Add rate limiting to the public API and document every endpoint');
    const chat = side.getByRole('group', { name: /^Current chat/ });
    expect(chat.getAttribute('aria-label')).toBe(
      'Current chat: Add rate limiting to the public API…',
    );
    expect(chat.dataset.status).toBe('working');
    send('And a changelog');
    expect(side.getByRole('group', { name: /^Current chat/ }).getAttribute('aria-label')).toBe(
      'Current chat: Add rate limiting to the public API…',
    );
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

  it('switches mode with Shift+Tab: Accept edits does not ask before editing', () => {
    const { view, composer, send, transcript } = open();
    const mode = () => view.getByRole('button', { name: /^Mode: / }).getAttribute('aria-label');
    expect(mode()).toBe('Mode: Manual');
    fireEvent.keyDown(composer, { key: 'Tab', shiftKey: true });
    expect(mode()).toBe('Mode: Accept edits');
    send('Go');
    play();
    expect(transcript.queryByRole('group', { name: 'Edit file: src/index.ts' })).toBeNull();
    expect(transcript.getByRole('group', { name: 'Bash command: npm test' })).toBeTruthy();
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
          data: { label: 'a', agent: 'Codex' },
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
      const card = screen.getByRole('group', { name: 'Agent 1, Codex' });
      expect(card.classList.contains('group-color-3')).toBe(true);
      expect(card.classList.contains('selected')).toBe(true);
      expect(container.querySelectorAll('.react-flow__edge')).toHaveLength(0);
      expect(next.getByRole('button', { name: 'Agent: Codex' })).toBeTruthy();
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
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Agent 1, Claude');

      fireEvent.doubleClick(screen.getByRole('group', { name: 'a, Claude' }));
      expect(stacked()).toEqual([]);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(container.querySelectorAll('.react-flow__node')).toHaveLength(2);
    });
  });
});
