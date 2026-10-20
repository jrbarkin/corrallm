import type { GuiOp } from '../../shared/api/surface';

/** GUI operations deliberately lacking a renderer gesture; T6 requires a reason for each. */
export const NO_GESTURE = {
  'canvas.rename':
    'The canvas’s rename still edits the renderer’s graph; B9’s gestures move onto the core’s operations together.',
} satisfies Partial<Record<GuiOp, string>>;
