import { describe, expect, it, vi } from 'vitest';

import type { PromptEnded, PromptEvent } from '../../../../shared/model/prompts';
import type { SessionAnswer } from '../../../../shared/session';
import type { HostEvent } from '../../connector';
import { Prompts } from './prompts';
import { recordedAsks, recordedPlaces } from './recorded';
import type { Fixture, RecordedAsk } from './recorded';
import { Translator } from './translate';

/*
 * Codex's requests as B13 C5 raises them: each a prompt of the core's owner's under a key minted
 * for that request, answered or declined only by that key, ended when Codex stops waiting or the
 * session closes, and always answered. Until X10 converts the renderer, each is shown as the events
 * B13 replaces too, whose answers reach Codex only through the owner (`bridge`).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Prompts, the events it emits, a translator that read what came before; `decline` as the owner. */
function prompts({ decline }: { decline?: string } = {}) {
  const events: HostEvent[] = [];
  const settled = vi.fn();
  const translator = new Translator({ places: recordedPlaces('p1') });
  const asking: Prompts = new Prompts(
    {
      emit: (event) => {
        events.push(event);
        if (decline !== undefined && event.type === 'prompt')
          asking.answers.decline(event.key, decline);
      },
      settled,
      patch: (itemId) => translator.patch(itemId),
      mcpCall: (itemId) => translator.mcpCall(itemId),
      mcpCalls: () => translator.mcpCalls(),
    },
    recordedPlaces('p1'),
  );
  /** Asks a recorded request, as Codex asked it, after what it said before. */
  const ask = (recorded: RecordedAsk, id: string | number = recorded.id) => {
    for (const { method, params } of recorded.before) translator.notification(method, params);
    return asking.request(recorded.method, recorded.params, id);
  };
  const raised = () => events.filter((event): event is PromptEvent => event.type === 'prompt');
  const ended = () => events.filter((event): event is PromptEnded => event.type === 'prompt-ended');
  const key = (index = -1) => {
    const found = raised().at(index);
    if (!found) throw new Error('nothing raised');
    return found.key;
  };
  /** The id of the event B13 replaces that shows the last prompt. */
  const shown = () => {
    const found = events.findLast(
      (event) =>
        event.type === 'permission' ||
        event.type === 'question' ||
        event.type === 'plan' ||
        event.type === 'elicitation',
    );
    if (!found || !('id' in found)) throw new Error('nothing shown');
    return found;
  };
  /** Answers the shown prompt as an old card would: through the owner, by its key. */
  const answerShown = (answer: SessionAnswer, id = shown().id) => {
    const bridged = asking.bridge(id, answer);
    asking.answers.answer(bridged.key, bridged.answer);
  };
  return { asking, events, settled, ask, raised, ended, key, shown, answerShown };
}

function asks(fixture: Fixture): RecordedAsk[] {
  return recordedAsks(fixture);
}
function first(fixture: Fixture, nth = 0): RecordedAsk {
  const found = asks(fixture)[nth];
  if (!found) throw new Error(`${fixture} has no request #${String(nth)}`);
  return found;
}

