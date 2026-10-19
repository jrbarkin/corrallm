import path from 'node:path';

import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { PlanMode, SessionEvent } from '../../../../shared/session';
import { alwaysWording, DENIED, Prompts } from './prompts';
import { RECORDED_PLACES, recorded } from './recorded';
import type { Fixture, RecordedRequest } from './recorded';

/** The permission requests the real CLI made in a recorded session, in order. */
function requests(fixture: Fixture): RecordedRequest[] {
  return recorded(fixture).flatMap((item) => (item.kind === 'canUseTool' ? [item.data] : []));
}

function prompts() {
  const events: SessionEvent[] = [];
  const planApproved = vi.fn<(mode: PlanMode) => void>();
  const asking = new Prompts(
    { emit: (event) => events.push(event), planApproved },
    RECORDED_PLACES,
  );
  /** Asks as the CLI did in `request`; resolves with what the CLI is told. */
  const ask = (request: RecordedRequest, signal = new AbortController().signal) =>
    asking.canUseTool(request.tool, request.input, {
      ...(request.opts as { toolUseID: string; requestId: string }),
      signal,
    });
  return { asking, events, planApproved, ask };
}

describe('Prompts, on the real CLI’s permission requests', () => {
  it('asks before a file is written, offering what the CLI offers for "always"', async () => {
    const [write] = requests('tools-and-compact');
    if (!write) throw new Error('no request');
    const { asking, events, ask } = prompts();
    const told = ask(write);
    expect(events).toEqual([
      {
        type: 'permission',
        id: 'toolu_01BcsAQYMNM52sfGgGbPDfjx:prompt',
        tool: 'Write',
        summary: 'notes.txt',
        always: 'Yes, allow all edits during this session',
        detail: { kind: 'diff', added: 1, removed: 0, lines: [{ kind: 'add', text: 'one' }] },
      },
      { type: 'status', status: 'waiting' },
    ]);
    expect(asking.waiting).toBe(true);

    asking.answer('toolu_01BcsAQYMNM52sfGgGbPDfjx:prompt', {
      kind: 'permission',
      answer: 'always',
    });
    // As the CLI was told, recorded: allowed, with its own suggestion kept.
    expect(await told).toMatchObject({
      behavior: 'allow',
      updatedInput: write.input,
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
    expect(events.at(-1)).toEqual({ type: 'status', status: 'working' });
    expect(asking.waiting).toBe(false);
  });

  it('allows once without keeping anything, and denies by stopping the turn, as the CLI does', async () => {
    const [write] = requests('tools-and-compact');
    if (!write) throw new Error('no request');
    const { asking, ask } = prompts();

    const once = ask(write);
    asking.answer('toolu_01BcsAQYMNM52sfGgGbPDfjx:prompt', { kind: 'permission', answer: 'once' });
    const allowed = await once;
    expect(allowed).toMatchObject({ behavior: 'allow', updatedInput: write.input });
    expect(allowed).not.toHaveProperty('updatedPermissions');

    const no = ask(write);
    asking.answer('toolu_01BcsAQYMNM52sfGgGbPDfjx:prompt', { kind: 'permission', answer: 'deny' });
    expect(await no).toMatchObject({ behavior: 'deny', message: DENIED, interrupt: true });
  });

  it('asks AskUserQuestion’s questions, and gives the CLI the answers by question', async () => {
    const [question] = requests('question-and-plan');
    if (!question) throw new Error('no request');
    const { asking, events, ask } = prompts();
    const told = ask(question);
    expect(events[0]).toEqual({
      type: 'question',
      id: 'toolu_01KfF8V1ijeyNsPd8vxDjdCn:prompt',
      questions: [
        {
          header: 'File name',
          text: 'Should the new file be named a.txt or b.txt?',
          options: [
            { label: 'a.txt', description: 'Create a.txt' },
            { label: 'b.txt', description: 'Create b.txt' },
          ],
          multiple: false,
        },
      ],
    });
    asking.answer('toolu_01KfF8V1ijeyNsPd8vxDjdCn:prompt', {
      kind: 'question',
      answers: ['a.txt'],
    });
    // Exactly as the CLI took it, recorded.
    const result = recorded('question-and-plan').find((item) => item.kind === 'canUseToolResult');
    expect(await told).toEqual(result?.data);
  });

  it('shows the plan to approve, carried out in the mode chosen; or keeps planning', async () => {
    const plan = requests('question-and-plan').find((request) => request.tool === 'ExitPlanMode');
    if (!plan) throw new Error('no request');
    const { asking, events, planApproved, ask } = prompts();

    const approved = ask(plan);
    expect(events[0]).toMatchObject({ type: 'plan', id: 'toolu_014GtCEwwsqinMn1txjtWDeb:prompt' });
    expect(events[0]).toHaveProperty('plan', expect.stringMatching(/^# Plan\n\n## Context/));
    asking.answer('toolu_014GtCEwwsqinMn1txjtWDeb:prompt', {
      kind: 'plan',
      answer: { approve: true, mode: 'acceptEdits' },
    });
    expect(await approved).toEqual({ behavior: 'allow', updatedInput: plan.input });
    expect(planApproved).toHaveBeenCalledWith('acceptEdits');

    const again = ask(plan);
    asking.answer('toolu_014GtCEwwsqinMn1txjtWDeb:prompt', {
      kind: 'plan',
      answer: { approve: false, feedback: 'Name it c.txt' },
    });
    expect(await again).toMatchObject({
      behavior: 'deny',
      message: expect.stringMatching(/keep planning.*Name it c\.txt/) as unknown,
    });
    expect(planApproved).toHaveBeenCalledTimes(1);
  });

  it('withdraws a prompt the CLI stops waiting for, as when the turn is interrupted', async () => {
    const [write] = requests('tools-and-compact');
    if (!write) throw new Error('no request');
    const { asking, events, ask } = prompts();
    const abort = new AbortController();
    const told = ask(write, abort.signal);
    abort.abort();
    expect(await told).toMatchObject({ behavior: 'deny' });
    expect(events.slice(-2)).toEqual([
      { type: 'withdrawn', id: 'toolu_01BcsAQYMNM52sfGgGbPDfjx:prompt' },
      { type: 'status', status: 'working' },
    ]);
    expect(() => {
      asking.answer('toolu_01BcsAQYMNM52sfGgGbPDfjx:prompt', {
        kind: 'permission',
        answer: 'once',
      });
    }).toThrow(/no longer asked/);
  });
});

describe('alwaysWording', () => {
  const rules = (destination: PermissionUpdate['destination'], ...ruleContent: string[]) => [
    {
      type: 'addRules' as const,
      behavior: 'allow' as const,
      destination,
      rules: ruleContent.map((content) => ({ toolName: 'Bash', ruleContent: content })),
    },
  ];

  it('words what "always" keeps as Claude Code does', () => {
    expect(alwaysWording(rules('localSettings', 'npm test:*'), RECORDED_PLACES)).toBe(
      "Yes, and don't ask again for `npm test` commands in shop",
    );
    expect(alwaysWording(rules('userSettings', 'ls -la'), RECORDED_PLACES)).toBe(
      "Yes, and don't ask again for `ls -la` anywhere",
    );
    expect(
      alwaysWording(
        [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }],
          },
        ],
        RECORDED_PLACES,
      ),
    ).toBe("Yes, and don't ask again for fetches from example.com during this session");
    expect(
      alwaysWording(
        [{ type: 'addDirectories', directories: ['/home/user/docs'], destination: 'session' }],
        RECORDED_PLACES,
      ),
    ).toBe(`Yes, and allow access to ${path.join('~', 'docs')} during this session`);
  });

  it('offers no "always" where the CLI suggests nothing to keep', () => {
    expect(alwaysWording([], RECORDED_PLACES)).toBeNull();
  });

  it('offers none where the CLI says "always" would allow too much', async () => {
    const [write] = requests('tools-and-compact');
    if (!write) throw new Error('no request');
    const { events, ask } = prompts();
    void ask({ ...write, opts: { ...write.opts, suppressAlwaysAllowRule: true } });
    expect(events[0]).toMatchObject({ type: 'permission', always: null });
    await Promise.resolve();
  });
});

describe('Prompts, on MCP servers’ requests (elicitations)', () => {
  /** What an MCP server asks, as the SDK passes it to onElicitation. */
  const form = {
    serverName: 'github',
    message: 'Which repository should the issue go in?',
    mode: 'form' as const,
    requestedSchema: {
      type: 'object',
      properties: { repo: { type: 'string', title: 'Repository' }, draft: { type: 'boolean' } },
      required: ['repo'],
    },
  };
  const elicit = (asking: Prompts, request: Parameters<Prompts['onElicitation']>[0]) =>
    asking.onElicitation(request, { signal: new AbortController().signal, requestId: 'r' });
  const promptOf = (events: SessionEvent[]) => {
    const asked = events.find((e) => e.type === 'elicitation');
    if (asked?.type !== 'elicitation') throw new Error('nothing asked');
    return asked;
  };

  it('asks for a form, and answers with what was filled in, once it is what the form asks', async () => {
    const { asking, events } = prompts();
    const told = elicit(asking, form);
    const asked = promptOf(events);
    expect(asked).toEqual({
      type: 'elicitation',
      id: asked.id,
      server: 'github',
      message: 'Which repository should the issue go in?',
      fields: [
        { name: 'repo', label: 'Repository', required: true, kind: 'text' },
        { name: 'draft', label: 'draft', required: false, kind: 'boolean' },
      ],
    });
    expect(events.at(-1)).toEqual({ type: 'status', status: 'waiting' });
    // Not what the form asks: refused, and it still asks.
    expect(() => {
      asking.answer(asked.id, { kind: 'elicitation', action: 'accept', values: { draft: true } });
    }).toThrow(/Repository is required/);
    expect(asking.waiting).toBe(true);
    asking.answer(asked.id, {
      kind: 'elicitation',
      action: 'accept',
      values: { repo: 'acme/shop', draft: false },
    });
    expect(await told).toEqual({ action: 'accept', content: { repo: 'acme/shop', draft: false } });
    expect(events.at(-1)).toEqual({ type: 'status', status: 'working' });
  });

  it('declines or cancels as the user says, and declines a form it cannot show, saying so', async () => {
    const { asking, events } = prompts();
    const declined = elicit(asking, form);
    asking.answer(promptOf(events).id, { kind: 'elicitation', action: 'decline' });
    expect(await declined).toEqual({ action: 'decline' });

    const strange = await elicit(asking, {
      ...form,
      requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } },
    });
    expect(strange).toEqual({ action: 'decline' });
    expect(events.at(-1)).toMatchObject({
      type: 'notice',
      level: 'warning',
      text: 'github asked for something corrallm can’t show, so it was declined: Which repository should the issue go in?',
    });
  });

  it('asks to open a link for a server, and withdraws a request the CLI stops waiting for', async () => {
    const { asking, events } = prompts();
    const controller = new AbortController();
    const told = asking.onElicitation(
      {
        serverName: 'linear',
        message: 'Sign in to Linear',
        mode: 'url',
        url: 'https://linear.app/oauth?state=1',
        elicitationId: 'e1',
      },
      { signal: controller.signal, requestId: 'r' },
    );
    const asked = promptOf(events);
    expect(asked).toMatchObject({
      server: 'linear',
      message: 'Sign in to Linear',
      url: 'https://linear.app/oauth?state=1',
    });
    controller.abort();
    expect(await told).toEqual({ action: 'cancel' });
    expect(events).toContainEqual({ type: 'withdrawn', id: asked.id });
  });
});
