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
import { sessionHookKey } from './hooks';

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
