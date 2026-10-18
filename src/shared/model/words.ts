import type { UsageBackendId } from '../adapter';
import { WINDOW_NAMES } from '../usage';
import type { UsageHold, UsageWindow } from '../usage';
import type { NodeLike } from './canvas';
import { agentName } from './queries';
import {
  CONDITIONS,
  findItem,
  isApproval,
  isDelay,
  isIf,
  isMessage,
  isRepeat,
  isRepeatEnds,
  isUsageReset,
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
  Time,
  Until,
  UsageAbove,
  UsageReset,
  WaitTarget,
} from './queue';
import { threadTitle } from './session';
import { DAY, HOUR, MINUTE } from './time';

/*
 * The words the engine needs, which the views show too: how the queue's items, times and usage
 * holds read, in what the run says and wherever they are shown. Words that may name a usage backend
 * (a usage condition, a delay until a window resets, a hold, and whatever reads one of them) are
 * given the catalog that names it; words that tell a time of day are given the locale to tell it
 * in (the host's: none, for the runtime's own).
 */

/** What these words read of the catalog: a usage backend's name (the engine's catalog is one). */
export interface BackendNames {
  backendName(backend: UsageBackendId): string;
}

/** How a condition reads after "If". */
export const ifText = (condition: Condition, catalog: BackendNames): string =>
  condition.kind === 'outputContains'
    ? `the output contains "${condition.text}"${condition.wholeLine ? ' on a line of its own' : ''}`
    : condition.kind === 'freeText'
      ? condition.text
      : condition.kind === 'usageAbove'
        ? usageAboveText(condition, catalog)
        : (CONDITIONS.find((c) => c.kind === condition.kind)?.label ?? '');

/** How a usage condition reads: "Claude’s usage is over 80% (5-hour)". */
export const usageAboveText = (
  { backend, percent, window }: UsageAbove,
  catalog: BackendNames,
): string =>
  `${catalog.backendName(backend)}’s usage is over ${String(percent)}% (${WINDOW_NAMES[window]})`;

/**
 * How a repeat's `until` reads after "Repeat until": "its last step succeeds", "the output contains
 * “APPROVED”", the user's own words, or the repeat it goes round with: "Judge's repeat ends" ("a
 * removed repeat ends" once that is gone).
 */
