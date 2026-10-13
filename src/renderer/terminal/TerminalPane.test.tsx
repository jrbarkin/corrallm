import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionEvent } from '../../shared/session';
import type { TerminalEvent } from '../../shared/terminal';
import { GraphEditor } from '../graph/GraphEditor';
import type { Graph, GraphNode } from '../graph/graph';
import { OpenLinkContext } from '../open-link';
import { fakeBackend } from '../test-backend';
import { fakeScreens, fakeTerminals, keyboardLayout, macKeyboard } from './test-screen';

// jsdom cannot draw xterm.js: a fake terminal stands in (test-screen.ts).
vi.mock('./screen', async () => {
  const { fakeScreens: screens } = await import('./test-screen');
  return { createScreen: screens.create };
});

/** What the run asks at the end of a tool's step: how it went (run/turns.ts). */
const VERDICT =
  ' End your reply with SUCCEEDED or FAILED on a line of its own: whether the step succeeded (a command: whether it exited with status 0; tests: whether they all passed), even if you expected it to fail.';

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

/**
 * The editor, with Terminal agent `a` (with `queue`; a Claude agent, unless `data` says otherwise)
 * opened in its view, and main faked.
 */
async function open({
  start,
  queue,
  data = { connection: 'terminal' },
}: {
  start?: () => Promise<null>;
  queue?: GraphNode['data']['queue'];
  data?: Partial<GraphNode['data']> & { connection: 'terminal' | 'codex-terminal' };
} = {}) {
  const sessions = fakeBackend();
  if (start) sessions.backend.start.mockImplementation(start);
  const terminals = fakeTerminals();
  const graph: Graph = {
    nodes: [agent('a', { ...data, ...(queue ? { queue } : {}) })],
    edges: [],
  };
  const openLink = vi.fn<(url: string) => void>();
  const { container } = render(
    <OpenLinkContext.Provider value={openLink}>
      <GraphEditor
        initialGraph={graph}
        sessionBackend={sessions.backend}
        terminalBackend={terminals.backend}
      />
    </OpenLinkContext.Provider>,
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
    openLink,
    card,
    view,
    /** Main says `events` happened in a's session. */
    session: (...events: SessionEvent[]) => {
      act(() => {
        sessions.emit('a', data.connection, ...events);
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
      mode: null,
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

  it('opens a link Cmd-clicked in the terminal through main, which asks first', async () => {
    const { openLink, show } = await open();
    show(SCREEN);
    fakeScreens.latest().openLink('https://docs.example.com/hooks');
    expect(openLink).toHaveBeenCalledExactlyOnceWith('https://docs.example.com/hooks');
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

  it('lists what Claude Code asks in its terminal in the Needs you sidebar, to answer there', async () => {
    const { view, session } = await open();
    session(
      { type: 'status', status: 'working' },
      { type: 'user', id: 'typed', text: 'Set up the repo' },
      {
        type: 'asking',
        asks: [
          { kind: 'permission', id: 'p', tool: 'Bash', summary: 'git init' },
          {
            kind: 'question',
            id: 'q',
            questions: [
              {
                header: 'Color',
                text: 'Pick a color',
                options: [
                  { label: 'Red', description: 'Warm' },
                  { label: 'Blue', description: 'Cool' },
                ],
                multiple: false,
              },
            ],
          },
          { kind: 'plan', id: 'plan', plan: '## Set up\nRun `git init`.' },
          { kind: 'other', id: 'o', text: 'answer: Which region?' },
        ],
      },
      { type: 'status', status: 'waiting' },
    );
    fireEvent.click(view.getByRole('button', { name: 'Back to the canvas' }));
    await settle();
    const sidebar = within(screen.getByRole('complementary', { name: 'Needs you' }));
    expect(sidebar.getByRole('heading', { level: 2 }).textContent).toBe('Needs you 4');
    const cards = sidebar.getAllByRole('group', { name: 'a asks, in its terminal' });
    expect(cards.map((card) => card.textContent)).toEqual([
      'aBashgit initDo you want to proceed?Answer it in the terminal.Open terminal',
      'aColorPick a colorRedWarmBlueCoolAnswer it in the terminal.Open terminal',
      'aPlanReady to code? Here is the plan:Set upRun git init.Answer it in the terminal.Open terminal',
      'aanswer: Which region?Answer it in the terminal.Open terminal',
    ]);
    // Never answered here: nothing to type in, no answers to pick.
    expect(sidebar.queryByRole('textbox')).toBeNull();
    expect(new Set(sidebar.getAllByRole('button').map((button) => button.textContent))).toEqual(
      new Set(['a', 'Open terminal']),
    );

    // Open terminal: the agent's view, where the user answers it.
    fireEvent.click(
      within(cards[0] ?? document.body).getByRole('button', { name: 'Open terminal' }),
    );
    await settle();
    expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();
    // Answered there: nothing is listed any more.
    session({ type: 'asking', asks: [] }, { type: 'status', status: 'working' });
    expect(screen.queryByRole('complementary', { name: 'Needs you' })).toBeNull();
  });

  it('needs the user while Claude Code asks whether to trust the folder: in its bar, on its card and in Needs you', async () => {
    const { card, view, session } = await open();
    // Started fresh, no turn going on: its folder trust dialog, whose default is "No, exit".
    session(
      { type: 'started', model: null, mode: 'manual', models: [] },
      { type: 'asking', asks: [{ kind: 'trust', id: 't' }] },
    );
    /** What its bar says the session is doing. */
    const status = () =>
      screen.getByRole('dialog', { name: 'a' }).querySelector('.agent-terminal-status');
    expect(status()?.textContent).toBe('Trust this folder in the terminal');
    expect(status()?.getAttribute('data-status')).toBe('waiting');
    expect(card().classList.contains('asking')).toBe(true);
    fireEvent.click(view.getByRole('button', { name: 'Back to the canvas' }));
    await settle();
    const sidebar = within(screen.getByRole('complementary', { name: 'Needs you' }));
    const asked = sidebar.getByRole('group', { name: 'a asks, in its terminal' });
    expect(asked.textContent).toBe(
      'aClaude Code asks whether you trust this folder before it works in it.Trust this folder in the terminal.Open terminal',
    );
    fireEvent.click(within(asked).getByRole('button', { name: 'Open terminal' }));
    await settle();
    // Trusted there: it no longer needs the user.
    session({ type: 'asking', asks: [] });
    expect(status()?.textContent).toBe('Idle');
    expect(card().classList.contains('asking')).toBe(false);
  });

  it('shows Codex’s own terminal for a Codex agent, and follows its turns there and on the canvas', async () => {
    const { sessions, terminals, card, view, session } = await open({
      data: { agent: 'Codex', connection: 'codex-terminal' },
    });
    expect(view.getByText('Starting Codex CLI…')).toBeTruthy();
    // Nothing chosen: main starts it as it was given before, else in Codex's own default mode.
    expect(sessions.backend.start).toHaveBeenCalledWith('a', {
      connection: 'codex-terminal',
      model: null,
      mode: null,
    });
    expect(terminals.backend.attach).toHaveBeenCalledWith('a');
    const status = () => view.getByText(/^(Idle|Working|Needs you, in the terminal)$/);
    session(
      { type: 'status', status: 'working' },
      { type: 'user', id: 'typed', text: 'Fix the tests' },
    );
    expect(card().classList.contains('working')).toBe(true);
    session(
      {
        type: 'asking',
        asks: [{ kind: 'other', id: 'w', text: 'Codex needs you: see its terminal.' }],
      },
      { type: 'status', status: 'waiting' },
    );
    expect(status().textContent).toBe('Needs you, in the terminal');
    expect(card().classList.contains('asking')).toBe(true);
    // Listed in Needs you, as a Claude agent's terminal asks are, to answer there.
    const sidebar = within(screen.getByRole('complementary', { name: 'Needs you' }));
    expect(sidebar.getByRole('group', { name: 'a asks, in its terminal' }).textContent).toContain(
      'Codex needs you: see its terminal.',
    );
    session({ type: 'asking', asks: [] });
    session({ type: 'end', messages: ['typed'], seconds: 2, interrupted: false, failed: false });
    expect(status().textContent).toBe('Idle');
    expect(card().classList.contains('working')).toBe(false);
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

  it('pastes files dropped on its terminal: main reads their paths', async () => {
    const { terminals, view, show } = await open();
    const terminal = view.getByRole('region', { name: 'Session' }).querySelector('.agent-terminal');
    if (!terminal) throw new Error('no terminal');
    const shot = new File(['png'], 'Screen Shot.png', { type: 'image/png' });
    const dragged = { dataTransfer: { types: ['Files'], files: [shot], dropEffect: 'none' } };
    // Not before Claude Code runs in it.
    fireEvent.drop(terminal, dragged);
    expect(terminals.backend.drop).not.toHaveBeenCalled();

    show(SCREEN);
    act(() => {
      fakeScreens.latest().finish();
    });
    fireEvent.dragOver(terminal, dragged);
    expect(terminal.hasAttribute('data-dragging')).toBe(true);
    fireEvent.drop(terminal, dragged);
    expect(terminal.hasAttribute('data-dragging')).toBe(false);
    expect(terminals.backend.drop).toHaveBeenCalledWith('a', [shot]);
  });

  it('fits a new screen to the view and draws it afresh when Claude Code starts again', async () => {
    const { terminals, view, session, show } = await open();
    const terminal = fakeScreens.latest();
    terminal.fits = { cols: 140, rows: 40 };
    show(SCREEN);
    act(() => {
      terminal.finish();
    });
    expect(terminal.size).toEqual({ cols: 140, rows: 40 });
    expect(terminal.redraws).toBe(1);
    show({ type: 'exit', code: 0 });
    session({ type: 'closed' });
    fireEvent.click(view.getByRole('button', { name: 'Start it again' }));
    await settle();
    terminals.backend.resize.mockClear();
    // The new CLI's screen comes at main's size: the view takes it, then its own again.
    show({ ...SCREEN, data: 'Started again' });
    expect(terminal.size).toEqual({ cols: 100, rows: 30 });
    act(() => {
      terminal.finish();
    });
    expect(terminal.size).toEqual({ cols: 140, rows: 40 });
    expect(terminals.backend.resize).toHaveBeenLastCalledWith('a', 140, 40);
    // Drawn afresh at that size, not as the renderer last drew it.
    expect(terminal.redraws).toBe(2);
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

  it('runs its queue’s steps and conditions in Claude Code, saying in its bar when an answer was unclear', async () => {
    const { view, session, sessions } = await open({
      queue: [
        { id: 'tests', action: 'Bash' },
        {
          id: 'green',
          if: { kind: 'outputContains', text: '0 failed' },
          then: [{ id: 'tag', message: 'Tag it' }],
        },
        { id: 'flaky', if: { kind: 'freeText', text: 'a test is flaky' }, then: [] },
      ],
    });
    fireEvent.click(view.getByRole('button', { name: 'All queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    fireEvent.click(queues.getByRole('button', { name: 'Run' }));
    fireEvent.click(queues.getByRole('button', { name: 'Open a' }));
    await settle();
    /** Main types the last message in, and Claude Code answers it (its Stop hook's last reply). */
    const answer = async (text: string, reply: string) => {
      const sent = sessions.sent();
      expect(sessions.backend.send).toHaveBeenLastCalledWith('a', { id: sent, text });
      session(
        { type: 'user', id: sent, text },
        { type: 'status', status: 'working' },
        { type: 'text', id: `${sent}/reply`, text: reply },
        { type: 'end', messages: [sent], seconds: 4, interrupted: false, failed: false },
      );
      await settle();
    };
    await answer(
      'Use the Bash tool for this step (run shell commands).' + VERDICT,
      'Ran them: 0 failed.\nSUCCEEDED',
    );
    await answer('Tag it', 'Tagged v1.2.');
    await answer(
      'corrallm asks: is this true now? “a test is flaky” Start your answer with yes or no.',
      'Hard to say.',
    );
    const terminalSession = within(view.getByRole('region', { name: 'Session' }));
    const warning = terminalSession.getByRole('note');
    expect(warning.textContent).toBe(
      'corrallm took that as no: the answer wasn’t a clear yes or no.',
    );
    fireEvent.click(within(warning).getByRole('button', { name: 'Dismiss' }));
    expect(terminalSession.queryByRole('note')).toBeNull();
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

describe('the Option key in a Terminal agent’s terminal', () => {
  let undo: (() => void) | undefined;
  afterEach(() => {
    undo?.();
    undo = undefined;
    localStorage.clear();
  });

  it('types characters on a German Mac, until the user makes it Meta: from then on', async () => {
    undo = macKeyboard(keyboardLayout({ KeyY: 'z', KeyZ: 'y', Minus: 'ß', Semicolon: 'ö' }));
    const { view, card } = await open();
    const option = view.getByRole('button', { name: 'Option as Meta' });
    expect(option.getAttribute('aria-pressed')).toBe('false');
    expect(fakeScreens.latest().optionIsMeta).toBe(false);

    fireEvent.click(option);
    expect(option.getAttribute('aria-pressed')).toBe('true');
    expect(fakeScreens.latest().optionIsMeta).toBe(true);
    // Kept for the user: the next terminal shown starts with it.
    fireEvent.click(view.getByRole('button', { name: 'Back to the canvas' }));
    await settle();
    fireEvent.doubleClick(card());
    await settle();
    expect(fakeScreens.made).toHaveLength(2);
    expect(fakeScreens.latest().optionIsMeta).toBe(true);
  });

  it('works as Meta on a US Mac, for Claude Code’s Option shortcuts', async () => {
    undo = macKeyboard(keyboardLayout());
    const { view } = await open();
    expect(view.getByRole('button', { name: 'Option as Meta' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(fakeScreens.latest().optionIsMeta).toBe(true);
  });

  it('is no choice off a Mac, where Alt is Meta anyway', async () => {
    const { view } = await open();
    expect(view.queryByRole('button', { name: 'Option as Meta' })).toBeNull();
  });
});
