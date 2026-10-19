import type { GuiOp } from '../../shared/api/surface';

/** GUI operations deliberately lacking a renderer gesture; T6 requires a reason for each. */
export const NO_GESTURE = {} satisfies Partial<Record<GuiOp, string>>;
