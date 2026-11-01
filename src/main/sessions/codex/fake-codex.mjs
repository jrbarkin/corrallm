#!/usr/bin/env node
// A stand-in for the `codex` CLI, for tests: `codex --version`, and `codex app-server`, which
// speaks the app server's JSON-RPC over stdio in the shapes the real one uses (Codex CLI 0.160.1:
// see app-server/fixtures/), without a model. It refuses requests before `initialized`, and
// requests without params, as the real one does.
//
// A turn reasons (a summary, streamed), then replies "You said: <text>" (streamed), and reports
// its token usage and the account's limits. What the message starts with (after the first line
// corrallm frames a message from anyone but you with) makes it do more:
// - "run": runs `npm test`, asking first in a read-only sandbox (its default), as Codex does
//   (item/commandExecution/requestApproval, Yes, a rule for `npm test`, or No: cancel);
// - "edit": patches hello.txt (a fileChange), asking first in a read-only sandbox;
// - "ask": asks a question (item/tool/requestUserInput) and replies with the answer;
// - "mcp": calls an MCP server's destructive tool, asking first through an elicitation marked
//   codex_approval_kind mcp_tool_call, as Codex 0.162.1 does (fixtures/mcp-approvals.jsonl);
// - "form", "link": an MCP server asks for a six-field form, or to open a link (the same);
// - "stdin": runs `cat` outside the sandbox, asking first, then asks to write to it (kind
//   writeStdin, its own approvalId on the command's item: fixtures/approvals.jsonl);
// - "permissions": asks for network access (item/permissions/requestApproval);
// - "slow": starts a sleeping Node child, left running after turn/interrupt;
// - "background": starts the same child, but completes the turn while it still runs;
// - "todo": keeps a plan (turn/plan/updated);
// - "fail": fails, out of usage (an error, then the turn failed);
// - "crash": exits at once, saying so on stderr;
// in plan mode (collaborationMode plan), it proposes a plan instead. review/start reviews (a turn
// with enteredReviewMode and exitedReviewMode), thread/compact/start compacts (a turn with a
// contextCompaction item). A thread is kept once it has had a turn: thread/resume resumes it,
// with its turns as history, and refuses one never kept ("no rollout found").
//
// Its environment: FAKE_CODEX_LOGIN (chatgpt, apikey or none: what account/read says; apikey by
// default), FAKE_CODEX_FAIL (it prints that on stderr and exits 1 at once), FAKE_CODEX_STATE (a
// file it keeps its threads in, so that a later app server resumes them), FAKE_CODEX_LOG (a file
// it appends each request it gets to, one JSON line each, and each answer to one of its requests,
// as `answer:<method>`), FAKE_CODEX_CONFIG_FAIL (config/read
// fails with that message), FAKE_CODEX_LINGER (how many ms it takes to exit once its input ends,
// as one finishing what it runs: none by default), FAKE_CODEX_START_GATE (a release-file path: as a
// thread starts, an MCP server asks for a form, and thread/start answers only once <path> exists;
// it writes <path>.waiting first), FAKE_CODEX_SANDBOX and FAKE_CODEX_APPROVAL
// (the sandbox and approvals a thread given none runs with, as the user's config.toml would set
// them: read-only and on-request by default).
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const VERSION = '0.160.1';
const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write(`codex-cli ${VERSION}\n`);
  process.exit(0);
}
if (args[0] !== 'app-server') {
  process.stderr.write(`fake codex: only --version and app-server, not ${args.join(' ')}\n`);
  process.exit(2);
}
if (process.env.FAKE_CODEX_FAIL) {
  process.stderr.write(`Error: ${process.env.FAKE_CODEX_FAIL}\n`);
  process.exit(1);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params, emittedAtMs: Date.now() });
const pause = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
let initialized = false;
let clientName = 'unknown';
let nextRequest = 0;
/** Requests the fake made of the client, waiting for their answers, by id. */
const asked = new Map();
/** Threads loaded in this server, by id: their settings, and the turn going on. */
const threads = new Map();
/** App-server process ids are not OS pids. Each belongs to its thread. */
const processes = new Map();
let nextProcess = 1000;
const processLog = (event) => {
  if (process.env.FAKE_CODEX_PROCESS_LOG)
    appendFileSync(process.env.FAKE_CODEX_PROCESS_LOG, `${JSON.stringify(event)}\n`);
};

