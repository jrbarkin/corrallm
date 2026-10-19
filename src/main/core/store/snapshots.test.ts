import { describe, expect, it } from 'vitest';

import { snapshotName, snapshotTime } from './snapshots';

/* A snapshot's name says when it was taken, and only a snapshot's name is read as one. */

describe('snapshot names', () => {
  it('name when a snapshot was taken, in UTC, and read back as that time', () => {
    const at = Date.UTC(2026, 9, 19, 12, 34, 56, 789);
    expect(snapshotName(at)).toBe('core-2026-10-19T12-34-56-789Z.db');
    expect(snapshotTime(snapshotName(at))).toBe(at);
  });

  it('read as no time a name that isn’t a snapshot’s', () => {
    for (const name of [
      'core.db',
      'core-2026-10-19T12-34-56-789Z.db.partial',
      'core-2026-13-45T12-34-56-789Z.db',
      'core-2026-10-19T12-34-56Z.db',
      'core.rejected-0a6f6a5e-4bb3-4c3e-8a8c-3f7f2c1e9d10.db',
    ]) {
      expect(snapshotTime(name), name).toBeUndefined();
    }
  });
});
