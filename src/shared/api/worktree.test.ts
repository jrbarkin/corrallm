import { describe, expect, it } from 'vitest';

import type { OpDef } from './define';
import { idsIn } from './ids';
import { OPS, opsFor } from './registry';
import { PARTIES, SURFACE, Y } from './surface';

const canvas = '11111111-1111-4111-8111-111111111111';
const worktree = '22222222-2222-4222-8222-222222222222';

describe('the kept-worktree removal contract', () => {
  it('registers C7’s destructive command for the human alone', () => {
    expect(SURFACE).toHaveProperty('worktree.remove', {
      access: Y,
      kind: 'command',
      scope: 'canvas',
      rules: ['discard'],
      destructive: true,
    });
    for (const party of PARTIES)
      expect(opsFor(SURFACE, party).includes('worktree.remove')).toBe(party === 'you');
  });

  it('takes only bounded canvas and worktree ids, exposing both to reach', () => {
    const op = (OPS as Readonly<Record<string, OpDef>>)['worktree.remove'];
    expect(op).toBeDefined();
    if (op === undefined) return;
    const args = op.input.parse({ canvas, worktree });
    expect(idsIn(op.input, args)).toEqual([
      { brand: 'CanvasId', id: canvas, path: '.canvas' },
      { brand: 'WorktreeId', id: worktree, path: '.worktree' },
    ]);
    for (const invalid of [
      {},
      { canvas },
      { canvas, worktree: '/a/checkout' },
      { canvas, worktree: 'x'.repeat(4096) },
      { canvas: 'not-a-canvas', worktree },
      { canvas, worktree, force: true },
      { canvas, worktree, path: '/a/checkout' },
    ])
      expect(op.input.safeParse(invalid).success).toBe(false);
    expect(op.output.safeParse({ removed: true, revs: {} }).success).toBe(true);
    expect(op.output.safeParse({ removed: false, retained: true, revs: {} }).success).toBe(true);
    expect(op.output.safeParse(true).success).toBe(false);
  });
});
