import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  first,
  headerOf,
  holdRecords,
  hookRequests,
  recordedHoldCases,
  screens,
} from '../../terminal/hook-recorded';
import type { HoldRecord } from '../../terminal/hook-recorded';
import { computedTrust, permissionCommand, sessionHookKey, toml } from './hooks';
import { CodexTui } from './tui';
import type { PromptAnswer } from '../../../../shared/model/prompts';

/*
 * What Codex 0.162.1 did when its command hooks were held, answered or ignored (B23),
 * recorded in a throwaway home against a local stub model (fixtures/hook-holds.jsonl). The hooks
 * are `curl` commands posting to a stub hook server; the commands here print the server's reply,
 * as a hook that decides must (the hooks corrallm sets today print nothing).
 */

const cases = recordedHoldCases(path.join(import.meta.dirname, 'fixtures', 'hook-holds.jsonl'));
const recorded = (name: string): HoldRecord[] => {
  const records = cases.get(name);
  if (records === undefined) throw new Error(`no recorded case ${name}`);
  return records;
};
const screenText = (name: string) => screens(recorded(name)).map((s) => s.text);
const closedAt = (name: string, id: string) =>
  first(
    holdRecords(recorded(name), 'hook-conn-closed').filter(({ data }) => data.id === id),
    `close of ${id}`,
  );
const resultsOf = (name: string) => screenText(name).at(-1) ?? '';

describe('the command hooks Codex runs', () => {
  it('send what their command sends: curl’s headers and Codex’s JSON on stdin, with no Content-Type of Codex’s own', () => {
    for (const [name, records] of cases) {
      const requests = holdRecords(records, 'hook-req');
      for (const { data } of requests) {
        expect(data.method, name).toBe('POST');
        expect(headerOf(data, 'User-Agent'), name).toMatch(/^curl\//);
        expect(headerOf(data, 'Content-Type'), name).toBe('application/json');
        expect(headerOf(data, 'Authorization'), name).toBe('Bearer REDACTED-TOKEN');
        expect(typeof data.body.hook_event_name, name).toBe('string');
        expect(data.body.turn_id, name).toEqual(expect.any(String));
      }
    }
  });

  it('trusts a PermissionRequest hook by its own key and hash, and asks for review of one not trusted', () => {
    const argv = first(holdRecords(recorded('hold'), 'argv')).data.args;
    const state = argv.find((arg) => arg.startsWith('hooks.state='));
    expect(state).toContain('"/<session-flags>/config.toml:permission_request:0:0"');
    expect(state).toMatch(/permission_request:0:0"=\{trusted_hash="sha256:[0-9a-f]{64}"\}/);
    // The key Codex gives a session hook is built the way hooks.ts builds it.
    expect(sessionHookKey('Stop')).toBe('/<session-flags>/config.toml:stop:0:0');
    expect(screenText('untrusted-hook').at(-1)).toContain('Hooks need review');
    expect(hookRequests(recorded('untrusted-hook'), 'PermissionRequest')).toHaveLength(0);
  });
});

describe('a held PermissionRequest hook', () => {
  it('holds the approval itself: the terminal shows "Running hook", not the dialog, and a key typed meanwhile is queued as text', () => {
    const [shown, second] = screenText('hold').slice(1);
    expect(shown).toContain('Running hook');
    expect(shown).not.toContain('Would you like to run');
    expect(second).toContain('Running hook');
    const held = screenText('hold-terminal-first').at(-1);
    expect(held).toContain('Running hook');
    expect(held).toContain('› y');
    expect(held).toContain('tab to queue message');
  });

  it('is cut off at its timeout, says so in the transcript, and then shows the approval', () => {
    const held = first(hookRequests(recorded('hold'), 'PermissionRequest'));
    const closed = closedAt('hold', held.data.id);
    expect(closed.data.answered).toBe(false);
    // The hook's own timeout was 5 s.
    expect(closed.t - held.t).toBeGreaterThan(4900);
    expect(closed.t - held.t).toBeLessThan(5600);
    const after = screenText('hold')[3];
    expect(after).toContain('Hook failed');
    expect(after).toContain('hook timed out after 5s');
    expect(after).toContain('Would you like to run the following command?');
    expect(screenText('hold').at(-1)).toContain(
      'You approved codex to run echo hi > hi.txt this time',
    );
  });

  it('is killed at once by Esc, which interrupts the turn', () => {
    const records = recorded('hold-esc');
    const held = first(hookRequests(records, 'PermissionRequest'));
    const esc = first(
      holdRecords(records, 'in').filter(({ data }) => data === '\u001b'),
      'Esc',
    );
    const closed = closedAt('hold-esc', held.data.id);
    expect(closed.data.answered).toBe(false);
    expect(closed.t - esc.t).toBeLessThan(500);
    expect(screenText('hold-esc').at(-1)).toContain('Conversation interrupted');
    expect(hookRequests(records, 'Stop')).toHaveLength(0);
  });

  it('tells its tool and input, and the turn and mode', () => {
    const held = first(hookRequests(recorded('answer-allow'), 'PermissionRequest'));
    expect(held.data.body).toMatchObject({
      hook_event_name: 'PermissionRequest',
      model: 'stub-model',
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi > hi.txt', description: 'write hi.txt' },
    });
    expect(held.data.body.tool_use_id).toBeUndefined();
  });
});

describe('a PermissionRequest hook that decides', () => {
  it('settles the approval with allow, or blocks it with deny and its message, both as the command printed it', () => {
    expect(resultsOf('answer-allow')).toContain('Ran echo hi > hi.txt');
    expect(resultsOf('answer-deny')).toContain('Blocked by hook');
    expect(resultsOf('answer-deny')).toContain('Denied from the hook test.');
    const reply = first(
      holdRecords(recorded('answer-deny'), 'hook-res').filter(({ data }) =>
        data.body.includes('PermissionRequest'),
      ),
    );
    expect(JSON.parse(reply.data.body)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'Denied from the hook test.' },
      },
    });
  });

  it('is waited for with its siblings: every hook of the event finishes, and a deny wins whichever was first', () => {
    expect(screenText('other-allows-first').at(-1)).toContain('late deny');
    expect(screenText('other-denies-first').at(-1)).toContain('user hook denies');
    expect(screenText('corrallm-allows-first-other-slow-deny').at(-1)).toContain('slow deny');
    // Neither reply is turned away: both requests were answered.
    for (const name of ['other-allows-first', 'other-denies-first']) {
      for (const { data } of holdRecords(recorded(name), 'hook-conn-closed')) {
        expect(data.answered, name).toBe(true);
      }
    }
  });

  it('reads only what the command printed: the HTTP status is curl’s, and an unusable reply leaves the approval to the user', () => {
    expect(resultsOf('reply-status-500')).toContain('Ran echo hi > hi.txt');
    for (const name of ['reply-garbage', 'reply-nodecision-long']) {
      expect(resultsOf(name), name).toContain('Would you like to run the following command?');
    }
  });
});

