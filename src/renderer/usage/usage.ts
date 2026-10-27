import { adapterIn } from '../../shared/adapter';
import type { AdapterId, Catalog, UsageBackendId } from '../../shared/adapter';
import type { UsageAction, UsageReading, UsageRule, UsageState } from '../../shared/usage';
import { windowText } from '../../shared/model/words';

/*
 * Usage readings and rules as the renderer shows them (src/shared/usage.ts): which backends a
 * canvas's agents spend, and how readings and rules read. How a hold reads, and the backend one
 * agent spends, are the engine's (src/shared/model/words.ts, src/shared/model/catalog.ts).
 */

/**
 * The backend an adapter's agents spend in `catalog`: the first its connections declare, if any.
 * One agent's is its connection's (the engine's usageBackendOf), which may be none.
 */
function backendOfType(catalog: Catalog, adapter: AdapterId): UsageBackendId | undefined {
  const found = adapterIn(catalog, adapter);
  return found?.connections.find((connection) => connection.usage !== null)?.usage ?? undefined;
}

/** The backends the agents of `adapters` use, in the order `catalog` lists backends. */
export function backendsOf(catalog: Catalog, adapters: readonly AdapterId[]): UsageBackendId[] {
  const used = new Set(adapters.map((adapter) => backendOfType(catalog, adapter)));
  return catalog.usageBackends.map((backend) => backend.id).filter((backend) => used.has(backend));
}

/** A backend's latest reading, if it has one. */
export function readingOf(state: UsageState, backend: UsageBackendId): UsageReading | undefined {
  return state.readings.find((reading) => reading.backend === backend);
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
  fallback: {
    label: 'Carry on with the next backend',
    detail: 'Use the next available backend before the next task',
  },
};

/** A rule in words: "Over 80% of the 5-hour window: pause and ask me". */
export function ruleText(rule: UsageRule): string {
  const action = ACTION_INFO[rule.action].label;
  return `Over ${String(rule.percent)}% of the ${windowText(rule.window)}: ${action.charAt(0).toLowerCase()}${action.slice(1)}`;
}
