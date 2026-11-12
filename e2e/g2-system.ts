import { readFile, readdir } from 'node:fs/promises';
import { availableParallelism, freemem, loadavg, totalmem } from 'node:os';

export interface ProcSource {
  read: (file: string) => Promise<string>;
  list: (folder: string) => Promise<string[]>;
}

interface Proc {
  pid: number;
  ppid: number;
  name: string;
  state: string;
  kind: string;
  rssKiB: number;
  threads: number;
  threadNames: string[];
  unreadableThreads: number;
}

const SYSTEM: ProcSource = {
  read: (file) => readFile(file, 'utf8'),
  list: (folder) => readdir(folder),
};
const WORKER_NAME = /^(?:\[worker\b|WorkerThread\b)/i;
const live = (proc: Proc) => !['Z', 'X'].includes(proc.state);
const product = (proc: Proc) => proc.kind.startsWith('corrallm');

/** Identify app/core/test roles without retaining command arguments or reading environments. */
function kindOf(name: string, command: string): string {
  const args = command.split('\0');
  if (args.some((arg) => /(?:dist-cli\/corrallm|\.vite\/build\/core)\.cjs$/.test(arg)))
    return 'corrallm-core';
  const executable = args[0]?.split('/').at(-1) ?? name;
  if (/^(?:electron|corrallm)$/.test(executable) || /^(?:electron|corrallm)$/.test(name)) {
    const type = args.find((arg) => /^--type=(?:renderer|gpu-process|utility)$/.test(arg));
    return `corrallm-${type?.slice(7) ?? 'app'}`;
  }
  if (args.some((arg) => /\/fake-[^/]+\.[cm]?js$/.test(arg))) return 'native-fake';
  if (args.some((arg) => /(?:playwright|vite|esbuild)/.test(arg))) return 'test-tool';
  return 'other';
}

export async function readSystem(source: ProcSource = SYSTEM) {
  const pids = (await source.list('/proc')).filter((entry) => /^\d+$/.test(entry));
  let unavailable = 0;
  const processes = (
    await Promise.all(
      pids.map(async (pid): Promise<Proc | undefined> => {
        try {
          const status = Object.fromEntries(
            (await source.read(`/proc/${pid}/status`)).split('\n').map((line) => {
              const at = line.indexOf(':');
              return [line.slice(0, at), line.slice(at + 1).trim()];
            }),
          );
          const command = await source.read(`/proc/${pid}/cmdline`);
          const tasks = await source.list(`/proc/${pid}/task`);
          let unreadableThreads = 0;
          const threadNames = await Promise.all(
            tasks.map(async (tid) => {
              try {
                return (await source.read(`/proc/${pid}/task/${tid}/comm`)).trim();
              } catch {
                unreadableThreads++;
                return '(gone)';
              }
            }),
          );
          const name = status.Name ?? '?';
          return {
            pid: Number(pid),
            ppid: Number(status.PPid),
            name,
            state: status.State?.[0] ?? '?',
            kind: kindOf(name, command),
            rssKiB: Number(status.VmRSS?.split(' ')[0] ?? 0),
            threads: Number(status.Threads),
            threadNames,
            unreadableThreads,
          };
        } catch {
          unavailable++;
          return undefined;
        }
      }),
    )
  )
    .filter((proc): proc is Proc => proc !== undefined)
    .sort((a, b) => a.pid - b.pid);
  const resources = await Promise.all(
    [
      '/proc/pressure/cpu',
      '/proc/pressure/io',
      '/proc/pressure/memory',
      '/sys/fs/cgroup/cpu.stat',
      '/sys/fs/cgroup/cpu.max',
      '/sys/fs/cgroup/memory.current',
      '/sys/fs/cgroup/memory.events',
    ].map(async (file) => {
      try {
        return [file, (await source.read(file)).trim().replaceAll('\n', '; ')] as const;
      } catch {
        return [file, '(unavailable)'] as const;
      }
    }),
  );
  return { processes, unavailable, load: (await source.read('/proc/loadavg')).trim(), resources };
}

export function formatSystem(
  label: string,
  snapshot: Awaited<ReturnType<typeof readSystem>>,
): string {
  const liveProcesses = snapshot.processes.filter(live);
  const apps = liveProcesses.filter(product);
  const workers = (procs: Proc[]) =>
    procs.reduce(
      (n, proc) => n + proc.threadNames.filter((name) => WORKER_NAME.test(name)).length,
      0,
    );
  const lines = [
    `G2-ENV ${label}: loadavg=${snapshot.load}`,
    `G2-ENV live corrallm processes=${String(apps.length)}; corrallm kernel threads=${String(apps.reduce((n, proc) => n + proc.threads, 0))}; corrallm named worker threads=${String(workers(apps))}; all named worker threads=${String(workers(liveProcesses))}; native-fake processes=${String(liveProcesses.filter((proc) => proc.kind === 'native-fake').length)}; unreadable/disappeared processes=${String(snapshot.unavailable)}`,
    'G2-ENV process list is container/PID-namespace visible; loadavg, pressure and diskstats may include host activity.',
    'G2-ENV named worker count matches [worker ...]/WorkerThread only (a lower bound); thread-name tallies retain V8/libuv/unnamed threads. Arguments and environments are omitted.',
  ];
  for (const proc of snapshot.processes) {
    const names = new Map<string, number>();
    for (const name of proc.threadNames) names.set(name, (names.get(name) ?? 0) + 1);
    lines.push(
      `G2-PROCESS pid=${String(proc.pid)} ppid=${String(proc.ppid)} state=${proc.state} kind=${proc.kind} comm=${JSON.stringify(proc.name)} threads=${String(proc.threads)} rssKiB=${String(proc.rssKiB)} threadNames=${JSON.stringify(Object.fromEntries(names))} unreadableThreads=${String(proc.unreadableThreads)}`,
    );
  }
  for (const [file, value] of snapshot.resources) lines.push(`G2-RESOURCE ${file}: ${value}`);
  return lines.join('\n');
}

/** Linux diskstats sectors always have 512 bytes, independent of the device's block size. */
export function diskDeltas(before: string, after: string, elapsedMs: number): string {
  const parse = (text: string) =>
    new Map(
      text
        .trim()
        .split('\n')
        .flatMap((line) => {
          const fields = line.trim().split(/\s+/);
          const [major, minor, name] = fields;
          return fields.length < 14 || !major || !minor || !name
            ? []
            : ([[`${major}:${minor}/${name}`, fields]] as const);
        }),
    );
  const previous = parse(before);
  const lines = [
    `G2-DISK interval=${elapsedMs.toFixed(1)} ms; per device, do not sum stacked devices`,
  ];
  for (const [key, fields] of parse(after)) {
    const name = fields[2] ?? key;
    const prior = previous.get(key);
    if (!prior) {
      lines.push(`G2-DISK ${name} new device`);
      continue;
    }
    const delta = (index: number) => Number(fields[index]) - Number(prior[index]);
    if ([3, 5, 6, 7, 9, 10, 12, 13].some((index) => delta(index) < 0)) {
      lines.push(`G2-DISK ${name} counter reset`);
      continue;
    }
    if (
      ![3, 5, 6, 7, 9, 10, 12, 13].some((index) => delta(index) !== 0) &&
      Number(fields[11]) === 0
    )
      continue;
    lines.push(
      `G2-DISK ${name} reads=${String(delta(3))} writes=${String(delta(7))} readMiB=${(delta(5) / 2048).toFixed(2)} writeMiB=${(delta(9) / 2048).toFixed(2)} readMs=${String(delta(6))} writeMs=${String(delta(10))} busyMs=${String(delta(12))} weightedMs=${String(delta(13))} inFlight=${fields[11] ?? '?'}`,
    );
  }
  return lines.join('\n');
}

/** Snapshot before the core starts, then sample disk deltas across its actual workload, no wait. */
export async function captureEnvironment(
  label: string,
  platform: string = process.platform,
  source: ProcSource = SYSTEM,
): Promise<() => Promise<string>> {
  const portable = (when: string) =>
    `G2-ENV ${label} ${when}: platform=${platform} arch=${process.arch} node=${process.version} parallelism=${String(availableParallelism())} loadavg=${loadavg()
      .map((n) => n.toFixed(2))
      .join(
        ',',
      )} freeMiB=${(freemem() / 2 ** 20).toFixed(0)} totalMiB=${(totalmem() / 2 ** 20).toFixed(0)}`;
  const lines = [portable('before-start')];
  let before: string | undefined;
  let start = performance.now();
  if (platform === 'linux') {
    try {
      lines.push(formatSystem(`${label} before-start`, await readSystem(source)));
      before = await source.read('/proc/diskstats');
      start = performance.now();
    } catch {
      lines.push(`G2-ENV ${label}: Linux /proc capture unavailable`);
    }
  } else lines.push(`G2-ENV ${label}: Linux /proc unavailable`);
  return async () => {
    const result = [...lines, portable('after-burst')];
    if (before !== undefined) {
      try {
        result.push(
          diskDeltas(before, await source.read('/proc/diskstats'), performance.now() - start),
        );
      } catch {
        result.push(`G2-ENV ${label}: disk delta unavailable`);
      }
    }
    return result.join('\n');
  };
}
