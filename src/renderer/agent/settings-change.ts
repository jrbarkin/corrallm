import type { AgentSettings, AgentSettingsChange } from '../../shared/session';

const KEYS = ['model', 'effort', 'mode'] as const;

/**
 * What a settings choice changes, from the saved settings it was made against to the settings it
 * leaves: only those fields, null where one goes back to the user's default. agent.setSettings
 * merges what it is given, so a choice made before an earlier one has reached the page (and so
 * made against the same saved settings) does not put the earlier one back.
 */
export function settingsChange(
  saved: AgentSettings | undefined,
  next: AgentSettings,
): AgentSettingsChange {
  const change: Record<string, string | null> = {};
  for (const key of KEYS) {
    const was = saved?.[key] ?? null;
    const now = next[key] ?? null;
    if (was !== now) change[key] = now;
  }
  return change;
}