describe('questions and forms', () => {
  it('gives its question tool to PreToolUse alone, never to PermissionRequest', () => {
    const records = recorded('ask-plan-mode');
    const asked = first(hookRequests(records, 'PreToolUse', 'request_user_input'));
    expect(asked.data.body.tool_input).toEqual({
      questions: [
        {
          id: 'color',
          header: 'Color',
          question: 'Pick a color',
          options: [
            { label: 'Red', description: 'A warm color' },
            { label: 'Blue', description: 'A cool color' },
          ],
        },
      ],
    });
    expect(asked.data.body.tool_use_id).toEqual(expect.any(String));
    expect(hookRequests(records, 'PermissionRequest')).toHaveLength(0);
    expect(resultsOf('ask-plan-mode')).toContain('Question 1/1');
    expect(resultsOf('ask-default')).toContain('request_user_input is unavailable in Default mode');
  });

  it('is answered, if at all, by a PreToolUse deny, whose reason the model reads; held, it holds the question like any hook', () => {
    expect(resultsOf('ask-pretooluse-deny')).toContain('Blocked by hook');
    expect(resultsOf('ask-pretooluse-deny')).toContain(
      'Tool call blocked by PreToolUse hook: The user answered: Blue. Tool: request_user_input',
    );
    const [shown, after] = screenText('ask-pretooluse-held').slice(1);
    expect(shown).toContain('Running hook');
    expect(shown).not.toContain('Pick a color');
    expect(after).toContain('hook timed out after 5s');
    expect(after).toContain('Pick a color');
  });

  it('asks an MCP tool’s approval through PermissionRequest, and then shows the server’s own form with no hook for it', () => {
    const records = recorded('form-perm-allow');
    const asked = first(hookRequests(records, 'PermissionRequest'));
    expect(asked.data.body).toMatchObject({ tool_name: 'mcp__form__ask', tool_input: {} });
    expect(screenText('form').at(-1)).toContain('Allow the form MCP server to run tool "ask"?');
    expect(screenText('form-perm-allow').at(-1)).toContain('Which deploy target?');
    const events = holdRecords(records, 'hook-req').map(({ data }) => data.body.hook_event_name);
    expect(events).not.toContain('Elicitation');
  });
});

