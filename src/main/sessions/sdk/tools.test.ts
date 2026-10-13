import { describe, expect, it } from 'vitest';

import { displayPath, resultDetail, toolSummary } from './tools';

const places = { cwd: '/home/user/shop', home: '/home/user' };

describe('displayPath', () => {
  it('shows paths in the project folder relative to it, and the home folder as ~', () => {
    expect(displayPath('/home/user/shop/src/a.ts', places)).toBe('src/a.ts');
    expect(displayPath('/home/user/.claude/plans/p.md', places)).toBe('~/.claude/plans/p.md');
    expect(displayPath('/etc/hosts', places)).toBe('/etc/hosts');
  });

  it('knows the project folder by its real path too (the CLI works in that)', () => {
    const linked = { cwd: '/tmp/shop', realCwd: '/private/tmp/shop', home: '/home/user' };
    expect(displayPath('/private/tmp/shop/notes.txt', linked)).toBe('notes.txt');
    expect(displayPath('/tmp/shop/notes.txt', linked)).toBe('notes.txt');
  });
});

describe('toolSummary', () => {
  it('says what each tool acts on', () => {
    expect(toolSummary('Bash', { command: 'npm test\nnpm run lint' }, places)).toBe('npm test …');
    expect(toolSummary('Grep', { pattern: 'TODO', path: '/home/user/shop/src' }, places)).toBe(
      'TODO in src',
    );
    expect(toolSummary('WebFetch', { url: 'https://example.com' }, places)).toBe(
      'https://example.com',
    );
    expect(toolSummary('mcp__github__get_issue', { repo: 'a/b', number: 3 }, places)).toBe('a/b');
  });
});

describe('resultDetail', () => {
  it('shows a command’s output and errors together', () => {
    expect(resultDetail('Bash', {}, { stdout: 'built', stderr: 'warning: slow' }, 'built')).toEqual(
      { kind: 'output', text: 'built\nwarning: slow' },
    );
  });

  it('cuts very long output', () => {
    const detail = resultDetail('Grep', {}, undefined, 'x'.repeat(50_000));
    expect(detail?.kind === 'output' && detail.text).toMatch(/… \(10000 more characters\)$/);
  });
});
