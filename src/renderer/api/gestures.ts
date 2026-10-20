import type { GuiOp } from '../../shared/api/surface';

/** GUI operations deliberately lacking a renderer gesture; T6 requires a reason for each. */
export const NO_GESTURE = {
  'window.show': 'B9 task 13 adds the Canvases list’s show gesture.',
  'agent.setType': 'B9 task 12 moves this renderer edit onto the core operation.',
  'agent.setConnection': 'B9 task 12 moves this renderer edit onto the core operation.',
  'agent.setSettings': 'B9 task 12 moves this renderer edit onto the core operation.',
  'agent.setRole': 'B9 task 12 moves this renderer edit onto the core operation.',

  'canvas.batch': 'Several edits as one commit, for tokens: no gesture of the window’s is one.',
  'canvas.open': 'B9 task 12 moves Open from the canvas:open channel onto this operation.',
  'canvas.save': 'B9 task 12 moves Save from the canvas:save channel onto this operation.',
  'canvas.saveAs': 'B9 task 12 moves Save As from the canvas:save channel onto this operation.',
  'canvas.close': 'B9 task 13’s Canvases list closes a canvas with it.',
  'project.choose':
    'B9 task 12 moves choosing the folder from the project:choose channel onto this operation.',
  reply: 'B9’s proposal cards in the Needs you sidebar (the worker’s task 13) answer with it.',
} satisfies Partial<Record<GuiOp, string>>;
