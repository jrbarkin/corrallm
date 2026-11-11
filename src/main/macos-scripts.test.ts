import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

// One program stands in for every tool the script calls (codesign, plutil, spctl, xcrun, ditto),
// for the app, the command and the fuse check. It logs each call and fails or lies as the
// environment says: a variable names a substring of the path it should misbehave for.
const STUB = String.raw`
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
const env = process.env;
const kind = process.argv[1].endsWith('/MacOS/corrallm') ? 'app'
  : process.argv[1].endsWith('/bin/corrallm') ? 'command'
  : path.basename(process.argv[1]).replace(/\.mjs$/, '');
const args = process.argv.slice(2);
appendFileSync(env.COMMAND_LOG, JSON.stringify({ kind, args,
  path: env.PATH, selfTest: env.CORRALLM_NATIVE_SELFTEST }) + '\n');
if (env.FAIL_CHECK === kind) process.exit(19);
const target = args.at(-1) ?? '';
const has = (variable) => env[variable] !== undefined && target.includes(env[variable]);
const entitlements = (extra) => '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/>' + extra + '</dict></plist>';
if (kind === 'app' && args.length) process.exit(args[0] === env.ACCEPT_SWITCH ? 0 : 1);
if (kind === 'codesign' && args[0] === '--display' && args[1] === '--verbose=4') {
  const lines = env.SIGN === 'adhoc'
    ? ['Signature=adhoc', 'flags=0x2(adhoc,runtime)']
    : [
        'Authority=' + (env.SIGN === 'other-authority' ? 'Apple Development: Someone (ABCDE12345)' : 'Developer ID Application: Test (TEAM123456)'),
        'TeamIdentifier=' + (env.SIGN === 'other-team' ? 'OTHER12345' : 'TEAM123456'),
        has('NO_RUNTIME') ? 'flags=0x0(none)' : 'flags=0x10000(runtime)',
      ];
  process.stderr.write(lines.join('\n') + '\n');
}
if (kind === 'codesign' && args[1] === '--entitlements') {
  process.stdout.write(entitlements(has('BAD_ENTITLEMENTS') ? '<key>com.apple.security.cs.disable-library-validation</key><true/>' : ''));
}
if (kind === 'plutil') {
  process.stdout.write((args[1] === 'CFBundleIdentifier'
    ? env.BUNDLE_ID ?? 'io.github.jrbarkin.corrallm' : env.BUNDLE_VERSION ?? env.PACKAGE_VERSION) + '\n');
}
if (kind === 'spctl') {
  if (has('SPCTL_REJECT')) process.exit(3);
  process.stderr.write('source=' + (has('SPCTL_ADHOC') ? 'Insufficient Context' : 'Notarized Developer ID') + '\n');
}
if (kind === 'xcrun' && has('NOT_STAPLED')) process.exit(65);
if (kind === 'ditto') mkdirSync(path.join(args.at(-1), 'corrallm.app/Contents'), { recursive: true });
`;

const NOTICED = ['react', '@xterm/xterm', '@xyflow/react', 'zod', '@modelcontextprotocol/sdk'];

/** The resources a built app holds of its notices; the options damage them. */
async function writeNotices(
  resources: string,
  { drop, extra, skip }: { drop?: string; extra?: string; skip?: string } = {},
) {
  const rule = '='.repeat(78);
  const entries = [...NOTICED.filter((name) => name !== drop), ...(extra ? [extra] : [])].map(
    (name) => `${rule}\n${name} 1.2.3\nLicense: MIT\n\nthe license text\n`,
  );
  await mkdir(resources, { recursive: true });
  await writeFile(
    path.join(resources, 'THIRD-PARTY-NOTICES.txt'),
    `corrallm bundles the packages below.\n\n${entries.join('\n')}${rule}\n`,
  );
  for (const name of ['electron-LICENSE', 'LICENSES.chromium.html'])
    if (name === skip) await rm(path.join(resources, name), { force: true });
    else await writeFile(path.join(resources, name), 'text');
}

