import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { newCanvasId } from '../../shared/canvas';
import { fakeCanvas } from '../test-canvas';
import { fakeSessions } from '../test-sessions';
import { events } from '../test-render';
import { GraphEditor } from '../graph/GraphEditor';

vi.mock('../terminal/screen', async () => ({
  createScreen: (await import('../terminal/test-screen')).fakeScreens.create,
}));
const disposals: (() => void)[] = [];
afterEach(() => {
  cleanup();
  disposals.splice(0).forEach((stop) => {
    stop();
  });
  vi.restoreAllMocks();
});

function setup(nodes: readonly object[] = []) {
  const sessions = fakeSessions();
  const canvas = fakeCanvas(
    { id: newCanvasId(), arrange: false, nodes: [...nodes], links: [] } as never,
    sessions.replies,
  );
  sessions.replies.installed.mockResolvedValue({});
  canvas.core.respond('catalog.installed', {});
  disposals.push(() => {
    canvas.core.dispose();
  });
  render(
    <GraphEditor
      canvas={canvas.document.id}
      client={canvas.core.api}
      mirror={canvas.core.topics}
      files
    />,
  );
  return canvas;
}
const page = () => screen.queryByRole('dialog', { name: 'Settings' });
const settled = (canvas: ReturnType<typeof setup>) =>
  canvas.core.operations.filter((one) => one.op === 'settings.set');

it('opens from the canvas menu over Start, sends nothing, and Escape returns focus to the menu', async () => {
  const canvas = setup();
  await screen.findByRole('dialog', { name: 'Start a session' });
  const before = canvas.core.operations.length;
  const menu = screen.getByRole('button', { name: 'Canvas menu' });
  await events.click(menu);
  await events.click(screen.getByRole('button', { name: 'Settings…' }));
  expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeTruthy();
  expect(screen.getByRole('dialog', { name: 'Start a session' })).toBeTruthy();
  await events.keyDown(screen.getByRole('dialog', { name: 'Settings' }), { key: 'Escape' });
  await waitFor(() => {
    expect(page()).toBeNull();
  });
  expect(document.activeElement).toBe(menu);
  // Start is still there, and nothing was created, started or written.
  expect(screen.getByRole('dialog', { name: 'Start a session' })).toBeTruthy();
  expect(canvas.core.operations).toHaveLength(before);
  expect(settled(canvas)).toEqual([]);
});

it('opens from the dock and Back returns focus to the dock button', async () => {
  const canvas = setup();
  await events.click(await screen.findByRole('button', { name: 'Close Start a session' }));
  const before = canvas.core.operations.length;
  const dock = screen.getByRole('button', { name: 'Settings' });
  await events.click(dock);
  expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Canvas menu' })).toBeTruthy();
  await events.click(screen.getByRole('button', { name: 'Close Settings' }));
  await waitFor(() => {
    expect(page()).toBeNull();
  });
  expect(document.activeElement).toBe(dock);
  expect(canvas.core.operations).toHaveLength(before);
});
