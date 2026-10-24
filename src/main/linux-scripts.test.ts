import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, expect, it } from 'vitest';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

async function fixture() {
  const cache = path.join(root, 'node_modules/.cache/probes');
  await mkdir(cache, { recursive: true });
  const folder = await mkdtemp(path.join(cache, 'linux-scripts-'));
  folders.push(folder);
  const log = path.join(folder, 'commands.jsonl');
  const context = path.join(folder, 'build-context.tar');
  // The container's working-tree copy intentionally has no .git. These tests exercise Docker
  // orchestration with a small stand-in file list, not the developer's repository metadata.
  await writeFile(path.join(folder, 'git'), '#!/bin/bash\nprintf "AGENTS.md\\0deleted-file\\0"\n', {
    mode: 0o755,
  });
  await writeFile(
    path.join(folder, 'docker'),
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.COMMAND_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'build' || args.includes('--interactive')) {
  for await (const chunk of process.stdin) {
    if (args[0] === 'build') appendFileSync(process.env.BUILD_CONTEXT, chunk);
  }
}
if (args[0] === process.env.FAIL_DOCKER_STEP || args.includes(process.env.FAIL_DOCKER_ARG)) process.exit(19);
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${folder}:${process.env.PATH ?? ''}`,
    COMMAND_LOG: log,
    BUILD_CONTEXT: context,
  };
  async function commands(): Promise<string[][]> {
    return (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
  }
  return { folder, env, commands, context };
}

it.each([
  ['arm64', 'linux/arm64'],
  ['x64', 'linux/amd64'],
])(
  'runs the full Linux gate in the matching %s container, without host node_modules',
  async (arch, platform) => {
    const { env, commands, context } = await fixture();
    await exec('bash', ['scripts/ci-linux.sh', arch], { cwd: root, env });
    const calls = await commands();
    expect(calls[0]).toEqual(expect.arrayContaining(['build', '--platform', platform]));
    const listed = (await exec('tar', ['-tf', context])).stdout.trim().split('\n');
    expect(listed.sort()).toEqual(['linux-build.Dockerfile', 'linux-node-path.sh']);
    expect(calls[0]).toEqual(expect.arrayContaining(['--file', 'linux-build.Dockerfile']));
    const run = calls.find((args) => args[0] === 'run');
    expect(run).toEqual(expect.arrayContaining(['--platform', platform, 'ci', arch]));
    expect(run?.join(' ')).not.toContain(`${root}:`);
    expect(run?.join(' ')).not.toContain('--no-sandbox');
  },
);

it('refuses an unknown architecture before doing anything in Docker', async () => {
  const { env } = await fixture();
  await expect(
    exec('bash', ['scripts/ci-linux.sh', 'ia32'], { cwd: root, env }),
  ).rejects.toMatchObject({
    code: 2,
    stderr: expect.stringContaining('[arm64|x64]') as string,
  });
});

it('reports the failed step and does not carry on after an image build fails', async () => {
  const { env, commands } = await fixture();
  await expect(
    exec('bash', ['scripts/ci-linux.sh'], {
      cwd: root,
      env: { ...env, FAIL_DOCKER_STEP: 'build' },
    }),
  ).rejects.toMatchObject({
    code: 19,
    stderr: expect.stringContaining('Build Linux image') as string,
  });
  expect(await commands()).toHaveLength(1);
});

it.each(['arm64', 'x64'])(
  'tests %s installers in clean distro containers and releases the artifact volume',
  async (arch) => {
    const { env, commands } = await fixture();
    await exec('bash', ['scripts/check-linux-packages.sh', arch], { cwd: root, env });
    const calls = await commands();
    for (const image of ['debian:bookworm', 'fedora:44']) {
      const run = calls.find((args) => args[0] === 'run' && args.includes(image));
      expect(run).toBeDefined();
      expect(run?.join(' ')).toContain(':/checks:ro');
      expect(run?.join(' ')).not.toContain('/home/node');
    }
    expect(calls.at(-1)?.slice(0, 2)).toEqual(['volume', 'rm']);
  },
);

it('releases the artifact volume when an installed package check fails', async () => {
  const { env, commands } = await fixture();
  await expect(
    exec('bash', ['scripts/check-linux-packages.sh'], {
      cwd: root,
      env: { ...env, FAIL_DOCKER_ARG: 'debian:bookworm' },
    }),
  ).rejects.toMatchObject({
    code: 19,
    stderr: expect.stringContaining('Installed package checks') as string,
  });
  const calls = await commands();
  expect(calls.some((args) => args.includes('fedora:44'))).toBe(false);
  expect(calls.at(-1)?.slice(0, 2)).toEqual(['volume', 'rm']);
});

it('runs every gate in order, including the e2e global build under xvfb, stopping on failure', async () => {
  const { folder, env } = await fixture();
  const log = path.join(folder, 'pnpm.log');
  const graphics = path.join(folder, 'graphics.log');
  const display = path.join(folder, 'display.log');
  for (const name of ['pnpm', 'xvfb-run']) {
    await writeFile(
      path.join(folder, name),
      name === 'pnpm'
        ? '#!/bin/bash\nprintf "%s\\n" "$*" >> "$PNPM_LOG"\nif [ "$1" = test:e2e ]; then printf "%s\\n" "$CORRALLM_E2E_GL" "$LIBGL_ALWAYS_SOFTWARE" "$GALLIUM_DRIVER" > "$GRAPHICS_LOG"; fi\nif [ "$*" = "$FAIL_PNPM_STEP" ]; then exit 23; fi\n'
        : '#!/bin/bash\nprintf "%s\\n" "$1" "$2" "$3" > "$DISPLAY_LOG"\nshift\nshift\nshift\nexec "$@"\n',
      { mode: 0o755 },
    );
  }
  const runEnv = {
    ...env,
    PNPM_LOG: log,
    GRAPHICS_LOG: graphics,
    DISPLAY_LOG: display,
    CORRALLM_E2E_GL: '',
    LIBGL_ALWAYS_SOFTWARE: '',
    GALLIUM_DRIVER: '',
    FAIL_PNPM_STEP: 'lint',
  };
  await expect(
    exec('bash', [path.join(root, 'scripts/lib/linux-workspace.sh'), 'ci', 'arm64'], {
      cwd: folder,
      env: runEnv,
    }),
  ).rejects.toMatchObject({ code: 23, stderr: expect.stringContaining('Lint') as string });
  expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual([
    'install --frozen-lockfile',
    'exec install-electron',
    'typecheck',
    'lint',
  ]);
  await writeFile(log, '');
  await exec('bash', [path.join(root, 'scripts/lib/linux-workspace.sh'), 'ci', 'arm64'], {
    cwd: folder,
    env: { ...runEnv, FAIL_PNPM_STEP: '' },
  });
  expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual([
    'install --frozen-lockfile',
    'exec install-electron',
    'typecheck',
    'lint',
    'format:check',
    'test',
    'test:e2e --retries=0 --trace retain-on-failure --reporter=list,html',
  ]);
  expect(await readFile(graphics, 'utf8')).toBe('mesa\ntrue\nllvmpipe\n');
  expect(await readFile(display, 'utf8')).toBe('-a\n-s\n-screen 0 1920x1080x24 +extension GLX\n');
});

it('makes only the configured Linux makers and collects their installers and runtime checks', async () => {
  const { folder, env } = await fixture();
  const log = path.join(folder, 'pnpm.log');
  const artifacts = path.join(folder, 'artifacts');
  await mkdir(artifacts);
  for (const kind of ['deb', 'rpm']) {
    const out = path.join(folder, 'out/make', kind, 'x64');
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, `test.${kind}`), kind);
  }
  await writeFile(path.join(folder, 'pnpm'), '#!/bin/bash\nprintf "%s\\n" "$*" >> "$PNPM_LOG"\n', {
    mode: 0o755,
  });
  await exec(
    'bash',
    [path.join(root, 'scripts/lib/linux-workspace.sh'), 'packages', 'x64', artifacts],
    {
      cwd: folder,
      env: { ...env, PNPM_LOG: log },
    },
  );
  expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual([
    'install --frozen-lockfile',
    'exec install-electron',
    'make --platform linux --arch x64 --targets deb,rpm',
  ]);
  expect(await readFile(path.join(artifacts, 'corrallm.deb'), 'utf8')).toBe('deb');
  expect(await readFile(path.join(artifacts, 'corrallm.rpm'), 'utf8')).toBe('rpm');
  expect(await readFile(path.join(artifacts, 'linux-installed.sh'), 'utf8')).toContain(
    'linked_libraries',
  );
});

it.each([
  ['/usr/bin:/bin', '/usr/local/bin:/usr/bin:/bin'],
  ['', '/usr/local/bin'],
  ['/usr/local/bin:/usr/bin', '/usr/local/bin:/usr/bin'],
])('keeps the pinned Node visible in a login profile with PATH=%s', async (before, after) => {
  const profile = path.join(root, 'scripts/lib/linux-node-path.sh');
  const result = await exec(
    '/bin/sh',
    ['-c', '. "$1"; printf "%s\n%s" "$PATH" "$LOGIN_CHECK"', 'login-profile', profile],
    {
      env: { PATH: before, LOGIN_CHECK: 'configuration with spaces' },
    },
  );
  expect(result.stdout).toBe(`${after}\nconfiguration with spaces`);
});

it('installs the Node login profile and checks both login shells as the build user', async () => {
  const dockerfile = await readFile(path.join(root, 'scripts/lib/linux-build.Dockerfile'), 'utf8');
  expect(dockerfile).toContain('COPY linux-node-path.sh /etc/profile.d/corrallm-node.sh');
  expect(dockerfile).toContain('ENV SHELL=/bin/bash');
  const loginCheck = dockerfile.slice(dockerfile.indexOf('USER node'));
  expect(loginCheck).toContain('/bin/sh -ilc');
  expect(loginCheck).toContain('"$SHELL" -ilc');
  expect(loginCheck).toContain('node --version');
});
