import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { Inbox } from './sdk/inbox';
import fakeClaude from './selftest-claude.mjs?raw';

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
      env: definedEnv(env),
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

function definedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
