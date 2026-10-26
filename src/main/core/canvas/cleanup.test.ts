import { describe, expect, it } from 'vitest';

import type { NeedId } from '../../../shared/api/ids';
import type { CanvasId } from '../../../shared/canvas';
import { fingerprint, heldFingerprint } from '../workspaces/cleanup';
import type { TreeState } from '../workspaces/cleanup';
import { workspaceSafety } from './commit';
import { itemOf, keptWords } from './proposals';
import type { Proposal } from './proposals';

const tree = (more: Partial<TreeState> = {}): TreeState => ({
  workspace: 'tree',
  head: 'a'.repeat(40),
  tip: 'a'.repeat(40),
  changed: 1,
  untracked: 0,
  paths: ['notes.md'],
  merged: true,
  writers: [],
  setup: false,
  status: 'changed',
  ...more,
});

function proposal(trees: TreeState[], op = 'canvas.delete'): Proposal {
  return {
    id: 'proposal/11111111-1111-4111-8111-111111111111' as NeedId,
    canvas: '22222222-2222-4222-8222-222222222222' as CanvasId,
    op,
    args: {},
    by: 'you',
    touched: {},
    lost: {
      what: 'delete Builder',
      title: 'Delete Builder?',
      detail: trees.map(keptWords).join(' '),
    },
    cleanup: { trees },
    at: 1,
  };
}

describe('cleanup choices for a tree that cannot be read whole', () => {
  it.each(['more of its files than corrallm reads', 'its submodule is checked out', 'unreadable'])(
    'offers keeping work, with its reason, for %s',
    (unknown) => {
      const state = tree({ unknown });
      const deletion = itemOf(proposal([state]));
      expect(deletion.choices.map(({ value }) => value)).toEqual(['allow', 'refuse']);
      expect(deletion.detail).toContain(unknown);
      expect(deletion.detail).toContain('whether it changed since you were asked');
      expect(deletion.detail).toContain('remove it yourself if you mean to');
      const kept = itemOf(proposal([state], 'worktree.remove'));
      expect(kept.choices.map(({ value, label }) => ({ value, label }))).toEqual([
        { value: 'refuse', label: 'Keep it' },
      ]);
    },
  );

  it('offers no Discard for a batch with even one unread tree', () => {
    const item = itemOf(proposal([tree(), tree({ workspace: 'other', unknown: 'unreadable' })]));
    expect(item.choices.map(({ value }) => value)).toEqual(['allow', 'refuse']);
  });

  it('gives an older unread-tree question the current Keep-only explanation', () => {
    const older = proposal([tree({ unknown: 'unreadable' })]);
    older.lost.detail =
      'corrallm can’t tell what its worktree holds (unreadable): it is kept unless you discard it.';
    const item = itemOf(older);
    expect(item.detail).toContain('whether it changed since you were asked');
    expect(item.detail).not.toContain('unless you discard');
  });

  it('still offers Discard for a whole tree holding work', () => {
    expect(itemOf(proposal([tree()])).choices.map(({ value }) => value)).toEqual([
      'allow',
      'discard',
      'refuse',
    ]);
    expect(itemOf(proposal([tree()], 'worktree.remove')).choices.map(({ value }) => value)).toEqual(
      ['discard', 'refuse'],
    );
  });
});

describe('cleanup decisions at commit', () => {
  it('refuses Discard for an unread tree, including an answer offered before it became unreadable', () => {
    const whole = tree();
    const unread = tree({ unknown: 'unreadable' });
    for (const asked of [unread, whole]) {
      expect(() =>
        workspaceSafety([unread], {
          choice: 'discard',
          fingerprints: { tree: fingerprint(asked) },
        }),
      ).toThrow(expect.objectContaining({ code: 'refused' }));
    }
  });

  it('accepts Keep for an unread tree without recording any removal', () => {
    const unread = tree({ unknown: 'unreadable' });
    expect(
      workspaceSafety([unread], {
        choice: 'keep',
        fingerprints: { tree: fingerprint(unread) },
      }),
    ).toEqual({ removals: new Map() });
  });

  it('accepts a whole unchanged tree’s Discard', () => {
    const whole = tree();
    expect(
      workspaceSafety([whole], {
        choice: 'discard',
        fingerprints: { tree: fingerprint(whole) },
      }),
    ).toEqual({
      removals: new Map([
        [
          'tree',
          {
            branch: true,
            force: true,
            approved: heldFingerprint(whole),
            tip: whole.tip,
          },
        ],
      ]),
    });
  });
});
