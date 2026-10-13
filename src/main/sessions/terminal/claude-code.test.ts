import { describe, expect, it } from 'vitest';

import type { TerminalAsk } from '../../../shared/session';
import { ClaudeCode } from './claude-code';

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
