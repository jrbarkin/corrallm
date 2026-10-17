import { describe, expect, it } from 'vitest';

import { parseArgs, report } from './cli';
import type { Delegation } from './delegate';

const THREAD = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('parseArgs', () => {
  it('reads a task and where Codex works on it, defaulting to a sandboxed new thread', () => {
    expect(parseArgs(['--cwd', '/work/tree', 'Make', 'the', 'tests', 'pass'])).toEqual({
      kind: 'task',
      cwd: '/work/tree',
      text: 'Make the tests pass',
      file: null,
      resume: null,
      model: null,
      effort: null,
      mode: 'auto',
      yes: false,
      chatgptPlan: false,
      timeoutMs: 60 * 60_000,
    });
  });

  it('takes the separator pnpm passes on, and every option', () => {
    expect(
      parseArgs([
        '--',
        '--cwd=/w',
        '--resume',
        THREAD,
        '--model',
        'gpt-6.1-sol',
        '--effort',
        'high',
        '--read-only',
        '--yes',
        '--chatgpt-plan',
        '--timeout',
        '5',
        '--file',
        'task.md',
      ]),
    ).toMatchObject({
      cwd: '/w',
      file: 'task.md',
      text: '',
      resume: THREAD,
      model: 'gpt-6.1-sol',
      effort: 'high',
      mode: 'read-only',
      yes: true,
      chatgptPlan: true,
      timeoutMs: 5 * 60_000,
    });
  });

  it('lists the models, or says how to use it', () => {
    expect(parseArgs(['--models', '--cwd', '/w'])).toEqual({ kind: 'models', cwd: '/w' });
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
  });

  it.each([
    [['Do it'], /--cwd/],
    [['--cwd', '/w'], /task/],
    [['--cwd', '/w', '--file', 'a.md', 'and more'], /task/],
    [['--cwd', '/w', '--resume=--dangerously-bypass-approvals-and-sandbox', 'go'], /thread/],
    [['--cwd', '/w', '--model=-c', 'go'], /model/],
    [['--cwd', '/w', '--effort', 'HIGH; rm', 'go'], /effort/],
    [['--cwd', '/w', '--timeout', '0', 'go'], /timeout/],
    [['--cwd', '/w', '--full-access', 'go'], /full-access/],
  ])('refuses %j', (args, why) => {
    expect(() => parseArgs(args)).toThrow(why);
  });
});

function delegation(more: Partial<Delegation> = {}): Delegation {
  return {
    outcome: 'completed',
    thread: THREAD,
    model: 'gpt-6.1-sol',
    effort: 'high',
    reply: 'Done: the tests pass.',
    result: { status: 'completed', reason: 'completed' },
    notices: [],
    limits: [{ name: '5h', usedPercent: 12, resetsAt: null }],
    seconds: 134,
    ...more,
  };
}

describe('report', () => {
  it('says how the turn went, how to continue it, what Codex said and what changed', () => {
    const text = report(delegation(), ' M src/a.ts\n?? src/b.ts\n');
    expect(text).toContain('Codex completed in 2m 14s');
    expect(text).toContain(`--resume ${THREAD}`);
    expect(text).toContain('gpt-6.1-sol (high)');
    expect(text).toContain('5h 12%');
    expect(text).toContain('Done: the tests pass.');
    expect(text).toContain(' M src/a.ts\n?? src/b.ts');
  });

  it('puts what Codex asked first, where it stopped on it', () => {
    const text = report(
      delegation({ outcome: 'asked', asked: 'Codex wants to reach registry.npmjs.org' }),
      '',
    );
    expect(text.split('\n')[0]).toMatch(/stopped to ask/);
    expect(text).toContain('Codex wants to reach registry.npmjs.org');
    expect(text).toContain('No changes.');
  });

  it("says when Codex kept no thread, so there's nothing to continue", () => {
    expect(report(delegation({ outcome: 'failed', thread: null }), '')).not.toContain('--resume');
  });
});
