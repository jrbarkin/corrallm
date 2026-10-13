// A stand-in for the `claude` CLI as the Agent SDK runs it (--input-format stream-json
// --output-format stream-json), for tests: it speaks the same protocol, in the shapes the real
// CLI uses (see fixtures/), without a model. Each message gets a short reply, streamed after a
// moment's thought ("markdown" in the message: a reply in Markdown). "run" in it also runs
// `echo hello` with Bash, and "edit" edits notes.txt, each asking first in the default (Manual)
// and plan modes; "slow" streams slowly enough to interrupt.
//
// `claude auth status --json` says how it is logged in, as the real one would: with a cloud
// provider (CLAUDE_CODE_USE_BEDROCK, …), an API key (ANTHROPIC_API_KEY), or an apiKeyHelper in
// the project's settings; otherwise with a Claude subscription (claude.ai), as on the machine it
// was recorded on. The project's settings (.claude/settings.json, then settings.local.json) also
// give its default mode, and can disable bypassing permissions.
//
// The connector's tests and the e2e tests point corrallm at it (CORRALLM_CLAUDE_PATH): a path
// ending in .mjs, so the SDK runs it with `node`.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};

/** The project's settings, as far as the fake reads them. */
function projectSettings() {
  const read = (name) => {
    try {
      return JSON.parse(readFileSync(`${process.cwd()}/.claude/${name}`, 'utf8'));
    } catch {
      return {};
    }
  };
  const [shared, local] = [read('settings.json'), read('settings.local.json')];
  return {
    ...shared,
    ...local,
    permissions: { ...(shared.permissions ?? {}), ...(local.permissions ?? {}) },
  };
}

if (args[0] === 'auth' && args[1] === 'status') {
  const env = process.env;
  const provider = env.CLAUDE_CODE_USE_BEDROCK
    ? 'bedrock'
    : env.CLAUDE_CODE_USE_VERTEX
      ? 'vertex'
      : env.CLAUDE_CODE_USE_FOUNDRY
        ? 'foundry'
        : 'firstParty';
  const status =
    provider !== 'firstParty'
      ? { loggedIn: true, authMethod: 'third_party', apiProvider: provider }
      : env.ANTHROPIC_API_KEY
        ? {
            loggedIn: true,
            authMethod: 'api_key',
            apiProvider: provider,
            apiKeySource: 'ANTHROPIC_API_KEY',
          }
        : projectSettings().apiKeyHelper !== undefined
          ? {
              loggedIn: true,
              authMethod: 'api_key_helper',
              apiProvider: provider,
              apiKeySource: 'apiKeyHelper',
            }
          : {
              loggedIn: true,
              authMethod: 'claude.ai',
              apiProvider: provider,
              subscriptionType: 'max',
            };
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  process.exit(0);
}

const sessionId = option('--resume') ?? option('--session-id') ?? randomUUID();
let mode = option('--permission-mode') ?? 'default';
let model = option('--model') ?? 'claude-opus-5-5';
let cost = 0;
/** The turn going on, if any: whether it was interrupted. */
let turn;
/** Requests the fake made of the SDK (can_use_tool), waiting for its answer. */
const asked = new Map();

const MODELS = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Default (recommended)',
    description: 'Opus 5.5 · Best for everyday, complex tasks',
  },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-5-5',
    displayName: 'Haiku 5.5',
    description: 'Fastest for quick answers',
  },
];
const COMMANDS = [
  {
    name: 'compact',
    description: 'Free up context by summarizing the conversation so far',
    argumentHint: '<optional custom summarization instructions>',
    builtin: true,
  },
  { name: 'context', description: 'Show current context usage', argumentHint: '', builtin: true },
];

const say = (message) => {
  process.stdout.write(`${JSON.stringify({ session_id: sessionId, ...message })}\n`);
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function respond(requestId, response) {
  process.stdout.write(
    `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })}\n`,
  );
}

/** Asks the SDK whether a tool may run; resolves with its answer. */
function canUseTool(name, input, toolUseId, suggestions) {
  const requestId = randomUUID();
  process.stdout.write(
    `${JSON.stringify({
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'can_use_tool',
        tool_name: name,
        display_name: name,
        input,
        tool_use_id: toolUseId,
        permission_suggestions: suggestions,
      },
    })}\n`,
  );
  return new Promise((resolve) => asked.set(requestId, resolve));
}

/**
 * A tool call in turn `current` of message `id`: shown, asked about first in the default (Manual)
 * and plan modes, then its result (`said` to the model, `result` structured), or its denial.
 */
async function useTool(current, id, name, input, { said, result, suggestions }) {
  const toolUseId = `toolu_${randomUUID().replace(/-/g, '')}`;
  say({
    type: 'assistant',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'tool_use', id: toolUseId, name, input }],
      stop_reason: null,
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 0,
        output_tokens: 30,
      },
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  });
  const answer =
    mode === 'default' || mode === 'plan'
      ? await canUseTool(name, input, toolUseId, suggestions)
      : { behavior: 'allow' };
  const allowed = answer.behavior === 'allow';
  say({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: toolUseId,
          type: 'tool_result',
          content: allowed ? said : answer.message,
          is_error: !allowed,
        },
      ],
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    ...(allowed ? { tool_use_result: result } : {}),
  });
  if (!allowed && answer.interrupt) current.interrupted = true;
}

