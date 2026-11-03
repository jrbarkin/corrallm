import type { GuiOp } from '../../shared/api/surface';

/** GUI operations deliberately lacking a renderer gesture; T6 requires a reason for each. */
export const NO_GESTURE = {
  agents: 'The canvas topic supplies agents; no renderer gesture requests this listing.',
  status:
    'The run, session summaries and Needs topics supply status; no renderer gesture polls it.',
  'canvas.batch': 'Several edits as one commit, for tokens: no gesture of the window’s is one.',
} satisfies Partial<Record<GuiOp, string>>;
