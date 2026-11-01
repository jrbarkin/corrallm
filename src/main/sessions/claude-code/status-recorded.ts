import { readFileSync } from 'node:fs';
import path from 'node:path';

/*
 * For tests: what the real Claude Code (2.1.316, Haiku 5.5) gave a status line command in its
 * terminal while it compacted by itself (B11a C4), kept in fixtures/status-line-compaction.jsonl:
 * every input its status line command received (the fields corrallm reads: model, cost, context
 * and usage limits; its session, folder and transcript paths are left out), and the hooks it ran
 * (PreCompact, SessionStart with source compact, PostCompact, Stop), with when (ms from the
 * first input; the hooks' times are approximate). It ran in a scratch folder with its user, MCP
 * and slash-command settings left out, only the Read tool, and its auto-compact window lowered
 * to the minimum for the recording alone (CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000: it compacts at
 * 67,000 tokens, while its status line still divides by the model's 1M window). Each turn read a
 * generated 42 KB text file; it compacted by itself in the middle of the third turn, when the
 * response that asked to read the third file (52,381 tokens in context) was about to be followed
 * by the file's 20,000-odd tokens.
 */

export type StatusRecord =
  | { t: number; kind: 'status'; data: Record<string, unknown> }
  | {
      t: number;
      kind: 'hook';
      data: {
        hook_event_name: string;
        source?: string;
        trigger?: string;
        model?: string;
        permission_mode?: string;
      };
    };

export function recordedStatus(): StatusRecord[] {
  return readFileSync(
    path.join(import.meta.dirname, 'fixtures', 'status-line-compaction.jsonl'),
    'utf8',
  )
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as StatusRecord)
    .sort((a, b) => a.t - b.t);
}
