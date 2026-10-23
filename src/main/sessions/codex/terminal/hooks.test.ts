import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HOOK_HEADER, HOOK_TOKEN, HookServer } from '../../terminal/hooks';
import type { HookEvent, HookRegistration } from '../../terminal/hooks';
import {
  computedTrust,
  hookCommand,
  hookHash,
  folderTrust,
  hookOverrides,
  sessionHooks,
  trustOverride,
} from './hooks';
import type { CodexHookEvent } from './hooks';
import { recordedTerminal } from './recorded';

const posix = process.platform !== 'win32';

let dir: string;
let header: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'corrallm-hook-'));
  header = path.join(dir, `header with 'quotes' $dollar % and spaces`);
  await writeFile(header, 'Authorization: Bearer x\n', { mode: 0o600 });
});
let registrations: HookRegistration[] = [];
afterEach(async () => {
  for (const registration of registrations) registration.release();
  registrations = [];
  await rm(dir, { recursive: true, force: true });
});

/** Runs a hook's command as Codex does (with a shell, the event on its stdin). */
function runHook(
  command: string,
  event: string,
  env: Record<string, string>,
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, out });
    });
    child.stdin.end(event);
  });
}

describe('the command a hook runs', () => {
  it.skipIf(!posix)(
    'the e2e TUI trusts and runs the file-backed hooks without a token environment',
    async () => {
      const heard: HookEvent[] = [];
      const registration = await new HookServer().register((event) => heard.push(event));
      registrations.push(registration);
      await writeFile(header, `Authorization: Bearer ${registration.token}\n`);
      const hooks = sessionHooks(registration.url, 'darwin');
      // Pipes suffice for this fake's input parser; no native pty or real CLI in a unit test.
      const child = spawn(
        process.execPath,
        [
          '--import',
          'data:text/javascript,process.stdin.setRawMode=()=>{}',
          path.resolve('e2e/fake-codex-tui.mjs'),
          '-C',
          dir,
          ...hookOverrides(hooks).flatMap((one) => ['-c', one]),
          '-c',
          trustOverride(computedTrust(hooks)),
          '-c',
          folderTrust(dir),
        ],
        {
          cwd: dir,
          env: { PATH: process.env.PATH ?? '', SHELL: '/bin/sh', [HOOK_HEADER]: header },
        },
      );
      const closed = new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('close', () => {
          resolve();
        });
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      try {
        await vi.waitFor(
          () => {
            expect(output).toContain('Ready');
          },
          { timeout: 5000, interval: 10 },
        );
        expect(output).not.toContain('Hooks need review');
        child.stdin.write('hello\r');
        await vi.waitFor(
          () => {
            expect(heard).toContainEqual(
              expect.objectContaining({ hook_event_name: 'UserPromptSubmit', prompt: 'hello' }),
            );
          },
          { timeout: 5000, interval: 10 },
        );
      } finally {
        child.kill('SIGTERM');
        const force = setTimeout(() => {
          child.kill('SIGKILL');
        }, 2000);
        try {
          await closed;
        } finally {
          clearTimeout(force);
        }
      }
    },
    15_000,
  );

  it.skipIf(!posix)(
    'keeps the token out of curl argv and environment, and hides errors',
    async () => {
      const captured = path.join(dir, 'captured.json');
      await writeFile(
        path.join(dir, 'curl'),
        `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.CAPTURE, JSON.stringify({ args: process.argv.slice(2), env: process.env }));
process.stdout.write('unwanted output');
process.stderr.write('unwanted error');
process.exit(9);
`,
        { mode: 0o700 },
      );
      const command = hookCommand('http://127.0.0.1:9/hook', 'linux');
      expect(command).not.toContain(HOOK_TOKEN);
      expect(
        await runHook(command, '{}', { PATH: dir, [HOOK_HEADER]: header, CAPTURE: captured }),
      ).toEqual({ code: 0, out: '' });
      const seen = JSON.parse(await readFile(captured, 'utf8')) as {
        args: string[];
        env: Record<string, string>;
      };
      expect(seen.args).toContain(`@${header}`);
      expect(seen.args.join(' ')).not.toContain('Bearer');
      expect(seen.env).not.toHaveProperty(HOOK_TOKEN);
    },
  );

  it.skipIf(!posix)('posts the event to corrallm’s server with the session’s token', async () => {
    const server = new HookServer();
    const heard: HookEvent[] = [];
    const registration = await server.register((event) => heard.push(event));
    registrations.push(registration);
    await writeFile(header, `Authorization: Bearer ${registration.token}\n`);
    const event = {
      session_id: 's1',
      hook_event_name: 'Stop',
      last_assistant_message: 'It’s “done”',
    };
    const run = await runHook(hookCommand(registration.url, 'darwin'), JSON.stringify(event), {
      [HOOK_HEADER]: header,
    });
    expect(run).toEqual({ code: 0, out: '' });
    expect(heard).toEqual([event]);
  });

  it.skipIf(!posix)(
    'prints nothing and succeeds when corrallm is not there to hear it',
    async () => {
      const run = await runHook(hookCommand('http://127.0.0.1:9/hook', 'linux'), '{}', {
        [HOOK_HEADER]: header,
      });
      expect(run).toEqual({ code: 0, out: '' });
    },
  );

  it('reads a header file on Windows too, without expanding a secret', () => {
    const command = hookCommand('http://127.0.0.1:4000/hook', 'win32');
    expect(command).toContain(`-H "@%${HOOK_HEADER}%"`);
    expect(command).not.toContain(HOOK_TOKEN);
    expect(command).toContain('--max-time 5');
    expect(command).toContain('exit /b 0');
    expect(command).toMatch(/^curl\.exe /);
    expect(command).not.toContain('secret');
  });
});

