import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { assetNames } from '../../build/release';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(root, 'scripts/release.sh');
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

const COMMIT = 'a'.repeat(40);
const SECRET = 'super-secret-credential-value';

describe('scripts/release.sh, read as text', () => {
  it('never publishes, pushes, edits or deletes, and makes only a draft', async () => {
    const text = await readFile(SCRIPT, 'utf8');
    const code = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/git push|git tag/);
    // `--draft=false` appears only where the script refuses it.
    expect(code.match(/--draft=false/g) ?? []).toHaveLength(0);
    expect(code).not.toMatch(/gh release (edit|upload|delete)/);
    expect(code).not.toMatch(/gh api .*(--method|-X |--field|--raw-field| -f |--input)/);
    expect(code).not.toMatch(/set -x|set -o xtrace/);
    // Its only `gh` commands: reading CI and the release, and creating the draft.
    const gh = [...code.matchAll(/\bgh (\w+)(?: (\w+))?/g)].map((match) =>
      [match[1], match[2]].filter(Boolean).join(' '),
    );
    expect(new Set(gh)).toEqual(new Set(['release view', 'api', 'release create']));
    expect(code.match(/gh release create/g)).toHaveLength(1);
    expect(code).toMatch(/local flags=\(--draft /);
  });

  it('builds only in the clone: every pnpm and project script runs through in_clone', async () => {
    const text = await readFile(SCRIPT, 'utf8');
    const lines = text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#') && /\bpnpm\b|bash scripts\//.test(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line, line).toMatch(/in_clone|decide|usage|printf|"pnpm|'pnpm/);
    }
  });
});

