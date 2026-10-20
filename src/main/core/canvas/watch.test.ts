import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CanvasId } from '../../../shared/canvas';
import { FileWatch, SETTLE_MS } from './watch';
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
let opened: string[];
let checked: CanvasId[];
let watch: FileWatch;

const fake: WatchFolder = (folder, changed) => {
  opened.push(folder);
  watched.set(folder, changed);
  return {
    close: () => {
      watched.delete(folder);
    },
  };
};

beforeEach(() => {
  vi.useFakeTimers();
  watched = new Map();
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

  it('leaves a folder that can’t be watched to the other checks', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = new FileWatch({
      watch: () => {
        throw new Error('Too many open files');
      },
      check: (canvas) => {
        checked.push(canvas);
      },
    });
    failing.follow(new Map([[ONE, path.join(HERE, 'one.corral')]]));
    expect(error).toHaveBeenCalledWith(
      `Could not watch ${HERE} for canvas files changed on disk:`,
      expect.objectContaining({ message: 'Too many open files' }),
    );
    failing.close();
  });
});