describe('a session’s hooks, as overrides', () => {
  it('adds a command hook for each event corrallm follows', () => {
    const hooks = sessionHooks('http://127.0.0.1:4000/hook', 'darwin');
    expect(hooks.map((hook) => hook.event)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'Interrupt',
    ]);
    const [first] = hookOverrides(hooks);
    expect(first).toBe(
      `hooks.SessionStart=[{hooks=[{type="command",command=${JSON.stringify(hooks[0]?.command)},timeout=10}]}]`,
    );
  });

  it('trusts them by the keys and hashes the real Codex trusted', () => {
    // The recording's hooks (another command, and Codex's default timeouts) and their trust.
    const [argv] = recordedTerminal('prompts');
    if (argv?.kind !== 'argv') throw new Error('no argv');
    const values = argv.data.filter((_, i) => argv.data[i - 1] === '-c');
    const recorded = (event: CodexHookEvent) => {
      const value = values.find((one) => one.startsWith(`hooks.${event}=`)) ?? '';
      return JSON.parse(/command=("(?:[^"\\]|\\.)*")/.exec(value)?.[1] ?? '""') as string;
    };
    const hooks = (['UserPromptSubmit', 'Stop', 'Interrupt'] as const).map((event) => ({
      event,
      command: recorded(event),
      timeout: event === 'Interrupt' ? 1 : 600,
    }));
    const state = values.find((value) => value.startsWith('hooks.state='));
    for (const [key, hash] of computedTrust(hooks)) {
      expect(state).toContain(`${JSON.stringify(key)}={trusted_hash="${hash}"}`);
    }
    const stop = hooks.find((hook) => hook.event === 'Stop');
    if (!stop) throw new Error('no Stop hook');
    expect(hookHash(stop)).toBe(
      'sha256:b54a8c4eddb9485fad7fadbc2e8aca5dabfae19495b264c11ad1dbe29916e0d4',
    );
    expect(trustOverride(new Map([['k', 'sha256:1']]))).toBe(
      'hooks.state={"k"={trusted_hash="sha256:1"}}',
    );
  });
});
