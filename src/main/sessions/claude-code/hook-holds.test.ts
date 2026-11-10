import { request } from 'node:http';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HookServer } from '../terminal/hooks';
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
