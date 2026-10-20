import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { newCanvasId } from '../../shared/canvas';
import { fakeCanvas } from '../test-canvas';
import { expectOneOp } from '../test-api';
import { GraphEditor } from './GraphEditor';

vi.mock('../terminal/screen', async () => ({
  createScreen: (await import('../terminal/test-screen')).fakeScreens.create,
}));

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanup();
  cleanups.splice(0).forEach((stop) => {
    stop();
  });
});
function setup(saved = true) {
  const canvas = fakeCanvas({
    id: newCanvasId(),
    arrange: false,
    links: [],
    nodes: [{ id: 'a', type: 'agent', position: { x: 0, y: 0 }, data: { label: 'Writer' } }],
  });
  if (saved) canvas.meta({ name: 'work.corral' });
  cleanups.push(() => {
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
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(await screen.findByRole('button', { name }));
  });
};
it.each([
  ['Save', 'canvas.save', true],
  ['Save', 'canvas.saveAs', false],
  ['Save as…', 'canvas.saveAs', true],
  ['Choose a project folder', 'project.choose', true],
] as const)('%s calls only %s (saved=%s)', async (button, op, saved) => {
  const canvas = setup(saved);
  canvas.core.respond(op, op === 'project.choose' ? { project: null } : { name: null });
  await click(button);
  await waitFor(() => {
    expectOneOp(canvas.core, op, { canvas: canvas.document.id });
  });
});
it.each(['New', 'Open…'])('%s keeps edited work without a discard question', async (button) => {
  const canvas = setup();
  canvas.meta({ edited: true });
  const before = canvas.document.id;
  const op = button === 'New' ? 'canvas.create' : 'canvas.open';
  if (op === 'canvas.open')
    canvas.core.reply(op, () => {
      canvas.open({ id: newCanvasId(), arrange: false, nodes: [], links: [] });
      return Promise.resolve({ ok: true, value: { canvas: canvas.document.id, revs: {} } });
    });
  await click(button);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  await waitFor(() => {
    expectOneOp(canvas.core, op, {});
  });
  await waitFor(() => {
    expect(screen.queryByText('Writer')).toBeNull();
  });
  expect(canvas.document.id).not.toBe(before);
  expect(screen.getByRole('status').textContent).toContain('stays open with its changes');
});
it('a cancelled Open keeps the canvas and its selection', async () => {
  const canvas = setup();
  canvas.core.respond('canvas.open', { canvas: null });
  await click('Open…');
  await waitFor(() => {
    expectOneOp(canvas.core, 'canvas.open', {});
  });
  expect(screen.getByText('Writer')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
});
it('a role draft commits as one agent.setRole and a refusal stays at the field', async () => {
  const canvas = setup();
  await act(async () => {
    fireEvent.doubleClick(screen.getByText('Writer'));
  });
  await click('Agent settings: Writer');
  // The summary menu opens the settings sheet.
  if (!screen.queryByRole('textbox', { name: 'Role' })) await click('Agent settings…');
  const role = await screen.findByRole('textbox', { name: 'Role' });
  canvas.core.reply('agent.setRole', {
    ok: false,
    error: { code: 'unavailable', sentence: 'Not saved' },
  });
  await act(async () => {
    fireEvent.focus(role);
    fireEvent.change(role, { target: { value: 'Review carefully' } });
    fireEvent.blur(role);
  });
  await waitFor(() => {
    expectOneOp(canvas.core, 'agent.setRole', {
      canvas: canvas.document.id,
      agent: 'a',
      role: 'Review carefully',
    });
  });
  expect(await screen.findByText('Not saved')).toBeTruthy();
  expect((role as HTMLTextAreaElement).value).toBe('Review carefully');
});

it.each([
  ['Claude · Agent SDK', 'agent.setConnection', { connection: 'claude-code.sdk' }],
  ['Codex · App Server', 'agent.setType', { adapter: 'codex', connection: 'codex.app-server' }],
] as const)('the agent chip chooses %s with one %s', async (choice, op, args) => {
  const canvas = setup();
  await act(async () => {
    fireEvent.doubleClick(screen.getByText('Writer'));
  });
  await click('Agent: Claude · Terminal');
  await act(async () => {
    fireEvent.click(await screen.findByRole('option', { name: new RegExp(`^${choice}`) }));
  });
  await waitFor(() => {
    expectOneOp(canvas.core, op, { canvas: canvas.document.id, agent: 'a', ...args });
  });
  expect(await screen.findByRole('button', { name: `Agent: ${choice}` })).toBeTruthy();
});

it('a settings-sheet choice commits one agent.setSettings', async () => {
  const canvas = setup();
  await act(async () => {
    fireEvent.doubleClick(screen.getByText('Writer'));
  });
  await click('Agent settings: Writer');
  const sheet = await screen.findByRole('dialog', { name: 'Agent settings: Writer' });
  await act(async () => {
    fireEvent.click(within(sheet).getByRole('button', { name: /^Mode:/ }));
  });
  await act(async () => {
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /^Plan/ }));
  });
  await waitFor(() => {
    expectOneOp(canvas.core, 'agent.setSettings', {
      canvas: canvas.document.id,
      agent: 'a',
      adapter: 'claude-code',
      settings: { model: null, effort: null, mode: 'plan' },
    });
  });
  expect(canvas.document.nodes[0]?.data.settings?.['claude-code']?.mode).toBe('plan');
});

it('waits for the initial canvas mirror before reading run progress', async () => {
  const canvas = fakeCanvas({ id: newCanvasId(), arrange: false, nodes: [], links: [] });
  cleanups.push(() => { canvas.core.dispose(); });
  const ready = Promise.withResolvers<void>();
  vi.spyOn(canvas.core.topics, 'whenAt').mockReturnValue(ready.promise);
  const get = vi.fn(() => Promise.resolve({ id: canvas.document.id, token: 'run', checkpoint: null, notices: ['Restored from a snapshot.'] }));
  render(<GraphEditor canvas={canvas.document.id} client={canvas.core.api} mirror={canvas.core.topics} runSource={{ get, save: () => Promise.resolve(null), ready: () => Promise.resolve(null), onStopping: () => () => undefined }} />);
  await act(() => Promise.resolve());
  expect(get).not.toHaveBeenCalled();
  await act(async () => { ready.resolve(); });
  await waitFor(() => { expect(get).toHaveBeenCalledOnce(); });
  expect(await screen.findByText('Restored from a snapshot.')).toBeTruthy();
});
