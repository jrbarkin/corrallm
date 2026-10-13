import { AgentType } from '../graph/agents';
import type { Step } from './player';
import type { Entry, Mode, Todo } from './session';

/*
 * A scripted turn, until agents are connected: whatever the user asks, the agent thinks, reads and
 * searches the code, makes a to-do list, edits a file and runs the tests, asking permission as its
 * mode says, then sums up and says the session is scripted. Tool names are the agent's own.
 */

/** Each agent's tools for reading, searching, editing and running commands (agents.ts). */
const TOOLS: Record<AgentType, { read: string; search: string; edit: string; shell: string }> = {
  [AgentType.Claude]: { read: 'Read', search: 'Grep', edit: 'Edit', shell: 'Bash' },
  [AgentType.Codex]: {
    read: 'exec_command',
    search: 'exec_command',
    edit: 'apply_patch',
    shell: 'exec_command',
  },
  [AgentType.Qwen]: {
    read: 'read_file',
    search: 'grep_search',
    edit: 'edit',
    shell: 'run_shell_command',
  },
  [AgentType.Gemini]: {
    read: 'read_file',
    search: 'grep_search',
    edit: 'replace',
    shell: 'run_shell_command',
  },
};

const FILE = 'src/index.ts';
const COMMAND = 'npm test';
const DIFF: Extract<Entry, { kind: 'tool' }>['detail'] = {
  kind: 'diff',
  added: 4,
  removed: 1,
  lines: [
    { kind: 'same', text: 'export function start(options: Options) {' },
    { kind: 'remove', text: '  const server = createServer(options);' },
    { kind: 'add', text: '  const server = createServer({' },
    { kind: 'add', text: '    ...options,' },
    { kind: 'add', text: '    retries: options.retries ?? 3,' },
    { kind: 'add', text: '  });' },
    { kind: 'same', text: '  return server.listen();' },
    { kind: 'same', text: '}' },
  ],
};

export function scriptedTurn(
  prompt: string,
  agent: AgentType,
  mode: Mode,
  newId: () => string,
): Step[] {
  const tools = TOOLS[agent];
  const codex = agent === AgentType.Codex;
  const note =
    agent === AgentType.Claude
      ? '_This is a scripted session, so nothing here really ran: connect Claude Code from the agent chip (Terminal or Agent SDK) to run it._'
      : `_This is a scripted session: corrallm isn't connected to ${agent} yet, so nothing here really ran._`;

  /** A tool call that runs for `ms`, then shows `detail`. */
  const call = (
    tool: string,
    summary: string,
    ms: number,
    detail?: Extract<Entry, { kind: 'tool' }>['detail'],
  ): Step[] => {
    const id = newId();
    return [
      { kind: 'add', entry: { id, kind: 'tool', tool, summary, status: 'running' } },
      { kind: 'pause', ms },
      {
        kind: 'update',
        id,
        update: (entry) =>
          entry.kind === 'tool'
            ? { ...entry, status: 'done', ...(detail ? { detail } : {}) }
            : entry,
      },
    ];
  };
  const todos = newId();
  const progress = (done: number): Step => ({
    kind: 'update',
    id: todos,
    update: (entry) =>
      entry.kind === 'todos'
        ? {
            ...entry,
            items: entry.items.map((item, i): Todo => ({
              ...item,
              status: i < done ? 'done' : i === done ? 'active' : 'pending',
            })),
          }
        : entry,
  });
  /** `steps`, behind a permission prompt for `tool` unless the mode lets it act freely. */
  const asking = (
    tool: string,
    summary: string,
    free: boolean,
    steps: Step[],
    deny: Step[],
  ): Step[] =>
    free
      ? steps
      : [
          {
            kind: 'ask',
            entry: { id: newId(), kind: 'permission', tool, summary },
            allow: steps,
            deny,
          },
        ];

  const look: Step[] = [
    { kind: 'pause', ms: 400 },
    {
      kind: 'add',
      entry: {
        id: newId(),
        kind: 'thinking',
        seconds: 2,
        text: `The user asked: “${prompt}”. Before changing anything, I should read the code this touches and check for related work.`,
      },
    },
    { kind: 'pause', ms: 300 },
    { kind: 'stream', id: newId(), text: "I'll start by reading the code this touches." },
    ...call(tools.read, codex ? `cat ${FILE}` : FILE, 500, { kind: 'output', text: '58 lines' }),
    ...call(tools.search, codex ? 'rg TODO src' : '"TODO" in src', 400, {
      kind: 'output',
      text: 'No matches',
    }),
  ];

  if (mode === 'plan') {
    return [
      ...look,
      {
        kind: 'stream',
        id: newId(),
        text: `Here's my plan:\n\n1. Change \`start\` in **${FILE}** to do what you asked\n2. Add a test for it\n3. Run \`${COMMAND}\`\n\nSwitch out of Plan mode and tell me to go ahead when you're happy with it.\n\n${note}`,
      },
    ];
  }

  const free = mode === 'auto' || mode === 'bypassPermissions';
  return [
    ...look,
    {
      kind: 'add',
      entry: {
        id: todos,
        kind: 'todos',
        items: [
          { text: 'Read the code it touches', status: 'done' },
          { text: 'Make the change', status: 'active' },
          { text: 'Run the tests', status: 'pending' },
        ],
      },
    },
    { kind: 'pause', ms: 400 },
    ...asking(
      tools.edit,
      FILE,
      free || mode === 'acceptEdits',
      [...call(tools.edit, FILE, 600, DIFF), progress(2)],
      [
        {
          kind: 'stream',
          id: newId(),
          text: `OK, I've left **${FILE}** as it was. Tell me what to do differently.\n\n${note}`,
        },
        { kind: 'end' },
      ],
    ),
    { kind: 'pause', ms: 300 },
    ...asking(
      tools.shell,
      COMMAND,
      free,
      [
        ...call(tools.shell, COMMAND, 1200, { kind: 'output', text: 'Tests: 42 passed, 42 total' }),
        progress(3),
        {
          kind: 'stream',
          id: newId(),
          text: `Done. Here's what changed:\n\n- **${FILE}**: the change you asked for, in four lines\n- The tests pass: 42 of 42\n\n${note}`,
        },
      ],
      [
        {
          kind: 'stream',
          id: newId(),
          text: `OK, I won't run them. Run \`${COMMAND}\` yourself to check the change.\n\n${note}`,
        },
      ],
    ),
  ];
}
