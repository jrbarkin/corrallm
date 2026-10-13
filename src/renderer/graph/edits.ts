import type { QueueEntry } from './QueueEditor';
import type { Condition, WaitTarget } from './queue';

/** What changes a queue, by agent (`owner`): what every queue's editor does to it. */
export interface QueueEdits {
  /** `into`: the id of the if-then to add a step or message to. */
  add: (owner: string, entry: QueueEntry, into?: string) => void;
  remove: (owner: string, itemId: string) => void;
  move: (owner: string, itemId: string, index: number) => void;
  retarget: (owner: string, itemId: string, target: string | undefined) => void;
  editMessage: (owner: string, itemId: string, message: string) => void;
  setCondition: (owner: string, ifId: string, condition: Condition) => void;
  setWaitFor: (owner: string, waitId: string, targets: WaitTarget[]) => void;
}

/** One agent's queue edits, as a queue's editor takes them (QueueEditor, QueueRow). */
export function editsOf(edits: QueueEdits, owner: string) {
  return {
    onAdd: (entry: QueueEntry, into?: string) => {
      edits.add(owner, entry, into);
    },
    onRemove: (itemId: string) => {
      edits.remove(owner, itemId);
    },
    onMove: (itemId: string, index: number) => {
      edits.move(owner, itemId, index);
    },
    onRetarget: (itemId: string, target: string | undefined) => {
      edits.retarget(owner, itemId, target);
    },
    onEditMessage: (itemId: string, message: string) => {
      edits.editMessage(owner, itemId, message);
    },
    onCondition: (ifId: string, condition: Condition) => {
      edits.setCondition(owner, ifId, condition);
    },
    onWaitFor: (waitId: string, targets: WaitTarget[]) => {
      edits.setWaitFor(owner, waitId, targets);
    },
  };
}
