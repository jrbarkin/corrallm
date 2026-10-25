import * as files from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { privateTokenProfile } from './token-profile';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof files>()),
}));

let dir: string;
let profile: string;
beforeEach(async () => {
  dir = await files.mkdtemp(path.join(tmpdir(), 'corrallm-private-profile-'));
  await files.mkdir(path.join(dir, 'profile'), { mode: 0o700 });
  profile = await files.realpath(path.join(dir, 'profile'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await files.rm(dir, { recursive: true, force: true });
});

describe('the token control channel’s profile namespace', () => {
  it('allows protected paths and sticky shared ancestors, without changing permissions', async () => {
    await files.chmod(dir, 0o1777);
    expect(await privateTokenProfile(profile)).toBe(profile);
    expect((await files.stat(dir)).mode & 0o7777).toBe(0o1777);
  });

  it.each(['profile', 'ancestor'] as const)('refuses a %s owned by another user', async (which) => {
    const lstat = files.lstat;
    const foreign = which === 'profile' ? profile : path.dirname(profile);
    vi.spyOn(files, 'lstat').mockImplementation(async (at) => {
      const stats = await lstat(at);
      if (at === foreign) stats.uid = (process.getuid?.() ?? 0) + 1;
      return stats;
    });
    await expect(privateTokenProfile(profile)).rejects.toThrow(/others/);
  });
});