async function fixture(arch = 'arm64') {
  const cache = path.join(root, 'node_modules/.cache/probes');
  await mkdir(cache, { recursive: true });
  const folder = await mkdtemp(path.join(cache, 'macos checks '));
  folders.push(folder);
  const script = path.join(folder, 'scripts/check-macos.sh');
  await mkdir(path.join(folder, 'scripts/lib'), { recursive: true });
  await mkdir(path.join(folder, 'build'));
  await copyFile(path.join(root, 'scripts/check-macos.sh'), script);
  await copyFile(
    path.join(root, 'scripts/lib/notices-check.sh'),
    path.join(folder, 'scripts/lib/notices-check.sh'),
  );
  await copyFile(
    path.join(root, 'scripts/lib/entitlements-equal.mjs'),
    path.join(folder, 'scripts/lib/entitlements-equal.mjs'),
  );
  for (const name of ['entitlements.mac.plist', 'entitlements.node.plist'])
    await copyFile(path.join(root, 'build', name), path.join(folder, 'build', name));
  await copyFile(path.join(root, 'forge.config.mts'), path.join(folder, 'forge.config.mts'));
  await copyFile(path.join(root, 'package.json'), path.join(folder, 'package.json'));
  const version = (
    JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string }
  ).version;
  const app = path.join(folder, `out/corrallm-darwin-${arch}/corrallm.app`);
  const helper = path.join(
    app,
    `Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-${arch}/spawn-helper`,
  );
  const log = path.join(folder, 'commands.jsonl');
  const program = `#!${process.execPath}\n${STUB}`;
  for (const file of [
    path.join(folder, 'codesign'),
    path.join(folder, 'plutil'),
    path.join(folder, 'spctl'),
    path.join(folder, 'xcrun'),
    path.join(folder, 'ditto'),
    path.join(folder, 'scripts/check-fuses.mjs'),
    path.join(app, 'Contents/MacOS/corrallm'),
    path.join(app, 'Contents/Resources/bin/corrallm'),
    helper,
  ]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, program, { mode: 0o755 });
  }
  // The seeding build and the headless round trip are other gates' work (headless-smoke.test.ts
  // pins them): here they are stood in for, and only what they were asked is kept.
  const steps = path.join(folder, 'steps.log');
  await mkdir(path.join(folder, 'scripts/lib'), { recursive: true });
  await writeFile(
    path.join(folder, 'scripts/lib/headless-smoke.sh'),
    `#!/bin/sh\nprintf 'smoke %s\\n' "$*" >> "${steps}"\n`,
    { mode: 0o755 },
  );
  await writeFile(
    path.join(folder, 'pnpm'),
    `#!/bin/sh\nprintf 'pnpm %s\\n' "$*" >> "${steps}"\n`,
    {
      mode: 0o755,
    },
  );
  await mkdir(path.join(app, 'Contents/Frameworks/corrallm Helper.app'), { recursive: true });
  await writeNotices(path.join(app, 'Contents/Resources'));
  const env = {
    ...process.env,
    PATH: `${folder}:${process.env.PATH ?? ''}`,
    COMMAND_LOG: log,
    PACKAGE_VERSION: version,
    APPLE_SIGNING_IDENTITY: 'Developer ID Application: Test (TEAM123456)',
  };
  async function commands(): Promise<
    { kind: string; args: string[]; path: string; selfTest?: string }[]
  > {
    return (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Awaited<ReturnType<typeof commands>>[number]);
  }
  return { folder, script, app, helper, env, commands, steps };
}

it.each(['arm64', 'x64'])(
  'verifies the %s bundle, id, helper, native self-test, refused switches and shipped command',
  async (arch) => {
    const { script, app, env, commands, steps, folder } = await fixture(arch);
    await exec('bash', [script, arch], { cwd: root, env });
    expect((await readFile(steps, 'utf8')).trim().split('\n')).toEqual([
      'pnpm build:seed',
      `smoke ${app}/Contents/Resources/bin/corrallm ${app}/Contents/Resources/cli/node ${folder}/dist-check/seed-profile.cjs`,
    ]);
    const calls = await commands();
    expect(calls.map(({ kind, args }) => ({ kind, args }))).toEqual([
      { kind: 'codesign', args: ['--verify', '--deep', '--strict', app] },
      {
        kind: 'plutil',
        args: ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', `${app}/Contents/Info.plist`],
      },
      { kind: 'app', args: [] },
      { kind: 'app', args: ['--remote-debugging-port=0'] },
      { kind: 'app', args: ['--gpu-launcher=refused'] },
      { kind: 'app', args: ['--renderer-cmd-prefix=refused'] },
      { kind: 'command', args: [] },
      { kind: 'command', args: ['--help'] },
    ]);
    expect(
      calls.filter(({ kind }) => kind === 'app').every(({ selfTest }) => selfTest === '1'),
    ).toBe(true);
    const command = calls.filter(({ kind }) => kind === 'command');
    expect(command.map(({ path }) => path)).toEqual(['', '']);
    expect(command[0]?.selfTest).toBe('1');
    expect(command[1]?.selfTest).toBeUndefined();
  },
);

