import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { appProfile } from '../core/host/node';
import { askTokenOwner } from '../core/token-socket';
import { OPEN_APP } from '../../shared/model/orchestrators';
import { SAFE_GIT_ENV, SAFE_GIT_OPTIONS } from '../git';
import { agentEnvironment, loginShellEnvironment } from '../sessions/environment';
import { installedClis } from '../sessions/installed';
import { CATALOG } from '../sessions/adapters';
import { privateTokenProfile } from '../core/token-profile';
import { helperInvocation, registrationLines, registrations, shellPath } from './register';
import { nameableFile, UsageError } from './args';
import { shown } from './output';

export interface ConnectCommand {
  command: 'connect';
  folder?: string;
  into?: string;
  timeout: number;
}
export function parseConnect(args: readonly string[]): ConnectCommand {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        folder: { type: 'string' },
        into: { type: 'string' },
        timeout: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    throw new UsageError('Use connect [--folder <dir>] [--into <file>] [--timeout <1-3600>].');
  }
  const timeout = values.timeout === undefined ? 300 : Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600)
    throw new UsageError('A connect timeout is 1 to 3600 seconds.');
  for (const value of [values.folder, values.into])
    if (
      value !== undefined &&
      (value === '' || !value.isWellFormed() || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value))
    )
      throw new UsageError('Use a nonempty single-line folder or file path.');
  return {
    command: 'connect',
    timeout,
    ...(values.folder === undefined ? {} : { folder: values.folder }),
    ...(values.into === undefined ? {} : { into: values.into }),
  };
}
/** Only asks for authority. No terminal gate and no unowned issuance path. */
export async function connectCommand(
  command: ConnectCommand,
  io: {
    env: NodeJS.ProcessEnv;
    cwd: string;
    say: (line: string) => void;
    home?: string;
    loginEnv?: Readonly<Record<string, string>>;
    invocation?: { node: string; bundle: string };
    launcher?: string;
  },
): Promise<number> {
  const say = (line: string) => {
    io.say(shown(line));
  };
  if (io.env.CORRALLM_AGENT_SESSION === '1') {
    say('corrallm connect does not run inside a corrallm agent session.');
    return 1;
  }
  try {
    const folder = await realpath(
      command.folder === undefined
        ? await defaultFolder(io.cwd, io.env)
        : path.resolve(io.cwd, command.folder),
    );
    const home = io.home ?? homedir();
    const requested =
      command.into === undefined
        ? path.join(home, '.corrallm', `${path.basename(folder)}.token`)
        : path.resolve(io.cwd, command.into);
    if (!nameableFile(requested))
      throw new Error('Choose a bounded single-line credential-file path.');
    if (command.into === undefined)
      await mkdir(path.dirname(requested), { mode: 0o700, recursive: true });
    const parent = await privateTokenProfile(path.dirname(requested));
    if (parent !== path.dirname(requested))
      throw new Error('Choose the real credential folder without directory links.');
    const into = path.join(parent, path.basename(requested));
    const login = io.loginEnv ?? (await loginShellEnvironment({ env: io.env }));
    const installed = await installedClis(agentEnvironment(login));
    const helper = CATALOG.adapters.some(
      (adapter) => installed[adapter.id] === true && adapter.registerMcpHelper !== undefined,
    )
      ? helperInvocation({
          searchPath: login.PATH ?? '',
          ...(io.launcher === undefined ? {} : { launcher: io.launcher }),
          ...(io.invocation ?? { node: process.execPath, bundle: process.argv[1] ?? '' }),
        })
      : undefined;
    const answer = await askTokenOwner(
      appProfile({ env: io.env }),
      {
        version: 1,
        op: 'connect',
        folder,
        into,
        timeout: command.timeout,
        ...(helper === undefined ? {} : { helperFiles: helper.files }),
        ...(helper?.directories === undefined ? {} : { helperDirectories: helper.directories }),
      },
      { timeoutMs: command.timeout * 1000 + 30_000 },
    );
    if (answer === undefined) {
      say(OPEN_APP);
      return 1;
    }
    if (!answer.ok) {
      say(answer.sentence);
      return 1;
    }
    if (answer.op !== 'connect' || answer.folder !== folder || answer.into !== into)
      throw new Error('The profile owner answered another request.');
    say(
      `Approved for ${folder}. The credential is in its private file; corrallm renews it until you revoke this approval in Settings.`,
    );
    say(`export CORRALLM_OUTSIDE_TOKEN_FILE=${shellPath(into)}`);
    if (answer.url !== null) say(`export CORRALLM_URL=${shellPath(answer.url)}`);
    say(`corrallm agents --canvas ${shellPath(answer.canvas)}`);
    if (answer.url !== null) {
      const { byFile } = registrations(installed, answer.url, into, helper?.command);
      if (byFile.length > 0) {
        say('Optional MCP registration (tools load at session start):');
        for (const line of registrationLines(byFile)) say(line);
        if (helper?.note !== undefined) say(helper.note);
      }
    }
    return 0;
  } catch {
    // Neither raw socket errors nor a credential's contents enter output.
    say(
      'The orchestrator request could not complete. Open the corrallm app and check the folder and private credential location.',
    );
    return 1;
  }
}
async function defaultFolder(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)(
      'git',
      [...SAFE_GIT_OPTIONS, 'rev-parse', '--show-toplevel'],
      {
        cwd,
        timeout: 5000,
        maxBuffer: 16 * 1024,
        env: {
          ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('GIT_'))),
          ...SAFE_GIT_ENV,
        },
      },
    );
    return (stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout) || cwd;
  } catch {
    return cwd;
  }
}
