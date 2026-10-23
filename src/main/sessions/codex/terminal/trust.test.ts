import { describe, expect, it } from 'vitest';

import type { AppServer, AppServerOptions } from '../rpc';
import { computedTrust, sessionHooks } from './hooks';
import type { SessionHook } from './hooks';
import { HookTruster, sessionHooksListed } from './trust';

const HOOKS = sessionHooks('http://127.0.0.1:4000/hook', 'darwin');
const CONTEXT = { codex: '/bin/codex', version: '0.160.1', cwd: '/work/shop', env: {} };

/** hooks/list's answer for `hooks` (as Codex 0.160.1 answers it), with `hash` for each. */
function listing(
  hooks: readonly SessionHook[],
  key: (hook: SessionHook) => string,
  hash: (hook: SessionHook) => string,
) {
  return {
    data: [
      {
        cwd: CONTEXT.cwd,
        hooks: [
          // One of the user's own: not corrallm's.
          {
            key: '/home/user/.codex/config.toml:stop:0:0',
            source: 'user',
            command: 'notify',
            currentHash: 'sha256:0',
          },
          ...hooks.map((hook, i) => ({
            key: key(hook),
            eventName: hook.event.charAt(0).toLowerCase() + hook.event.slice(1),
            handlerType: 'command',
            command: hook.command,
            async: false,
            matcher: null,
            timeoutSec: hook.timeout,
            sourcePath: '/<session-flags>/config.toml',
            source: 'sessionFlags',
            displayOrder: i,
            enabled: true,
            isManaged: false,
            currentHash: hash(hook),
            trustStatus: 'untrusted',
          })),
        ],
        warnings: [],
        errors: [],
      },
    ],
  };
}

/** A fake app server start: answers hooks/list with `answer`; counts starts and closes. */
function fakeStart(answer: () => unknown) {
  const calls = { starts: [] as AppServerOptions[], closed: 0 };
  const start = (options: AppServerOptions): Promise<AppServer> => {
    calls.starts.push(options);
    return Promise.resolve({
      userAgent: 'corrallm/0.160.1',
      version: '0.160.1',
      codexHome: '/home/user/.codex',
      request: (method: string) =>
        method === 'hooks/list' ? Promise.resolve(answer()) : Promise.reject(new Error(method)),
      notify: () => undefined,
      close: () => {
        calls.closed += 1;
        return Promise.resolve();
      },
      exited: new Promise(() => undefined),
    });
  };
  return { start, calls };
}

describe('trusting a session’s hooks', () => {
  it('asks Codex once whether corrallm computes their trust as it does', async () => {
    const computed = computedTrust(HOOKS);
    const { start, calls } = fakeStart(() =>
      listing(
        HOOKS,
        (hook) => [...computed.keys()][HOOKS.indexOf(hook)] ?? '',
        (hook) => [...computed.values()][HOOKS.indexOf(hook)] ?? '',
      ),
    );
    const truster = new HookTruster({ start });
    expect(await truster.trust(HOOKS, CONTEXT)).toEqual(computed);
    // Given the same hooks, on the command line.
    expect(calls.starts[0]?.args?.filter((arg) => arg !== '-c')).toHaveLength(4);
    expect(calls.closed).toBe(1);
    expect(await truster.trust(HOOKS, CONTEXT)).toEqual(computed);
    expect(calls.starts).toHaveLength(1);
    // Another Codex is asked too.
    await truster.trust(HOOKS, { ...CONTEXT, version: '0.161.0' });
    expect(calls.starts).toHaveLength(2);
  });

  it('trusts them as Codex says where it says otherwise, and asks it every time', async () => {
    const { start, calls } = fakeStart(() =>
      listing(
        HOOKS,
        (hook) => `C:\\<session-flags>\\config.toml:${hook.event}:0:0`,
        (hook) => `sha256:${hook.event}`,
      ),
    );
    const truster = new HookTruster({ start });
    const trust = await truster.trust(HOOKS, CONTEXT);
    expect(trust.get('C:\\<session-flags>\\config.toml:Stop:0:0')).toBe('sha256:Stop');
    expect(trust.size).toBe(4);
    await truster.trust(HOOKS, CONTEXT);
    expect(calls.starts).toHaveLength(2);
  });

  it('falls back on the computed trust when Codex cannot say', async () => {
    const failing = new HookTruster({ start: () => Promise.reject(new Error('no codex')) });
    expect(await failing.trust(HOOKS, CONTEXT)).toEqual(computedTrust(HOOKS));
    const { start, calls } = fakeStart(() => new Promise(() => undefined));
    const slow = new HookTruster({ start, listMs: 20 });
    expect(await slow.trust(HOOKS, CONTEXT)).toEqual(computedTrust(HOOKS));
    expect(calls.closed).toBe(1);
  });

  it('reads only the session’s own hooks from what Codex lists', () => {
    const answer = listing(
      HOOKS,
      (hook) => `key-${hook.event}`,
      () => 'sha256:x',
    );
    answer.data[0]?.hooks.push({
      key: 'other',
      source: 'sessionFlags',
      command: 'something else',
      currentHash: 'sha256:y',
    });
    const listed = sessionHooksListed(answer, HOOKS);
    expect([...listed.keys()]).toEqual([
      'key-SessionStart',
      'key-UserPromptSubmit',
      'key-Stop',
      'key-Interrupt',
    ]);
    expect(sessionHooksListed(null, HOOKS).size).toBe(0);
  });
});
