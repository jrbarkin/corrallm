import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MADE_UP } from '../../shared/test-made-up';
import type { CanvasNode } from '../../shared/model/canvas';
import { NEW_SESSION } from '../../shared/model/session';
import { catalog, loadCatalog } from '../catalog';
import { events } from '../test-render';
import { Dock } from './Dock';
import * as motion from '../agent/motion';
import { fakeCanvas } from '../test-canvas';
import { newCanvasId } from '../../shared/canvas';
import { fakeBackend } from '../../shared/engine/test-backend';
import { GraphEditor } from './GraphEditor';
import { renderReady } from '../test-render';

vi.mock('../terminal/screen', async () => ({
  createScreen: (await import('../terminal/test-screen')).fakeScreens.create,
}));

const shipped = catalog();
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await loadCatalog(() => Promise.resolve(shipped));
});
const nodes: CanvasNode[] = [
  { id: 'frame', type: 'frame', position: { x: 0, y: 0 }, data: { label: 'Review team' } },
  {
    id: 'a',
    type: 'agent',
    parentId: 'frame',
    position: { x: 0, y: 0 },
    data: { label: 'Writer' },
  },
  {
    id: 'nested',
    type: 'frame',
    parentId: 'frame',
    position: { x: 0, y: 0 },
    data: { label: 'Checks' },
  },
  {
    id: 'b',
    type: 'agent',
    parentId: 'nested',
    position: { x: 0, y: 0 },
    data: { label: 'Reviewer', adapter: 'codex' },
  },
  { id: 'c', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Lead' } },
  { id: 'd', type: 'agent', parentId: 'c', position: { x: 0, y: 0 }, data: { label: 'Helper' } },
];
const props = () => ({
  nodes,
  sessions: {},
  run: { running: false, agents: {} },
  needs: new Set<string>(),
  queues: false,
  onToggleQueues: vi.fn(),
  onOpen: vi.fn(),
  onNew: vi.fn(),
  onTemplates: vi.fn(),
});
it('lists every agent once in its nested canvas group, with catalog image logos', () => {
  render(<Dock {...props()} />);
  const dock = within(screen.getByRole('navigation', { name: 'Canvas agents' }));
  const group = within(dock.getByRole('group', { name: 'Review team' }));
  expect(group.getByRole('button', { name: /^Writer,/ })).toBeTruthy();
  expect(
    within(group.getByRole('group', { name: 'Checks' })).getByRole('button', {
      name: /^Reviewer,/,
    }),
  ).toBeTruthy();
  expect(within(dock.getByRole('group', { name: 'Lead' })).getAllByRole('button')).toHaveLength(2);
  expect(dock.getAllByRole('button', { name: /, .*: Idle$/ })).toHaveLength(4);
  for (const image of dock.getAllByRole('img')) {
    expect(image.tagName).toBe('IMG');
    expect(image.getAttribute('src')).toMatch(/^data:image\/svg\+xml,/);
  }
});
it('shows a declared adapter without a logo as its first letter', async () => {
  await loadCatalog(() => Promise.resolve(MADE_UP));
  render(
    <Dock
      {...props()}
      nodes={[
        {
          id: 'zed',
          type: 'agent',
          position: { x: 0, y: 0 },
          data: { label: 'Zed', adapter: 'zed' },
        },
      ]}
    />,
  );
  const logo = screen.getByRole('img', { name: 'Zed Agent' });
  expect(logo.textContent).toBe('Z');
  expect(logo.querySelector('img, svg')).toBeNull();
});
it('shows run and session status, with Needs taking priority and clearing when answered', () => {
  const input = props();
  const state = {
    ...input,
    sessions: { a: { ...NEW_SESSION, status: 'working' as const } },
    run: {
      running: true,
      agents: {
        b: { status: 'waiting' as const, outcomes: {} },
        c: { status: 'done' as const, outcomes: {} },
      },
    },
  };
  const view = render(<Dock {...state} needs={new Set(['a'])} />);
  const writer = screen.getByRole('button', { name: /^Writer,/ });
  expect(writer.title).toContain('Needs you');
  expect(writer.hasAttribute('data-needs')).toBe(true);
  expect(screen.getByRole('button', { name: /^Reviewer,/ }).title).toContain('Waiting');
  expect(screen.getByRole('button', { name: /^Lead,/ }).title).toContain('Done');
  view.rerender(<Dock {...state} />);
  expect(writer.hasAttribute('data-needs')).toBe(false);
  expect(writer.title).toContain('Working');
});
it('toggles queues, opens an agent and offers New/Templates, one intent each', async () => {
  const input = props();
  const view = render(<Dock {...input} />);
  await events.click(screen.getByRole('button', { name: 'Show all queues' }));
  expect(input.onToggleQueues).toHaveBeenCalledOnce();
  view.rerender(<Dock {...input} queues />);
  expect(screen.getByRole('button', { name: 'Show all queues' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  await events.click(screen.getByRole('button', { name: /^Reviewer,/ }));
  expect(input.onOpen).toHaveBeenCalledExactlyOnceWith('b');
  for (const [label, action] of [
    ['New canvas', input.onNew],
    ['Browse templates', input.onTemplates],
  ] as const) {
    await events.click(screen.getByRole('button', { name: 'Start a session' }));
    await events.click(screen.getByRole('button', { name: label }));
    expect(action).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: 'Start a session' })).toBeNull();
  }
});
it('keeps completed queues done during a global pause and names a pause still taking effect', () => {
  render(
    <Dock
      {...props()}
      run={{
        running: false,
        paused: true,
        agents: {
          a: { status: 'done', outcomes: {} },
          b: { status: 'running', current: 'message', paused: true, outcomes: {} },
        },
      }}
    />,
  );
  expect(screen.getByRole('button', { name: /^Writer,/ }).title).toContain('Done');
  expect(screen.getByRole('button', { name: /^Reviewer,/ }).title).toContain('Pausing');
});
it('moves the same keyed icons into the taskbar and back, without replaying on status updates', () => {
  const slide = vi.spyOn(motion, 'slide').mockReturnValue([]);
  const input = props();
  const view = render(<Dock {...input} />);
  const dock = screen.getByRole('navigation', { name: 'Canvas agents' });
  const writer = screen.getByRole('button', { name: /^Writer,/ });
  view.rerender(<Dock {...input} current="a" />);
  expect(dock.getAttribute('data-horizontal')).toBe('');
  expect(writer.getAttribute('aria-current')).toBe('true');
  expect(screen.getByRole('button', { name: /^Writer,/ })).toBe(writer);
  expect(slide).toHaveBeenCalledTimes(1);
  view.rerender(<Dock {...input} current="a" needs={new Set(['b'])} />);
  expect(slide).toHaveBeenCalledTimes(1);
  view.rerender(<Dock {...input} />);
  expect(dock.hasAttribute('data-horizontal')).toBe(false);
  expect(slide).toHaveBeenCalledTimes(2);
});

it('toggles the canvas queues and switches agents through the taskbar without document operations', async () => {
  const canvas = fakeCanvas({ id: newCanvasId(), arrange: false, nodes, links: [] });
  const sessions = fakeBackend();
  try {
    await renderReady(
      <GraphEditor
        canvas={canvas.document.id}
        client={canvas.core.api}
        mirror={canvas.core.topics}
        sessionBackend={sessions.backend}
      />,
    );
    const dock = within(screen.getByRole('navigation', { name: 'Canvas agents' }));
    await events.click(dock.getByRole('button', { name: 'Show all queues' }));
    expect(screen.getByRole('dialog', { name: 'All queues' })).toBeTruthy();
    await events.click(dock.getByRole('button', { name: 'Show all queues' }));
    expect(screen.queryByRole('dialog', { name: 'All queues' })).toBeNull();
    await events.click(dock.getByRole('button', { name: /^Writer,/ }));
    expect(screen.getByRole('dialog', { name: 'Writer' })).toBeTruthy();
    expect(dock.getByRole('button', { name: /^Writer,/ }).getAttribute('aria-current')).toBe(
      'true',
    );
    await events.click(dock.getByRole('button', { name: /^Reviewer,/ }));
    expect(screen.queryByRole('dialog', { name: 'Writer' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Reviewer' })).toBeTruthy();
    await events.click(dock.getByRole('button', { name: 'Show all queues' }));
    expect(screen.getByRole('dialog', { name: 'All queues' })).toBeTruthy();
    await events.click(dock.getByRole('button', { name: 'Show all queues' }));
    expect(screen.queryByRole('dialog', { name: 'All queues' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Reviewer' })).toBeTruthy();
    expect(canvas.core.operations).toEqual([]);
    await events.click(
      within(screen.getByRole('dialog', { name: 'Reviewer' })).getByRole('button', {
        name: 'Back to the canvas',
      }),
    );
    expect(
      screen.getByRole('navigation', { name: 'Canvas agents' }).hasAttribute('data-horizontal'),
    ).toBe(false);
  } finally {
    canvas.core.dispose();
  }
});

it('glows for a need from either the core topic or the renderer session, until both clear', async () => {
  const canvas = fakeCanvas({ id: newCanvasId(), arrange: false, nodes, links: [] });
  const sessions = fakeBackend();
  try {
    await renderReady(
      <GraphEditor
        canvas={canvas.document.id}
        client={canvas.core.api}
        mirror={canvas.core.topics}
        sessionBackend={sessions.backend}
      />,
    );
    const writer = screen.getByRole('button', { name: /^Writer,/ });
    await events.click(writer);
    act(() => {
      canvas.core.change({
        topic: `needs:${canvas.document.id}`,
        rev: 1,
        replace: {
          items: [
            {
              id: 'core-hold',
              canvas: canvas.document.id,
              agent: 'a',
              kind: 'hold',
              for: 'you',
              by: ['you'],
              title: 'Review',
              choices: [],
              answerIn: 'api',
            },
          ],
        },
      });
    });
    expect(writer.hasAttribute('data-needs')).toBe(true);
    act(() => {
      sessions.emit('a', 'claude-code.terminal', {
        type: 'asking',
        asks: [{ id: 'trust', kind: 'trust' }],
      });
      canvas.core.change({ topic: `needs:${canvas.document.id}`, rev: 2, replace: { items: [] } });
    });
    expect(writer.hasAttribute('data-needs')).toBe(true);
    act(() => {
      sessions.emit('a', 'claude-code.terminal', { type: 'asking', asks: [] });
    });
    expect(writer.hasAttribute('data-needs')).toBe(false);
    expect(canvas.core.operations).toEqual([]);
  } finally {
    canvas.core.dispose();
  }
});
