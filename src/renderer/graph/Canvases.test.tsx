import { cleanup, render, screen, within, waitFor, act } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { newCanvasId } from '../../shared/canvas';
import { fakeCore, expectOneOp } from '../test-api';
import { events } from '../test-render';
import { Canvases } from './Canvases';

const cores: ReturnType<typeof fakeCore>[] = [];
afterEach(() => {
  cleanup();
  cores.splice(0).forEach((core) => {
    core.dispose();
  });
});
const current = newCanvasId(),
  other = newCanvasId();
const row = (canvas = current, name: string | null = 'work.corral') => ({
  canvas,
  name,
  edited: true,
  running: true,
  open: true,
  project: { name: 'Project', path: '/work' },
  shownIn: [7],
});
function setup() {
  const core = fakeCore();
  cores.push(core);
  core.snapshot('canvases', {
    items: [row(), { ...row(other, null), open: false, running: false, shownIn: [] }],
  });
  render(
    <Canvases
      canvas={current}
      mirror={core.topics}
      client={core.api}
      onShow={async (canvas) => {
        await core.api.windowShow({ canvas });
      }}
      onClose={async (canvas, discard) => {
        await core.api.canvasClose({ canvas, ...(discard ? { discard: true } : {}) });
      }}
    />,
  );
  return core;
}

it('keeps closed-canvas work and its pending confirmation reachable after reopening the list', async () => {
  const core = setup();
  const worktree = '11111111-1111-4111-8111-111111111111';
  core.snapshot(`worktrees:${current}`, { items: [], into: null, kept: [] });
  core.snapshot(`needs:${current}`, { items: [] });
  core.snapshot(`worktrees:${other}`, {
    items: [],
    into: null,
    kept: [
      {
        workspace: worktree,
        owner: 'agent/old',
        name: 'Former agent',
        branch: 'corral/old',
        base: { ref: 'main', oid: '123' },
        location: '/project/kept',
        state: 'retained',
        error: null,
        createdAt: 1,
      },
    ],
  });
  core.snapshot(`needs:${other}`, {
    items: [
      {
        id: 'proposal/kept',
        canvas: other,
        kind: 'proposal',
        for: 'you',
        by: ['you'],
        answerIn: 'api',
        title: 'Remove a kept worktree? It holds work.',
        choices: [{ label: 'Cancel', value: 'refuse' }],
      },
    ],
  });
  await events.click(screen.getByRole('button', { name: 'Canvases' }));
  const kept = await screen.findByRole('region', { name: 'Kept worktrees of Untitled' });
  expect(within(kept).getByText('Former agent')).toBeTruthy();
  expect(within(kept).getByText('corral/old')).toBeTruthy();
  await events.click(screen.getByRole('button', { name: 'Close Canvases list' }));
  await events.click(screen.getByRole('button', { name: 'Canvases' }));
  await events.click(await screen.findByRole('button', { name: 'Cancel' }));
  expectOneOp(core, 'reply', { canvas: other, to: 'proposal/kept', answer: { choice: 'refuse' } });
});
it('reads the pushed list in core order with its states and project, and follows changes', async () => {
  const core = setup();
  await events.click(screen.getByRole('button', { name: 'Canvases' }));
  const list = await screen.findByRole('dialog', { name: 'Canvases' });
  const rows = within(list).getAllByRole('listitem');
  expect(rows[0]?.textContent).toContain('work.corral');
  for (const text of ['Edited', 'Running', 'Open', 'Shown in this window', 'Project'])
    expect(rows[0]?.textContent).toContain(text);
  expect(rows[1]?.textContent).toContain('Untitled');
  expect(rows[1]?.textContent).toContain('Closed');
  act(() => {
    core.change({ topic: 'canvases', rev: 1, replace: { items: [row(other, 'other.corral')] } });
  });
  expect(within(list).queryByText('work.corral')).toBeNull();
  expect(within(list).getByText('other.corral')).toBeTruthy();
  expect(core.operations).toEqual([]);
});
it('shows a kept canvas with one window.show', async () => {
  const core = setup();
  await events.click(screen.getByRole('button', { name: 'Canvases' }));
  await events.click(await screen.findByRole('button', { name: 'Show Untitled' }));
  await waitFor(() => {
    expectOneOp(core, 'window.show', { canvas: other });
  });
});
it.each([false, true])(
  'closes with one canvas.close; discard is explicit (%s)',
  async (discard) => {
    const core = setup();
    await events.click(screen.getByRole('button', { name: 'Canvases' }));
    const label = discard ? 'Discard changes and close work.corral' : 'Close work.corral';
    await events.click(await screen.findByRole('button', { name: label }));
    if (discard) {
      expect(core.operations).toEqual([]);
      await events.click(
        within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }),
      );
    }
    await waitFor(() => {
      expectOneOp(core, 'canvas.close', { canvas: current, ...(discard ? { discard: true } : {}) });
    });
  },
);
it('says a refusal at the list and allows another attempt', async () => {
  const core = setup();
  core.reply('window.show', {
    ok: false,
    error: { code: 'unavailable', sentence: 'Could not load' },
  });
  await events.click(screen.getByRole('button', { name: 'Canvases' }));
  await events.click(await screen.findByRole('button', { name: 'Show Untitled' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not load');
  expect(screen.getByRole('button', { name: 'Show Untitled' })).not.toHaveProperty(
    'disabled',
    true,
  );
});
