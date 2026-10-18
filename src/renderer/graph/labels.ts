import { WINDOW_NAMES } from '../../shared/usage';
import { threadTitle } from '../agent/session';
import type { GraphNode } from './graph';
import {
  CONDITIONS,
  findItem,
  isApproval,
  isDelay,
  isIf,
  isMessage,
  isRepeat,
  isRepeatEnds,
  isWait,
  UNTIL_CONDITIONS,
} from './queue';
import type {
  Condition,
  QueueApproval,
  QueueDelay,
  QueueItem,
  QueueRepeat,
  QueueStep,
  QueueWait,
  RepeatEnds,
  Until,
  UsageAbove,
  WaitTarget,
} from './queue';
import { limitText, timeText } from './time';

/** How a condition reads after "If". */
export const ifText = (condition: Condition): string =>
  condition.kind === 'outputContains'
    ? `the output contains "${condition.text}"${condition.wholeLine ? ' on a line of its own' : ''}`
    : condition.kind === 'freeText'
      ? condition.text
      : condition.kind === 'usageAbove'
        ? usageAboveText(condition)
        : (CONDITIONS.find((c) => c.kind === condition.kind)?.label ?? '');

/** How a usage condition reads: "Claude’s usage is over 80% (5-hour)". */
export const usageAboveText = ({ backend, percent, window }: UsageAbove): string =>
  `${backend}’s usage is over ${String(percent)}% (${WINDOW_NAMES[window]})`;

/**
 * How a repeat's `until` reads after "Repeat until": "its last step succeeds", "the output contains
 * “APPROVED”", the user's own words, or the repeat it goes round with: "Judge's repeat ends" ("a
 * removed repeat ends" once that is gone).
 */
export function untilText(nodes: readonly GraphNode[], until: Until): string {
  switch (until.kind) {
    case 'outputContains':
      return `the output contains “${until.text}”${until.wholeLine ? ' on a line of its own' : ''}`;
    case 'freeText':
      return until.text;
    case 'repeatEnds':
      return leaderOf(nodes, until)
        ? `${agentName(nodes, until.agent)}'s repeat ends`
        : 'a removed repeat ends';
    default:
      return UNTIL_CONDITIONS.find((c) => c.kind === until.kind)?.label ?? '';
  }
}

/** The repeat another goes round with (`until`), if it is still there. */
export function leaderOf(nodes: readonly GraphNode[], until: RepeatEnds): QueueRepeat | undefined {
  const leader = nodes.find((n) => n.id === until.agent && n.type === 'agent');
  const found = leader && findItem(leader.data.queue ?? [], until.item)?.item;
  return found && isRepeat(found) ? found : undefined;
}

/** "up to 3 rounds", "up to 1 round". */
export const roundsText = (rounds: number): string =>
  `up to ${String(rounds)} round${rounds === 1 ? '' : 's'}`;

/** What a repeat does after its last round, as its chip reads: "then ask me", "then go on". */
export const otherwiseText = (repeat: QueueRepeat): string =>
  repeat.otherwise === 'ask' ? 'then ask me' : 'then go on';

/** How a repeat reads: "Repeat until its last step succeeds". */
export const repeatText = (nodes: readonly GraphNode[], repeat: QueueRepeat): string =>
  `Repeat until ${untilText(nodes, repeat.until)}`;

/** How a delay reads: "Wait 10 minutes", "Wait until 9:00 AM". */
export const delayText = (item: QueueDelay): string => `Wait ${timeText(item.delay)}`;

/** What an OK is on, in the user's words: "the spec in SPEC.md", or "the work before it". */
export const okWhat = (ok: QueueApproval): string => ok.approve.trim() || 'the work before it';

/** How an OK reads, its words cut to `max` characters: "Your OK on the spec in SPEC.md". */
export const okText = (ok: QueueApproval, max = 32): string =>
  `Your OK on ${threadTitle(okWhat(ok), max)}`;

