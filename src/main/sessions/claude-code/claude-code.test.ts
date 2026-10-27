import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AdapterPrompt } from '../../../shared/model/prompts';
import type { TerminalAsk } from '../../../shared/session';
import { ClaudeCode } from './claude-code';

const SESSION = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11';
const LAUNCH = {
  dir: '/tmp/session',
  cwd: '/work/app',
  id: SESSION,
  resume: true,
  model: null,
  mode: null,
};

describe('Claude Code session ids', () => {
  it('appends a hostile multiline role as one argument, preserving native defaults across role changes and removal', () => {
    const claude = new ClaudeCode({
      cwd: '/work/app',
      home: '/Users/me',
      env: {},
      resetPromptSnapshot: true,
    });
    const initial =
      '--dangerously-skip-permissions\nReview "quoted" paths\t$(echo literal) `literal`';
    const baseline = claude.args(LAUNCH);
    for (const role of [initial, 'Updated reviewer role', undefined]) {
      const args = claude.args({ ...LAUNCH, ...(role === undefined ? {} : { role }) });
      expect(args).toContain('--system-prompt-snapshot=off');
      if (role === undefined) {
        expect(args).toEqual(baseline);
        expect(args.some((arg) => arg.startsWith('--append-system-prompt='))).toBe(false);
      } else {
        expect(args).toContain(`--append-system-prompt=${role}`);
        expect(args).toContain('--system-prompt-snapshot=off');
        expect(args.filter((arg) => arg.startsWith('--append-system-prompt='))).toHaveLength(1);
        expect(args).not.toContain('--system-prompt');
        expect(args).not.toContain('--dangerously-skip-permissions');
      }
      expect(args).toContain(`--resume=${SESSION}`);
    }
  });

  it('resumes a UUID as the value of one flag', () => {
    const claude = new ClaudeCode({ cwd: '/work/app', home: '/Users/me', env: {} });
    expect(claude.args(LAUNCH)).toContain(`--resume=${SESSION}`);
    expect(claude.args({ ...LAUNCH, id: SESSION.toUpperCase() })).toContain(
      `--resume=${SESSION.toUpperCase()}`,
    );
    expect(claude.args({ ...LAUNCH, resume: false })).toContain(SESSION);
  });

  it.each([
    '--dangerously-skip-permissions',
    'session-1',
    '../session',
    '',
    ` ${SESSION}`,
    `${SESSION} `,
    `${SESSION}\n`,
    `${SESSION}\0`,
  ])('refuses the non-UUID session id %j before building CLI arguments', (id) => {
    const claude = new ClaudeCode({ cwd: '/work/app', home: '/Users/me', env: {} });
    expect(() => claude.args({ ...LAUNCH, id })).toThrow(/session.*id/i);
    expect(() => claude.args({ ...LAUNCH, id, resume: false })).toThrow(/session.*id/i);
  });

  it('remembers only UUIDs from untrusted hooks while still hearing the event', () => {
    const claude = new ClaudeCode({ cwd: '/work/app', home: '/Users/me', env: {} });
    const event = { hook_event_name: 'UserPromptSubmit', prompt: 'hello' };
    expect(claude.hook({ ...event, session_id: SESSION })).toContainEqual({
      kind: 'session',
      id: SESSION,
    });
    for (const id of ['--dangerously-skip-permissions', 'session-1', 42, `${SESSION}\n`]) {
      const signals = claude.hook({ ...event, session_id: id });
      expect(signals.some((signal) => signal.kind === 'session')).toBe(false);
      expect(signals.find((signal) => signal.kind === 'notice')?.text).toMatch(
        /invalid conversation id/,
      );
      expect(signals).toContainEqual({ kind: 'prompt', text: 'hello' });
    }
  });

  it('warns once per invalid native session id while still hearing every hook', () => {
    const claude = new ClaudeCode({ cwd: '/work/app', home: '/Users/me', env: {} });
    for (const id of ['bad-id', 'another-bad-id']) {
      const first = claude.hook({
        hook_event_name: 'UserPromptSubmit',
        session_id: id,
        prompt: 'hello',
      });
      expect(first.filter((signal) => signal.kind === 'notice')).toHaveLength(1);
      const later = claude.hook({
        hook_event_name: 'UserPromptSubmit',
        session_id: id,
        prompt: 'again',
      });
      expect(later.filter((signal) => signal.kind === 'notice')).toEqual([]);
      expect(later).toContainEqual({ kind: 'prompt', text: 'again' });
    }
  });
});

