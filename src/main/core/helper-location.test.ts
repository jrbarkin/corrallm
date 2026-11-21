import { describe, expect, it } from 'vitest';
import { helperLocationRefusal } from './helper-location';

const file = '/home/user/tools/node';
const inodes = new Map<string, number>();
const deps = {
  realpath: (file: string) => Promise.resolve(file),
  stat: (at: string) => {
    if (!inodes.has(at)) inodes.set(at, inodes.size + 1);
    return Promise.resolve({
      uid: 42,
      mode: 0o755,
      dev: 1,
      ino: inodes.get(at) ?? 0,
      isFile: () => at === file,
      isDirectory: () => at !== file,
    });
  },
  uid: 42,
  temporary: ['/tmp'],
};

describe('credential helper code locations', () => {
  it('accepts permanent protected code outside project folders', async () => {
    expect(await helperLocationRefusal([file], ['/home/user/project'], deps)).toBeUndefined();
  });

  it('refuses a project location through its canonical alias', async () => {
    const observed = {
      ...deps,
      realpath: (at: string) =>
        Promise.resolve(at === file ? '/work/project/build/header.cjs' : at),
    };
    expect(await helperLocationRefusal([file], ['/work/project'], observed)).toContain(
      'project folder',
    );
  });

  it('recognizes a project ancestor by its filesystem identity when spelling differs', async () => {
    const observed = {
      ...deps,
      stat: async (at: string) => ({
        ...(await deps.stat(at)),
        dev: 1,
        ino: at === '/home/user/tools' || at === '/home/user/TOOLS' ? 100 : at === file ? 101 : 102,
      }),
    };
    expect(await helperLocationRefusal([file], ['/home/user/TOOLS'], observed)).toContain(
      'project folder',
    );
  });

  it('refuses temporary code even in a private child folder', async () => {
    expect(await helperLocationRefusal(['/tmp/private/node'], [], deps)).toContain(
      'temporary folder',
    );
  });

  it('refuses code replaceable through a writable ancestor', async () => {
    const observed = {
      ...deps,
      stat: async (at: string) => ({
        ...(await deps.stat(at)),
        mode: at === '/home/user/tools' ? 0o777 : 0o755,
      }),
    };
    expect(await helperLocationRefusal([file], [], observed)).toContain('no write access');
  });
});
