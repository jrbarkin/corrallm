import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { SDKMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk';

/*
 * For tests: what the real Claude Code (2.1.296, through the Agent SDK 0.3.296, model Haiku)
 * did in three short sessions, recorded and kept in fixtures/: its messages, the permission
 * requests it made (canUseTool) and how they were answered, and each session's history as
 * getSessionMessages reads it back. The machine's paths read /home/user/shop (the project folder)
 * and /home/user; the user's own skills, MCP servers and plugins, and long signatures, are left out.
 *
 * - tools-and-compact: Bash, Write (asked, answered "always"), Edit, then /compact.
 * - question-and-plan: in plan mode, AskUserQuestion, a plan approved, then carried out.
 * - subagent-and-interrupt: an Agent call (a subagent reading a file), then a turn interrupted.
 */

export type Fixture = 'tools-and-compact' | 'question-and-plan' | 'subagent-and-interrupt';

/** Where a recorded session worked, and the home folder, as the fixtures name them. */
export const RECORDED_PLACES = { cwd: '/home/user/shop', home: '/home/user' };

/** A permission request the CLI made, and how it was answered. */
export interface RecordedRequest {
  tool: string;
  input: Record<string, unknown>;
  opts: Record<string, unknown>;
}

/** One thing that happened, in order. */
export type Recorded =
  | { kind: 'send'; data: Extract<SDKMessage, { type: 'user' }> }
  | { kind: 'message'; data: SDKMessage }
  | { kind: 'canUseTool'; data: RecordedRequest }
  | { kind: 'canUseToolResult'; data: unknown }
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
export function recordedHistory(name: Fixture): SessionMessage[] {
  return JSON.parse(
    readFileSync(path.join(FOLDER, `${name}.history.json`), 'utf8'),
  ) as SessionMessage[];
}
