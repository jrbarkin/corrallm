import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runGit } from './diff';

type Callback = (error: unknown, stdout: string) => void;
const fake = vi.hoisted(() => ({ error: undefined, stdout: '' }));

vi.mock('../../process', () => ({
  execFile: (_file: string, _args: string[], _options: unknown, done: Callback) => {
    done(fake.error, fake.stdout);
  },
}));

describe('runGit when git ends by a signal', () => {
  beforeEach(() => {
    fake.stdout = 'partial';
  });

  it('reports a git killed by SIGPIPE as a failure, as it does a nonzero exit', async () => {
    // A transport helper refusing ("transport 'none' not allowed") can close its pipe before git
    // writes to it; git then dies of SIGPIPE with no exit code.
    fake.error = Object.assign(new Error('git failed'), { code: null, signal: 'SIGPIPE' });
    const result = await runGit({})(['diff'], '/nowhere');
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('partial');
  });

  it('still rejects a git the timeout killed', async () => {
    fake.error = Object.assign(new Error('timed out'), {
      code: null,
      signal: 'SIGTERM',
      killed: true,
    });
    await expect(runGit({})(['diff'], '/nowhere')).rejects.toThrow('failed');
  });
});
