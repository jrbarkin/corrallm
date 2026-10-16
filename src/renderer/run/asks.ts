import type { Connection } from '../../shared/session';
import { CONNECTION_INFO } from '../graph/agents';
import type { GraphNode } from '../graph/graph';
import { agentName, itemLabel, okWhat, taskLabel, untilText } from '../graph/labels';
import { checkedBy, findItem, isApproval, isRepeat, isWait } from '../graph/queue';
import type { QueueItem } from '../graph/queue';
import { holdText, resetTime } from '../usage/usage';
import type { UsageHold } from '../usage/usage';
import type { Run, TaskProblem } from './runner';

/*
 * What each hold for the user asks (an OK, a repeat out of rounds, a session that would not
 * start, a usage rule), derived from the graph and the run, never stored: an edit or a Stop needs
 * nothing withdrawn. One ask shows in four places (a queue's row, All queues' lane head, the
 * canvas's Needs you sidebar, the bar above an agent's composer or, for a Terminal agent, under
 * its terminal), each answering through RunStore.decide.
 */

/** One way to answer a hold: `key` is what RunStore.decide is told (`{ choice: key }`). */
export interface AskChoice {
  key: string;
  label: string;
  title?: string;
  /** What it means, shown under it (as Claude Code shows its questions' options). */
  detail?: string;
  /** The answer most expected, shown filled. */
  primary?: boolean;
}

/** How the user can answer at an item the run holds for them (static, from the item). */
export interface Answers {
  choices: readonly AskChoice[];
  /** An answer in their own words (`{ reply }`): what its box asks, and its button. */
  reply?: { label: string; button: string };
}

const OK_ANSWERS: Answers = {
  choices: [
    { key: 'approve', label: 'Approve', primary: true },
    { key: 'stop', label: 'Stop here', title: 'Stop this queue here, and whatever waits on it' },
  ],
  reply: { label: 'What should change?', button: 'Ask for changes' },
};

const ROUND_ANSWERS: Answers = {
  choices: [
    { key: 'more', label: 'One more round', primary: true },
    { key: 'goOn', label: 'Go on', title: 'End the repeat as failed and carry on' },
  ],
  reply: { label: 'What should it try next?', button: 'Try this' },
};

const CONDITION_ANSWERS: Answers = {
  choices: [
    {
      key: 'retry',
      label: 'Retry',
      primary: true,
      title: 'Ask the agent to check this condition again',
    },
    { key: 'yes', label: 'Condition holds' },
    { key: 'no', label: 'Condition does not hold' },
    { key: 'stop', label: 'Stop here', title: 'Stop this queue here, and whatever waits on it' },
  ],
};

/**
 * How the user answers where a usage rule holds an agent before a task: Go on (primary) or Wait
 * for the reset (each for every agent on that backend, until the window resets), or Stop here.
 * No wait without a reset time to wait for.
 */
export function usageAnswers({
  backend,
  resetsAt,
}: Pick<UsageHold, 'backend' | 'resetsAt'>): Answers {
  return {
    choices: [
      {
        key: 'goOn',
        label: 'Go on',
        title: `Every ${backend} agent carries on until the window resets`,
        primary: true,
      },
      ...(resetsAt === null
        ? []
        : [
            {
              key: 'wait',
              label: 'Wait for the reset',
              title: `Every ${backend} agent holds until the window resets, then goes on`,
            },
          ]),
      { key: 'stop', label: 'Stop here', title: 'Stop this queue here, and whatever waits on it' },
    ],
  };
}

/**
 * How the user answers at an item, if the run can hold its queue there for them. An OK: Approve
 * (primary) or Stop here, or the changes to make, in their words. A repeat out of rounds: One more
 * round (primary) or Go on, or what to try next, in their words (then one more round).
 */
export function answersOf(item: QueueItem, problem: TaskProblem): Answers;
export function answersOf(item: QueueItem, problem?: TaskProblem): Answers | undefined;
export function answersOf(item: QueueItem, problem?: TaskProblem): Answers | undefined {
  if (problem?.conditionKey !== undefined) return CONDITION_ANSWERS;
  if (problem)
    return {
      choices: [
        {
          key: 'retry',
          label: 'Retry',
          primary: true,
          title:
            problem.kind === 'uncertain'
              ? 'Run the task again; earlier work may already have happened'
              : 'Run the original task again',
        },
        {
          key: 'resolve',
          label: 'Mark resolved',
          title: 'Record that this task is resolved and continue',
        },
        {
          key: 'continue',
          label: problem.kind === 'cancelled' ? 'Continue cancelled' : 'Continue with failure',
        },
        {
          key: 'stop',
          label: 'Stop here',
          title: 'Stop this queue here, and whatever waits on it',
        },
      ],
      reply: { label: 'What should it try next?', button: 'Try this' },
    };
  return isApproval(item) ? OK_ANSWERS : isRepeat(item) ? ROUND_ANSWERS : undefined;
}

