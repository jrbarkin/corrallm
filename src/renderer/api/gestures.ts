import type { GuiOp } from '../../shared/api/surface';

/** GUI operations deliberately lacking a renderer gesture; T6 requires a reason for each. */
export const NO_GESTURE = {
  'canvas.batch': 'Several edits as one commit, for tokens: no gesture of the window’s is one.',
} satisfies Partial<Record<GuiOp, string>>;
