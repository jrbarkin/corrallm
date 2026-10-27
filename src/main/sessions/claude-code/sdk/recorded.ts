import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { SDKMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk';

/*
 * For tests: what the real Claude Code did through the Agent SDK with Haiku, recorded and kept in
 * fixtures/: its messages, the permission requests it made (canUseTool) and MCP servers' requests
 * (onElicitation), how each was answered, and for the first three each session's history as
 * getSessionMessages reads it back. The machine's paths read /home/user/shop (the project folder),
 * /home/user/elsewhere (a folder beside it) and /home/user; the user's own skills, MCP servers,
 * plugins and usage limits, and long signatures, are left out.
 *
 * Claude Code 2.1.296, through the Agent SDK 0.3.296:
 * - tools-and-compact: Bash, Write (asked, answered "always"), Edit, then /compact.
 * - question-and-plan: in plan mode, AskUserQuestion, a plan approved, then carried out.
 * - subagent-and-interrupt: an Agent call (a subagent reading a file), then a turn interrupted.
 *
 * Claude Code 2.1.311, through the Agent SDK 0.3.306 (B13 C4), in the default mode unless said:
 * - ask-rule: the project's settings ask before reading secret.txt (`permissions.ask`), so a Read
 *   the mode allows is asked for (`decisionReasonType: 'rule'`); `echo` runs unasked; a Read
 *   outside the folder is asked for (`workingDir`), offering a session rule for that folder.
 * - suggestions-and-denials: `touch` asked for with a rule, the folder and Accept edits offered
 *   together (addRules, addDirectories, setMode); `cat` outside the folder with two rules; a Write
 *   outside it with Accept edits and that folder; then a denial with words (the turn goes on) and
 *   one that interrupts (the turn ends aborted).
 * - safety-check: in Accept edits, a Write into .claude/commands asked for all the same
 *   (`safetyCheck`, no suggestions).
 * - mcp-elicitations: a stdio MCP server (tracker) given with the query's options: each of its
 *   tools asked for (`mcpServer`, `serverPolicyAskOnly`), one asking for a form and one for a link
 *   to open (onElicitation, `mode` form and url), each accepted.
 * - plan-into-mode: in plan mode, ExitPlanMode allowed with a session setMode to Accept edits: the
 *   CLI says it is in Accept edits at once, and writes the file unasked.
 */

export type Fixture =
  | 'tools-and-compact'
  | 'question-and-plan'
  | 'subagent-and-interrupt'
  | 'ask-rule'
  | 'suggestions-and-denials'
  | 'safety-check'
  | 'mcp-elicitations'
  | 'plan-into-mode';

/** The fixtures recorded with their sessions' histories. */
export type HistoryFixture = 'tools-and-compact' | 'question-and-plan' | 'subagent-and-interrupt';

/** Where a recorded session worked, and the home folder, as the fixtures name them. */
export const RECORDED_PLACES = { cwd: '/home/user/shop', home: '/home/user' };

/** A permission request the CLI made, and how it was answered. */
export interface RecordedRequest {
  tool: string;
  input: Record<string, unknown>;
  opts: Record<string, unknown>;
}

/** An MCP server's request (onElicitation), and the control request's id. */
export interface RecordedElicitation {
  request: Record<string, unknown>;
  requestId: string;
}

/** One thing that happened, in order. */
export type Recorded =
  | { kind: 'send'; data: Extract<SDKMessage, { type: 'user' }> }
  | { kind: 'message'; data: SDKMessage }
  | { kind: 'canUseTool'; data: RecordedRequest }
  | { kind: 'canUseToolResult'; data: unknown }
  | { kind: 'elicitation'; data: RecordedElicitation }
  | { kind: 'elicitationResult'; data: unknown }
  | { kind: 'initializationResult'; data: { commands: unknown[]; models: unknown[] } }
  | { kind: 'interruptReceipt'; data: unknown };

const FOLDER = path.join(import.meta.dirname, 'fixtures');

export function recorded(name: Fixture): Recorded[] {
  return readFileSync(path.join(FOLDER, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Recorded);
}

/** The messages the CLI sent, in order. */
export function recordedMessages(name: Fixture): SDKMessage[] {
  return recorded(name).flatMap((item) => (item.kind === 'message' ? [item.data] : []));
}

/** The session's history, as getSessionMessages read it after the session. */
export function recordedHistory(name: HistoryFixture): SessionMessage[] {
  return JSON.parse(
    readFileSync(path.join(FOLDER, `${name}.history.json`), 'utf8'),
  ) as SessionMessage[];
}
