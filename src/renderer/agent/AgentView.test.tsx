import type { FakeCanvas } from '../test-canvas';
import type { Run } from '../../shared/model/run';
import { NEW_SESSION } from '../../shared/model/session';
let canvas: FakeCanvas | undefined;
const showRun = (run: Run) => {
  act(() => {
    if (!canvas) throw new Error('No fixture');
    canvas.run(run);
  });
};
import { renderReady, events } from '../test-render';
import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_LABEL } from '../../shared/api/limits';
import { useState } from 'react';
import type { ComponentProps } from 'react';

import { GraphEditor as NativeGraphEditor } from '../test-graph';
import { automaticSessions } from '../test-sessions';
import type { Graph, GraphNode } from '../graph/flow';
import type { QueueItem, QueueRepeat } from '../../shared/model/queue';

/** Native session events from a test backend; production never fabricates replies. */
function GraphEditor(props: ComponentProps<typeof NativeGraphEditor>) {
  const [backend] = useState(() => automaticSessions().replies);
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
      onCanvas={(made) => {
        canvas = made;
        props.onCanvas?.(made);
      }}
      {...(initialGraph ? { initialGraph } : {})}
      sessionReplies={backend}
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
async function open(graph: Graph = { nodes: [agent('a')], edges: [] }) {
  const { container } = await renderReady(<GraphEditor initialGraph={graph} />);
  const card = container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
  if (!card) throw new Error('no agent');
  await events.doubleClick(card);
  const view = within(screen.getByRole('dialog', { name: 'a' }));
  const composer = view.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message a' });
  const send = async (text: string) => {
    await events.change(composer, { target: { value: text } });
    await events.keyDown(composer, { key: 'Enter' });
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

  it('keeps the agent header name within the file’s label bounds', async () => {
    const { view } = await open();
    const name = view.getByRole<HTMLInputElement>('textbox', { name: 'Name' });
    expect(name.maxLength).toBe(MAX_LABEL);
    await events.change(name, { target: { value: ' ' } });
    await events.keyDown(name, { key: 'Enter' });
    expect(name.value).toBe('a');
    await events.change(name, { target: { value: 'x'.repeat(MAX_LABEL + 1) } });
    await events.blur(name);
    expect(name.value).toBe('x'.repeat(MAX_LABEL));
  });

  it('fills the editor, with a back button to the canvas', async () => {
    const { view } = await open();
    await events.click(view.getByRole('button', { name: 'Back to the canvas' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the adapter’s logo in its agent chip', async () => {
    const { view } = await open();
    const chip = view.getByRole('button', { name: /^Agent:/ });
    expect(within(chip).getByRole('img', { name: 'Claude Code' }).tagName).toBe('IMG');
  });

  it('adds to the queue from its sidebar, or from right above the message box', async () => {
    const { view } = await open();
    const session = within(view.getByRole('region', { name: 'Session' }));
    const side = within(view.getByRole('complementary', { name: 'Questions and queue' }));
    expect(side.getByRole('button', { name: 'Add to queue' })).toBeTruthy();
    await events.click(session.getByRole('button', { name: 'Queue something' }));
    await events.click(session.getByRole('option', { name: /^Read / }));
    await events.keyDown(session.getByRole('combobox'), { key: 'Enter' }); // this agent
    expect(side.getByRole('button', { name: 'Move Read' })).toBeTruthy();
  });

  it('shows each submitted message in the queue without a duplicate chat summary', async () => {
    const { view, send } = await open();
    const side = within(view.getByRole('complementary', { name: 'Questions and queue' }));
    expect(side.queryByRole('group', { name: /^Current chat/ })).toBeNull();
    await send('Add rate limiting to the public API and document every endpoint');
    const row = side
      .getByText('Add rate limiting to the public API and document every endpoint')
      .closest('[data-submission]');
    expect(row?.getAttribute('data-run')).toBe('running');
    expect(side.queryByRole('group', { name: /^Current chat/ })).toBeNull();
    await send('And a changelog');
    expect(
      side.getByText('And a changelog').closest('[data-submission]')?.getAttribute('data-run'),
    ).toBe('queued');
  });

  it('closes an open menu on Escape, not the view', async () => {
    const { view } = await open();
    const mode = view.getByRole('button', { name: /^Mode: / });
    await events.click(mode);
    expect(view.getByRole('menu', { name: 'Mode' })).toBeTruthy();
    await events.keyDown(mode, { key: 'Escape' });
    expect(view.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();
  });

  it('queues messages sent while it works; Escape interrupts, then sends them', async () => {
    const { card, view, composer, send, transcript } = await open();
    await send('First');
    expect(card.classList.contains('working')).toBe(true);
    await send('Second');
    await send('Third');
    const queued = within(view.getByRole('list', { name: 'Queued messages' }));
    expect(queued.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Second',
      'Third',
    ]);
    // ✕ puts a queued message back in the box.
    await events.click(queued.getByRole('button', { name: 'Edit queued message: Third' }));
    expect(composer.value).toBe('Third');

    await events.change(composer, { target: { value: '' } });
    await events.keyDown(composer, { key: 'Escape' });
    expect(transcript.getByText(/^Interrupted/)).toBeTruthy();
    act(() => {
      if (!canvas) throw new Error('No fixture');
      const items = Object.values(
        canvas.core.state(`messages:${canvas.document.id}`)?.state.items ?? {},
      );
      canvas.messages(items.map((m) => (m.body === 'Second' ? { ...m, state: 'delivered' } : m)));
      canvas.session('a', {
        ...(canvas.session('a') ?? NEW_SESSION),
        status: 'working',
        entries: [
          ...(canvas.session('a')?.entries ?? []),
          { kind: 'user', id: 'second-delivery', text: 'Second' },
        ],
      });
    });
    expect(transcript.getByText('Second')).toBeTruthy();
    expect(view.queryByRole('list', { name: 'Queued messages' })).toBeNull();
  });

  it('never switches into bypassing permissions with Shift+Tab', async () => {
    const { view, composer } = await open();
    const mode = () => view.getByRole('button', { name: /^Mode: / }).getAttribute('aria-label');
    const seen = [mode()];
    for (let i = 0; i < 4; i += 1) {
      await events.keyDown(composer, { key: 'Tab', shiftKey: true });
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

  it('bypasses permissions from the mode menu only once it is confirmed', async () => {
    const { view, composer } = await open();
    const menu = () => view.getByRole('button', { name: /^Mode: / });
    await events.click(menu());
    await events.click(view.getByRole('menuitemradio', { name: /^Bypass permissions/ }));
    const confirm = within(view.getByRole('alertdialog', { name: 'Bypass permissions?' }));
    expect(menu().getAttribute('aria-label')).toBe('Mode: Manual');
    await events.click(confirm.getByRole('button', { name: 'Cancel' }));
    expect(view.queryByRole('alertdialog')).toBeNull();
    expect(menu().getAttribute('aria-label')).toBe('Mode: Manual');

    // Escape says no too, and leaves the view open.
    await events.click(menu());
    await events.click(view.getByRole('menuitemradio', { name: /^Bypass permissions/ }));
    await events.keyDown(view.getByRole('button', { name: 'Bypass permissions' }), {
      key: 'Escape',
    });
    expect(view.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();

    await events.click(menu());
    await events.click(view.getByRole('menuitemradio', { name: /^Bypass permissions/ }));
    await events.click(view.getByRole('button', { name: 'Bypass permissions' }));
    expect(menu().getAttribute('aria-label')).toBe('Mode: Bypass permissions');
    // Out of it with Shift+Tab, to Manual.
    await events.keyDown(composer, { key: 'Tab', shiftKey: true });
    expect(menu().getAttribute('aria-label')).toBe('Mode: Manual');
  });

  it('keeps Codex’s Full access out of Shift+Tab, and switches to it once confirmed', async () => {
    const { view, composer } = await open({
      nodes: [agent('a', { data: { label: 'a', adapter: 'codex' } })],
      edges: [],
    });
    const menu = () => view.getByRole('button', { name: /^Mode: / });
    const seen = [menu().getAttribute('aria-label')];
    for (let i = 0; i < 3; i += 1) {
      await events.keyDown(composer, { key: 'Tab', shiftKey: true });
      seen.push(menu().getAttribute('aria-label'));
    }
    expect(seen).toEqual(['Mode: Default', 'Mode: Plan', 'Mode: Read only', 'Mode: Default']);

    await events.click(menu());
    await events.click(view.getByRole('menuitemradio', { name: /^Full access/ }));
    const confirm = within(view.getByRole('alertdialog', { name: 'Full access?' }));
    expect(menu().getAttribute('aria-label')).toBe('Mode: Default');
    await events.click(confirm.getByRole('button', { name: 'Full access' }));
    expect(menu().getAttribute('aria-label')).toBe('Mode: Full access');
    // Out of it with Shift+Tab, to the first.
    await events.keyDown(composer, { key: 'Tab', shiftKey: true });
    expect(menu().getAttribute('aria-label')).toBe('Mode: Read only');
  });

  it('asks for your OK above the composer while the run holds it, where what you send asks for changes', async () => {
    await renderReady(
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
    await events.click(screen.getByRole('button', { name: 'Show all queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    await events.click(queues.getByRole('button', { name: 'Run' }));
    await events.click(queues.getByRole('button', { name: 'Open a' }));
    const view = shown('a');
    const session = within(view.getByRole('region', { name: 'Session' }));
    const side = within(view.getByRole('complementary', { name: 'Questions and queue' }));
    const row = () =>
      side
        .getByRole('button', { name: 'Move Your OK on the spec in SPEC.md' })
        .closest<HTMLElement>('[data-run]');
    const composer = session.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message a' });
    const bar = () => session.queryByRole('group', { name: 'Needs you' });

    showRun({ running: true, agents: { a: { current: 'ok', status: 'asking', outcomes: {} } } });
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
    await events.change(composer, { target: { value: 'Cover the empty state too' } });
    await events.keyDown(composer, { key: 'Enter' });
    showRun({
      running: true,
      agents: {
        a: {
          current: 'ok',
          status: 'running',
          outcomes: {},
          changes: { ok: ['Cover the empty state too'] },
        },
      },
    });
    act(() => {
      canvas?.session('a', {
        ...NEW_SESSION,
        status: 'working',
        entries: [{ kind: 'user', id: 'changes', text: 'Cover the empty state too' }],
      });
    });
    expect(row()?.dataset.run).toBe('running');
    expect(bar()).toBeNull();
    expect(composer.placeholder).toBe('Queue a message for a…');
    const transcript = within(view.getByRole('log', { name: 'Transcript' }));
    expect(transcript.getByText('Cover the empty state too')).toBeTruthy();

    // The core publishes the new hold after the interrupted correction.
    await events.keyDown(composer, { key: 'Escape' });
    showRun({
      running: true,
      agents: {
        a: {
          current: 'ok',
          status: 'asking',
          outcomes: {},
          changes: { ok: ['Cover the empty state too'] },
        },
      },
    });
    expect(row()?.dataset.run).toBe('asking');
    expect(row()?.querySelector('.graph-queue-ok-asked')?.textContent).toBe(
      'You asked: “Cover the empty state too”',
    );
    await events.click(within(bar() ?? document.body).getByRole('button', { name: 'Approve' }));
    showRun({
      running: true,
      agents: { a: { current: 'next', status: 'running', outcomes: { ok: 'succeeded' } } },
    });
    expect(row()?.dataset.run).toBe('succeeded');
    expect(bar()).toBeNull();
    expect(
      side
        .getByRole('button', { name: 'Move Read' })
        .closest('[data-run]')
        ?.getAttribute('data-run'),
    ).toBe('running');
  });

  it('asks above the composer when a repeat is out of rounds, where what you send is what to try next', async () => {
    // An empty message is skipped: no round ends with its last step succeeding.
    await renderReady(
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
    await events.click(screen.getByRole('button', { name: 'Show all queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    await events.click(queues.getByRole('button', { name: 'Run' }));
    play(10);
    await events.click(queues.getByRole('button', { name: 'Open a' }));
    const view = shown('a');
    const session = within(view.getByRole('region', { name: 'Session' }));
    const side = within(view.getByRole('complementary', { name: 'Questions and queue' }));
    const card = () =>
      side
        .getByRole('button', { name: 'Move Repeat until its last step succeeds' })
        .closest<HTMLElement>('.graph-queue-repeat');
    const composer = session.getByRole<HTMLTextAreaElement>('textbox', { name: 'Message a' });
    const bar = () => within(session.getByRole('group', { name: 'Needs you' }));

    showRun({
      running: true,
      agents: {
        a: {
          current: 'loop',
          status: 'asking',
          outcomes: { note: 'skipped' },
          rounds: { loop: { round: 1, more: 0 } },
        },
      },
    });
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
    await events.change(composer, { target: { value: 'Try a smaller fix' } });
    await events.keyDown(composer, { key: 'Enter' });
    const transcript = within(view.getByRole('log', { name: 'Transcript' }));
    act(() => {
      canvas?.session('a', {
        ...NEW_SESSION,
        entries: [{ kind: 'user', id: 'retry-note', text: 'Try a smaller fix' }],
      });
    });
    showRun({
      running: true,
      agents: {
        a: {
          current: 'loop',
          status: 'asking',
          outcomes: { note: 'skipped' },
          rounds: { loop: { round: 2, more: 1 } },
        },
      },
    });
    expect(transcript.getByText('Try a smaller fix')).toBeTruthy();
    play(10);
    expect(card()?.dataset.round).toBe('Round 2 of 2');
    expect(bar().getByText(/^2 rounds done/)).toBeTruthy();

    await events.click(bar().getByRole('button', { name: 'Go on' }));
    showRun({
      running: true,
      agents: {
        a: {
          current: 'next',
          status: 'running',
          outcomes: { loop: 'failed' },
          rounds: { loop: { round: 2, more: 1 } },
        },
      },
    });
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

  it("picks a step inside the other agent's repeat, beside, for a wait inside its own repeat", async () => {
    const round = (id: string, repeat: QueueItem[]): QueueItem => ({
      id,
      repeat: repeat as QueueRepeat['repeat'],
      until: { kind: 'succeeded' },
      rounds: 3,
      otherwise: 'ask',
    });
    await renderReady(
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
    await events.doubleClick(card);
    const view = shown('a');
    await events.click(view.getByRole('button', { name: 'Change what it waits for: Reviewer' }));
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
    await events.click(beside.getByRole('button', { name: 'Wait for Reviewer: Read' }));
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

    it('spawns a new agent of its type in its group, not linked, and stacks itself under it', async () => {
      const { container, view, send } = await open(grouped);
      await send('Add rate limiting');
      await events.click(view.getByRole('button', { name: 'New agent' }));

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

    it('spawns one linked to the agent shown, from the menu beside its ⊕', async () => {
      const { container, view } = await open(grouped);
      await events.click(view.getByRole('button', { name: 'Ways to add an agent' }));
      const menu = within(view.getByRole('menu', { name: 'New agent' }));
      await events.click(menu.getByRole('menuitem', { name: 'New agent, linked to a' }));
      const links = () =>
        [...container.querySelectorAll('.react-flow__edge')].map((e) =>
          e.getAttribute('aria-label'),
        );
      expect(links()).toEqual(['a and Agent 1 can talk']);

      // The menu's other choice is the ⊕'s: on its own.
      await events.click(shown('Agent 1').getByRole('button', { name: 'Ways to add an agent' }));
      await events.click(screen.getByRole('menuitem', { name: 'New agent' }));
      expect(shown('Agent 2')).toBeTruthy();
      expect(links()).toEqual(['a and Agent 1 can talk']);
    });

    it('switches to a stacked agent, the one shown going on top of the stack', async () => {
      const { view } = await open();
      await events.click(view.getByRole('button', { name: 'New agent' }));
      await events.click(shown('Agent 1').getByRole('button', { name: 'New agent' }));
      expect(stacked()).toEqual(['Switch to Agent 1', 'Switch to a']);

      await events.click(shown('Agent 2').getByRole('button', { name: 'Switch to a' }));
      expect(shown('a')).toBeTruthy();
      expect(stacked()).toEqual(['Switch to Agent 2', 'Switch to Agent 1']);
      await events.click(shown('a').getByRole('button', { name: 'Switch to Agent 1' }));
      expect(stacked()).toEqual(['Switch to a', 'Switch to Agent 2']);
    });

    it('closes to the canvas from any agent in the stack, which then starts afresh', async () => {
      const { container, view } = await open();
      await events.click(view.getByRole('button', { name: 'New agent' }));
      await events.click(shown('Agent 1').getByRole('button', { name: 'Back to the canvas' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      // The agent shown last has the keyboard on the canvas.
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Agent 1, Claude · SDK');

      await events.doubleClick(screen.getByRole('group', { name: 'a, Claude · SDK' }));
      expect(stacked()).toEqual([]);
      await events.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(container.querySelectorAll('.react-flow__node')).toHaveLength(2);
    });
  });
});
