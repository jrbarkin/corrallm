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
    expect(installed).toContain('dpkg --compare-versions');
    expect(installed).toContain('rpm.vercmp');
    const packages = await readFile(path.join(root, 'scripts/check-linux-packages.sh'), 'utf8');
    expect(/for distro in (.*); do/.exec(packages)?.[1]).toBe(
      'debian:bookworm ubuntu:24.04 fedora:44',
    );
  });
});
