import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NODE_VERSION, NODE_RELEASES, nodeRelease, stageNode } from '../../build/node-runtime.js';
import { shipCli } from '../../build/shipped-cli.js';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..', '..');
let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), 'corrallm-shipped-cli-'));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

async function put(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function archive() {
  const release = nodeRelease('linux', 'x64');
  const base = release.file.replace(/\.tar\.gz$/, '');
  const source = path.join(folder, 'source');
  await put(path.join(source, base, 'bin/node'), 'fake node');
  await put(path.join(source, base, 'LICENSE'), 'Node license bytes\n');
  await put(path.join(source, base, 'bin/npm'), 'not shipped');
  await put(path.join(source, base, 'include/node/node.h'), 'not shipped');
  const file = path.join(folder, 'fixture.tar.gz');
  await run('tar', ['-czf', file, '-C', source, base]);
  const bytes = await readFile(file);
  return {
    bytes,
    release: { ...release, sha256: createHash('sha256').update(bytes).digest('hex') },
  };
}

describe('the shipped Node', () => {
  it('pins the same version as the toolchain, for exactly the four released targets', async () => {
    expect(NODE_VERSION).toBe((await readFile(path.join(ROOT, '.nvmrc'), 'utf8')).trim());
    expect(Object.keys(NODE_RELEASES).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
    ]);
    for (const [target, release] of Object.entries(NODE_RELEASES)) {
      expect(release.file).toBe(`node-v${NODE_VERSION}-${target}.tar.gz`);
      expect(release.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(nodeRelease('mas', 'arm64')).toEqual(nodeRelease('darwin', 'arm64'));
    expect(() => nodeRelease('linux', 'riscv64')).toThrow(/not supported/);
    expect(() => nodeRelease('win32', 'x64')).toThrow(/not supported/);
  });

  it('refuses a downloaded checksum mismatch before unpacking or shipping anything', async () => {
    const destination = path.join(folder, 'runtime');
    const fetch = vi.fn(() => Promise.resolve(new Response('wrong archive')));
    await expect(
      stageNode(destination, nodeRelease('linux', 'x64'), {
        cache: path.join(folder, 'cache'),
        fetch,
      }),
    ).rejects.toThrow(/SHA-256 mismatch/);
    await expect(readdir(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('checks cached bytes again and ships only the executable and license', async () => {
    const { bytes, release } = await archive();
    const cache = path.join(folder, 'cache');
    const destination = path.join(folder, 'runtime');
    const fetch = vi.fn(() => Promise.resolve(new Response(bytes)));
    await stageNode(destination, release, { cache, fetch });
    expect(await readdir(destination)).toEqual(['NODE-LICENSE', 'node']);
    expect(await readFile(path.join(destination, 'node'), 'utf8')).toBe('fake node');
    expect(await readFile(path.join(destination, 'NODE-LICENSE'), 'utf8')).toBe(
      'Node license bytes\n',
    );
    await stageNode(destination, release, { cache, fetch });
    expect(fetch).toHaveBeenCalledOnce();
    await writeFile(path.join(cache, release.file), 'tampered cache');
    await expect(stageNode(destination, release, { cache, fetch })).rejects.toThrow(
      /SHA-256 mismatch/,
    );
    expect(fetch).toHaveBeenCalledOnce(); // A bad cache is refused, never silently replaced.
  });
});

describe('the shipped command', () => {
  it('puts its bundle, runtime, launcher and only its target’s native runtime outside app.asar', async () => {
    const project = path.join(folder, 'project');
    await put(path.join(project, 'dist-cli/corrallm.cjs'), 'CLI bundle');
    await put(
      path.join(project, 'build/corrallm'),
      await readFile(path.join(ROOT, 'build/corrallm'), 'utf8'),
    );
    const pty = path.join(project, 'node_modules/node-pty');
    await put(
      path.join(pty, 'package.json'),
      JSON.stringify({ main: 'lib/index.js', dependencies: { 'node-addon-api': '*' } }),
    );
    for (const file of [
      'LICENSE',
      'lib/index.js',
      'lib/drop.test.js',
      'lib/drop.d.ts',
      'prebuilds/linux-arm64/pty.node',
      'prebuilds/linux-x64/pty.node',
      'src/never.cc',
    ])
      await put(path.join(pty, file), file);
    const app = path.join(folder, 'resources/app');
    await mkdir(app, { recursive: true });
    const runtime = vi.fn(async (destination: string) => {
      await put(path.join(destination, 'node'), 'node');
      await put(path.join(destination, 'NODE-LICENSE'), 'license');
    });
    await shipCli(app, 'linux', 'arm64', { project, stageRuntime: runtime });
    const resources = path.dirname(app);
    expect(await readFile(path.join(resources, 'cli/corrallm.cjs'), 'utf8')).toBe('CLI bundle');
    expect(await readFile(path.join(resources, 'cli/node'), 'utf8')).toBe('node');
    expect(await readFile(path.join(resources, 'cli/NODE-LICENSE'), 'utf8')).toBe('license');
    expect(await readFile(path.join(resources, 'bin/corrallm'), 'utf8')).toContain('exec ');
    expect(await readdir(path.join(resources, 'cli/node_modules/node-pty/lib'))).toEqual([
      'index.js',
    ]);
    expect(await readdir(path.join(resources, 'cli/node_modules/node-pty/prebuilds'))).toEqual([
      'linux-arm64',
    ]);
    expect(await readdir(app)).toEqual([]);
  });

  it('leaves Windows packaging unchanged until its command is supported', async () => {
    const runtime = vi.fn();
    await shipCli(path.join(folder, 'app'), 'win32', 'x64', { stageRuntime: runtime });
    expect(runtime).not.toHaveBeenCalled();
    expect(await readdir(folder)).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'resolves relative and absolute symlinks with spaces, without Node or utilities on PATH',
    async () => {
      const resources = path.join(folder, 'My app/Resources');
      const launcher = path.join(resources, 'bin/corrallm');
      await put(launcher, await readFile(path.join(ROOT, 'build/corrallm'), 'utf8'));
      await chmod(launcher, 0o755);
      await mkdir(path.join(resources, 'cli'));
      await symlink(process.execPath, path.join(resources, 'cli/node'));
      await put(
        path.join(resources, 'cli/corrallm.cjs'),
        'console.log(JSON.stringify(process.argv.slice(2))); console.error("diagnostic"); process.exit(7);',
      );
      const intermediate = path.join(folder, 'command link');
      await symlink('My app/Resources/bin/corrallm', intermediate);
      const outer = path.join(folder, 'outer');
      await symlink(intermediate, outer);
      for (const file of [launcher, intermediate, outer]) {
        const result = await run(file, ['with spaces', 'a"b', '--flag'], {
          env: { PATH: '' },
        }).catch((error: unknown) => error);
        expect(result).toMatchObject({
          code: 7,
          stdout: '["with spaces","a\\"b","--flag"]\n',
          stderr: 'diagnostic\n',
        });
      }
    },
  );
});
