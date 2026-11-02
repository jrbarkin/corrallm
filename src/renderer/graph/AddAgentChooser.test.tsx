import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AddAgentChooser } from './AddAgentChooser';
import { useCatalog } from '../test-catalog';
import { TWO_MADE_UP } from '../../shared/test-made-up';
import { fakeCore, expectOneOp } from '../test-api';
import { newCanvasId } from '../../shared/canvas';

afterEach(cleanup);
describe('choosing an endpoint while adding an agent', () => {
  it('keeps catalog order, selects nothing, ignores Enter until a pick, then adds with one operation', async () => {
    const restore = await useCatalog(TWO_MADE_UP);
    const core = fakeCore();
    const canvas = newCanvasId();
    try {
      render(
        <AddAgentChooser
          installed={{ zed: false, yak: true }}
          onClose={vi.fn()}
          onPick={(endpoint) => {
            void core.api.canvasAddAgent({ canvas, at: { x: 1, y: 2 }, ...endpoint });
          }}
        />,
      );
      expect(screen.getAllByRole('radio').map((item) => item.getAttribute('aria-label'))).toEqual([
        'Zed Agent',
        'Yak Agent',
      ]);
      expect(
        screen.getAllByRole('radio').every((item) => !(item as HTMLInputElement).checked),
      ).toBe(true);
      expect(screen.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', true);
      fireEvent.submit(
        screen.getByRole('dialog', { name: 'Choose an agent' }).querySelector('form') ??
          document.body,
      );
      expect(core.operations).toEqual([]);
      fireEvent.click(screen.getByRole('radio', { name: 'Zed Agent' }));
      expect(screen.getByText('Not installed')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      await waitFor(() => {
        expectOneOp(core, 'canvas.addAgent', {
          canvas,
          at: { x: 1, y: 2 },
          adapter: 'zed',
          connection: 'zed.acp',
        });
      });
    } finally {
      await restore();
      core.dispose();
    }
  });
  it('sends nothing on Cancel even when only one adapter is installed', async () => {
    const restore = await useCatalog(TWO_MADE_UP);
    const pick = vi.fn();
    const close = vi.fn();
    try {
      render(
        <AddAgentChooser installed={{ zed: true, yak: false }} onPick={pick} onClose={close} />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(close).toHaveBeenCalledOnce();
      expect(pick).not.toHaveBeenCalled();
    } finally {
      await restore();
    }
  });
});