async function fixture(extra: Record<string, string> = {}) {
  // Not under node_modules: Node does not strip types from files there.
  const folder = await mkdtemp(path.join(tmpdir(), 'release-script-'));
  folders.push(folder);
  await mkdir(path.join(folder, 'scripts'));
  await mkdir(path.join(folder, 'build'));
  await copyFile(SCRIPT, path.join(folder, 'scripts/release.sh'));
  await copyFile(
    path.join(root, 'scripts/release-decide.mjs'),
    path.join(folder, 'scripts/release-decide.mjs'),
  );
  for (const name of ['release.ts', 'linux-version.ts'])
    await copyFile(path.join(root, 'build', name), path.join(folder, 'build', name));
  const bin = path.join(folder, 'bin');
  await mkdir(bin);
  const log = path.join(folder, 'calls.jsonl');
  // One program stands in for every external tool, logging each call.
  const program = `#!${process.execPath}
import { appendFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
const env = process.env;
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(env.CALL_LOG, JSON.stringify({ tool, args, cwd: process.cwd() }) + '\\n');
const out = (text) => process.stdout.write(text + '\\n');
const extra = env.LISTING_EXTRA ? env.LISTING_EXTRA.split(',') : [];
const listing = [
  './Resources/NOTICE', './Resources/LICENSE', './Resources/THIRD-PARTY-NOTICES.txt',
  './Resources/claude-agent-sdk-LICENSE.md', ...extra,
].filter((entry) => !(env.LISTING_DROP && entry.endsWith(env.LISTING_DROP)));
switch (tool) {
  case 'git':
    if (args[0] === 'fetch') break;
    if (args[0] === 'rev-parse') out('${COMMIT}');
    else if (args[0] === 'show') out(JSON.stringify({ version: env.PACKAGE_VERSION ?? '0.1.0' }));
    else if (args[0] === 'merge-base') process.exit(env.OFF_MAIN ? 1 : 0);
    else if (args[0] === 'remote') out('file:///nowhere');
    else if (args[0] === 'ls-remote') process.exit(2);
    else if (args[0] === 'clone') {
      const clone = args.at(-1);
      mkdirSync(path.join(clone, 'scripts'), { recursive: true });
      for (const name of ['check-linux-packages.sh', 'check-macos.sh'])
        writeFileSync(path.join(clone, 'scripts', name), name.startsWith('check-linux')
          ? '#!/bin/bash\\nout=$3\\nmkdir -p "$out"\\nif [ "$1" = arm64 ]; then d=arm64; r=arm64; else d=amd64; r=x86_64; fi\\nv=$PACKAGE_VERSION\\n[ -n "$v" ] || v=0.1.0\\ndv=$(printf %s "$v" | tr - "~")\\nprintf "deb $1" > "$out/corrallm_$dv"_$d.deb\\nprintf "rpm $1" > "$out/corrallm-$dv"-1.$r.rpm\\n'
          : '#!/bin/bash\\nexit 0\\n');
    }
    break;
  case 'gh':
    if (args[0] === 'release' && args[1] === 'view') process.exit(env.RELEASE_EXISTS ? 0 : 1);
    if (args[0] === 'api') {
      const names = ['macos-latest', 'ubuntu-24.04', 'ubuntu-24.04-arm', 'e2e macos-latest (1/2)',
        'e2e macos-latest (2/2)', 'e2e ubuntu-24.04 (1/2)', 'e2e ubuntu-24.04 (2/2)'];
      for (const name of names)
        out(JSON.stringify({ name, status: 'completed', conclusion: env.CI_FAILS === name ? 'failure' : 'success' }));
    }
    if (args[0] === 'release' && args[1] === 'create') out('https://github.com/example/draft');
    break;
  case 'docker':
    process.exit(env.DOCKER_DOWN ? 1 : 0);
  case 'pnpm':
    if (args[0] === 'audit') {
      out(JSON.stringify({ metadata: { vulnerabilities: { low: Number(env.ADVISORIES ?? 0), high: 0 } } }));
    } else if (args[0] === 'make') {
      const v = env.PACKAGE_VERSION ?? '0.1.0';
      for (const file of ['out/make/zip/darwin/arm64/corrallm-darwin-arm64-' + v + '.zip', 'out/make/dmg/arm64/corrallm-' + v + '-arm64.dmg']) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, 'bytes of ' + file);
      }
    } else if (args[0] === 'exec' && args[1] === 'asar') {
      out('/app/index.js');
      for (const entry of extra.filter((entry) => entry.startsWith('/'))) out(entry);
    }
    break;
  case 'unzip':
    for (const entry of listing) out(entry);
    break;
  case 'tar':
    if (args.includes('-tf')) for (const entry of listing) out(entry);
    break;
  case 'hdiutil':
    if (args[0] === 'attach') {
      const mount = args[args.indexOf('-mountpoint') + 1];
      for (const entry of listing) {
        mkdirSync(path.dirname(path.join(mount, entry)), { recursive: true });
        writeFileSync(path.join(mount, entry), '');
      }
    }
    break;
  case 'shasum':
    break;
}
`;
  for (const name of [
    'git',
    'gh',
    'docker',
    'pnpm',
    'unzip',
    'tar',
    'hdiutil',
    'codesign',
    'xcrun',
  ])
    await writeFile(path.join(bin, name), program, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    CALL_LOG: log,
    ...extra,
  };
  // The real shasum is wanted, not the stub above.
  await rm(path.join(bin, 'shasum'), { force: true });
  async function calls(): Promise<{ tool: string; args: string[]; cwd: string }[]> {
    try {
      return (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { tool: string; args: string[]; cwd: string });
    } catch {
      return [];
    }
  }
  const run = (args: string[], more: Record<string, string | undefined> = {}) =>
    exec('bash', [path.join(folder, 'scripts/release.sh'), ...args], {
      cwd: folder,
      env: { ...env, ...more },
    });
  return { folder, run, calls };
}

const SIGNING = {
  APPLE_SIGNING_IDENTITY: 'Developer ID Application: Test (TEAM123456)',
  APPLE_API_KEY: `/keys/${SECRET}.p8`,
  APPLE_API_KEY_ID: SECRET,
  APPLE_API_ISSUER: SECRET,
};
const blankSigning = Object.fromEntries(
  [
    'APPLE_SIGNING_IDENTITY',
    'APPLE_API_KEY',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
    'APPLE_ID',
    'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_TEAM_ID',
    'CORRALLM_DISTRIBUTION',
    'CORRALLM_UNSIGNED',
    'CORRALLM_E2E_BUILD',
  ].map((name) => [name, undefined]),
) as Record<string, string | undefined>;