describe('a turn Claude Code could not finish', () => {
  it.each([
    ['rate_limit', 'usage-limit'],
    ['authentication_failed', 'auth'],
    ['billing_error', 'auth'],
    ['overloaded', 'api'],
    ['something_new', 'api'],
  ])('says why, from its StopFailure hook (%s)', (error, reason) => {
    const claude = new ClaudeCode({ cwd: '/work/app', home: '/Users/me', env: {} });
    const signals = claude.hook({
      hook_event_name: 'StopFailure',
      session_id: SESSION,
      error,
      error_details: 'What the API said',
    });
    expect(signals).toContainEqual({ kind: 'failed', why: 'What the API said', reason });
  });
});

/** What Claude Code asks, as its PermissionRequest hook tells it for `tool` with `input`. */
function asked(tool: string, input: Record<string, unknown>): TerminalAsk | undefined {
  const claude = new ClaudeCode({ cwd: '/work/app', home: '/Users/me', env: {} });
  const signals = claude.hook({
    hook_event_name: 'PermissionRequest',
    session_id: 's1',
    tool_name: tool,
    tool_input: input,
  });
  const ask = signals.find((signal) => signal.kind === 'ask');
  return ask?.kind === 'ask' ? ask.ask : undefined;
}

describe('a permission Claude Code asks for in its terminal', () => {
  it('says what it is for: the command in full, the edit’s diff, the new file’s start', () => {
    expect(asked('Bash', { command: 'npm test', description: 'Run the tests' })).toEqual({
      kind: 'permission',
      id: expect.any(String) as unknown,
      tool: 'Bash',
      summary: 'npm test',
    });
    expect(asked('Bash', { command: 'git add -A\ngit commit -m "Tests"' })).toMatchObject({
      summary: 'git add -A …',
      detail: { kind: 'output', text: 'git add -A\ngit commit -m "Tests"' },
    });
    expect(
      asked('Edit', {
        file_path: '/work/app/notes.txt',
        old_string: 'hello',
        new_string: 'hello world',
      }),
    ).toMatchObject({
      tool: 'Edit',
      summary: 'notes.txt',
      detail: {
        kind: 'diff',
        added: 1,
        removed: 1,
        lines: [
          { kind: 'remove', text: 'hello' },
          { kind: 'add', text: 'hello world' },
        ],
      },
    });

    // A long file shows its start: the card is a preview, the terminal shows it all.
    const content = Array.from({ length: 30 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    const write = asked('Write', { file_path: '/work/app/src/long.ts', content });
    expect(write).toMatchObject({ tool: 'Write', summary: path.join('src', 'long.ts') });
    const detail = write?.kind === 'permission' ? write.detail : undefined;
    expect(detail?.kind === 'diff' && detail.added).toBe(30);
    expect(detail?.kind === 'diff' && detail.lines.map((line) => line.text)).toEqual([
      ...Array.from({ length: 12 }, (_, i) => `line ${String(i + 1)}`),
      '… (18 more lines)',
    ]);
  });
});

/** What Claude Code waits on in its terminal, as the core's prompt, as hook `event` tells it. */
function raisedBy(
  event: 'PermissionRequest' | 'PreToolUse',
  tool: string,
  input: unknown,
): AdapterPrompt | undefined {
  const claude = new ClaudeCode({ cwd: '/work/app', home: '/Users/me', env: {} });
  const signals = claude.hook({
    hook_event_name: event,
    session_id: SESSION,
    tool_name: tool,
    tool_input: input,
    tool_use_id: 'toolu_1',
  });
  const ask = signals.find((signal) => signal.kind === 'ask');
  return ask?.kind === 'ask' ? ask.prompt : undefined;
}

describe('what Claude Code asks in its terminal, as the core’s prompt (B13 C6)', () => {
  it('raises a permission with its hook’s tool and input, answered in its terminal, with no choice of corrallm’s', () => {
    const edit = {
      file_path: '/work/app/notes.txt',
      old_string: 'hello',
      new_string: 'hello world',
    };
    expect(raisedBy('PermissionRequest', 'Edit', edit)).toEqual({
      kind: 'approval',
      title: 'Claude wants to use Edit',
      summary: 'notes.txt',
      subject: { type: 'tool', tool: 'Edit', input: edit },
      detail: {
        kind: 'diff',
        added: 1,
        removed: 1,
        lines: [
          { kind: 'remove', text: 'hello' },
          { kind: 'add', text: 'hello world' },
        ],
      },
      answerIn: 'terminal',
      choices: [],
    });
    // What it would do, in twelve lines at most, marked cut: the terminal shows it all.
    const content = Array.from({ length: 30 }, (_, i) => `line ${String(i + 1)}`).join('\n');
    const write = raisedBy('PermissionRequest', 'Write', {
      file_path: '/work/app/src/long.ts',
      content,
    });
    expect(write).toMatchObject({ cut: true, subject: { input: { content } } });
    expect(
      write?.kind === 'approval' && write.detail?.kind === 'diff' && write.detail.lines,
    ).toEqual([
      ...Array.from({ length: 11 }, (_, i) => ({ kind: 'add', text: `line ${String(i + 1)}` })),
      { kind: 'same', text: '… (19 more lines)' },
    ]);
    // An input past its bound, a command's too, is a marked preview: nothing it asks is declined.
    const huge = 'x'.repeat(70_000);
    for (const [tool, input] of [
      ['Write', { file_path: '/work/app/big.txt', content: huge }],
      ['Bash', { command: `echo ${huge}` }],
    ] as const) {
      const prompt = raisedBy('PermissionRequest', tool, input);
      expect(prompt, tool).toMatchObject({ kind: 'approval', cut: true, answerIn: 'terminal' });
      const subject = prompt?.kind === 'approval' ? prompt.subject : undefined;
      expect(subject?.type === 'tool' && typeof subject.input).toBe('string');
      expect(JSON.stringify(prompt).length).toBeLessThan(20_000);
    }
  });

  it('raises AskUserQuestion’s questions by ids of corrallm’s, and ExitPlanMode’s plan; what it can’t read describes nothing', () => {
    const questions = {
      questions: [
        {
          question: 'Pick a color',
          header: 'Color',
          options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue' }],
          multiSelect: false,
        },
        {
          question: 'Which sizes?',
          header: 'Size',
          options: [{ label: 'S' }, { label: 'M' }],
          multiSelect: true,
        },
      ],
    };
    for (const event of ['PreToolUse', 'PermissionRequest'] as const) {
      expect(raisedBy(event, 'AskUserQuestion', questions), event).toEqual({
        kind: 'question',
        title: 'Claude asks 2 questions',
        answerIn: 'terminal',
        questions: [
          {
            id: 'q1',
            header: 'Color',
            text: 'Pick a color',
            options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue' }],
            multiple: false,
            other: true,
          },
          {
            id: 'q2',
            header: 'Size',
            text: 'Which sizes?',
            options: [{ label: 'S' }, { label: 'M' }],
            multiple: true,
            other: true,
          },
        ],
      });
    }
    expect(raisedBy('PreToolUse', 'ExitPlanMode', { plan: '## Plan\nShip it.' })).toEqual({
      kind: 'plan',
      title: 'Approve Claude’s plan?',
      plan: '## Plan\nShip it.',
      answerIn: 'terminal',
      choices: [],
    });
    // Nothing it can read: its report's words say what it waits for instead.
    expect(raisedBy('PreToolUse', 'AskUserQuestion', { questions: 'Pick one' })).toBeUndefined();
    expect(raisedBy('PreToolUse', 'ExitPlanMode', { plan: '   ' })).toBeUndefined();
  });
});
