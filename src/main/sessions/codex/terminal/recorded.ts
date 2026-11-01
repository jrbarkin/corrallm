import { readFileSync } from 'node:fs';
import path from 'node:path';

import { Screen } from '../../terminal/screen';

/*
 * For tests: what the real Codex CLI (0.160.1, model GPT-6-Luna at low effort) did in its TUI in a
 * pseudo-terminal of 100×30, recorded and kept in fixtures/: everything it printed, its window
 * titles, the hooks it ran (with what they posted), and the keys sent to it, with their times (ms).
 * The project folder reads /work/smoke/p2 (or term1) outside the screen; the user's name, paths
 * and MCP servers are replaced with stand-ins of the same length, so the screens are laid out as
 * drawn.
 *
 * - prompts: a new session; "Say hi in one word." (pasted while its MCP servers start, then
 *   Enter), then "Create a file named bye.txt containing the word bye." (its command approved with
 *   y), then /quit. Its terminal answered Codex's colour queries (its composer is shaded).
 * - resume: that session resumed, then /quit.
 * - resume-missing: a session that does not exist resumed: Codex says so, and exits.
 * - turns: corrallm's own Codex Terminal session (connector.ts, with no view: its composer is not
 *   shaded), in Read only: "Say hi in one word.", "Create a file named hi.txt containing the word
 *   hi." (approved with y), "Write the numbers from 1 to 400, one per line, as plain text."
 *   (interrupted with Escape), then closed (SIGHUP).
 * - context (Codex 0.162.1, B11a C4; GPT-6-Luna at low effort, then GPT-5.6-Luna; /work/smoke/ctx3):
 *   its window titles as corrallm asks for them (`["context-used","activity","run-state"]`) with the
 *   hooks it ran, its screen's compaction notices, and the keys sent. Only titles (a spinner
 *   frame's change kept out), hooks (what corrallm reads), keys and notes are kept, not its
 *   screen. Its model window was lowered for the recording alone (`-c model_context_window=50000`,
 *   so 47,500 usable) and a compaction limit of 40,000 set (`-c model_auto_compact_token_limit`),
 *   neither of which its title shows. Four messages of filler text (the pasted text is left out),
 *   which compacted it as the fourth began (hook SessionStart, source compact); then `/model` to
 *   GPT-5.6-Luna at low effort (picker keys 8, 1); then a short message, which compacted it again.
 *   The hooks' times are lined up with the keys by the first prompt, to within a second. The
 *   token counts beside it in the tests (the session's own `token_count` records, numbers only)
 *   are what its rollout file held for the same session.
 */

export type TerminalFixture = 'prompts' | 'resume' | 'resume-missing' | 'turns' | 'context';

/** The recorded sessions' ids (their threads'): prompts' (and resume's), and turns'. */
export const RECORDED_SESSION = '01a13450-a090-78e2-aba2-01792d6d732d';
export const RECORDED_TURNS_SESSION = '01a13488-405a-7d90-95ce-96f4546ade36';

/** One thing that happened, at `t` ms after the start. */
export type TerminalRecord = { t: number } & (
  | { kind: 'argv'; data: string[] }
  /** What it printed. */
  | { kind: 'out'; data: string }
  /** Its window title changed (also in what it printed). */
  | { kind: 'title'; data: string }
  /** Keys sent to it: text pasted, or a key ("\\r" is Enter). */
  | { kind: 'in'; data: string }
  /** A hook it ran, and the event it posted. */
  | { kind: 'hook'; data: { ok: boolean; ev: Record<string, unknown> } }
  /** The recorder's own note (as "turn 1 done"). */
  | { kind: 'note'; data: string }
  | { kind: 'exit'; data: { exitCode: number; signal: number } }
);

const FOLDER = path.join(import.meta.dirname, 'fixtures');

export function recordedTerminal(name: TerminalFixture): TerminalRecord[] {
  return readFileSync(path.join(FOLDER, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as TerminalRecord);
}

/**
 * A screen (main's copy, as a Terminal session keeps it) showing what it printed until `t`, each
 * write passed through `change` first.
 */
export async function recordedScreen(
  name: TerminalFixture,
  t: number,
  change: (data: string) => string = (data) => data,
): Promise<Screen> {
  const screen = new Screen({
    cols: 100,
    rows: 30,
    reply: () => undefined,
    status: () => undefined,
    answersQueries: () => false,
  });
  for (const record of recordedTerminal(name)) {
    if (record.t > t) break;
    if (record.kind === 'out') screen.write(change(record.data));
  }
  await screen.settled();
  return screen;
}