describe('Prompts: each request Codex makes raised to the core under a fresh key', () => {
  it('raises a recorded approval, shows it as before, and tells Codex only the owner’s answer', async () => {
    const asked = first('turns');
    const { asking, events, ask, key, settled } = prompts();
    const told = ask(asked);
    expect(events).toEqual([
      {
        type: 'prompt',
        key: expect.stringMatching(UUID) as unknown,
        prompt: expect.objectContaining({ kind: 'approval', answerIn: 'api' }) as unknown,
      },
      {
        type: 'permission',
        id: expect.stringMatching(/^prompt:[0-9a-f-]{36}$/) as unknown,
        tool: 'exec_command',
        summary: "printf 'hi' > hello.txt",
        always: "Yes, and don't ask again for commands that start with `printf 'hi' > hello.txt`",
        title: 'May I create hello.txt containing hi in the workspace?',
      },
      { type: 'status', status: 'waiting' },
    ]);
    expect(asking.waiting).toBe(true);
    // An answer it doesn't offer is refused, and it still waits.
    expect(() => {
      asking.answers.answer(key(), { kind: 'choice', value: 'acceptForSession' });
    }).toThrow(/not offered/);
    asking.answers.answer(key(), { kind: 'choice', value: 'accept' });
    // As recorded.
    await expect(told).resolves.toEqual(asked.result);
    expect(asking.waiting).toBe(false);
    expect(settled).toHaveBeenCalledOnce();
    expect(() => {
      asking.answers.answer(key(), { kind: 'choice', value: 'accept' });
    }).toThrow(/no longer asked/);
  });

  it('gives two approvals of one item keys of their own: an answer to one never answers the other (F14)', async () => {
    const [, command, input] = asks('approvals');
    if (!command || !input) throw new Error('not recorded');
    const { asking, ask, key } = prompts();
    const commandTold = ask(command);
    const one = key();
    asking.answers.answer(one, { kind: 'choice', value: 'accept' });
    await expect(commandTold).resolves.toEqual(command.result);
    const inputTold = ask(input);
    const two = key();
    expect(two).not.toBe(one);
    // A late answer meant for the first is refused: the second still waits.
    expect(() => {
      asking.answers.answer(one, { kind: 'choice', value: 'accept' });
    }).toThrow(/no longer asked/);
    expect(asking.waiting).toBe(true);
    asking.answers.answer(two, { kind: 'choice', value: 'cancel' });
    await expect(inputTold).resolves.toEqual(input.result);
  });

  it('declines with Codex’s nonapproval and shows nothing of a request the owner declines as it comes', async () => {
    const { events, ask } = prompts({ decline: 'corrallm declined this request: too many wait.' });
    await expect(ask(first('turns'))).resolves.toEqual({ decision: 'cancel' });
    await expect(ask(first('permissions'))).resolves.toEqual({ permissions: {}, scope: 'turn' });
    await expect(ask(first('question'))).resolves.toEqual({ answers: {} });
    await expect(ask(first('mcp-approvals', 3))).resolves.toEqual({
      action: 'cancel',
      content: null,
      _meta: null,
    });
    expect(events.map(({ type }) => type)).toEqual(['prompt', 'prompt', 'prompt', 'prompt']);
  });

  it('declines what corrallm can’t pass on faithfully, telling the user, never raising it', async () => {
    const { events, ask } = prompts();
    const asked = first('mcp-approvals', 0);
    // Its tool's call was never seen.
    await expect(ask({ ...asked, before: [] })).resolves.toEqual({
      action: 'decline',
      content: null,
      _meta: null,
    });
    expect(events).toEqual([
      {
        type: 'notice',
        id: expect.any(String) as unknown,
        level: 'warning',
        text: 'Codex asked to approve a tool call of MCP server “probe” corrallm couldn’t tell, so it was declined.',
      },
    ]);
  });

  it('ends a request Codex stops waiting for, answering it still; a numeric id is not its text', async () => {
    const asked = first('turns');
    const { asking, events, ask, key, ended, shown, settled } = prompts();
    const told = ask(asked, 7);
    const { id } = shown();
    asking.resolved('7');
    expect(asking.waiting).toBe(true);
    asking.resolved(7);
    await expect(told).resolves.toEqual({ decision: 'cancel' });
    expect(ended()).toEqual([{ type: 'prompt-ended', key: key(), reason: 'withdrawn' }]);
    expect(events).toContainEqual({ type: 'withdrawn', id });
    expect(settled).toHaveBeenCalled();
    expect(() => {
      asking.answers.answer(key(), { kind: 'choice', value: 'accept' });
    }).toThrow(/no longer asked/);
    // Codex says so after every answer too: then it ends nothing.
    asking.resolved(7);
    expect(ended()).toHaveLength(1);
  });

  it('withdraws every open request through the owner as the session closes, each answered', async () => {
    const { asking, ask, ended } = prompts();
    const command = ask(first('turns'), 1);
    const question = ask(first('question'), 2);
    asking.withdrawAll();
    await expect(command).resolves.toEqual({ decision: 'cancel' });
    await expect(question).resolves.toEqual({ answers: {} });
    expect(ended().map(({ reason }) => reason)).toEqual(['withdrawn', 'withdrawn']);
    expect(asking.waiting).toBe(false);
  });

  it('answers what it doesn’t handle as unhandled, and tells the time', async () => {
    const { asking } = prompts();
    await expect(asking.request('item/tool/call', {}, 1)).rejects.toMatchObject({ code: -32601 });
    const { currentTimeAt } = (await asking.request('currentTime/read', { threadId: 't' }, 3)) as {
      currentTimeAt: number;
    };
    expect(Math.abs(currentTimeAt - Date.now() / 1000)).toBeLessThan(5);
  });
});

