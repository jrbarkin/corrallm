import { EventEmitter } from 'node:events';

import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import { newCanvasId } from '../../shared/canvas';
import type { CanvasId } from '../../shared/canvas';
import { Windows } from './windows';

const ORIGIN = 'app://main_window';

/** A window's web contents, faked: it emits what Electron's would. */
const window = () => new EventEmitter() as unknown as WebContents & EventEmitter;
const navigation = (url: string, fields: Record<string, unknown> = {}) => ({
  url,
  isMainFrame: true,
  isSameDocument: false,
  ...fields,
});

function windows(restore: () => Promise<CanvasId> = () => Promise.resolve(newCanvasId())) {
  const left = vi.fn<(canvas: CanvasId) => Promise<void>>().mockResolvedValue(undefined);
  const restoring = vi.fn(restore);
  return { windows: new Windows(ORIGIN, { restore: restoring, left }), left, restoring };
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
    // A window that showed none (its restore failed) leaves nothing.
    const fresh = window();
    await shown.show(fresh, newCanvasId());
    expect(left).toHaveBeenCalledOnce();
  });

  it('ends a reloading window’s canvas’s sessions, and gives its page the canvas once they have', async () => {
    const { windows: shown, left } = windows();
    const contents = window();
    shown.watch(contents);
    const canvas = await shown.canvasOf(contents);
    const closed = Promise.withResolvers<undefined>();
    left.mockReturnValueOnce(closed.promise);
    contents.emit('did-start-navigation', navigation(`${ORIGIN}/index.html`));
    expect(left).toHaveBeenCalledWith(canvas);
    let restored = false;
    const asked = shown.canvasOf(contents).then((id) => {
      restored = true;
      return id;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(restored).toBe(false);
    closed.resolve(undefined);
    expect(await asked).toBe(canvas);

    // Navigations that are no reload leave it alone.
    contents.emit('did-start-navigation', navigation('https://example.com/'));
    contents.emit('did-start-navigation', navigation(`${ORIGIN}/`, { isMainFrame: false }));
    contents.emit('did-start-navigation', navigation(`${ORIGIN}/#x`, { isSameDocument: true }));
    expect(left).toHaveBeenCalledOnce();
  });

  it('ends a crashed window’s canvas’s sessions, keeping its canvas; a closed one forgets it', async () => {
    const { windows: shown, left } = windows();
    const contents = window();
    shown.watch(contents);
    const canvas = await shown.canvasOf(contents);
    contents.emit('render-process-gone');
    expect(left).toHaveBeenLastCalledWith(canvas);
    expect(shown.has(contents)).toBe(true);
    contents.emit('destroyed');
    expect(left).toHaveBeenCalledTimes(2);
    expect(shown.has(contents)).toBe(false);
    expect(shown.showing(canvas)).toEqual([]);
  });
});
