import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkVersion, codexVersion, findCodex, parseVersion, requireCodex } from './codex';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-codex-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Puts an executable file `name` in `folder` (under the test's folder); returns its path. */
async function install(folder: string, name = 'codex', script = '#!/bin/sh\n'): Promise<string> {
  await mkdir(path.join(dir, folder), { recursive: true });
  const file = path.join(dir, folder, name);
  await writeFile(file, script);
  await chmod(file, 0o755);
  return file;
}

const posix = process.platform !== 'win32';

describe('findCodex', () => {
  it.skipIf(!posix)('finds the standalone install first, then codex on the PATH', async () => {
    const home = path.join(dir, 'home');
    const onPath = await install('bin');
    const env = { PATH: [path.join(dir, 'empty'), path.join(dir, 'bin')].join(path.delimiter) };
    expect(await findCodex(env, { home, override: undefined })).toBe(onPath);
    const standalone = await install(path.join('home', '.local', 'bin'));
    expect(await findCodex(env, { home, override: undefined })).toBe(standalone);
  });

  it('takes the path the user set over any other', async () => {
    const chosen = await install('custom', 'my-codex');
    await install('bin');
    expect(await findCodex({ PATH: path.join(dir, 'bin') }, { home: dir, override: chosen })).toBe(
      chosen,
    );
  });

  it('runs the native Codex that npm installed on Windows, not its .cmd launcher', async () => {
    // npm's global folder: the launcher, and the platform's package with its binary.
    await install('npm', 'codex.cmd', '@node codex.js %*\r\n');
    const native = await install(
      path.join(
        'npm',
        'node_modules',
        '@openai',
        'codex',
        'node_modules',
        '@openai',
        'codex-win32-x64',
        'vendor',
        'x86_64-pc-windows-msvc',
        'codex',
      ),
      'codex.exe',
    );
    expect(
      await findCodex(
        { Path: path.join(dir, 'npm') },
        { home: dir, override: undefined, platform: 'win32' },
      ),
    ).toBe(native);
  });

  it('says how to install and log in to Codex when it finds none', async () => {
    await expect(
      requireCodex({ PATH: path.join(dir, 'nothing') }, { home: dir, override: undefined }),
    ).rejects.toThrow(/Codex isn't installed.*codex login/s);
  });
});

describe('the Codex version', () => {
  it('reads what `codex --version` prints', () => {
    expect(parseVersion('codex-cli 0.160.1\n')).toBe('0.160.1');
    expect(parseVersion('codex-cli 0.161.0-alpha.3')).toBe('0.161.0-alpha.3');
    expect(parseVersion('something else')).toBeUndefined();
  });

  it('accepts the version corrallm was built against, or a later one', () => {
    expect(checkVersion('0.160.1')).toBeUndefined();
    expect(checkVersion('0.162.0')).toBeUndefined();
    expect(checkVersion('1.0.0')).toBeUndefined();
    expect(checkVersion('0.159.9')).toMatch(/0\.159\.9.*0\.160\.0 or later/);
  });

  it.skipIf(!posix)('asks the installed codex', async () => {
    const codex = await install('bin', 'codex', '#!/bin/sh\necho "codex-cli 0.160.1"\n');
    expect(await codexVersion(codex, { PATH: '/usr/bin:/bin' })).toBe('0.160.1');
    const broken = await install('old', 'codex', '#!/bin/sh\nexit 3\n');
    await expect(codexVersion(broken, { PATH: '/usr/bin:/bin' })).rejects.toThrow(/version/);
  });
});
