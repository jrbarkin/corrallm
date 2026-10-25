import { constants } from 'node:fs';
import * as files from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readTokenFile } from './token-file';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof files>()),
}));

let dir: string;
let file: string;
const TOKEN = 'A'.repeat(43);

beforeEach(async () => {
  dir = await files.mkdtemp(path.join(tmpdir(), 'corrallm-token-file-'));
  file = path.join(dir, 'token');
  await files.writeFile(file, `${TOKEN}\n`, { mode: 0o600 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await files.rm(dir, { recursive: true, force: true });
});

describe('a token file', () => {
  it('reads one private regular file, and refuses two tokens without revealing either', async () => {
    expect(await readTokenFile(file)).toBe(TOKEN);
    await files.writeFile(file, `${TOKEN}\n${'B'.repeat(43)}\n`);
    await expect(readTokenFile(file)).rejects.toThrow(/no corrallm token/);
  });

  it('never follows a symlink to a private token file', async () => {
    const link = path.join(dir, 'link');
    await files.symlink(file, link);
    await expect(readTokenFile(link)).rejects.toThrow();
  });

  it('opens nonblocking and without following links, before checking the opened file', async () => {
    // A blocking read-only open of a FIFO never reaches fstat until a writer arrives.
    const open = files.open;
    const opened = vi.spyOn(files, 'open').mockImplementation((at, flags, mode) => {
      expect(typeof flags).toBe('number');
      expect(Number(flags) & constants.O_NONBLOCK).not.toBe(0);
      expect(Number(flags) & constants.O_NOFOLLOW).not.toBe(0);
      return open(at, flags, mode);
    });
    expect(await readTokenFile(file)).toBe(TOKEN);
    expect(opened).toHaveBeenCalledOnce();
  });

  it('bounds the read itself, even if the file grows after fstat', async () => {
    const open = files.open;
    vi.spyOn(files, 'open').mockImplementation(async (at, flags, mode) => {
      const handle = await open(at, flags, mode);
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementation(async () => {
        const before = await stat();
        await files.appendFile(file, ' '.repeat(2048));
        return before;
      });
      return handle;
    });
    await expect(readTokenFile(file)).rejects.toThrow(/more than a token/);
  });

  it('checks the opened inode’s owner and permissions, and closes it on refusal', async () => {
    const open = files.open;
    let closed = false;
    vi.spyOn(files, 'open').mockImplementation(async (at, flags, mode) => {
      const handle = await open(at, flags, mode);
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, 'stat').mockImplementation(async () => {
        const stats = await stat();
        stats.uid = (process.getuid?.() ?? 0) + 1;
        return stats;
      });
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close();
        closed = true;
      });
      return handle;
    });
    await expect(readTokenFile(file)).rejects.toThrow(/yours alone/);
    expect(closed).toBe(true);
  });

  it('refuses token files on Windows until their private ACL can be checked', async () => {
    await expect(readTokenFile(file, 'win32')).rejects.toThrow(/Windows/);
  });
});
