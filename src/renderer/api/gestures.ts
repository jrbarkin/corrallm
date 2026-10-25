import type { GuiOp } from '../../shared/api/surface';

/** GUI operations deliberately lacking a renderer gesture; T6 requires a reason for each. */
export const NO_GESTURE = {
  'session.interrupt': 'B11 X13 rewires the session Stop control.',
  'run.pause': 'B11 X12 rewires the run pause controls.',
  'run.kill': 'B11 X12 rewires Kill.',
  'run.unpause': 'B11 X12 rewires Resume.',
  'run.start': 'B11 X12 rewires Run and Run again; the renderer runs its own run until then.',
  'run.stop': 'B11 X12 rewires the run’s Stop; the renderer runs its own run until then.',
  'run.resume': 'B11 X12 rewires the run’s Resume; the renderer runs its own run until then.',
  'run.goOn': 'B11 X12 rewires Go on now; the renderer runs its own run until then.',
  'session.open': 'B11 X13 rewires the agent window to this operation.',
  'session.setMode': 'B11 X13 rewires the composer mode picker.',
  'session.setModel': 'B11 X13 rewires the composer model picker.',
  'session.setEffort': 'B11 X13 rewires the composer effort picker.',
  'session.stopTask': 'B11 X13 rewires the background task controls.',
  'session.restart': 'B11 X13 rewires Restart with these.',
  'session.newConversation': 'B11 X13 rewires New conversation.',
  'session.rewindPreview': 'B11 X13 rewires the rewind preview.',
  'session.rewind': 'B11 X13 rewires the rewind action.',
  'session.continueIn': 'B11 X13 rewires Continue in Terminal.',
  'canvas.batch': 'Several edits as one commit, for tokens: no gesture of the window’s is one.',
  'project.setSetupCommand':
    'Its project setup settings come with B9a X14’s worktree UI; until then no window sets it.',
  'project.clearSetupApproval':
    'Its project setup settings come with B9a X14’s worktree UI; until then no window clears it.',
} satisfies Partial<Record<GuiOp, string>>;
