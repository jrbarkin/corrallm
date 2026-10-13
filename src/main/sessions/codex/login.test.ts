import { describe, expect, it } from 'vitest';

import { appServerRefusal, codexLogin } from './login';

describe('the Codex login', () => {
  it('reads what account/read says (as the real app server said it)', () => {
    expect(
      codexLogin({
        account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
        requiresOpenaiAuth: true,
      }),
    ).toEqual({ kind: 'chatgpt', plan: 'plus' });
    expect(codexLogin({ account: { type: 'apiKey' }, requiresOpenaiAuth: true })).toEqual({
      kind: 'apiKey',
    });
    expect(codexLogin({ account: null, requiresOpenaiAuth: true, workspaceRouting: null })).toEqual(
      { kind: 'none' },
    );
    // A provider that needs no OpenAI login (a local model, Bedrock) is logged in its own way.
    expect(codexLogin({ account: null, requiresOpenaiAuth: false })).toEqual({
      kind: 'other',
      type: 'provider',
    });
    expect(codexLogin({ account: { type: 'amazonBedrock' } })).toEqual({
      kind: 'other',
      type: 'amazonBedrock',
    });
    expect(codexLogin('nonsense')).toEqual({ kind: 'none' });
  });

  it('runs the App Server connection on an API key, not on a ChatGPT plan', () => {
    expect(appServerRefusal({ kind: 'apiKey' })).toBeUndefined();
    expect(appServerRefusal({ kind: 'other', type: 'amazonBedrock' })).toBeUndefined();
    expect(appServerRefusal({ kind: 'chatgpt', plan: 'plus' })).toMatch(
      /ChatGPT.*Terminal.*codex login --with-api-key/s,
    );
    expect(appServerRefusal({ kind: 'none' })).toMatch(/isn't logged in.*codex login/s);
  });
});
