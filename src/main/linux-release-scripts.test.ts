import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const cache = path.join(root, 'node_modules/.cache/probes');
  await mkdir(cache, { recursive: true });
  const folder = await mkdtemp(path.join(cache, 'linux-release-'));
  folders.push(folder);
  return folder;
}

const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

describe('scripts/lib/linux-keep.sh', () => {
  async function checked(deb = 'deb bytes', rpm = 'rpm bytes', keptDeb = deb) {
    const folder = await scratch();
    const checks = path.join(folder, 'checks');
    const out = path.join(folder, 'out');
    await mkdir(path.join(checks, 'release'), { recursive: true });
    await mkdir(out);
    await writeFile(path.join(checks, 'corrallm.deb'), deb);
    await writeFile(path.join(checks, 'corrallm.rpm'), rpm);
    await writeFile(path.join(checks, 'release/corrallm_0.1.0_arm64.deb'), keptDeb);
    await writeFile(path.join(checks, 'release/corrallm-0.1.0-1.aarch64.rpm'), rpm);
    return { checks, out };
  }
  const run = (checks: string, out: string) =>
    exec('bash', [path.join(root, 'scripts/lib/linux-keep.sh'), checks, out]);

  it('keeps the installed bytes under their release names, and prints their checksums', async () => {
    const { checks, out } = await checked();
    const { stdout } = await run(checks, out);
    expect((await readdir(out)).sort()).toEqual([
      'corrallm-0.1.0-1.aarch64.rpm',
      'corrallm_0.1.0_arm64.deb',
    ]);
    expect(await readFile(path.join(out, 'corrallm_0.1.0_arm64.deb'), 'utf8')).toBe('deb bytes');
    expect(stdout).toContain(`${sha('deb bytes')}  corrallm_0.1.0_arm64.deb`);
    expect(stdout).toContain(`${sha('rpm bytes')}  corrallm-0.1.0-1.aarch64.rpm`);
  });

  it('refuses installers whose bytes differ from the ones it checked', async () => {
    const { checks, out } = await checked('installed', 'rpm', 'something else');
    await expect(run(checks, out)).rejects.toMatchObject({
      stderr: expect.stringContaining('differs from the installed') as string,
    });
    expect(await readdir(out)).toEqual([]);
  });

  it('refuses when there is not exactly one installer of a kind', async () => {
    const { checks, out } = await checked();
    await writeFile(path.join(checks, 'release/corrallm_0.1.1_arm64.deb'), 'deb bytes');
    await expect(run(checks, out)).rejects.toMatchObject({
      stderr: expect.stringContaining('exactly one deb') as string,
    });
  });
});

describe('installed checks', () => {
  it('cover Debian, Ubuntu and Fedora, with the icon and the prerelease order', async () => {
    const installed = await readFile(path.join(root, 'scripts/lib/linux-installed.sh'), 'utf8');
    expect(installed).toMatch(/debian:bookworm\|ubuntu:24\.04\)/);
    expect(installed).toContain('fedora:44)');
    expect(installed).toContain('/usr/share/icons/hicolor/512x512/apps/corrallm.png');
    expect(installed).toContain('check_installed_version');
    expect(installed).toContain('check_prerelease_tools');
    const packages = await readFile(path.join(root, 'scripts/check-linux-packages.sh'), 'utf8');
    expect(/for distro in (.*); do/.exec(packages)?.[1]).toBe(
      'debian:bookworm ubuntu:24.04 fedora:44',
    );
  });
});

describe('scripts/lib/linux-versions.sh', () => {
  /** Runs one check with stubbed dpkg-query, rpm and dpkg: what is "installed" is the argument. */
  async function check(fn: string, args: string[], installed: string) {
    const folder = await scratch();
    const stub = (name: string, body: string) =>
      writeFile(path.join(folder, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    await stub('dpkg-query', `printf '%s' "$INSTALLED"`);
    await stub('rpm', `if [ "$1" = -q ]; then printf '%s' "$INSTALLED"; else printf '%s' -1; fi`);
    await stub('dpkg', `[ "$2" = 0.1.0~beta.1 ] && [ "$3" = lt ] && [ "$4" = 0.1.0 ]`);
    const script = `source ${path.join(root, 'scripts/lib/linux-steps.sh')}
source ${path.join(root, 'scripts/lib/linux-versions.sh')}
${fn} "$@"`;
    return exec('bash', ['-c', script, 'check', ...args], {
      env: { ...process.env, PATH: `${folder}:${process.env.PATH ?? ''}`, INSTALLED: installed },
    });
  }

  it.each([
    ['debian:bookworm', '0.1.0~beta.1'],
    ['fedora:44', '0.1.0~beta.1'],
    ['ubuntu:24.04', '0.1.0'],
  ])('accepts the version the installers convert on %s', async (distro, installed) => {
    await check('check_installed_version', [distro, installed, installed], installed);
  });

  it.each(['debian:bookworm', 'fedora:44'])(
    'refuses a beta installed as 0.1.0.beta.1 on %s, which has no tilde and sorts after its release',
    async (distro) => {
      await expect(
        check('check_installed_version', [distro, '0.1.0~beta.1', '0.1.0~beta.1'], '0.1.0.beta.1'),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining('expected 0.1.0~beta.1') as string,
      });
    },
  );

  it('asks the real tools whether the fixed beta sorts below its release', async () => {
    await check('check_prerelease_tools', ['debian:bookworm'], '');
    await check('check_prerelease_tools', ['fedora:44'], '');
  });
});
