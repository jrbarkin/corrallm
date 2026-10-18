import { adapterIn, usageBackendIn } from '../../shared/adapter';
import type { AdapterId, UsageBackendId } from '../../shared/adapter';
import { WINDOW_NAMES } from '../../shared/usage';
import type {
  UsageAction,
  UsageReading,
  UsageRule,
  UsageState,
  UsageWindow,
} from '../../shared/usage';
import { catalog } from '../catalog';

/*
 * Usage readings and rules as the renderer shows and runs them (src/shared/usage.ts): which
 * backends a canvas's agents spend, and how readings, holds and rules read. The backend one agent
 * spends is the run's catalog's to say (run/catalog.ts usageBackendOf).
 */

/** The backend an adapter's agents spend: the first its connections declare, if any. */
export function backendOfType(adapter: AdapterId): UsageBackendId | undefined {
  const found = adapterIn(catalog(), adapter);
  return found?.connections.find((connection) => connection.usage !== null)?.usage ?? undefined;
}

/** The backends the agents of `adapters` use, in the order backends are listed. */
export function backendsOf(adapters: readonly AdapterId[]): UsageBackendId[] {
  const used = new Set(adapters.map((adapter) => backendOfType(adapter)));
  return catalog()
    .usageBackends.map((backend) => backend.id)
    .filter((backend) => used.has(backend));
}

/** How a backend is named ("Claude"): the catalog's label, else its id. */
export function backendName(backend: UsageBackendId): string {
  return usageBackendIn(catalog(), backend)?.label ?? backend;
}

/** A backend's latest reading, if it has one. */
export function readingOf(state: UsageState, backend: UsageBackendId): UsageReading | undefined {
  return state.readings.find((reading) => reading.backend === backend);
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

/** How long ago a reading was taken: "just now", "4 min ago", "3 h ago", "2 days ago". */
export function ageText(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} h ago`;
  const days = Math.floor(hours / 24);
  return `${String(days)} day${days === 1 ? '' : 's'} ago`;
}

/** How a window is named on its own: "5-hour window". */
export const windowText = (window: UsageWindow): string => `${WINDOW_NAMES[window]} window`;

/** What each action of a usage rule is called, and what it does. */
export const ACTION_INFO: Readonly<Record<UsageAction, { label: string; detail: string }>> = {
  warn: { label: 'Warn me', detail: 'Say so in the agent’s session, and carry on' },
  ask: {
    label: 'Pause and ask me',
    detail: 'Hold each agent before its next task until you say (Needs you)',
  },
  waitForReset: {
    label: 'Finish the task, then wait for the reset',
    detail: 'Let the task going on finish, then hold until the window resets',
  },
};

/** A rule in words: "Over 80% of the 5-hour window: pause and ask me". */
export function ruleText(rule: UsageRule): string {
  const action = ACTION_INFO[rule.action].label;
  return `Over ${String(rule.percent)}% of the ${windowText(rule.window)}: ${action.charAt(0).toLowerCase()}${action.slice(1)}`;
}

/**
 * Where a usage rule holds an agent, before its next task (run/runner.ts AgentRun.usage): whose
 * usage, which window, the rule's share, how much was used then and when the window resets.
 */
export interface UsageHold {
  backend: UsageBackendId;
  window: UsageWindow;
  /** The rule's share. */
  percent: number;
  /** The share used, by the reading that held it. */
  used: number;
  /** When the window resets (epoch ms), if the reading says. */
  resetsAt: number | null;
}

/** What a usage rule's hold says: "Claude has used 84% of its 5-hour window (over 80%)". */
export function holdText({ backend, window, percent, used }: UsageHold): string {
  return `${backendName(backend)} has used ${percentText(used)} of its ${windowText(window)} (over ${String(percent)}%)`;
}

/**
 * What a usage rule's warning says, in the agent's session: "Claude has used 84% of its 5-hour
 * window (over 80%). It resets at 3:40 PM."
 */
export function warningText(hold: UsageHold, now: number, locale?: string): string {
  const reset =
    hold.resetsAt === null ? '' : ` It resets at ${resetTime(hold.resetsAt, now, locale)}.`;
  return `${holdText(hold)}.${reset}`;
}
