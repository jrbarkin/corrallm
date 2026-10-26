import type { Answer } from '../../shared/engine/run/runner';
import type { CanvasId } from '../../shared/canvas';
import type { GuiApi } from '../../shared/gui-link';
import type {
  Condition,
  QueueEntry,
  QueueRepeat,
  QueueStep,
  Time,
  WaitTarget,
} from '../../shared/model/queue';

/** What changes about a repeat: when it stops, how many rounds it runs at most, and then what. */
export type RepeatChange = Partial<Pick<QueueRepeat, 'until' | 'rounds' | 'otherwise'>>;

export type AddEntry = (
  entry: QueueEntry,
  into?: string,
) => string | undefined | Promise<string | undefined>;
type EditResult = void | Promise<void>;

/**
 * What changes a queue, by agent (`owner`): what every queue's editor does to it. And what acts on
 * the queues' run from a queue's rows (`goOn`, `decide`), so every view of a queue has its run
 * controls.
 */
export interface QueueEdits {
  /** `into`: the id of the if-then or repeat to add to. */
  add: (owner: string, ...args: Parameters<AddEntry>) => ReturnType<AddEntry>;
  remove: (owner: string, itemId: string) => EditResult;
  move: (owner: string, itemId: string, before: string | null) => EditResult;
  retarget: (owner: string, itemId: string, target: string | undefined) => EditResult;
  editMessage: (owner: string, itemId: string, message: string) => EditResult;
  /** What a step is to do, in the user's words ('' takes it off). */
  setInstruction: (owner: string, itemId: string, instruction: string) => EditResult;
  /** Whether a step is expected to fail ('fails'), or (undefined) to succeed. */
  setExpect: (owner: string, itemId: string, expect: QueueStep['expect']) => EditResult;
  setCondition: (owner: string, ifId: string, condition: Condition) => EditResult;
  setWaitFor: (owner: string, waitId: string, targets: WaitTarget[]) => EditResult;
  /** A delay's time, or a wait's time limit (`undefined` takes the limit off). */
  setTime: (owner: string, itemId: string, time: Time | undefined) => EditResult;
  /** What an OK is on, in the user's words ('' for the work before it). */
  setApproval: (owner: string, okId: string, approve: string) => EditResult;
  /** When a repeat stops, how many rounds it runs at most, or what it does after the last. */
  setRepeat: (owner: string, repeatId: string, change: RepeatChange) => EditResult;
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
      return edits.add(owner, entry, into);
    },
    onRemove: (itemId: string) => {
      return edits.remove(owner, itemId);
    },
    onMove: (itemId: string, before: string | null) => {
      return edits.move(owner, itemId, before);
    },
    onRetarget: (itemId: string, target: string | undefined) => {
      return edits.retarget(owner, itemId, target);
    },
    onEditMessage: (itemId: string, message: string) => {
      return edits.editMessage(owner, itemId, message);
    },
    onInstruction: (itemId: string, instruction: string) => {
      return edits.setInstruction(owner, itemId, instruction);
    },
    onExpect: (itemId: string, expect: QueueStep['expect']) => {
      return edits.setExpect(owner, itemId, expect);
    },
    onCondition: (ifId: string, condition: Condition) => {
      return edits.setCondition(owner, ifId, condition);
    },
    onWaitFor: (waitId: string, targets: WaitTarget[]) => {
      return edits.setWaitFor(owner, waitId, targets);
    },
    onTime: (itemId: string, time: Time | undefined) => {
      return edits.setTime(owner, itemId, time);
    },
    onApproval: (okId: string, approve: string) => {
      return edits.setApproval(owner, okId, approve);
    },
    onRepeat: (repeatId: string, change: RepeatChange) => {
      return edits.setRepeat(owner, repeatId, change);
    },
    onGoOn: (itemId: string) => {
      edits.goOn(owner, itemId);
    },
    onDecide: (itemId: string, answer: Answer) => {
      edits.decide(owner, itemId, answer);
    },
  };
}

/** Queue writes share the generated client's draft/revision barriers; run controls delegate to their operations. */
export function operationEdits(
  api: GuiApi,
  canvas: CanvasId,
  run: {
    goOn: (agent: string, item: string) => unknown;
    decide: (agent: string, item: string, answer: Answer) => unknown;
  },
  failed: (error: unknown) => void,
): QueueEdits {
  const send = async <T>(promise: Promise<T>): Promise<T | undefined> => {
    try {
      return await promise;
    } catch (error) {
      failed(error);
      return undefined;
    }
  };
  const update = async (
    agent: string,
    item: string,
    change: Parameters<GuiApi['queueUpdate']>[0]['change'],
  ) => {
    await send(api.queueUpdate({ canvas, agent, item, change }));
  };
  return {
    add: async (agent, entry, into) => {
      const result = await send(
        api.queueAdd({ canvas, agent, entry, ...(into === undefined ? {} : { into }) }),
      );
      return result?.id;
    },
    remove: async (agent, item) => {
      await send(api.queueRemove({ canvas, agent, item }));
    },
    move: async (agent, item, before) => {
      await send(api.queueMove({ canvas, agent, item, before }));
    },
    retarget: (agent, item, target) =>
      update(agent, item, { kind: 'target', target: target ?? null }),
    editMessage: (agent, item, message) => update(agent, item, { kind: 'message', message }),
    setInstruction: (agent, item, instruction) =>
      update(agent, item, { kind: 'instruction', instruction: instruction || null }),
    setExpect: (agent, item, expect) =>
      update(agent, item, { kind: 'expect', expect: expect ?? null }),
    setCondition: (agent, item, condition) => update(agent, item, { kind: 'condition', condition }),
    setWaitFor: (agent, item, waitFor) => update(agent, item, { kind: 'waitFor', waitFor }),
    setTime: (agent, item, time) => update(agent, item, { kind: 'time', time: time ?? null }),
    setApproval: (agent, item, approve) => update(agent, item, { kind: 'approve', approve }),
    setRepeat: (agent, item, change) => update(agent, item, { kind: 'repeat', ...change }),
    goOn: (agent, item) => {
      void send(Promise.resolve(run.goOn(agent, item)));
    },
    decide: (agent, item, answer) => {
      void send(Promise.resolve(run.decide(agent, item, answer)));
    },
  };
}
