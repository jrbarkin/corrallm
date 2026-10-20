import type { GuiOp } from '../../shared/api/surface';

/** GUI operations deliberately lacking a renderer gesture; T6 requires a reason for each. */
export const NO_GESTURE = {
  'agent.setType': 'B9 task 12 moves this renderer edit onto the core operation.',
  'agent.setConnection': 'B9 task 12 moves this renderer edit onto the core operation.',
  'agent.setSettings': 'B9 task 12 moves this renderer edit onto the core operation.',
  'agent.setRole': 'B9 task 12 moves this renderer edit onto the core operation.',
  'queue.add': 'B9 task 11 moves this renderer edit onto the core operation.',
  'queue.remove': 'B9 task 11 moves this renderer edit onto the core operation.',
  'queue.move': 'B9 task 11 moves this renderer edit onto the core operation.',
  'queue.update': 'B9 task 11 moves this renderer edit onto the core operation.',

  'canvas.addAgent': 'B9 task 10 moves agent creation from the renderer graph onto this operation.',
  'canvas.spawnAgent': 'B9 task 10 moves spawning from the renderer graph onto this operation.',
  'canvas.delete': 'B9 task 10 moves deletion from the renderer graph onto this operation.',
  'canvas.link': 'B9 task 10 moves link drawing from the renderer graph onto this operation.',
  'canvas.unlink': 'B9 task 10 moves link removal from the renderer graph onto this operation.',
  'canvas.group': 'B9 task 10 moves grouping from the renderer graph onto this operation.',
  'canvas.ungroup': 'B9 task 10 moves ungrouping from the renderer graph onto this operation.',
  'canvas.addParent':
    'B9 task 10 moves adding a parent from the renderer graph onto this operation.',
  'canvas.move': 'B9 task 10 moves dragging from the renderer graph onto this operation.',
  'canvas.rename':
    'The canvas’s rename still edits the renderer’s graph; B9’s gestures move onto the core’s operations together.',
} satisfies Partial<Record<GuiOp, string>>;
