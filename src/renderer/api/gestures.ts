import type { GuiOp } from '../../shared/api/surface';

/** GUI operations deliberately lacking a renderer gesture; T6 requires a reason for each. */
export const NO_GESTURE = {
  'canvas.batch': 'Several edits as one commit, for tokens: no gesture of the window’s is one.',
  'project.setSetupCommand':
    'Its project setup settings come with B9a X14’s worktree UI; until then no window sets it.',
  'project.clearSetupApproval':
    'Its project setup settings come with B9a X14’s worktree UI; until then no window clears it.',
} satisfies Partial<Record<GuiOp, string>>;
