import { describe, expect, it, vi } from 'vitest';

import { newCanvasId } from '../../shared/canvas';
import type { CanvasId } from '../../shared/canvas';
import { Windows } from './windows';

let nextWindow = 0;
const window = () => ++nextWindow;

function windows(restore: () => Promise<CanvasId> = () => Promise.resolve(newCanvasId())) {
  const shown = vi.fn<(canvas: CanvasId) => Promise<void>>().mockResolvedValue(undefined);
  const restoring = vi.fn(restore);
  return { windows: new Windows({ restore: restoring, shown }), shown, restoring };
}

describe('the windows and their canvases', () => {
  it('restores the last canvas for a window that first asks, once, however many ask', async () => {
    const last = newCanvasId();
    const { windows: views, restoring, shown } = windows(() => Promise.resolve(last));
    const contents = window();
    const [a, b] = await Promise.all([views.canvasOf(contents), views.canvasOf(contents)]);
    expect([a, b]).toEqual([last, last]);
    expect(await views.canvasOf(contents)).toBe(last);
    expect(restoring).toHaveBeenCalledOnce();
    // The core runs the canvas a window restores before the window sees it (B11 Design §8).
    expect(shown).toHaveBeenCalledExactlyOnceWith(last);
    expect(views.has(contents)).toBe(true);
  });

  it('shows a restored canvas even if the core can’t run it: its topics say why', async () => {
    const last = newCanvasId();
    const { windows: views, shown } = windows(() => Promise.resolve(last));
    shown.mockRejectedValueOnce(new Error('Its file holds another canvas now'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const contents = window();
    try {
      await expect(views.canvasOf(contents)).resolves.toBe(last);
      expect(views.shownIn(contents)).toBe(last);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('tries a restore that failed again the next time a window asks', async () => {
    const last = newCanvasId();
    let fail = true;
    const { windows: views } = windows(() =>
      fail ? Promise.reject(new Error('Corrupt journal')) : Promise.resolve(last),
    );
    const contents = window();
    await expect(views.canvasOf(contents)).rejects.toThrow('Corrupt journal');
    expect(views.has(contents)).toBe(false);
    fail = false;
    await expect(views.canvasOf(contents)).resolves.toBe(last);
  });

  it('shows the canvas a window opens, run by the core first; the one before runs on', async () => {
    const { windows: views, shown } = windows();
    const contents = window();
    const first = await views.canvasOf(contents);
    const next = newCanvasId();
    await views.show(contents, next);
    expect(shown).toHaveBeenLastCalledWith(next);
    expect(await views.canvasOf(contents)).toBe(next);
    expect(views.showing(first)).toEqual([]);
    expect(views.showing(next)).toEqual([contents]);
    expect(views.shownIn(contents)).toBe(next);
  });

  it('keeps the window on its canvas when the core can’t run the one it would show', async () => {
    const { windows: views, shown } = windows();
    const contents = window();
    const first = await views.canvasOf(contents);
    shown.mockRejectedValueOnce(new Error('Its file holds another canvas now'));
    await expect(views.show(contents, newCanvasId())).rejects.toThrow('another canvas');
    expect(views.shownIn(contents)).toBe(first);
    expect(views.showing(first)).toEqual([contents]);
  });

  it('keeps the current canvas when asked to show it again', async () => {
    const { windows: views, shown } = windows();
    const contents = window();
    const canvas = await views.canvasOf(contents);
    await views.show(contents, canvas);
    expect(shown).toHaveBeenCalledOnce();
    expect(await views.canvasOf(contents)).toBe(canvas);
    expect(views.showing(canvas)).toEqual([contents]);
  });

  it('keeps a reloaded or crashed window’s canvas for the page that reconnects, at once', async () => {
    const { windows: views, shown } = windows();
    const contents = window();
    const canvas = await views.canvasOf(contents);
    await views.gone(contents);
    // Nothing of its canvas ends, and nothing is waited for: the core runs it whether or not a
    // window shows it (B11 Design §8).
    expect(await views.canvasOf(contents)).toBe(canvas);
    expect(views.showing(canvas)).toEqual([contents]);
    expect(shown).toHaveBeenCalledOnce();
  });

  it('forgets a destroyed window, including a restore still in progress', async () => {
    const last = newCanvasId();
    const restore = Promise.withResolvers<typeof last>();
    const { windows: views } = windows(() => restore.promise);
    const contents = window();
    const restoring = views.canvasOf(contents);
    await views.gone(contents, true);
    restore.resolve(last);
    await restoring;
    expect(views.has(contents)).toBe(false);
    expect(views.showing(last)).toEqual([]);
  });

  it('forgets a closed window’s canvas, which runs on in the core', async () => {
    const { windows: views } = windows();
    const contents = window();
    const canvas = await views.canvasOf(contents);
    const told = vi.fn();
    views.subscribe(told);
    await views.gone(contents, true);
    expect(views.has(contents)).toBe(false);
    expect(views.showing(canvas)).toEqual([]);
    expect(told).toHaveBeenCalledOnce();
  });
});
