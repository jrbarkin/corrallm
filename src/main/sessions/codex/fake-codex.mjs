#!/usr/bin/env node
// A stand-in for the `codex` CLI, for tests: `codex --version`, and `codex app-server`, which
// speaks the app server's JSON-RPC over stdio in the shapes the real one uses (Codex CLI 0.160.1:
// see app-server/fixtures/), without a model. It refuses requests before `initialized`, and
// requests without params, as the real one does.
//
// A turn reasons (a summary, streamed), then replies "You said: <text>" (streamed), and reports
// its token usage and the account's limits. What the message starts with makes it do more:
// - "run": runs `npm test`, asking first in a read-only sandbox (its default), as Codex does
//   (item/commandExecution/requestApproval, Yes, a rule for `npm test`, or No: cancel);
// - "edit": patches hello.txt (a fileChange), asking first in a read-only sandbox;
// - "ask": asks a question (item/tool/requestUserInput) and replies with the answer;
// - "slow": runs `sleep 30`, printing a line every 50 ms, until interrupted (turn/interrupt);
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
// it appends each request it gets to, one JSON line each).
import { randomUUID } from 'node:crypto';
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

const LIMITS = {
  limitId: 'codex',
  limitName: null,
  primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1791896790 },
  secondary: { usedPercent: 3, windowDurationMins: 10080, resetsAt: 1792483590 },
  credits: null,
  planType: 'plus',
  rateLimitReachedType: null,
};

/** Asks the client something, and waits for its answer: resolves with it, and the request's id. */
function ask(method, params) {
  const id = nextRequest;
  nextRequest += 1;
  send({ method, id, params });
  return new Promise((resolve) => asked.set(id, (answer) => resolve({ id, answer })));
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
    approvalPolicy: params.approvalPolicy ?? 'on-request',
    sandbox: SANDBOXES[params.sandbox ?? 'read-only'],
    plan: false,
    turn: undefined,
  };
  threads.set(id, thread);
  return thread;
}

/** One turn: what the thread does with `input`, as the real one says it. */
async function turn(thread, turnId, input, { review, compact } = {}) {
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
  if (text.startsWith('crash')) {
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
    const plan = { type: 'plan', id: `${turnId}-plan`, text: '' };
    const proposed = '# Plan\n\n1. Read the code\n2. Change it\n';
    await item(plan, { ...plan, text: proposed }, () =>
      stream('plan', plan.id, proposed, 'item/plan/delta'),
    );
    return finish('completed');
  }
  if (text.startsWith('fail')) {
    const error = {
      message: 'You’ve hit your usage limit.',
      codexErrorInfo: 'usageLimitExceeded',
      additionalDetails: null,
    };
    notify('error', { error, willRetry: false, threadId, turnId });
    return finish('failed', error);
  }
  if (text.startsWith('todo')) {
    notify('turn/plan/updated', {
      ...where,
      explanation: null,
      plan: [
        { step: 'Read the code', status: 'completed' },
        { step: 'Change it', status: 'inProgress' },
      ],
    });
  }
  if (text.startsWith('run')) {
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
  if (text.startsWith('edit')) {
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
  if (text.startsWith('ask')) {
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
  if (text.startsWith('slow')) {
    const command = {
      type: 'commandExecution',
      id: `exec-${randomUUID()}`,
      command: '/bin/zsh -lc "sleep 30"',
      cwd: thread.cwd,
      status: 'inProgress',
      commandActions: [{ type: 'unknown', command: 'sleep 30' }],
      aggregatedOutput: null,
      exitCode: null,
    };
    notify('item/started', { item: command, ...where, startedAtMs: Date.now() });
    for (let tick = 0; tick < 600 && !state.interrupted; tick += 1) {
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

function handle({ method, id, params }) {
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
    case 'thread/start': {
      const thread = load(randomUUID(), params);
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
  if (message.id !== undefined) handle(message);
});
// Its input ends: it exits, as the real one does.
process.stdin.on('end', () => process.exit(0));
