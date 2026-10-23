import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { Checkpointer } from './checkpointer';
import { connect } from './sqlite';

let profile: string;

beforeEach(async () => {
  profile = await mkdtemp(path.join(tmpdir(), 'corrallm-checkpointer-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(profile, { recursive: true, force: true });
});

it.each(['stdout', 'stderr'] as const)(
  'takes its closing snapshot and ends its worker without opening the parent’s %s',
  async (stream) => {
    const source = path.join(profile, 'core.db');
    const partial = path.join(profile, 'snapshot.partial');
    const connection = connect(source);
    connection.exec("CREATE TABLE note (text TEXT); INSERT INTO note VALUES ('kept')");
    connection.close();
    const checkpointer = new Checkpointer(source);
    const terminating = vi.spyOn(Worker.prototype, 'terminate');
    // A terminal may already have hung up by the time shutdown starts its first worker.
    // Opening an unused stream then can block forever on macOS; fail immediately here.
    const opening = vi.spyOn(process, stream, 'get').mockImplementation(() => {
      throw new Error('The terminal is gone');
    });
    try {
      await expect(checkpointer.snapshot(partial)).resolves.toBeUndefined();
      expect(opening).not.toHaveBeenCalled();
    } finally {
      opening.mockRestore();
      await checkpointer.close();
    }
    expect(terminating).toHaveBeenCalledOnce();
    const [worker] = terminating.mock.contexts;
    if (!(worker instanceof Worker)) throw new Error('The snapshot had no worker');
    expect(worker.threadId).toBe(-1);
    const reader = connect(partial, { readOnly: true });
    try {
      expect(reader.prepare('SELECT text FROM note').all()).toEqual([{ text: 'kept' }]);
    } finally {
      reader.close();
    }
  },
);
