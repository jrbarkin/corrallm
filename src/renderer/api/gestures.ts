import type { GuiOp } from '../../shared/api/surface';

/** GUI operations deliberately lacking a renderer gesture; T6 requires a reason for each. */
export const NO_GESTURE = {
  'branch.diff': 'B9b X3 builds Review changes; no renderer gesture reads a branch yet.',
  'branch.merge': 'B9b X3 builds Merge into the picked branch; no renderer gesture merges yet.',
  agents: 'The canvas topic supplies agents; no renderer gesture requests this listing.',
  status:
    'The run, session summaries and Needs topics supply status; no renderer gesture polls it.',
  'canvas.batch': 'Several edits as one commit, for tokens: no gesture of the window’s is one.',
  'agent.setFallback':
    'The chain picker on the model chip and in Agent settings (B11a X4) is not built yet.',
  'agent.setHandoff': 'The handoff tile’s gear menu (B11a X4) is not built yet.',
  'session.handoff': 'The handoff tile, which opens the text (B11a X4), is not built yet.',
} satisfies Partial<Record<GuiOp, string>>;
