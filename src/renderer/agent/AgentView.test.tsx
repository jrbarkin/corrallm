import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphEditor } from '../graph/GraphEditor';
import type { GraphNode } from '../graph/graph';

const agent = (id: string): GraphNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id },
});

/** Opens agent `a` in its view; returns the view and its composer. */
function open() {
  const { container } = render(<GraphEditor initialGraph={{ nodes: [agent('a')], edges: [] }} />);
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
  return { card, view, composer, send, transcript };
}

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
});
