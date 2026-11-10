import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  it('is none unpackaged, on Windows, with no file, with a folder there, or in a translocated copy', async () => {
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
    expect(packagedLauncher({ packaged: true, resourcesPath: moved, platform: 'darwin' })).toBe(
      null,
    );
  });
});
