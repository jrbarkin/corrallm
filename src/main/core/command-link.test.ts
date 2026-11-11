import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OpFailure } from './call';
import { CommandLink } from './command-link';

/*
 * The `corrallm` command's link (B30 C1 to C3), on a throwaway home with a fake launcher: the one
 * path it writes, what it never replaces, the folders it refuses to write through, an atomic
 * write and fixed words for every failure.
 */

let dir: string;
let home: string;
let launcher: string;
let bin: string;
let at: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cl-'));
  home = path.join(dir, 'home');
  await mkdir(home);
  const resources = path.join(dir, 'corrallm.app', 'Contents', 'Resources', 'bin');
  await mkdir(resources, { recursive: true });
  launcher = path.join(resources, 'corrallm');
  await writeFile(launcher, '#!/bin/sh\n');
  await chmod(launcher, 0o755);
  bin = path.join(home, '.local', 'bin');
  at = path.join(bin, 'corrallm');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function link(over: Partial<ConstructorParameters<typeof CommandLink>[0]> = {}): CommandLink {
  return new CommandLink({
    home,
    searchPath: () => Promise.resolve(`${bin}:/usr/bin`),
    launcher: () => launcher,
    ...over,
  });
}

/** The folders, made as a user would. */
async function folders(mode = 0o755): Promise<void> {
  await mkdir(bin, { recursive: true });
  await chmod(path.join(home, '.local'), mode);
  await chmod(bin, mode);
}

async function failure(run: Promise<unknown>): Promise<OpFailure> {
  const error = await run.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(OpFailure);
  return error as OpFailure;
}

const real = async (file: string) => (await lstat(file)).ino;

