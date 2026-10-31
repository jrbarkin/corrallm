import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import type { ChildSystem } from '../core/children';
import { hasLiveGroupMembers } from '../core/process-groups';
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
      if ((error as NodeJS.ErrnoException).code === 'EPERM' && process.platform !== 'win32') {
        // A group probe can be denied even after its leader exited. Inspect every member,
        // not just the recorded leader: descendants may still run in that private group.
        return hasLiveGroupMembers(pid);
      }
      throw error;
    }
  },
  signal: (pid, signal) => {
    process.kill(process.platform === 'win32' ? pid : -pid, signal);
  },
  hasLiveMembers: hasLiveGroupMembers,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  pause: (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
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
  let probeFault: string | undefined;
  let signalFault: string | undefined;
  const words = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const failure = (reason: string) =>
    new Error(
      `Test group ${String(record.pid)} ${reason}${probeFault === undefined ? '' : `; group probe failed (${probeFault})`}${signalFault === undefined ? '' : `; ${signalFault}`}; its folder was kept.`,
    );
  const possiblyAlive = () => {
    try {
      const alive = system.alive(record.pid);
      probeFault = undefined;
      return alive;
    } catch (error) {
      probeFault = words(error);
      return true; // An inconclusive probe never establishes that a group is gone.
    }
  };
  if (!possiblyAlive()) return;
  const signal = (value: NodeJS.Signals) => {
    try {
      system.signal(record.pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        signalFault = `${value} failed (${words(error)})`;
    }
  };
  const gone = async (ms: number) => {
    const deadline = system.now() + ms;
    while (possiblyAlive()) {
      const left = deadline - system.now();
      if (left <= 0) return false;
      await system.wait(Math.min(50, left));
    }
    return true;
  };
  const identityFault = (leaderMayHaveExited: boolean): string | undefined => {
    try {
      const found = system.inspect(record.pid);
      if (matches(found) || (leaderMayHaveExited && found === undefined)) return undefined;
      return leaderMayHaveExited ? 'changed identity' : 'has no matching process identity';
    } catch (error) {
      return `could not read its process identity (${words(error)})`;
    }
  };
  const unverified = async (reason: string) => {
    // A ps failure says nothing about whether the group still runs. It may have exited
    // during that read, or be awaiting reaping after an earlier shutdown. Confirm that
    // separately, without letting an absent, reused or unread identity authorize a signal.
    if (await gone(5000)) return;
    throw failure(reason);
  };
  const before = identityFault(false);
  if (before !== undefined) return unverified(before);
  signal('SIGTERM');
  if (await gone(5000)) return;
  // A leader may exit while its descendants remain; a *different* leader is never ours.
  const after = identityFault(true);
  if (after !== undefined) return unverified(after);
  signal('SIGKILL');
  if (!(await gone(5000))) {
    throw failure('did not stop');
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
