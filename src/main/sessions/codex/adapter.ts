import { MAX_IMAGE_BYTES, MAX_IMAGES } from '../../../shared/api/limits';
import { IMAGE_TYPES } from '../../../shared/session';
import type { Adapter } from '../adapter';
import { findCodex, requireCodex } from './codex';
import { AppServerConnector } from './app-server/connector';
import { CodexTerminalConnector } from './terminal/connector';
import { codexOptions } from './options';
import { FakeConnector, FAKE_CODEX_MODELS } from '../fake';
import logo from './logo.svg?raw';
import { UsageReader } from './terminal/usage';

const HOUR = 60 * 60 * 1000;

/** The usage backend both of Codex's connections read (its plan's limits). */
export const CODEX_USAGE = 'codex';

/** Codex's Terminal connection: where an agent goes when its App Server refuses its login. */
export const CODEX_TERMINAL = 'codex.terminal';

/**
 * Codex's modes: its permission presets, as its /permissions names them (by their ids in its
 * source, codex-rs/utils/approval-presets), then its plan collaboration mode, which has Default's
 * permissions.
 */
const MODES = [
  {
    id: 'read-only',
    label: 'Read only',
    description: 'Reads and runs read-only commands; asks before editing',
  },
  {
    id: 'auto',
    label: 'Default',
    description: 'Edits and runs commands in the project folder; asks before going outside it',
  },
  {
    id: 'full-access',
    label: 'Full access',
    description: 'Edits and runs anything, with network access; never asks',
  },
  { id: 'plan', label: 'Plan', description: 'Explores and proposes a plan; changes nothing' },
] as const;

/** How little each asks, by its sandbox: Plan has Default's, Full access none and never asks. */
const RANKS: Readonly<Record<(typeof MODES)[number]['id'], number>> = {
  'read-only': 0,
  plan: 1,
  auto: 2,
  'full-access': 3,
};

/** What reads Codex's limits for the core while they hold its agents: one read at a time. */
const usageReader = new UsageReader();

/**
 * Codex: its own interactive CLI in a terminal (codex/terminal/), or a thread of its app server
 * (codex/app-server/), in corrallm's transcript. Terminal comes first, as Codex's own CLI.
 */
export const codex: Adapter = {
  descriptor: {
    id: 'codex',
    name: 'Codex',
    accent: 1,
    logo,
    words: { defaults: 'Yours, from your Codex config' },
    modes: MODES.map((mode) => ({
      ...mode,
      asks: mode.id !== 'full-access',
      rank: RANKS[mode.id],
    })),
    runtimeModes: false,
    // A resumed thread keeps the developer instructions it started with (openai/codex#19045).
    role: 'append-new',
    resume: true,
    list: false,
    // https://developers.openai.com/codex/cli/slash-commands (now learn.chatgpt.com) and the CLI's
    // source, openai/codex rust-v0.162.1 (read 2026-10-11)
    actions: [
      { name: 'exec_command', description: 'Run a shell command', job: 'shell' },
      {
        name: 'apply_patch',
        description: 'Create, edit, delete or move files with a patch',
        job: 'edit',
      },
      { name: 'view_image', description: 'Look at a local image' },
      { name: 'web_search', description: 'Search the web', job: 'web-search' },
      { name: 'image_gen.imagegen', description: 'Generate or edit images' },
      { name: 'spawn_agent', description: 'Hand a task to a subagent', job: 'subagent' },
      {
        name: '/review',
        description: 'Review working-tree changes and report issues',
        job: 'code-review',
      },
      { name: '/diff', description: 'Show the git diff, untracked files included' },
      { name: '/init', description: 'Write an AGENTS.md for the project', job: 'init' },
      { name: '/plan', description: 'Plan before changing code', job: 'plan' },
      { name: '/goal', description: 'Work toward a long-running goal', job: 'goal' },
      { name: '/worktree', description: 'Continue in a new git worktree', job: 'worktree' },
      { name: '/fork', description: 'Fork the chat into a new one' },
      { name: '/compact', description: 'Summarize the conversation to free context' },
      { name: '/recap', description: 'Summarize the conversation now' },
      { name: '/new', description: 'Start a new chat' },
      { name: '/export', description: 'Export the conversation as Markdown' },
    ],
    connections: [
      {
        id: CODEX_TERMINAL,
        label: 'Terminal',
        short: 'Terminal',
        description: 'Codex itself, in a terminal in its view',
        view: 'terminal',
        // Its command line starts it in Read only (-s, -a); Default is the user's own config, and
        // Plan is chosen in its terminal.
        startModes: ['read-only'],
        live: { effort: false, stopTask: false },
        panels: {},
        images: null,
        usage: CODEX_USAGE,
        // Not checked against its TUI yet: until it is, Shift+Enter types what the terminal types.
        keys: { shiftEnter: null },
        // What follows runs as a shell command, without asking.
        shellPrefix: '!',
      },
      {
        id: 'codex.app-server',
        label: 'App Server',
        short: 'App Server',
        description: 'Codex through its app server, in corrallm’s transcript',
        view: 'transcript',
        startModes: ['read-only', 'auto', 'plan'],
        live: { effort: true, stopTask: false },
        panels: {},
        images: { types: [...IMAGE_TYPES], maxBytes: MAX_IMAGE_BYTES, max: MAX_IMAGES },
        usage: CODEX_USAGE,
      },
    ],
    registerMcp: 'codex mcp add {server} --url {url} --bearer-token-env-var {var}',
  },
  find: findCodex,
  connectors: ({ clientApp, distribution, consent, usage }) => {
    const readings = usage === undefined ? {} : { usage };
    return {
      [CODEX_TERMINAL]: new CodexTerminalConnector(readings),
      'codex.app-server': new AppServerConnector({
        clientApp,
        distribution,
        consent: consent('plan'),
        ...readings,
      }),
    };
  },
  readOptions: async ({ env, cwd }) => codexOptions({ codex: await requireCodex(env), cwd, env }),
  fake: (pause) => new FakeConnector({ pause, adapter: 'codex' }),
  fakeOptions: {
    models: FAKE_CODEX_MODELS,
    // The fake's own default, Codex's Default, asks.
    defaults: { model: null, effort: null, mode: null, asks: true },
  },
  usageBackends: [
    {
      id: CODEX_USAGE,
      label: 'Codex',
      source:
        'Read from Codex’s app server while an App Server agent works, and as a Terminal agent starts and after each turn (asking one of its own, which spends no usage), and so every 10 minutes while a hit limit holds its agents. On an API key, Codex has no usage windows: it reads nothing.',
      windows: [
        { id: 'fiveHour', label: '5-hour', lengthMs: 5 * HOUR },
        { id: 'weekly', label: 'weekly', lengthMs: 7 * 24 * HOUR },
      ],
    },
  ],
  // A private app server of the user's own `codex`, asked only account/rateLimits/read.
  readUsage: async (backend, { env, cwd }) => {
    if (backend !== CODEX_USAGE) return undefined;
    const found = await findCodex(env);
    return found === undefined
      ? undefined
      : (await usageReader.read({ codex: found, cwd, env }))?.windows;
  },
};
