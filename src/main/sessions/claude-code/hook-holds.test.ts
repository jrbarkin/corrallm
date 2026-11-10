import { request } from 'node:http';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HookServer } from '../terminal/hooks';
import { askOf } from '../terminal/ask';
import type { HookEvent, HookRegistration } from '../terminal/hooks';
import {
  first,
  headerOf,
  holdRecords,
  hookRequests,
  recordedHoldCases,
  screens,
} from '../terminal/hook-recorded';
import type { HoldRecord } from '../terminal/hook-recorded';
import { ClaudeCode } from './claude-code';
import type { PromptAnswer } from '../../../shared/model/prompts';

/*
 * What Claude Code 2.1.321 did when its HTTP hooks were held, answered or ignored (B23),
 * recorded in a throwaway home against a local stub model (fixtures/hook-holds.jsonl).
 */

const cases = recordedHoldCases(path.join(import.meta.dirname, 'fixtures', 'hook-holds.jsonl'));
const recorded = (name: string): HoldRecord[] => {
  const records = cases.get(name);
  if (records === undefined) throw new Error(`no recorded case ${name}`);
  return records;
};
const screenText = (name: string) => screens(recorded(name)).map((s) => s.text);
const toolResults = (name: string) =>
  holdRecords(recorded(name), 'model-req').flatMap(({ data }) => data.toolResults ?? []);
const closedAt = (name: string, id: string) =>
  first(
    holdRecords(recorded(name), 'hook-conn-closed').filter(({ data }) => data.id === id),
    `close of ${id}`,
  );

let registrations: HookRegistration[] = [];
afterEach(() => {
  for (const registration of registrations) registration.release();
  registrations = [];
});

describe('the HTTP hooks Claude Code sends', () => {
  it('post JSON to the configured URL with the configured header, whatever the event', () => {
    for (const [name, records] of cases) {
      const requests = holdRecords(records, 'hook-req');
      expect(requests.length, name).toBeGreaterThan(0);
      for (const { data } of requests) {
        expect(data.method, name).toBe('POST');
        expect(data.url, name).toBe('/hook');
        expect(headerOf(data, 'Content-Type'), name).toBe('application/json');
        expect(headerOf(data, 'Authorization'), name).toBe('Bearer REDACTED-TOKEN');
        expect(headerOf(data, 'User-Agent'), name).toMatch(/^axios\//);
        expect(typeof data.body.hook_event_name, name).toBe('string');
      }
    }
  });

  it('are heard by the hook server with exactly the headers they were recorded sending', async () => {
    const server = new HookServer();
    const heard = vi.fn<(event: HookEvent) => void>();
    const registration = await server.register(heard);
    registrations.push(registration);
    const sent = first(hookRequests(recorded('hold-timeout'), 'PermissionRequest')).data;
    // Node sets these itself; every other header is as recorded, with the session's own token.
    const skipped = new Set(['host', 'content-length', 'connection']);
    const headers = Object.fromEntries(
      sent.headers
        .filter(([name]) => !skipped.has(name.toLowerCase()))
        .map(([name, value]) => [
          name,
          name === 'Authorization' ? `Bearer ${registration.token}` : value,
        ]),
    );
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        registration.url,
        { method: 'POST', agent: false, headers },
        (response) => {
          response.resume();
          response.on('end', () => {
            resolve(response.statusCode ?? 0);
          });
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(sent.body));
    });
    expect(status).toBe(200);
    await vi.waitFor(() => {
      expect(heard).toHaveBeenCalledWith(sent.body);
    });
  });
});

