import type * as fs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import { UsageReadings } from './usage';

const gate = vi.hoisted(() => ({
  held: undefined as Promise<void> | undefined,
  syncing: false,
  fails: false,
}));
const events = vi.hoisted(() => [] as string[]);
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        gate.syncing = true;
        await gate.held;
        if (gate.fails) throw new Error('EIO: i/o error, fsync');
        await sync();
        events.push(String(args[0]).endsWith('.partial') ? 'file synced' : 'directory synced');
      };
      return handle;
    },
  };
});

it('awaits the exhausted limit’s file and directory syncs before publishing it', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'corrallm-usage-durable-'));
  const writing = Promise.withResolvers<undefined>();
  const usage = new UsageReadings({ file: path.join(profile, 'usage.json'), backends: ['codex'] });
  gate.held = writing.promise;
  gate.syncing = false;
  events.length = 0;
  usage.subscribe(() => events.push('published'));
  try {
    const pending = usage.exhaust('codex', Date.now() + 60_000);
    await vi.waitFor(() => {
      expect(gate.syncing).toBe(true);
    });
    expect(events).toEqual([]);
    writing.resolve(undefined);
    await pending;
    expect(events).toEqual([
      'file synced',
      ...(process.platform === 'win32' ? [] : ['directory synced']),
      'published',
    ]);
  } finally {
    writing.resolve(undefined);
    gate.held = undefined;
    await usage.flush();
    await rm(profile, { recursive: true, force: true });
  }
});

it('tells no one of a hold it couldn’t write, and rejects, though the hold applies for this run', async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'corrallm-usage-durable-'));
  const usage = new UsageReadings({ file: path.join(profile, 'usage.json'), backends: ['codex'] });
  const resetsAt = Date.now() + 60_000;
  events.length = 0;
  usage.subscribe(() => events.push('published'));
  try {
    gate.fails = true;
    await expect(usage.exhaust('codex', resetsAt)).rejects.toThrow(/EIO/);
    expect(events).toEqual([]);
    expect(usage.exhausted('codex')).toBe(resetsAt);

    // Told once a write of it works.
    gate.fails = false;
    await usage.exhaust('codex', resetsAt);
    expect(events).toEqual([
      'file synced',
      ...(process.platform === 'win32' ? [] : ['directory synced']),
      'published',
    ]);
    const again = new UsageReadings({
      file: path.join(profile, 'usage.json'),
      backends: ['codex'],
    });
    await again.load();
    expect(again.exhausted('codex')).toBe(resetsAt);
  } finally {
    gate.fails = false;
    await usage.flush();
    await rm(profile, { recursive: true, force: true });
  }
});
