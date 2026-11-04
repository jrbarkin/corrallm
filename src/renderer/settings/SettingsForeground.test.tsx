import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NEW_SESSION } from '../../shared/model/session';
import type { FakeCanvas } from '../test-canvas';
import { fakeSessions } from '../test-sessions';
import { events, renderReady } from '../test-render';
import { GraphEditor } from '../test-graph';
import type { GraphNode } from '../graph/flow';

vi.mock('../terminal/screen', async () => ({
  createScreen: (await import('../terminal/test-screen')).fakeScreens.create,
}));
afterEach(cleanup);

const agent = (id: string, x = 200, y = 200): GraphNode => ({
  id,
  type: 'agent',
  position: { x, y },
  data: { adapter: 'claude-code', label: id },
});

async function setup(nodes: GraphNode[] = [agent('a')], files = false) {
  const fake = fakeSessions();
  const held: { canvas?: FakeCanvas } = {};
  const view = await renderReady(
    <GraphEditor
      sessionReplies={fake.replies}
      initialGraph={{ nodes, edges: [] }}
      files={files}
      onCanvas={(canvas) => {
        held.canvas = canvas;
      }}
    />,
  );
  const canvas = () => {
    if (!held.canvas) throw new Error('No canvas');
    return held.canvas;
  };
  return { view, fake, canvas };
}
const dock = () => screen.getByRole('button', { name: 'Settings' });
const settings = () => screen.queryByRole('dialog', { name: 'Settings' });
/** Another window remembered a site: the settings topic now lists it. */
function remember(canvas: FakeCanvas, sites: string[]) {
  const previous = canvas.core.state('settings');
  if (!previous) throw new Error('No settings');
  act(() => {
    canvas.core.change({
      topic: 'settings',
      rev: previous.rev + 1,
      replace: { ...previous.state, links: { state: 'ready', sites, builtIn: [] } },
    });
  });
}
async function takeBackSite(canvas: FakeCanvas, origin: string) {
  await events.click(dock());
  await screen.findByRole('dialog', { name: 'Settings' });
  remember(canvas, [origin, 'https://other.example']);
  const row = await screen.findByRole('button', { name: `Ask next time: ${origin}` });
  // A real click focuses the button first.
  row.focus();
  await events.click(row);
  await waitFor(() => {
    expect(screen.queryByText(origin)).toBeNull();
  });
}

describe('Escape with Settings over a foreground', () => {
  it.each(['working', 'idle'] as const)(
    'closes only Settings after a row gesture drops focus, over a %s agent window',
    async (state) => {
      const { view, fake, canvas } = await setup();
      const node = view.container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
      if (!node) throw new Error('No node');
      await events.doubleClick(node);
      expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();
      if (state === 'working')
        act(() => {
          canvas().session('a', { ...NEW_SESSION, status: 'working' });
        });
      await takeBackSite(canvas(), 'https://example.org');
      await events.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      expect(fake.replies.interrupt).not.toHaveBeenCalled();
      expect(settings()).toBeNull();
      expect(screen.getByRole('dialog', { name: 'a' })).toBeTruthy();
    },
  );

  it('closes Settings and leaves All queues open', async () => {
    await setup();
    await events.click(screen.getByRole('button', { name: 'Show all queues' }));
    expect(screen.getByRole('dialog', { name: 'All queues' })).toBeTruthy();
    await events.click(dock());
    await screen.findByRole('dialog', { name: 'Settings' });
    await events.keyDown(document.body, { key: 'Escape' });
    expect(settings()).toBeNull();
    expect(screen.getByRole('dialog', { name: 'All queues' })).toBeTruthy();
  });
});

describe('what Settings covers', () => {
  it('makes the graph inert, and keyboard shortcuts do nothing, while it is open', async () => {
    const { view, canvas } = await setup([agent('a'), agent('b', 500, 200)]);
    const node = view.container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
    if (!node) throw new Error('No node');
    await events.click(node);
    await events.click(dock());
    await screen.findByRole('dialog', { name: 'Settings' });
    expect(view.container.querySelector('.react-flow')?.hasAttribute('inert')).toBe(true);
    const before = canvas().core.operations.length;
    await events.keyDown(document.body, { key: 'Delete' });
    expect(canvas().core.operations).toHaveLength(before);
    await events.keyDown(document.body, { key: 'Escape' });
    expect(view.container.querySelector('.react-flow')?.hasAttribute('inert')).toBe(false);
  });

  it.each([
    ['an agent window', 'agent'],
    ['All queues', 'queues'],
  ] as const)('makes %s inert while Settings shows', async (_, which) => {
    const { view } = await setup();
    if (which === 'agent') {
      const node = view.container.querySelector<HTMLElement>('.react-flow__node[data-id="a"]');
      if (!node) throw new Error('No node');
      await events.doubleClick(node);
    } else await events.click(screen.getByRole('button', { name: 'Show all queues' }));
    const covered = screen.getByRole('dialog', {
      name: which === 'agent' ? 'a' : 'All queues',
    });
    expect(covered.closest('[inert]')).toBeNull();
    await events.click(dock());
    await screen.findByRole('dialog', { name: 'Settings' });
    expect(covered.closest('[inert]')).not.toBeNull();
    await events.keyDown(document.body, { key: 'Escape' });
    expect(covered.closest('[inert]')).toBeNull();
  });

  it('makes Start inert while Settings shows, and never opens over the agent chooser', async () => {
    await setup([], true);
    const start = await screen.findByRole('dialog', { name: 'Start a session' });
    await events.click(dock());
    await screen.findByRole('dialog', { name: 'Settings' });
    expect(start.closest('[inert]')).not.toBeNull();
    await events.keyDown(document.body, { key: 'Escape' });
    expect(start.closest('[inert]')).toBeNull();
  });

  it('does not open Settings over the modal agent chooser', async () => {
    const { view } = await setup([]);
    const pane = view.container.querySelector('.react-flow__pane');
    if (!pane) throw new Error('No pane');
    await events.doubleClick(pane);
    await screen.findByRole('dialog', { name: 'Choose an agent' });
    await events.click(dock());
    expect(settings()).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Choose an agent' })).toBeTruthy();
  });
});
