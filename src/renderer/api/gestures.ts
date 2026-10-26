import type { GuiOp } from '../../shared/api/surface';

/** GUI operations deliberately lacking a renderer gesture; T6 requires a reason for each. */
export const NO_GESTURE = {
  'worktree.remove': 'B9a X14 supplies the kept-worktrees Remove gesture.',
  'worktree.retry': 'B9a X14 supplies the held worktree’s Retry gesture.',
  'canvas.batch': 'Several edits as one commit, for tokens: no gesture of the window’s is one.',
  'project.setSetupCommand':
    'Its project setup settings come with B9a X14’s worktree UI; until then no window sets it.',
  'project.clearSetupApproval':
    'Its project setup settings come with B9a X14’s worktree UI; until then no window clears it.',
} satisfies Partial<Record<GuiOp, string>>;
