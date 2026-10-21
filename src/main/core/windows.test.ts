import { describe, expect, it, vi } from 'vitest';

import { newCanvasId } from '../../shared/canvas';
import type { CanvasId } from '../../shared/canvas';
import { Windows } from './windows';

let nextWindow = 0;
const window = () => ++nextWindow;

function windows(restore: () => Promise<CanvasId> = () => Promise.resolve(newCanvasId())) {
  const left = vi.fn<(canvas: CanvasId) => Promise<void>>().mockResolvedValue(undefined);
  const restoring = vi.fn(restore);
  return { windows: new Windows({ restore: restoring, left }), left, restoring };
}

describe('the windows and their canvases', () => {
  it('restores the last canvas for a window that first asks, once, however many ask', async () => {
    const last = newCanvasId();
    const { windows: shown, restoring } = windows(() => Promise.resolve(last));
    const contents = window();
    const [a, b] = await Promise.all([shown.canvasOf(contents), shown.canvasOf(contents)]);
    expect([a, b]).toEqual([last, last]);
    expect(await shown.canvasOf(contents)).toBe(last);
    expect(restoring).toHaveBeenCalledOnce();
    expect(shown.has(contents)).toBe(true);
  });

  it('tries a restore that failed again the next time a window asks', async () => {
    const last = newCanvasId();
    let fail = true;
    const { windows: shown } = windows(() =>
      fail ? Promise.reject(new Error('Corrupt journal')) : Promise.resolve(last),
    );
    const contents = window();
    await expect(shown.canvasOf(contents)).rejects.toThrow('Corrupt journal');
    expect(shown.has(contents)).toBe(false);
    fail = false;
    await expect(shown.canvasOf(contents)).resolves.toBe(last);
  });

  it('shows the canvas a window opens; the one before leaves it, and its sessions end', async () => {
    const { windows: shown, left } = windows();
    const contents = window();
    const first = await shown.canvasOf(contents);
    const next = newCanvasId();
    await shown.show(contents, next);
    expect(left).toHaveBeenCalledWith(first);
    expect(await shown.canvasOf(contents)).toBe(next);
    expect(shown.showing(first)).toEqual([]);
    expect(shown.showing(next)).toEqual([contents]);
    expect(shown.shownIn(contents)).toBe(next);
    // A window that showed none (its restore failed) leaves nothing.
    const fresh = window();
    expect(shown.shownIn(fresh)).toBeUndefined();
    await shown.show(fresh, newCanvasId());
    expect(left).toHaveBeenCalledOnce();
  });

  it('ends a gone window’s sessions, keeping its canvas for the page that reconnects', async () => {
    const { windows: shown, left } = windows();
    const contents = window();
    const canvas = await shown.canvasOf(contents);
    const closed = Promise.withResolvers<undefined>();
    left.mockReturnValueOnce(closed.promise);
    const leaving = shown.gone(contents);
    expect(left).toHaveBeenCalledExactlyOnceWith(canvas);
    let restored = false;
    const asked = shown.canvasOf(contents).then((id) => {
      restored = true;
      return id;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(restored).toBe(false);
    closed.resolve(undefined);
    await leaving;
    expect(await asked).toBe(canvas);
  });

  it('forgets a destroyed window, including a restore still in progress', async () => {
    const last = newCanvasId();
    const restore = Promise.withResolvers<typeof last>();
    const { windows: shown, left } = windows(() => restore.promise);
    const contents = window();
    const restoring = shown.canvasOf(contents);
    await shown.gone(contents, true);
    restore.resolve(last);
    await restoring;
    expect(shown.has(contents)).toBe(false);
    expect(shown.showing(last)).toEqual([]);
    expect(left).not.toHaveBeenCalled();
  });

  it('forgets a closed window’s canvas and ends its sessions', async () => {
    const { windows: shown, left } = windows();
    const contents = window();
    const canvas = await shown.canvasOf(contents);
    await shown.gone(contents, true);
    expect(left).toHaveBeenCalledExactlyOnceWith(canvas);
    expect(shown.has(contents)).toBe(false);
    expect(shown.showing(canvas)).toEqual([]);
  });
});
