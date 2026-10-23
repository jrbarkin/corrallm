import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

async function fixture(arch = 'arm64') {
  const cache = path.join(root, 'node_modules/.cache/probes');
  await mkdir(cache, { recursive: true });
  const folder = await mkdtemp(path.join(cache, 'macos checks '));
  folders.push(folder);
  const script = path.join(folder, 'scripts/check-macos.sh');
  await mkdir(path.dirname(script));
  await copyFile(path.join(root, 'scripts/check-macos.sh'), script);
  const app = path.join(folder, `out/corrallm-darwin-${arch}/corrallm.app`);
  const helper = path.join(
    app,
    `Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-${arch}/spawn-helper`,
  );
  const log = path.join(folder, 'commands.jsonl');
  const program = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const kind = process.argv[1].endsWith('/MacOS/corrallm') ? 'app'
  : process.argv[1].endsWith('/bin/corrallm') ? 'command' : 'codesign';
const args = process.argv.slice(2);
appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ kind, args,
  path: process.env.PATH, selfTest: process.env.CORRALLM_NATIVE_SELFTEST }) + '\\n');
if (process.env.FAIL_CHECK === kind) process.exit(19);
if (kind === 'app' && args.length) {
  process.exit(args[0] === process.env.ACCEPT_SWITCH ? 0 : 1);
}
`;
  for (const file of [
    path.join(folder, 'codesign'),
    path.join(app, 'Contents/MacOS/corrallm'),
    path.join(app, 'Contents/Resources/bin/corrallm'),
    helper,
  ]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, program, { mode: 0o755 });
  }
  const env = { ...process.env, PATH: `${folder}:${process.env.PATH ?? ''}`, COMMAND_LOG: log };
  async function commands(): Promise<
    { kind: string; args: string[]; path: string; selfTest?: string }[]
  > {
    return (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Awaited<ReturnType<typeof commands>>[number]);
  }
  return { folder, script, app, helper, env, commands };
}

it.each(['arm64', 'x64'])(
  'verifies the %s bundle, helper, native self-test, refused switches and shipped command',
  async (arch) => {
    const { script, app, env, commands } = await fixture(arch);
    await exec('bash', [script, arch], { cwd: root, env });
    const calls = await commands();
    expect(calls.map(({ kind, args }) => ({ kind, args }))).toEqual([
      { kind: 'codesign', args: ['--verify', '--deep', '--strict', app] },
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

it('fails on a non-executable spawn-helper before running the app', async () => {
  const { script, helper, env, commands } = await fixture();
  await chmod(helper, 0o644);
  await expect(exec('bash', [script, 'arm64'], { env })).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining('Check node-pty spawn-helper') as string,
  });
  expect((await commands()).map(({ kind }) => kind)).toEqual(['codesign']);
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
