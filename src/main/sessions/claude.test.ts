import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claudeFlags, findClaude, helpFlags, requireClaude } from './claude';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-claude-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';

/** Puts an executable `claude` in `folder` (under the test's folder); returns its path. */
async function install(folder: string, executable = true): Promise<string> {
  await mkdir(path.join(dir, folder), { recursive: true });
  const file = path.join(dir, folder, exe);
  await writeFile(file, '#!/bin/sh\n');
  await chmod(file, executable ? 0o755 : 0o644);
  return file;
}

describe('findClaude', () => {
  it('finds the native install first, then claude on the PATH', async () => {
    const home = path.join(dir, 'home');
    const onPath = await install('bin');
    const env = { PATH: [path.join(dir, 'empty'), path.join(dir, 'bin')].join(path.delimiter) };
    expect(await findClaude(env, { home, override: undefined })).toBe(onPath);
    const native = await install(path.join('home', '.local', 'bin'));
    expect(await findClaude(env, { home, override: undefined })).toBe(native);
  });

  it('takes the path the user set over any other', async () => {
    const chosen = await install('custom');
    await install('bin');
    const env = { PATH: path.join(dir, 'bin') };
    expect(await findClaude(env, { home: dir, override: chosen })).toBe(chosen);
  });

  it.skipIf(process.platform === 'win32')('skips a claude that cannot run', async () => {
    await install('bin', false);
    expect(
      await findClaude({ PATH: path.join(dir, 'bin') }, { home: dir, override: undefined }),
    ).toBeUndefined();
  });

  it('says how to install Claude Code when it finds none', async () => {
    await expect(
      requireClaude({ PATH: path.join(dir, 'nothing') }, { home: dir, override: undefined }),
    ).rejects.toThrow(/Claude Code isn't installed/);
  });
});

describe('claudeFlags', () => {
  it('reads the flags its --help lists', () => {
    const help = [
      'Options:',
      '  --effort <level>                      Effort level for the current session',
      '  --model <model>                       Model for the current session.',
      '  -r, --resume [value]                  Resume a conversation',
      '  --allowedTools, --allowed-tools <tools...>',
      'Commands:',
      '  auth                                  Manage authentication',
    ].join('\n');
    expect([...helpFlags(help)].sort()).toEqual([
      '--allowed-tools',
      '--allowedTools',
      '--effort',
      '--model',
      '--resume',
      '-r',
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'asks each claude once, and takes none from one that cannot say',
    async () => {
      const claude = await install('bin');
      const count = path.join(dir, 'asked');
      await writeFile(
        claude,
        `#!/bin/sh\necho x >> "${count}"\n[ "$1" = --help ] && echo '  --effort <level>  Effort'\n`,
      );
      const flags = claudeFlags();
      expect((await flags(claude, {})).has('--effort')).toBe(true);
      expect((await flags(claude, {})).has('--effort')).toBe(true);
      expect((await readFile(count, 'utf8')).trim().split('\n')).toHaveLength(1);

      const broken = await install('broken');
      await writeFile(broken, '#!/bin/sh\nexit 1\n');
      expect([...(await flags(broken, {}))]).toEqual([]);
    },
  );
});
