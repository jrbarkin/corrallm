import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionEvent } from '../../shared/session';
import type { TerminalEvent } from '../../shared/terminal';
import { GraphEditor } from '../graph/GraphEditor';
import type { Graph, GraphNode } from '../graph/graph';
import { fakeBackend } from '../test-backend';
import { fakeScreens, fakeTerminals } from './test-screen';

// jsdom cannot draw xterm.js: a fake terminal stands in (test-screen.ts).
vi.mock('./screen', async () => {
  const { fakeScreens: screens } = await import('./test-screen');
  return { createScreen: screens.create };
});

const agent = (id: string, data: Partial<GraphNode['data']> = {}): GraphNode => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: id, ...data },
});

/** Lets IPC replies (promises) settle. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

beforeEach(() => {
  fakeScreens.made.length = 0;
});

/** The editor, with Terminal agent `a` (with `queue`) opened in its view, and main faked. */
async function open({
  start,
  queue,
}: { start?: () => Promise<null>; queue?: GraphNode['data']['queue'] } = {}) {
  const sessions = fakeBackend();
  if (start) sessions.backend.start.mockImplementation(start);
  const terminals = fakeTerminals();
  const graph: Graph = {
    nodes: [agent('a', { connection: 'terminal', ...(queue ? { queue } : {}) })],
    edges: [],
  };
  const { container } = render(
    <GraphEditor
      initialGraph={graph}
      sessionBackend={sessions.backend}
      terminalBackend={terminals.backend}
    />,
  );
  const card = () => {
    const element = container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
    if (!element) throw new Error('no agent');
    return element;
  };
  fireEvent.doubleClick(card());
  await settle();
  const view = within(screen.getByRole('dialog', { name: 'a' }));
  return {
    sessions,
    terminals,
    card,
    view,
    /** Main says `events` happened in a's session. */
    session: (...events: SessionEvent[]) => {
      act(() => {
        sessions.emit('a', 'terminal', ...events);
      });
    },
    /** Main shows `events` in a's terminal. */
    show: (...events: TerminalEvent[]) => {
      act(() => {
        terminals.emit('a', ...events);
      });
    },
  };
}

const SCREEN = { type: 'screen', data: 'Claude Code\r\n❯ ', cols: 100, rows: 30 } as const;

