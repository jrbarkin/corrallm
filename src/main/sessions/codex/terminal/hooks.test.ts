import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { HOOK_TOKEN, HookServer } from '../../terminal/hooks';
import type { HookEvent, HookRegistration } from '../../terminal/hooks';
import {
  computedTrust,
  hookCommand,
  hookHash,
  hookOverrides,
  sessionHooks,
  trustOverride,
} from './hooks';
import type { CodexHookEvent } from './hooks';
import { recordedTerminal } from './recorded';

const posix = process.platform !== 'win32';

let registrations: HookRegistration[] = [];
afterEach(() => {
  for (const registration of registrations) registration.release();
  registrations = [];
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
  it.skipIf(!posix)('posts the event to corrallm’s server with the session’s token', async () => {
    const server = new HookServer();
    const heard: HookEvent[] = [];
    const registration = await server.register((event) => heard.push(event));
    registrations.push(registration);
    const event = {
      session_id: 's1',
      hook_event_name: 'Stop',
      last_assistant_message: 'It’s “done”',
    };
    const run = await runHook(hookCommand(registration.url, 'darwin'), JSON.stringify(event), {
      [HOOK_TOKEN]: registration.token,
    });
    expect(run).toEqual({ code: 0, out: '' });
    expect(heard).toEqual([event]);
  });

  it.skipIf(!posix)(
    'prints nothing and succeeds when corrallm is not there to hear it',
    async () => {
      const run = await runHook(hookCommand('http://127.0.0.1:9/hook', 'linux'), '{}', {
        [HOOK_TOKEN]: 'x',
      });
      expect(run).toEqual({ code: 0, out: '' });
    },
  );

  it('reads the token from the environment on Windows too', () => {
    const command = hookCommand('http://127.0.0.1:4000/hook', 'win32');
    expect(command).toContain(`Bearer %${HOOK_TOKEN}%`);
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
