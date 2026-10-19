import { describe, expect, it } from 'vitest';

import { FirstRuns } from './first-run';
import type { FirstRunTurn } from '../terminal/first-run';

/** Whether a turn may start: now, or once its wait has resolved (by the time this settles). */
async function started(turn: FirstRunTurn): Promise<boolean> {
  if (turn.ready === undefined) return true;
  return Promise.race([
    turn.ready.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(resolve, 5, false)),
  ]);
}

describe('FirstRuns', () => {
  it('starts one session first in a new folder, and the others once it is past its dialogs', async () => {
    const runs = new FirstRuns();
    const first = runs.take('/work/shop');
    const second = runs.take('/work/shop');
    const third = runs.take('/work/shop');
    expect(await started(first)).toBe(true);
    expect(await started(second)).toBe(false);
    expect(await started(third)).toBe(false);
    // Another folder waits on nothing here.
    expect(await started(runs.take('/work/blog'))).toBe(true);

    first.passed();
    expect(await started(second)).toBe(true);
    expect(await started(third)).toBe(true);
    // The folder is trusted: later sessions start at once.
    expect(runs.take('/work/shop').ready).toBeUndefined();
  });

  it('starts the next one waiting when the first goes before getting past them', async () => {
    const runs = new FirstRuns();
    const first = runs.take('/work/shop');
    const second = runs.take('/work/shop');
    const third = runs.take('/work/shop');
    // The user picked "No, exit" in the first one's terminal.
    first.done();
    expect(await started(second)).toBe(true);
    expect(await started(third)).toBe(false);
    // One that goes while it waits is no longer waited for.
    third.done();
    const fourth = runs.take('/work/shop');
    second.done();
    expect(await started(fourth)).toBe(true);
    expect(await started(third)).toBe(false);
  });

  it('lets only the session started first say the folder is trusted', async () => {
    const runs = new FirstRuns();
    const first = runs.take('/work/shop');
    const second = runs.take('/work/shop');
    second.passed();
    expect(await started(second)).toBe(false);
    first.passed();
    expect(await started(second)).toBe(true);
    // Done once past: nothing changes.
    first.done();
    expect(runs.take('/work/shop').ready).toBeUndefined();
  });
});