describe('a held PermissionRequest hook', () => {
  it('leaves the permission dialog on the terminal, answerable, and is cut off at its timeout', () => {
    const records = recorded('hold-timeout');
    const held = first(hookRequests(records, 'PermissionRequest'));
    const [shown, , afterTimeout] = screenText('hold-timeout').slice(1);
    expect(shown).toContain('Do you want to proceed?');
    expect(afterTimeout).toContain('Do you want to proceed?');
    const closed = closedAt('hold-timeout', held.data.id);
    expect(closed.data.answered).toBe(false);
    // The settings' timeout is 5 s.
    expect(closed.t - held.t).toBeGreaterThan(4900);
    expect(closed.t - held.t).toBeLessThan(5600);
    // The user's Yes in the terminal went through, and the turn finished.
    expect(toolResults('hold-timeout')).toContain('(Bash completed with no output)');
  });

  it('is cut off at once by Esc, which interrupts the turn', () => {
    const records = recorded('hold-esc');
    const held = first(hookRequests(records, 'PermissionRequest'));
    const esc = first(
      holdRecords(records, 'in').filter(({ data }) => data === '\u001b'),
      'Esc',
    );
    const closed = closedAt('hold-esc', held.data.id);
    expect(closed.data.answered).toBe(false);
    expect(closed.t - esc.t).toBeLessThan(500);
    expect(screenText('hold-esc').at(-1)).toContain('Interrupted');
    // No Stop hook: nothing tells the end of an interrupted turn.
    expect(hookRequests(records, 'Stop')).toHaveLength(0);
  });

  it('is not cut off when the user answers in the terminal: the request stays open until its timeout', () => {
    const records = recorded('terminal-first');
    const held = first(hookRequests(records, 'PermissionRequest'));
    const stop = first(hookRequests(records, 'Stop'));
    const closed = closedAt('terminal-first', held.data.id);
    expect(holdRecords(records, 'hook-res').some(({ data }) => data.id === held.data.id)).toBe(
      false,
    );
    expect(stop.t).toBeGreaterThan(held.t);
    expect(closed.t).toBeGreaterThan(stop.t + 1000);
  });

  it('tells a permission prompt of its tool and input, which the adapter already reads', () => {
    const claude = new ClaudeCode({ cwd: '/work/app', home: '/Users/me', env: {} });
    const held = first(hookRequests(recorded('hold-timeout'), 'PermissionRequest', 'Bash'));
    const signals = claude.hook(held.data.body);
    expect(signals).toContainEqual(
      expect.objectContaining({
        kind: 'ask',
        prompt: expect.objectContaining({
          kind: 'approval',
          subject: {
            type: 'tool',
            tool: 'Bash',
            input: { command: 'echo hi > hi.txt', description: 'write hi' },
          },
        }) as unknown,
      }),
    );
  });

  it('is followed by a Notification only after the CLI has waited some seconds', () => {
    const records = recorded('hold-long-timeout');
    const held = first(hookRequests(records, 'PermissionRequest'));
    const notice = first(hookRequests(records, 'Notification'));
    expect(notice.data.body).toMatchObject({
      message: 'Claude needs your permission',
      notification_type: 'permission_prompt',
    });
    expect(notice.t - held.t).toBeGreaterThan(5000);
  });
});

describe('a PermissionRequest hook that decides', () => {
  it.each([
    ['answer-allow', 'Allowed by PermissionRequest hook'],
    ['answer-allow-updatedInput', 'Allowed by PermissionRequest hook'],
    ['answer-deny', 'Denied by PermissionRequest hook'],
  ])('%s settles the dialog: "%s"', (name, said) => {
    expect(screenText(name).at(-1)).toContain(said);
  });
  it('can change the tool input it allows', () => {
    expect(JSON.stringify(recorded('answer-allow-updatedInput'))).toContain(
      'echo changed > changed.txt',
    );
    expect(screenText('answer-allow-updatedInput').at(-1)).toContain(
      'Allowed by PermissionRequest hook',
    );
  });
  it('gives the model its deny message, and interrupts the turn with interrupt', () => {
    expect(toolResults('answer-deny')).toContain('Denied from the hook test.');
    expect(screenText('answer-deny-interrupt').at(-1)).toContain('Interrupted');
    expect(toolResults('answer-deny-interrupt')).toEqual([]);
  });
});

describe('another hook deciding, or the reply being unusable', () => {
  it('lets the first decision win and still takes the late reply of the other hook, ignoring it', () => {
    expect(screenText('other-hook-allows-first').at(-1)).toContain(
      'Allowed by PermissionRequest hook',
    );
    expect(screenText('other-hook-denies-first').at(-1)).toContain(
      'Denied by PermissionRequest hook',
    );
    expect(toolResults('corrallm-allows-first-other-slow-deny')).toContain(
      '(Bash completed with no output)',
    );
    for (const name of ['other-hook-allows-first', 'other-hook-denies-first']) {
      const late = first(
        holdRecords(recorded(name), 'hook-res').filter(({ data }) =>
          data.body.includes('PermissionRequest'),
        ),
        'late reply',
      );
      expect(late.data.status).toBe(200);
      expect(closedAt(name, late.data.id).data.answered).toBe(true);
    }
  });

  it.each(['reply-garbage', 'reply-status-500', 'reply-empty-204'])(
    '%s leaves the dialog for the user',
    (name) => {
      expect(screenText(name).at(-1)).toContain('Do you want to proceed?');
    },
  );
  it('reads a decision whatever the Content-Type of the reply', () => {
    expect(screenText('reply-text-plain').at(-1)).toContain('Allowed by PermissionRequest hook');
    expect(screenText('reply-no-content-type-json').at(-1)).toContain(
      'Allowed by PermissionRequest hook',
    );
  });
});

