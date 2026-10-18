import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import fakeClaude from './selftest-claude.mjs?raw';
import { Inbox } from './sessions/sdk/inbox';
import { Screen } from './sessions/terminal/screen';
import type { ProgramStatus } from './sessions/terminal/status';

/*
 * What the packaged app's self-test (native-selftest.ts) checks besides node-pty: that what
 * connected sessions need loads and runs in the bundle as packaged (CommonJS, fused), with no real
 * `claude` and no login. Each check resolves with what it saw, or rejects saying what failed.
 */

/**
 * Main's copy of a terminal's screen (@xterm/headless, with its addons): it answers Claude Code's
 * status probe, reads a status report, and takes a snapshot.
 */
export async function checkTerminalScreen(): Promise<string> {
  const replies: string[] = [];
  const reports: ProgramStatus[] = [];
  const screen = new Screen({
    cols: 40,
    rows: 5,
    reply: (data) => replies.push(data),
    status: (report) => reports.push(report),
    answersQueries: () => true,
  });
  try {
    screen.write('\x1b]7501;?\x07\x1b]7501;state=working:app=claude-code\x07✻ self-test\r\n');
    const snapshot = await screen.snapshot();
    if (replies.length === 0 || reports[0]?.state !== 'working') {
      throw new Error('the screen did not answer or read Claude Code’s status');
    }
    if (!snapshot.data.includes('self-test')) throw new Error('the snapshot lost the screen');
    return `@xterm/headless ok (${String(snapshot.cols)}×${String(snapshot.rows)})`;
  } finally {
    screen.dispose();
  }
}

/**
 * The Agent SDK as bundled (its own file found through `import.meta.url`, as vite.main.config.mts
 * defines it) starts a query as the Agent SDK connection does (streaming input, the CLI's path
 * given) against a tiny fake `claude` (selftest-claude.mjs, written to a temporary folder and run
 * with `node`, as the SDK runs a .mjs), and hears one turn's result.
 */
export async function checkAgentSdk(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'corrallm-selftest-'));
  const claude = path.join(dir, 'claude.mjs');
  await writeFile(claude, fakeClaude);
  const inbox = new Inbox<SDKUserMessage>();
  const run = query({
    prompt: inbox,
    options: {
      pathToClaudeCodeExecutable: claude,
      cwd: dir,
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      settingSources: [],
    },
  });
  try {
    await run.initializationResult();
    inbox.push({
      type: 'user',
      message: { role: 'user', content: 'Say ok.' },
      parent_tool_use_id: null,
      uuid: randomUUID(),
    });
    for await (const message of run) {
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success') throw new Error(`the query failed (${message.subtype})`);
      return `Agent SDK ok (the fake claude said “${message.result}”)`;
    }
    throw new Error('the query ended without a result');
  } finally {
    inbox.end();
    run.close();
    await rm(dir, { recursive: true, force: true });
  }
}
