import { NEW_SESSION } from '../../shared/model/session';
import { renderReady, events } from '../test-render';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_LABEL } from '../../shared/api/limits';
import { canvasIdOf, newCanvasId } from '../../shared/canvas';
import type { CanvasId } from '../../shared/canvas';
import type { ProjectFolder } from '../../shared/canvas';
import type { QueueItem } from '../../shared/model/queue';
import type { UsageState } from '../../shared/usage';
import { catalog } from '../catalog';
import { api } from '../api/client';
import { useDraft } from '../useDraft';
import { EXAMPLES } from '../../shared/examples';
import { templateInfo } from '../../shared/templates';
import { automaticSessions, fakeSessions } from '../test-sessions';
import type { UsageSource } from '../usage/store';
import { fromFile, toFile } from '../../shared/model/file';
import { GraphEditor } from '../test-graph';
import type { FakeCanvas } from '../test-canvas';
import { expectOneOp } from '../test-api';
import type { GuiOp } from '../../shared/api/surface';
import { PADDING } from '../../shared/model/geometry';
import type { Graph, GraphNode } from './flow';
import { documentOf, graphOf } from '../test-graph-data';
import { DEFAULT_AGENT } from './agents';

// jsdom cannot draw xterm.js: a fake terminal stands in for a Terminal agent's (test-screen.ts).
vi.mock('../terminal/screen', async () => {
  const { fakeScreens } = await import('../terminal/test-screen');
  return { createScreen: fakeScreens.create };
});

const agentNode = (
  id: string,
  x: number,
  y: number,
  extra: Partial<GraphNode> = {},
): GraphNode => ({
  id,
  type: 'agent',
  position: { x, y },
  data: { label: id },
  ...extra,
});

const frame: GraphNode = {
  id: 'F',
  type: 'frame',
  position: { x: 0, y: 0 },
  data: { label: 'Group 1' },
  width: 400,
  height: 300,
  measured: { width: 400, height: 300 },
};

/** The fake core a test editor runs on (test-canvas.ts), as it renders. */
function core() {
  const held: { canvas?: FakeCanvas } = {};
  return {
    onCanvas: (made: FakeCanvas) => {
      held.canvas = made;
    },
    get canvas(): FakeCanvas {
      if (!held.canvas) throw new Error('No canvas core yet');
      return held.canvas;
    },
  };
}
/** The operations named `op` the editor called, in order. */
const calls = (canvas: FakeCanvas, op: GuiOp) =>
  canvas.core.operations.filter((call) => call.op === op);

async function setup(initialGraph?: Graph, files = false) {
  const fake = automaticSessions();
  const held = core();
  const { container } = await renderReady(
    <GraphEditor
      sessionReplies={fake.replies}
      {...(initialGraph ? { initialGraph } : {})}
      files={files}
      onCanvas={held.onCanvas}
    />,
  );
  const { canvas } = held;
  const nodes = (selector = '.react-flow__node') => [
    ...container.querySelectorAll<HTMLElement>(selector),
  ];
  const node = (id: string) => {
    const element = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
    if (!element) throw new Error(`no node ${id}`);
    return element;
  };
  const pane = container.querySelector('.react-flow__pane');
  if (!pane) throw new Error('no pane');
  return { container, nodes, node, pane, fake, canvas };
}

const button = (name: string) => {
  if (
    ['New', 'Open…', 'Save', 'Save as…'].includes(name) &&
    !screen.queryByRole('button', { name })
  )
    fireEvent.click(screen.getByRole('button', { name: 'Canvas menu' }));
  return screen.getByRole<HTMLButtonElement>('button', { name });
};
const labelInput = () => screen.getByRole<HTMLInputElement>('textbox', { name: 'Label' });
/** The actions shown for a node, group or selection. */
const actions = (id: string) => {
  const toolbar = document.querySelector<HTMLElement>(`.react-flow__node-toolbar[data-id="${id}"]`);
  if (!toolbar) throw new Error(`no actions for ${id}`);
  return within(toolbar);
};

