import type { GraphNode } from '../graph/graph';
import { itemLabel, okWhat, taskLabel } from '../graph/labels';
import { checkedBy, isApproval, isWait } from '../graph/queue';
import type { QueueItem } from '../graph/queue';
import type { Run } from './runner';

/*
 * What each hold for the user asks (an OK, for now), derived from the graph and the run, never
 * stored: an edit or a Stop needs nothing withdrawn. One ask shows in four places (a queue's row,
 * All queues' lane head, the canvas's Needs you sidebar, the bar above an agent's composer), each
 * answering through RunStore.decide.
 */

/** One way to answer a hold: `key` is what RunStore.decide is told (`{ choice: key }`). */
export interface AskChoice {
  key: string;
  label: string;
  title?: string;
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

/**
 * How the user answers at an item, if the run can hold its queue there for them. An OK: Approve
 * (primary) or Stop here, or the changes to make, in their words.
 */
export function answersOf(item: QueueItem): Answers | undefined {
  return isApproval(item) ? OK_ANSWERS : undefined;
}

/** A hold a running run has for the user: its agent, the item it holds at, and what it asks. */
export interface HeldAsk extends Answers {
  agent: GraphNode;
  item: QueueItem;
  /** The question: "Your OK on the spec in SPEC.md?". */
  text: string;
  /** What it comes after: "After “Write the spec…”". */
  detail?: string;
}

/**
 * Every hold a running run has for the user, in graph order. An OK asks `Your OK on <what>?`,
 * after the work before it (pauses passed over), if there is any.
 */
export function heldAsks(nodes: readonly GraphNode[], run: Run): HeldAsk[] {
  if (!run.running) return [];
  return nodes.flatMap((agent) => {
    const at = run.agents[agent.id];
    if (agent.type !== 'agent' || at?.status !== 'asking') return [];
    const queue = agent.data.queue ?? [];
    const index = queue.findIndex((item) => item.id === at.current);
    const item = queue[index];
    const answers = item && answersOf(item);
    if (!item || !isApproval(item) || !answers) return [];
    const before = checkedBy(queue, index);
    return [
      {
        agent,
        item,
        text: `Your OK on ${okWhat(item)}?`,
        // A wait, in full: what it waited for.
        ...(before
          ? { detail: `After ${isWait(before) ? taskLabel(nodes, before) : itemLabel(before)}` }
          : {}),
        ...answers,
      },
    ];
  });
}