describe('a Terminal agent', () => {
  it('shows Claude Code’s own terminal in place of the transcript and composer', async () => {
    const { sessions, terminals, view, show } = await open();
    expect(view.queryByRole('log', { name: 'Transcript' })).toBeNull();
    expect(view.queryByRole('textbox', { name: 'Message a' })).toBeNull();
    expect(view.getByText('Starting Claude Code…')).toBeTruthy();
    // Its session starts as its view opens, and the view shows its terminal.
    expect(sessions.backend.start).toHaveBeenCalledWith('a', {
      connection: 'terminal',
      model: null,
      mode: 'manual',
    });
    expect(terminals.backend.attach).toHaveBeenCalledWith('a');

    show(SCREEN);
    const terminal = fakeScreens.latest();
    act(() => {
      terminal.finish();
    });
    expect(view.queryByText('Starting Claude Code…')).toBeNull();
    expect(terminal.shown).toBe('Claude Code\r\n❯ ');
    expect(terminal.focused).toBe(true);

    // What the user types goes to Claude Code.
    terminal.type('/model\r');
    expect(terminals.backend.write).toHaveBeenCalledWith('a', '/model\r');
    show({ type: 'output', data: 'Select model' });
    expect(terminal.shown).toContain('Select model');
  });

  it('shows what the session does, as corrallm follows it, there and on the canvas', async () => {
    const { card, view, session, sessions } = await open();
    const status = () => view.getByText(/^(Idle|Working|Needs you, in the terminal)$/);
    expect(status().textContent).toBe('Idle');
    // The user typed a prompt in the terminal; then Claude Code asks for permission.
    session(
      { type: 'status', status: 'working' },
      { type: 'user', id: 'typed', text: 'Fix the tests' },
    );
    expect(status().textContent).toBe('Working');
    expect(card().classList.contains('working')).toBe(true);
    session({ type: 'status', status: 'waiting' });
    expect(status().textContent).toBe('Needs you, in the terminal');
    expect(card().classList.contains('asking')).toBe(true);
    session({ type: 'end', messages: ['typed'], seconds: 3, interrupted: false, failed: false });
    expect(status().textContent).toBe('Idle');
    expect(card().classList.contains('working')).toBe(false);
    // The queue's current chat is what was typed.
    expect(view.getByRole('group', { name: 'Current chat: Fix the tests' })).toBeTruthy();
    expect(sessions.backend.send).not.toHaveBeenCalled();
  });

  it('says why Claude Code cannot run, and tries again', async () => {
    let fail = true;
    const { sessions, view } = await open({
      start: () =>
        fail
          ? Promise.reject(new Error('Choose a project folder for this canvas first.'))
          : Promise.resolve(null),
    });
    expect(view.getByText('Claude Code isn’t running.')).toBeTruthy();
    expect(view.getByText('Choose a project folder for this canvas first.')).toBeTruthy();
    fail = false;
    fireEvent.click(view.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(sessions.backend.start).toHaveBeenCalledTimes(2);
  });

  it('says when Claude Code exited, and starts it again, resuming its session', async () => {
    const { sessions, view, session, show } = await open();
    show(SCREEN);
    act(() => {
      fakeScreens.latest().finish();
    });
    show({ type: 'exit', code: 0 });
    session({ type: 'closed' });
    expect(view.getByText('Claude Code exited.')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Start it again' }));
    await settle();
    expect(sessions.backend.start).toHaveBeenCalledTimes(2);
    // Its new run's screen replaces the last.
    show({ ...SCREEN, data: 'Resumed' });
    act(() => {
      fakeScreens.latest().finish();
    });
    expect(fakeScreens.latest().shown).toBe('Resumed');
    expect(view.queryByText('Claude Code exited.')).toBeNull();
  });

  it('types the queue’s messages in once Claude Code is done; queued ones wait in its bar', async () => {
    const { view, session, sessions } = await open({
      queue: [{ id: 'q1', message: 'Write the docs' }],
    });
    // The user is at work in the terminal when the queues' run sends the message: it waits.
    session(
      { type: 'status', status: 'working' },
      { type: 'user', id: 'typed', text: 'Fix the tests' },
    );
    fireEvent.click(view.getByRole('button', { name: 'All queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    fireEvent.click(queues.getByRole('button', { name: 'Run' }));
    fireEvent.click(queues.getByRole('button', { name: 'Open a' }));
    await settle();
    const queued = within(view.getByRole('list', { name: 'Queued messages' }));
    expect(queued.getByText('Write the docs')).toBeTruthy();
    expect(sessions.backend.send).not.toHaveBeenCalled();

    // The user's turn ends: the message goes to Claude Code (main types it in).
    session({ type: 'end', messages: ['typed'], seconds: 3, interrupted: false, failed: false });
    await settle();
    expect(sessions.backend.send).toHaveBeenCalledWith('a', {
      id: expect.any(String) as unknown,
      text: 'Write the docs',
    });
    expect(view.queryByRole('list', { name: 'Queued messages' })).toBeNull();
  });

  it('asks for your OK in the bar under its terminal: Approve, Stop here, or changes typed in', async () => {
    const { view, session, sessions } = await open({
      queue: [
        { id: 'ok', approve: 'the spec in SPEC.md' },
        { id: 'next', action: 'Read' },
      ],
    });
    fireEvent.click(view.getByRole('button', { name: 'All queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    fireEvent.click(queues.getByRole('button', { name: 'Run' }));
    fireEvent.click(queues.getByRole('button', { name: 'Open a' }));
    await settle();
    const side = within(view.getByRole('complementary', { name: 'Questions and queue' }));
    const row = () =>
      side
        .getByRole('button', { name: 'Move Your OK on the spec in SPEC.md' })
        .closest<HTMLElement>('[data-run]');
    const terminalSession = within(view.getByRole('region', { name: 'Session' }));
    const bar = () => terminalSession.queryByRole('group', { name: 'Needs you' });
    const asks = () => within(bar() ?? document.body);

    // No composer to write in: the bar has its own box for the changes.
    expect(row()?.dataset.run).toBe('asking');
    expect(asks().getByText('Waits for your OK on the spec in SPEC.md:')).toBeTruthy();
    expect(
      asks()
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Approve', 'Stop here', 'Ask for changes']);
    const changes = asks().getByRole<HTMLInputElement>('textbox', { name: 'What should change?' });
    const ask = asks().getByRole<HTMLButtonElement>('button', { name: 'Ask for changes' });
    expect(ask.disabled).toBe(true);

    // The changes go to Claude Code as a message: main types them into the terminal.
    fireEvent.change(changes, { target: { value: 'Cover the empty state too' } });
    fireEvent.click(ask);
    await settle();
    expect(sessions.backend.send).toHaveBeenCalledWith('a', {
      id: expect.any(String) as unknown,
      text: 'Cover the empty state too',
    });
    expect(row()?.dataset.run).toBe('running');
    expect(bar()).toBeNull();

    // Once that turn ends, it asks again.
    const sent = sessions.sent();
    session(
      { type: 'user', id: sent, text: 'Cover the empty state too' },
      { type: 'status', status: 'working' },
      { type: 'end', messages: [sent], seconds: 5, interrupted: false, failed: false },
    );
    expect(row()?.dataset.run).toBe('asking');
    fireEvent.click(asks().getByRole('button', { name: 'Approve' }));
    expect(row()?.dataset.run).toBe('succeeded');
    expect(bar()).toBeNull();
  });

  it('asks in its bar when a repeat is out of rounds, where what to try next is typed in', async () => {
    const { view, sessions } = await open({
      queue: [
        {
          id: 'loop',
          // An empty message is skipped: no round ends with its last step succeeding.
          repeat: [{ id: 'note', message: '' }],
          until: { kind: 'succeeded' },
          rounds: 1,
          otherwise: 'ask',
        },
      ],
    });
    fireEvent.click(view.getByRole('button', { name: 'All queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    fireEvent.click(queues.getByRole('button', { name: 'Run' }));
    fireEvent.click(queues.getByRole('button', { name: 'Open a' }));
    await settle();
    const asks = within(view.getByRole('group', { name: 'Needs you' }));
    expect(asks.getByText('1 round done, and still not: its last step succeeds.')).toBeTruthy();
    expect(asks.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'One more round',
      'Go on',
      'Try this',
    ]);
    const next = asks.getByRole('textbox', { name: 'What should it try next?' });
    fireEvent.change(next, { target: { value: 'Try a smaller fix' } });
    fireEvent.keyDown(next, { key: 'Enter' });
    await settle();
    expect(sessions.backend.send).toHaveBeenCalledWith('a', {
      id: expect.any(String) as unknown,
      text: 'Try a smaller fix',
    });
  });

  it('lets its terminal go when the view closes, and shows it again when it opens', async () => {
    const { terminals, view, card } = await open();
    const first = fakeScreens.latest();
    fireEvent.click(view.getByRole('button', { name: 'Back to the canvas' }));
    await settle();
    expect(terminals.backend.detach).toHaveBeenCalledWith('a');
    expect(first.disposed).toBe(true);
    fireEvent.doubleClick(card());
    await settle();
    expect(terminals.backend.attach).toHaveBeenCalledTimes(2);
    expect(fakeScreens.latest()).not.toBe(first);
  });
});
