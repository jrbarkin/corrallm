import type { GuiOp } from '../../shared/api/surface';

/** GUI operations deliberately lacking a renderer gesture; T6 requires a reason for each. */
export const NO_GESTURE = {
  agents: 'The canvas topic supplies agents; no renderer gesture requests this listing.',
  status:
    'The run, session summaries and Needs topics supply status; no renderer gesture polls it.',
  'canvas.batch': 'Several edits as one commit, for tokens: no gesture of the window’s is one.',
  // B24 C1 registers them; their sheets are B24 X2's (the settings sheet's Lead section) and X3's
  // (the canvas menu's outside orchestrators), which remove these rows.
  'agent.setLead':
    'The settings sheet’s Lead section (B24 X2) is its gesture; until it lands, none calls it.',
  'outside.setGrant':
    'The canvas menu’s outside orchestrators sheet (B24 X3) is its gesture; until it lands, none calls it.',
} satisfies Partial<Record<GuiOp, string>>;
