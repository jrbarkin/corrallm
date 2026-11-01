import { describe, expect, it } from 'vitest';

import { appServerRefusal, codexLogin, PLAN_DECLINED, planPrompt } from './login';

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

  it('runs the App Server connection on any login of a local build; a ChatGPT one only locally', () => {
    expect(appServerRefusal({ kind: 'apiKey' }, 'local')).toBeUndefined();
    expect(appServerRefusal({ kind: 'other', type: 'amazonBedrock' }, 'hosted')).toBeUndefined();
    // corrallm runs on the user's own computer: OpenAI lets a local app use a ChatGPT login.
    expect(appServerRefusal({ kind: 'chatgpt', plan: 'plus' }, 'local')).toBeUndefined();
    // Built as a commercial or hosted product, it may not.
    for (const distribution of ['commercial', 'hosted'] as const) {
      expect(appServerRefusal({ kind: 'chatgpt', plan: 'plus' }, distribution)).toMatch(
        /commercial or hosted.*Codex · Terminal.*codex login --with-api-key/s,
      );
    }
    expect(appServerRefusal({ kind: 'none' }, 'local')).toMatch(/isn't logged in.*codex login/s);
  });

  it('asks before using a ChatGPT plan, quoting what OpenAI allows and where it says so', () => {
    const prompt = planPrompt('m1:chatgpt-plan', { kind: 'chatgpt', plan: 'plus' });
    expect(prompt).toMatchObject({
      type: 'permission',
      id: 'm1:chatgpt-plan',
      tool: 'ChatGPT plan',
      summary: 'Plus',
      title: 'Use your ChatGPT plan here?',
      always: "Yes, and don't ask again on this computer",
    });
    const said = prompt.detail?.kind === 'output' ? prompt.detail.text : '';
    const unwrapped = said.replace(/\s+/g, ' ');
    expect(unwrapped).toContain(
      '"If you’ve built a local or open-source application using Codex app-server authentication, you can continue using it',
    );
    expect(unwrapped).toContain(
      '"App-server authentication has never been permitted for commercial or hosted services."',
    );
    expect(unwrapped).toContain('learn.chatgpt.com/docs/app-server');
    // It fits the prompt's box: no line scrolls.
    for (const line of said.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
    expect(planPrompt('p', { kind: 'chatgpt', plan: null })).toMatchObject({ summary: 'ChatGPT' });
    expect(PLAN_DECLINED).toMatch(/Codex · Terminal.*codex login --with-api-key/s);
  });
});