describe.skipIf(process.platform === 'win32')('the corrallm command’s link', () => {
  it('installs: ~/.local/bin/corrallm becomes a link to the launcher’s real path, and reads current', async () => {
    const service = link();
    expect(await service.status()).toMatchObject({
      state: 'ready',
      link: { at: '~/.local/bin/corrallm', is: 'absent', onPath: true },
      runs: null,
    });
    const result = await service.install();
    expect(result.changed).toBe(true);
    expect((await lstat(at)).isSymbolicLink()).toBe(true);
    expect(await readlink(at)).toBe(await (await import('node:fs/promises')).realpath(launcher));
    expect(result.command).toMatchObject({
      state: 'ready',
      link: { is: 'current' },
      runs: { at: '~/.local/bin/corrallm', current: true },
    });
  });

  it('makes missing folders 0700, and leaves existing folders’ modes alone', async () => {
    await link().install();
    expect((await lstat(path.join(home, '.local'))).mode & 0o777).toBe(0o700);
    expect((await lstat(bin)).mode & 0o777).toBe(0o700);
    await rm(path.join(home, '.local'), { recursive: true });
    await folders(0o755);
    await link().install();
    expect((await lstat(bin)).mode & 0o777).toBe(0o755);
  });

  it('twice changes nothing: the link keeps its inode and times, and no temporary link is left', async () => {
    const service = link();
    await service.install();
    const before = await lstat(at);
    const again = await service.install();
    expect(again.changed).toBe(false);
    const after = await lstat(at);
    expect([after.ino, after.mtimeMs, after.ctimeMs]).toEqual([
      before.ino,
      before.mtimeMs,
      before.ctimeMs,
    ]);
    expect(await readdir(bin)).toEqual(['corrallm']);
  });

  it.each([
    ['a regular file', async () => writeFile(at, 'mine')],
    ['a folder', async () => mkdir(at)],
    ['a link to another program', async () => symlink('/usr/bin/true', at)],
    [
      'a FIFO',
      () => {
        execFileSync('mkfifo', [at]);
        return Promise.resolve();
      },
    ],
  ])(
    'never replaces or removes %s there: it reads taken and both are refused',
    async (_name, place) => {
      await folders();
      await place();
      const before = await lstat(at);
      const target = before.isSymbolicLink() ? await readlink(at) : undefined;
      const service = link();
      expect(await service.status()).toMatchObject({ link: { is: 'taken' } });
      expect((await failure(service.install())).code).toBe('refused');
      expect((await failure(service.remove())).code).toBe('refused');
      const after = await lstat(at);
      expect(after.ino).toBe(before.ino);
      if (target !== undefined) expect(await readlink(at)).toBe(target);
    },
  );

  it('replaces and removes its own stale link, to a moved or other copy', async () => {
    await folders();
    await symlink('/Old/corrallm.app/Contents/Resources/bin/corrallm', at);
    const service = link();
    expect(await service.status()).toMatchObject({ link: { is: 'stale' } });
    expect((await service.install()).changed).toBe(true);
    expect(await service.status()).toMatchObject({ link: { is: 'current' } });
    await rm(at);
    await symlink('/Old/resources/bin/corrallm', at);
    expect((await service.remove()).changed).toBe(true);
    await expect(lstat(at)).rejects.toThrow();
    expect((await service.remove()).changed).toBe(false);
  });

  it.each([
    [
      'a link',
      async () => {
        await mkdir(path.join(home, '.local'));
        await mkdir(path.join(dir, 'elsewhere'));
        await symlink(path.join(dir, 'elsewhere'), bin);
      },
    ],
    ['mode 0775', () => folders(0o775)],
    ['mode 0757', () => folders(0o757)],
  ])('refuses to write through ~/.local/bin as %s, making nothing', async (_name, prepare) => {
    await prepare();
    const error = await failure(link().install());
    expect(error.code).toBe('refused');
    expect(error.message).toContain('link it yourself');
    expect(await readdir(path.join(dir, 'elsewhere')).catch(() => [])).toEqual([]);
    await expect(lstat(at)).rejects.toThrow();
  });

  it('leaves the path as it was when the rename fails, with no temporary link', async () => {
    await folders();
    await symlink('/Old/corrallm.app/Contents/Resources/bin/corrallm', at);
    const service = link({
      rename: () =>
        Promise.reject(Object.assign(new Error('EXDEV secret /private/path'), { code: 'EXDEV' })),
    });
    const error = await failure(service.install());
    expect(error.code).toBe('unavailable');
    expect(error.message).not.toMatch(/EXDEV|secret|private/);
    expect(await readlink(at)).toBe('/Old/corrallm.app/Contents/Resources/bin/corrallm');
    expect(await readdir(bin)).toEqual(['corrallm']);
  });

  it('says nothing but fixed words for an EACCES or ENOSPC on the write', async () => {
    await folders();
    for (const code of ['EACCES', 'ENOSPC']) {
      const service = link({
        symlink: () => Promise.reject(Object.assign(new Error(`${code}: ${dir}/secret`), { code })),
      });
      const error = await failure(service.install());
      expect(error.message).not.toContain(dir);
      expect(error.message).not.toContain(code);
    }
  });

  it('reads what runs: ours first, another program first, a PATH without the folder, a relative entry ignored', async () => {
    await link().install();
    const other = path.join(dir, 'other');
    await mkdir(other);
    await writeFile(path.join(other, 'corrallm'), '#!/bin/sh\n');
    await chmod(path.join(other, 'corrallm'), 0o755);

    const ours = await link({ searchPath: () => Promise.resolve(`${bin}:${other}`) }).status();
    expect(ours).toMatchObject({ runs: { current: true }, link: { onPath: true } });

    const shadowed = await link({ searchPath: () => Promise.resolve(`${other}:${bin}`) }).status();
    expect(shadowed).toMatchObject({ runs: { at: other + '/corrallm', current: false } });

    const off = await link({ searchPath: () => Promise.resolve(other) }).status();
    expect(off).toMatchObject({ link: { onPath: false }, runs: { current: false } });

    const relative = await link({ searchPath: () => Promise.resolve(`.local/bin:bin`) }).status();
    expect(relative).toMatchObject({ link: { onPath: false }, runs: null });
  });

  it('writes nothing when corrallm already runs this app’s command through another path', async () => {
    const usr = path.join(dir, 'usr', 'bin');
    await mkdir(usr, { recursive: true });
    await symlink(launcher, path.join(usr, 'corrallm'));
    const service = link({ searchPath: () => Promise.resolve(usr) });
    const result = await service.install();
    expect(result.changed).toBe(false);
    expect(result.command).toMatchObject({ runs: { current: true }, link: { is: 'absent' } });
    await expect(lstat(path.join(home, '.local'))).rejects.toThrow();
  });

  it.each([
    ['the Node host, with no launcher', { launcher: () => null }],
    [
      'a launcher in a translocated copy',
      {
        launcher: () =>
          '/private/var/folders/x/AppTranslocation/ABC/d/corrallm.app/Contents/Resources/bin/corrallm',
      },
    ],
    ['Windows', { platform: 'win32' as const }],
  ])('is unavailable for %s: install is refused and nothing is written', async (_name, over) => {
    const service = link(over);
    expect(await service.status()).toMatchObject({ state: 'unavailable' });
    expect((await failure(service.install())).code).toBe('refused');
    expect((await failure(service.remove())).code).toBe('refused');
    await expect(lstat(path.join(home, '.local'))).rejects.toThrow();
  });

  it('keeps its stat of the link’s identity: a different real launcher reads stale, not current', async () => {
    await folders();
    const moved = path.join(dir, 'moved', 'corrallm.app', 'Contents', 'Resources', 'bin');
    await mkdir(moved, { recursive: true });
    await writeFile(path.join(moved, 'corrallm'), '#!/bin/sh\n');
    await symlink(path.join(moved, 'corrallm'), at);
    expect(await link().status()).toMatchObject({ link: { is: 'stale' } });
    const before = await real(at);
    await link().install();
    expect(await real(at)).not.toBe(before);
  });
});
