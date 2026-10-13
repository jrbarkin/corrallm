// A stand-in for the `codex` CLI, for tests: `codex --version`, and `codex app-server`, which
// speaks the app server's JSON-RPC over stdio in the shapes the real one uses (Codex CLI 0.160.1:
// see app-server/fixtures/), without a model. It refuses requests before `initialized`, and
// requests without params, as the real one does. A turn echoes the message; one whose text
// starts with "run" first asks to run a command (item/commandExecution/requestApproval) and waits
// for the answer.
//
// Its environment: FAKE_CODEX_LOGIN (chatgpt, apikey or none: what account/read says; apikey by
// default), FAKE_CODEX_FAIL (it prints that on stderr and exits 1 at once).
import { randomUUID } from 'node:crypto';
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
let initialized = false;
let clientName = 'unknown';
let nextRequest = 0;
/** Requests the fake made of the client, waiting for their answers, by id. */
const asked = new Map();
const threads = new Map();

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
    inputModalities: ['text', 'image'],
  },
];

/** Asks the client something, and waits for its answer. */
function ask(method, params) {
  const id = nextRequest;
  nextRequest += 1;
  send({ method, id, params });
  return new Promise((resolve) => asked.set(id, resolve));
}

function thread(cwd) {
  return {
    id: randomUUID(),
    sessionId: randomUUID(),
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    historyMode: 'paginated',
    modelProvider: 'openai',
    model: 'gpt-6.1-sol',
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

async function turn(threadId, input) {
  const turnId = randomUUID();
  const text = input.map((item) => (item.type === 'text' ? item.text : '')).join('');
  const where = { threadId, turnId };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
  notify('turn/started', {
    threadId,
    turn: { id: turnId, items: [], status: 'inProgress', error: null },
  });
  const user = { type: 'userMessage', id: randomUUID(), clientId: null, content: input };
  notify('item/started', { item: user, ...where, startedAtMs: Date.now() });
  notify('item/completed', { item: user, ...where, completedAtMs: Date.now() });
  await pause();
  if (text.startsWith('run')) {
    const command = {
      type: 'commandExecution',
      id: `exec-${randomUUID()}`,
      command: '/bin/zsh -lc "npm test"',
      cwd: threads.get(threadId)?.cwd ?? '/',
      processId: null,
      source: 'agent',
      status: 'inProgress',
      commandActions: [{ type: 'unknown', command: 'npm test' }],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    notify('item/started', { item: command, ...where, startedAtMs: Date.now() });
    const answer = await ask('item/commandExecution/requestApproval', {
      kind: 'command',
      ...where,
      itemId: command.id,
      startedAtMs: Date.now(),
      reason: 'May I run the tests?',
      command: command.command,
      cwd: command.cwd,
      commandActions: command.commandActions,
      proposedExecpolicyAmendment: ['npm', 'test'],
    });
    notify('serverRequest/resolved', { threadId, requestId: nextRequest - 1 });
    const accepted =
      answer?.result?.decision === 'accept' || answer?.result?.decision === 'acceptForSession';
    notify('item/completed', {
      item: {
        ...command,
        status: accepted ? 'completed' : 'declined',
        aggregatedOutput: accepted ? 'Tests: 1 passed\n' : null,
        exitCode: accepted ? 0 : null,
      },
      ...where,
      completedAtMs: Date.now(),
    });
  }
  const reply = {
    type: 'agentMessage',
    id: `msg_${randomUUID()}`,
    text: '',
    phase: 'final_answer',
  };
  notify('item/started', { item: reply, ...where, startedAtMs: Date.now() });
  const said = `You said: ${text}`;
  for (const word of said.split(/(?= )/)) {
    notify('item/agentMessage/delta', { ...where, itemId: reply.id, delta: word });
  }
  notify('item/completed', { item: { ...reply, text: said }, ...where, completedAtMs: Date.now() });
  notify('turn/completed', {
    threadId,
    turn: { id: turnId, items: [], status: 'completed', error: null, durationMs: 10 },
  });
}

function handle({ method, id, params }) {
  const reply = (result) => send({ id, result });
  const fail = (code, message) => send({ error: { code, message }, id });
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
    case 'model/list':
      return reply({ data: MODELS, nextCursor: null });
    case 'thread/start': {
      const made = thread(params.cwd ?? process.cwd());
      threads.set(made.id, made);
      reply({
        thread: made,
        model: made.model,
        cwd: made.cwd,
        approvalPolicy: params.approvalPolicy ?? 'on-request',
      });
      return notify('thread/started', { thread: made });
    }
    case 'turn/start': {
      if (!threads.has(params.threadId))
        return fail(-32600, `thread not found: ${params.threadId}`);
      reply({ turn: { id: randomUUID(), items: [], status: 'inProgress', error: null } });
      return void turn(params.threadId, params.input ?? []);
    }
    case 'turn/interrupt':
      return fail(-32600, 'no active turn to interrupt');
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
