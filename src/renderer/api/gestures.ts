import type { GuiOp } from '../../shared/api/surface';

/** GUI operations deliberately lacking a renderer gesture; T6 requires a reason for each. */
export const NO_GESTURE = {
  'window.show': 'B9 task 13 adds the Canvases list’s show gesture.',
  'agent.setType': 'B9 task 12 moves this renderer edit onto the core operation.',
  'agent.setConnection': 'B9 task 12 moves this renderer edit onto the core operation.',
  'agent.setSettings': 'B9 task 12 moves this renderer edit onto the core operation.',
  'agent.setRole': 'B9 task 12 moves this renderer edit onto the core operation.',
  'queue.add': 'B9 task 11 moves this renderer edit onto the core operation.',
  'queue.remove': 'B9 task 11 moves this renderer edit onto the core operation.',
  'queue.move': 'B9 task 11 moves this renderer edit onto the core operation.',
  'queue.update': 'B9 task 11 moves this renderer edit onto the core operation.',

  'canvas.batch': 'Several edits as one commit, for tokens: no gesture of the window’s is one.',
  reply: 'B9’s proposal cards in the Needs you sidebar (the worker’s task 13) answer with it.',
} satisfies Partial<Record<GuiOp, string>>;
