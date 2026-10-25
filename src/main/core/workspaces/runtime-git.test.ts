import { afterEach, expect, it, vi } from 'vitest';
import { GitRunner } from './git';
import { WorkspaceGit } from './runtime-git';

afterEach(() => {
  vi.restoreAllMocks();
});
it('leaves a stopped provisioning call interrupted, even if its child finishes during close', async () => {
  const result = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
  const run = vi.spyOn(GitRunner.prototype, 'run').mockReturnValue(result.promise);
  const git = new WorkspaceGit({ hooks: '/unused', environment: () => Promise.resolve({}) });
  const going = git.run({ cwd: '/unused', args: ['version'] });
  git.stop();
  result.resolve({ code: 0, stdout: '', stderr: '' });
  await expect(going).rejects.toMatchObject({ fault: 'refused' });
  await expect(git.run({ cwd: '/unused', args: ['version'] })).rejects.toMatchObject({
    fault: 'refused',
  });
  expect(run).toHaveBeenCalledOnce();
});
