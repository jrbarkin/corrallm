import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { lockProfile, processStart, ProfileLocked } from './lock';
import type { LockHolder } from './lock';

/*
 * One owner per profile (Core Server §7.6): <profile>/core.lock, opened O_EXCL, holding the pid and
 * start time of the process that owns the profile, the app or `corrallm serve`, so the two never
 * write one profile's stores at once. A lock whose process is gone is taken over.
 */

let profile: string;
let lockFile: string;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-lock-'));
  lockFile = path.join(profile, 'core.lock');
});

afterEach(async () => {
  await rm(profile, { recursive: true, force: true });
});

/** When this process started, as the lock keeps it. */
const STARTED = processStart();

/** A pid no process has: one that ran and has exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.once('exit', resolve));
  if (child.pid === undefined) throw new Error('No pid');
  return child.pid;
}

async function held(): Promise<unknown> {
  return JSON.parse(await readFile(lockFile, 'utf8'));
}

describe('lockProfile', () => {
  it('takes the profile, keeping who holds it, and lets it go', async () => {
    const lock = await lockProfile(profile, 'serve');
    const kept = (await held()) as LockHolder;
    expect(kept).toMatchObject({ owner: 'serve', pid: process.pid });
    if (typeof kept.started === 'number' && typeof STARTED === 'number') {
      expect(Math.abs(kept.started - STARTED)).toBeLessThan(500);
    } else expect(kept.started).toEqual(STARTED);
    lock.release();
    await expect(stat(lockFile)).rejects.toThrow(/ENOENT/);
    // Released, it can be taken again.
    (await lockProfile(profile, 'app')).release();
  });

  it('refuses while a live process holds it, saying which', async () => {
    const lock = await lockProfile(profile, 'app');
    const refused = await lockProfile(profile, 'serve').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ProfileLocked);
    expect((refused as ProfileLocked).holder).toMatchObject({ owner: 'app', pid: process.pid });
    expect((refused as ProfileLocked).message).toBe(
      `The corrallm app (process ${String(process.pid)}) is using this profile.`,
    );
    // The holder's lock is left as it was.
    expect(await held()).toMatchObject({ owner: 'app', pid: process.pid });
    lock.release();
  });

  it('words a lock `corrallm serve` holds', async () => {
    await writeFile(
      lockFile,
      JSON.stringify({ owner: 'serve', pid: process.pid, started: STARTED }),
    );
    await expect(lockProfile(profile, 'app')).rejects.toThrow(
      `corrallm serve (process ${String(process.pid)}) is using this profile.`,
    );
  });

  it('takes over a lock whose process is gone', async () => {
    const pid = await deadPid();
    await writeFile(lockFile, JSON.stringify({ owner: 'serve', pid, started: STARTED }));
    const lock = await lockProfile(profile, 'app');
    expect(await held()).toMatchObject({ owner: 'app', pid: process.pid });
    lock.release();
  });

  it('lets only one of several taking over a lock left behind at once have it', async () => {
    const pid = await deadPid();
    for (let round = 0; round < 20; round++) {
      await writeFile(lockFile, JSON.stringify({ owner: 'serve', pid, started: STARTED }));
      const tries = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => lockProfile(profile, i % 2 === 0 ? 'app' : 'serve')),
      );
      const took = tries.flatMap((one) => (one.status === 'fulfilled' ? [one.value] : []));
      expect(took, `round ${String(round)}`).toHaveLength(1);
      for (const one of tries) {
        if (one.status === 'rejected') expect(one.reason).toBeInstanceOf(ProfileLocked);
      }
      // The one that has it holds the lock file, and nothing else is left beside it.
      expect(await held()).toMatchObject({ pid: process.pid });
      expect((await readdir(profile)).sort()).toEqual(['core.lock']);
      took[0]?.release();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'takes over a lock whose pid another process has since been given',
    async () => {
      // This process started after the lock's: its pid was reused.
      await writeFile(
        lockFile,
        JSON.stringify({
          owner: 'serve',
          pid: process.pid,
          started:
            typeof STARTED === 'number' ? STARTED - 60 * 60 * 1000 : { ...STARTED, ticks: '0' },
        }),
      );
      const lock = await lockProfile(profile, 'app');
      expect(await held()).toMatchObject({ owner: 'app', pid: process.pid });
      lock.release();
    },
  );

  it('takes over a lock it can’t read once it is old, but not while it may be being written', async () => {
    await writeFile(lockFile, '{"owner":');
    await expect(lockProfile(profile, 'app')).rejects.toThrow(ProfileLocked);
    const old = new Date(Date.now() - 60 * 1000);
    await utimes(lockFile, old, old);
    const lock = await lockProfile(profile, 'app');
    expect(await held()).toMatchObject({ owner: 'app', pid: process.pid });
    lock.release();
  });

  it('lets go only of a lock it still holds', async () => {
    const lock = await lockProfile(profile, 'serve');
    // Taken over meanwhile (as if this process had been thought gone).
    const other = { owner: 'app', pid: await deadPid(), started: STARTED };
    await writeFile(lockFile, JSON.stringify(other));
    lock.release();
    expect(await held()).toEqual(other);
    // Releasing twice is harmless.
    lock.release();
  });
});
