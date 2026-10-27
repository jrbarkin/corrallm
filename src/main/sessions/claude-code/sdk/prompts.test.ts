import type { ElicitationRequest } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';

import type { PromptEvent } from '../../../../shared/model/prompts';
import type { HostEvent } from '../../connector';
import { DENIED, Prompts } from './prompts';
import { RECORDED_PLACES, recorded } from './recorded';
import type { Fixture, RecordedElicitation, RecordedRequest } from './recorded';

/*
 * The Agent SDK's prompts as B13 C4 raises them: each native request a prompt of the core's
 * owner's under a fresh key, answered or declined only by that key, and ended when the CLI stops
 * waiting or the session closes. Until X10 converts the renderer, each is shown as the events B13
 * replaces too, whose answers reach it only through the owner (`bridge`).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function requests(fixture: Fixture): RecordedRequest[] {
  return recorded(fixture).flatMap((item) => (item.kind === 'canUseTool' ? [item.data] : []));
}
function results(fixture: Fixture): unknown[] {
  return recorded(fixture).flatMap((item) => (item.kind === 'canUseToolResult' ? [item.data] : []));
}
function first(fixture: Fixture, tool?: string): RecordedRequest {
  const found = requests(fixture).find((one) => tool === undefined || one.tool === tool);
  if (!found) throw new Error(`no request in ${fixture}`);
  return found;
}

/** Prompts, with what it says; `decline` stands in for the owner declining a raise as it comes. */
function prompts({ decline }: { decline?: string } = {}) {
  const events: HostEvent[] = [];
  const asking: Prompts = new Prompts(
    {
      emit: (event) => {
        events.push(event);
        if (decline !== undefined && event.type === 'prompt')
          asking.answers.decline(event.key, decline);
      },
    },
    RECORDED_PLACES,
    ['manual', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'],
  );
  const ask = (request: RecordedRequest, signal = new AbortController().signal) =>
    asking.canUseTool(request.tool, request.input, {
      ...(request.opts as { toolUseID: string; requestId: string }),
      signal,
    });
  const elicit = (request: unknown, signal = new AbortController().signal) =>
    asking.onElicitation(request as ElicitationRequest, { signal, requestId: 'r' });
  /** The raises so far, in order. */
  const raised = () => events.filter((event): event is PromptEvent => event.type === 'prompt');
  const key = (index = -1) => {
    const found = raised().at(index);
    if (!found) throw new Error('nothing raised');
    return found.key;
  };
  return { asking, events, ask, elicit, raised, key };
}

describe('Prompts: each native request raised to the core under a fresh key', () => {
  it('raises a recorded permission request, shows it as before, and answers it only by its key', async () => {
    const write = first('tools-and-compact', 'Write');
    const { asking, events, ask, key } = prompts();
    const told = ask(write);
    expect(events).toEqual([
      {
        type: 'prompt',
        key: expect.stringMatching(UUID) as unknown,
        prompt: expect.objectContaining({ kind: 'approval', answerIn: 'api' }) as unknown,
      },
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
    asking.answers.answer(key(), { kind: 'choice', value: 'always' });
    // As the CLI was told, recorded: allowed, with its own suggestion kept.
    expect(await told).toEqual({
      ...(results('tools-and-compact')[0] as object),
      decisionClassification: 'user_permanent',
    });
    expect(events.at(-1)).toEqual({ type: 'status', status: 'working' });
    expect(asking.waiting).toBe(false);
    expect(() => {
      asking.answers.answer(key(), { kind: 'choice', value: 'allow' });
    }).toThrow(/no longer asked/);
  });

  it('gives every request a key of its own, even the same tool call asked again', () => {
    const write = first('tools-and-compact', 'Write');
    const { ask, raised } = prompts();
    void ask(write);
    void ask(write);
    const [one, two] = raised();
    expect(one?.key).not.toBe(two?.key);
  });

  it('refuses an answer the prompt doesn’t offer, and it still waits', async () => {
    const { asking, ask, key } = prompts();
    const told = ask(first('suggestions-and-denials'));
    expect(() => {
      asking.answers.answer(key(), { kind: 'choice', value: 'maybe' });
    }).toThrow(/not offered/);
    expect(asking.waiting).toBe(true);
    asking.answers.answer(key(), { kind: 'choice', value: 'deny' });
    expect(await told).toMatchObject({ behavior: 'deny', message: DENIED, interrupt: true });
  });

  it('declines with the CLI’s nonapproval, never stopping the turn, and stops showing it', async () => {
    const { asking, events, ask, key } = prompts();
    const told = ask(first('ask-rule'));
    asking.answers.decline(key(), 'corrallm declined this request: too many wait.');
    expect(await told).toEqual({
      behavior: 'deny',
      message: 'corrallm declined this request: too many wait.',
    });
    expect(events.slice(-2)).toEqual([
      { type: 'withdrawn', id: 'toolu_01FZuzydzUtCanydjC5wcg2G:prompt' },
      { type: 'status', status: 'working' },
    ]);
    // Declining one no longer asked does nothing, and never throws.
    asking.answers.decline(key(), 'again');
    expect(events.filter((event) => event.type === 'withdrawn')).toHaveLength(1);
  });

  it('shows nothing of a request the core declines as it is raised', async () => {
    const { events, ask } = prompts({ decline: 'corrallm declined this request: no.' });
    expect(await ask(first('ask-rule'))).toEqual({
      behavior: 'deny',
      message: 'corrallm declined this request: no.',
    });
    expect(events.map((event) => event.type)).toEqual(['prompt']);
  });

  it('ends a request the CLI stops waiting for, as when the turn is interrupted', async () => {
    const { asking, events, ask, key } = prompts();
    const abort = new AbortController();
    const told = ask(first('tools-and-compact', 'Write'), abort.signal);
    abort.abort();
    expect(await told).toMatchObject({ behavior: 'deny' });
    expect(events.slice(-3)).toEqual([
      { type: 'prompt-ended', key: key(), reason: 'withdrawn' },
      { type: 'withdrawn', id: 'toolu_01BcsAQYMNM52sfGgGbPDfjx:prompt' },
      { type: 'status', status: 'working' },
    ]);
    expect(() => {
      asking.answers.answer(key(), { kind: 'choice', value: 'allow' });
    }).toThrow(/no longer asked/);
  });

  it('answers everything still waiting with its nonapproval as the session closes, ending each', async () => {
    const { asking, events, ask, elicit, raised } = prompts();
    const tool = ask(first('ask-rule'));
    const form = elicit(
      recorded('mcp-elicitations').find((item) => item.kind === 'elicitation')?.data.request,
    );
    asking.withdrawAll();
    expect(await tool).toEqual({ behavior: 'deny', message: expect.any(String) as unknown });
    expect(await form).toEqual({ action: 'cancel' });
    expect(events.filter((event) => event.type === 'prompt-ended')).toEqual(
      raised().map(({ key }) => ({ type: 'prompt-ended', key, reason: 'withdrawn' })),
    );
    expect(asking.waiting).toBe(false);
  });

  it('asks the recorded question and plan, answering each as the CLI took it', async () => {
    const { asking, ask, key, raised } = prompts();
    const question = ask(first('question-and-plan', 'AskUserQuestion'));
    expect(raised().at(-1)?.prompt.kind).toBe('question');
    asking.answers.answer(key(), { kind: 'questions', answers: { q1: { picked: ['a.txt'] } } });
    expect(await question).toEqual(results('question-and-plan')[0]);

    const plan = ask(first('plan-into-mode'));
    expect(raised().at(-1)?.prompt.kind).toBe('plan');
    asking.answers.answer(key(), { kind: 'choice', value: 'acceptEdits' });
    expect(await plan).toEqual(results('plan-into-mode')[0]);
  });

  it('refuses an answer another party gives to a question, which the CLI would take as the user’s', () => {
    const { asking, ask, key } = prompts();
    void ask(first('question-and-plan', 'AskUserQuestion'));
    expect(() => {
      asking.answers.answer(key(), {
        kind: 'questions',
        answers: { q1: { picked: ['a.txt'] } },
        decider: { party: 'agent:lead', name: 'Lead' },
      });
    }).toThrow(/only the user/i);
    expect(asking.waiting).toBe(true);
  });
});

describe('Prompts: MCP servers’ requests', () => {
  const [form, link] = recorded('mcp-elicitations').flatMap((item) =>
    item.kind === 'elicitation' ? [item.data] : [],
  ) as [RecordedElicitation, RecordedElicitation];

  it('raises the recorded form, shows it as before, and answers what fits it', async () => {
    const { asking, events, elicit, key } = prompts();
    const told = elicit(form.request);
    expect(events[0]).toMatchObject({
      type: 'prompt',
      prompt: { kind: 'form', server: 'tracker' },
    });
    expect(events[1]).toEqual({
      type: 'elicitation',
      id: expect.stringMatching(/^elicitation:/) as unknown,
      server: 'tracker',
      message: 'Which repository should the issue go in?',
      fields: [
        { name: 'repo', label: 'Repository', required: true, kind: 'text', min: 1 },
        {
          name: 'priority',
          label: 'Priority',
          required: false,
          kind: 'choice',
          options: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' },
          ],
        },
        { name: 'draft', label: 'Draft', required: false, kind: 'boolean', default: false },
      ],
    });
    expect(() => {
      asking.answers.answer(key(), { kind: 'form', action: 'accept', values: { draft: true } });
    }).toThrow(/Repository is required/);
    expect(asking.waiting).toBe(true);
    asking.answers.answer(key(), {
      kind: 'form',
      action: 'accept',
      values: { repo: 'acme/shop', priority: 'high', draft: false },
    });
    expect(await told).toEqual({
      action: 'accept',
      content: { repo: 'acme/shop', priority: 'high', draft: false },
    });
  });

  it('raises the recorded link, and declines one the core won’t open', async () => {
    const { asking, events, elicit, key } = prompts();
    const told = elicit(link.request);
    expect(events[0]).toMatchObject({
      type: 'prompt',
      prompt: { kind: 'form', form: { url: 'https://tracker.example.com/sign-in?state=abc123' } },
    });
    // Shown in the core's words, naming the link's host, never the server's.
    expect(events[1]).toEqual({
      type: 'elicitation',
      id: expect.stringMatching(/^elicitation:/) as unknown,
      server: 'tracker',
      message: 'MCP server “tracker” asks you to open a link on tracker.example.com',
      url: 'https://tracker.example.com/sign-in?state=abc123',
    });
    asking.answers.decline(
      key(),
      'corrallm declined this request: its link isn’t one corrallm opens.',
    );
    expect(await told).toEqual({ action: 'decline' });
  });

  it('declines a form it can’t show without raising it, saying so', async () => {
    const { events, elicit } = prompts();
    expect(
      await elicit({
        serverName: 'github',
        message: 'Which? See github.example/x%3Ftoken%3Dsecret',
        mode: 'form',
        requestedSchema: { type: 'object', properties: { nested: { type: 'object' } } },
      }),
    ).toEqual({ action: 'decline' });
    expect(events).toEqual([
      {
        type: 'notice',
        id: expect.any(String) as unknown,
        level: 'warning',
        text: 'MCP server “github” asked for a form corrallm can’t show, so it was declined.',
      },
    ]);
  });
});

describe('Prompts: the events B13 replaces answered through the owner (until X10)', () => {
  it('translates an old card’s answer to the prompt’s own, answering nothing itself', async () => {
    const { asking, ask, key } = prompts();
    let settled = false;
    const told = ask(first('suggestions-and-denials')).then((result) => {
      settled = true;
      return result;
    });
    const id = 'toolu_01SGVroyU7WGzKnbgZoSqP31:prompt';
    expect(asking.bridge(id, { kind: 'permission', answer: 'once' })).toEqual({
      key: key(),
      answer: { kind: 'choice', value: 'allow' },
    });
    expect(asking.bridge(id, { kind: 'permission', answer: 'always' }).answer).toEqual({
      kind: 'choice',
      value: 'always',
    });
    expect(asking.bridge(id, { kind: 'permission', answer: 'deny' }).answer).toEqual({
      kind: 'choice',
      value: 'deny',
    });
    expect(
      asking.bridge(id, { kind: 'permission', answer: 'deny', feedback: ' Use pnpm ' }).answer,
    ).toEqual({ kind: 'choice', value: 'deny-feedback', feedback: 'Use pnpm' });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(asking.waiting).toBe(true);
    asking.answers.answer(key(), { kind: 'choice', value: 'allow' });
    await told;
  });

  it('refuses to translate what the prompt doesn’t offer, or one no longer asked', () => {
    const { asking, ask } = prompts();
    void ask(first('ask-rule'));
    expect(() =>
      asking.bridge('toolu_01FZuzydzUtCanydjC5wcg2G:prompt', {
        kind: 'permission',
        answer: 'always',
      }),
    ).toThrow(/doesn’t offer/);
    expect(() => asking.bridge('nope', { kind: 'permission', answer: 'once' })).toThrow(
      /no longer asked/,
    );
  });

  it('translates questions by id, a plan by its mode, and a form as it is', () => {
    const { asking, ask, elicit, events } = prompts();
    void ask(first('question-and-plan', 'AskUserQuestion'));
    expect(
      asking.bridge('toolu_01KfF8V1ijeyNsPd8vxDjdCn:prompt', {
        kind: 'question',
        answers: ['a.txt'],
      }).answer,
    ).toEqual({ kind: 'questions', answers: { q1: { picked: ['a.txt'] } } });
    expect(
      asking.bridge('toolu_01KfF8V1ijeyNsPd8vxDjdCn:prompt', {
        kind: 'question',
        answers: ['c.txt, please'],
      }).answer,
    ).toEqual({ kind: 'questions', answers: { q1: { text: 'c.txt, please' } } });

    void ask(first('plan-into-mode'));
    const plan = 'toolu_0139mcmghNr8iKzvYn3WmFEw:prompt';
    expect(
      asking.bridge(plan, { kind: 'plan', answer: { approve: true, mode: 'auto' } }).answer,
    ).toEqual({ kind: 'choice', value: 'auto' });
    expect(
      asking.bridge(plan, { kind: 'plan', answer: { approve: false, feedback: 'Smaller' } }).answer,
    ).toEqual({ kind: 'choice', value: 'keep-planning', feedback: 'Smaller' });

    void elicit(
      recorded('mcp-elicitations').find((item) => item.kind === 'elicitation')?.data.request,
    );
    const shown = events.findLast((event) => event.type === 'elicitation');
    if (shown?.type !== 'elicitation') throw new Error('not shown');
    expect(
      asking.bridge(shown.id, { kind: 'elicitation', action: 'accept', values: { repo: 'a/b' } })
        .answer,
    ).toEqual({ kind: 'form', action: 'accept', values: { repo: 'a/b' } });
  });
});