describe('AskUserQuestion', () => {
  const pre = first(hookRequests(recorded('ask-baseline'), 'PreToolUse', 'AskUserQuestion'));
  const perm = first(
    hookRequests(recorded('ask-baseline'), 'PermissionRequest', 'AskUserQuestion'),
  );

  it('is told by PreToolUse (with a tool_use_id) and then by PermissionRequest (without), the same questions', () => {
    expect(pre.data.body.tool_use_id).toEqual(expect.any(String));
    expect(perm.data.body.tool_use_id).toBeUndefined();
    expect(perm.data.body.tool_input).toEqual(pre.data.body.tool_input);
    const claude = new ClaudeCode({ cwd: '/work/app', home: '/Users/me', env: {} });
    for (const request of [pre, perm]) {
      expect(claude.hook(request.data.body)).toContainEqual(
        expect.objectContaining({
          kind: 'ask',
          prompt: expect.objectContaining({ kind: 'question', title: 'Pick a color' }) as unknown,
        }),
      );
    }
  });

  it('shows no dialog while PreToolUse is held, and shows it once that times out or is cut off', () => {
    const held = screenText('ask-pretooluse-held');
    expect(held.at(-1)).toContain('running PreToolUse hook');
    const [shown, after] = screenText('ask-pretooluse-timeout').slice(1);
    expect(shown).toContain('running PreToolUse hook');
    expect(after).toContain('Pick a color');
    expect(screenText('ask-pretooluse-esc').at(-1)).toContain('User declined to answer questions');
  });

  it('is answered by PreToolUse allow with updatedInput.answers, keyed by the question text', () => {
    expect(toolResults('ask-pre-allow-answers')).toContain(
      'Your questions have been answered: "Pick a color"="Blue". You can now continue with these answers in mind.',
    );
    expect(screenText('ask-pre-allow-answers').at(-1)).toContain(
      "User answered Claude's questions",
    );
  });

  it('is answered the same way by PermissionRequest allow with updatedInput.answers, with the terminal still answerable while held', () => {
    expect(toolResults('ask-perm-allow-answers')).toContain(
      'Your questions have been answered: "Pick a color"="Blue". You can now continue with these answers in mind.',
    );
    expect(screenText('ask-perm-held-terminal-answers')[1]).toContain('Pick a color');
    expect(toolResults('ask-perm-held-terminal-answers')).toContain(
      'Your questions have been answered: "Pick a color"="Blue". You can now continue with these answers in mind.',
    );
  });

  it('can be declined with words by a deny, which reach the model as an error', () => {
    expect(toolResults('ask-perm-deny')).toContain('The user answered: Blue');
    expect(toolResults('ask-pre-deny-reason')).toContain(
      'PreToolUse:AskUserQuestion hook error: The user answered the question: Pick a color = Blue',
    );
  });

  it('is left to the terminal by PreToolUse ask', () => {
    expect(screenText('ask-pre-ask').at(-1)).toContain('Pick a color');
  });
});

