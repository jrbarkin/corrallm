import { agentParty, isContinuation } from '../../shared/model/messages';
import type { Message } from '../../shared/model/messages';
import type { TaskMessage } from '../../shared/session';
import { sentByRun } from './delivery/messages';
import type { OpenCanvas } from './engines';

/**
 * B21 Design §9.2 C4, C7, C8: the task attempt whose own turn agent `agent`'s session is on now, if
 * one is, with that turn's message: the turn its session started and hasn't heard end, whose
 * message is its step's send (the run's) or a continuation of it (an answer to one of its asks, or
 * the record of how one ended), of the agent's own current attempt, running, at a tool step (never
 * a slash command's, a message item's or a condition's question). What `complete` may report
 * (the AttemptId's resolver) and what an ask made now belongs to. None in any other turn: a party's
 * message, yours, a reply, no run. Whether the caller is the agent's current generation, core.call's
 * stamp checks; no native id or text is read as an attempt.
 */
export function ownTurn(
  open: Pick<OpenCanvas, 'engine' | 'messages'>,
  agent: string,
): { task: TaskMessage; message: Message } | undefined {
  const turn = open.engine.sessions.turnOf(agent);
  if (turn === undefined) return undefined;
  const message = open.messages
    .active()
    .find(
      (one) =>
        one.delivery?.as === turn &&
        one.to === agentParty(agent) &&
        (one.state === 'delivering' || one.state === 'delivered'),
    );
  const task = message?.task;
  if (
    message === undefined ||
    task?.agent !== agent ||
    !(sentByRun(message) || isContinuation(message)) ||
    !open.engine.run.ownsAttempt(task)
  )
    return undefined;
  return { task, message };
}
