import { describe, expect, it } from 'vitest';

import { displayPath, output, replacement, resetTime, unifiedDiff, usageLimit } from './transcript';

describe('the transcript’s words, shared by every connection', () => {
  it('shows paths in the project folder relative to it, and the home folder as ~', () => {
    const places = { cwd: '/home/user/shop', home: '/home/user' };
    expect(displayPath('/home/user/shop/src/a.ts', places)).toBe('src/a.ts');
    expect(displayPath('/home/user/.codex/AGENTS.md', places)).toBe('~/.codex/AGENTS.md');
  });

  it('cuts very long output', () => {
    const cut = output('x'.repeat(50_000));
    expect(cut.kind === 'output' && cut.text).toMatch(/… \(10000 more characters\)$/);
  });

  it('reads a unified diff: its hunks’ lines, "…" between hunks, its headers left out', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 3b18e51..b6fc4c6 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,3 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      '@@ -10,2 +10,3 @@ function f() {',
      '   return a;',
      '+  // done',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    expect(unifiedDiff(diff)).toEqual({
      kind: 'diff',
      added: 2,
      removed: 1,
      lines: [
        { kind: 'same', text: 'const a = 1;' },
        { kind: 'remove', text: 'const b = 2;' },
        { kind: 'add', text: 'const b = 3;' },
        { kind: 'same', text: '…' },
        { kind: 'same', text: '  return a;' },
        { kind: 'add', text: '  // done' },
      ],
    });
  });

  it('shows a new file as every line added', () => {
    expect(replacement('', 'hi\nthere\n')).toMatchObject({ added: 2, removed: 0 });
  });

  it('says when a limit resets (a time, or a day and time), and names its window', () => {
    const at = new Date(2026, 9, 12, 15, 4).getTime() / 1000;
    expect(resetTime(at, { timeOnly: true })).toMatch(/04/);
    expect(resetTime(at, { timeOnly: true })).not.toMatch(/,/);
    expect(resetTime(at)).toMatch(/12.*,.*04/);
    expect(usageLimit({ usedPercent: 100, windowMinutes: 300, resetsAt: at })).toEqual({
      name: '5h',
      usedPercent: 100,
      resetsAt: at * 1000,
    });
    expect(usageLimit({ usedPercent: 3, windowMinutes: 10_080, resetsAt: null })).toEqual({
      name: 'weekly',
      usedPercent: 3,
      resetsAt: null,
    });
    expect(usageLimit({ usedPercent: 50, windowMinutes: 90, resetsAt: null }).name).toBe('90m');
  });
});
