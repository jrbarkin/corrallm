import type { InstalledClis } from '../../shared/session';
import { findClaude } from './claude';
import { findCodex } from './codex/codex';

/**
 * Which agents the user has, by adapter: whether `claude` and `codex` are found where connected
 * agents would run them from (claude.ts, codex/codex.ts), in the agents' environment (`env`). It
 * runs neither.
 */
export async function installedClis(env: Readonly<Record<string, string>>): Promise<InstalledClis> {
  const [claude, codex] = await Promise.all([findClaude(env), findCodex(env)]);
  return { 'claude-code': claude !== undefined, codex: codex !== undefined };
}
