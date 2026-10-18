import { describe, expect, it } from 'vitest';

import { supervise } from './supervise';
import type { Supervision } from './supervise';

/*
 * What the host does when the core process exits: restart it after a crash, at most 3 times in
 * 60 s, then give up (and say so in a native dialog); nothing after a clean exit.
 */

const SECOND = 1000;

/** Feeds `exits` (exit code, at what time) through the policy, from a fresh start. */
function run(exits: [code: number, at: number][]): string[] {
  let state: Supervision = { restarts: [] };
  return exits.map(([code, at]) => {
    const { action, next } = supervise(state, code, at);
    state = next;
    return action;
  });
}

describe('supervising the core process', () => {
  it('restarts a crashed core at most 3 times in 60 s, then gives up', () => {
    expect(
      run([
        [1, 0],
        [1, 10 * SECOND],
        [1, 20 * SECOND],
        [1, 30 * SECOND],
      ]),
    ).toEqual(['restart', 'restart', 'restart', 'give-up']);
  });

  it('counts only the restarts of the last 60 s', () => {
    expect(
      run([
        [1, 0],
        [1, 30 * SECOND],
        [1, 59 * SECOND],
        // The first restart is now over a minute old.
        [1, 61 * SECOND],
        [1, 62 * SECOND],
      ]),
    ).toEqual(['restart', 'restart', 'restart', 'restart', 'give-up']);
  });

  it('keeps restarting a core that crashes now and then', () => {
    expect(
      run([
        [1, 0],
        [1, 61 * SECOND],
        [1, 122 * SECOND],
        [1, 183 * SECOND],
        [1, 244 * SECOND],
      ]),
    ).toEqual(['restart', 'restart', 'restart', 'restart', 'restart']);
  });

  it('treats a clean exit as no crash: nothing to restart, and nothing counted', () => {
    expect(
      run([
        [0, 0],
        [1, 1 * SECOND],
        [0, 2 * SECOND],
        [1, 3 * SECOND],
        [1, 4 * SECOND],
        [1, 5 * SECOND],
      ]),
    ).toEqual(['none', 'restart', 'none', 'restart', 'restart', 'give-up']);
  });
});
