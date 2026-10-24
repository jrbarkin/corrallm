import { expect, it, vi } from 'vitest';
import type { Locator, Page } from '@playwright/test';

import { clickTerminalLink } from '../../e2e/terminal-link';

it('waits for asynchronous link discovery before clicking, and releases the modifier', async () => {
  const ready = Promise.withResolvers<undefined>();
  const keys: string[] = [];
  const click = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const move = vi.fn();
  const page = {
    mouse: { move, click },
    keyboard: {
      down: (key: string) => keys.push(`down ${key}`),
      up: (key: string) => keys.push(`up ${key}`),
    },
  } as unknown as Page;
  const screen = { boundingBox: () => Promise.resolve({ x: 10, y: 20, width: 800, height: 400 }) };
  const pointer = { waitFor: () => ready.promise };
  const view = {
    locator: (selector: string) => (selector === '.xterm-screen' ? screen : pointer),
  } as unknown as Locator;
  const clicking = clickTerminalLink(page, view, { cols: 80, rows: 20 }, 12, 3);
  await vi.waitFor(() => {
    expect(move).toHaveBeenCalledTimes(2);
  });
  expect(click).not.toHaveBeenCalled();
  expect(keys).toEqual([]);
  ready.resolve(undefined);
  await clicking;
  expect(click).toHaveBeenCalledWith(135, 90);
  expect(keys).toEqual(['down ControlOrMeta', 'up ControlOrMeta']);

  keys.length = 0;
  click.mockRejectedValueOnce(new Error('lost page'));
  await expect(clickTerminalLink(page, view, { cols: 80, rows: 20 }, 12, 3)).rejects.toThrow(
    'lost page',
  );
  expect(keys).toEqual(['down ControlOrMeta', 'up ControlOrMeta']);
});
