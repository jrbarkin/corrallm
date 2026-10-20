import { createInterface } from 'node:readline';

import { utilityProcess } from 'electron';
import type { MessagePortMain, UtilityProcess } from 'electron';

import { CoreLink } from '../../shared/link';
import type { Handlers, LinkPort } from '../../shared/link';
import type { WindowId } from '../core/host';
import type { CoreSide, HostSide, WindowMessage } from '../core/protocol';

/*
 * The core process, as main forks it: an Electron utility process running core.cjs (core/entry.ts)
 * with the app's environment (so CORRALLM_FAKE_SESSIONS and the CLIs' path overrides reach it),
 * its stdout and stderr piped back line by line, and a CoreLink to it over its parentPort, on which
 * main answers what the core asks of the desktop. Each window's port goes to it over the same
 * parentPort, beside the link. A utility process, unlike child_process.fork, works with the
 * RunAsNode fuse off. What to do when it exits is supervise.ts's policy, which supervisor.ts
 * carries out.
 */

export interface CoreProcessOptions {
  /** The core's bundle: core.cjs, beside main's. */
  entry: string;
  /** Each line the core prints, and on which stream. */
  output: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Whether the link checks that every value it posts is plain data. */
  check: boolean;
  /** What main answers the core of the desktop: its HostServices (host/services.ts). */
  host: Handlers<HostSide>;
}

export interface CoreProcess {
  readonly link: CoreLink<HostSide, CoreSide>;
  /** Resolves with the process's exit code once it has exited. */
  readonly exited: Promise<number>;
  /** Hands the core its end of `window`'s port (the window has the other end). */
  connect(window: WindowId, port: MessagePortMain): void;
  /** Tells the core that `window` closed, crashed or reloaded: its port is done. */
  windowGone(window: WindowId, closed?: boolean): void;
  /** Tells the core that `window` gained focus. */
  windowFocused(window: WindowId): void;
  kill(): void;
}

export function forkCore({ entry, output, check, host }: CoreProcessOptions): CoreProcess {
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
  const link = new CoreLink<HostSide, CoreSide>(processPort(child, exited), host, { check });
  return {
    link,
    exited,
    connect: (window, port) => {
      child.postMessage({ kind: 'window', window } satisfies WindowMessage, [port]);
    },
    windowGone: (window, closed) => {
      if (closed === undefined) link.emit('windowGone', window);
      else link.emit('windowGone', window, closed);
    },
    windowFocused: (window) => {
      link.emit('windowFocused', window);
    },
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
