import { execFileSync } from 'node:child_process';

/** A complete group-membership read, used only after a denied signal or liveness probe. */
export type LiveGroupMembers = (group: number) => boolean;

/** Zombies have exited; a missing leader alone says nothing about its descendants. */
export const hasLiveGroupMembers: LiveGroupMembers = (group) => {
  const table = execFileSync('ps', ['-A', '-o', 'pgid=', '-o', 'stat='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 1000,
  });
  let live = false;
  for (const line of table.split('\n')) {
    if (!line.trim()) continue;
    const fields = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
    if (fields === null) throw new Error('Could not read process groups.');
    if (Number(fields[1]) === group && !fields[2]?.startsWith('Z')) live = true;
  }
  return live;
};

/** An inconclusive inspection never establishes that a denied group has exited. */
export function groupIsGone(error: unknown, group: number, members?: LiveGroupMembers): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ESRCH' || (code === 'EPERM' && members !== undefined && !members(group));
}
