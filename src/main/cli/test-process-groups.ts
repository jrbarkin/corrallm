import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import type { ChildSystem } from '../core/children';
import { inspectProcess, isProcessStart, sameStart } from '../core/process-identity';
import type { ProcessStart } from '../core/process-identity';

export interface TestGroup {
  pid: number;
  started: ProcessStart;
  profile?: string;
}

export const TEST_GROUP_SYSTEM: ChildSystem = {
  platform: process.platform,
  inspect: inspectProcess,
  alive: (pid) => {
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  },
  signal: (pid, signal) => {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
  },
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => performance.now(),
};

export function testGroup(value: unknown): TestGroup {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid test process record.');
  const { pid, started, profile } = value as Record<string, unknown>;
  if (
    typeof pid !== 'number' ||
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    !isProcessStart(started) ||
    (profile !== undefined && typeof profile !== 'string')
  ) {
    throw new Error('Invalid test process identity; the folder was kept.');
  }
  return { pid, started, ...(typeof profile === 'string' ? { profile } : {}) };
}

export async function recordedTestGroups(file: string): Promise<TestGroup[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const data: unknown = JSON.parse(text);
  if (
    typeof data !== 'object' ||
    data === null ||
    !('version' in data) ||
    data.version !== 1 ||
    !('children' in data) ||
    !Array.isArray(data.children)
  ) {
    throw new Error('The test CLI registry could not be read; the folder was kept.');
  }
  return data.children.map(testGroup);
}

/** Test cleanup allows scheduling/reaping time after SIGKILL, unlike a startup's short probe. */
export async function stopTestGroup(record: TestGroup, system = TEST_GROUP_SYSTEM): Promise<void> {
  const matches = (found: ReturnType<ChildSystem['inspect']>) =>
    found?.group === record.pid && sameStart(found.started, record.started);
  if (!system.alive(record.pid)) return;
  const signal = (value: NodeJS.Signals) => {
    try {
      system.signal(record.pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const gone = async (ms: number) => {
    const deadline = system.now() + ms;
    while (system.alive(record.pid)) {
      const left = deadline - system.now();
      if (left <= 0) return false;
      await system.wait(Math.min(50, left));
    }
    return true;
  };
  if (!matches(system.inspect(record.pid))) {
    // Earlier shutdown may already have killed the leader. Allow its group time to be
    // reaped, without treating an absent or reused identity as permission to signal it.
    if (await gone(5000)) return;
    throw new Error(
      `Test group ${String(record.pid)} has no matching process identity; its folder was kept.`,
    );
  }
  signal('SIGTERM');
  if (await gone(5000)) return;
  // A leader may exit while its descendants remain; a *different* leader is never ours.
  const after = system.inspect(record.pid);
  if (after !== undefined && !matches(after)) {
    throw new Error(`Test group ${String(record.pid)} changed identity; its folder was kept.`);
  }
  signal('SIGKILL');
  if (!(await gone(5000))) {
    throw new Error(`Test group ${String(record.pid)} did not stop; its folder was kept.`);
  }
}

export async function stopTestGroups(
  records: readonly TestGroup[],
  system = TEST_GROUP_SYSTEM,
): Promise<void> {
  const results = await Promise.allSettled(records.map((record) => stopTestGroup(record, system)));
  const failed = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  if (failed.length)
    throw new AggregateError(
      failed,
      failed.map((error) => (error instanceof Error ? error.message : String(error))).join('\n'),
    );
}