describe('ExitPlanMode', () => {
  const perm = first(hookRequests(recorded('plan-file'), 'PermissionRequest', 'ExitPlanMode'));

  it('is told with its plan and plan file, which the adapter reads as a plan', () => {
    expect(perm.data.body.tool_input).toEqual({
      plan: '# The plan\n\n1. Add the file\n2. Test it\n',
      planFilePath: expect.stringContaining('/plans/') as unknown,
    });
    const claude = new ClaudeCode({ cwd: '/work/app', home: '/Users/me', env: {} });
    expect(claude.hook(perm.data.body)).toContainEqual(
      expect.objectContaining({
        kind: 'ask',
        prompt: expect.objectContaining({
          kind: 'plan',
          plan: '# The plan\n\n1. Add the file\n2. Test it\n',
        }) as unknown,
      }),
    );
    expect(screenText('plan-file').at(-1)).toContain('Yes, and use auto mode');
  });

  it.each(['planfile-allow-setmode-acceptEdits', 'planfile-allow-bare', 'planfile-pre-allow'])(
    '%s does not accept the plan: its dialog stays, and the mode the user picks there is what it becomes',
    (name) => {
      const afterHook = screens(recorded(name)).find(({ label }) =>
        label.startsWith('after the hook answered'),
      );
      expect(afterHook?.text).toContain('Ready to code?');
      const end = screenText(name).at(-1);
      expect(end).toContain('manual mode on');
      expect(end).not.toContain('accept edits on');
    },
  );

  it("is refused by a deny, whose words are the model's answer, staying in plan mode", () => {
    expect(toolResults('planfile-deny')).toContain('Keep planning: add a rollback step.');
    expect(screenText('planfile-deny').at(-1)).toContain('plan mode on');
    expect(toolResults('planfile-pre-deny')).toContain(
      'PreToolUse:ExitPlanMode hook error: Keep planning: add a rollback step.',
    );
    expect(screenText('planfile-pre-deny').at(-1)).toContain('plan mode on');
  });
});

describe("an MCP server's form (Elicitation)", () => {
  it('is told to an Elicitation hook with its server, message and schema, and holds the terminal while held', () => {
    const asked = first(hookRequests(recorded('elic-baseline'), 'Elicitation'));
    expect(asked.data.body).toMatchObject({
      mcp_server_name: 'form',
      message: 'Which deploy target?',
      mode: 'form',
      requested_schema: { type: 'object', required: ['target'] },
    });
    expect(screenText('elic-baseline').at(-1)).toContain('MCP server “form” requests your input');
    expect(screenText('elic-held').at(-1)).toContain('running Elicitation hook');
    // PermissionRequest is not told of it (the tool itself was allowed).
    expect(hookRequests(recorded('elic-baseline'), 'PermissionRequest')).toHaveLength(0);
  });

  it.each([
    ['elic-accept', '"action":"accept","content":{"target":"prod","note":"from hook"}'],
    ['elic-decline', '"action":"decline"'],
    ['elic-cancel', '"action":"cancel"'],
  ])('%s answers it, as the server sees', (name, result) => {
    expect(JSON.stringify(toolResults(name))).toContain(result.replaceAll('"', '\\"'));
  });
});

/*
 * B23 C2 and C4: what Claude Code · Terminal holds and how it answers, read from the recorded
 * requests: the held prompt, and each reply equal, byte for byte, to the one the recording shows
 * decided.
 */
