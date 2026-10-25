import { renderReady, events } from '../test-render';
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionEvent, SettingsOptions, TerminalAsk } from '../../shared/session';
import type { TerminalEvent } from '../../shared/terminal';
import { catalog } from '../catalog';
import { fromFile } from '../../shared/model/file';
import { GraphEditor } from '../test-graph';
import type { FakeCanvas } from '../test-canvas';
import type { Graph, GraphNode } from '../graph/flow';
import { OpenLinkContext } from '../open-link';
import { fakeBackend } from '../../shared/engine/test-backend';
import { fakeScreens, fakeTerminals, keyboardLayout, macKeyboard } from './test-screen';
import { graphOf } from '../test-graph-data';
import { DEFAULT_AGENT } from '../graph/agents';
import * as motion from '../agent/motion';

// jsdom cannot draw xterm.js: a fake terminal stands in (test-screen.ts).
vi.mock('./screen', async () => {
  const { fakeScreens: screens } = await import('./test-screen');
  return { createScreen: screens.create };
});

/** What the run asks at the end of a tool's step: how it went (src/shared/engine/run/turns.ts). */
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
  data = { connection: 'claude-code.terminal' },
  options,
}: {
  start?: () => Promise<null>;
  queue?: GraphNode['data']['queue'];
  data?: Partial<GraphNode['data']> & { connection: 'claude-code.terminal' | 'codex.terminal' };
  /** What main reads of what its CLI's agents can be set to, or why it could not. */
  options?: SettingsOptions | Error;
} = {}) {
  /** The fake core the editor runs on: what it saved, as each .corral file's text. */
  let core: FakeCanvas | undefined;
  const sessions = fakeBackend();
  if (start) sessions.backend.start.mockImplementation(start);
  if (options instanceof Error) sessions.backend.options.mockRejectedValue(options);
  else if (options) sessions.backend.options.mockResolvedValue(options);
  const terminals = fakeTerminals();
  const graph: Graph = {
    nodes: [agent('a', { ...data, ...(queue ? { queue } : {}) })],
    edges: [],
  };
  const openLink = vi.fn<(url: string) => void>();
  const { container } = await renderReady(
    <OpenLinkContext.Provider value={openLink}>
      <GraphEditor
        initialGraph={graph}
        files
        onCanvas={(made) => {
          core = made;
        }}
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
  await events.doubleClick(card());
  await settle();
  const view = within(screen.getByRole('dialog', { name: 'a' }));
  return {
    sessions,
    terminals,
    saved: () => core?.files.saved ?? [],
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
  it.each(['finished', 'cancelled'] as const)(
    'keeps its terminal when Needs reopens it before Back’s animation has %s',
    async (outcome) => {
      const closings: {
        done: ReturnType<typeof Promise.withResolvers<Animation>>;
        cancel: ReturnType<typeof vi.fn>;
      }[] = [];
      const morph = vi.spyOn(motion, 'morph').mockImplementation((_element, _small, direction) => {
        if (direction !== 'close') return undefined;
        const closing = { done: Promise.withResolvers<Animation>(), cancel: vi.fn() };
        closings.push(closing);
        return { finished: closing.done.promise, cancel: closing.cancel } as unknown as Animation;
      });
      const animate = vi.spyOn(motion, 'animate').mockReturnValue(undefined);
      try {
        const { view, show, session, sessions, terminals } = await open();
        show(SCREEN);
        const terminal = fakeScreens.latest();
        act(() => {
          terminal.finish();
        });
        const element = view.getByLabelText('Claude Code’s terminal');
        for (const asks of [
          [{ kind: 'permission', id: 'p', tool: 'Bash', summary: 'echo hello' }],
          [
            {
              kind: 'question',
              id: 'q',
              questions: [
                {
                  header: 'Database',
                  text: 'Which database?',
                  options: [{ label: 'SQLite', description: 'One file, for tests' }],
                  multiple: false,
                },
              ],
            },
          ],
        ] satisfies TerminalAsk[][]) {
          session({ type: 'asking', asks }, { type: 'status', status: 'waiting' });
          await events.click(view.getByRole('button', { name: 'Back to the canvas' }));
          const closing = closings.at(-1);
          expect(closing).toBeDefined();
          await events.click(screen.getByRole('button', { name: 'Needs you' }));
          const needs = within(screen.getByRole('complementary', { name: 'Needs you' }));
          await events.click(needs.getByRole('button', { name: 'Open terminal' }));
          await act(() => {
            if (outcome === 'finished') closing?.done.resolve({} as Animation);
            else closing?.done.reject(new Error('Animation cancelled'));
            return Promise.resolve();
          });
          // The old completion cannot close this opening or replace its terminal.
          expect(screen.queryByRole('dialog', { name: 'a' })).not.toBeNull();
          expect(view.getByLabelText('Claude Code’s terminal')).toBe(element);
          expect(closing?.cancel).toHaveBeenCalledOnce();
          expect(terminal.disposed).toBe(false);
          session(
            { type: 'asking', asks: [] },
            {
              type: 'end',
              messages: [],
              seconds: 0,
              result: { status: 'completed', reason: 'completed' },
            },
          );
        }
        expect(closings).toHaveLength(2);
        expect(morph.mock.calls.filter((call) => call[2] === 'open')).toHaveLength(3);
        expect(terminals.backend.attach).toHaveBeenCalledOnce();
        expect(terminals.backend.detach).not.toHaveBeenCalled();
        expect(sessions.backend.start).toHaveBeenCalledOnce();
      } finally {
        morph.mockRestore();
        animate.mockRestore();
      }
    },
  );

  it('keeps the agent picker focused when a late terminal screen arrives, so Escape only closes the picker', async () => {
    const { view, show } = await open();
    const terminal = fakeScreens.latest();
    // xterm focuses a real element; model its focus (and the picker's blur) in jsdom too.
    const focus = vi.spyOn(terminal, 'focus').mockImplementation(() => {
      terminal.element.tabIndex = -1;
      terminal.element.focus();
    });
    try {
      await events.click(view.getByRole('button', { name: /^Agent:/ }));
      const picker = view.getByRole('combobox', { name: 'Agent' });
      expect(document.activeElement).toBe(picker);
      const element = view.getByLabelText('Claude Code’s terminal');
      show(SCREEN);
      act(() => {
        terminal.finish();
      });
      expect(document.activeElement).toBe(picker);
      await events.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      expect(view.queryByRole('combobox', { name: 'Agent' })).toBeNull();
      expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();
      expect(view.getByLabelText('Claude Code’s terminal')).toBe(element);
      expect(terminal.disposed).toBe(false);
    } finally {
      focus.mockRestore();
    }
  });

  it('shows Claude Code’s own terminal in place of the transcript and composer', async () => {
    const { sessions, terminals, view, show } = await open();
    expect(view.queryByRole('log', { name: 'Transcript' })).toBeNull();
    expect(view.queryByRole('textbox', { name: 'Message a' })).toBeNull();
    expect(view.getByText('Starting Claude Code…')).toBeTruthy();
    // Its session starts as its view opens, and the view shows its terminal.
    expect(sessions.backend.start).toHaveBeenCalledWith('a', {
      connection: 'claude-code.terminal',
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
    session({
      type: 'end',
      messages: ['typed'],
      seconds: 3,
      result: { status: 'completed', reason: 'completed' },
    });
    expect(status().textContent).toBe('Idle');
    expect(card().classList.contains('working')).toBe(false);
    // The native prompt is observed once as a read-only completed message.
    const sidebar = view.getByRole('complementary', { name: 'Questions and queue' });
    const rows = sidebar.querySelectorAll<HTMLElement>('[data-submission]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector('.graph-queue-submission-text')?.textContent).toBe(
      'Fix the tests',
    );
    expect(rows[0]?.dataset.run).toBe('completed');
    expect(rows[0]?.querySelector('button, input, textarea')).toBeNull();
    expect(view.queryByRole('group', { name: /^Current chat/ })).toBeNull();
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
    await events.click(view.getByRole('button', { name: 'Back to the canvas' }));
    await settle();
    await events.click(screen.getByRole('button', { name: 'Needs you' }));
    const sidebar = within(screen.getByRole('complementary', { name: 'Needs you' }));
    expect(sidebar.getByRole('heading', { level: 2 }).textContent).toBe('Needs you 4');
    const cards = sidebar.getAllByRole('group', { name: 'a asks, in its terminal' });
    expect(cards.map((card) => card.textContent)).toEqual([
      'Session promptaApprove Bash: git init?Answer it in the terminal.Open terminal',
      'Session promptaPick a colorColorPick a colorRedWarmBlueCoolAnswer it in the terminal.Open terminal',
      'Session promptaApprove its plan?## Set up\nRun `git init`.Answer it in the terminal.Open terminal',
      'Session promptaanswer: Which region?Answer it in the terminal.Open terminal',
    ]);
    // Never answered here: nothing to type in, no answers to pick.
    expect(sidebar.queryByRole('textbox')).toBeNull();
    expect(new Set(sidebar.getAllByRole('button').map((button) => button.textContent))).toEqual(
      new Set(['a', 'Open terminal']),
    );

    // Open terminal: the agent's view, where the user answers it.
    await events.click(
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
    await events.click(view.getByRole('button', { name: 'Back to the canvas' }));
    await settle();
    await events.click(screen.getByRole('button', { name: 'Needs you' }));
    const sidebar = within(screen.getByRole('complementary', { name: 'Needs you' }));
    const asked = sidebar.getByRole('group', { name: 'a asks, in its terminal' });
    expect(asked.textContent).toBe(
      'Session promptaTrust the project folder?Answer it in the terminal.Open terminal',
    );
    await events.click(within(asked).getByRole('button', { name: 'Open terminal' }));
    await settle();
    // Trusted there: it no longer needs the user.
    session({ type: 'asking', asks: [] });
    expect(status()?.textContent).toBe('Idle');
    expect(card().classList.contains('asking')).toBe(false);
  });

  it('lists a permission with what it is for, as Claude Code’s prompt shows it', async () => {
    const { view, session } = await open();
    session(
      { type: 'status', status: 'working' },
      { type: 'user', id: 'typed', text: 'Greet the world' },
      {
        type: 'asking',
        asks: [
          {
            kind: 'permission',
            id: 'edit',
            tool: 'Edit',
            summary: 'notes.txt',
            detail: {
              kind: 'diff',
              added: 1,
              removed: 1,
              lines: [
                { kind: 'remove', text: 'hello' },
                { kind: 'add', text: 'hello world' },
              ],
            },
          },
          {
            kind: 'permission',
            id: 'bash',
            tool: 'Bash',
            summary: 'git add -A …',
            detail: { kind: 'output', text: 'git add -A\ngit commit -m "Greet"' },
          },
        ],
      },
      { type: 'status', status: 'waiting' },
    );
    await events.click(view.getByRole('button', { name: 'Back to the canvas' }));
    await settle();
    await events.click(screen.getByRole('button', { name: 'Needs you' }));
    const sidebar = within(screen.getByRole('complementary', { name: 'Needs you' }));
    const cards = sidebar.getAllByRole('group', { name: 'a asks, in its terminal' });
    expect(cards.map((card) => card.textContent)).toEqual([
      'Session promptaApprove Edit: notes.txt?- hello\n+ hello world\n' +
        'Answer it in the terminal.Open terminal',
      'Session promptaApprove Bash: git add -A …?git add -A\ngit commit -m "Greet"' +
        'Answer it in the terminal.Open terminal',
    ]);
    const [edit] = cards;
    const removed = edit?.querySelector('[data-line="remove"]');
    expect(removed?.textContent).toBe('- hello\n');
  });

  it('shows Codex’s own terminal for a Codex agent, and follows its turns there and on the canvas', async () => {
    const { sessions, terminals, card, view, session } = await open({
      data: { adapter: 'codex', connection: 'codex.terminal' },
    });
    expect(view.getByText('Starting Codex CLI…')).toBeTruthy();
    // Nothing set: the user's own defaults (Codex's Default mode, which leaves their own config).
    expect(sessions.backend.start).toHaveBeenCalledWith('a', {
      connection: 'codex.terminal',
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
    await events.click(screen.getByRole('button', { name: 'Needs you' }));
    const sidebar = within(screen.getByRole('complementary', { name: 'Needs you' }));
    expect(sidebar.getByRole('group', { name: 'a asks, in its terminal' }).textContent).toContain(
      'Codex needs you: see its terminal.',
    );
    session({ type: 'asking', asks: [] });
    session({
      type: 'end',
      messages: ['typed'],
      seconds: 2,
      result: { status: 'completed', reason: 'completed' },
    });
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
    await events.click(view.getByRole('button', { name: 'Try again' }));
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
    await events.click(view.getByRole('button', { name: 'Start it again' }));
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
    await events.drop(terminal, dragged);
    expect(terminals.backend.drop).not.toHaveBeenCalled();

    show(SCREEN);
    act(() => {
      fakeScreens.latest().finish();
    });
    await events.dragOver(terminal, dragged);
    expect(terminal.hasAttribute('data-dragging')).toBe(true);
    await events.drop(terminal, dragged);
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
    await events.click(view.getByRole('button', { name: 'Start it again' }));
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
    await events.click(view.getByRole('button', { name: 'All queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    await events.click(queues.getByRole('button', { name: 'Run' }));
    await events.click(queues.getByRole('button', { name: 'Open a' }));
    await settle();
    const queued = within(view.getByRole('list', { name: 'Queued messages' }));
    expect(queued.getByText('Write the docs')).toBeTruthy();
    expect(sessions.backend.send).not.toHaveBeenCalled();

    // The user's turn ends: the message goes to Claude Code (main types it in).
    session({
      type: 'end',
      messages: ['typed'],
      seconds: 3,
      result: { status: 'completed', reason: 'completed' },
    });
    await settle();
    expect(sessions.backend.send).toHaveBeenCalledWith('a', {
      id: expect.any(String) as unknown,
      text: 'Write the docs',
      origin: 'queue',
      task: { agent: 'a', item: 'q1', attempt: expect.any(String) as string },
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
    await events.click(view.getByRole('button', { name: 'All queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    await events.click(queues.getByRole('button', { name: 'Run' }));
    await events.click(queues.getByRole('button', { name: 'Open a' }));
    await settle();
    /** Main types the last message in, and Claude Code answers it (its Stop hook's last reply). */
    const answer = async (item: string, text: string, reply: string) => {
      const sent = sessions.sent();
      expect(sessions.backend.send).toHaveBeenLastCalledWith('a', {
        id: sent,
        text,
        origin: 'queue',
        task: { agent: 'a', item, attempt: expect.any(String) as string },
      });
      session(
        { type: 'user', id: sent, text },
        { type: 'status', status: 'working' },
        { type: 'text', id: `${sent}/reply`, text: reply },
        {
          type: 'end',
          messages: [sent],
          seconds: 4,
          result: { status: 'completed', reason: 'completed' },
        },
      );
      await settle();
    };
    await answer(
      'tests',
      'Use the Bash tool for this step (run shell commands).' + VERDICT,
      'Ran them: 0 failed.\nSUCCEEDED',
    );
    await answer('tag', 'Tag it', 'Tagged v1.2.');
    await answer(
      'flaky',
      'corrallm asks: is this true now? “a test is flaky” Start your answer with yes or no.',
      'Hard to say.',
    );
    const terminalSession = within(view.getByRole('region', { name: 'Session' }));
    const needs = within(terminalSession.getByRole('group', { name: 'Needs you' }));
    expect(needs.getByText(/The answer did not clearly say yes or no/)).toBeTruthy();
    expect(sessions.backend.send).toHaveBeenCalledTimes(3);
    await events.click(needs.getByRole('button', { name: 'Condition does not hold' }));
    expect(terminalSession.queryByRole('group', { name: 'Needs you' })).toBeNull();
    expect(sessions.backend.send).toHaveBeenCalledTimes(3);
  });

  it('warns in its bar when its settings keep corrallm from hearing Claude Code, as the run does', async () => {
    const { view, session, sessions } = await open({
      queue: [
        { id: 'tests', action: 'Bash' },
        {
          id: 'green',
          if: { kind: 'outputContains', text: '0 failed' },
          then: [{ id: 'tag', message: 'Tag it' }],
        },
      ],
    });
    const unheard =
      'Claude Code’s settings turn off its hooks (disableAllHooks in ~/.claude/settings.json), so ' +
      'corrallm can’t hear this agent’s replies.';
    session(
      { type: 'started', model: null, mode: 'manual', models: [] },
      { type: 'unheard', text: unheard },
    );
    const terminalSession = within(view.getByRole('region', { name: 'Session' }));
    expect(terminalSession.getByRole('note').textContent).toBe(unheard);

    await events.click(view.getByRole('button', { name: 'All queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    await events.click(queues.getByRole('button', { name: 'Run' }));
    await events.click(queues.getByRole('button', { name: 'Open a' }));
    await settle();
    // Its turn ends (Claude Code's screen says so), with no reply heard.
    const sent = sessions.sent();
    session(
      { type: 'user', id: sent, text: 'Use the Bash tool for this step (run shell commands).' },
      { type: 'status', status: 'working' },
      {
        type: 'end',
        messages: [sent],
        seconds: 4,
        result: { status: 'completed', reason: 'completed' },
      },
    );
    await settle();
    expect(terminalSession.getByRole('note').textContent).toMatch(
      /^corrallm can’t read this agent’s replies \(its hooks are off\)/,
    );
    expect(sessions.backend.send).toHaveBeenCalledTimes(1);
  });

  it('asks for your OK in the bar under its terminal: Approve, Stop here, or changes typed in', async () => {
    const { view, session, sessions } = await open({
      queue: [
        { id: 'ok', approve: 'the spec in SPEC.md' },
        { id: 'next', action: 'Read' },
      ],
    });
    await events.click(view.getByRole('button', { name: 'All queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    await events.click(queues.getByRole('button', { name: 'Run' }));
    await events.click(queues.getByRole('button', { name: 'Open a' }));
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
    await events.change(changes, { target: { value: 'Cover the empty state too' } });
    await events.click(ask);
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
      {
        type: 'end',
        messages: [sent],
        seconds: 5,
        result: { status: 'completed', reason: 'completed' },
      },
    );
    expect(row()?.dataset.run).toBe('asking');
    await events.click(asks().getByRole('button', { name: 'Approve' }));
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
    await events.click(view.getByRole('button', { name: 'All queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    await events.click(queues.getByRole('button', { name: 'Run' }));
    await events.click(queues.getByRole('button', { name: 'Open a' }));
    await settle();
    const asks = within(view.getByRole('group', { name: 'Needs you' }));
    expect(asks.getByText('1 round done, and still not: its last step succeeds.')).toBeTruthy();
    expect(asks.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'One more round',
      'Go on',
      'Try this',
    ]);
    const next = asks.getByRole('textbox', { name: 'What should it try next?' });
    await events.change(next, { target: { value: 'Try a smaller fix' } });
    await events.keyDown(next, { key: 'Enter' });
    await settle();
    expect(sessions.backend.send).toHaveBeenCalledWith('a', {
      id: expect.any(String) as unknown,
      text: 'Try a smaller fix',
    });
  });

  it('lets its terminal go when the view closes, and shows it again when it opens', async () => {
    const { terminals, view, card } = await open();
    const first = fakeScreens.latest();
    await events.click(view.getByRole('button', { name: 'Back to the canvas' }));
    await settle();
    expect(terminals.backend.detach).toHaveBeenCalledWith('a');
    expect(first.disposed).toBe(true);
    await events.doubleClick(card());
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

    await events.click(option);
    expect(option.getAttribute('aria-pressed')).toBe('true');
    expect(fakeScreens.latest().optionIsMeta).toBe(true);
    // Kept for the user: the next terminal shown starts with it.
    await events.click(view.getByRole('button', { name: 'Back to the canvas' }));
    await settle();
    await events.doubleClick(card());
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

describe('a Terminal agent’s settings', () => {
  const EFFORTS = [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'xhigh', label: 'Extra high' },
  ];
  /** What main reads of Claude Code: its aliases, and the user's own defaults. */
  const CLAUDE = {
    models: [
      { value: 'opus', label: 'Opus', description: 'For complex work', efforts: EFFORTS },
      { value: 'haiku', label: 'Haiku', description: 'Fastest', efforts: EFFORTS.slice(0, 2) },
    ],
    defaults: { model: 'opus', effort: 'xhigh', mode: 'auto' as const },
  };
  /** The items of a menu, by label. */
  const items = (menu: HTMLElement) =>
    within(menu)
      .getAllByRole('menuitemradio')
      .map((item) => item.firstChild?.textContent);

  it('starts Claude Code with what it is set to, chosen beside its chip, the user’s own shown', async () => {
    const { sessions, saved, view } = await open({
      data: { connection: 'claude-code.terminal', settings: { 'claude-code': { model: 'haiku' } } },
      options: CLAUDE,
    });
    expect(sessions.backend.start).toHaveBeenCalledWith('a', {
      connection: 'claude-code.terminal',
      model: 'haiku',
      mode: null,
    });
    expect(sessions.backend.options).toHaveBeenCalledWith('claude-code', 'a');
    // What it starts with, the user's own where nothing is chosen.
    const button = () => view.getByRole('button', { name: 'Agent settings: a' });
    expect(button().textContent).toContain('Claude · Terminal · Haiku · Auto');
    await events.click(button());
    await settle();
    const panel = within(screen.getByRole('dialog', { name: 'Agent settings: a' }));
    expect(panel.getByRole('button', { name: 'Model: Haiku' })).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Mode: Default (Auto)' })).toBeTruthy();

    await events.click(panel.getByRole('button', { name: 'Model: Haiku' }));
    expect(items(panel.getByRole('menu', { name: 'Model' }))).toEqual([
      'Default (Opus)',
      'Opus',
      'Haiku',
    ]);
    await events.click(panel.getByRole('menuitemradio', { name: /^Default \(Opus\)/ }));
    // Back to the user's own: their effort shows too, as Opus has it.
    expect(button().textContent).toContain('Opus · Extra high · Auto');
    await events.click(panel.getByRole('button', { name: 'Effort: Default (Extra high)' }));
    await events.click(panel.getByRole('menuitemradio', { name: /^Low/ }));
    // Never a mode that never asks: that is chosen in its terminal, each time.
    await events.click(panel.getByRole('button', { name: 'Mode: Default (Auto)' }));
    expect(items(panel.getByRole('menu', { name: 'Mode' }))).toEqual([
      'Default (Auto)',
      'Manual',
      'Accept edits',
      'Plan',
      'Auto',
    ]);
    await events.click(panel.getByRole('menuitemradio', { name: /^Plan/ }));
    expect(button().textContent).toContain('Opus · Low · Plan');
    // Saved with the agent, in the canvas's file.
    await events.keyDown(document.body, { key: 's', ctrlKey: true });
    await waitFor(() => {
      expect(saved()).toHaveLength(1);
    });
    expect(
      graphOf(fromFile(saved().at(-1) ?? '', catalog(), DEFAULT_AGENT)).nodes[0]?.data.settings,
    ).toEqual({
      'claude-code': { effort: 'low', mode: 'plan' },
    });

    // Its session runs as it started: restarted, it starts with these, resuming its conversation.
    expect(sessions.backend.start).toHaveBeenCalledOnce();
    await events.click(panel.getByRole('button', { name: 'Restart with these' }));
    await settle();
    expect(sessions.backend.close).toHaveBeenCalledWith('a');
    expect(sessions.backend.start).toHaveBeenLastCalledWith('a', {
      connection: 'claude-code.terminal',
      model: null,
      mode: 'plan',
      effort: 'low',
    });
    expect(panel.queryByRole('button', { name: 'Restart with these' })).toBeNull();
  });

  it('drops an effort the model chosen does not have, and restarts only once it is done working', async () => {
    const { session, view } = await open({
      data: {
        connection: 'claude-code.terminal',
        settings: { 'claude-code': { effort: 'xhigh' } },
      },
      options: CLAUDE,
    });
    await events.click(view.getByRole('button', { name: 'Agent settings: a' }));
    await settle();
    const panel = within(screen.getByRole('dialog', { name: 'Agent settings: a' }));
    await events.click(panel.getByRole('button', { name: 'Model: Default (Opus)' }));
    await events.click(panel.getByRole('menuitemradio', { name: /^Haiku/ }));
    expect(panel.getByRole('button', { name: 'Effort: Default' })).toBeTruthy();
    session({ type: 'user', id: 'typed', text: 'Fix it' }, { type: 'status', status: 'working' });
    expect(
      panel.getByRole<HTMLButtonElement>('button', { name: 'Restart with these' }).disabled,
    ).toBe(true);
  });

  it('offers a Codex agent Codex’s models, and the modes its command line starts it in', async () => {
    const { sessions, view } = await open({
      data: { adapter: 'codex', connection: 'codex.terminal' },
      options: {
        models: [
          {
            value: 'gpt-6.1-sol',
            label: 'GPT-6.1-Sol',
            efforts: EFFORTS,
            defaultEffort: 'low',
          },
        ],
        defaults: { model: 'gpt-6.1-sol', effort: null, mode: 'auto' },
      },
    });
    expect(sessions.backend.options).toHaveBeenCalledWith('codex', 'a');
    const button = view.getByRole('button', { name: 'Agent settings: a' });
    // Codex's Default needs no more saying; the model's own effort, its config setting none.
    expect(button.textContent).toContain('Codex · Terminal · GPT-6.1-Sol · Low · Default');
    await events.click(button);
    await settle();
    const panel = within(screen.getByRole('dialog', { name: 'Agent settings: a' }));
    await events.click(panel.getByRole('button', { name: 'Mode: Default' }));
    // Its Default is the user's own config: no more to choose than Read only.
    expect(items(panel.getByRole('menu', { name: 'Mode' }))).toEqual(['Default', 'Read only']);
  });

  it('says why it cannot list the models, and still starts with what it is set to', async () => {
    const { sessions, view } = await open({
      data: {
        connection: 'claude-code.terminal',
        settings: { 'claude-code': { model: 'haiku', mode: 'plan' } },
      },
      options: new Error(
        "Error invoking remote method 'session:options': Error: Codex could not list its models",
      ),
    });
    expect(sessions.backend.start).toHaveBeenCalledWith('a', {
      connection: 'claude-code.terminal',
      model: 'haiku',
      mode: 'plan',
    });
    const button = view.getByRole('button', { name: 'Agent settings: a' });
    expect(button.textContent).toContain('Claude · Terminal · haiku · Plan');
    await events.click(button);
    await settle();
    expect(
      within(screen.getByRole('dialog', { name: 'Agent settings: a' })).getByRole('alert')
        .textContent,
    ).toBe('Codex could not list its models');
  });
});
