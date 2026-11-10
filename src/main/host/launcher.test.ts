import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CommandLink } from '../core/command-link';
import { packagedLauncher } from './launcher';

/** The packaged app's launcher (B30 C2): found only in a packaged app, as a real regular file. */

let dir: string;
let resources: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'launch-'));
  resources = path.join(dir, 'corrallm.app', 'Contents', 'Resources');
  await mkdir(path.join(resources, 'bin'), { recursive: true });
  await writeFile(path.join(resources, 'bin', 'corrallm'), '#!/bin/sh\n');
  await chmod(path.join(resources, 'bin', 'corrallm'), 0o755);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the packaged launcher', () => {
  it('is the real path of bin/corrallm in a packaged app on macOS and Linux', () => {
    const found = packagedLauncher({
      packaged: true,
      resourcesPath: resources,
      platform: 'darwin',
    });
    expect(found).toMatch(/corrallm\.app\/Contents\/Resources\/bin\/corrallm$/);
    expect(packagedLauncher({ packaged: true, resourcesPath: resources, platform: 'linux' })).toBe(
      found,
    );
  });

  it('follows a link to the real file', async () => {
    const other = path.join(dir, 'link-resources');
    await mkdir(path.join(other, 'bin'), { recursive: true });
    await symlink(path.join(resources, 'bin', 'corrallm'), path.join(other, 'bin', 'corrallm'));
    expect(packagedLauncher({ packaged: true, resourcesPath: other, platform: 'linux' })).toMatch(
      /Resources\/bin\/corrallm$/,
    );
  });

  it('is none unpackaged, on Windows, with no file, or with a folder there', async () => {
    expect(
      packagedLauncher({ packaged: false, resourcesPath: resources, platform: 'darwin' }),
    ).toBe(null);
    expect(packagedLauncher({ packaged: true, resourcesPath: resources, platform: 'win32' })).toBe(
      null,
    );
    expect(
      packagedLauncher({
        packaged: true,
        resourcesPath: path.join(dir, 'none'),
        platform: 'linux',
      }),
    ).toBe(null);
    const folder = path.join(dir, 'folder');
    await mkdir(path.join(folder, 'bin', 'corrallm'), { recursive: true });
    expect(packagedLauncher({ packaged: true, resourcesPath: folder, platform: 'linux' })).toBe(
      null,
    );
  });

  it('hands over a translocated copy’s path as it is, so the core can say why it will not link it', async () => {
    const moved = path.join(
      dir,
      'AppTranslocation',
      'X',
      'd',
      'corrallm.app',
      'Contents',
      'Resources',
    );
    await mkdir(path.join(moved, 'bin'), { recursive: true });
    await writeFile(path.join(moved, 'bin', 'corrallm'), '#!/bin/sh\n');
    expect(packagedLauncher({ packaged: true, resourcesPath: moved, platform: 'darwin' })).toMatch(
      /AppTranslocation\/X\/d\/corrallm\.app\/Contents\/Resources\/bin\/corrallm$/,
    );
  });

  it('composes with the command link: a translocated app is told to move to Applications, and nothing is written', async () => {
    const moved = path.join(
      dir,
      'AppTranslocation',
      'X',
      'd',
      'corrallm.app',
      'Contents',
      'Resources',
    );
    await mkdir(path.join(moved, 'bin'), { recursive: true });
    await writeFile(path.join(moved, 'bin', 'corrallm'), '#!/bin/sh\n');
    const home = path.join(dir, 'home');
    await mkdir(home);
    const service = new CommandLink({
      home,
      searchPath: () => Promise.resolve('/usr/bin'),
      launcher: () =>
        packagedLauncher({ packaged: true, resourcesPath: moved, platform: 'darwin' }),
      platform: 'darwin',
    });
    expect(await service.status()).toEqual({
      state: 'unavailable',
      sentence: 'Move corrallm to Applications, then open it from there.',
    });
    await expect(service.install()).rejects.toMatchObject({ code: 'refused' });
    await expect(lstat(path.join(home, '.local'))).rejects.toThrow();
  });
});
