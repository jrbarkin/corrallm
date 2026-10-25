import { afterEach, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => vi.fn(() => 'darwin'));
vi.mock('node:os', () => ({ platform }));
afterEach(() => {
  vi.clearAllMocks();
});
import type { Locator, Page } from '@playwright/test';

import { clickTerminalLink } from '../../e2e/terminal-link';

/** A page and terminal view whose link pointer shows as `pointer` says. */
function fakes(pointer: (options: { state: string; timeout: number }) => Promise<unknown>) {
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
  const screen = {
    boundingBox: () => Promise.resolve({ x: 10, y: 20, width: 800, height: 400 }),
  };
  const waitFor = vi.fn(pointer);
  const view = {
    locator: (selector: string) => {
      if (selector === '.xterm-screen') return screen;
      if (selector === '.xterm-screen.xterm-cursor-pointer') return { waitFor };
      throw new Error(
        'xterm sets the link pointer on its screen, not the outer terminal: ' + selector,
      );
    },
  } as unknown as Locator;
  return { page, view, keys, click, move, waitFor };
}

it.each([
  ['darwin', 'Meta'],
  ['linux', 'Control'],
  ['win32', 'Control'],
])(
  'waits for the screen link on %s, clicks with %s, and releases it even on failure',
  async (os, modifier) => {
    platform.mockReturnValue(os);
    const ready = Promise.withResolvers<undefined>();
    const { page, view, keys, click, move } = fakes(() => ready.promise);
    click.mockImplementation(() => {
      expect(keys).toEqual([`down ${modifier}`]);
      return Promise.resolve();
    });
    const clicking = clickTerminalLink(page, view, { cols: 80, rows: 20 }, 12, 3);
    void clicking.catch(() => undefined);
    await vi.waitFor(() => {
      expect(move).toHaveBeenCalledTimes(2);
    });
    expect(click).not.toHaveBeenCalled();
    expect(keys).toEqual([]);
    ready.resolve(undefined);
    await expect(clicking).resolves.toBe(true);
    expect(click).toHaveBeenCalledWith(135, 90);
    expect(keys).toEqual([`down ${modifier}`, `up ${modifier}`]);

    keys.length = 0;
    click.mockRejectedValueOnce(new Error('lost page'));
    await expect(clickTerminalLink(page, view, { cols: 80, rows: 20 }, 12, 3)).rejects.toThrow(
      'lost page',
    );
    expect(keys).toEqual([`down ${modifier}`, `up ${modifier}`]);
  },
);

it('comes onto the link’s row from another row, so xterm asks for that row’s links afresh', async () => {
  // xterm keeps a row's links while the pointer stays on the row: a pointer that came onto it
  // before the CLI's text did would never see the link from a cell of the same row.
  const { page, view, move } = fakes(() => Promise.resolve());
  await clickTerminalLink(page, view, { cols: 80, rows: 20 }, 12, 3);
  // Cells are 10×20 from (10, 20): row 3's middle is y 90, row 4's 110.
  expect(move.mock.calls).toEqual([
    [135, 110],
    [135, 90, { steps: 2 }],
  ]);
  move.mockClear();
  // The last row is come onto from the one above it.
  await clickTerminalLink(page, view, { cols: 80, rows: 20 }, 12, 19);
  expect(move.mock.calls[0]).toEqual([135, 390]);
});

it('neither clicks nor holds a modifier where xterm shows no link in time, for the caller to hover again', async () => {
  const timeout = Object.assign(new Error('locator.waitFor: Timeout exceeded.'), {
    name: 'TimeoutError',
  });
  const { page, view, keys, click, waitFor } = fakes(() => Promise.reject(timeout));
  await expect(clickTerminalLink(page, view, { cols: 80, rows: 20 }, 12, 3)).resolves.toBe(false);
  expect(click).not.toHaveBeenCalled();
  expect(keys).toEqual([]);
  // Briefly: the caller's poll (5 s by default) has time to hover again.
  expect(waitFor.mock.calls[0]?.[0].timeout).toBeLessThanOrEqual(1000);

  // Anything else (the page went) still fails the click.
  waitFor.mockRejectedValueOnce(new Error('Target page, context or browser has been closed'));
  await expect(clickTerminalLink(page, view, { cols: 80, rows: 20 }, 12, 3)).rejects.toThrow(
    'closed',
  );
  expect(click).not.toHaveBeenCalled();
});
