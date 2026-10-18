import type { Answer } from '../run/runner';
import type { QueueEntry } from './QueueEditor';
import type { Condition, QueueRepeat, QueueStep, Time, WaitTarget } from '../../shared/model/queue';

/** What changes about a repeat: when it stops, how many rounds it runs at most, and then what. */
export type RepeatChange = Partial<Pick<QueueRepeat, 'until' | 'rounds' | 'otherwise'>>;

/**
 * What changes a queue, by agent (`owner`): what every queue's editor does to it. And what acts on
 * the queues' run from a queue's rows (`goOn`, `decide`), so every view of a queue has its run
 * controls.
 */
export interface QueueEdits {
  /** `into`: the id of the if-then or repeat to add to. */
  add: (owner: string, entry: QueueEntry, into?: string) => void;
  remove: (owner: string, itemId: string) => void;
  move: (owner: string, itemId: string, index: number) => void;
  retarget: (owner: string, itemId: string, target: string | undefined) => void;
  editMessage: (owner: string, itemId: string, message: string) => void;
  /** What a step is to do, in the user's words ('' takes it off). */
  setInstruction: (owner: string, itemId: string, instruction: string) => void;
  /** Whether a step is expected to fail ('fails'), or (undefined) to succeed. */
  setExpect: (owner: string, itemId: string, expect: QueueStep['expect']) => void;
  setCondition: (owner: string, ifId: string, condition: Condition) => void;
  setWaitFor: (owner: string, waitId: string, targets: WaitTarget[]) => void;
  /** A delay's time, or a wait's time limit (`undefined` takes the limit off). */
  setTime: (owner: string, itemId: string, time: Time | undefined) => void;
  /** What an OK is on, in the user's words ('' for the work before it). */
  setApproval: (owner: string, okId: string, approve: string) => void;
  /** When a repeat stops, how many rounds it runs at most, or what it does after the last. */
  setRepeat: (owner: string, repeatId: string, change: RepeatChange) => void;
  /** Ends now the hold the run has the agent at, `itemId`: a delay, or a wait (Go on now). */
  goOn: (owner: string, itemId: string) => void;
  /**
   * Answers the hold the run has the agent at for the user, `itemId` (an OK, or a repeat out of
   * rounds): see RunStore.decide.
   */
  decide: (owner: string, itemId: string, answer: Answer) => void;
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
    onInstruction: (itemId: string, instruction: string) => {
      edits.setInstruction(owner, itemId, instruction);
    },
    onExpect: (itemId: string, expect: QueueStep['expect']) => {
      edits.setExpect(owner, itemId, expect);
    },
    onCondition: (ifId: string, condition: Condition) => {
      edits.setCondition(owner, ifId, condition);
    },
    onWaitFor: (waitId: string, targets: WaitTarget[]) => {
      edits.setWaitFor(owner, waitId, targets);
    },
    onTime: (itemId: string, time: Time | undefined) => {
      edits.setTime(owner, itemId, time);
    },
    onApproval: (okId: string, approve: string) => {
      edits.setApproval(owner, okId, approve);
    },
    onRepeat: (repeatId: string, change: RepeatChange) => {
      edits.setRepeat(owner, repeatId, change);
    },
    onGoOn: (itemId: string) => {
      edits.goOn(owner, itemId);
    },
    onDecide: (itemId: string, answer: Answer) => {
      edits.decide(owner, itemId, answer);
    },
  };
}