describe('what Claude Code · Terminal holds (B23 C2)', () => {
  const claude = () => new ClaudeCode({ cwd: '/work/app', home: '/Users/me', env: {} });
  const request = (name: string, event: string, tool?: string) =>
    first(hookRequests(recorded(name), event, tool)).data.body;
  const decided = (name: string): string => {
    const res = holdRecords(recorded(name), 'hook-res').find(
      ({ data }) => data.status === 200 && data.body !== '{}' && data.body !== '',
    );
    if (res === undefined) throw new Error(`${name} decided nothing`);
    return res.data.body;
  };
  const choice = (value: string, feedback?: string): PromptAnswer => ({
    kind: 'choice',
    value,
    ...(feedback === undefined ? {} : { feedback }),
  });

  it('holds a tool’s permission as a both approval with Yes, No and No with words, and no always', () => {
    const held = claude().hold(request('answer-allow', 'PermissionRequest', 'Bash'));
    expect(held?.prompt).toMatchObject({
      kind: 'approval',
      answerIn: 'both',
      title: 'Claude wants to use Bash',
      subject: {
        type: 'tool',
        tool: 'Bash',
        input: { command: 'echo hi > hi.txt', description: 'write hi' },
      },
    });
    const prompt = held?.prompt;
    if (prompt?.kind !== 'approval') throw new Error('not an approval');
    expect(prompt.choices.map(({ value, hint }) => [value, hint])).toEqual([
      ['allow', 'allow_once'],
      ['deny', 'reject_once'],
      ['deny-feedback', 'reject_once'],
    ]);
    // The dialog also offers to allow a folder; corrallm passes none of that on, and says so.
    expect(prompt.omitted).toBe(true);
  });

  it('does not say it left a choice out where the dialog offers only Yes and No', () => {
    const event = { ...request('answer-allow', 'PermissionRequest', 'Bash') };
    delete event.permission_suggestions;
    expect(claude().hold(event)?.prompt).not.toHaveProperty('omitted');
  });

  it('holds AskUserQuestion as a both question', () => {
    const held = claude().hold(
      request('ask-perm-allow-answers', 'PermissionRequest', 'AskUserQuestion'),
    );
    expect(held?.prompt).toMatchObject({
      kind: 'question',
      answerIn: 'both',
      title: 'Pick a color',
      questions: [{ id: 'q1', text: 'Pick a color', other: true }],
    });
  });

  it('holds neither a plan, nor any PreToolUse, nor an event that is no permission', () => {
    expect(claude().hold(request('ask-baseline', 'PreToolUse', 'AskUserQuestion'))).toBeUndefined();
    const plan = hookRequests(recorded('plan-file'), 'PermissionRequest', 'ExitPlanMode');
    expect(plan.length).toBeGreaterThan(0);
    for (const { data } of plan) expect(claude().hold(data.body)).toBeUndefined();
    expect(claude().hold(request('answer-allow', 'Stop'))).toBeUndefined();
    expect(claude().hold({ hook_event_name: 'PermissionRequest' })).toBeUndefined();
    expect(
      claude().hold({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: 'x' }),
    ).toBeUndefined();
    for (const tool_input of [{}, { command: '' }, { command: 3 }, ['ls']]) {
      expect(
        claude().hold({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input }),
      ).toBeUndefined();
    }
  });

  it('does not hold questions with the same text, none, or a request it cannot show whole', () => {
    const base = request('ask-perm-allow-answers', 'PermissionRequest', 'AskUserQuestion');
    const input = base.tool_input as { questions: Record<string, unknown>[] };
    const [question] = input.questions;
    const duplicated = { ...base, tool_input: { questions: [question, { ...question }] } };
    expect(claude().hold(duplicated)).toBeUndefined();
    expect(claude().hold({ ...base, tool_input: { questions: [] } })).toBeUndefined();
    const long = {
      ...base,
      tool_input: { questions: [{ ...question, header: 'h'.repeat(5000) }] },
    };
    expect(claude().hold(long)).toBeUndefined();
    const bash = request('answer-allow', 'PermissionRequest', 'Bash');
    const huge = { ...bash, tool_input: { command: 'x'.repeat(30_000), description: 'd' } };
    expect(claude().hold(huge)).toBeUndefined();
  });

  it.each([
    ['answer-allow', choice('allow')],
    ['answer-deny-interrupt', choice('deny')],
  ])(
    'replies %s byte for byte as recorded, except the words only the recording had',
    (name, answer) => {
      const held = claude().hold(request(name, 'PermissionRequest', 'Bash'));
      const body = JSON.stringify(held?.reply(answer));
      if (name === 'answer-allow') expect(body).toBe(decided(name));
      else {
        // The recording's own message words differ; the shape is the same.
        const recordedBody = JSON.parse(decided(name)) as {
          hookSpecificOutput: { decision: object };
        };
        expect(JSON.parse(body)).toMatchObject({
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'deny', interrupt: true, message: expect.any(String) as string },
          },
        });
        expect(
          Object.keys((JSON.parse(body) as typeof recordedBody).hookSpecificOutput.decision),
        ).toEqual(Object.keys(recordedBody.hookSpecificOutput.decision));
      }
    },
  );

  it('tells and holds the same ask for AskUserQuestion, with option previews too', () => {
    const pre = request('ask-baseline', 'PreToolUse', 'AskUserQuestion');
    const perm = request('ask-baseline', 'PermissionRequest', 'AskUserQuestion');
    const withPreview = (event: Record<string, unknown>) => {
      const input = event.tool_input as { questions: { options: object[] }[] };
      return {
        ...event,
        tool_input: {
          ...input,
          questions: input.questions.map((question) => ({
            ...question,
            options: question.options.map((option) => ({ ...option, preview: '<b>sample</b>' })),
          })),
        },
      };
    };
    for (const [told, asked] of [
      [pre, perm],
      [withPreview(pre), withPreview(perm)],
    ] as const) {
      const signal = claude()
        .hook(told)
        .find((one) => one.kind === 'ask');
      const held = claude().hold(asked);
      if (signal?.kind !== 'ask' || held === undefined) throw new Error('not told or held');
      expect(askOf(signal.prompt)).toBe(askOf(held.prompt));
    }
  });

  it('names a decider other than the user on a plain No, keeping the recorded shape without one', () => {
    const held = claude().hold(request('answer-deny-interrupt', 'PermissionRequest', 'Bash'));
    interface Body {
      hookSpecificOutput: { decision: { message: string; interrupt?: boolean } };
    }
    const other = held?.reply({
      ...choice('deny'),
      decider: { party: 'agent:lead', name: 'Lead' },
    }) as Body;
    expect(other.hookSpecificOutput.decision.message).toContain(
      'Lead (another party in corrallm, not the user)',
    );
    expect(other.hookSpecificOutput.decision.message).not.toContain("The user doesn't want");
    expect(other.hookSpecificOutput.decision.interrupt).toBe(true);
    const user = held?.reply(choice('deny')) as Body;
    expect(user.hookSpecificOutput.decision.message).toContain("The user doesn't want");
  });

  it('replies No with words as a deny that goes on, in the user’s words framed as theirs', () => {
    const held = claude().hold(request('answer-deny', 'PermissionRequest', 'Bash'));
    const body = held?.reply(choice('deny-feedback', 'use a branch')) as {
      hookSpecificOutput: { decision: { behavior: string; message: string; interrupt?: boolean } };
    };
    expect(Object.keys(body.hookSpecificOutput.decision)).toEqual(
      Object.keys(
        (
          JSON.parse(decided('answer-deny')) as {
            hookSpecificOutput: { decision: object };
          }
        ).hookSpecificOutput.decision,
      ),
    );
    expect(body.hookSpecificOutput.decision.message).toMatch(/the user said:\nuse a branch$/);
    expect(body.hookSpecificOutput.decision.interrupt).toBeUndefined();
    const other = held?.reply({
      ...choice('deny-feedback', 'use a branch'),
      decider: { party: 'agent:lead', name: 'Lead' },
    }) as typeof body;
    expect(other.hookSpecificOutput.decision.message).toContain(
      'Lead (another party in corrallm, not the user) said:',
    );
  });

  it('replies a question as the recorded allow, keyed by the question’s text', () => {
    const held = claude().hold(
      request('ask-perm-allow-answers', 'PermissionRequest', 'AskUserQuestion'),
    );
    const body = held?.reply({ kind: 'questions', answers: { q1: { picked: ['Blue'] } } });
    // The same JSON (the stub wrote the request's own input back in its own key order).
    expect(body).toEqual(JSON.parse(decided('ask-perm-allow-answers')));
    // Several picks are joined, own words go as given.
    expect(
      JSON.stringify(
        held?.reply({ kind: 'questions', answers: { q1: { picked: ['Red', 'Blue'] } } }),
      ),
    ).toContain('"answers":{"Pick a color":"Red, Blue"}');
    expect(
      JSON.stringify(held?.reply({ kind: 'questions', answers: { q1: { text: 'Teal' } } })),
    ).toContain('"answers":{"Pick a color":"Teal"}');
  });

  it('refuses a question answered by another party, writing nothing', () => {
    const held = claude().hold(
      request('ask-perm-allow-answers', 'PermissionRequest', 'AskUserQuestion'),
    );
    expect(() =>
      held?.reply({
        kind: 'questions',
        answers: { q1: { picked: ['Blue'] } },
        decider: { party: 'agent:lead', name: 'Lead' },
      }),
    ).toThrow(/only the user/i);
  });

  it('never sends an always, a changed input on an approval, or a classification', () => {
    const held = claude().hold(request('answer-allow', 'PermissionRequest', 'Bash'));
    for (const answer of [choice('allow'), choice('deny'), choice('deny-feedback', 'x')]) {
      const sent = JSON.stringify(held?.reply(answer));
      for (const never of ['updatedPermissions', 'updatedInput', 'decisionClassification']) {
        expect(sent).not.toContain(never);
      }
    }
    expect(() => held?.reply(choice('always'))).toThrow();
  });
});
