import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { takeSnapshot } from './snapshots';
import { connect } from './sqlite';

// This measures scheduling and disk IO: the store-performance project runs after the parallel
// pool, with the same 512 MiB fixture, 30-second completion limit and 50 ms loop-delay bound.
// CORRALLM_SNAPSHOT_LOOP_BUDGET_MS widens the bound for CI's 3-core macOS runner only (126 ms
// measured there); a snapshot converted synchronously would stall the loop for seconds, far over it.
const budget = Number(process.env.CORRALLM_SNAPSHOT_LOOP_BUDGET_MS) || 50;
let profile: string;
beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-snapshot-loop-'));
});
afterEach(async () => {
  await rm(profile, { recursive: true, force: true });
});

it('keeps the loop responsive while converting and checking a large snapshot', async () => {
  const source = path.join(profile, 'core.db');
  const database = connect(source);
  try {
    database.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE payload (body BLOB) STRICT;
      WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<131072)
      INSERT INTO payload SELECT zeroblob(4096) FROM n`);
    let last = performance.now();
    let delay = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      delay = Math.max(delay, now - last);
      last = now;
    }, 5);
    try {
      await takeSnapshot(source, profile, Date.UTC(2026, 9, 19, 12));
      // Include a timer delayed by the last synchronous portion of publication.
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      clearInterval(timer);
    }
    console.info(`512 MiB snapshot: maximum loop interval ${delay.toFixed(1)} ms`);
    expect(delay).toBeLessThan(budget);
  } finally {
    database.close();
  }
}, 30_000);