/** A real sleeping child, reported as a unified-exec command with a separate process id. */
function sleepingCommand(thread, turnId) {
  const threadId = thread.id;
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: 'ignore',
  });
  const processId = String(nextProcess++);
  processes.set(processId, { child, threadId });
  child.once('exit', () => processes.delete(processId));
  processLog({ type: 'process', processId, pid: child.pid, turnId });
  return {
    type: 'commandExecution',
    id: `exec-${randomUUID()}`,
    command: '/bin/zsh -lc "sleep 30"',
    cwd: thread.cwd,
    processId,
    source: 'unifiedExecStartup',
    status: 'inProgress',
    commandActions: [{ type: 'unknown', command: 'sleep 30' }],
    aggregatedOutput: null,
    exitCode: null,
  };
}

const STATE = process.env.FAKE_CODEX_STATE;
/** Threads kept (they had a turn), by id: their cwd, model and turns. */
const kept = STATE && existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const keep = () => {
  if (STATE) writeFileSync(STATE, JSON.stringify(kept));
};

const ACCOUNTS = {
  chatgpt: {
    account: { type: 'chatgpt', email: 'user@example.com', planType: 'plus' },
    requiresOpenaiAuth: true,
  },
  apikey: { account: { type: 'apiKey' }, requiresOpenaiAuth: true },
  none: { account: null, requiresOpenaiAuth: true, workspaceRouting: null },
};

const MODELS = [
  {
    id: 'gpt-6.1-sol',
    model: 'gpt-6.1-sol',
    displayName: 'GPT-6.1-Sol',
    description: 'Latest workhorse model for coding and everyday work.',
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
      { reasoningEffort: 'high', description: 'Greater reasoning depth for complex problems' },
      { reasoningEffort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
    ],
    inputModalities: ['text', 'image'],
  },
  {
    id: 'gpt-6-luna',
    model: 'gpt-6-luna',
    displayName: 'GPT-6-Luna',
    description: 'Fast and affordable model for easier tasks.',
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
    inputModalities: ['text'],
  },
  {
    id: 'gpt-5-old',
    model: 'gpt-5-old',
    displayName: 'GPT-5-Old',
    description: 'Hidden',
    hidden: true,
    isDefault: false,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [],
    inputModalities: ['text'],
  },
];

/** Its plan's limits: windows that reset hours and days from when it runs, as real ones do. */
const STARTED_S = Math.round(Date.now() / 1000);
const LIMITS = {
  limitId: 'codex',
  limitName: null,
  primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: STARTED_S + 3 * 3600 },
  secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: STARTED_S + 5 * 86_400 },
  credits: null,
  planType: 'plus',
  rateLimitReachedType: null,
};

/** Asks the client something, and waits for its answer: resolves with it, and the request's id. */
function ask(method, params) {
  const id = nextRequest;
  nextRequest += 1;
  send({ method, id, params });
  return new Promise((resolve) =>
    asked.set(id, (answer) => {
      if (answer !== undefined && process.env.FAKE_CODEX_LOG) {
        const params = answer.result ?? { error: answer.error };
        appendFileSync(
          process.env.FAKE_CODEX_LOG,
          `${JSON.stringify({ method: `answer:${method}`, params })}\n`,
        );
      }
      resolve({ id, answer });
    }),
  );
}

function threadObject(id, cwd, model) {
  return {
    id,
    sessionId: id,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    historyMode: 'paginated',
    modelProvider: 'openai',
    model,
    status: { type: 'idle' },
    path: null,
    cwd,
    cliVersion: VERSION,
    originator: clientName,
    source: 'vscode',
    name: null,
    turns: [],
  };
}