/** A hold a running run has for the user: its agent, the item it holds at, and what it asks. */
export interface HeldAsk extends Answers {
  agent: GraphNode;
  item: QueueItem;
  /** The question: "Your OK on the spec in SPEC.md?"; or why a session would not start. */
  text: string;
  /** What it comes after: "After “Write the spec…”"; or what waits for a session to start. */
  detail?: string;
  /**
   * Held because a session would not start: whose (this agent's, or one it handed a message to),
   * and the connection Switch (`{ choice: 'switch' }`) runs it with.
   */
  refusal?: { agent: string; switchTo: Connection };
  /** A task's known failure, cancellation, or uncertain result, awaiting a human decision. */
  problem?: TaskProblem;
}

/**
 * Every hold a running run has for the user, in graph order. An OK asks `Your OK on <what>?`,
 * after the work before it (pauses passed over), if there is any. A repeat out of rounds says how
 * many it ran, and what still does not hold. A task whose session would not start says why, and
 * what waits, and offers to switch that session's agent: "Switch to Terminal" ("Switch Reviewer
 * to Terminal" for an agent it handed a message to). A usage rule says how much of which window is
 * used, before the task it holds, and when the window resets (as of `now`).
 */
export function heldAsks(nodes: readonly GraphNode[], run: Run, now = Date.now()): HeldAsk[] {
  if (!run.running) return [];
  return nodes.flatMap((agent): HeldAsk[] => {
    const at = run.agents[agent.id];
    if (agent.type !== 'agent' || at?.paused || at?.status !== 'asking' || at.current === undefined)
      return [];
    const queue = agent.data.queue ?? [];
    const item = findItem(queue, at.current)?.item;
    if (item && at.problem)
      return [
        {
          agent,
          item,
          text: at.problem.text,
          detail: `${taskLabel(nodes, item)}${at.problem.agent === agent.id ? '' : ` · ${agentName(nodes, at.problem.agent)}`}`,
          ...answersOf(item, at.problem),
          problem: at.problem,
        },
      ];
    if (item && at.refused) {
      const { agent: to, text, switchTo } = at.refused;
      const name = agentName(nodes, to);
      const how = CONNECTION_INFO[switchTo].label;
      return [
        {
          agent,
          item,
          text,
          detail: `${taskLabel(nodes, item)} waits until ${name} can start`,
          choices: [
            {
              key: 'switch',
              label: to === agent.id ? `Switch to ${how}` : `Switch ${name} to ${how}`,
              primary: true,
            },
          ],
          refusal: { agent: to, switchTo },
        },
      ];
    }
    if (item && at.usage) {
      const reset =
        at.usage.resetsAt === null ? '' : ` · resets ${resetTime(at.usage.resetsAt, now)}`;
      return [
        {
          agent,
          item,
          text: `${holdText(at.usage)}. Go on?`,
          detail: `Before ${itemLabel(item)}${reset}`,
          ...usageAnswers(at.usage),
        },
      ];
    }
    const answers = item && answersOf(item);
    if (!item || !answers) return [];
    if (isRepeat(item)) {
      const done = at.rounds?.[item.id]?.round ?? 1;
      const rounds = `${String(done)} round${done === 1 ? '' : 's'}`;
      return [
        {
          agent,
          item,
          text: `${rounds} done, and still not: ${untilText(nodes, item.until)}.`,
          ...answers,
        },
      ];
    }
    if (!isApproval(item)) return [];
    const before = checkedBy(queue, queue.indexOf(item));
    return [
      {
        agent,
        item,
        text: `Your OK on ${okWhat(item)}?`,
        // A wait or a repeat, in full: what it waited for, or what it repeated until.
        ...(before
          ? {
              detail: `After ${isWait(before) || isRepeat(before) ? taskLabel(nodes, before) : itemLabel(before)}`,
            }
          : {}),
        ...answers,
      },
    ];
  });
}