/*
 * B23 C2 and C4: what Codex · Terminal holds, and what its hook is told, read from the recorded
 * requests. Held, Codex hides its approval ("Running hook"), so only corrallm answers it
 * (`answerIn: 'api'`), with Answer in terminal to hand it back.
 */
describe('what Codex · Terminal holds (B23 C2)', () => {
  const tui = (options: { permission?: boolean } = {}) =>
    new CodexTui({
      trust: (hooks) => Promise.resolve(computedTrust(hooks)),
      platform: 'darwin',
      ...options,
    });
  const bash = () =>
    first(hookRequests(recorded('answer-allow'), 'PermissionRequest', 'Bash')).data.body;
  const mcp = () =>
    first(hookRequests(recorded('form-perm-allow'), 'PermissionRequest', 'mcp__form__ask')).data
      .body;
  const choice = (value: string, feedback?: string): PromptAnswer => ({
    kind: 'choice',
    value,
    ...(feedback === undefined ? {} : { feedback }),
  });
  const decision = (body: unknown) =>
    (body as { hookSpecificOutput: { hookEventName: string; decision: Record<string, unknown> } })
      .hookSpecificOutput;

  it('holds a command as an api approval with its command and folder, and what the dialog also offers said', () => {
    const held = tui().hold(bash());
    expect(held?.prompt).toEqual({
      kind: 'approval',
      title: 'Codex wants to run a command',
      reason: 'write hi.txt',
      subject: { type: 'command', command: 'echo hi > hi.txt', cwd: '/tmp/rec/work' },
      answerIn: 'api',
      omitted: true,
      choices: [
        {
          value: 'accept',
          label: 'Yes, proceed',
          hint: 'allow_once',
          effects: {},
          feedback: 'none',
          endsTurn: false,
        },
        {
          value: 'decline',
          label: 'No, continue without running it',
          hint: 'reject_once',
          effects: {},
          feedback: 'none',
          endsTurn: false,
        },
        {
          value: 'decline-feedback',
          label: 'No, and tell Codex what to do differently',
          hint: 'reject_once',
          effects: {},
          feedback: 'required',
          endsTurn: false,
        },
      ],
    });
  });

  it('holds an MCP tool’s approval as an mcpTool one, its server and tool read from its name', () => {
    const held = tui().hold(mcp());
    expect(held?.prompt).toMatchObject({
      kind: 'approval',
      answerIn: 'api',
      subject: { type: 'mcpTool', server: 'form', tool: 'ask', input: {} },
    });
    // A name that can't be split one way is a tool, named whole.
    const odd = tui().hold({ ...mcp(), tool_name: 'mcp__a__b__c' });
    expect(odd?.prompt).toMatchObject({ subject: { type: 'tool', tool: 'mcp__a__b__c' } });
  });

  it('holds nothing else: another tool, a subagent’s request, another event, a command too long', () => {
    for (const tool of ['apply_patch', 'WebSearch', 'request_user_input', '']) {
      expect(tui().hold({ ...bash(), tool_name: tool }), tool).toBeUndefined();
    }
    expect(tui().hold({ ...bash(), agent_id: 'sub-1' })).toBeUndefined();
    expect(tui().hold({ ...bash(), hook_event_name: 'PreToolUse' })).toBeUndefined();
    expect(tui().hold({ ...bash(), tool_input: { command: 'x'.repeat(70_000) } })).toBeUndefined();
    expect(tui().hold({ ...bash(), tool_input: {} })).toBeUndefined();
    expect(tui().hold({ ...bash(), cwd: undefined })).toBeUndefined();
  });

  it('holds nothing where Codex was not given the hook (before 0.162.1)', () => {
    expect(tui({ permission: false }).hold(bash())).toBeUndefined();
  });

  it('replies as the recorded allow and deny, with the user’s words framed, and nothing more', () => {
    const held = tui().hold(bash());
    const allow = held?.reply(choice('accept'));
    expect(allow).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    const recordedAllow = JSON.parse(
      holdRecords(recorded('answer-allow'), 'hook-res').find(({ data }) =>
        data.body.includes('PermissionRequest'),
      )?.data.body ?? '{}',
    ) as unknown;
    expect(allow).toEqual(recordedAllow);
    const deny = decision(held?.reply(choice('decline')));
    expect(deny).toMatchObject({
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: expect.stringContaining('declined') as string },
    });
    expect(Object.keys(deny.decision).sort()).toEqual(['behavior', 'message']);
    const feedback = decision(held?.reply(choice('decline-feedback', 'use a branch')));
    expect(feedback.decision.message).toBe('The user declined this and said: use a branch');
    const lead = decision(
      held?.reply({
        ...choice('decline-feedback', 'use a branch'),
        decider: { party: 'agent:lead', name: 'Lead' },
      }),
    );
    expect(lead.decision.message).toBe(
      'Lead (another party in corrallm, not the user) declined this and said: use a branch',
    );
    for (const answer of [choice('accept'), choice('decline'), choice('decline-feedback', 'x')]) {
      const sent = JSON.stringify(held?.reply(answer));
      for (const never of ['interrupt', 'updatedInput', 'updatedPermissions']) {
        expect(sent).not.toContain(never);
      }
    }
  });

  it('refuses what it cannot express, writing nothing', () => {
    const held = tui().hold(bash());
    expect(() => held?.reply(choice('always'))).toThrow();
    expect(() => held?.reply(choice('decline-feedback'))).toThrow(/instead|words/i);
    expect(() => held?.reply({ kind: 'questions', answers: {} })).toThrow();
  });

  it('lets the held request go with {} and no failure line, which the recording shows', () => {
    // Released, the approval is the terminal's, and Codex prints no "Hook failed".
    expect(resultsOf('reply-nodecision-long')).toContain(
      'Would you like to run the following command?',
    );
    expect(resultsOf('reply-nodecision-long')).not.toContain('Hook failed');
  });
});