export function untilText(nodes: readonly NodeLike[], until: Until): string {
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
export function leaderOf(nodes: readonly NodeLike[], until: RepeatEnds): QueueRepeat | undefined {
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
export const repeatText = (nodes: readonly NodeLike[], repeat: QueueRepeat): string =>
  `Repeat until ${untilText(nodes, repeat.until)}`;

/** How a delay reads: "Wait 10 minutes", "Wait until 9:00 AM". */
export const delayText = (item: QueueDelay, catalog: BackendNames): string =>
  `Wait ${timeText(item.delay, catalog)}`;

/** What an OK is on, in the user's words: "the spec in SPEC.md", or "the work before it". */
export const okWhat = (ok: QueueApproval): string => ok.approve.trim() || 'the work before it';

/** How an OK reads, its words cut to `max` characters: "Your OK on the spec in SPEC.md". */
export const okText = (ok: QueueApproval, max = 32): string =>
  `Your OK on ${threadTitle(okWhat(ok), max)}`;

/** How a wait reads, given how each of its targets reads: "Wait for Builder, at most 30 minutes". */
export const waitText = (
  item: QueueWait,
  targetLabel: (target: WaitTarget) => string,
  catalog: BackendNames,
): string =>
  `Wait for ${andList(item.waitFor.map(targetLabel))}${
    item.timeout === undefined ? '' : `, ${limitText(item.timeout, catalog)}`
  }`;

/** How a queue item reads when another agent waits for it. */
export const itemLabel = (item: QueueItem, catalog: BackendNames): string =>
  isWait(item)
    ? 'its wait'
    : isRepeat(item)
      ? 'its repeat'
      : isDelay(item)
        ? delayText(item, catalog)
        : isApproval(item)
          ? okText(item, 24)
          : isIf(item)
            ? `If ${ifText(item.if, catalog)}`
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

/** What a wait waits for, in words: an agent (all of its work), or one of its items. */
export function waitTargetLabel(
  nodes: readonly NodeLike[],
  { agent, item }: WaitTarget,
  catalog: BackendNames,
): string {
  if (item === undefined) return agentName(nodes, agent);
  const found = findItem(nodes.find((n) => n.id === agent)?.data.queue ?? [], item);
  return `${agentName(nodes, agent)}: ${found ? itemLabel(found.item, catalog) : 'a removed step'}`;
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
export function taskLabel(
  nodes: readonly NodeLike[],
  item: QueueItem,
  catalog: BackendNames,
): string {
  if (isWait(item))
    return waitText(item, (target) => waitTargetLabel(nodes, target, catalog), catalog);
  if (isRepeat(item)) {
    const text = repeatText(nodes, item);
    return isRepeatEnds(item.until) ? text : `${text} (${roundsText(item.rounds)})`;
  }
  if (isDelay(item)) return delayText(item, catalog);
  if (isApproval(item)) return okText(item);
  if (isIf(item)) return `If ${ifText(item.if, catalog)}`;
  const what = isMessage(item)
    ? `Message ${item.message.trim() === '' ? '(empty)' : `“${threadTitle(item.message, 32)}”`}`
    : stepText(item, 32);
  return item.target === undefined ? what : `${what} → ${agentName(nodes, item.target)}`;
}

/**
 * How an item reads on its own buttons ("Move …", "Remove …", "Go on now: …"): what it is, and
 * for a wait, a delay, an OK, an if-then or a repeat, what it waits for or checks.
 */
export function describe(
  nodes: readonly NodeLike[],
  item: QueueItem,
  catalog: BackendNames,
): string {
  if (isWait(item))
    return waitText(item, (target) => waitTargetLabel(nodes, target, catalog), catalog);
  if (isRepeat(item)) return repeatText(nodes, item);
  if (isDelay(item)) return delayText(item, catalog);
  if (isApproval(item)) return okText(item);
  if (isIf(item)) return `If ${ifText(item.if, catalog)}`;
  return isMessage(item) ? 'Message' : item.action;
}

const LENGTH_WORDS = [
  [DAY, 'day'],
  [HOUR, 'hour'],
  [MINUTE, 'minute'],
  [1, 'second'],
] as const;

/**
 * A time in words: "10 minutes", "1 hour 30 minutes", "until 9:00 AM" (in `locale`'s way), "until
 * Claude’s usage resets (5-hour)" (its backend named by `catalog`).
 */
export function timeText(time: Time, catalog: BackendNames, locale?: string): string {
  if (isUsageReset(time)) return `until ${resetText(time, catalog)}`;
  if ('at' in time) return `until ${clockText(time.at, locale)}`;
  let left = time.seconds;
  const words: string[] = [];
  for (const [size, word] of LENGTH_WORDS) {
    const n = Math.floor(left / size);
    left -= n * size;
    if (n > 0) words.push(`${String(n)} ${word}${n === 1 ? '' : 's'}`);
  }
  return words.join(' ');
}

/** A time limit in words: "at most 30 minutes", "no later than 6:00 PM". */
export function limitText(time: Time, catalog: BackendNames, locale?: string): string {
  if (isUsageReset(time)) return `no later than ${resetText(time, catalog)}`;
  return 'at' in time
    ? `no later than ${clockText(time.at, locale)}`
    : `at most ${timeText(time, catalog)}`;
}

/** "Claude’s usage resets (5-hour)". */
function resetText({ backend, resets }: UsageReset, catalog: BackendNames): string {
  return `${catalog.backendName(backend)}’s usage resets (${WINDOW_NAMES[resets]})`;
}

/** A time of day ("HH:MM") as `locale` shows one: "9:00 AM", "09:00". */
function clockText(at: string, locale: string | undefined): string {
  const [hours = 0, minutes = 0] = at.split(':').map(Number);
  return (
    new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' })
      .format(new Date(2000, 0, 1, hours, minutes))
      // Some locales put a narrow no-break space before AM and PM.
      .replace(/\s/gu, ' ')
  );
}

/** How long is left, `ms`, as a countdown shows it: "4:05 left", or "8 h 12 min left" from an hour. */
export function leftText(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < HOUR) {
    return `${String(Math.floor(seconds / MINUTE))}:${String(seconds % MINUTE).padStart(2, '0')} left`;
  }
  return `${String(Math.floor(seconds / HOUR))} h ${String(Math.floor((seconds % HOUR) / MINUTE))} min left`;
}

/** A share used, as a gauge shows it: "42%", or "<1%" for a little. */
export function percentText(used: number): string {
  if (used > 0 && used < 1) return '<1%';
  return `${String(Math.round(used))}%`;
}

/**
 * When a window resets, as a gauge says it: "3:40 PM" today, "Thu 9:00 AM" within a week, or the
 * date further off (in `locale`'s way).
 */
export function resetTime(at: number, now: number, locale?: string): string {
  const day = new Date(at);
  const today = new Date(now);
  const clock = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' })
    .format(day)
    // Some locales put a narrow no-break space before AM and PM.
    .replace(/\s/gu, ' ');
  if (day.toDateString() === today.toDateString()) return clock;
  const days = (at - now) / 86_400_000;
  const date =
    days > 0 && days < 6.5
      ? new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(day)
      : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(day);
  return `${date} ${clock}`;
}

/** How a window is named on its own: "5-hour window". */
export const windowText = (window: UsageWindow): string => `${WINDOW_NAMES[window]} window`;

/**
 * What a usage rule's hold says, the backend named by `catalog`: "Claude has used 84% of its
 * 5-hour window (over 80%)".
 */
export function holdText(
  { backend, window, percent, used }: UsageHold,
  catalog: BackendNames,
): string {
  return `${catalog.backendName(backend)} has used ${percentText(used)} of its ${windowText(window)} (over ${String(percent)}%)`;
}

/**
 * What a usage rule's warning says, in the agent's session: "Claude has used 84% of its 5-hour
 * window (over 80%). It resets at 3:40 PM."
 */
export function warningText(
  hold: UsageHold,
  catalog: BackendNames,
  now: number,
  locale?: string,
): string {
  const reset =
    hold.resetsAt === null ? '' : ` It resets at ${resetTime(hold.resetsAt, now, locale)}.`;
  return `${holdText(hold, catalog)}.${reset}`;
}