describe('a dry run', { timeout: 60_000 }, () => {
  it('builds in a clone, checks the assets, and drafts nothing, with no gh call', async () => {
    const { folder, run, calls } = await fixture();
    const { stdout } = await run(['--dry-run', '0.1.0', 'HEAD'], blankSigning);
    expect(stdout).toContain('Dry run: nothing was uploaded');
    for (const name of assetNames('0.1.0')) expect(stdout).toContain(name);
    const made = await calls();
    expect(made.some(({ tool }) => tool === 'gh')).toBe(false);
    // Built in a clone, with no signing credential passed to the build.
    const make = made.find(({ tool, args }) => tool === 'pnpm' && args[0] === 'make');
    expect(make?.cwd).toMatch(/release-dry-run-[^/]+\/clone$/);
    expect(make?.cwd).toContain('/node_modules/.cache/probes/release-dry-run-');
    expect(made.some(({ tool, args }) => tool === 'git' && args[0] === 'push')).toBe(false);
    expect(made.some(({ tool }) => ['codesign', 'xcrun'].includes(tool))).toBe(false);
    // It checks nothing that needs a Developer ID.
    expect(made.some(({ args }) => args.includes('--release'))).toBe(false);
    // The kept assets are the exact set, and SHA256SUMS passes sha256sum -c.
    const probes = path.join(folder, 'node_modules/.cache/probes');
    const [kept] = (await readdir(probes)).filter((name) => name.startsWith('release-dry-run-'));
    const assets = path.join(probes, kept ?? '', 'assets');
    expect((await readdir(assets)).sort()).toEqual(assetNames('0.1.0'));
    await exec('shasum', ['-a', '256', '-c', 'SHA256SUMS'], { cwd: assets });
    // The clone is gone.
    await expect(readdir(path.join(probes, kept ?? '', 'clone'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('allows a commit off main', async () => {
    const { run } = await fixture();
    await run(['--dry-run', '0.1.0', 'HEAD'], { ...blankSigning, OFF_MAIN: '1' });
  });

  it.each(['--upload', '--publish', '--draft=false', '--release'])('refuses %s', async (flag) => {
    const { run, calls } = await fixture();
    await expect(run(['--dry-run', flag, '0.1.0', 'HEAD'])).rejects.toMatchObject({ code: 2 });
    expect(await calls()).toEqual([]);
  });

  it.each([
    ['an audit advisory', { ADVISORIES: '2' }, /advisories/],
    ['a version other than package.json’s', { PACKAGE_VERSION: '0.2.0' }, /package\.json/],
    ['Docker not running', { DOCKER_DOWN: '1' }, /Docker/],
    ['a hosted distribution', { CORRALLM_DISTRIBUTION: 'hosted' }, /CORRALLM_DISTRIBUTION/],
  ])('refuses %s, before building where it can', async (_name, change, message) => {
    const { run, calls } = await fixture();
    await expect(
      run(['--dry-run', '0.1.0', 'HEAD'], { ...blankSigning, ...change }),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(message) as string,
    });
    expect((await calls()).some(({ tool, args }) => tool === 'pnpm' && args[0] === 'make')).toBe(
      false,
    );
  });

  it('fails on a credential-like file in an asset, naming it', async () => {
    const { run } = await fixture();
    await expect(
      run(['--dry-run', '0.1.0', 'HEAD'], { ...blankSigning, LISTING_EXTRA: './Resources/.env' }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('.env') as string });
  });

  it('fails on a credential-like file in app.asar, naming it', async () => {
    const { run } = await fixture();
    await expect(
      run(['--dry-run', '0.1.0', 'HEAD'], { ...blankSigning, LISTING_EXTRA: '/config/key.pem' }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining('key.pem') as string });
  });

  it('fails on a missing notice, naming it', async () => {
    const { run } = await fixture();
    await expect(
      run(['--dry-run', '0.1.0', 'HEAD'], {
        ...blankSigning,
        LISTING_DROP: 'THIRD-PARTY-NOTICES.txt',
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('THIRD-PARTY-NOTICES.txt') as string,
    });
  });
});

describe('a real run', { timeout: 60_000 }, () => {
  it('refuses, before building, without the signing and notarization variables', async () => {
    const { run, calls } = await fixture();
    await expect(run(['0.1.0', 'HEAD'], blankSigning)).rejects.toMatchObject({
      stderr: expect.stringContaining('APPLE_SIGNING_IDENTITY') as string,
    });
    const made = await calls();
    expect(made.some(({ tool, args }) => tool === 'git' && args[0] === 'clone')).toBe(false);
    expect(
      made.some(({ tool, args }) => tool === 'gh' && args[0] === 'release' && args[1] === 'create'),
    ).toBe(false);
  });

  it.each([
    ['a commit off main', { OFF_MAIN: '1' }, /not on origin\/main/],
    ['an existing release', { RELEASE_EXISTS: '1' }, /already exists/],
    ['a failing CI job', { CI_FAILS: 'ubuntu-24.04-arm' }, /ubuntu-24\.04-arm/],
  ])('refuses %s, before building', async (_name, change, message) => {
    const { run, calls } = await fixture();
    await expect(
      run(['0.1.0', 'HEAD'], { ...blankSigning, ...SIGNING, ...change }),
    ).rejects.toMatchObject({
      stderr: expect.stringMatching(message) as string,
    });
    expect((await calls()).some(({ tool, args }) => tool === 'git' && args[0] === 'clone')).toBe(
      false,
    );
  });

  it('makes a draft, and only a draft, without echoing or writing a credential', async () => {
    const { folder, run, calls } = await fixture();
    const temporary = path.join(folder, 'tmp');
    await mkdir(temporary);
    const { stdout, stderr } = await run(['0.1.0', 'HEAD'], {
      ...blankSigning,
      ...SIGNING,
      TMPDIR: temporary,
    });
    const made = await calls();
    const gh = made.filter(({ tool }) => tool === 'gh');
    // The facts are read before the build and again after the audit; the draft comes last, once.
    const kinds = gh.map(({ args }) => (args[0] === 'api' ? 'api' : args.slice(0, 2).join(' ')));
    expect(kinds.slice(0, -1).every((kind) => kind === 'api' || kind === 'release view')).toBe(
      true,
    );
    expect(kinds.at(-1)).toBe('release create');
    expect(kinds.filter((kind) => kind === 'release create')).toHaveLength(1);
    const create = gh.at(-1)?.args ?? [];
    expect(create).toEqual(
      expect.arrayContaining([
        'v0.1.0',
        '--draft',
        '--target',
        COMMIT,
        '--title',
        'corrallm 0.1.0',
      ]),
    );
    expect(create).not.toContain('--prerelease');
    expect(create).toContain('--generate-notes');
    const attached = create
      .filter((arg) => arg.includes('/assets/'))
      .map((arg) => path.basename(arg));
    expect(attached.sort()).toEqual(assetNames('0.1.0'));
    // The dmg is signed with the identity, notarized and stapled; the release check runs on it.
    expect(made.some(({ tool, args }) => tool === 'codesign' && args.includes('--timestamp'))).toBe(
      true,
    );
    expect(made.some(({ tool, args }) => tool === 'xcrun' && args[0] === 'notarytool')).toBe(true);
    expect(made.some(({ tool, args }) => tool === 'xcrun' && args[0] === 'stapler')).toBe(true);
    // Nothing is pushed, and the checkout itself is never built in.
    expect(made.some(({ tool, args }) => tool === 'git' && args.includes('push'))).toBe(false);
    for (const { tool, args, cwd } of made)
      if (tool === 'pnpm' && args[0] !== 'audit') expect(cwd).not.toBe(folder);
    // No credential's value reaches the output or any file.
    expect(stdout + stderr).not.toContain(SECRET);
    const files = await readdir(folder, { recursive: true });
    for (const file of files) {
      if (file.startsWith('bin') || file.endsWith('calls.jsonl')) continue;
      const bytes = await readFile(path.join(folder, file)).catch(() => Buffer.alloc(0));
      expect(bytes.toString('latin1'), file).not.toContain(SECRET);
    }
    // The temporary clone and folders are removed.
    expect(await readdir(temporary)).toEqual([]);
  });

  it('makes a beta a prerelease, with the notes file it is given', async () => {
    const { run, calls } = await fixture({ PACKAGE_VERSION: '0.1.0-beta.1' });
    await run(['--notes-file', '/notes/by-hand.md', '0.1.0-beta.1', 'HEAD'], {
      ...blankSigning,
      ...SIGNING,
    });
    const create = (await calls()).find(({ tool, args }) => tool === 'gh' && args[1] === 'create');
    expect(create?.args).toEqual(
      expect.arrayContaining(['--prerelease', '--notes-file', '/notes/by-hand.md']),
    );
    expect(create?.args).not.toContain('--generate-notes');
  });
});