async function play(message) {
  const uuid = message.uuid;
  const content = message.message.content;
  const text =
    typeof content === 'string'
      ? content
      : content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
  const images = typeof content === 'string' ? 0 : content.filter((b) => b.type === 'image').length;
  const current = { interrupted: false };
  turn = current;
  const started = Date.now();
  const stamp = { user_message_uuid: uuid, user_message_uuids: [uuid] };
  say({
    type: 'system',
    subtype: 'init',
    cwd: process.cwd(),
    tools: ['Bash', 'Read', 'Edit', 'Write'],
    mcp_servers: [],
    model,
    permissionMode: mode,
    slash_commands: COMMANDS.map((c) => c.name),
    apiKeySource: 'none',
    claude_code_version: '2.1.296',
    output_style: 'default',
    skills: [],
    plugins: [],
    uuid: randomUUID(),
  });

  const id = `msg_${randomUUID()}`;
  say({
    type: 'stream_event',
    event: {
      type: 'message_start',
      message: { id, type: 'message', role: 'assistant', model, content: [] },
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    ...stamp,
  });
  say({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  });
  const thought = `They wrote “${text}”.`;
  say({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: thought },
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  });
  say({
    type: 'assistant',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'thinking', thinking: thought, signature: 'signature' }],
      stop_reason: null,
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 0,
        output_tokens: 10,
      },
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    ...stamp,
  });
  say({
    type: 'stream_event',
    event: { type: 'content_block_stop', index: 0 },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  });

  const reply = text.includes('markdown')
    ? [
        '### What I found\n\n',
        'The **queue** runs in `runner.ts`:\n\n',
        '1. Each agent takes its next task\n2. Waits hold until their target is done\n\n',
        '```ts\nstore.send(agentId, agent, text, onDone);\n```\n\n',
        '| File | Lines |\n|---|--:|\n| runner.ts | 240 |\n| lanes.ts | 180 |',
      ]
    : [`You said: ${text}`, images > 0 ? ` (with ${images} image${images === 1 ? '' : 's'})` : ''];
  const pieces = text.includes('slow')
    ? Array.from({ length: 40 }, (_, i) => `${i} `)
    : reply.filter(Boolean);
  say({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  });
  let written = '';
  for (const piece of pieces) {
    if (current.interrupted) break;
    await pause(text.includes('slow') ? 100 : 20);
    written += piece;
    say({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: piece } },
      parent_tool_use_id: null,
      uuid: randomUUID(),
    });
  }
  say({
    type: 'assistant',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: written }],
      stop_reason: null,
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 0,
        output_tokens: 20,
      },
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    ...(current.interrupted ? { aborted: true } : {}),
  });
  say({
    type: 'stream_event',
    event: { type: 'content_block_stop', index: 1 },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  });

  if (!current.interrupted && text.includes('run')) {
    await useTool(
      current,
      id,
      'Bash',
      { command: 'echo hello', description: 'Print hello' },
      {
        said: 'hello',
        result: { stdout: 'hello', stderr: '', interrupted: false, isImage: false },
        suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Bash', ruleContent: 'echo:*' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
      },
    );
  }
  if (!current.interrupted && text.includes('edit')) {
    const file = `${process.cwd()}/notes.txt`;
    await useTool(
      current,
      id,
      'Edit',
      { file_path: file, old_string: 'one', new_string: 'two' },
      {
        said: `The file ${file} has been updated successfully.`,
        result: {
          filePath: file,
          oldString: 'one',
          newString: 'two',
          structuredPatch: [
            {
              oldStart: 1,
              oldLines: 2,
              newStart: 1,
              newLines: 2,
              lines: ['-one', '+two', ' three'],
            },
          ],
        },
        suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
      },
    );
  }

  say({
    type: 'stream_event',
    event: { type: 'message_stop' },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  });
  cost += 0.01;
  const usage = {
    input_tokens: 2,
    cache_creation_input_tokens: 1000,
    cache_read_input_tokens: 0,
    output_tokens: 20,
  };
  const modelUsage = {
    [model]: {
      inputTokens: 2,
      outputTokens: 20,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 1000,
      webSearchRequests: 0,
      costUSD: cost,
      contextWindow: 200000,
      maxOutputTokens: 64000,
    },
  };
  const common = {
    duration_ms: Date.now() - started,
    duration_api_ms: 10,
    num_turns: 1,
    total_cost_usd: cost,
    usage,
    modelUsage,
    permission_denials: [],
    uuid: randomUUID(),
    origin: { kind: 'human' },
    ...stamp,
  };
  if (turn === current) turn = undefined;
  if (current.interrupted) {
    say({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      stop_reason: null,
      terminal_reason: 'aborted_streaming',
      errors: [],
      ...common,
    });
  } else {
    say({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: written,
      stop_reason: 'end_turn',
      terminal_reason: 'completed',
      ...common,
    });
  }
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line.trim() === '') return;
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    const { subtype } = message.request;
    if (subtype === 'initialize') {
      respond(message.request_id, {
        commands: COMMANDS,
        agents: [],
        output_style: 'default',
        available_output_styles: ['default'],
        models: MODELS,
        account: {},
        claude_code_version: '2.1.296',
      });
    } else if (subtype === 'interrupt') {
      if (turn) turn.interrupted = true;
      respond(message.request_id, { still_queued: [] });
    } else if (subtype === 'set_permission_mode') {
      mode = message.request.mode;
      respond(message.request_id, {});
      say({
        type: 'system',
        subtype: 'status',
        status: null,
        permissionMode: mode,
        uuid: randomUUID(),
      });
    } else if (subtype === 'set_model') {
      model = message.request.model ?? 'claude-opus-5-5';
      respond(message.request_id, {});
    } else {
      respond(message.request_id, {});
    }
  } else if (message.type === 'control_response') {
    const answer = asked.get(message.response.request_id);
    asked.delete(message.response.request_id);
    answer?.(message.response.response ?? { behavior: 'deny', message: 'No answer' });
  } else if (message.type === 'user') {
    void play(message);
  }
});
input.on('close', () => {
  process.exit(0);
});
