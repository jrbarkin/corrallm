import { afterEach, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => vi.fn(() => 'darwin'));
vi.mock('node:os', () => ({ platform }));
afterEach(() => {
  vi.clearAllMocks();
});
import type { Locator, Page } from '@playwright/test';

import { clickTerminalLink } from '../../e2e/terminal-link';

it.each([
  ['darwin', 'Meta'],
  ['linux', 'Control'],
  ['win32', 'Control'],
])(
  'waits for the screen link on %s, clicks with %s, and releases it even on failure',
  async (os, modifier) => {
    platform.mockReturnValue(os);
    const ready = Promise.withResolvers<undefined>();
    const keys: string[] = [];
    const click = vi.fn<() => Promise<void>>(() => {
      expect(keys).toEqual([`down ${modifier}`]);
      return Promise.resolve();
    });
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
    const pointer = { waitFor: () => ready.promise };
    const view = {
      locator: (selector: string) => {
        if (selector === '.xterm-screen') return screen;
        if (selector === '.xterm-screen.xterm-cursor-pointer') return pointer;
        throw new Error(
          'xterm sets the link pointer on its screen, not the outer terminal: ' + selector,
        );
      },
    } as unknown as Locator;
    const clicking = clickTerminalLink(page, view, { cols: 80, rows: 20 }, 12, 3);
    void clicking.catch(() => undefined);
    await vi.waitFor(() => {
      expect(move).toHaveBeenCalledTimes(2);
    });
    expect(click).not.toHaveBeenCalled();
    expect(keys).toEqual([]);
    ready.resolve(undefined);
    await clicking;
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
