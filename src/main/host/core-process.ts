import { createInterface } from 'node:readline';

import { utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';

import { CoreLink } from '../../shared/link';
import type { LinkPort } from '../../shared/link';
import type { CoreSide, HostSide } from '../core/protocol';

/*
 * The core process, as main forks it: an Electron utility process running core.cjs (core/entry.ts)
 * with the app's environment (so CORRALLM_FAKE_SESSIONS and the CLIs' path overrides reach it),
 * its stdout and stderr piped back line by line, and a CoreLink to it over its parentPort. A
 * utility process, unlike child_process.fork, works with the RunAsNode fuse off. What to do when
 * it exits is supervise.ts's policy.
 */

export interface CoreProcessOptions {
  /** The core's bundle: core.cjs, beside main's. */
  entry: string;
  /** Each line the core prints, and on which stream. */
  output: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Whether the link checks that every value it posts is plain data. */
  check: boolean;
}

export interface CoreProcess {
  readonly link: CoreLink<HostSide, CoreSide>;
  /** Resolves with the process's exit code once it has exited. */
  readonly exited: Promise<number>;
  kill(): void;
}

export function forkCore({ entry, output, check }: CoreProcessOptions): CoreProcess {
  const child = utilityProcess.fork(entry, [], { serviceName: 'corrallm core', stdio: 'pipe' });
  for (const [stream, readable] of [
    ['stdout', child.stdout],
    ['stderr', child.stderr],
  ] as const) {
    if (!readable) continue;
    createInterface({ input: readable }).on('line', (line) => {
      output(line, stream);
    });
  }
  const exited = new Promise<number>((resolve) => {
    child.once('exit', resolve);
  });
  const link = new CoreLink<HostSide, CoreSide>(processPort(child, exited), {}, { check });
  return {
    link,
    exited,
    kill: () => {
      child.kill();
    },
  };
}

/** Main's handle on the core process, as a link's port: it is gone once the process exits. */
function processPort(child: UtilityProcess, exited: Promise<number>): LinkPort {
  return {
    post: (message) => {
      child.postMessage(message);
    },
    start: (receive, gone) => {
      child.on('message', receive);
      void exited.then((code) => {
        gone(`the core process exited with code ${String(code)}`);
      });
    },
  };
}