const SANDBOXES = {
  'read-only': { type: 'readOnly', networkAccess: false },
  'workspace-write': {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
  'danger-full-access': { type: 'dangerFullAccess' },
};

/** What thread/start and thread/resume answer about a thread. */
function threadResult(thread, extra = {}) {
  return {
    thread: threadObject(thread.id, thread.cwd, thread.model),
    model: thread.model,
    modelProvider: 'openai',
    serviceTier: null,
    cwd: thread.cwd,
    instructionSources: [],
    approvalPolicy: thread.approvalPolicy,
    approvalsReviewer: 'user',
    sandbox: thread.sandbox,
    reasoningEffort: 'low',
    ...extra,
  };
}

function load(id, params) {
  const thread = {
    id,
    cwd: params.cwd ?? process.cwd(),
    model: params.model ?? kept[id]?.model ?? 'gpt-6.1-sol',
    approvalPolicy: params.approvalPolicy ?? process.env.FAKE_CODEX_APPROVAL ?? 'on-request',
    sandbox: SANDBOXES[params.sandbox ?? process.env.FAKE_CODEX_SANDBOX ?? 'read-only'],
    plan: false,
    turn: undefined,
  };
  threads.set(id, thread);
  return thread;
}

/** One turn: what the thread does with `input`, as the real one says it. */
async function turn(thread, turnId, input, { review, compact } = {}) {
  processLog({ type: 'turn', turnId, live: [...processes.keys()] });
  const threadId = thread.id;
  const where = { threadId, turnId };
  const state = { interrupted: false };
  thread.turn = { id: turnId, state };
  const items = [];
  const item = async (started, completed = started, between = async () => undefined) => {
    notify('item/started', { item: started, ...where, startedAtMs: Date.now() });
    await between();
    notify('item/completed', { item: completed, ...where, completedAtMs: Date.now() });
    items.push(completed);
  };
  const stream = async (type, id, text, method = 'item/agentMessage/delta', more = {}) => {
    for (const word of text.split(/(?= )/)) {
      notify(method, { ...where, itemId: id, delta: word, ...more });
      await pause(2);
    }
  };
  const finish = (status, error = null) => {
    thread.turn = undefined;
    notify('thread/status/changed', { threadId, status: { type: 'idle' } });
    notify('turn/completed', {
      threadId,
      turn: { id: turnId, items: [], status, error, durationMs: 10 },
    });
    const record = kept[threadId] ?? { cwd: thread.cwd, model: thread.model, turns: [] };
    record.turns.push({ id: turnId, items, status, error, durationMs: 10 });
    kept[threadId] = record;
    keep();
  };

  notify('thread/status/changed', { threadId, status: { type: 'active', activeFlags: [] } });
  notify('turn/started', {
    threadId,
    turn: { id: turnId, items: [], status: 'inProgress', error: null },
  });
  const text = input.map((part) => (part.type === 'text' ? part.text : '')).join('');
  // What it is asked to do: the message, after the first line corrallm frames a party's with.
  const wanted = text.replace(/^\[corrallm\] [^\n]*\n/, '');
  if (wanted.startsWith('crash')) {
    process.stderr.write('Error: it crashed\n');
    process.exit(3);
  }
  const images = input.filter((part) => part.type === 'image').length;
  const skills = input.filter((part) => part.type === 'skill').map((part) => part.name);

  if (compact) {
    await item({ type: 'contextCompaction', id: `cc-${randomUUID()}` });
    return finish('completed');
  }
  if (!review) {
    const user = {
      type: 'userMessage',
      id: randomUUID(),
      clientId: thread.clientId ?? null,
      content: input,
    };
    await item(user);
  }
  if (review) {
    await item({ type: 'enteredReviewMode', id: `review-${randomUUID()}`, review: review });
    await item({
      type: 'exitedReviewMode',
      id: `review-${randomUUID()}`,
      review: 'No issues found in the current changes.',
    });
    return finish('completed');
  }

  const reasoning = { type: 'reasoning', id: `rs_${randomUUID()}`, summary: [], content: [] };
  const thought = `**Reading the request**`;
  await item(reasoning, { ...reasoning, summary: [thought] }, () =>
    stream('thinking', reasoning.id, thought, 'item/reasoning/summaryTextDelta', {
      summaryIndex: 0,
    }),
  );

  const readOnly = thread.sandbox.type === 'readOnly';
  if (thread.plan) {
    if (wanted.startsWith('background')) {
      const command = sleepingCommand(thread, turnId);
      await item(command, { ...command, status: 'completed' });
    }
    const plan = { type: 'plan', id: `${turnId}-plan`, text: '' };
    const proposed = '# Plan\n\n1. Read the code\n2. Change it\n';
    await item(plan, { ...plan, text: proposed }, () =>
      stream('plan', plan.id, proposed, 'item/plan/delta'),
    );
    return finish('completed');
  }
  if (wanted.startsWith('fail')) {
    const error = {
      message: 'You’ve hit your usage limit.',
      codexErrorInfo: 'usageLimitExceeded',
      additionalDetails: null,
    };
    notify('error', { error, willRetry: false, threadId, turnId });
    return finish('failed', error);
  }
  if (wanted.startsWith('todo')) {
    notify('turn/plan/updated', {
      ...where,
      explanation: null,
      plan: [
        { step: 'Read the code', status: 'completed' },
        { step: 'Change it', status: 'inProgress' },
      ],
    });
  }
  if (wanted.startsWith('run')) {
    const command = {
      type: 'commandExecution',
      id: `exec-${randomUUID()}`,
      command: '/bin/zsh -lc "npm test"',
      cwd: thread.cwd,
      processId: null,
      source: 'agent',
      status: 'inProgress',
      commandActions: [{ type: 'unknown', command: 'npm test' }],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    notify('item/started', { item: command, ...where, startedAtMs: Date.now() });
    let decision = 'accept';
    if (readOnly) {
      notify('thread/status/changed', {
        threadId,
        status: { type: 'active', activeFlags: ['waitingOnApproval'] },
      });
      const { id, answer } = await ask('item/commandExecution/requestApproval', {
        kind: 'command',
        ...where,
        itemId: command.id,
        startedAtMs: Date.now(),
        reason: 'May I run the tests?',
        command: command.command,
        cwd: command.cwd,
        commandActions: command.commandActions,
        proposedExecpolicyAmendment: ['npm', 'test'],
        availableDecisions: [
          'accept',
          { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'test'] } },
          'cancel',
        ],
      });
      notify('serverRequest/resolved', { threadId, requestId: id });
      if (state.interrupted) return finish('interrupted');
      decision = answer?.result?.decision ?? 'cancel';
    }
    const accepted = decision !== 'cancel' && decision !== 'decline';
    if (accepted) {
      notify('item/commandExecution/outputDelta', {
        ...where,
        itemId: command.id,
        delta: 'Tests: ',
      });
      notify('item/commandExecution/outputDelta', {
        ...where,
        itemId: command.id,
        delta: '1 passed\n',
      });
    }
    const done = {
      ...command,
      status: accepted ? 'completed' : 'declined',
      aggregatedOutput: accepted ? 'Tests: 1 passed\n' : null,
      exitCode: accepted ? 0 : null,
    };
    notify('item/completed', { item: done, ...where, completedAtMs: Date.now() });
    items.push(done);
    if (decision === 'cancel') return finish('interrupted');
  }
  if (wanted.startsWith('edit')) {
    const change = {
      type: 'fileChange',
      id: `call_${randomUUID()}`,
      status: 'inProgress',
      changes: [
        {
          path: `${thread.cwd}/hello.txt`,
          kind: { type: 'update', move_path: null },
          diff: '@@ -1 +1,2 @@\n hi\n+bye\n',
        },
      ],
    };
    notify('item/started', { item: change, ...where, startedAtMs: Date.now() });
    let decision = 'accept';
    if (readOnly) {
      const { id, answer } = await ask('item/fileChange/requestApproval', {
        ...where,
        itemId: change.id,
        startedAtMs: Date.now(),
        reason: null,
      });
      notify('serverRequest/resolved', { threadId, requestId: id });
      if (state.interrupted) return finish('interrupted');
      decision = answer?.result?.decision ?? 'cancel';
    }
    const accepted = decision === 'accept' || decision === 'acceptForSession';
    const done = { ...change, status: accepted ? 'completed' : 'declined' };
    notify('item/completed', { item: done, ...where, completedAtMs: Date.now() });
    items.push(done);
    if (!accepted) return finish('interrupted');
  }
  let said = `You said: ${text}`;
  if (wanted.startsWith('ask')) {
    const { id, answer } = await ask('item/tool/requestUserInput', {
      ...where,
      itemId: `call_${randomUUID()}`,
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: 'color',
          header: 'Color',
          question: 'Which color?',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'Red', description: 'Warm' },
            { label: 'Blue', description: 'Cool' },
          ],
        },
      ],
    });
    notify('serverRequest/resolved', { threadId, requestId: id });
    if (state.interrupted) return finish('interrupted');
    said = `You picked ${answer?.result?.answers?.color?.answers?.[0] ?? 'nothing'}.`;
  }
  /** An MCP server's tool call, as Codex reports it: asking first, as `asks` does. */
  const mcpCall = async (tool, args, readOnly, asks) => {
    const call = {
      type: 'mcpToolCall',
      id: `exec-${randomUUID()}`,
      server: 'probe',
      tool,
      status: 'inProgress',
      arguments: args,
      appContext: null,
      mcpAppUi: null,
      pluginId: null,
      readOnlyHint: readOnly,
      result: null,
      error: null,
      durationMs: null,
    };
    notify('item/started', { item: call, ...where, startedAtMs: Date.now() });
    const { id, answer } = await ask('mcpServer/elicitation/request', {
      threadId,
      turnId,
      serverName: 'probe',
      ...asks,
    });
    notify('serverRequest/resolved', { threadId, requestId: id });
    const result = answer?.result;
    const ok = result?.action === 'accept';
    const done = {
      ...call,
      status: ok ? 'completed' : 'failed',
      result: ok ? { content: [{ type: 'text', text: 'done' }], structuredContent: null } : null,
      error: ok
        ? null
        : {
            message:
              result?.action === 'decline'
                ? 'user rejected MCP tool call'
                : 'user cancelled MCP tool call',
          },
      durationMs: 1,
    };
    notify('item/completed', { item: done, ...where, completedAtMs: Date.now() });
    items.push(done);
    return result;
  };
  if (wanted.startsWith('mcp')) {
    const result = await mcpCall('save_note', { text: 'a' }, false, {
      mode: 'form',
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        persist: ['session', 'always'],
        tool_title: 'Save note',
        tool_description: 'Saves a short note.',
        tool_params: { text: 'a' },
        tool_params_display: [{ name: 'text', value: 'a', display_name: 'text' }],
      },
      message: 'Allow the probe MCP server to run tool "save_note"?',
      requestedSchema: { type: 'object', properties: {} },
    });
    if (state.interrupted) return finish('interrupted');
    const persist = result?._meta?.persist;
    said =
      result?.action !== 'accept'
        ? 'Not saved.'
        : persist === 'session'
          ? 'Saved, and allowed for this session.'
          : persist === 'always'
            ? 'Saved, and allowed from now on.'
            : 'Saved.';
  }
  if (wanted.startsWith('form')) {
    const result = await mcpCall('profile_form', {}, true, {
      mode: 'form',
      _meta: null,
      message: 'Fill in your profile.',
      requestedSchema: {
        type: 'object',
        properties: {
          age: { type: 'integer', title: 'Age', minimum: 0, maximum: 150 },
          color: {
            type: 'string',
            title: 'Color',
            enum: ['red', 'green', 'blue'],
            enumNames: ['Red', 'Green', 'Blue'],
          },
          email: { type: 'string', title: 'Email', format: 'email' },
          name: { type: 'string', title: 'Name', minLength: 1, maxLength: 40 },
          subscribe: { type: 'boolean', title: 'Subscribe', default: false },
          topics: {
            type: 'array',
            title: 'Topics',
            items: { type: 'string', enum: ['news', 'tips'] },
            minItems: 1,
          },
        },
        required: ['name', 'email'],
      },
    });
    if (state.interrupted) return finish('interrupted');
    said = result?.action === 'accept' ? `Hello, ${String(result.content?.name)}.` : 'No form.';
  }
  if (wanted.startsWith('link')) {
    const result = await mcpCall('sign_in', {}, true, {
      mode: 'url',
      _meta: null,
      message: 'Sign in to continue.',
      url: 'https://auth.example.com/sign-in?state=probe',
      elicitationId: '5b8f7c1e-2f4a-4c1d-9e3b-7a6d5c4b3a21',
    });
    if (state.interrupted) return finish('interrupted');
    said = result?.action === 'accept' ? 'Signed in.' : 'Not signed in.';
  }
  if (wanted.startsWith('stdin')) {
    const command = {
      type: 'commandExecution',
      id: `exec-${randomUUID()}`,
      command: '/bin/zsh -lc cat',
      cwd: thread.cwd,
      processId: null,
      source: 'agent',
      status: 'inProgress',
      commandActions: [{ type: 'unknown', command: 'cat' }],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    notify('item/started', { item: command, ...where, startedAtMs: Date.now() });
    const run = await ask('item/commandExecution/requestApproval', {
      kind: 'command',
      ...where,
      itemId: command.id,
      startedAtMs: Date.now(),
      environmentId: 'local',
      reason: 'test',
      command: command.command,
      cwd: command.cwd,
      commandActions: command.commandActions,
      proposedExecpolicyAmendment: ['cat'],
      availableDecisions: [
        'accept',
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['cat'] } },
        'cancel',
      ],
    });
    notify('serverRequest/resolved', { threadId, requestId: run.id });
    if (state.interrupted || run.answer?.result?.decision === 'cancel') {
      return finish('interrupted');
    }
    const input = await ask('item/commandExecution/requestApproval', {
      kind: 'writeStdin',
      ...where,
      itemId: command.id,
      startedAtMs: Date.now(),
      approvalId: `exec-${randomUUID()}`,
      environmentId: 'local',
      reason:
        'Send input to an existing terminal. This terminal was launched outside the sandbox, bypassing any managed network proxy.',
      command: "write_stdin --session-id 7627 'hi\n'",
      cwd: command.cwd,
      commandActions: [{ type: 'unknown', command: "write_stdin --session-id 7627 'hi\n'" }],
      availableDecisions: ['accept', 'cancel'],
    });
    notify('serverRequest/resolved', { threadId, requestId: input.id });
    if (state.interrupted || input.answer?.result?.decision !== 'accept') {
      return finish('interrupted');
    }
    said = 'Wrote to cat.';
  }
  if (wanted.startsWith('permissions')) {
    const { id, answer } = await ask('item/permissions/requestApproval', {
      ...where,
      itemId: `exec-${randomUUID()}`,
      environmentId: 'local',
      startedAtMs: Date.now(),
      cwd: thread.cwd,
      reason: 'to fetch a page',
      permissions: { network: { enabled: true }, fileSystem: null },
    });
    notify('serverRequest/resolved', { threadId, requestId: id });
    if (state.interrupted) return finish('interrupted');
    said = answer?.result?.permissions?.network ? 'Granted.' : 'Not granted.';
  }
  if (wanted.startsWith('slow') || wanted.startsWith('background')) {
    const command = sleepingCommand(thread, turnId);
    if (wanted.includes('interact')) {
      const earlier = [...processes.keys()][0];
      notify('item/started', {
        ...where,
        item: {
          type: 'commandExecution',
          id: `exec-${randomUUID()}`,
          command: 'write_stdin',
          processId: earlier,
          source: 'unifiedExecInteraction',
          status: 'inProgress',
          exitCode: null,
        },
      });
    }
    notify('item/started', { item: command, ...where, startedAtMs: Date.now() });
    if (wanted.startsWith('background')) {
      const completed = { ...command, status: 'completed' };
      notify('item/completed', { item: completed, ...where, completedAtMs: Date.now() });
      items.push(completed);
      return finish('completed');
    }
    for (let tick = 0; tick < 600 && !state.interrupted; tick += 1) {
      if (wanted.includes('self-interrupt') && tick === 1) state.interrupted = true;
      notify('item/commandExecution/outputDelta', {
        ...where,
        itemId: command.id,
        delta: `tick ${String(tick)}\n`,
      });
      await pause(50);
    }
    items.push(command);
    return finish('interrupted');
  }
  if (images > 0) said += ` [${String(images)} image${images === 1 ? '' : 's'}]`;
  if (skills.length > 0) said += ` [skills: ${skills.join(', ')}]`;
  const reply = {
    type: 'agentMessage',
    id: `msg_${randomUUID()}`,
    text: '',
    phase: 'final_answer',
  };
  await item(reply, { ...reply, text: said }, () => stream('text', reply.id, said));
  notify('thread/tokenUsage/updated', {
    ...where,
    tokenUsage: {
      total: {
        totalTokens: 2000,
        inputTokens: 1900,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 100,
        reasoningOutputTokens: 0,
      },
      last: {
        totalTokens: 2000,
        inputTokens: 1900,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 100,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 200000,
    },
  });
  notify('account/rateLimits/updated', { rateLimits: LIMITS });
  finish('completed');
}