/*
 * B23 E1: Codex's window title while its PermissionRequest hook is held, with corrallm's
 * `tui.terminal_title`, the hook's timeout at 30 s and the printing command the session gives the
 * hook, released with {} at 20 s. Held, the title is the spinner and "Working" (no Action
 * Required: the approval is hidden); released, the approval appears and the title says so.
 */
describe('what Codex titles while its PermissionRequest hook is held (B23 E1)', () => {
  const name = 'e1-held-release-20s';
  const titles = () => holdRecords(recorded(name), 'title');
  const held = () => first(hookRequests(recorded(name), 'PermissionRequest', 'Bash'));
  const release = () =>
    first(
      holdRecords(recorded(name), 'hook-res').filter(({ data }) => data.id === held().data.id),
      'release',
    );

  it('ran with the session’s own title setting, hook command and timeout', () => {
    const args = first(holdRecords(recorded(name), 'argv')).data.args;
    expect(args).toContain('tui.terminal_title=["context-used","activity","run-state"]');
    const command = permissionCommand('http://127.0.0.1:PORT/hook');
    expect(args).toContain(
      `hooks.PermissionRequest=[{hooks=[{type="command",command=${toml(command)},timeout=30}]}]`,
    );
  });

  it('titles the hold as working, the spinner and "Working", all the way to the release', () => {
    const request = held().t;
    // The spinner's frames are recorded once: no other title came while it was held.
    const during = titles().filter(({ t }) => t > request && t < release().t);
    expect(during).toEqual([]);
    const before = titles().filter(({ t }) => t <= request);
    expect(before.at(-1)?.data).toMatch(/ Working$/);
    expect(before.every(({ data }) => !data.includes('Action Required'))).toBe(true);
    // The screen at 18 s: hooks are running, and the approval is not drawn.
    const screen = screens(recorded(name)).find(({ label }) => label.startsWith('held +18s'));
    expect(screen?.text).toContain('Running hook');
    expect(screen?.text).not.toContain('Would you like to run');
  });

  it('is read by the session as working while held, and blocked once released', () => {
    const tui = new CodexTui({
      trust: (hooks) => Promise.resolve(computedTrust(hooks)),
      platform: 'darwin',
    });
    const states = titles().map(({ t, data }) => ({ t, state: tui.title(data)?.state }));
    const before = states.filter(({ t }) => t <= release().t).map(({ state }) => state);
    expect(before.at(-1)).toBe('working');
    expect(before).not.toContain('blocked');
    const after = states.filter(({ t }) => t > release().t).map(({ state }) => state);
    expect(after[0]).toBe('blocked');
  });

  it('is let go by {} at 20 s, which shows the approval and no "Hook failed"', () => {
    const request = held();
    expect(release().data.body).toBe('{}');
    expect(release().t - request.t).toBeGreaterThan(19_500);
    expect(release().t - request.t).toBeLessThan(21_500);
    expect(closedAt(name, request.data.id).data.answered).toBe(true);
    const title = first(
      titles().filter(({ t }) => t > release().t),
      'a title after the release',
    );
    expect(title.data).toContain('Action Required');
    expect(title.t - release().t).toBeLessThan(500);
    const shown = screenText(name);
    expect(
      shown.some((text) => text.includes('Would you like to run the following command?')),
    ).toBe(true);
    for (const text of shown) expect(text).not.toContain('Hook failed');
    // The user's y in the terminal then went through.
    expect(shown.at(-1)).toContain('You approved codex to run');
  });
});
