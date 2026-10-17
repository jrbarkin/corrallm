// A stand-in for the `claude` CLI as the Agent SDK runs it (--input-format stream-json
// --output-format stream-json), for tests: it speaks the same protocol, in the shapes the real
// CLI uses (see fixtures/), without a model. Each message gets a short reply, streamed after a
// moment's thought ("markdown" in the message: a reply in Markdown). "run" in it also runs
// `echo hello` with Bash, "test" runs `npm test`, reporting its progress as it goes, "edit" edits
// notes.txt (in the project folder, for real if it is there: "one" becomes "two"), and
// "background" starts `npm run dev` in the background (until stopped: stop_task), each asking
// first in the default (Manual) and plan modes; "slow" streams slowly enough to interrupt. "ask"
// asks a question taking several answers (AskUserQuestion); "hook" has a PreToolUse hook block a
// command (with --include-hook-events); "suggest" ends with a prediction of the next message (when
// the SDK asked for them); "a form" has its MCP server github ask for a form first (an
// elicitation), and replies with what it got. It has two MCP servers, github (connected) and
// sentry (failed until reconnected), which /mcp's requests list and change.
// Recovery fixtures opt in with "recovery-failed", "recovery-missing" or "recovery-corrected":
// explicit FAILED, no verdict or explicit SUCCEEDED. FAKE_CLAUDE_PROMPTS logs received prompts
// as JSON lines, only when a test gives it a file of its own.
//
// `claude auth status --json` says how it is logged in, as the real one would: with a cloud
// provider (CLAUDE_CODE_USE_BEDROCK, …), an API key (ANTHROPIC_API_KEY), or an apiKeyHelper in
// the project's settings; otherwise with a Claude subscription (claude.ai), as on the machine it
// was recorded on. The project's settings (.claude/settings.json, then settings.local.json) also
// give its default mode, and can disable bypassing permissions.
//
// With file checkpointing on (CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING, as the SDK's
// enableFileCheckpointing sets it), it keeps notes.txt as it was before each message, for the
// SDK's rewindFiles to restore (only while it runs: a new process, as after a fork, has none).
//
// With CLAUDE_CONFIG_DIR set (never otherwise, so that it never writes into the user's own
// ~/.claude), it keeps each conversation's transcript there, as the CLI does: the user's messages
// and its replies, chained by parentUuid, under projects/<the folder's path, dashed>/<id>.jsonl, so
// that the Agent SDK's listSessions, getSessionMessages and forkSession read them.
//
// The connector's tests and the e2e tests point corrallm at it (CORRALLM_CLAUDE_PATH): a path
// ending in .mjs, so the SDK runs it with `node`.
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
/** A flag's value, given as the SDK gives it ("--resume=<id>"), or as two arguments. */
const option = (name) => {
  const joined = args.find((arg) => arg.startsWith(`${name}=`));
  if (joined !== undefined) return joined.slice(name.length + 1);
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
let mode = option('--permission-mode') ?? projectSettings().permissions.defaultMode ?? 'default';
// As the CLI: --model, else the settings' model, else the account's default.
let model = option('--model') ?? projectSettings().model ?? 'claude-opus-5-5';
let cost = 0;

/** Where it keeps the conversation's transcript, if anywhere. */
const transcript = process.env.CLAUDE_CONFIG_DIR
  ? `${process.env.CLAUDE_CONFIG_DIR}/projects/${process.cwd().replace(/[^a-zA-Z0-9]/g, '-')}/${sessionId}.jsonl`
  : undefined;
/** The last entry of the transcript: what the next one follows. */
let leaf = (() => {
  if (!transcript) return null;
  try {
    const entries = readFileSync(transcript, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return entries.findLast((entry) => typeof entry.uuid === 'string')?.uuid ?? null;
  } catch {
    return null;
  }
})();

/** Keeps a user or assistant message (`uuid`, `message`) in the transcript, after the last. */
function keep(type, uuid, message) {
  if (!transcript) return;
  mkdirSync(transcript.slice(0, transcript.lastIndexOf('/')), { recursive: true });
  const entry = {
    parentUuid: leaf,
    isSidechain: false,
    type,
    message,
    uuid,
    timestamp: new Date().toISOString(),
    userType: 'external',
    entrypoint: 'sdk-ts',
    cwd: process.cwd(),
    sessionId,
    version: '2.1.296',
  };
  appendFileSync(transcript, `${JSON.stringify(entry)}\n`);
  leaf = uuid;
}
/** The turn going on, if any: whether it was interrupted. */
let turn;
/** The files it may change: notes.txt in the project folder. */
const NOTES = `${process.cwd()}/notes.txt`;
/** What a file holds, or null if it is not there. */
const contents = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
/** The files as they were before each message, by its uuid (file checkpointing). */
const checkpoints = new Map();

/** Answers rewind_files: what restoring the files to before message `id` changes, done unless `dryRun`. */
function rewindFiles(id, dryRun) {
  const checkpoint = checkpoints.get(id);
  if (!checkpoint) return { canRewind: false, error: 'No file checkpoint found for this message' };
  const changed = [...checkpoint].filter(([file, was]) => contents(file) !== was);
  const lines = (text) => (text ?? '').split('\n').filter(Boolean);
  let insertions = 0;
  let deletions = 0;
  for (const [file, was] of changed) {
    const now = lines(contents(file));
    const then = lines(was);
    insertions += then.filter((line) => !now.includes(line)).length;
    deletions += now.filter((line) => !then.includes(line)).length;
    if (dryRun) continue;
    if (was === null) rmSync(file, { force: true });
    else writeFileSync(file, was);
  }
  return { canRewind: true, filesChanged: changed.map(([file]) => file), insertions, deletions };
}

/** Requests the fake made of the SDK (can_use_tool, elicitation), waiting for its answer. */
const asked = new Map();
/** Its MCP servers, as the CLI reports them (mcp_status). */
const GITHUB = {
  name: 'github',
  status: 'connected',
  serverInfo: { name: 'github-mcp', version: '1.2.0' },
  scope: 'user',
  tools: [{ name: 'create_issue' }, { name: 'list_pull_requests' }],
};
const servers = new Map([
  ['github', GITHUB],
  ['sentry', { name: 'sentry', status: 'failed', error: 'Connection refused', scope: 'project' }],
]);
/** What runs in the background, by task id: the call that started it, and what it is. */
const background = new Map();
let tasks = 0;
/** Whether the SDK asked for predictions of the next message (initialize). */
let suggestions = false;
const hookEvents = args.includes('--include-hook-events');

const MODELS = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Default (recommended)',
    description: 'Opus 5.5 · Best for everyday, complex tasks',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
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

/** Says a message to the SDK; its replies and tool results are kept in the transcript too. */
const say = (message) => {
  process.stdout.write(`${JSON.stringify({ session_id: sessionId, ...message })}\n`);
  if (message.type === 'assistant' || message.type === 'user') {
    keep(message.type, message.uuid, message.message);
  }
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function respond(requestId, response) {
  process.stdout.write(
    `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })}\n`,
  );
}

/** Asks the SDK something (a control request); resolves with its answer. */
function request(body) {
  const requestId = randomUUID();
  process.stdout.write(
    `${JSON.stringify({ type: 'control_request', request_id: requestId, request: body })}\n`,
  );
  return new Promise((resolve) => asked.set(requestId, resolve));
}

/** Asks the SDK whether a tool may run; resolves with its answer. */
function canUseTool(name, input, toolUseId, suggestions) {
  return request({
    subtype: 'can_use_tool',
    tool_name: name,
    display_name: name,
    input,
    tool_use_id: toolUseId,
    permission_suggestions: suggestions,
  });
}

/** Its github server asks the user for a form (an MCP elicitation); resolves with the answer. */
function elicit() {
  return request({
    subtype: 'elicitation',
    mcp_server_name: 'github',
    message: 'Which repository should the issue go in?',
    mode: 'form',
    requested_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', title: 'Repository' },
        draft: { type: 'boolean', title: 'Draft' },
      },
      required: ['repo'],
    },
  });
}

/**
 * A tool call in turn `current` of message `id`: shown, asked about first in the default (Manual)
 * and plan modes, then its result (`said` to the model, `result` structured), or its denial.
 */
async function useTool(current, id, name, input, { said, result, suggestions, act }) {
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
  if (allowed) act?.();
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

/** The work running in the background, as background_tasks_changed lists it. */
function backgroundTasks() {
  say({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [...background].map(([taskId, task]) => ({
      task_id: taskId,
      task_type: 'local_bash',
      description: task.description,
    })),
    uuid: randomUUID(),
  });
}

/** Starts `npm run dev` in the background (asking first, as for any command). */
async function startInBackground(current, id) {
  const toolUseId = `toolu_${randomUUID().replace(/-/g, '')}`;
  const input = {
    command: 'npm run dev',
    description: 'Start the dev server',
    run_in_background: true,
  };
  say({
    type: 'assistant',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input }],
      stop_reason: null,
      usage: { input_tokens: 2, output_tokens: 30 },
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  });
  const answer =
    mode === 'default' || mode === 'plan'
      ? await canUseTool('Bash', input, toolUseId, [])
      : { behavior: 'allow' };
  if (answer.behavior !== 'allow') {
    say({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { tool_use_id: toolUseId, type: 'tool_result', content: answer.message, is_error: true },
        ],
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
    });
    if (answer.interrupt) current.interrupted = true;
    return;
  }
  const taskId = `b${String(++tasks)}`;
  background.set(taskId, { toolUseId, description: input.command });
  // As the CLI does: the task joins the set before it says it started.
  backgroundTasks();
  say({
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    tool_use_id: toolUseId,
    description: input.command,
    task_type: 'local_bash',
    is_backgrounded: true,
    uuid: randomUUID(),
  });
  say({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: toolUseId,
          type: 'tool_result',
          content: `Command running in background with ID: ${taskId}`,
          is_error: false,
        },
      ],
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    tool_use_result: {
      stdout: '',
      stderr: '',
      interrupted: false,
      isImage: false,
      backgroundTaskId: taskId,
    },
  });
}