async function handle({ method, id, params }) {
  const reply = (result) => send({ id, result });
  const fail = (code, message) => send({ error: { code, message }, id });
  if (process.env.FAKE_CODEX_LOG) {
    appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ method, params })}\n`);
  }
  if (method === 'initialize') {
    if (initialized) return fail(-32600, 'Already initialized');
    clientName = params?.clientInfo?.name ?? clientName;
    return reply({
      userAgent: `${clientName}/${VERSION} (Fake OS; arm64) fake (${clientName}; ${params?.clientInfo?.version ?? ''})`,
      codexHome: `${process.env.HOME ?? ''}/.codex`,
      platformFamily: 'unix',
      platformOs: 'macos',
    });
  }
  if (!initialized) return fail(-32600, 'Not initialized');
  if (params === undefined) return fail(-32600, 'Invalid request: missing field `params`');
  switch (method) {
    case 'account/read':
      return reply(ACCOUNTS[process.env.FAKE_CODEX_LOGIN ?? 'apikey'] ?? ACCOUNTS.apikey);
    case 'account/rateLimits/read':
      return reply({ rateLimits: LIMITS, rateLimitsByLimitId: { codex: LIMITS } });
    case 'config/read':
      if (process.env.FAKE_CODEX_CONFIG_FAIL)
        return fail(-32000, process.env.FAKE_CODEX_CONFIG_FAIL);
      if (process.env.FAKE_CODEX_DIAGNOSTICS) {
        try {
          appendFileSync(
            process.env.FAKE_CODEX_DIAGNOSTICS,
            JSON.stringify({
              phase: 'config/read',
              node: process.execPath,
              version: process.version,
              cwd: process.cwd(),
              nativeInstructionsPresent: Boolean(process.env.FAKE_CODEX_DEVELOPER_INSTRUCTIONS),
            }) + '\n',
          );
        } catch {
          // Diagnostic output must never change the RPC result.
        }
      }
      return reply({
        config: {
          developer_instructions: process.env.FAKE_CODEX_DEVELOPER_INSTRUCTIONS ?? null,
          model_auto_compact_token_limit: process.env.FAKE_CODEX_COMPACT_AT
            ? Number(process.env.FAKE_CODEX_COMPACT_AT)
            : null,
        },
      });
    case 'model/list':
      return reply({ data: MODELS, nextCursor: null });
    case 'skills/list':
      return reply({
        data: [
          {
            cwd: params.cwds?.[0] ?? process.cwd(),
            skills: [
              {
                name: 'deploy',
                description: 'Deploy the app to staging',
                path: '/skills/deploy/SKILL.md',
                scope: 'repo',
                enabled: true,
                pluginId: null,
              },
            ],
            errors: [],
          },
        ],
      });
    case 'mcpServerStatus/list':
      return reply({
        data: [
          { name: 'docs', tools: { search: {}, fetch: {} }, toolsError: null },
          {
            name: 'apps',
            tools: Object.fromEntries(
              Array.from({ length: 10 }, (_, i) => [`tool_${String(i + 1)}`, {}]),
            ),
            toolsError: null,
          },
        ],
        nextCursor: null,
      });
    case 'thread/list': {
      const data = Object.entries(kept)
        .filter(([, record]) => params.cwd === undefined || record.cwd === params.cwd)
        .slice(0, params.limit ?? 50)
        .map(([id, record]) => ({
          ...threadObject(id, record.cwd, record.model),
          updatedAt: 1,
        }));
      return reply({ data, nextCursor: null });
    }
    case 'thread/start': {
      const thread = load(randomUUID(), params);
      const gate = process.env.FAKE_CODEX_START_GATE;
      if (gate) {
        // An MCP server asks for a form as the thread starts, before thread/start answers.
        void ask('mcpServer/elicitation/request', {
          threadId: thread.id,
          turnId: null,
          serverName: 'probe',
          mode: 'form',
          _meta: null,
          message: 'Fill in your name.',
          requestedSchema: {
            type: 'object',
            properties: { name: { type: 'string', title: 'Name', minLength: 1 } },
            required: ['name'],
          },
        });
        writeFileSync(`${gate}.waiting`, 'waiting');
        while (!existsSync(gate)) await pause(20);
      }
      reply(threadResult(thread));
      return notify('thread/started', {
        thread: threadObject(thread.id, thread.cwd, thread.model),
      });
    }
    case 'thread/resume': {
      const record = kept[params.threadId];
      if (!record) return fail(-32600, `no rollout found for thread id ${params.threadId}`);
      const thread = load(params.threadId, { ...params, cwd: params.cwd ?? record.cwd });
      const page = params.initialTurnsPage;
      const turns = page ? [...record.turns].reverse().slice(0, page.limit ?? 50) : [];
      return reply(
        threadResult(thread, {
          initialTurnsPage: page ? { data: turns, nextCursor: null, backwardsCursor: null } : null,
        }),
      );
    }
    case 'turn/start': {
      const thread = threads.get(params.threadId);
      if (!thread) return fail(-32600, `thread not found: ${params.threadId}`);
      if (thread.turn) return fail(-32600, 'a turn is already running');
      if (params.sandboxPolicy) thread.sandbox = params.sandboxPolicy;
      if (params.model) thread.model = params.model;
      if (params.collaborationMode) thread.plan = params.collaborationMode.mode === 'plan';
      thread.clientId = params.clientUserMessageId ?? null;
      const turnId = randomUUID();
      reply({ turn: { id: turnId, items: [], status: 'inProgress', error: null } });
      return void turn(thread, turnId, params.input ?? []);
    }
    case 'review/start': {
      const thread = threads.get(params.threadId);
      if (!thread) return fail(-32600, `thread not found: ${params.threadId}`);
      const turnId = randomUUID();
      reply({
        turn: { id: turnId, items: [], status: 'inProgress', error: null },
        reviewThreadId: thread.id,
      });
      const target =
        params.target?.type === 'custom' ? params.target.instructions : 'current changes';
      return void turn(thread, turnId, [], { review: target });
    }
    case 'thread/compact/start': {
      const thread = threads.get(params.threadId);
      if (!thread) return fail(-32600, `thread not found: ${params.threadId}`);
      reply({});
      return void turn(thread, randomUUID(), [], { compact: true });
    }
    case 'thread/name/set':
      return reply({});
    case 'turn/interrupt': {
      const thread = threads.get(params.threadId);
      if (!thread?.turn || thread.turn.id !== params.turnId) {
        return fail(-32600, 'no active turn to interrupt');
      }
      thread.turn.state.interrupted = true;
      // A question or an approval waiting is withdrawn.
      for (const [requestId, resolve] of asked) {
        asked.delete(requestId);
        notify('serverRequest/resolved', { threadId: thread.id, requestId });
        resolve(undefined);
      }
      return reply({});
    }
    case 'thread/backgroundTerminals/terminate': {
      const behavior = process.env.FAKE_CODEX_TERMINATE;
      if (behavior === 'hang') return;
      if (behavior === 'missing') return fail(-32601, 'Method not found');
      if (behavior === 'unknown')
        return fail(
          -32600,
          'Invalid request: unknown variant `thread/backgroundTerminals/terminate`',
        );
      if (behavior === 'fail') return fail(-32603, 'Could not stop the process');
      if (behavior === 'delay') await pause(100);
      const running = processes.get(params.processId);
      if (!running || running.threadId !== params.threadId) return reply({ terminated: false });
      running.child.once('exit', () => {
        processLog({ type: 'terminated', processId: params.processId });
        reply({ terminated: true });
      });
      running.child.kill();
      return;
    }
    default:
      return fail(-32600, `Invalid request: unknown variant \`${method}\``);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === undefined && message.id !== undefined) {
    asked.get(message.id)?.(message);
    asked.delete(message.id);
    return;
  }
  if (message.method === 'initialized') {
    initialized = true;
    return;
  }
  if (message.id !== undefined) void handle(message);
});
// Its input ends: it exits, as the real one does (FAKE_CODEX_LINGER ms later, if set).
const linger = Number(process.env.FAKE_CODEX_LINGER ?? 0);
const close = async () => {
  await Promise.all(
    [...processes.values()].map(
      ({ child }) =>
        new Promise((resolve) => {
          child.once('exit', resolve);
          child.kill('SIGKILL');
        }),
    ),
  );
  if (linger > 0) setTimeout(() => process.exit(0), linger);
  else process.exit(0);
};
process.stdin.on('end', () => {
  void close();
});
process.on('SIGTERM', () => {
  void close();
});
