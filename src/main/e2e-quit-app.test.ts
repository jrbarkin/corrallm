import { EventEmitter } from 'node:events';

import type { ElectronApplication } from '@playwright/test';
import { expect, it, vi } from 'vitest';

import { quitApp } from '../../e2e/quit-app';

it('finishes the app quit before Playwright tears down its context', async () => {
  const calls: string[] = [];
  const native = Object.assign(new EventEmitter(), {
    quit: () => {
      calls.push('quit');
    },
  });
  const close = vi.fn(() => {
    calls.push('context.close');
    return Promise.resolve();
  });
  const evaluate = vi.fn((callback: (electron: unknown) => Promise<unknown>) =>
    callback({ app: native }),
  );
  const app = { evaluate, close } as unknown as ElectronApplication;
  const quitting = quitApp(app);
  expect(calls).toEqual(['quit']);
  expect(close).not.toHaveBeenCalled();
  const event = { preventDefault: vi.fn() };
  native.emit('will-quit', event);
  await quitting;
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(calls).toEqual(['quit', 'context.close']);
  expect(native.listenerCount('will-quit')).toBe(0);
});

it('still closes the Playwright context when the app exits during its quit', async () => {
  const error = new Error('The app exited before the evaluation answered');
  const close = vi.fn(() => Promise.resolve());
  const app = {
    evaluate: vi.fn(() => Promise.reject(error)),
    close,
  } as unknown as ElectronApplication;
  await expect(quitApp(app)).rejects.toBe(error);
  expect(close).toHaveBeenCalledOnce();
});