describe('the shipped notices', () => {
  it.each([
    ['a missing package', { drop: 'zod' }, /no entry with a license for zod/],
    ['a build tool', { extra: 'vite' }, /vite/],
    ['a Forge package', { extra: '@electron-forge/shared-types' }, /@electron-forge/],
    ['no Electron license', { skip: 'electron-LICENSE' }, /No electron-LICENSE/],
    ['no Chromium licenses', { skip: 'LICENSES.chromium.html' }, /No LICENSES\.chromium\.html/],
  ])('refuses %s, before running the app', async (_name, damage, message) => {
    const { script, app, env, commands } = await fixture();
    await writeNotices(path.join(app, 'Contents/Resources'), damage);
    await expect(exec('bash', [script, 'arm64'], { env })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(message) as string,
    });
    expect((await commands()).some(({ kind }) => kind === 'app')).toBe(false);
  });

  it('refuses a notices file that is empty', async () => {
    const { script, app, env } = await fixture();
    await writeFile(path.join(app, 'Contents/Resources/THIRD-PARTY-NOTICES.txt'), '');
    await expect(exec('bash', [script, 'arm64'], { env })).rejects.toMatchObject({
      stderr: expect.stringContaining('THIRD-PARTY-NOTICES.txt') as string,
    });
  });
});

it('fails on a damaged bundle before running any executable from it', async () => {
  const { script, env, commands } = await fixture();
  await expect(
    exec('bash', [script, 'arm64'], { env: { ...env, FAIL_CHECK: 'codesign' } }),
  ).rejects.toMatchObject({
    code: 19,
    stderr: expect.stringContaining('Verify macOS bundle signature') as string,
  });
  expect((await commands()).map(({ kind }) => kind)).toEqual(['codesign']);
});

it('fails when the bundle id differs from forge.config.mts, before running the app', async () => {
  const { script, env, commands } = await fixture();
  await expect(
    exec('bash', [script, 'arm64'], { env: { ...env, BUNDLE_ID: 'com.electron.corrallm' } }),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('com.electron.corrallm') as string,
  });
  expect((await commands()).map(({ kind }) => kind)).toEqual(['codesign', 'plutil']);
});

it('fails on a non-executable spawn-helper before running the app', async () => {
  const { script, helper, env, commands } = await fixture();
  await chmod(helper, 0o644);
  await expect(exec('bash', [script, 'arm64'], { env })).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Check node-pty spawn-helper') as string,
  });
  expect((await commands()).map(({ kind }) => kind)).toEqual(['codesign', 'plutil']);
});

it.each(['--remote-debugging-port=0', '--gpu-launcher=refused', '--renderer-cmd-prefix=refused'])(
  'fails if the packaged app accepts %s',
  async (switchName) => {
    const { script, env, commands } = await fixture();
    await expect(
      exec('bash', [script, 'arm64'], { env: { ...env, ACCEPT_SWITCH: switchName } }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`accepted ${switchName}`) as string,
    });
    expect((await commands()).at(-1)).toMatchObject({ kind: 'app', args: [switchName] });
  },
);

it.each(['app', 'command'])('stops and names a failed %s self-test', async (kind) => {
  const { script, env, commands } = await fixture();
  await expect(
    exec('bash', [script, 'arm64'], { env: { ...env, FAIL_CHECK: kind } }),
  ).rejects.toMatchObject({
    code: 19,
    stderr: expect.stringContaining('self-test') as string,
  });
  expect((await commands()).at(-1)).toMatchObject({ kind, args: [] });
});

it('refuses arguments it does not know, and --zip or --dmg without --release', async () => {
  const { script, env } = await fixture();
  for (const args of [['--bogus'], ['--zip', 'a.zip'], ['--release', '--dmg'], ['arm64', 'x64']])
    await expect(exec('bash', [script, ...args], { env })).rejects.toMatchObject({ code: 2 });
});

