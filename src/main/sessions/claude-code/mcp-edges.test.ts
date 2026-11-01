import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * B21 C3b (held back, private until the findings are fixed): Claude · Terminal's mention edges,
 * recorded with Claude Code 2.1.316 against a local stub model; replayed from
 * fixtures/mcp-entry.json (mentions.edges). Not yet run by vitest (written outside a worktree).
 */

interface Fixture {
  mentions: {
    edges: {
      midWordAbsolute: Record<string, number>;
      homeVariable: Record<string, number>;
      tilde: Record<string, number>;
      symlinkInProjectToOutside: Record<string, number>;
      absoluteHomeControl: Record<string, number>;
      terminalTypedSymlink: { seen: Record<string, number>; screen: Record<string, boolean> };
    };
  };
}
const { edges } = (
  JSON.parse(
    readFileSync(path.join(import.meta.dirname, 'fixtures', 'mcp-entry.json'), 'utf8'),
  ) as Fixture
).mentions;

describe("Claude · Terminal's mention edges (B21 C3b)", () => {
  it('reads an absolute path under the home folder, and expands a leading ~ to it', () => {
    expect(edges.absoluteHomeControl).toEqual({ 'OUTSIDE-CANARY-HOME': 1 });
    expect(edges.tilde).toEqual({ 'OUTSIDE-CANARY-HOME': 1 });
  });

  it('does not expand $HOME, nor an @ in the middle of a word', () => {
    expect(edges.homeVariable).toEqual({});
    expect(edges.midWordAbsolute).toEqual({});
  });

  it('follows a symlink in the project to a file outside it, without asking', () => {
    expect(edges.symlinkInProjectToOutside).toEqual({ 'OUTSIDE-CANARY-LINE': 3 });
    expect(edges.terminalTypedSymlink.seen).toEqual({ 'OUTSIDE-CANARY-LINE': 3 });
    expect(edges.terminalTypedSymlink.screen).toEqual({
      'Read link': true,
      'Do you want to proceed?': false,
    });
  });
});