/** How a wait reads, given how each of its targets reads: "Wait for Builder, at most 30 minutes". */
export const waitText = (item: QueueWait, targetLabel: (target: WaitTarget) => string): string =>
  `Wait for ${andList(item.waitFor.map(targetLabel))}${
    item.timeout === undefined ? '' : `, ${limitText(item.timeout)}`
  }`;

/** How a queue item reads when another agent waits for it. */
export const itemLabel = (item: QueueItem): string =>
  isWait(item)
    ? 'its wait'
    : isRepeat(item)
      ? 'its repeat'
      : isDelay(item)
        ? delayText(item)
        : isApproval(item)
          ? okText(item, 24)
          : isIf(item)
            ? `If ${ifText(item.if)}`
            : isMessage(item)
              ? item.message.trim() === ''
                ? 'an empty message'
                : `“${threadTitle(item.message, 24)}”`
              : stepText(item, 24);

/**
 * A step: its action, what it is to do when the user said (cut at `max` characters), and whether
 * it is expected to fail.
 */
function stepText({ action, instruction = '', expect }: QueueStep, max: number): string {
  const what = instruction.trim() === '' ? action : `${action} “${threadTitle(instruction, max)}”`;
  return expect === 'fails' ? `${what} (expected to fail)` : what;
}

/**
 * How a step expected to fail went, once judged (the run's AgentRun.asExpected): it failed, as
 * expected (`true`: its success), or it passed (its failure).
 */
export const expectedText = (asExpected: boolean): string =>
  asExpected ? 'failed, as expected' : 'passed, but was expected to fail';

/** An agent's name: its label, "Unnamed agent" without one, or "Deleted agent" once it is gone. */
export function agentName(nodes: readonly GraphNode[], id: string): string {
  const node = nodes.find((n) => n.id === id);
  return node ? node.data.label || 'Unnamed agent' : 'Deleted agent';
}

/** What a wait waits for, in words: an agent (all of its work), or one of its items. */
export function waitTargetLabel(nodes: readonly GraphNode[], { agent, item }: WaitTarget): string {
  if (item === undefined) return agentName(nodes, agent);
  const found = findItem(nodes.find((n) => n.id === agent)?.data.queue ?? [], item);
  return `${agentName(nodes, agent)}: ${found ? itemLabel(found.item) : 'a removed step'}`;
}

/** "a", "a and b", "a, b and c". */
export function andList(names: readonly string[]): string {
  return names.length < 2
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${String(names.at(-1))}`;
}

/**
 * How an item reads in full, as All queues names it: what it does, and to which agent; a repeat,
 * how many rounds it runs at most (unless it goes round with another, as many as that one).
 */
export function taskLabel(nodes: readonly GraphNode[], item: QueueItem): string {
  if (isWait(item)) return waitText(item, (target) => waitTargetLabel(nodes, target));
  if (isRepeat(item)) {
    const text = repeatText(nodes, item);
    return isRepeatEnds(item.until) ? text : `${text} (${roundsText(item.rounds)})`;
  }
  if (isDelay(item)) return delayText(item);
  if (isApproval(item)) return okText(item);
  if (isIf(item)) return `If ${ifText(item.if)}`;
  const what = isMessage(item)
    ? `Message ${item.message.trim() === '' ? '(empty)' : `“${threadTitle(item.message, 32)}”`}`
    : stepText(item, 32);
  return item.target === undefined ? what : `${what} → ${agentName(nodes, item.target)}`;
}

/**
 * How an item reads on its own buttons ("Move …", "Remove …", "Go on now: …"): what it is, and
 * for a wait, a delay, an OK, an if-then or a repeat, what it waits for or checks.
 */
export function describe(nodes: readonly GraphNode[], item: QueueItem): string {
  if (isWait(item)) return waitText(item, (target) => waitTargetLabel(nodes, target));
  if (isRepeat(item)) return repeatText(nodes, item);
  if (isDelay(item)) return delayText(item);
  if (isApproval(item)) return okText(item);
  if (isIf(item)) return `If ${ifText(item.if)}`;
  return isMessage(item) ? 'Message' : item.action;
}
