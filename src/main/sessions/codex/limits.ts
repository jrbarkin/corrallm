import { usedUpUntil } from '../../../shared/usage';
import type { UsageWindow, UsageWindows } from '../../../shared/usage';
import { property } from '../transcript';

/*
 * Codex's usage limits, as its app server reports them: a RateLimitSnapshot (account/rateLimits/
 * read's `rateLimits`, or account/rateLimits/updated's) whose `primary` and `secondary` windows are
 * the plan's 5-hour and weekly ones, each with `usedPercent`, `windowDurationMins` and `resetsAt`
 * (epoch seconds). Read once here, for the App Server's composer (app-server/translate.ts) and for
 * the backend's usage reading (main's usage.ts), from either connection: the App Server hears them
 * as it works, a Terminal session asks a private app server (terminal/usage.ts). Reading them uses
 * no model, so it spends no usage. Verified against Codex CLI 0.160.1 on a ChatGPT (Plus) login.
 */

/** A window of Codex's limits, as its snapshot has it. */
export interface CodexLimit {
  /** Where the snapshot has it. */
  slot: 'primary' | 'secondary';
  usedPercent: number;
  /** Its length in minutes (300, 10080), if Codex says. */
  windowMinutes: number | null;
  /** When it resets, in epoch seconds, if Codex says. */
  resetsAt: number | null;
}

/** The windows corrallm counts usage in, by their length in minutes. */
const WINDOWS: Readonly<Record<number, UsageWindow>> = { 300: 'fiveHour', 10_080: 'weekly' };
/** The latest a window can reset: a week and a day from now. */
const MAX_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * Codex's own limits in a snapshot: its windows that say how much is used (primary, then
 * secondary). Undefined if it is not a snapshot, or is another limit's (a model's, which is not
 * the plan's).
 */
export function codexLimits(snapshot: unknown): CodexLimit[] | undefined {
  const id = property(snapshot, 'limitId');
  if (typeof snapshot !== 'object' || snapshot === null || (id !== 'codex' && id != null)) {
    return undefined;
  }
  return (['primary', 'secondary'] as const).flatMap((slot): CodexLimit[] => {
    const window = property(snapshot, slot);
    const used = property(window, 'usedPercent');
    if (typeof used !== 'number' || !Number.isFinite(used)) return [];
    const minutes = property(window, 'windowDurationMins');
    const resets = property(window, 'resetsAt');
    return [
      {
        slot,
        usedPercent: used,
        windowMinutes: typeof minutes === 'number' ? minutes : null,
        resetsAt: typeof resets === 'number' && Number.isFinite(resets) ? resets : null,
      },
    ];
  });
}

/**
 * Codex's limits as a usage reading's windows: each window by its length (5 hours, a week; the
 * primary is the 5-hour one and the secondary the weekly one where Codex does not say), its share
 * used kept from 0 to 100, and when it resets (epoch ms; null unless a time within a week and a
 * day of `now`). Undefined if none is a window corrallm counts in.
 */
export function usageWindows(limits: readonly CodexLimit[], now: number): UsageWindows | undefined {
  const windows: UsageWindows = {};
  for (const limit of limits) {
    const window = windowOf(limit);
    const { usedPercent, resetsAt } = limit;
    if (window === undefined || windows[window] !== undefined) continue;
    windows[window] = {
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      resetsAt:
        resetsAt !== null && resetsAt > 0 && resetsAt * 1000 <= now + MAX_AHEAD_MS
          ? Math.round(resetsAt * 1000)
          : null,
    };
  }
  return Object.keys(windows).length > 0 ? windows : undefined;
}

/**
 * Until when Codex's plan can't be used, by a snapshot: the latest reset of its windows used up
 * (usedUpUntil), where its credits say Codex has none to go on with past them (`credits`, as
 * recorded on a plan without any: neither `hasCredits` nor `unlimited`). Undefined where no window
 * is used up, where credits may let Codex go on, or where the snapshot says nothing of them.
 */
export function codexUsedUp(snapshot: unknown, now: number): number | undefined {
  const credits = property(snapshot, 'credits');
  if (property(credits, 'hasCredits') !== false || property(credits, 'unlimited') !== false) {
    return undefined;
  }
  const windows = usageWindows(codexLimits(snapshot) ?? [], now);
  return windows && usedUpUntil(windows, now);
}

/** The window a limit is, by its length; by its place where Codex does not say its length. */
function windowOf({ slot, windowMinutes }: CodexLimit): UsageWindow | undefined {
  if (windowMinutes !== null) return WINDOWS[windowMinutes];
  return slot === 'primary' ? 'fiveHour' : 'weekly';
}
