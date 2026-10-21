import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { newCanvasId } from '../../shared/canvas';
import type { CanvasDocument } from '../../shared/model/canvas';
import type { RunSource } from '../run/persistence';
import { fakeCanvas } from '../test-canvas';
import { expectOneOp } from '../test-api';
import { events } from '../test-render';
import { GraphEditor } from './GraphEditor';
vi.mock('../terminal/screen', async () => ({
  createScreen: (await import('../terminal/test-screen')).fakeScreens.create,
}));

const stops: (() => void)[] = [];
afterEach(() => {
  cleanup();
  stops.splice(0).forEach((stop) => {
    stop();
  });
});
const document = (label: string): CanvasDocument => ({
  id: newCanvasId(),
  arrange: false,
  nodes: [{ id: label, type: 'agent', position: { x: 0, y: 0 }, data: { label } }],
  links: [],
});
it.each(['show', 'close', 'allow'] as const)(
  '%s is one operation, saving the old run and restoring the replacement after its mirror',
  async (action) => {
    const first = document('Before'),
      next = document('After');
    const canvas = fakeCanvas(first);
    stops.push(() => {
      canvas.core.dispose();
    });
    canvas.open(next);
    canvas.open(first);
    canvas.core.snapshot('canvases', {
      items: [first, next].map((doc) => ({
        canvas: doc.id,
        name: doc === first ? 'before.corral' : 'after.corral',
        edited: true,
        running: false,
        open: true,
        project: null,
        shownIn: doc === first ? [1] : [],
      })),
    });
    const proposal = 'proposal/11111111-1111-4111-8111-111111111111';
    if (action === 'allow')
      canvas.core.snapshot(`needs:${first.id}`, {
        items: [
          {
            id: proposal,
            canvas: first.id,
            kind: 'proposal',
            for: 'you',
            by: ['you'],
            title: 'Close this canvas',
            choices: [{ value: 'allow', label: 'Allow' }],
            answerIn: 'api',
          },
        ],
      });
    const order: string[] = [];
    const op = action === 'show' ? 'window.show' : action === 'close' ? 'canvas.close' : 'reply';
    canvas.core.reply(op, () => {
      order.push('op');
      canvas.open(next);
      return Promise.resolve({
        ok: true,
        value: {
          ...(action === 'show' ? {} : { canvas: next.id }),
          ...(action === 'allow' ? { outcome: 'allowed' } : {}),
          revs: {},
        },
      });
    });
    const get = vi.fn<RunSource['get']>(() => {
      order.push(`get:${canvas.document.id}`);
      return Promise.resolve({
        id: canvas.document.id,
        token: canvas.document.id,
        checkpoint: null,
      });
    });
    const save = vi.fn<RunSource['save']>((token) => {
      order.push(`save:${token}`);
      return Promise.resolve(null);
    });
    render(
      <GraphEditor
        canvas={first.id}
        client={canvas.core.api}
        mirror={canvas.core.topics}
        files
        runSource={{
          get,
          save,
          ready: () => Promise.resolve(null),
          onStopping: () => () => undefined,
        }}
      />,
    );
    await waitFor(() => {
      expect(save).toHaveBeenCalled();
    });
    order.length = 0;
    if (action === 'allow')
      await events.click(await screen.findByRole('button', { name: 'Allow' }));
    else {
      await events.click(screen.getByRole('button', { name: 'Canvases' }));
      await events.click(
        await screen.findByRole('button', {
          name: action === 'show' ? 'Show after.corral' : 'Close before.corral',
        }),
      );
    }
    await waitFor(() => {
      expect(screen.queryByText('Before')).toBeNull();
    });
    expect(await screen.findByText('After')).toBeTruthy();
    await waitFor(() => {
      expect(get).toHaveBeenCalledTimes(2);
    });
    expectOneOp(
      canvas.core,
      op,
      action === 'show'
        ? { canvas: next.id }
        : action === 'close'
          ? { canvas: first.id }
          : { canvas: first.id, to: proposal, answer: { choice: 'allow' } },
    );
    expect(order.indexOf(`save:${first.id}`)).toBeLessThan(order.indexOf('op'));
    expect(order.indexOf('op')).toBeLessThan(order.indexOf(`get:${next.id}`));
    if (action === 'close') expect(screen.queryByText(/stays open/)).toBeNull();
    if (action === 'allow')
      expect((await screen.findByRole('status')).textContent).toContain('allowed');
  },
);
