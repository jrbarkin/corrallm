import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it as test, vi } from 'vitest';
const it = test.skipIf(process.platform === 'win32');
import { connectCommand, parseConnect } from './connect';
const git = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: Object.assign(() => undefined, { [Symbol.for('nodejs.util.promisify.custom')]: git }) }));
import { askTokenOwner } from '../core/token-socket';
vi.mock('../core/token-socket', () => ({ askTokenOwner: vi.fn() }));
vi.mock('../sessions/installed', () => ({ installedClis: () => Promise.resolve({}) }));
let home: string;
let folder: string;
let output: string[];
beforeEach(async () => {
  home = await realpath(await mkdtemp(path.join(tmpdir(), 'connect-')));
  folder = path.join(home, 'project');
  await mkdir(folder);
  output = [];
  git.mockResolvedValue({ stdout: '' });
  vi.mocked(askTokenOwner).mockReset();
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});
const run = (env: NodeJS.ProcessEnv = {}) =>
  connectCommand(parseConnect(['--folder', folder]), {
    env,
    cwd: folder,
    home,
    say: (line) => {
      output.push(line);
    },
    loginEnv: {},
  });
it('refuses inside an agent session before contacting an owner', async () => {
  expect(await run({ CORRALLM_AGENT_SESSION: '1' })).toBe(1);
  expect(askTokenOwner).not.toHaveBeenCalled();
});
it('requires an app owner and never issues a credential itself', async () => {
  vi.mocked(askTokenOwner).mockResolvedValue(undefined);
  expect(await run()).toBe(1);
  expect(output.join('\n')).toContain('Open the corrallm app');
});
it('requests the default private file without a TTY and prints only next steps', async () => {
  vi.mocked(askTokenOwner).mockResolvedValue({
    ok: true,
    op: 'connect',
    folder,
    canvas: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    into: path.join(home, '.corrallm', 'project.token'),
    url: 'http://127.0.0.1:47104/mcp',
  });
  expect(await run()).toBe(0);
  expect(askTokenOwner).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      op: 'connect',
      folder,
      into: path.join(home, '.corrallm', 'project.token'),
      timeout: 300,
    }),
    { timeoutMs: 330_000 },
  );
  expect(output.join('\n')).toContain('CORRALLM_OUTSIDE_TOKEN_FILE');
  expect(output.join('\n')).toContain('corrallm agents');
});
it('bounds timeout and strictly parses its paths and flags', () => {
  expect(parseConnect(['--timeout', '3600', '--into', '/safe/file'])).toMatchObject({
    command: 'connect',
    timeout: 3600,
    into: '/safe/file',
  });
  for (const args of [
    ['--timeout', '3601'],
    ['--timeout', '0'],
    ['--timeout', 'NaN'],
    ['--unknown'],
    ['extra'],
  ])
    expect(() => parseConnect(args)).toThrow();
});


it('keeps a Git top-level folder’s trailing space when choosing the default', async () => {
  const project = path.join(home, 'spaced project ');
  await mkdir(project);
  git.mockResolvedValue({ stdout: `${project}\n` });
  vi.mocked(askTokenOwner).mockResolvedValue(undefined);
  await connectCommand(parseConnect([]), { env: {}, cwd: folder, home, say: () => undefined, loginEnv: {} });
  expect(askTokenOwner).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ folder: project, into: path.join(home, '.corrallm', 'spaced project .token') }), expect.any(Object));
});
