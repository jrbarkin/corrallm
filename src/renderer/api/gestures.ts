import type { GuiOp } from '../../shared/api/surface';

/** GUI operations deliberately lacking a renderer gesture; T6 requires a reason for each. */
export const NO_GESTURE = {
  'window.show': 'B9 task 13 adds the Canvases list’s show gesture.',
  'canvas.batch': 'Several edits as one commit, for tokens: no gesture of the window’s is one.',
  'canvas.close': 'B9 task 13’s Canvases list closes a canvas with it.',
  reply: 'B9’s proposal cards in the Needs you sidebar (the worker’s task 13) answer with it.',
} satisfies Partial<Record<GuiOp, string>>;
