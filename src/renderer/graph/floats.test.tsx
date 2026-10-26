import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { events } from '../test-render';
import { CanvasMenu } from './CanvasMenu';
import { RunFloat, ZoomFloat } from './Floats';
vi.mock('../terminal/screen', async () => ({
  createScreen: (await import('../terminal/test-screen')).fakeScreens.create,
}));

afterEach(cleanup);
it.each(['New', 'Open…', 'Save', 'Save as…'] as const)(
  'the canvas menu keeps %s behind its name and invokes one action',
  async (name) => {
    const actions = {
      onNew: vi.fn(),
      onOpen: vi.fn(),
      onSave: vi.fn(),
      onSaveAs: vi.fn(),
      onExamples: vi.fn(),
      onDismiss: vi.fn(),
    };
    render(
      <CanvasMenu
        name="team.corral"
        edited
        project={{ folder: { name: 'Project', path: '/work' }, onChoose: vi.fn() }}
        problem={undefined}
        canvases={<button>Canvases</button>}
        {...actions}
      />,
    );
    expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.getByText('team.corral')).toBeTruthy();
    expect(screen.getByText('Edited')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Project folder: Project' })).toBeTruthy();
    await events.click(screen.getByRole('button', { name: 'Canvas menu' }));
    const menu = screen.getByRole('dialog', { name: 'Canvas menu' });
    expect(within(menu).getByRole('button', { name: 'Canvases' })).toBeTruthy();
    await events.click(within(menu).getByRole('button', { name }));
    const key = (
      { New: 'onNew', 'Open…': 'onOpen', Save: 'onSave', 'Save as…': 'onSaveAs' } as const
    )[name];
    expect(actions[key]).toHaveBeenCalledOnce();
    expect(Object.values(actions).reduce((sum, action) => sum + action.mock.calls.length, 0)).toBe(
      1,
    );
    expect(screen.queryByRole('dialog', { name: 'Canvas menu' })).toBeNull();
  },
);
it('canvas commands dismiss with Escape or a click outside, without dispatching', async () => {
  const action = vi.fn();
  render(
    <CanvasMenu
      name={undefined}
      edited={false}
      problem={undefined}
      onNew={action}
      onOpen={action}
      onSave={action}
      onSaveAs={action}
      onExamples={action}
      onDismiss={action}
    />,
  );
  const button = screen.getByRole('button', { name: 'Canvas menu' });
  await events.click(button);
  await events.keyDown(screen.getByRole('button', { name: 'New' }), { key: 'Escape' });
  expect(button.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(button);
  await events.click(button);
  await events.pointerDown(document.body);
  expect(screen.queryByRole('dialog', { name: 'Canvas menu' })).toBeNull();
  expect(action).not.toHaveBeenCalled();
});
it('zoom and Arrange share a float; each click has one intent', async () => {
  const actions = { onIn: vi.fn(), onOut: vi.fn(), onFit: vi.fn(), onArrange: vi.fn() };
  render(
    <ZoomFloat
      zoom={0.75}
      arranging
      onIn={actions.onIn}
      onOut={actions.onOut}
      onFit={actions.onFit}
      onArrange={actions.onArrange}
    />,
  );
  const zoom = within(screen.getByRole('toolbar', { name: 'Canvas zoom' }));
  expect(zoom.getByText('75%')).toBeTruthy();
  expect(
    zoom.getByRole('button', { name: 'Arrange automatically' }).getAttribute('aria-pressed'),
  ).toBe('true');
  for (const [name, action] of [
    ['Zoom in', actions.onIn],
    ['Zoom out', actions.onOut],
    ['Fit view', actions.onFit],
    ['Arrange automatically', actions.onArrange],
  ] as const) {
    await events.click(zoom.getByRole('button', { name }));
    expect(action).toHaveBeenCalledOnce();
  }
});
it('the run float keeps Run, Stop and Resume alongside Needs and usage, with queues in the dock', async () => {
  const actions = {
    onRun: vi.fn(),
    onStop: vi.fn(),
    onResume: vi.fn(),
  };
  const props = {
    working: 0,
    ...actions,
    needs: <button>Needs you</button>,
    gauges: <span>Usage</span>,
  };
  const view = render(<RunFloat {...props} run={{ running: false, agents: {} }} />);
  await events.click(screen.getByRole('button', { name: 'Run' }));
  expect(actions.onRun).toHaveBeenCalledOnce();
  view.rerender(<RunFloat {...props} run={{ running: true, agents: {} }} />);
  await events.click(screen.getByRole('button', { name: 'Stop' }));
  expect(actions.onStop).toHaveBeenCalledOnce();
  view.rerender(<RunFloat {...props} run={{ running: false, paused: true, agents: {} }} />);
  await events.click(screen.getByRole('button', { name: 'Resume' }));
  await events.click(screen.getByRole('button', { name: 'Run again' }));
  expect(actions.onResume).toHaveBeenCalledOnce();
  expect(actions.onRun).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('button', { name: 'Show all queues' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Needs you' })).toBeTruthy();
  expect(screen.getByText('Usage')).toBeTruthy();
});

it('keeps the canvas commands available beside a nonmodal agent window', async () => {
  const { GraphEditor } = await import('../test-graph');
  render(
    <GraphEditor
      files
      initialGraph={{
        nodes: [{ id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Writer' } }],
        edges: [],
      }}
    />,
  );
  await waitFor(() => {
    expect(document.querySelector('.graph-editor')?.hasAttribute('inert')).toBe(false);
  });
  await events.doubleClick(await screen.findByText('Writer'));
  const window = await screen.findByRole('dialog', { name: 'Writer' });
  expect(window.getAttribute('aria-modal')).toBe('false');
  expect(screen.getByRole('toolbar', { name: 'Run controls' })).toBeTruthy();
  await events.click(screen.getByRole('button', { name: 'Canvas menu' }));
  expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
});
