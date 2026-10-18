import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunShutdown } from './run-shutdown';

const contents = () =>
  ({ isDestroyed: () => false, isCrashed: () => false }) as Electron.WebContents;
afterEach(() => vi.useRealTimers());
describe('run shutdown acknowledgement', () => {
  it('waits for the same renderer and request, rejecting mismatched acknowledgements', async () => {
    const send = vi.fn();
    const shutdown = new RunShutdown(send);
    const window = contents();
    const stopping = shutdown.stop(window);
    const request = send.mock.calls[0]?.[1] as string;
    expect(() => {
      shutdown.ready(contents(), request, null);
    }).toThrow(/matching/);
    expect(() => {
      shutdown.ready(window, 'old', null);
    }).toThrow(/matching/);
    shutdown.ready(window, request, null);
    await stopping;
  });
  it('surfaces renderer save failures', async () => {
    const send = vi.fn();
    const shutdown = new RunShutdown(send);
    const window = contents();
    const stopping = shutdown.stop(window);
    const rejected = expect(stopping).rejects.toThrow('Disk full');
    shutdown.ready(window, send.mock.calls[0]?.[1] as string, 'Disk full');
    await rejected;
  });
  it('times out instead of silently closing an unsaved window', async () => {
    vi.useFakeTimers();
    const shutdown = new RunShutdown(vi.fn(), 10);
    const rejected = expect(shutdown.stop(contents())).rejects.toThrow(/did not finish saving/);
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
  });
});
