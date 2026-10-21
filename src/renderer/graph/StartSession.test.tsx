import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { newCanvasId } from '../../shared/canvas';
import { EXAMPLES } from '../../shared/examples';
import { templateInfo } from '../../shared/templates';
import { catalog } from '../catalog';
import { fakeCanvas } from '../test-canvas';
import { fakeBackend } from '../../shared/engine/test-backend';
import { expectOneOp } from '../test-api';
import { events } from '../test-render';
import { GraphEditor } from './GraphEditor';
import * as motion from '../agent/motion';

vi.mock('../terminal/screen', async () => ({
  createScreen: (await import('../terminal/test-screen')).fakeScreens.create,
}));
const disposals: (() => void)[] = [];
beforeEach(() => {
  vi.spyOn(api, 'templatesList').mockResolvedValue({
    items: EXAMPLES.map((example) => templateInfo(example, catalog(), 'claude-code')),
  });
  vi.spyOn(api, 'catalogInstalled').mockResolvedValue({ 'claude-code': true, codex: false });
});
afterEach(() => {
  cleanup();
  disposals.splice(0).forEach((stop) => {
    stop();
  });
  vi.restoreAllMocks();
});
function setup() {
  const canvas = fakeCanvas({ id: newCanvasId(), arrange: false, nodes: [], links: [] });
  const sessions = fakeBackend();
  sessions.backend.installed.mockResolvedValue({ 'claude-code': true, codex: false });
  disposals.push(() => {
    canvas.core.dispose();
  });
  render(
    <GraphEditor
      canvas={canvas.document.id}
      client={canvas.core.api}
      mirror={canvas.core.topics}
      sessionBackend={sessions.backend}
      files
    />,
  );
  return { canvas, sessions };
}
const start = async () => within(await screen.findByRole('dialog', { name: 'Start a session' }));
it('opens a window on an empty canvas, offering the folder, installed agents, connections and templates', async () => {
  setup();
  const view = await start();
  expect(view.getByRole('button', { name: 'Choose a project folder' })).toBeTruthy();
  expect(
    (await view.findByRole<HTMLButtonElement>('button', { name: 'Start Claude Code' })).disabled,
  ).toBe(false);
  expect(
    view.getByRole<HTMLSelectElement>('combobox', { name: 'Claude Code connection' }).options[0]
      ?.textContent,
  ).toBe('Terminal');
  expect(view.getByRole<HTMLButtonElement>('button', { name: 'Start Codex' }).disabled).toBe(true);
  expect(await view.findByRole('button', { name: /Independent cross-check/ })).toBeTruthy();
  await events.click(view.getByRole('button', { name: 'Close Start a session' }));
  expect(screen.queryByRole('dialog', { name: 'Start a session' })).toBeNull();
  await events.click(screen.getByRole('button', { name: 'Start a session' }));
  expect(await screen.findByRole('dialog', { name: 'Start a session' })).toBeTruthy();
});
it('starts on the chosen connection in one addAgent and grows from the Start window', async () => {
  const morph = vi.spyOn(motion, 'morph').mockReturnValue(undefined);
  const { canvas, sessions } = setup();
  const view = await start();
  const dialog = screen.getByRole('dialog', { name: 'Start a session' });
  const from = new DOMRect(100, 80, 780, 420);
  vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue(from);
  const select = await view.findByRole('combobox', { name: 'Claude Code connection' });
  await events.change(select, { target: { value: 'claude-code.sdk' } });
  await events.click(view.getByRole('button', { name: 'Start Claude Code' }));
  expectOneOp(canvas.core, 'canvas.addAgent', {
    canvas: canvas.document.id,
    adapter: 'claude-code',
    connection: 'claude-code.sdk',
    at: { x: 0, y: 0 },
  });
  expect(await screen.findByRole('dialog', { name: 'Agent 1' })).toBeTruthy();
  expect(screen.queryByRole('dialog', { name: 'Start a session' })).toBeNull();
  expect(sessions.backend.start).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ connection: 'claude-code.sdk' }),
  );
  expect(morph).toHaveBeenCalledWith(expect.any(HTMLElement), from, 'open', {
    duration: 440,
    fade: true,
  });
});
it('chooses the folder with one op and shows its new project in the Start window', async () => {
  const { canvas } = setup();
  canvas.files.folders.push({ name: 'Project', path: '/project' });
  const view = await start();
  await events.click(view.getByRole('button', { name: 'Choose a project folder' }));
  expectOneOp(canvas.core, 'project.choose', { canvas: canvas.document.id });
  expect(view.getByRole('button', { name: 'Project folder: Project' })).toBeTruthy();
});
it('opens a recent canvas with one window.show through the switch', async () => {
  const { canvas } = setup();
  const recent = newCanvasId();
  act(() => {
    canvas.core.change({
      topic: 'canvases',
      rev: 1,
      replace: {
        items: [
          {
            canvas: recent,
            name: 'Recent.corral',
            edited: true,
            running: false,
            open: true,
            shownIn: [],
            project: null,
          },
        ],
      },
    });
  });
  canvas.core.reply('window.show', () => {
    canvas.open({
      id: recent,
      arrange: false,
      nodes: [
        { id: 'old', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Recent agent' } },
      ],
      links: [],
    });
    return Promise.resolve({ ok: true, value: {} });
  });
  const view = await start();
  await events.click(await view.findByRole('button', { name: 'Show Recent.corral' }));
  await waitFor(() => {
    expectOneOp(canvas.core, 'window.show', { canvas: recent });
  });
  expect(await screen.findByText('Recent agent')).toBeTruthy();
  expect(screen.queryByRole('dialog', { name: 'Start a session' })).toBeNull();
});
it('a new canvas reopens Start with no folder, in one create', async () => {
  const { canvas } = setup();
  const before = canvas.document.id;
  canvas.meta({ project: { name: 'Old', path: '/old' } });
  const view = await start();
  await events.click(view.getByRole('button', { name: 'Close Start a session' }));
  await events.click(screen.getByRole('button', { name: 'Canvas menu' }));
  await events.click(screen.getByRole('button', { name: 'New' }));
  await waitFor(() => {
    expectOneOp(canvas.core, 'canvas.create', {});
  });
  expect(canvas.document.id).not.toBe(before);
  const next = await start();
  expect(next.getByRole('button', { name: 'Choose a project folder' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Project folder: Old' })).toBeNull();
});
it('a template chosen from Start creates the canvas in one op', async () => {
  const { canvas } = setup();
  const view = await start();
  const template = EXAMPLES.find((example) => example.name === 'Independent cross-check');
  if (!template) throw new Error('Missing test template');
  await events.click(await view.findByRole('button', { name: /^Independent cross-check/ }));
  const gallery = within(await screen.findByRole('dialog', { name: 'Templates' }));
  await events.click(gallery.getByRole('button', { name: 'Create canvas' }));
  await waitFor(() => {
    expect(canvas.core.operations).toEqual([
      {
        op: 'canvas.create',
        args: expect.objectContaining({
          template: templateInfo(template, catalog(), 'claude-code').id,
        }) as unknown,
      },
    ]);
  });
  expect(canvas.document.nodes.filter((node) => node.type === 'agent')).toHaveLength(2);
  expect(screen.queryByRole('dialog', { name: 'Start a session' })).toBeNull();
  expect(screen.queryByRole('dialog', { name: 'Templates' })).toBeNull();
});
it('a refused start leaves Start open and explains the refusal', async () => {
  const { canvas } = setup();
  canvas.core.reply('canvas.addAgent', {
    ok: false,
    error: { code: 'invalid', sentence: 'This connection is unavailable.' },
  });
  const view = await start();
  await events.click(view.getByRole('button', { name: 'Start Claude Code' }));
  expectOneOp(canvas.core, 'canvas.addAgent', {
    canvas: canvas.document.id,
    adapter: 'claude-code',
    connection: 'claude-code.terminal',
    at: { x: 0, y: 0 },
  });
  expect(view.getByRole('alert').textContent).toContain('This connection is unavailable.');
  expect(canvas.document.nodes).toHaveLength(0);
});
