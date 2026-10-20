import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import { FileWatch, RETRY_MS, SETTLE_MS } from './watch';
import type { WatchFolder } from './watch';

/*
 * The open canvases' files, watched through their folders (B9 Design §5), against a fake watch and
 * a fake clock: fs.watch itself is exercised in core/reviews.test.ts.
 */

const ONE = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f01' as CanvasId;
const TWO = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f02' as CanvasId;
const THREE = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4f03' as CanvasId;
const HERE = path.resolve('/work/canvases');
const THERE = path.resolve('/work/elsewhere');

/** Each folder watched now, and what it tells of a change of an entry. */
let watched: Map<string, (name: string | null) => void>;
let stopped: Map<string, () => void>;
let unavailable: boolean;
let opened: string[];
let checked: CanvasId[];
let watch: FileWatch;

const fake: WatchFolder = (folder, changed, ended) => {
  opened.push(folder);
  if (unavailable) throw new Error('Folder is gone');
  stopped.set(folder, ended);
  watched.set(folder, changed);
  return {
    close: () => {
      watched.delete(folder);
      stopped.delete(folder);
      ended();
    },
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  watched = new Map();
  stopped = new Map();
  unavailable = false;
  opened = [];
  checked = [];
  watch = new FileWatch({
    watch: fake,
    check: (canvas) => {
      checked.push(canvas);
    },
  });
});
afterEach(() => {
  watch.close();
  vi.useRealTimers();
});

function tell(folder: string, name: string | null): void {
  const changed = watched.get(folder);
  if (changed === undefined) throw new Error(`${folder} isn’t watched.`);
  changed(name);
}

describe('the open canvases’ files', () => {
  it('are watched one folder at a time, each canvas checked once its file settles', () => {
    watch.follow(
      new Map([
        [ONE, path.join(HERE, 'one.corral')],
        [TWO, path.join(HERE, 'two.corral')],
      ]),
    );
    expect(opened).toEqual([HERE]);
    expect(checked).toEqual([]);

    // An editor's writes in a row are checked once, once they settle; another entry is none's.
    tell(HERE, 'one.corral');
    vi.advanceTimersByTime(SETTLE_MS - 1);
    tell(HERE, 'one.corral');
    tell(HERE, 'one.corral.swp');
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(checked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(checked).toEqual([ONE]);

    // An entry unnamed may be any.
    tell(HERE, null);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(checked).toEqual([ONE, ONE, TWO]);
  });

  it('are watched only while open: a folder no open canvas needs is closed, and all as it closes', () => {
    watch.follow(
      new Map([
        [ONE, path.join(HERE, 'one.corral')],
        [TWO, path.join(THERE, 'two.corral')],
      ]),
    );
    tell(HERE, 'one.corral');
    // ONE closes before its check comes: it is dropped. TWO's file moves (Save As).
    watch.follow(new Map([[TWO, path.join(HERE, 'two.corral')]]));
    expect([...watched.keys()]).toEqual([HERE]);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(checked).toEqual([]);
    tell(HERE, 'two.corral');
    vi.advanceTimersByTime(SETTLE_MS);
    expect(checked).toEqual([TWO]);

    tell(HERE, 'two.corral');
    watch.close();
    expect(watched.size).toBe(0);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(checked).toEqual([TWO]);
    watch.follow(new Map([[THREE, path.join(THERE, 'three.corral')]]));
    expect(watched.size).toBe(0);
  });

  it.each(['folder name', 'error or close'])(
    're-arms after %s, backs off while absent and checks every canvas',
    (event) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      watch.follow(
        new Map([
          [ONE, path.join(HERE, 'one.corral')],
          [TWO, path.join(HERE, 'two.corral')],
        ]),
      );
      const oldChanged = watched.get(HERE);
      const oldStopped = stopped.get(HERE);
      if (!oldChanged || !oldStopped) throw new Error('No folder watch');
      unavailable = true;
      if (event === 'folder name') oldChanged(path.basename(HERE));
      else oldStopped();
      // Linux can send the folder's name twice, and closing a failed watch emits close too.
      oldChanged(path.basename(HERE));
      oldStopped();
      expect(watched.size).toBe(0);
      expect(opened).toHaveLength(1);
      vi.advanceTimersByTime(RETRY_MS);
      expect(opened).toHaveLength(2);
      vi.advanceTimersByTime(RETRY_MS);
      expect(opened).toHaveLength(2);
      unavailable = false;
      vi.advanceTimersByTime(RETRY_MS);
      expect(opened).toHaveLength(3);
      expect(watched.size).toBe(1);
      oldStopped();
      oldChanged(path.basename(HERE));
      expect(watched.size).toBe(1);
      // Anything written during the gap is checked, without another file event or a focus.
      vi.advanceTimersByTime(SETTLE_MS);
      expect(checked).toEqual([ONE, TWO]);
      tell(HERE, 'one.corral');
      vi.advanceTimersByTime(SETTLE_MS);
      expect(checked).toEqual([ONE, TWO, ONE]);
      expect(error).toHaveBeenCalled();
    },
  );

  it('caps the retry backoff at ten seconds, without polling a missing folder in a busy loop', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    unavailable = true;
    watch.follow(new Map([[ONE, path.join(HERE, 'one.corral')]]));
    vi.advanceTimersByTime(15_750);
    expect(opened).toHaveLength(7);
    vi.advanceTimersByTime(9_999);
    expect(opened).toHaveLength(7);
    vi.advanceTimersByTime(1);
    expect(opened).toHaveLength(8);
    expect(error).toHaveBeenCalledWith(
      `Could not watch ${HERE} for canvas files changed on disk:`,
      expect.objectContaining({ message: 'Folder is gone' }),
    );
    expect(vi.getTimerCount()).toBe(1);
    watch.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['last canvas closes', 'core closes'])('drops retries when the %s', (event) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    unavailable = true;
    watch.follow(new Map([[ONE, path.join(HERE, 'one.corral')]]));
    vi.advanceTimersByTime(RETRY_MS);
    expect(opened).toHaveLength(2);
    if (event === 'core closes') watch.close();
    else watch.follow(new Map());
    expect(vi.getTimerCount()).toBe(0);
    unavailable = false;
    vi.advanceTimersByTime(60_000);
    expect(opened).toHaveLength(2);
    expect(checked).toEqual([]);
  });
});
