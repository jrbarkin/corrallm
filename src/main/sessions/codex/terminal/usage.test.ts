import { describe, expect, it } from 'vitest';

import { property } from '../../transcript';
import { recordedResult } from '../app-server/recorded';
import type { AppServer, AppServerOptions } from '../rpc';
import { UsageReader } from './usage';

const CONTEXT = { codex: '/bin/codex', cwd: '/work/shop', env: { PATH: '/usr/bin' } };
/** When the recording was made (its weekly window resets six days later). */
const NOW = 1_791_880_000_000;

/** A fake app server start: answers account/rateLimits/read with `answer`; counts what it did. */
function fakeStart(answer: () => Promise<unknown>) {
  const calls = { starts: [] as AppServerOptions[], asked: [] as string[], closed: 0 };
  const start = (options: AppServerOptions): Promise<AppServer> => {
    calls.starts.push(options);
    return Promise.resolve({
      userAgent: 'corrallm/0.160.1',
      version: '0.160.1',
      codexHome: '/home/user/.codex',
      request: (method: string) => {
        calls.asked.push(method);
        return method === 'account/rateLimits/read' ? answer() : Promise.reject(new Error(method));
      },
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

/** What the real app server answered on a ChatGPT (Plus) login. */
const READ = () => Promise.resolve(recordedResult('handshake', 'account/rateLimits/read'));

describe('reading Codex’s usage for a Terminal session', () => {
  it('asks a private app server for its limits only, then closes it', async () => {
    const { start, calls } = fakeStart(READ);
    const reader = new UsageReader({ start, now: () => NOW });
    expect(await reader.read(CONTEXT)).toEqual({
      windows: {
        fiveHour: { usedPercent: 0, resetsAt: 1_791_896_263_000 },
        weekly: { usedPercent: 0, resetsAt: 1_792_483_063_000 },
      },
    });
    // The user's own `codex`, in the project folder, with the agents' environment; nothing else.
    expect(calls.starts).toEqual([
      expect.objectContaining({ codex: '/bin/codex', cwd: '/work/shop', env: CONTEXT.env }),
    ]);
    expect(calls.starts[0]?.args ?? []).toEqual([]);
    expect(calls.asked).toEqual(['account/rateLimits/read']);
    expect(calls.closed).toBe(1);
  });

  it('reads once at a time: what is asked meanwhile is read once more, after', async () => {
    const answers: (() => void)[] = [];
    const { start, calls } = fakeStart(
      () =>
        new Promise((resolve) => {
          answers.push(() => {
            void READ().then(resolve);
          });
        }),
    );
    const reader = new UsageReader({ start, now: () => NOW });
    const first = reader.read(CONTEXT);
    const second = reader.read(CONTEXT);
    const third = reader.read(CONTEXT);
    await expect.poll(() => answers.length).toBe(1);
    answers[0]?.();
    expect(await first).toBeDefined();
    // The two asked while it read share the next reading.
    await expect.poll(() => answers.length).toBe(2);
    answers[1]?.();
    expect(await second).toEqual(await third);
    expect(calls.starts).toHaveLength(2);
    expect(calls.closed).toBe(2);
  });

  it('says until when its plan is used up, where a window is and no credits let Codex go on', async () => {
    const snapshot = property(await READ(), 'rateLimits') as Record<string, unknown>;
    const primary = property(snapshot, 'primary') as Record<string, unknown>;
    const { start } = fakeStart(() =>
      Promise.resolve({ rateLimits: { ...snapshot, primary: { ...primary, usedPercent: 100 } } }),
    );
    expect(await new UsageReader({ start, now: () => NOW }).read(CONTEXT)).toEqual({
      windows: {
        fiveHour: { usedPercent: 100, resetsAt: 1_791_896_263_000 },
        weekly: { usedPercent: 0, resetsAt: 1_792_483_063_000 },
      },
      usedUp: 1_791_896_263_000,
    });
  });

  it('says nothing when Codex cannot say (another login, no app server, too slow)', async () => {
    const refused = fakeStart(() => Promise.reject(new Error('not logged in with ChatGPT')));
    expect(await new UsageReader({ start: refused.start }).read(CONTEXT)).toBeUndefined();
    expect(refused.calls.closed).toBe(1);

    const none = new UsageReader({ start: () => Promise.reject(new Error('no codex')) });
    expect(await none.read(CONTEXT)).toBeUndefined();

    const slow = fakeStart(() => new Promise(() => undefined));
    expect(await new UsageReader({ start: slow.start, readMs: 20 }).read(CONTEXT)).toBeUndefined();
    expect(slow.calls.closed).toBe(1);

    // An API key has no plan limits: Codex answers with none.
    const apiKey = fakeStart(() => Promise.resolve({ rateLimits: null }));
    expect(await new UsageReader({ start: apiKey.start }).read(CONTEXT)).toBeUndefined();
  });
});
