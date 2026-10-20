import { describe, expect, it } from 'vitest';

import { recordedResult } from './app-server/recorded';
import { codexOptions } from './options';
import type { AppServer, AppServerOptions } from './rpc';

const CONTEXT = { codex: '/bin/codex', cwd: '/work/smoke/p2', env: { PATH: '/usr/bin' } };

/** A fake app server start, answering as `answers` say; it counts what it was asked. */
function fakeStart(answers: Record<string, () => Promise<unknown>>) {
  const calls = {
    starts: [] as AppServerOptions[],
    asked: [] as { method: string; params: unknown }[],
    closed: 0,
  };
  const start = (options: AppServerOptions): Promise<AppServer> => {
    calls.starts.push(options);
    return Promise.resolve({
      userAgent: 'corrallm/0.160.1',
      version: '0.160.1',
      codexHome: '/home/user/.codex',
      request: (method: string, params?: unknown) => {
        calls.asked.push({ method, params });
        return answers[method]?.() ?? Promise.reject(new Error(method));
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

/** What the real app server answered (Codex 0.160.1, a ChatGPT Plus login). */
const RECORDED = {
  'config/read': () => Promise.resolve(recordedResult('options', 'config/read')),
  'model/list': () => Promise.resolve(recordedResult('options', 'model/list')),
};

/** A config/read answer whose config is `config` (what corrallm reads of it). */
const config = (values: Record<string, unknown>) => () =>
  Promise.resolve({
    config: {
      model: null,
      approval_policy: null,
      sandbox_mode: null,
      model_reasoning_effort: null,
      ...values,
    },
    origins: {},
    layers: null,
  });

describe('codexOptions', () => {
  it('lists Codex’s models and the user’s own defaults, from a private app server, then closes it', async () => {
    const { start, calls } = fakeStart(RECORDED);
    const { models, defaults } = await codexOptions(CONTEXT, { start });
    expect(models.map((m) => m.value)).toEqual([
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
    expect(models[0]).toMatchObject({ label: 'GPT-6.1-Sol', defaultEffort: 'low' });
    for (const model of models)
      for (const effort of model.efforts ?? []) {
        expect(typeof effort.label).toBe('string');
        expect(effort.label.trim()).not.toBe('');
      }
    expect(models[3]?.efforts?.map((e) => e.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    // Their config.toml's model and effort; no sandbox or approval set: Codex's Default.
    expect(defaults).toEqual({ model: 'gpt-6.1-sol', effort: 'max', mode: 'auto', asks: true });

    // The user's own codex, in the project folder, trusted for this server alone (as their
    // Terminal session trusts it, so its config is what that session gets).
    expect(calls.starts).toEqual([
      expect.objectContaining({ codex: '/bin/codex', cwd: '/work/smoke/p2', env: CONTEXT.env }),
    ]);
    expect(calls.starts[0]?.args).toEqual([
      '-c',
      'projects={"/work/smoke/p2"={trust_level="trusted"}}',
    ]);
    // Nothing but its config and its models: no thread, no prompt.
    expect(calls.asked.map((ask) => ask.method).sort()).toEqual(['config/read', 'model/list']);
    expect(calls.asked.find((ask) => ask.method === 'config/read')?.params).toEqual({
      cwd: '/work/smoke/p2',
    });
    expect(calls.closed).toBe(1);
  });

  it('takes Codex’s default model where the config sets none; its effort is then the model’s', async () => {
    const { start } = fakeStart({ ...RECORDED, 'config/read': config({}) });
    expect((await codexOptions(CONTEXT, { start })).defaults).toEqual({
      model: 'gpt-6.1-sol',
      effort: null,
      mode: 'auto',
      asks: true,
    });
  });

  it('says the mode the config’s sandbox and approvals make', async () => {
    const mode = async (values: Record<string, unknown>) => {
      const { start } = fakeStart({ ...RECORDED, 'config/read': config(values) });
      return (await codexOptions(CONTEXT, { start })).defaults.mode;
    };
    expect(await mode({ sandbox_mode: 'read-only' })).toBe('read-only');
    expect(await mode({ sandbox_mode: 'workspace-write', approval_policy: 'on-request' })).toBe(
      'auto',
    );
    expect(await mode({ sandbox_mode: 'danger-full-access', approval_policy: 'never' })).toBe(
      'full-access',
    );
    // Neither of Codex's presets: none of corrallm's.
    expect(await mode({ sandbox_mode: 'danger-full-access', approval_policy: 'untrusted' })).toBe(
      null,
    );
  });

  it('says whether the config’s sandbox and approvals ask before acting, where it can tell', async () => {
    const asks = async (values: Record<string, unknown>) => {
      const { start } = fakeStart({ ...RECORDED, 'config/read': config(values) });
      return (await codexOptions(CONTEXT, { start })).defaults.asks;
    };
    // Codex's Default, set or not: a sandbox of the project folder, asking on request.
    expect(await asks({})).toBe(true);
    expect(await asks({ sandbox_mode: 'workspace-write', approval_policy: 'on-request' })).toBe(
      true,
    );
    expect(await asks({ sandbox_mode: 'read-only', approval_policy: 'on-failure' })).toBe(true);
    expect(await asks({ sandbox_mode: 'danger-full-access', approval_policy: 'untrusted' })).toBe(
      true,
    );
    // Never asking, in a sandbox or not; or no sandbox, so nothing ever needs asking about.
    expect(await asks({ approval_policy: 'never' })).toBe(false);
    expect(await asks({ sandbox_mode: 'read-only', approval_policy: 'never' })).toBe(false);
    expect(await asks({ sandbox_mode: 'danger-full-access', approval_policy: 'on-failure' })).toBe(
      false,
    );
    expect(await asks({ sandbox_mode: 'danger-full-access' })).toBe(false);
    // Settings it doesn't know: it can't tell.
    expect(await asks({ approval_policy: { granular: { sandbox_approval: true } } })).toBe(
      undefined,
    );
    expect(await asks({ sandbox_mode: 'external-sandbox' })).toBe(undefined);
  });

  it('can’t tell whether the user’s default asks when Codex can’t read its config', async () => {
    const { start } = fakeStart({
      ...RECORDED,
      'config/read': () => Promise.reject(new Error('no config')),
    });
    const { defaults } = await codexOptions(CONTEXT, { start });
    expect(defaults.mode).toBeNull();
    expect(defaults).not.toHaveProperty('asks');
  });

  it('fails, saying so, when Codex cannot list its models', async () => {
    const { start, calls } = fakeStart({ 'config/read': config({}) });
    await expect(codexOptions(CONTEXT, { start })).rejects.toThrow(/Codex/);
    expect(calls.closed).toBe(1);
  });
});