/** Stops a task running in the background: it says so, and it leaves the set. */
function stopInBackground(taskId) {
  const task = background.get(taskId);
  if (!task) return;
  background.delete(taskId);
  say({
    type: 'system',
    subtype: 'task_updated',
    task_id: taskId,
    patch: { status: 'killed', end_time: Date.now() },
    uuid: randomUUID(),
  });
  say({
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    tool_use_id: task.toolUseId,
    status: 'stopped',
    output_file: '/tmp/claude/tasks/output',
    summary: '',
    uuid: randomUUID(),
  });
  backgroundTasks();
}

/** Asks a question taking several answers, as AskUserQuestion does; says what was answered. */
async function askQuestion(id) {
  const toolUseId = `toolu_${randomUUID().replace(/-/g, '')}`;
  const input = {
    questions: [
      {
        question: 'Which checks should run?',
        header: 'Checks',
        options: [
          { label: 'Lint', description: 'ESLint, zero warnings' },
          { label: 'Tests', description: 'Vitest, every project' },
          { label: 'E2E', description: 'Playwright, on the built app' },
        ],
        multiSelect: true,
      },
    ],
  };
  say({
    type: 'assistant',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'tool_use', id: toolUseId, name: 'AskUserQuestion', input }],
      stop_reason: null,
      usage: { input_tokens: 2, output_tokens: 30 },
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  });
  const answer = await canUseTool('AskUserQuestion', input, toolUseId, []);
  const answers = answer.updatedInput?.answers ?? {};
  say({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: toolUseId,
          type: 'tool_result',
          content:
            answer.behavior === 'allow'
              ? `User has answered your questions: ${JSON.stringify(answers)}`
              : answer.message,
          is_error: answer.behavior !== 'allow',
        },
      ],
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  });
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
  if (process.env.FAKE_CLAUDE_PROMPTS) {
    appendFileSync(
      process.env.FAKE_CLAUDE_PROMPTS,
      `${JSON.stringify({ sessionId, uuid, text })}\n`,
    );
  }
  const current = { interrupted: false };
  turn = current;
  const started = Date.now();
  keep('user', uuid, message.message);
  if (process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING) {
    checkpoints.set(uuid, new Map([[NOTES, contents(NOTES)]]));
  }
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

  const got = text.includes('a form') ? await elicit() : undefined;
  const recovery = text.includes('recovery-corrected')
    ? 'The original task is complete.\nSUCCEEDED'
    : text.includes('recovery-failed')
      ? 'The original task needs a correction.\nFAILED'
      : text.includes('recovery-missing')
        ? 'I inspected the checklist, but gave no task verdict.'
        : undefined;
  const reply = got
    ? [`github got: ${got.action}`, got.content ? ` ${JSON.stringify(got.content)}` : '']
    : text.includes('markdown')
      ? [
          '### What I found\n\n',
          'The **queue** runs in `runner.ts`:\n\n',
          '1. Each agent takes its next task\n2. Waits hold until their target is done\n\n',
          '```ts\nstore.send(agentId, agent, text, onDone);\n```\n\n',
          '| File | Lines |\n|---|--:|\n| runner.ts | 240 |\n| lanes.ts | 180 |\n\n',
          'See [the queue docs](https://docs.example.com/queues).',
        ]
      : [
          `You said: ${text}`,
          images > 0 ? ` (with ${images} image${images === 1 ? '' : 's'})` : '',
        ];
  const pieces = text.includes('slow')
    ? Array.from({ length: 40 }, (_, i) => `${i} `)
    : recovery
      ? [recovery]
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

  if (!current.interrupted && !recovery && text.includes('run')) {
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
  if (!current.interrupted && !recovery && text.includes('hook') && hookEvents) {
    say({
      type: 'system',
      subtype: 'hook_started',
      hook_id: 'hook_1',
      hook_name: 'PreToolUse:Bash',
      hook_event: 'PreToolUse',
      uuid: randomUUID(),
    });
    say({
      type: 'system',
      subtype: 'hook_response',
      hook_id: 'hook_1',
      hook_name: 'PreToolUse:Bash',
      hook_event: 'PreToolUse',
      output: 'Use pnpm, not npm.\n',
      stdout: '',
      stderr: 'Use pnpm, not npm.\n',
      exit_code: 2,
      outcome: 'error',
      uuid: randomUUID(),
    });
  }
  if (!current.interrupted && !recovery && text.includes('test')) {
    const toolUseId = `toolu_${randomUUID().replace(/-/g, '')}`;
    say({
      type: 'assistant',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [
          { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'npm test' } },
        ],
        stop_reason: null,
        usage: { input_tokens: 2, output_tokens: 30 },
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
    });
    for (const elapsed of [1, 2, 3]) {
      await pause(400);
      if (current.interrupted) break;
      say({
        type: 'tool_progress',
        tool_use_id: toolUseId,
        tool_name: 'Bash',
        parent_tool_use_id: null,
        elapsed_time_seconds: elapsed + 0.2,
        uuid: randomUUID(),
      });
    }
    say({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { tool_use_id: toolUseId, type: 'tool_result', content: '42 passed', is_error: false },
        ],
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      tool_use_result: { stdout: '42 passed', stderr: '', interrupted: false, isImage: false },
    });
  }
  if (!current.interrupted && !recovery && text.includes('background'))
    await startInBackground(current, id);
  if (!current.interrupted && !recovery && text.includes('ask')) await askQuestion(id);
  if (!current.interrupted && !recovery && text.includes('edit')) {
    const file = NOTES;
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
        act: () => {
          const was = contents(file);
          if (was !== null) writeFileSync(file, was.replace('one', 'two'));
        },
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
    // After the result, as the CLI predicts the next message.
    if (suggestions && text.includes('suggest')) {
      say({ type: 'prompt_suggestion', suggestion: 'Run the tests', uuid: randomUUID() });
    }
  }
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line.trim() === '') return;
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    const { subtype } = message.request;
    if (subtype === 'initialize') {
      if (process.env.FAKE_CLAUDE_INITIALIZE) {
        appendFileSync(
          process.env.FAKE_CLAUDE_INITIALIZE,
          `${JSON.stringify({ sessionId, request: message.request })}\n`,
        );
      }
      suggestions = message.request.promptSuggestions === true;
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
      if (
        message.request.mode === 'bypassPermissions' &&
        projectSettings().permissions.disableBypassPermissionsMode === 'disable'
      ) {
        process.stdout.write(
          `${JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: message.request_id,
              error:
                'Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration',
            },
          })}\n`,
        );
        return;
      }
      mode = message.request.mode;
      respond(message.request_id, {});
      say({
        type: 'system',
        subtype: 'status',
        status: null,
        permissionMode: mode,
        uuid: randomUUID(),
      });
    } else if (subtype === 'get_settings') {
      respond(message.request_id, {
        effective: projectSettings(),
        sources: [],
        applied: { model, effort: projectSettings().effortLevel ?? null },
      });
    } else if (subtype === 'rewind_files') {
      respond(
        message.request_id,
        rewindFiles(message.request.user_message_id, message.request.dry_run === true),
      );
    } else if (subtype === 'mcp_status') {
      respond(message.request_id, { mcpServers: [...servers.values()] });
    } else if (subtype === 'mcp_reconnect' || subtype === 'mcp_toggle') {
      const server = servers.get(message.request.serverName);
      if (!server) {
        process.stdout.write(
          `${JSON.stringify({
            type: 'control_response',
            response: {
              subtype: 'error',
              request_id: message.request_id,
              error: `Server not found: ${message.request.serverName}`,
            },
          })}\n`,
        );
        return;
      }
      const on = subtype === 'mcp_reconnect' || message.request.enabled;
      servers.set(
        server.name,
        on
          ? { ...GITHUB, name: server.name, scope: server.scope }
          : { name: server.name, status: 'disabled', scope: server.scope },
      );
      respond(message.request_id, {});
    } else if (subtype === 'stop_task') {
      respond(message.request_id, {});
      stopInBackground(message.request.task_id);
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
