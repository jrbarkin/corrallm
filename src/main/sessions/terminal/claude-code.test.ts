import { describe, expect, it } from 'vitest';

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
      promptSnapshot: true,
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
      expect(signals).toContainEqual({ kind: 'prompt', text: 'hello' });
    }
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
    expect(write).toMatchObject({ tool: 'Write', summary: 'src/long.ts' });
    const detail = write?.kind === 'permission' ? write.detail : undefined;
    expect(detail?.kind === 'diff' && detail.added).toBe(30);
    expect(detail?.kind === 'diff' && detail.lines.map((line) => line.text)).toEqual([
      ...Array.from({ length: 12 }, (_, i) => `line ${String(i + 1)}`),
      '… (18 more lines)',
    ]);
  });
});
