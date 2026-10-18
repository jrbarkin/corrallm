/*
 * Usage readings and rules. A backend's usage limits belong to its account, not to one agent:
 * every Claude agent on the same login spends the same 5-hour and weekly windows. So main keeps
 * one reading per backend (src/main/usage.ts), taken from whichever of its agents' CLIs reports it
 * (Claude Code's status line, for a Terminal agent), and every agent on that backend sees it. A
 * reading holds only how much of each window is used and when it resets: never anything else the
 * CLI reported. A usage rule, one per backend, says what the queues' run does when usage passes a
 * share of a window.
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process.
 */

/**
 * The backends whose usage corrallm reads, named as their agent type is (graph/agents.ts). Claude:
 * from the Terminal connection's status line. Codex: from `codex app-server`'s
 * account/rateLimits (primary: 5-hour, secondary: weekly), once it is connected.
 */
export const USAGE_BACKENDS = ['Claude', 'Codex'] as const;
export type UsageBackend = (typeof USAGE_BACKENDS)[number];

/** The usage windows a backend's limits are counted in. */
export const USAGE_WINDOWS = ['fiveHour', 'weekly'] as const;
export type UsageWindow = (typeof USAGE_WINDOWS)[number];

/** How each window is named: "5-hour", "weekly". */
export const WINDOW_NAMES: Readonly<Record<UsageWindow, string>> = {
  fiveHour: '5-hour',
  weekly: 'weekly',
};

/** How much of a window is used (0 to 100), and when it resets (epoch ms; null if not said). */
export interface WindowUsage {
  usedPercent: number;
  resetsAt: number | null;
}

/** A backend's windows, as one reading has them: those its CLI reported. */
export type UsageWindows = Partial<Record<UsageWindow, WindowUsage>>;

/** A backend's latest usage: its windows, when it was read (epoch ms), and whether simulated. */
export interface UsageReading {
  backend: UsageBackend;
  windows: UsageWindows;
  at: number;
  /** Set by "Simulate usage…", to try rules without spending real usage. */
  simulated?: true;
}

/**
 * What a usage rule does when its backend's usage passes its share of a window, between tasks:
 * warn the user; hold the run and ask them (Needs you); or let the task going on finish, then
 * wait for the window to reset. ("Carry on with the next backend" comes with the fallback chain.)
 */
export const USAGE_ACTIONS = ['warn', 'ask', 'waitForReset'] as const;
export type UsageAction = (typeof USAGE_ACTIONS)[number];

/** When a backend's usage is over `percent` of `window`, the run does `action`. */
export interface UsageRule {
  window: UsageWindow;
  /** A whole number from 1 to 99. */
  percent: number;
  action: UsageAction;
}

/** Every backend's latest reading (those read so far), and each backend's rule, if it has one. */
export interface UsageState {
  readings: UsageReading[];
  rules: Partial<Record<UsageBackend, UsageRule>>;
}

export const NO_USAGE: UsageState = { readings: [], rules: {} };

/** The latest time a window may reset: corrallm reads no window longer than a week, plus a day. */
const MAX_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `value` as a backend whose usage corrallm reads, or throws. */
export function parseBackend(value: unknown): UsageBackend {
  const found = USAGE_BACKENDS.find((backend) => backend === value);
  if (found === undefined) throw new TypeError(`Expected one of: ${USAGE_BACKENDS.join(', ')}`);
  return found;
}

/**
 * `value` as a backend's windows, or throws: only the windows corrallm knows, each with a share
 * used from 0 to 100 and a reset time (epoch ms) no later than `now` plus a week and a day, or
 * null. Anything else in it is dropped.
 */
export function parseWindows(value: unknown, now: number): UsageWindows {
  if (!isRecord(value)) throw new TypeError('Expected usage windows');
  const windows: UsageWindows = {};
  for (const window of USAGE_WINDOWS) {
    const usage = value[window];
    if (usage === undefined) continue;
    if (!isRecord(usage)) throw new TypeError(`Expected the ${window} window's usage`);
    const { usedPercent, resetsAt } = usage;
    if (
      typeof usedPercent !== 'number' ||
      !Number.isFinite(usedPercent) ||
      usedPercent < 0 ||
      usedPercent > 100
    ) {
      throw new RangeError(`The ${window} window's usage must be from 0 to 100`);
    }
    if (
      resetsAt !== null &&
      (typeof resetsAt !== 'number' ||
        !Number.isFinite(resetsAt) ||
        resetsAt < 0 ||
        resetsAt > now + MAX_AHEAD_MS)
    ) {
      throw new RangeError(`The ${window} window's reset must be a time, or null`);
    }
    windows[window] = { usedPercent, resetsAt };
  }
  return windows;
}

/** `value` as a usage rule, or throws. */
export function parseRule(value: unknown): UsageRule {
  if (!isRecord(value)) throw new TypeError('Expected a usage rule');
  const { window, percent, action } = value;
  const ruleWindow = USAGE_WINDOWS.find((w) => w === window);
  const ruleAction = USAGE_ACTIONS.find((a) => a === action);
  if (ruleWindow === undefined) throw new TypeError(`Expected one of: ${USAGE_WINDOWS.join(', ')}`);
  if (ruleAction === undefined) throw new TypeError(`Expected one of: ${USAGE_ACTIONS.join(', ')}`);
  if (typeof percent !== 'number' || !Number.isInteger(percent) || percent < 1 || percent > 99) {
    throw new RangeError('A usage rule’s share must be a whole number from 1 to 99');
  }
  return { window: ruleWindow, percent, action: ruleAction };
}

/**
 * A window's usage while it counts: undefined once its reset time has passed (what was used then
 * no longer counts, and nothing has been read since), or if the reading has no such window.
 */
export function windowNow(
  reading: UsageReading | undefined,
  window: UsageWindow,
  now: number,
): WindowUsage | undefined {
  const usage = reading?.windows[window];
  if (!usage || (usage.resetsAt !== null && usage.resetsAt <= now)) return undefined;
  return usage;
}

/** Whether a backend's usage of a window is over `percent` now (by its latest reading). */
export function usageOver(
  reading: UsageReading | undefined,
  window: UsageWindow,
  percent: number,
  now: number,
): boolean {
  const usage = windowNow(reading, window, now);
  return usage !== undefined && usage.usedPercent > percent;
}