beforeEach(() => {
  vi.spyOn(api, 'templatesList').mockResolvedValue({
    items: EXAMPLES.map((example) => templateInfo(example, catalog(), DEFAULT_AGENT)),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GraphEditor', () => {
  function DraftGate({ save }: { save: () => Promise<void> }) {
    const { problem, ...draft } = useDraft('Saved', save);
    return (
      <>
        <input aria-label="Pending draft" {...draft} />
        {problem && <p role="alert">{problem}</p>}
      </>
    );
  }

  it.each(['save', 'shortcut', 'run', 'composer'] as const)(
    'waits for in-flight drafts before %s',
    async (gesture) => {
      const saving = Promise.withResolvers<undefined>();
      const { fake, node, canvas } = await setup(
        {
          nodes: [
            agentNode('a', 0, 0, {
              data: {
                label: 'a',
                connection: 'claude-code.sdk',
                queue: [{ id: 'work', message: 'Planned' }],
              },
            }),
          ],
          edges: [],
        },
        true,
      );
      if (gesture === 'run') fireEvent.click(button('Show all queues'));
      if (gesture === 'composer') fireEvent.doubleClick(node('a'));
      const save = vi.fn(() => saving.promise);
      render(<DraftGate save={save} />);
      fireEvent.change(screen.getByRole('textbox', { name: 'Pending draft' }), {
        target: { value: 'New words' },
      });
      try {
        if (gesture === 'save') fireEvent.click(button('Save'));
        else if (gesture === 'shortcut')
          fireEvent.keyDown(document.body, { key: 's', ctrlKey: true });
        else if (gesture === 'run') fireEvent.click(button('Run'));
        else {
          const composer = screen.getByRole('textbox', { name: 'Message a' });
          fireEvent.change(composer, { target: { value: 'Hello' } });
          fireEvent.keyDown(composer, { key: 'Enter' });
        }
        await act(async () => {
          await Promise.resolve();
        });
        expect(save).toHaveBeenCalledOnce();
        expect(canvas.files.saved).toEqual([]);
        expect(fake.replies.send).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          saving.resolve(undefined);
          await Promise.resolve();
        });
      }
      await waitFor(() => {
        if (gesture === 'save' || gesture === 'shortcut')
          expect(canvas.files.saved).toHaveLength(1);
        else if (gesture === 'run')
          expect(canvas.core.operations.some(({ op }) => op === 'run.start')).toBe(true);
        else expect(fake.replies.send).toHaveBeenCalledOnce();
      });
    },
  );

  it('leaves run ownership in the core when the view unloads', async () => {
    const held = core();
    const fake = fakeSessions();
    const { unmount } = await renderReady(
      <GraphEditor
        initialGraph={{ nodes: [agentNode('a', 0, 0)], edges: [] }}
        onCanvas={held.onCanvas}
        sessionReplies={fake.replies}
      />,
    );
    const before = held.canvas.run();
    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
    });
    expect(held.canvas.run()).toBe(before);
    expect(fake.replies.interrupt).not.toHaveBeenCalled();
    unmount();
    expect(fake.replies.close).not.toHaveBeenCalled();
  });

  it('commits the agent name before the composer sends without blur', async () => {
    const { fake, node } = await setup({
      nodes: [agentNode('a', 0, 0, { data: { label: 'a', connection: 'claude-code.sdk' } })],
      edges: [],
    });
    await events.doubleClick(node('a'));
    const view = within(screen.getByRole('dialog', { name: 'a' }));
    const name = view.getByRole('textbox', { name: 'Name' });
    await events.change(name, { target: { value: 'Drafted name' } });
    expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();
    fake.replies.send.mockImplementationOnce(() => {
      expect(screen.getByRole('dialog', { name: 'Drafted name' })).toBeTruthy();
      return Promise.resolve(null);
    });
    const composer = view.getByRole('textbox', { name: 'Message a' });
    await events.change(composer, { target: { value: 'Hello' } });
    await events.keyDown(composer, { key: 'Enter' });
    await waitFor(() => {
      expect(fake.replies.send).toHaveBeenCalledOnce();
    });
    expect(node('a').querySelector('.graph-label')?.textContent).toContain('Drafted name');
  });

  it('saves the drafted label from the file shortcut before blur', async () => {
    const { canvas } = await setup(
      { nodes: [agentNode('a', 0, 0, { selected: true })], edges: [] },
      true,
    );
    await events.keyDown(document.body, { key: 'F2' });
    await events.change(labelInput(), { target: { value: 'Drafted label' } });
    await events.keyDown(labelInput(), { key: 's', ctrlKey: true });
    await waitFor(() => {
      expect(canvas.files.saved).toHaveLength(1);
    });
    expect(
      fromFile(canvas.files.saved[0] ?? '', catalog(), DEFAULT_AGENT).nodes[0]?.data.label,
    ).toBe('Drafted label');
  });

  it('runs a pending message draft before the idle commit or blur', async () => {
    const { canvas } = await setup({
      nodes: [
        agentNode('a', 0, 0, {
          data: {
            label: 'a',
            connection: 'claude-code.sdk',
            queue: [{ id: 'work', message: 'Original' }],
          },
        }),
      ],
      edges: [],
    });
    await events.click(button('Show all queues'));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    const input = queues.getByRole('textbox', { name: 'Message to the agent' });
    await events.focus(input);
    await events.change(input, { target: { value: 'Run this draft' } });
    // A synthetic click deliberately skips blur: Run itself must flush the draft.
    await events.click(queues.getByRole('button', { name: 'Run' }));
    expect(canvas.core.operations.at(-1)).toEqual({
      op: 'run.start',
      args: { canvas: canvas.document.id },
    });
    const agent = canvas.document.nodes.find((n) => n.id === 'a');
    expect(agent?.type === 'agent' && agent.data.queue?.[0]).toEqual({
      id: 'work',
      message: 'Run this draft',
    });
  });

  it.each([
    ['Model: Opus', 'Default (Opus)', { effort: 'low', mode: 'plan' }],
    ['Effort: Low', 'Default (Low)', { model: 'opus', mode: 'plan' }],
    ['Mode: Plan', 'Default (Manual)', { model: 'opus', effort: 'low' }],
  ] as const)(
    'saves exactly the settings the sheet shows after clearing %s',
    async (field, choice, expected) => {
      const other = { model: 'gpt-6-luna', mode: 'auto' };
      const { node, fake, canvas } = await setup(
        {
          nodes: [
            agentNode('a', 0, 0, {
              data: {
                label: 'Reviewer',
                connection: 'claude-code.sdk',
                settings: {
                  'claude-code': { model: 'opus', effort: 'low', mode: 'plan' },
                  codex: other,
                },
              },
            }),
          ],
          edges: [],
        },
        true,
      );
      fake.replies.options.mockResolvedValue({
        models: [{ value: 'opus', label: 'Opus', efforts: [{ value: 'low', label: 'Low' }] }],
        defaults: { model: 'opus', effort: 'low', mode: 'manual' },
      });
      await events.contextMenu(node('a'));
      await events.click(screen.getByRole('menuitem', { name: 'Settings…' }));
      const sheet = within(screen.getByRole('dialog', { name: 'Agent settings: Reviewer' }));
      await waitFor(() => {
        expect(sheet.getByRole('button', { name: 'Model: Opus' })).toBeTruthy();
      });
      await events.click(sheet.getByRole('button', { name: field }));
      await events.click(
        sheet.getByRole('menuitemradio', { name: (name) => name.startsWith(choice) }),
      );
      expect(
        sheet.getByRole('button', { name: `${field.split(':')[0] ?? ''}: ${choice}` }),
      ).toBeTruthy();
      await events.click(sheet.getByRole('button', { name: 'Close agent settings' }));
      await events.click(button('Save'));
      await waitFor(() => {
        expect(canvas.files.saved).toHaveLength(1);
      });
      const loaded = fromFile(canvas.files.saved[0] ?? '', catalog(), DEFAULT_AGENT);
      expect(loaded.nodes[0]?.data).toHaveProperty('settings', {
        'claude-code': expected,
        codex: other,
      });
    },
  );

  it('StrictMode shows the core’s restored run and Resume is one operation', async () => {
    const held = core();
    await renderReady(
      <StrictMode>
        <GraphEditor
          initialGraph={{
            nodes: [
              agentNode('a', 0, 0, {
                data: { label: 'a', queue: [{ id: 'work', approve: 'work' }] },
              }),
            ],
            edges: [],
          }}
          onCanvas={held.onCanvas}
        />
      </StrictMode>,
    );
    act(() => {
      held.canvas.run({
        running: false,
        paused: true,
        agents: { a: { status: 'asking', current: 'work', outcomes: {} } },
      });
    });
    await events.click(await screen.findByRole('button', { name: 'Resume' }));
    expectOneOp(held.canvas.core, 'run.resume', { canvas: held.canvas.document.id });
  });

  it('hears usage changes and applies their rules after StrictMode cleanup', async () => {
    const changed = new Set<(state: UsageState) => void>();
    let usage: UsageState = { readings: [], rules: {} };
    const usageSource: UsageSource = {
      topics: {
        snapshot: () => usage,
        subscribe: (_topic, listener) => {
          const receive = (state: UsageState) => {
            usage = state;
            listener();
          };
          changed.add(receive);
          return () => {
            changed.delete(receive);
          };
        },
      },
      setRule: vi.fn<UsageSource['setRule']>().mockResolvedValue({}),
      simulate: vi.fn<UsageSource['simulate']>().mockResolvedValue({}),
    };
    const sessions = fakeSessions();
    const held = core();
    const { unmount } = await renderReady(
      <StrictMode>
        <GraphEditor
          initialGraph={{
            nodes: [
              agentNode('a', 0, 0, {
                data: {
                  label: 'a',
                  adapter: 'codex',
                  connection: 'codex.app-server',
                  queue: [{ id: 'work', message: 'Held work' }],
                },
              }),
            ],
            edges: [],
          }}
          sessionReplies={sessions.replies}
          usageSource={usageSource}
          onCanvas={held.onCanvas}
        />
      </StrictMode>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      for (const listener of changed)
        listener({
          readings: [
            {
              backend: 'codex',
              at: Date.now(),
              windows: {
                fiveHour: { usedPercent: 95, resetsAt: Date.now() + 60_000 },
              },
            },
          ],
          rules: { codex: { window: 'fiveHour', percent: 80, action: 'ask' } },
        });
    });
    expect(screen.getByRole('button', { name: /^Codex usage: 95%/ })).toBeTruthy();
    await events.click(button('Show all queues'));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    await events.click(queues.getByRole('button', { name: 'Run' }));
    act(() => {
      held.canvas.run({
        running: true,
        agents: {
          a: {
            current: 'work',
            status: 'asking',
            outcomes: {},
            usage: {
              backend: 'codex',
              window: 'fiveHour',
              percent: 80,
              used: 95,
              resetsAt: Date.now() + 60000,
            },
          },
        },
      });
    });
    expect(queues.getByRole('button', { name: 'Wait for the reset' })).toBeTruthy();
    expect(sessions.replies.send).not.toHaveBeenCalled();
    unmount();
    await waitFor(() => {
      expect(changed.size).toBe(0);
    });
  });

  it('keeps legacy unsupported work unsent and offers a real connection without fabricating completion', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { fake, canvas } = await setup({
      nodes: [
        agentNode('legacy', 0, 0, {
          data: {
            label: 'Legacy',
            adapter: 'qwen',
            queue: [{ id: 'work', message: 'Keep this work pending' }],
          },
        }),
      ],
      edges: [],
    });
    await events.click(button('Show all queues'));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    await events.click(queues.getByRole('button', { name: 'Run' }));
    act(() => {
      canvas.run({
        running: true,
        agents: {
          legacy: {
            current: 'work',
            status: 'asking',
            outcomes: {},
            refused: {
              agent: 'legacy',
              connection: 'unavailable',
              text: 'This agent has no connection; choose Claude or Codex in Agent settings.',
            },
          },
        },
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    const row = queues.getByRole('group', { name: 'Legacy: Message “Keep this work pending”' });
    expect(row.querySelector('[data-run]')?.getAttribute('data-run')).toBe('asking');
    expect(
      queues.getByText('This agent has no connection; choose Claude or Codex in Agent settings.'),
    ).toBeTruthy();
    expect(within(row).queryByText(/attempt/)).toBeNull();
    expect(within(row).queryByText('Running')).toBeNull();
    expect(fake.replies.start).not.toHaveBeenCalled();
    expect(fake.replies.send).not.toHaveBeenCalled();
    await events.click(queues.getByRole('button', { name: 'Open Legacy' }));
    const view = within(screen.getByRole('dialog', { name: 'Legacy' }));
    expect(view.getByText(/qwen has no connector yet/)).toBeTruthy();
    expect(view.queryByRole('textbox', { name: 'Message Legacy' })).toBeNull();
    expect(view.queryByText(/scripted session|SUCCEEDED/)).toBeNull();
    await events.click(view.getByRole('button', { name: 'Choose a connected agent' }));
    const settings = within(screen.getByRole('dialog', { name: 'Agent settings: Legacy' }));
    await events.click(settings.getByRole('button', { name: /^Agent:/ }));
    expect(
      settings
        .getAllByRole('option')
        .map((option) => option.textContent)
        .join(' '),
    ).not.toMatch(/Simulated|qwen|gemini/i);
  });

  it('draws agents whose adapters are named like what every object inherits as Not connected', async () => {
    const steps = [{ id: 'run', action: 'Bash' }];
    const { container } = await setup({
      nodes: [
        agentNode('s', 0, 0, {
          data: { label: 'S', adapter: 'toString', connection: 'toString', queue: steps },
        }),
        agentNode('c', 300, 0, { data: { label: 'C', adapter: 'constructor', queue: steps } }),
      ],
      edges: [],
    });
    const tags = [...container.querySelectorAll('.graph-card')].map((tag) =>
      tag.getAttribute('title'),
    );
    expect(tags).toEqual(['Agent: toString · Not connected', 'Agent: constructor · Not connected']);
    await events.click(button('Show all queues'));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    expect(queues.getByRole('group', { name: 'S: Bash' })).toBeTruthy();
    await events.click(queues.getByRole('button', { name: 'Open C' }));
    const view = within(screen.getByRole('dialog', { name: 'C' }));
    expect(view.getByText(/constructor has no connector yet/)).toBeTruthy();
  });

  it('holds one agent through its context menu without changing the saved canvas', async () => {
    const initial: Graph = {
      nodes: [agentNode('a', 0, 0), agentNode('b', 400, 0), frame],
      edges: [],
    };
    const { node, canvas } = await setup(initial, true);
    await events.contextMenu(node('F'));
    expect(screen.getByRole('menu', { name: 'Group 1 controls' })).toBeTruthy();
    await events.keyDown(screen.getByRole('menuitem', { name: /^Pause/ }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    await events.contextMenu(node('a'), { clientX: 100, clientY: 200 });
    const menu = within(screen.getByRole('menu', { name: 'a controls' }));
    await events.click(menu.getByRole('menuitem', { name: /^Pause/ }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(node('a').querySelector('[aria-label$="paused"]')).toBeTruthy();
    expect(node('b').querySelector('[aria-label$="paused"]')).toBeNull();
    expect(document.title).toBe('Untitled — corrallm');
    await events.click(button('Save'));
    await waitFor(() => {
      expect(canvas.files.saved).toHaveLength(1);
    });
    const text = canvas.files.saved[0] ?? '';
    expect(text).toBe(toFile(documentOf(initial, canvasIdOf(text))));
    await events.contextMenu(node('a'));
    await events.click(screen.getByRole('menuitem', { name: /^Resume/ }));
    expect(node('a').querySelector('[aria-label$="paused"]')).toBeNull();
  });

  it('resumes only a group’s own holds, retaining nested and individual pauses', async () => {
    const initial: Graph = {
      nodes: [
        frame,
        agentNode('a', 20, 50, { parentId: 'F' }),
        agentNode('parent', 20, 120, { parentId: 'F' }),
        agentNode('child', 20, 50, { parentId: 'parent' }),
      ],
      edges: [],
    };
    const { node, canvas } = await setup(initial, true);
    // Let the canvas save its measured group geometry before testing runtime-only controls.
    await events.click(button('Save'));
    await waitFor(() => {
      expect(document.title).toBe('team.corral — corrallm');
    });
    const saved = canvas.files.saved[0];
    await events.contextMenu(node('a'));
    await events.click(screen.getByRole('menuitem', { name: /^Pause/ }));
    node('F').focus();
    await events.keyDown(node('F'), { key: 'F10', shiftKey: true });
    await events.click(screen.getByRole('menuitem', { name: /^Pause/ }));
    expect(node('F').querySelector('[aria-label$="paused"]')).toBeTruthy();
    expect(node('child').querySelector('[aria-label$="paused"]')).toBeTruthy();
    await events.contextMenu(node('parent'));
    const parentMenu = within(screen.getByRole('menu', { name: 'parent controls' }));
    expect(parentMenu.getByRole('menuitem', { name: /^Pause separately/ })).toBeTruthy();
    await events.click(parentMenu.getByRole('menuitem', { name: /^Pause group/ }));
    await events.contextMenu(node('F'));
    await events.click(screen.getByRole('menuitem', { name: /^Resume/ }));
    expect(node('F').querySelector('[aria-label$="paused"]')).toBeNull();
    expect(node('a').querySelector('[aria-label$="paused"]')).toBeTruthy();
    expect(node('parent').querySelector('[aria-label$="paused"]')).toBeTruthy();
    expect(node('child').querySelector('[aria-label$="paused"]')).toBeTruthy();
    await events.contextMenu(node('parent'));
    await events.click(screen.getByRole('menuitem', { name: /^Resume group/ }));
    expect(node('parent').querySelector('[aria-label$="paused"]')).toBeNull();
    expect(node('child').querySelector('[aria-label$="paused"]')).toBeNull();
    expect(node('a').querySelector('[aria-label$="paused"]')).toBeTruthy();
    expect(document.title).toBe('team.corral — corrallm');
    await events.click(button('Save'));
    await waitFor(() => {
      expect(canvas.files.saved).toHaveLength(2);
    });
    expect(canvas.files.saved[1]).toBe(saved);
  });

  it('opens agent controls with the keyboard and dismisses without changing the agent', async () => {
    const { node } = await setup({ nodes: [agentNode('a', 0, 0)], edges: [] });
    node('a').focus();
    await events.keyDown(node('a'), { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menu', { name: 'a controls' })).toBeTruthy();
    await events.keyDown(screen.getByRole('menuitem', { name: /^Pause/ }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(node('a'));
    expect(node('a').querySelector('[aria-label$="paused"]')).toBeNull();
  });

  it('shows manual turns in every queue view without saving or running them again', async () => {
    const sessions = fakeSessions();
    const initial: Graph = {
      nodes: [
        agentNode('a', 0, 0, {
          data: {
            label: 'a',
            connection: 'claude-code.sdk',
            queue: [{ id: 'planned', message: 'Do planned work' }],
          },
        }),
      ],
      edges: [],
    };
    const held = core();
    const { container } = await renderReady(
      <GraphEditor
        initialGraph={initial}
        files
        onCanvas={held.onCanvas}
        sessionReplies={sessions.replies}
      />,
    );
    const card = container.querySelector('.react-flow__node[data-id="a"]');
    if (!card) throw new Error('no agent');
    await events.doubleClick(card);
    const view = within(screen.getByRole('dialog', { name: 'a' }));
    const composer = view.getByRole('textbox', { name: 'Message a' });
    await events.change(composer, { target: { value: 'Inspect the failure' } });
    await events.keyDown(composer, { key: 'Enter' });
    await waitFor(() => {
      expect(sessions.replies.send).toHaveBeenCalledTimes(1);
    });
    const message = sessions.sent();
    const side = within(view.getByRole('complementary', { name: 'Questions and queue' }));
    expect(
      side.getByText('Inspect the failure').closest('[data-submission]')?.getAttribute('data-run'),
    ).toBe('running');
    expect(side.queryByRole('group', { name: /^Current chat/ })).toBeNull();
    act(() => {
      sessions.emit(
        'a',
        'claude-code.sdk',
        { type: 'user', id: message, text: 'Inspect the failure' },
        { type: 'text', id: 'answer', text: 'I inspected it.' },
        {
          type: 'end',
          messages: [message],
          seconds: 1,
          result: { status: 'completed', reason: 'completed' },
        },
      );
    });
    expect(
      side.getByText('Inspect the failure').closest('[data-submission]')?.getAttribute('data-run'),
    ).toBe('completed');
    await events.click(view.getByRole('button', { name: 'All queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    const manual = queues.getByRole('group', { name: 'a: Message “Inspect the failure”' });
    expect(manual.querySelector('[data-submission]')?.getAttribute('data-run')).toBe('completed');
    expect(within(manual).queryByRole('button')).toBeNull();
    await events.click(queues.getByRole('button', { name: 'Run' }));
    expect(held.canvas.core.operations.filter(({ op }) => op === 'run.start')).toHaveLength(1);
    expect(sessions.replies.send).toHaveBeenCalledTimes(1);
    act(() => {
      held.canvas.run({
        running: true,
        agents: { a: { current: 'planned', status: 'running', outcomes: {} } },
      });
    });
    expect(
      screen.getByRole('dialog', { name: 'All queues' }).querySelectorAll('[data-submission]'),
    ).toHaveLength(1);
    await events.click(queues.getByRole('button', { name: 'Back' }));
    await events.click(view.getByRole('button', { name: 'Back to the canvas' }));
    expect(document.title).toBe('Untitled — corrallm');
    await events.click(button('Save'));
    await waitFor(() => {
      expect(held.canvas.files.saved).toHaveLength(1);
    });
    const text = held.canvas.files.saved[0] ?? '';
    expect(text).toBe(toFile(documentOf(initial, canvasIdOf(text))));
  });

  it('records an SDK command handled locally as a completed submitted message', async () => {
    const sessions = fakeSessions();
    const initial: Graph = {
      nodes: [agentNode('a', 0, 0, { data: { label: 'a', connection: 'claude-code.sdk' } })],
      edges: [],
    };
    const { container } = await renderReady(
      <GraphEditor initialGraph={initial} sessionReplies={sessions.replies} />,
    );
    const card = container.querySelector('.react-flow__node[data-id="a"]');
    if (!card) throw new Error('no agent');
    await events.doubleClick(card);
    const view = within(screen.getByRole('dialog', { name: 'a' }));
    const composer = view.getByRole('textbox', { name: 'Message a' });
    await events.change(composer, { target: { value: '/mcp' } });
    await events.keyDown(composer, { key: 'Enter' });
    const side = within(view.getByRole('complementary', { name: 'Questions and queue' }));
    expect(side.getByText('/mcp').closest('[data-submission]')?.getAttribute('data-run')).toBe(
      'completed',
    );
    await waitFor(() => {
      expect(sessions.replies.mcp).toHaveBeenCalled();
    });
    expect(sessions.replies.send).not.toHaveBeenCalled();
  });

  it('adds a node on double-click on the empty canvas', async () => {
    const { nodes, pane } = await setup();
    await events.doubleClick(pane, { clientX: 200, clientY: 100 });
    expect(nodes().map((n) => n.querySelector('.graph-label')?.textContent)).toEqual(['Agent 1']);
  });

  it("starts a new agent's queue with a message to write, counted on its card once written", async () => {
    const { nodes, pane } = await setup();
    await events.doubleClick(pane, { clientX: 200, clientY: 100 });
    const [card] = nodes();
    if (!card) throw new Error('no node');
    const count = () => card.querySelector('.graph-queue-count')?.getAttribute('data-count');
    expect(count()).toBeUndefined();
    await events.doubleClick(card);
    const panel = within(screen.getByRole('dialog', { name: 'Agent 1' }));
    expect(panel.getAllByRole('button', { name: /^Move / }).map((b) => b.ariaLabel)).toEqual([
      'Move Message',
    ]);
    const message = panel.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Message to the agent',
    });
    expect(message.value).toBe('');
    await events.change(message, { target: { value: 'Fix the flaky test' } });
    expect(count()).toBeUndefined();
    await events.blur(message);
    expect(count()).toBe('1');
  });

  it('says what a step is to do in the box beside it: arguments, for a command', async () => {
    const { node } = await setup({
      nodes: [
        agentNode('a', 0, 0, {
          data: {
            label: 'a',
            queue: [
              { id: 's', action: 'Bash' },
              { id: 'c', action: '/code-review' },
            ],
          },
          selected: true,
        }),
      ],
      edges: [],
    });
    await events.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    const what = panel.getByRole<HTMLTextAreaElement>('textbox', { name: 'What Bash is to do' });
    expect(what.placeholder).toBe('What to do');
    await events.change(what, { target: { value: 'run npm test' } });
    expect(
      panel.getByRole<HTMLTextAreaElement>('textbox', { name: 'What Bash is to do' }).value,
    ).toBe('run npm test');
    expect(
      panel.getByRole<HTMLTextAreaElement>('textbox', { name: 'Arguments for /code-review' })
        .placeholder,
    ).toBe('Arguments');
  });

  it('expects a step to fail from its action, then shows it in a chip; not a slash command', async () => {
    const { node } = await setup({
      nodes: [
        agentNode('a', 0, 0, {
          data: {
            label: 'a',
            queue: [
              { id: 's', action: 'Bash' },
              { id: 'c', action: '/code-review' },
            ],
          },
          selected: true,
        }),
      ],
      edges: [],
    });
    await events.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    const chip = () =>
      panel.queryByRole('button', { name: 'Change what Bash is expected to do: fail' });
    const action = panel.getByRole('button', { name: 'Change what Bash is expected to do' });
    expect(action.textContent).toBe('Bash');
    expect(chip()).toBeNull();
    await events.click(action);
    await events.click(panel.getByRole('option', { name: /^Fail/ }));
    expect(chip()?.textContent).toBe('expect: fails');
    // A command's turn is not judged pass or fail: nothing to expect of it.
    expect(
      panel.queryByRole('button', { name: /^Change what \/code-review is expected/ }),
    ).toBeNull();
    await events.click(chip() ?? action);
    await events.click(panel.getByRole('option', { name: /^Succeed/ }));
    expect(chip()).toBeNull();
  });

  it('adds a node inside a group when double-clicking its body', async () => {
    const { nodes, node } = await setup({ nodes: [frame], edges: [] });
    await events.doubleClick(node('F'), { clientX: 100, clientY: 60 });
    expect(nodes('.react-flow__node-frame.parent')).toHaveLength(1);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('bounds in-place labels and restores a blank label before it can be saved', async () => {
    const { node, canvas } = await setup(
      { nodes: [agentNode('a', 0, 0, { selected: true })], edges: [] },
      true,
    );
    await events.keyDown(document.body, { key: 'F2' });
    expect(labelInput().maxLength).toBe(MAX_LABEL);
    await events.change(labelInput(), { target: { value: ' ' } });
    await events.keyDown(labelInput(), { key: 'Enter' });
    expect(node('a').querySelector('.graph-label')?.textContent).toContain('a');
    await events.keyDown(document.body, { key: 'F2' });
    await events.change(labelInput(), { target: { value: 'x'.repeat(MAX_LABEL + 1) } });
    await events.blur(labelInput());
    await events.click(button('Save'));
    await waitFor(() => {
      expect(canvas.files.saved).toHaveLength(1);
    });
    expect(
      fromFile(canvas.files.saved[0] ?? '', catalog(), DEFAULT_AGENT).nodes[0]?.data.label,
    ).toBe('x'.repeat(MAX_LABEL));
  });

  it('renames a node in place on F2: Enter keeps the text, Escape restores it', async () => {
    const { node } = await setup({ nodes: [agentNode('a', 0, 0, { selected: true })], edges: [] });
    await events.keyDown(document.body, { key: 'F2' });
    expect(document.activeElement).toBe(labelInput());
    await events.change(labelInput(), { target: { value: 'Alpha' } });
    await events.keyDown(labelInput(), { key: 'Enter' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(node('a').querySelector('.graph-label')?.textContent).toBe('Alpha');

    await events.keyDown(document.body, { key: 'F2' });
    await events.change(labelInput(), { target: { value: 'Beta' } });
    await events.keyDown(labelInput(), { key: 'Escape' });
    expect(node('a').querySelector('.graph-label')?.textContent).toBe('Alpha');
  });

  it('edits text instead of deleting while typing in a label', async () => {
    const { nodes } = await setup({ nodes: [agentNode('a', 0, 0, { selected: true })], edges: [] });
    await events.keyDown(document.body, { key: 'F2' });
    await events.keyDown(labelInput(), { key: 'Backspace' });
    expect(nodes()).toHaveLength(1);
  });

  it('renames a group in place on a double-click on its label bar', async () => {
    const { node } = await setup({ nodes: [frame], edges: [] });
    const title = node('F').querySelector('.graph-frame-title');
    if (!title) throw new Error('no title bar');
    await events.doubleClick(title);
    await events.change(labelInput(), { target: { value: 'Team' } });
    await events.keyDown(labelInput(), { key: 'Enter' });
    expect(node('F').querySelector('.graph-label')?.textContent).toBe('Team');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a double-clicked agent in a panel, where its queue is edited', async () => {
    const { node, nodes } = await setup({
      nodes: [agentNode('a', 0, 0), agentNode('b', 0, 100)],
      edges: [],
    });
    await events.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    /** The queue, top to bottom, by its rows' handles (an if-then's rows follow it). */
    const order = () =>
      panel.queryAllByRole('button', { name: /^Move / }).map((b) => b.getAttribute('aria-label'));
    const field = () => panel.getByRole('combobox');
    const plus = async (name = 'Add to queue') => {
      await events.click(panel.getByRole('button', { name }));
    };

    // An action of the agent (Claude's, by default), then the agent it acts on.
    await plus();
    await events.click(panel.getByRole('option', { name: /^Read / }));
    await events.keyDown(field(), { key: 'Enter' }); // this agent
    // Typing finds actions by what they do, after matches on their names: "run shell" finds Bash.
    await plus();
    await events.change(field(), { target: { value: 'run shell' } });
    await events.keyDown(field(), { key: 'Enter' });
    await events.change(field(), { target: { value: 'b' } });
    await events.keyDown(field(), { key: 'Enter' });
    expect(panel.getByRole('button', { name: 'Change the agent Bash acts on' }).textContent).toBe(
      '→ b',
    );

    // An if-then, with a message to the agent inside it.
    await plus();
    await events.click(panel.getByRole('option', { name: /^If… then/ }));
    await events.click(panel.getByRole('option', { name: 'the previous step failed' }));
    await plus('Add to If the previous step failed');
    await events.click(panel.getByRole('option', { name: /^Message/ }));
    const note = panel.getByRole('textbox', { name: 'New message to the agent' });
    await events.change(note, { target: { value: 'Try again, more carefully' } });
    await events.keyDown(note, { key: 'Enter' });
    expect(order()).toEqual([
      'Move Read',
      'Move Bash',
      'Move If the previous step failed',
      'Move Message',
    ]);
    const message = panel.getByRole<HTMLTextAreaElement>('textbox', {
      name: 'Message to the agent',
    });
    expect(message.value).toBe('Try again, more carefully');
    await events.change(message, { target: { value: 'Ask me first' } });
    expect(message.value).toBe('Ask me first');

    // Reorder from a handle (focus stays on it), retarget from a chip, remove.
    const handle = panel.getByRole('button', { name: 'Move Bash' });
    await events.keyDown(handle, { key: 'ArrowUp' });
    expect(order().slice(0, 2)).toEqual(['Move Bash', 'Move Read']);
    expect(document.activeElement).toBe(handle);
    await events.click(panel.getByRole('button', { name: 'Change the agent Read acts on' }));
    await events.click(panel.getByRole('option', { name: 'b' }));
    expect(panel.getByRole('button', { name: 'Change the agent Read acts on' }).textContent).toBe(
      '→ b',
    );
    await events.click(panel.getByRole('button', { name: 'Remove Read' }));
    expect(order()).toEqual(['Move Bash', 'Move If the previous step failed', 'Move Message']);

    // Escape closes a dropdown first, then the panel; shortcuts are off while it is open.
    await plus();
    await events.keyDown(field(), { key: 'Escape' });
    expect(panel.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
    await events.keyDown(document.body, { key: 'Delete' });
    await events.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(nodes().map((n) => n.dataset.id)).toEqual(['a', 'b']);
    expect(node('a').querySelector('.graph-queue-count')?.getAttribute('data-count')).toBe('2');
  });

  it('takes an if-then condition in your own words, for the agent to judge, and edits it', async () => {
    const { node } = await setup({ nodes: [agentNode('a', 0, 0)], edges: [] });
    await events.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    const field = () => panel.getByRole<HTMLInputElement>('combobox');
    const chip = () => panel.getByRole('button', { name: /^Change the condition: / });
    await events.click(panel.getByRole('button', { name: 'Add to queue' }));
    await events.click(panel.getByRole('option', { name: /^If… then/ }));
    await events.change(field(), { target: { value: 'the tests mention a flaky test' } });
    await events.keyDown(field(), { key: 'Enter' });
    expect(chip().textContent).toBe('the tests mention a flaky test');

    // Its chip reopens the dropdown with its words in the field, to change them.
    await events.click(chip());
    expect(field().value).toBe('the tests mention a flaky test');
    await events.change(field(), { target: { value: 'a test is flaky' } });
    await events.keyDown(field(), { key: 'Enter' });
    expect(chip().textContent).toBe('a test is flaky');
    expect(panel.getByRole('button', { name: 'Move If a test is flaky' })).toBeTruthy();
  });

  it('queues a delay, picked by typing how long, and changes it from its chip', async () => {
    const { node } = await setup({ nodes: [agentNode('a', 0, 0)], edges: [] });
    await events.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    const field = () => panel.getByRole<HTMLInputElement>('combobox');
    const options = () => panel.getAllByRole('option').map((o) => o.firstChild?.textContent);
    await events.click(panel.getByRole('button', { name: 'Add to queue' }));
    // Typing "wait" finds both ways to wait.
    await events.change(field(), { target: { value: 'wait' } });
    expect(options().slice(0, 2)).toEqual(['Wait for…', 'Wait a while…']);
    await events.click(panel.getByRole('option', { name: /^Wait a while…/ }));
    expect(field().getAttribute('aria-label')).toBe('Wait how long?');
    expect(field().placeholder).toBe('10 minutes, 1 hour, until 9:00…');
    // A Claude agent's delay can also wait for Claude's usage to reset.
    expect(options()).toEqual([
      '5 minutes',
      '10 minutes',
      '30 minutes',
      '1 hour',
      '4 hours',
      'Until 9:00 AM',
      'Until Claude’s usage resets (5-hour)',
      'Until Claude’s usage resets (weekly)',
    ]);
    // What is typed is read as the times it can mean, listed first.
    await events.change(field(), { target: { value: '15' } });
    expect(options()).toEqual(['15 minutes', '15 hours', '15 seconds', 'Until 3:00 PM']);
    await events.click(panel.getByRole('option', { name: '15 minutes' }));
    expect(panel.getByRole('button', { name: 'Move Wait 15 minutes' })).toBeTruthy();

    // Its chip reopens the picker with its time typed in, to change it.
    const chip = () => panel.getByRole('button', { name: /^Change how long it waits: / });
    expect(chip().textContent).toBe('15 minutes');
    await events.click(chip());
    expect(field().value).toBe('15 minutes');
    await events.change(field(), { target: { value: '1h30' } });
    await events.keyDown(field(), { key: 'Enter' });
    expect(chip().getAttribute('aria-label')).toBe('Change how long it waits: 1 hour 30 minutes');
    expect(panel.getByRole('button', { name: 'Move Wait 1 hour 30 minutes' })).toBeTruthy();
  });

  it("gives a wait a time limit from its 'at most…' chip, and takes it off again", async () => {
    const queue = [{ id: 'w', waitFor: [{ agent: 'a' }] }];
    const { node } = await setup({
      nodes: [agentNode('a', 0, 0), agentNode('b', 0, 100, { data: { label: 'b', queue } })],
      edges: [],
    });
    await events.doubleClick(node('b'));
    const panel = within(screen.getByRole('dialog', { name: 'b' }));
    const add = panel.getByRole('button', { name: 'Add a time limit' });
    expect([add.textContent, add.title, add.hasAttribute('data-more')]).toEqual([
      'at most…',
      'Go on anyway if it is not done in time',
      true,
    ]);
    await events.click(add);
    expect(panel.getByRole('combobox').getAttribute('aria-label')).toBe('Go on anyway after…');
    await events.click(panel.getByRole('option', { name: '30 minutes' }));
    const limit = panel.getByRole('button', { name: 'Change the time limit: at most 30 minutes' });
    expect(limit.textContent).toBe('at most 30 minutes');
    expect(panel.getByRole('button', { name: 'Move Wait for a, at most 30 minutes' })).toBeTruthy();
    expect(panel.queryByRole('button', { name: 'Add a time limit' })).toBeNull();

    // Its chip offers to take it off first.
    await events.click(limit);
    expect(panel.getAllByRole('option')[0]?.textContent).toBe('No time limit');
    await events.click(panel.getByRole('option', { name: 'No time limit' }));
    expect(panel.getByRole('button', { name: 'Move Wait for a' })).toBeTruthy();
    expect(panel.getByRole('button', { name: 'Add a time limit' })).toBeTruthy();
  });

  it('checks whether a wait ran out of time, striking the condition out where no wait is before it', async () => {
    const { node } = await setup({
      nodes: [
        agentNode('a', 0, 0, { data: { label: 'a', queue: [{ id: 'm', message: 'Build it' }] } }),
        agentNode('b', 0, 100, {
          data: {
            label: 'b',
            queue: [
              { id: 'w', waitFor: [{ agent: 'a' }], timeout: { seconds: 60 } },
              { id: 'd', delay: { seconds: 60 } },
              { id: 'late', if: { kind: 'timedOut' }, then: [] },
            ],
          },
        }),
      ],
      edges: [],
    });
    await events.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    await events.click(panel.getByRole('button', { name: 'Add to queue' }));
    await events.click(panel.getByRole('option', { name: /^If… then/ }));
    expect(panel.getAllByRole('option').map((o) => o.firstChild?.textContent)).toEqual([
      'the previous step succeeded',
      'the previous step failed',
      'the output contains…',
      'the wait ran out of time',
      // A Claude agent's If can check Claude's usage.
      'Claude’s usage is over…',
    ]);
    await events.click(panel.getByRole('option', { name: 'the wait ran out of time' }));
    // After a message, there is no wait to run out of time.
    const chip = panel.getByRole('button', {
      name: 'Change the condition: the wait ran out of time',
    });
    expect(chip.hasAttribute('data-unavailable')).toBe(true);
    expect(chip.title).toBe('No wait right before this If');

    // After a wait, it can hold: a delay between the two is passed over.
    await events.click(panel.getByRole('button', { name: 'Back to the canvas' }));
    await events.doubleClick(node('b'));
    const other = within(screen.getByRole('dialog', { name: 'b' }));
    const fits = other.getByRole('button', {
      name: 'Change the condition: the wait ran out of time',
    });
    expect(fits.hasAttribute('data-unavailable')).toBe(false);
    expect(fits.title).toBe('');
  });

  it('queues your OK on the work before it, or on what you name, and changes it from its chip', async () => {
    const { node } = await setup({ nodes: [agentNode('a', 0, 0)], edges: [] });
    await events.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    const field = () => panel.getByRole<HTMLInputElement>('combobox');
    const options = () => panel.getAllByRole('option').map((o) => o.firstChild?.textContent);
    const plus = async (name = 'Add to queue') => {
      await events.click(panel.getByRole('button', { name }));
    };
    // Typing "wait", "ok" or "approve" finds it.
    await plus();
    await events.change(field(), { target: { value: 'wait' } });
    expect(options().slice(0, 3)).toEqual(['Wait for…', 'Wait a while…', 'Wait for your OK…']);
    for (const typed of ['ok', 'approve']) {
      await events.change(field(), { target: { value: typed } });
      expect(options()[0]).toBe('Wait for your OK…');
    }
    const choice = panel.getByRole('option', { name: /^Wait for your OK…/ });
    expect(choice.textContent).toBe(
      'Wait for your OK… Hold here until you approve, ask for changes, or stop',
    );
    await events.click(choice);
    expect(field().getAttribute('aria-label')).toBe('Your OK on…');
    expect(field().placeholder).toBe('What you check, e.g. the spec in SPEC.md…');
    expect(options()).toEqual(['The work before it']);
    await events.click(panel.getByRole('option', { name: 'The work before it' }));
    expect(panel.getByRole('button', { name: 'Move Your OK on the work before it' })).toBeTruthy();

    // Or on what you name, in your own words.
    await plus();
    await events.click(panel.getByRole('option', { name: /^Wait for your OK…/ }));
    await events.change(field(), { target: { value: 'the spec in SPEC.md' } });
    expect(panel.getAllByRole('option').map((o) => o.textContent)).toEqual([
      '“the spec in SPEC.md” In your own words',
    ]);
    await events.keyDown(field(), { key: 'Enter' });
    const chip = () => panel.getByRole('button', { name: /^Change what you OK: the spec/ });
    expect(chip().getAttribute('aria-label')).toBe('Change what you OK: the spec in SPEC.md');
    expect(chip().textContent).toBe('the spec in SPEC.md');
    expect(chip().closest('.graph-queue-row')?.getAttribute('data-mark')).toBe('ok');

    // Its chip reopens the picker with its words in the field.
    await events.click(chip());
    expect(field().value).toBe('the spec in SPEC.md');
    await events.change(field(), { target: { value: 'the spec in SPEC.md and its tests' } });
    await events.keyDown(field(), { key: 'Enter' });
    expect(chip().textContent).toBe('the spec in SPEC.md and its tests');

    // An if-then holds steps and messages, not OKs.
    await plus();
    await events.click(panel.getByRole('option', { name: /^If… then/ }));
    await events.click(panel.getByRole('option', { name: 'the previous step failed' }));
    await plus('Add to If the previous step failed');
    expect(options()).not.toContain('Wait for your OK…');
    expect(options()).toContain('Message');
  });

  it('repeats steps until a condition holds, a few rounds at most, changed from its chips', async () => {
    const { node } = await setup({ nodes: [agentNode('a', 0, 0)], edges: [] });
    await events.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    const field = () => panel.getByRole<HTMLInputElement>('combobox');
    const options = () => panel.getAllByRole('option').map((o) => o.firstChild?.textContent);
    const plus = async (name = 'Add to queue') => {
      await events.click(panel.getByRole('button', { name }));
    };
    // Offered right after If… then; "repeat", "loop" or "round" finds it.
    await plus();
    expect(options().slice(0, 6)).toEqual([
      'If… then',
      'Repeat until…',
      'Wait for…',
      'Wait a while…',
      'Wait for your OK…',
      'Message',
    ]);
    for (const typed of ['repeat', 'loop', 'round']) {
      await events.change(field(), { target: { value: typed } });
      expect(options()[0]).toBe('Repeat until…');
    }
    const choice = panel.getByRole('option', { name: /^Repeat until…/ });
    expect(choice.textContent).toBe(
      'Repeat until… Loop: run steps again until a condition holds, a few rounds at most',
    );
    await events.click(choice);
    expect(field().getAttribute('aria-label')).toBe('Repeat until…');
    expect(field().placeholder).toBe('Pick when to stop, or describe it…');
    expect(options()).toEqual([
      'its last step succeeds',
      'its last step fails',
      'the output contains…',
    ]);
    await events.click(panel.getByRole('option', { name: 'the output contains…' }));
    const text = panel.getByRole('textbox', { name: 'Text to look for' });
    await events.change(text, { target: { value: 'Converged' } });
    await events.keyDown(text, { key: 'Enter' });

    // A card: when it stops, up to 3 rounds, then ask me; each a chip.
    expect(
      panel.getByRole('button', { name: 'Move Repeat until the output contains “Converged”' }),
    ).toBeTruthy();
    const until = panel.getByRole('button', {
      name: 'Change when it stops: the output contains “Converged”',
    });
    expect(until.textContent).toBe('the output contains “Converged”');
    const rounds = () => panel.getByRole('button', { name: /^Change how many rounds: / });
    const then = () =>
      panel.getByRole('button', { name: /^Change what happens after the last round: / });
    expect([rounds().textContent, then().textContent]).toEqual(['up to 3 rounds', 'then ask me']);

    // Typing 5 finds 5 rounds; Go on carries on with the queue.
    await events.click(rounds());
    expect(field().getAttribute('aria-label')).toBe('How many rounds at most?');
    expect(options()).toHaveLength(20);
    await events.change(field(), { target: { value: '5' } });
    expect(options()[0]).toBe('5 rounds');
    await events.keyDown(field(), { key: 'Enter' });
    expect(rounds().getAttribute('aria-label')).toBe('Change how many rounds: up to 5 rounds');
    await events.click(then());
    expect(panel.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Ask me Stop and ask: one more round, or go on',
      'Go on Carry on with the queue; an If after it sees that it failed',
    ]);
    await events.click(panel.getByRole('option', { name: /^Go on/ }));
    expect(then().getAttribute('aria-label')).toBe(
      'Change what happens after the last round: then go on',
    );
    expect(then().textContent).toBe('then go on');

    // Its own ⊕ adds what it runs each round: waits, delays, messages and actions; no if-thens.
    await plus('Add to Repeat until the output contains “Converged”');
    expect(options().slice(0, 4)).toEqual(['Wait for…', 'Wait a while…', 'Message', 'Read']);
    expect(options()).not.toContain('If… then');
    expect(options()).not.toContain('Repeat until…');
    expect(options()).not.toContain('Wait for your OK…');
    await events.click(panel.getByRole('option', { name: /^Message/ }));
    const note = panel.getByRole('textbox', { name: 'New message to the agent' });
    await events.change(note, { target: { value: 'Tune the model' } });
    await events.keyDown(note, { key: 'Enter' });
    const inner = panel.getByRole('list', { name: 'Each round: the output contains “Converged”' });
    expect(
      within(inner)
        .getAllByRole('button', { name: /^Move / })
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Move Message']);

    // Its condition, in your own words, is changed starting from them.
    await events.click(until);
    await events.change(field(), { target: { value: 'the loss stops falling' } });
    await events.keyDown(field(), { key: 'Enter' });
    const words = panel.getByRole('button', { name: /^Change when it stops: / });
    expect(words.textContent).toBe('the loss stops falling');
    await events.click(words);
    expect(field().value).toBe('the loss stops falling');
  });

  it("goes round with another agent's repeat, and waits for a step inside one, round by round", async () => {
    const judging = {
      id: 'judging',
      repeat: [{ id: 'judge', message: 'Judge both versions' }],
      until: { kind: 'outputContains' as const, text: 'WINNER' },
      rounds: 2,
      otherwise: 'goOn' as const,
    };
    const { node } = await setup({
      nodes: [
        agentNode('j', 0, 0, { data: { label: 'Judge', queue: [judging] } }),
        agentNode('c', 0, 100, { data: { label: 'Claude', queue: [] } }),
      ],
      edges: [],
    });
    await events.doubleClick(node('c'));
    const panel = within(screen.getByRole('dialog', { name: 'Claude' }));
    const plus = async (name = 'Add to queue') => {
      await events.click(panel.getByRole('button', { name }));
    };
    await plus();
    await events.click(panel.getByRole('option', { name: /^Repeat until…/ }));
    // Another agent's repeat, after the conditions: go round with it.
    const leader = panel.getByRole('option', { name: /^Judge's repeat ends/ });
    expect(leader.textContent).toBe(
      "Judge's repeat ends Go round with it: as many rounds as Judge's repeat",
    );
    await events.click(leader);
    // It runs as many rounds as the judge's: its own are not shown.
    expect(
      panel.getByRole('button', { name: "Change when it stops: Judge's repeat ends" }),
    ).toBeTruthy();
    expect(panel.queryByRole('button', { name: /^Change how many rounds/ })).toBeNull();
    expect(panel.queryByRole('button', { name: /^Change what happens after/ })).toBeNull();

    // A wait inside it, for a step inside the judge's repeat, picked in the judge's queue beside.
    await plus("Add to Repeat until Judge's repeat ends");
    await events.click(panel.getByRole('option', { name: /^Wait for…/ }));
    await events.click(panel.getByRole('option', { name: 'Judge' }));
    const beside = within(panel.getByRole('complementary', { name: "Judge's queue" }));
    await events.click(
      beside.getByRole('button', { name: 'Wait for Judge: “Judge both versions”' }),
    );
    expect(
      panel.getByRole('button', { name: 'Move Wait for Judge: “Judge both versions”' }),
    ).toBeTruthy();

    // The judge's repeat names who goes round with it.
    expect(beside.getByText('Claude goes round with it')).toBeTruthy();
    // Its own waits are offered the steps inside Claude's repeat: each round inside a repeat, and
    // once that repeat is over outside one.
    const choices = () => beside.getAllByRole('option').map((o) => o.textContent);
    await events.click(
      beside.getByRole('button', { name: 'Add to Repeat until the output contains “WINNER”' }),
    );
    await events.click(beside.getByRole('option', { name: /^Wait for…/ }));
    expect(choices()).toEqual([
      'Claude All of its work',
      'Claude: its repeat All of its rounds',
      'Claude: its wait This step, each round',
    ]);
    await events.keyDown(beside.getByRole('combobox'), { key: 'Escape' });
    await events.click(beside.getByRole('button', { name: "Add to Judge's queue" }));
    await events.click(beside.getByRole('option', { name: /^Wait for…/ }));
    expect(choices().at(-1)).toBe('Claude: its wait This step, once its repeat is over');
    await events.keyDown(beside.getByRole('combobox'), { key: 'Escape' });

    // Claude's repeat goes round with the judge's, so it is not offered back to the judge.
    await events.click(beside.getByRole('button', { name: /^Change when it stops/ }));
    expect(beside.getAllByRole('option').map((o) => o.firstChild?.textContent)).toEqual([
      'its last step succeeds',
      'its last step fails',
      'the output contains…',
    ]);
  });

  it('asks for your OK on the canvas while the run holds an agent at one', async () => {
    const queue = (approve: string) => [
      { id: 'spec', action: 'Read' },
      { id: 'ok', approve },
      { id: 'next', action: 'Grep' },
    ];
    const { node, canvas } = await setup({
      nodes: [
        agentNode('a', 0, 0, { data: { label: 'Planner', queue: queue('the spec in SPEC.md') } }),
        agentNode('b', 0, 100, { data: { label: 'Builder', queue: queue('') } }),
        agentNode('c', 0, 200, { data: { label: 'Tester', queue: queue('the tests') } }),
      ],
      edges: [],
    });
    const sidebar = () => screen.queryByRole('complementary', { name: 'Needs you' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await events.click(screen.getByRole('button', { name: 'Show all queues' }));
    await events.click(screen.getByRole('button', { name: 'Run' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    const agents = {
      a: { current: 'ok', status: 'asking' as const, outcomes: { spec: 'succeeded' as const } },
      b: { current: 'ok', status: 'asking' as const, outcomes: { spec: 'succeeded' as const } },
      c: { current: 'ok', status: 'asking' as const, outcomes: { spec: 'succeeded' as const } },
    };
    act(() => {
      canvas.run({ running: true, agents });
    });
    await events.click(screen.getByRole('button', { name: 'Back' }));
    expect(['a', 'b', 'c'].map((id) => node(id).classList.contains('asking'))).toEqual([
      true,
      true,
      true,
    ]);

    // The sidebar asks for each, in graph order, after the work it is on.
    await events.click(screen.getByRole('button', { name: 'Needs you' }));
    const list = within(sidebar() ?? document.body);
    expect(list.getByRole('heading').textContent).toBe('Needs you 3');
    const card = (agent: string) => {
      const chip = list.getByRole('button', { name: `Open ${agent}` });
      const found = chip.closest<HTMLElement>('.graph-question');
      if (!found) throw new Error(`no card for ${agent}`);
      return within(found);
    };
    expect(card('Planner').getByText('Your OK on the spec in SPEC.md?')).toBeTruthy();
    expect(card('Planner').getByText('After Read')).toBeTruthy();
    expect(card('Builder').getByText('Your OK on the work before it?')).toBeTruthy();

    // Approve, Stop here and Ask for changes act on the run; each card then leaves.
    await events.click(card('Planner').getByRole('button', { name: 'Approve' }));
    act(() => {
      canvas.run({
        running: true,
        agents: {
          ...agents,
          a: {
            current: 'next',
            status: 'running',
            outcomes: { spec: 'succeeded', ok: 'succeeded' },
          },
        },
      });
    });
    await events.click(card('Builder').getByRole('button', { name: 'Stop here' }));
    const after = {
      ...agents,
      a: {
        current: 'next',
        status: 'running' as const,
        outcomes: { spec: 'succeeded' as const, ok: 'succeeded' as const },
      },
      b: {
        current: 'ok',
        status: 'stopped' as const,
        outcomes: { spec: 'succeeded' as const, ok: 'stopped' as const },
      },
    };
    act(() => {
      canvas.run({ running: true, agents: after });
    });
    const reply = card('Tester').getByRole('textbox', { name: 'What should change?' });
    await events.change(reply, { target: { value: 'Test the empty state' } });
    await events.pointerDown(document.body);
    expect(sidebar()).toBeNull();
    await events.click(screen.getByRole('button', { name: 'Needs you' }));
    expect(reply).toHaveProperty('value', 'Test the empty state');
    await events.click(card('Tester').getByRole('button', { name: 'Ask for changes' }));
    act(() => {
      canvas.run({
        running: true,
        agents: {
          ...after,
          c: {
            current: 'ok',
            status: 'running',
            outcomes: { spec: 'succeeded' },
            changes: { ok: ['Test the empty state'] },
          },
        },
      });
      canvas.session('c', { ...NEW_SESSION, status: 'working' });
    });
    expect(sidebar()).toBeNull();
    expect(['a', 'b', 'c'].map((id) => node(id).classList.contains('asking'))).toEqual([
      false,
      false,
      false,
    ]);
    // The Tester works on the changes asked for, in its session.
    expect(node('c').classList.contains('working')).toBe(true);
    await events.click(screen.getByRole('button', { name: 'Show all queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    const run = (name: string) =>
      queues.getByRole('group', { name }).querySelector('[data-run]')?.getAttribute('data-run');
    expect(run('Planner: Your OK on the spec in SPEC.md')).toBe('succeeded');
    expect(run('Planner: Grep')).toBe('running');
    expect(run('Builder: Your OK on the work before it')).toBe('stopped');
    expect(run('Tester: Your OK on the tests')).toBe('running');
  });

  it('shows a usage gauge per backend, with its rule and Simulate usage…, and holds the run by it', async () => {
    const { node, canvas } = await setup({
      nodes: [
        agentNode('a', 0, 0, {
          data: {
            label: 'Builder',
            queue: [
              { id: 'one', action: 'Edit' },
              { id: 'two', action: 'Bash' },
            ],
          },
        }),
        agentNode('x', 0, 100, { data: { label: 'Coder', adapter: 'codex' } }),
        agentNode('g', 0, 200, { data: { label: 'Writer', adapter: 'gemini' } }),
      ],
      edges: [],
    });
    // A gauge for each backend the agents use whose usage corrallm reads.
    const gauge = (backend: string) =>
      screen.getByRole('button', { name: new RegExp(`^${backend} usage:`) });
    expect(gauge('Claude').getAttribute('aria-label')).toBe('Claude usage: no reading');
    expect(gauge('Codex').getAttribute('aria-label')).toBe('Codex usage: no reading');
    expect(screen.queryByRole('button', { name: /^Gemini usage/ })).toBeNull();

    // Its panel: no reading yet, where readings come from, and the rule, set from chips.
    await events.click(gauge('Claude'));
    const dialog = screen.getByRole('dialog', { name: 'Claude usage' });
    const panel = within(dialog);
    expect(panel.getByText('Not read yet')).toBeTruthy();
    expect(panel.getByText(/Read from Claude Code’s status line/)).toBeTruthy();
    await events.click(panel.getByRole('button', { name: 'Add a rule…' }));
    await events.click(panel.getByRole('option', { name: /^Pause and ask me/ }));
    await events.click(panel.getByRole('button', { name: 'Change the share: 80%' }));
    await events.change(panel.getByRole('combobox'), { target: { value: '90' } });
    await events.keyDown(panel.getByRole('combobox'), { key: 'Enter' });
    expect(panel.getByRole('button', { name: 'Change the share: 90%' })).toBeTruthy();
    expect(
      panel.getByRole('button', { name: 'Change what happens: Pause and ask me' }),
    ).toBeTruthy();

    // Simulated usage, to try it: the gauge fills, amber past the rule's share.
    await events.click(panel.getByRole('button', { name: 'Simulate usage…' }));
    await events.change(panel.getByRole('textbox', { name: '5-hour window: share used (%)' }), {
      target: { value: '95' },
    });
    await events.click(panel.getByRole('button', { name: 'Simulate' }));
    expect(gauge('Claude').getAttribute('aria-label')).toBe(
      'Claude usage: 95% of 5-hour window, 30% of weekly window',
    );
    expect(gauge('Claude').hasAttribute('data-over')).toBe(true);
    expect(panel.getByText(/^Simulated /)).toBeTruthy();
    await events.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Claude usage' })).toBeNull();

    // Run: the Builder is held before its first task, and asked about on the canvas.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await events.click(screen.getByRole('button', { name: 'Show all queues' }));
    const queues = within(screen.getByRole('dialog', { name: 'All queues' }));
    // All queues shows the gauges too.
    expect(queues.getByRole('button', { name: /^Claude usage:/ })).toBeTruthy();
    await events.click(queues.getByRole('button', { name: 'Run' }));
    act(() => {
      canvas.run({
        running: true,
        agents: {
          a: {
            current: 'one',
            status: 'asking',
            outcomes: {},
            usage: {
              backend: 'claude-code',
              window: 'fiveHour',
              percent: 90,
              used: 95,
              resetsAt: Date.now() + 60000,
            },
          },
        },
      });
    });
    const row = queues.getByRole('group', { name: 'Builder: Edit' });
    expect(row.querySelector('[data-run]')?.getAttribute('data-run')).toBe('asking');
    expect(
      within(row).getByText('Claude has used 95% of its 5-hour window (over 90%)'),
    ).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Wait for the reset' })).toBeTruthy();
    expect(queues.getByRole('button', { name: 'Decide for Builder' }).title).toBe(
      'Builder: Claude has used 95% of its 5-hour window (over 90%)',
    );
    await events.click(queues.getByRole('button', { name: 'Back' }));
    expect(node('a').classList.contains('asking')).toBe(true);
    await events.click(screen.getByRole('button', { name: 'Needs you' }));
    const sidebar = within(screen.getByRole('complementary', { name: 'Needs you' }));
    expect(
      sidebar.getByText('Claude has used 95% of its 5-hour window (over 90%). Go on?'),
    ).toBeTruthy();
    await events.click(sidebar.getByRole('button', { name: 'Go on' }));
    act(() => {
      canvas.run({
        running: true,
        agents: { a: { current: 'one', status: 'running', outcomes: {} } },
      });
    });
    expect(screen.queryByRole('complementary', { name: 'Needs you' })).toBeNull();
    expect(node('a').classList.contains('asking')).toBe(false);
  });

  it("checks a Claude agent's usage in an If, and waits for its window to reset", async () => {
    const { node } = await setup({
      nodes: [
        agentNode('a', 0, 0),
        agentNode('g', 0, 100, { data: { label: 'g', adapter: 'gemini' } }),
      ],
      edges: [],
    });
    await events.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    const options = () => panel.getAllByRole('option').map((o) => o.firstChild?.textContent);
    await events.click(panel.getByRole('button', { name: 'Add to queue' }));
    await events.click(panel.getByRole('option', { name: /^If… then/ }));
    await events.click(panel.getByRole('option', { name: /^Claude’s usage is over…/ }));
    // The share is typed; each window is offered for it.
    await events.change(panel.getByRole('combobox', { name: 'Claude’s usage is over…' }), {
      target: { value: '85' },
    });
    expect(options().slice(0, 2)).toEqual([
      'Over 85% of the 5-hour window',
      'Over 85% of the weekly window',
    ]);
    await events.click(panel.getByRole('option', { name: 'Over 85% of the weekly window' }));
    expect(
      panel.getByRole('button', { name: 'Move If Claude’s usage is over 85% (weekly)' }),
    ).toBeTruthy();

    await events.click(panel.getByRole('button', { name: 'Add to queue' }));
    await events.click(panel.getByRole('option', { name: /^Wait a while…/ }));
    await events.click(panel.getByRole('option', { name: 'Until Claude’s usage resets (5-hour)' }));
    expect(
      panel.getByRole('button', {
        name: 'Change how long it waits: until Claude’s usage resets (5-hour)',
      }),
    ).toBeTruthy();
    await events.click(panel.getByRole('button', { name: 'Back to the canvas' }));

    // A Gemini agent's usage is not read: neither is offered.
    await events.doubleClick(node('g'));
    const other = within(screen.getByRole('dialog', { name: 'g' }));
    await events.click(other.getByRole('button', { name: 'Add to queue' }));
    await events.click(other.getByRole('option', { name: /^If… then/ }));
    expect(other.queryByRole('option', { name: /usage/ })).toBeNull();
  });

  it("checks a Codex agent's usage in an If and a wait; its gauge says where readings come from", async () => {
    const { node } = await setup({
      nodes: [agentNode('x', 0, 0, { data: { label: 'Coder', adapter: 'codex' } })],
      edges: [],
    });
    await events.click(screen.getByRole('button', { name: 'Codex usage: no reading' }));
    const gauge = within(screen.getByRole('dialog', { name: 'Codex usage' }));
    expect(gauge.getByText(/Read from Codex’s app server/)).toBeTruthy();
    await events.keyDown(screen.getByRole('dialog', { name: 'Codex usage' }), { key: 'Escape' });

    await events.doubleClick(node('x'));
    const panel = within(screen.getByRole('dialog', { name: 'Coder' }));
    await events.click(panel.getByRole('button', { name: 'Add to queue' }));
    await events.click(panel.getByRole('option', { name: /^If… then/ }));
    await events.click(panel.getByRole('option', { name: /^Codex’s usage is over…/ }));
    await events.change(panel.getByRole('combobox', { name: 'Codex’s usage is over…' }), {
      target: { value: '80' },
    });
    await events.click(panel.getByRole('option', { name: 'Over 80% of the 5-hour window' }));
    expect(
      panel.getByRole('button', { name: 'Move If Codex’s usage is over 80% (5-hour)' }),
    ).toBeTruthy();
    await events.click(panel.getByRole('button', { name: 'Add to queue' }));
    await events.click(panel.getByRole('option', { name: /^Wait a while…/ }));
    await events.click(panel.getByRole('option', { name: 'Until Codex’s usage resets (weekly)' }));
    expect(
      panel.getByRole('button', {
        name: 'Change how long it waits: until Codex’s usage resets (weekly)',
      }),
    ).toBeTruthy();
  });

  it('offers an agent whose connection spends no usage backend no usage condition or reset', async () => {
    // An Agent SDK agent runs on an API key: its connection declares no usage backend.
    const { node } = await setup({
      nodes: [agentNode('s', 0, 0, { data: { label: 'Keyed', connection: 'claude-code.sdk' } })],
      edges: [],
    });
    await events.doubleClick(node('s'));
    const panel = within(screen.getByRole('dialog', { name: 'Keyed' }));
    const options = () => panel.getAllByRole('option').map((o) => o.firstChild?.textContent);
    // Neither the queue's own ⊕ nor the one above its message box.
    for (const add of ['Add to queue', 'Queue something']) {
      await events.click(panel.getByRole('button', { name: add }));
      await events.click(panel.getByRole('option', { name: /^If… then/ }));
      expect(options()).toEqual([
        'the previous step succeeded',
        'the previous step failed',
        'the output contains…',
        'the wait ran out of time',
      ]);
      await events.keyDown(panel.getByRole('combobox'), { key: 'Escape' });
      await events.click(panel.getByRole('button', { name: add }));
      await events.click(panel.getByRole('option', { name: /^Wait a while…/ }));
      expect(options()).toEqual([
        '5 minutes',
        '10 minutes',
        '30 minutes',
        '1 hour',
        '4 hours',
        'Until 9:00 AM',
      ]);
      await events.keyDown(panel.getByRole('combobox'), { key: 'Escape' });
    }
  });

  it('keeps a usage condition and reset an agent spending no usage backend has, editable', async () => {
    // Written while it ran in a Terminal, or shared in a file: each still names its backend.
    const queue: QueueItem[] = [
      {
        id: 'high',
        if: { kind: 'usageAbove', backend: 'claude-code', window: 'fiveHour', percent: 80 },
        then: [],
      },
      { id: 'reset', delay: { resets: 'weekly', backend: 'claude-code' } },
    ];
    const { node } = await setup({
      nodes: [
        agentNode('s', 0, 0, { data: { label: 'Keyed', connection: 'claude-code.sdk', queue } }),
      ],
      edges: [],
    });
    await events.doubleClick(node('s'));
    const panel = within(screen.getByRole('dialog', { name: 'Keyed' }));
    const options = () => panel.getAllByRole('option').map((o) => o.firstChild?.textContent);
    const field = () => panel.getByRole<HTMLInputElement>('combobox');

    await events.click(
      panel.getByRole('button', {
        name: 'Change the condition: Claude’s usage is over 80% (5-hour)',
      }),
    );
    await events.click(panel.getByRole('option', { name: /^Claude’s usage is over…/ }));
    expect(field().value).toBe('80%');
    await events.change(field(), { target: { value: '90 weekly' } });
    await events.click(panel.getByRole('option', { name: 'Over 90% of the weekly window' }));
    expect(
      panel.getByRole('button', {
        name: 'Change the condition: Claude’s usage is over 90% (weekly)',
      }),
    ).toBeTruthy();

    await events.click(
      panel.getByRole('button', {
        name: 'Change how long it waits: until Claude’s usage resets (weekly)',
      }),
    );
    expect(field().value).toBe('until Claude’s usage resets (weekly)');
    expect(options()).toEqual(['Until Claude’s usage resets (weekly)']);
    // Its own backend's other window too.
    await events.change(field(), { target: { value: 'resets' } });
    expect(options()).toEqual([
      'Until Claude’s usage resets (5-hour)',
      'Until Claude’s usage resets (weekly)',
    ]);
    await events.click(panel.getByRole('option', { name: 'Until Claude’s usage resets (5-hour)' }));
    expect(
      panel.getByRole('button', {
        name: 'Change how long it waits: until Claude’s usage resets (5-hour)',
      }),
    ).toBeTruthy();
  });

  it("offers a Claude agent Claude Code's own tools, Workflow included", async () => {
    const { node } = await setup({ nodes: [agentNode('a', 0, 0)], edges: [] });
    await events.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    await events.click(panel.getByRole('button', { name: 'Add to queue' }));
    await events.change(panel.getByRole('combobox'), { target: { value: 'workflow' } });
    expect(panel.getAllByRole('option')[0]?.firstChild?.textContent).toBe('Workflow');
  });

  it("shows each node's agent type, and changes it from the node's panel", async () => {
    const { node } = await setup({
      nodes: [
        agentNode('a', 0, 0, { data: { label: 'a', adapter: 'codex' } }),
        agentNode('b', 0, 100),
      ],
      edges: [],
    });
    const tag = (id: string) => node(id).querySelector('.graph-card')?.getAttribute('data-agent');
    expect([tag('a'), tag('b')]).toEqual(['codex', 'claude-code']);
    expect(node('a').getAttribute('aria-label')).toBe('a, Codex · Terminal');

    await events.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    await events.click(panel.getByRole('button', { name: 'Agent: Codex · Terminal' }));
    expect(panel.queryByRole('option', { name: /qwen/i })).toBeNull();
    expect(panel.queryByRole('option', { name: /Simulated/ })).toBeNull();
    await events.click(panel.getByRole('option', { name: /^Claude · Agent SDK/ }));
    expect(tag('a')).toBe('claude-code');
    expect(await panel.findByRole('button', { name: 'Agent: Claude · Agent SDK' })).toBeTruthy();
  });

  it('opens only a double-clicked node that is part of a multi-selection', async () => {
    const { node, nodes } = await setup({
      nodes: [agentNode('a', 0, 0, { selected: true }), agentNode('b', 0, 100, { selected: true })],
      edges: [],
    });
    await events.doubleClick(node('a'));
    expect(nodes('.react-flow__node.selected').map((n) => n.dataset.id)).toEqual(['a']);
    expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();
  });

  it("groups a selection from its actions, and ungroups from the group's", async () => {
    const { nodes } = await setup({
      nodes: [agentNode('a', 0, 0, { selected: true }), agentNode('b', 0, 100, { selected: true })],
      edges: [],
    });
    await events.click(actions('a b').getByRole('button', { name: 'Group' }));
    const [group] = nodes('.react-flow__node-frame');
    expect(group?.textContent).toBe('Group 1');
    expect(group?.classList.contains('selected')).toBe(true);

    const title = group?.querySelector('.graph-frame-title');
    if (!title) throw new Error('no title bar');
    await events.mouseEnter(title);
    await events.click(actions(group?.dataset.id ?? '').getByRole('button', { name: 'Ungroup' }));
    expect(nodes('.react-flow__node-frame')).toHaveLength(0);
    expect(nodes('.react-flow__node.selected').map((n) => n.dataset.id)).toEqual(['a', 'b']);
  });

  it('groups with the keyboard shortcut', async () => {
    const { nodes } = await setup({
      nodes: [agentNode('a', 0, 0, { selected: true }), agentNode('b', 0, 100, { selected: true })],
      edges: [],
    });
    await events.keyDown(document.body, { key: 'g', code: 'KeyG', ctrlKey: true });
    expect(nodes('.react-flow__node-frame').map((n) => n.textContent)).toEqual(['Group 1']);
  });

  it("cannot group nodes from different groups, and the selection's Group button says why", async () => {
    await setup({
      nodes: [
        frame,
        agentNode('a', 20, 52, { parentId: 'F', selected: true }),
        agentNode('b', 500, 0, { selected: true }),
      ],
      edges: [],
    });
    const group = actions('a b').getByRole<HTMLButtonElement>('button', { name: 'Group' });
    expect(group.disabled).toBe(true);
    expect(group.title).toBe('Only agents in the same group can be grouped');
  });

  it("gives a group a parent node from the '+' on its top border", async () => {
    const { node, nodes } = await setup({
      nodes: [frame, agentNode('a', 20, 52, { parentId: 'F' })],
      edges: [],
    });
    await events.click(button('Add a parent agent'));
    expect(nodes('.react-flow__node-agent.parent').map((n) => n.dataset.id)).toEqual(['F']);
    expect(node('F').querySelector('.graph-label')?.textContent).toBe('Agent 1');
    expect(node('F').classList.contains('selected')).toBe(true);
  });

  it("shows a node's actions on hover: Delete, and Remove from group inside a group", async () => {
    const { node, nodes } = await setup({
      nodes: [frame, agentNode('a', 20, 52, { parentId: 'F' }), agentNode('b', 500, 0)],
      edges: [],
    });
    const card = (id: string) => node(id).querySelector('.graph-card') ?? node(id);
    await events.mouseEnter(card('a'));
    await events.click(actions('a').getByRole('button', { name: 'Remove from group' }));
    expect(nodes('.react-flow__node.parent')).toHaveLength(0);

    await events.mouseEnter(card('b'));
    await events.click(actions('b').getByRole('button', { name: 'Delete' }));
    expect(nodes().map((n) => n.dataset.id)).toEqual(['F', 'a']);
  });

  it("colours each group's nodes, and gives a new group the next colour", async () => {
    const { node } = await setup({
      nodes: [
        { ...frame, data: { label: 'Group 1', color: 0 } },
        agentNode('a', 20, 52, { parentId: 'F' }),
        agentNode('b', 500, 0, { selected: true }),
        agentNode('c', 500, 100, { selected: true }),
      ],
      edges: [],
    });
    const color = (id: string) => /group-color-(\d+)/.exec(node(id).className)?.[1];
    expect([color('F'), color('a'), color('b')]).toEqual(['0', '0', undefined]);
    await events.keyDown(document.body, { key: 'g', code: 'KeyG', ctrlKey: true });
    expect([color('b'), color('c')]).toEqual(['1', '1']);
  });

  it('arranges the graph while the toggle is on, and lets nodes be dragged again when off', async () => {
    const { node } = await setup({
      nodes: [agentNode('a', 300, 300), agentNode('b', 0, 0)],
      edges: [{ id: 'a->b', source: 'a', target: 'b' }],
    });
    const y = (id: string) =>
      Number(/translate\([^,]+,\s*([-\d.]+)px\)/.exec(node(id).style.transform)?.[1]);
    const toggle = button('Arrange automatically');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(y('a')).toBeGreaterThan(y('b'));

    await events.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(y('a')).toBeLessThan(y('b'));
    expect(node('a').classList.contains('draggable')).toBe(false);

    await events.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(y('a')).toBeLessThan(y('b'));
    expect(node('a').classList.contains('draggable')).toBe(true);
  });

  it('draws the work a queue gives another agent as an arrow, which opens the work between them', async () => {
    const queue = [
      { id: 'm', message: 'Fix the tests' },
      { id: 's', action: 'Read', target: 'b' },
    ];
    const { container } = await setup({
      nodes: [agentNode('a', 0, 0, { data: { label: 'a', queue } }), agentNode('b', 0, 100)],
      edges: [{ id: 'a->b', source: 'a', target: 'b' }],
    });
    const edge = (id: string) => container.querySelector(`[data-testid="rf__edge-${id}"]`);
    // Work implies the agents can talk: it takes the place of their link.
    expect(edge('work:a->b')?.getAttribute('aria-label')).toBe('Work from a for b: 1 queued');
    expect(edge('a->b')).toBeNull();

    await events.click(button('Open the work from a for b'));
    const panel = within(screen.getByRole('dialog', { name: 'Work from a for b' }));
    const order = () => panel.queryAllByRole('button', { name: /^Move / }).map((b) => b.ariaLabel);
    // Only a's items for b, not its message; ⊕ queues one of a's actions, aimed at b.
    expect(order()).toEqual(['Move Read']);
    await events.click(panel.getByRole('button', { name: 'Queue work for b' }));
    await events.click(panel.getByRole('option', { name: /^Bash / }));
    expect(order()).toEqual(['Move Read', 'Move Bash']);
    expect(panel.getByRole('button', { name: 'Change the agent Bash acts on' }).textContent).toBe(
      '→ b',
    );
    expect(button('Open the work from a for b').textContent).toBe('2');

    // Without work, the link shows again.
    await events.click(panel.getByRole('button', { name: 'Remove Read' }));
    await events.click(panel.getByRole('button', { name: 'Remove Bash' }));
    expect(edge('work:a->b')).toBeNull();
    expect(edge('a->b')?.getAttribute('aria-label')).toBe('a and b can talk');
    await events.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sends a message to another agent, which draws an arrow, marked "if" on a condition', async () => {
    const queue = [
      { id: 'i', if: { kind: 'failed' as const }, then: [{ id: 'm', message: 'Take over' }] },
    ];
    const { container, node } = await setup({
      nodes: [agentNode('a', 0, 0, { data: { label: 'a', queue } }), agentNode('lead', 0, 100)],
      edges: [],
    });
    await events.doubleClick(node('a'));
    const panel = within(screen.getByRole('dialog', { name: 'a' }));
    const chip = panel.getByRole('button', { name: 'Change the agent the message goes to' });
    expect(chip.textContent).toBe('→ this agent');
    await events.click(chip);
    await events.click(panel.getByRole('option', { name: 'lead' }));
    expect(chip.textContent).toBe('→ lead');
    await events.keyDown(document.body, { key: 'Escape' });
    const edge = container.querySelector('[data-testid="rf__edge-work:a->lead"]');
    expect(edge?.getAttribute('aria-label')).toBe('Work from a for lead: 1 queued, on a condition');
    const count = () => button('Open the work from a for lead');
    expect(count().textContent).toBe('if 1');

    // The work panel's ⊕ sends messages too: no longer all on a condition.
    await events.click(count());
    const work = within(screen.getByRole('dialog', { name: 'Work from a for lead' }));
    await events.click(work.getByRole('button', { name: 'Queue work for lead' }));
    await events.click(work.getByRole('option', { name: /^Message/ }));
    const text = work.getByRole('textbox', { name: 'New message to the agent' });
    await events.change(text, { target: { value: 'Start now' } });
    await events.keyDown(text, { key: 'Enter' });
    expect(count().textContent).toBe('2');
  });

  it('queues a wait for other agents, drawn as an arrow from each, opening to the waiting queue', async () => {
    const { container, node } = await setup({
      nodes: [agentNode('a', 0, 0), agentNode('b', 0, 100), agentNode('c', 200, 0)],
      edges: [],
    });
    const edge = (id: string) => container.querySelector(`[data-testid="rf__edge-${id}"]`);
    await events.doubleClick(node('b'));
    const panel = within(screen.getByRole('dialog', { name: 'b' }));
    await events.click(panel.getByRole('button', { name: 'Add to queue' }));
    await events.click(panel.getByRole('option', { name: /^Wait for…/ }));
    await events.click(panel.getByRole('option', { name: 'a' }));
    // Another agent joins the wait: the queue goes on once both have finished.
    await events.click(panel.getByRole('button', { name: 'Wait for something else' }));
    expect(panel.getAllByRole('option').map((o) => o.textContent)).toEqual(['c']);
    await events.click(panel.getByRole('option', { name: 'c' }));
    expect(panel.getByRole('button', { name: 'Move Wait for a and c' })).toBeTruthy();
    await events.click(panel.getByRole('button', { name: 'Back to the canvas' }));
    expect(edge('work:a->b')?.getAttribute('aria-label')).toBe('Work from a for b: 1 queued');
    expect(edge('work:c->b')).not.toBeNull();

    // The arrow opens the queue that waits, where an agent can come off the wait.
    await events.click(button('Open the work from a for b'));
    const work = within(screen.getByRole('dialog', { name: 'Work from a for b' }));
    const waiting = within(work.getByRole('region', { name: "In b's queue" }));
    await events.click(waiting.getByRole('button', { name: 'Stop waiting for a' }));
    expect(edge('work:a->b')).toBeNull();
    expect(edge('work:c->b')).not.toBeNull();
  });

  it("picks the step to wait for in the other agent's queue, shown beside, linked to the wait", async () => {
    const queue = [
      { id: 'research', action: 'Workflow' },
      { id: 'm', message: 'Write up what you found' },
    ];
    const { node } = await setup({
      nodes: [agentNode('a', 0, 0, { data: { label: 'a', queue } }), agentNode('b', 0, 100)],
      edges: [],
    });
    await events.doubleClick(node('b'));
    const view = within(screen.getByRole('dialog', { name: 'b' }));
    const links = () => screen.getByRole('dialog', { name: 'b' }).querySelectorAll('[data-link]');
    await events.click(view.getByRole('button', { name: 'Add to queue' }));
    await events.click(view.getByRole('option', { name: /^Wait for…/ }));
    await events.click(view.getByRole('option', { name: 'a' }));

    // b waits for all of a's work until a step of a's, in its queue beside b's, is picked.
    expect(view.getByRole('button', { name: 'Move Wait for a' })).toBeTruthy();
    // a's queue, as editable there as anywhere, picks: one of its tasks, or its end.
    const beside = within(view.getByRole('complementary', { name: "a's queue" }));
    expect(
      beside
        .getAllByRole('button', { name: /^Wait for / })
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      'Wait for a: Workflow',
      'Wait for a: “Write up what you found”',
      "Wait for all of a's work",
    ]);
    expect(beside.getByRole('button', { name: 'Remove Workflow' })).toBeTruthy();
    await events.click(beside.getByRole('button', { name: 'Wait for a: Workflow' }));
    const wait = view.getByRole('button', { name: 'Move Wait for a: Workflow' });
    // Marked as tasks are wherever a queue shows: the wait, and the step it waits for.
    expect(wait.closest('[data-mark]')?.getAttribute('data-mark')).toBe('wait');
    const step = beside.getByRole('button', { name: 'Move Workflow' }).closest('.graph-queue-row');
    expect(step?.hasAttribute('data-waited-for')).toBe(true);
    // The two queues stay side by side, the wait linked to the step it waits for.
    expect(beside.queryByRole('button', { name: /^Wait for / })).toBeNull();
    expect(links()).toHaveLength(1);

    // Its chip picks again; Escape stops picking, then hides a's queue, then closes the view.
    await events.click(view.getByRole('button', { name: 'Change what it waits for: a: Workflow' }));
    await events.click(beside.getByRole('button', { name: "Wait for all of a's work" }));
    expect(view.getByRole('button', { name: 'Move Wait for a' })).toBeTruthy();
    await events.click(view.getByRole('button', { name: 'Change what it waits for: a' }));
    await events.keyDown(document.body, { key: 'Escape' });
    expect(beside.queryByRole('button', { name: /^Wait for / })).toBeNull();
    await events.keyDown(document.body, { key: 'Escape' });
    expect(view.queryByRole('complementary', { name: "a's queue" })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'b' })).toBeTruthy();
  });

  it('deletes a selected link from its button', async () => {
    const { container } = await setup({
      nodes: [agentNode('a', 0, 0), agentNode('b', 0, 100)],
      edges: [{ id: 'a->b', source: 'a', target: 'b', selected: true }],
    });
    await events.click(button('Delete link'));
    expect(container.querySelector('[data-testid="rf__edge-a->b"]')).toBeNull();
  });

  it('deletes a group but keeps its contents, and removes edges of deleted agents', async () => {
    const { container, nodes } = await setup({
      nodes: [
        { ...frame, selected: true },
        agentNode('a', 20, 52, { parentId: 'F' }),
        agentNode('b', 500, 0, { selected: true }),
      ],
      edges: [{ id: 'a->b', source: 'a', target: 'b' }],
    });
    expect(container.querySelector('[data-testid="rf__edge-a->b"]')).not.toBeNull();
    await events.keyDown(document.body, { key: 'Delete' });
    expect(nodes().map((n) => n.querySelector('.graph-label')?.textContent)).toEqual(['a']);
    expect(container.querySelector('[data-testid="rf__edge-a->b"]')).toBeNull();
  });

  it('fits every container to its children when React Flow reports changes', async () => {
    const { container } = await setup({
      nodes: [
        { ...frame, id: 'H', width: 300, height: 300, measured: { width: 300, height: 300 } },
        {
          ...frame,
          id: 'G',
          parentId: 'H',
          position: { x: 20, y: 40 },
          width: 260,
          height: 200,
          measured: { width: 260, height: 200 },
        },
        agentNode('c', 400, 50, { parentId: 'G' }),
      ],
      edges: [],
    });
    // React Flow measures c on mount; G must shrink around it and H around G.
    const width = (id: string) =>
      parseFloat(container.querySelector<HTMLElement>(`[data-id="${id}"]`)?.style.width ?? '');
    expect(width('G')).toBeLessThan(260);
    expect(width('H')).toBe(width('G') + 2 * PADDING);
  });

  it('names links by the labels of their agents, and follows renames', async () => {
    const { container, node } = await setup({
      nodes: [
        agentNode('a', 0, 0, { data: { label: 'Alpha' } }),
        agentNode('b', 0, 100, { data: { label: 'Beta' } }),
      ],
      edges: [{ id: 'a->b', source: 'a', target: 'b' }],
    });
    const edge = () => container.querySelector('[data-testid="rf__edge-a->b"]');
    expect(edge()?.getAttribute('aria-label')).toBe('Alpha and Beta can talk');
    // Renamed in the panel a double-click opens.
    await events.doubleClick(node('a'));
    await events.change(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Gamma' },
    });
    expect(edge()?.getAttribute('aria-label')).toBe('Alpha and Beta can talk');
    await events.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Gamma' })).toBeTruthy();
    expect(edge()?.getAttribute('aria-label')).toBe('Gamma and Beta can talk');
  });

  describe('canvas files', () => {
    const coder: Graph = {
      nodes: [agentNode('x', 0, 0, { data: { label: 'Coder' } })],
      edges: [],
    };
    /** What the Open dialog picks: `graph` as the canvas `id`'s file `name`. */
    const opening = (graph: Graph, id: CanvasId, name: string, project?: ProjectFolder) => ({
      document: documentOf(graph, id),
      name,
      ...(project ? { project } : {}),
    });

    it('saves arrangement as an edit even on an empty canvas, restores it on open, and omits it when off', async () => {
      const first = core();
      const { unmount } = await renderReady(<GraphEditor files onCanvas={first.onCanvas} />);
      expect(document.title).toBe('Untitled — corrallm');
      await events.click(button('Arrange automatically'));
      expect(document.title).toBe('Untitled (edited) — corrallm');
      await events.click(button('Save'));
      await waitFor(() => {
        expect(first.canvas.files.saved).toHaveLength(1);
      });
      const text = first.canvas.files.saved[0] ?? '';
      expect(JSON.parse(text)).toHaveProperty('arrange', true);
      unmount();
      const { pane, nodes, canvas } = await setup(undefined, true);
      canvas.files.open = {
        document: fromFile(text, catalog(), DEFAULT_AGENT),
        name: 'team.corral',
      };
      await events.click(button('Open…'));
      await waitFor(() => {
        expect(button('Arrange automatically').getAttribute('aria-pressed')).toBe('true');
      });
      expect(document.title).toBe('team.corral — corrallm');
      await events.doubleClick(pane, { clientX: 200, clientY: 100 });
      expect(nodes()[0]?.classList.contains('draggable')).toBe(false);
      expect(button('Arrange automatically').getAttribute('aria-pressed')).toBe('true');
      await events.click(button('Arrange automatically'));
      expect(document.title).toBe('team.corral (edited) — corrallm');
      expect(nodes()[0]?.classList.contains('draggable')).toBe(true);
      await events.click(button('Save'));
      await waitFor(() => {
        expect(canvas.files.saved).toHaveLength(1);
      });
      expect(calls(canvas, 'canvas.save')).toHaveLength(1);
      expect(JSON.parse(canvas.files.saved[0] ?? '')).not.toHaveProperty('arrange');
    });

    it('saves the canvas, and titles the window with its file and whether it is edited', async () => {
      const { pane, canvas } = await setup(undefined, true);
      expect(document.title).toBe('Untitled — corrallm');
      await events.doubleClick(pane, { clientX: 200, clientY: 100 });
      expect(document.title).toBe('Untitled (edited) — corrallm');

      // Never saved: Save picks its file, as Save As does.
      canvas.core.operations.length = 0;
      await events.click(button('Save'));
      await waitFor(() => {
        expect(document.title).toBe('team.corral — corrallm');
      });
      expectOneOp(canvas.core, 'canvas.saveAs', { canvas: canvas.document.id });
      expect(
        graphOf(fromFile(canvas.files.saved[0] ?? '', catalog(), DEFAULT_AGENT)).nodes.map(
          (n) => n.data.label,
        ),
      ).toEqual(['Agent 1']);

      // Ctrl/⌘ Shift S saves as, Ctrl/⌘ S saves.
      canvas.core.operations.length = 0;
      await events.keyDown(document.body, { key: 's', ctrlKey: true, shiftKey: true });
      await waitFor(() => {
        expectOneOp(canvas.core, 'canvas.saveAs', { canvas: canvas.document.id });
      });
      canvas.core.operations.length = 0;
      await events.keyDown(document.body, { key: 's', ctrlKey: true });
      await waitFor(() => {
        expectOneOp(canvas.core, 'canvas.save', { canvas: canvas.document.id });
      });
    });

    it('opens a canvas and starts new ones while keeping the previous canvas open', async () => {
      const id = newCanvasId();
      const { pane, nodes, canvas } = await setup(undefined, true);
      canvas.files.open = opening(coder, id, 'review.corral');
      await events.doubleClick(pane, { clientX: 200, clientY: 100 });

      canvas.core.operations.length = 0;
      await events.click(button('Open…'));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      await waitFor(() => {
        expect(nodes().map((n) => n.querySelector('.graph-label')?.textContent)).toEqual(['Coder']);
      });
      expectOneOp(canvas.core, 'canvas.open', {});
      expect(canvas.document.id).toBe(id);
      expect(document.title).toBe('review.corral — corrallm');
      expect(screen.getByRole('status').textContent).toContain('stays open with its changes');

      // Nothing to lose: New asks nothing, and the canvas is the core's new draft.
      canvas.core.operations.length = 0;
      await events.click(button('New'));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      await waitFor(() => {
        expect(nodes()).toEqual([]);
      });
      expectOneOp(canvas.core, 'canvas.create', {});
      expect(canvas.document.id).not.toBe(id);
      expect(document.title).toBe('Untitled — corrallm');
    });

    it('opens an example as a new canvas, from an empty canvas or the file bar', async () => {
      const { nodes, canvas } = await setup(undefined, true);
      await events.click(button('Start from a template…'));
      const gallery = within(screen.getByRole('dialog', { name: 'Templates' }));
      await events.click(await gallery.findByRole('button', { name: /^Team lead/ }));
      await events.click(gallery.getByRole('button', { name: 'Create canvas' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      // The template is the canvas, created by the core operation.
      await waitFor(() => {
        expect(nodes().map((n) => n.querySelector('.graph-label')?.textContent)).toContain('Lead');
      });
      expect(calls(canvas, 'canvas.create')).toEqual([
        {
          op: 'canvas.create',
          args: expect.objectContaining({ template: expect.any(String) as unknown }) as unknown,
        },
      ]);
      expect(document.title).toBe('Untitled (edited) — corrallm');
      // Not empty now: the file bar still has them.
      expect(screen.queryByRole('button', { name: 'Start from a template…' })).toBeNull();
      await events.click(button('Templates…'));
      await events.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('creates another template canvas with no folder after choosing the first canvas’s folder', async () => {
      const { nodes, canvas } = await setup(undefined, true);
      canvas.files.folders.push({ name: 'app', path: '/work/app' });
      const create = async (name: string) => {
        await events.click(button('Templates…'));
        const gallery = within(await screen.findByRole('dialog', { name: 'Templates' }));
        await events.click(await gallery.findByRole('button', { name: new RegExp(`^${name}`) }));
        await events.click(gallery.getByRole('button', { name: 'Create canvas' }));
        await screen.findByRole('button', { name: 'Choose a project folder' });
      };
      await create('Independent cross-check');
      await events.click(button('Choose a project folder'));
      await screen.findByRole('button', { name: 'Project folder: app' });
      await create('Review loop');
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(calls(canvas, 'canvas.create').map(({ args }) => args)).toEqual([
        expect.objectContaining({ template: expect.any(String) as unknown }),
        expect.objectContaining({ template: expect.any(String) as unknown }),
      ]);
      expect(nodes().map((node) => node.querySelector('.graph-label')?.textContent)).toContain(
        'Reviewer',
      );
    });

    it('shows the folder its agents work in, chooses another, and brings it back with the canvas', async () => {
      const id = newCanvasId();
      const { canvas } = await setup(undefined, true);
      canvas.files.open = opening(coder, id, 'shop.corral', { name: 'shop', path: '/work/shop' });
      canvas.files.folders.push({ name: 'app', path: '/work/app' }, null);
      await events.click(button('Choose a project folder'));
      await waitFor(() => {
        expect(button('Project folder: app').title).toMatch(/^\/work\/app\n/);
      });
      // Cancelled: it keeps the folder it had.
      await events.click(button('Project folder: app'));
      await waitFor(() => {
        expect(calls(canvas, 'project.choose')).toHaveLength(2);
      });
      expect(button('Project folder: app')).toBeTruthy();

      // A new canvas has none; an opened one has the folder the core remembered with its file.
      await events.click(button('New'));
      await waitFor(() => {
        expect(button('Choose a project folder')).toBeTruthy();
      });
      await events.click(button('Open…'));
      await waitFor(() => {
        expect(button('Project folder: shop')).toBeTruthy();
      });
    });

    it("fills in a template's blanks before it opens", async () => {
      const { nodes } = await setup(undefined, true);
      await events.click(button('Start from a template…'));
      const gallery = within(screen.getByRole('dialog', { name: 'Templates' }));
      await events.click(await gallery.findByRole('button', { name: /^TDD relay/ }));
      // Each blank starts from the template's own example; Back returns to the templates.
      const framework = gallery.getByRole('textbox', { name: 'Which test framework?' });
      expect((framework as HTMLTextAreaElement).value).toBe('pytest');
      await events.change(framework, { target: { value: 'Vitest' } });
      await events.change(gallery.getByRole('textbox', { name: 'What should they build?' }), {
        target: { value: 'A slugify(text) helper in src/text.ts.' },
      });
      await events.click(gallery.getByRole('button', { name: 'Create canvas' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      await waitFor(() => {
        expect(nodes().map((n) => n.querySelector('.graph-label')?.textContent)).toEqual([
          'TDD relay',
          'Tester',
          'Implementer',
          'Refactorer',
        ]);
      });
      await act(async () => {
        const tester = nodes('.react-flow__node-agent').find(
          (node) => node.querySelector('.graph-label')?.textContent === 'Tester',
        );
        if (!tester) throw new Error('No Tester');
        fireEvent.doubleClick(tester);
        await Promise.resolve();
      });
      const message = within(screen.getByRole('dialog', { name: 'Tester' })).getAllByRole(
        'textbox',
        { name: 'Message to the agent' },
      )[0] as HTMLTextAreaElement;
      expect(message.value).toBe(
        "Write Vitest tests for this, and nothing else: don't implement it.\n\nA slugify(text) helper in src/text.ts.\n\nPut them where this project keeps its tests, named the way the others are.",
      );
    });

    it('inserts a template’s own frame, each agent of the type chosen', async () => {
      const { nodes, container } = await setup(coder, true);
      await events.click(button('Templates…'));
      const gallery = within(screen.getByRole('dialog', { name: 'Templates' }));
      await events.click(await gallery.findByRole('button', { name: /^TDD relay/ }));
      // Each agent starts as the template names it; the Tester is left to the default agent.
      const tester = gallery.getByRole('combobox', { name: "Tester's agent" });
      expect((tester as HTMLSelectElement).value).toBe('codex');
      await events.change(tester, { target: { value: '' } });
      await events.click(gallery.getByRole('button', { name: 'Insert into this canvas' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(nodes().map((n) => n.querySelector('.graph-label')?.textContent)).toEqual([
        'Coder',
        'TDD relay',
        'Tester',
        'Implementer',
        'Refactorer',
      ]);
      const agentOf = (label: string) =>
        [...container.querySelectorAll('.react-flow__node')]
          .find((n) => n.querySelector('.graph-label')?.textContent === label)
          ?.querySelector('[data-agent]')
          ?.getAttribute('data-agent');
      expect(['Tester', 'Implementer', 'Refactorer'].map(agentOf)).toEqual([
        'claude-code',
        'claude-code',
        'codex',
      ]);
    });

    it('runs a template’s agents through native connections even before their CLI is installed', async () => {
      const sessions = fakeSessions();
      sessions.replies.installed.mockResolvedValue({ 'claude-code': true, codex: false });
      const { container } = await renderReady(
        <GraphEditor files sessionReplies={sessions.replies} />,
      );
      await events.click(button('Start from a template…'));
      const gallery = within(screen.getByRole('dialog', { name: 'Templates' }));
      await events.click(await gallery.findByRole('button', { name: /^TDD relay/ }));
      const how = (role: string) =>
        gallery.getByRole<HTMLSelectElement>('combobox', { name: `How ${role} runs` });
      const options = (role: string) => [...how(role).options].map((o) => o.textContent);
      // Missing CLIs never substitute a scripted runtime: each role keeps a native connection.
      await waitFor(() => {
        expect(how('Implementer').value).toBe('claude-code.terminal');
      });
      expect(options('Implementer')).toEqual(['Terminal', 'Agent SDK']);
      expect(how('Tester').value).toBe('codex.terminal');
      expect(options('Tester')).toEqual(['Terminal (CLI not found)', 'App Server (CLI not found)']);
      // Another type runs as that type does by default.
      await events.change(gallery.getByRole('combobox', { name: "Tester's agent" }), {
        target: { value: 'claude-code' },
      });
      expect(how('Tester').value).toBe('claude-code.terminal');
      await events.change(how('Refactorer'), { target: { value: 'codex.app-server' } });
      // Only adapters this build has are offered.
      expect(
        [
          ...gallery.getByRole<HTMLSelectElement>('combobox', { name: "Implementer's agent" })
            .options,
        ].map((option) => [option.value, option.textContent]),
      ).toEqual([
        ['', 'Default (Claude)'],
        ['claude-code', 'Claude'],
        ['codex', 'Codex'],
      ]);

      await events.click(gallery.getByRole('button', { name: 'Create canvas' }));
      const cards = () =>
        [...container.querySelectorAll('.react-flow__node-agent')].map((n) =>
          n.getAttribute('aria-label'),
        );
      await waitFor(() => {
        expect(cards()).toEqual([
          'Tester, Claude · Terminal',
          'Implementer, Claude · Terminal',
          'Refactorer, Codex · App Server',
        ]);
      });
      // Nothing starts until an agent is opened, or sent a message.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(sessions.replies.start).not.toHaveBeenCalled();
      const implementer = [...container.querySelectorAll('.react-flow__node-agent')].find(
        (node) => node.querySelector('.graph-label')?.textContent === 'Implementer',
      );
      if (!implementer) throw new Error('no Implementer');
      await events.doubleClick(implementer);
      await waitFor(() => {
        expect(sessions.replies.start).toHaveBeenCalledTimes(1);
      });
      expect(sessions.replies.start).toHaveBeenCalledWith(implementer.getAttribute('data-id'), {
        connection: 'claude-code.terminal',
        model: null,
        mode: null,
      });
    });

    it('keeps the canvas, saving it under its own token, when the core refuses a file', async () => {
      const id = newCanvasId();
      const held = core();
      const { container } = await renderReady(
        <GraphEditor
          initialGraph={coder}
          files
          onCanvas={(made) => {
            made.open({ ...made.document, id });
            held.onCanvas(made);
          }}
        />,
      );
      held.canvas.files.open = new Error('notes.corral: This is not a corrallm canvas');
      await waitFor(() => {
        expect(button('Open…').disabled).toBe(false);
      });
      await events.click(button('Open…'));
      expect((await screen.findByRole('alert')).textContent).toMatch(
        /^Could not open the canvas: notes\.corral: This is not a corrallm canvas/,
      );
      expect(calls(held.canvas, 'canvas.create')).toEqual([]);
      expect(container.querySelector('.react-flow__node[data-id="x"]')).not.toBeNull();
      await events.click(button('Save'));
      await waitFor(() => {
        expect(held.canvas.files.saved).toHaveLength(1);
      });
      expect(canvasIdOf(held.canvas.files.saved[0] ?? '')).toBe(id);
    });

    it('says why a file cannot be opened, and keeps the canvas', async () => {
      const { nodes, canvas } = await setup(coder, true);
      canvas.files.open = new Error('notes.corral: This is not a corrallm canvas');
      await events.click(button('Open…'));
      expect((await screen.findByRole('alert')).textContent).toMatch(
        /^Could not open the canvas: notes\.corral: This is not a corrallm canvas/,
      );
      expect(nodes().map((n) => n.querySelector('.graph-label')?.textContent)).toEqual(['Coder']);
      // The core never took it as the canvas's file: one refused Open, and nothing begun anew.
      expectOneOp(canvas.core, 'canvas.open', {});
    });
  });
});