describe('Prompts: the events B13 replaces, answered only through the owner (until X10)', () => {
  it('takes an old card’s “always” as the decision it shows: Codex’s first that keeps', async () => {
    const asked = first('mcp-approvals', 1);
    const { ask, shown, answerShown } = prompts();
    const told = ask(asked);
    expect(shown()).toEqual({
      type: 'permission',
      id: expect.stringMatching(/^prompt:/) as unknown,
      tool: 'mcp__probe__save_note',
      summary: 'b',
      always: 'Allow for this session',
      title: 'Allow the probe MCP server to run tool "save_note"?',
    });
    answerShown({ kind: 'permission', answer: 'always' });
    // As recorded: allowed for the session.
    await expect(told).resolves.toEqual(asked.result);
  });

  it('takes an old card’s No as Codex’s No, and its once as Yes', async () => {
    const { ask, answerShown } = prompts();
    const command = ask(first('turns'));
    answerShown({ kind: 'permission', answer: 'deny', feedback: 'not now' });
    await expect(command).resolves.toEqual({ decision: 'cancel' });
    const permissions = ask(first('permissions'));
    answerShown({ kind: 'permission', answer: 'once' });
    await expect(permissions).resolves.toEqual({
      permissions: { network: { enabled: true }, fileSystem: null },
      scope: 'turn',
    });
  });

  it('takes an old card’s answers to questions by their order, a pick or words', async () => {
    const asked = first('question');
    const { ask, shown, answerShown } = prompts();
    const told = ask(asked);
    expect(shown()).toEqual({
      type: 'question',
      id: expect.stringMatching(/^prompt:/) as unknown,
      questions: [
        {
          header: 'Filename',
          text: 'Should the new file be named a.txt or b.txt?',
          options: [
            { label: 'a.txt (Recommended)', description: 'Plan to create a file named a.txt.' },
            { label: 'b.txt', description: 'Plan to create a file named b.txt.' },
          ],
          multiple: false,
        },
      ],
    });
    answerShown({ kind: 'question', answers: ['c.txt'] });
    await expect(told).resolves.toEqual(asked.result);
  });

  it('shows a form’s fields and a link in the core’s words, and takes their answers', async () => {
    const form = first('mcp-approvals', 3);
    const link = first('mcp-approvals', 4);
    const { ask, shown, answerShown } = prompts();
    const formTold = ask(form);
    expect(shown()).toMatchObject({
      type: 'elicitation',
      server: 'probe',
      message: 'Fill in your profile.',
      fields: expect.arrayContaining([
        expect.objectContaining({ name: 'age', kind: 'integer' }),
      ]) as unknown,
    });
    const values = (form.result as { content: Record<string, never> }).content;
    answerShown({ kind: 'elicitation', action: 'accept', values });
    await expect(formTold).resolves.toEqual(form.result);
    const linkTold = ask(link);
    expect(shown()).toEqual({
      type: 'elicitation',
      id: expect.stringMatching(/^elicitation:/) as unknown,
      server: 'probe',
      message: 'MCP server “probe” asks you to open a link on auth.example.com',
      url: 'https://auth.example.com/sign-in?state=probe',
    });
    answerShown({ kind: 'elicitation', action: 'accept' });
    await expect(linkTold).resolves.toEqual(link.result);
  });

  it('declines a secret question while the old events show prompts: they keep every answer', async () => {
    const asked = first('question');
    const params = asked.params as { questions: Record<string, unknown>[] };
    const { events, ask } = prompts();
    await expect(
      ask({
        ...asked,
        params: { ...params, questions: params.questions.map((q) => ({ ...q, isSecret: true })) },
      }),
    ).resolves.toEqual({ answers: {} });
    expect(events).toEqual([
      {
        type: 'notice',
        id: expect.any(String) as unknown,
        level: 'warning',
        text: 'Codex asked a secret question, which corrallm can’t ask yet, so it was declined.',
      },
    ]);
  });

  it('refuses an old answer the prompt doesn’t take, and one no longer asked', () => {
    const { asking, ask, shown } = prompts();
    void ask(first('turns'));
    expect(() => asking.bridge(shown().id, { kind: 'question', answers: ['yes'] })).toThrow(
      /isn’t one this request takes/,
    );
    expect(() => asking.bridge('prompt:gone', { kind: 'permission', answer: 'once' })).toThrow(
      /no longer asked/,
    );
  });
});