describe('--release', { timeout: 60_000 }, () => {
  const release = ['--release', 'arm64'];

  it('passes when everything holds, on the packaged app, the zip’s app and the dmg', async () => {
    const { script, app, env, commands } = await fixture();
    const { stdout } = await exec(
      'bash',
      [script, '--release', '--zip', 'corrallm.zip', '--dmg', 'corrallm.dmg', 'arm64'],
      { env },
    );
    expect(stdout).toContain('packaged checks: passed');
    const calls = await commands();
    const unzipped = calls.find(({ kind }) => kind === 'ditto');
    expect(unzipped?.args.slice(0, 3)).toEqual(['-x', '-k', 'corrallm.zip']);
    const dmgChecks = calls.filter(
      ({ kind, args }) => (kind === 'xcrun' || kind === 'spctl') && args.at(-1) === 'corrallm.dmg',
    );
    expect(dmgChecks.map(({ kind, args }) => [kind, ...args.slice(0, 2)])).toEqual([
      ['xcrun', 'stapler', 'validate'],
      ['spctl', '--assess', '--type'],
    ]);
    expect(
      calls.find(({ kind, args }) => kind === 'spctl' && args.includes('open'))?.args,
    ).toContain('context:primary-signature');
    // The packaged app and the zip's app each get the fuse read-back.
    expect(calls.filter(({ kind }) => kind === 'check-fuses')).toHaveLength(2);
    expect(calls.find(({ kind }) => kind === 'check-fuses')?.args).toEqual([
      `${app}/Contents/MacOS/corrallm`,
    ]);
  });

  it('is not run by the development check, which an ad hoc signature passes', async () => {
    const { script, env, commands } = await fixture();
    await exec('bash', [script, 'arm64'], { env: { ...env, SIGN: 'adhoc' } });
    expect((await commands()).map(({ kind }) => kind)).not.toContain('spctl');
  });

  it.each([
    ['an ad hoc signature', { SIGN: 'adhoc' }, 'ad hoc signature'],
    [
      'an authority other than Developer ID',
      { SIGN: 'other-authority' },
      'Developer ID Application',
    ],
    ['another team', { SIGN: 'other-team' }, 'not signed by team TEAM123456'],
    ['an identity naming no team', { APPLE_SIGNING_IDENTITY: 'ABCDEF' }, 'names no team'],
    ['no identity', { APPLE_SIGNING_IDENTITY: '' }, 'APPLE_SIGNING_IDENTITY is not set'],
    ['a helper without the hardened runtime', { NO_RUNTIME: 'Helper.app' }, 'no hardened runtime'],
    [
      'the bundled Node without the hardened runtime',
      { NO_RUNTIME: 'cli/node' },
      'no hardened runtime on',
    ],
    [
      'the bundled Node with other entitlements',
      { BAD_ENTITLEMENTS: 'cli/node' },
      'entitlements of',
    ],
    ['the app with other entitlements', { BAD_ENTITLEMENTS: 'corrallm.app' }, 'entitlements of'],
    ['a missing staple on the app', { NOT_STAPLED: 'corrallm.app' }, 'Release checks'],
    ['Gatekeeper rejecting the app', { SPCTL_REJECT: 'corrallm.app' }, 'Gatekeeper rejects'],
    ['an app Gatekeeper does not call notarized', { SPCTL_ADHOC: 'corrallm.app' }, 'notarized'],
    ['a wrong bundle id', { BUNDLE_ID: 'com.example.other' }, 'com.example.other'],
    ['a wrong version', { BUNDLE_VERSION: '9.9.9' }, 'version in Info.plist'],
    ['a fuse differing from the configuration', { FAIL_CHECK: 'check-fuses' }, 'Release checks'],
  ])('fails on %s', async (_name, change, message) => {
    const { script, env } = await fixture();
    await expect(
      exec('bash', [script, ...release], { env: { ...env, ...change } }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining(message) as string });
  });

  it('fails on a zip whose app is not what the release says', async () => {
    const { script, env } = await fixture();
    // The unzipped copy sits in a scratch folder, not under the packaged app's path.
    await expect(
      exec('bash', [script, '--release', '--zip', 'a.zip', 'arm64'], {
        env: { ...env, NOT_STAPLED: 'corrallm-zip-check' },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('a.zip') as string });
  });

  it.each([
    ['a dmg that is not stapled', { NOT_STAPLED: 'corrallm.dmg' }],
    ['a dmg Gatekeeper rejects', { SPCTL_REJECT: 'corrallm.dmg' }],
    ['a dmg Gatekeeper does not call notarized', { SPCTL_ADHOC: 'corrallm.dmg' }],
  ])('fails on %s', async (_name, change) => {
    const { script, env } = await fixture();
    await expect(
      exec('bash', [script, '--release', '--dmg', 'corrallm.dmg', 'arm64'], {
        env: { ...env, ...change },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('corrallm.dmg') as string });
  });
});
