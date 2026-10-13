import type { InstalledClis } from '../../shared/session';
import { findClaude } from './claude';
import { findCodex } from './codex/codex';

/**
 * Which CLIs the user has: whether `claude` and `codex` are found where connected agents would
 * run them from (claude.ts, codex/codex.ts), in the agents' environment (`env`). It runs neither.
 */
export async function installedClis(env: Readonly<Record<string, string>>): Promise<InstalledClis> {
  const [claude, codex] = await Promise.all([findClaude(env), findCodex(env)]);
  return { claude: claude !== undefined, codex: codex !== undefined };
}
