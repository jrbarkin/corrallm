import { once } from 'node:events';

import { expect, it, vi } from 'vitest';

import { execFile, withProcesses } from './process';

it.each(['running', 'exited'] as const)(
  'finishes a timed-out helper whose leader is %s while a descendant holds its pipes',
  async (leader) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const done = vi.fn();
    const owner = {
      node: vi.fn(),
      pty: vi.fn(),
      stop: (child: { kill: (signal: NodeJS.Signals | number) => unknown }) => {
        child.kill('SIGTERM');
      },
    };
    const child = withProcesses(owner, () =>
      execFile(
        process.execPath,
        [
          '-e',
          'require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 800)"], {stdio: ["ignore", 1, 2]}); console.log("ready"); ' +
            (leader === 'exited' ? 'process.exit(0);' : 'setTimeout(() => {}, 2000);'),
        ],
        { timeout: 100 },
        done,
      ),
    );
    const exited = once(child, 'exit');
    const closed = once(child, 'close');
    try {
      if (!child.stdout) throw new Error('No helper stdout.');
      await once(child.stdout, 'data');
      if (leader === 'exited') await exited;
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(done).toHaveBeenCalledWith(expect.objectContaining({ killed: true }), 'ready\n', '');
    } finally {
      child.kill('SIGTERM');
      await closed;
      vi.useRealTimers();
    }
  },
);
