import { MAX_IMAGE_BYTES, MAX_IMAGES } from '../../../shared/api/limits';
import { IMAGE_TYPES } from '../../../shared/session';
import type { Adapter } from '../adapter';
import { FakeConnector, FAKE_MODELS } from '../fake';
import { findClaude } from './claude';
import { isUuid } from '../id';
import { claudeOptions } from './claude-settings';
import { TerminalConnector } from './connector';
import { SdkConnector } from './sdk/connector';
import { Conversations } from './sdk/conversations';
import { checkAgentSdk } from './selftest';
import logo from './logo.svg?raw';

const HOUR = 60 * 60 * 1000;

/** The usage backend Claude Code's Terminal sessions read (its subscription's limits). */
export const CLAUDE_USAGE = 'claude-code';

/** Claude Code's Terminal connection: where an agent goes for what the Agent SDK can't do. */
export const CLAUDE_TERMINAL = 'claude-code.terminal';

/** Claude Code's modes, by its settings' names, in the order Shift+Tab cycles them. */
const MODES = [
  { id: 'manual', label: 'Manual', description: 'Asks before editing files or running commands' },
  {
    id: 'acceptEdits',
    label: 'Accept edits',
    description: 'Edits files freely; asks before commands',
  },
  { id: 'plan', label: 'Plan', description: 'Reads and proposes a plan; changes nothing' },
  { id: 'bypassPermissions', label: 'Bypass permissions', description: 'Never asks' },
  { id: 'auto', label: 'Auto', description: 'Decides for itself what needs your approval' },
] as const;

/** How little each asks: Plan changes nothing, bypassing permissions never asks. */
const RANKS: Readonly<Record<(typeof MODES)[number]['id'], number>> = {
  plan: 0,
  manual: 1,
  acceptEdits: 2,
  auto: 3,
  bypassPermissions: 4,
};

/** The modes `--permission-mode` starts Claude Code in, and its Agent SDK sessions: all that ask. */
const START_MODES = ['manual', 'acceptEdits', 'plan', 'auto'];

/**
 * Claude Code: its own interactive CLI in a terminal (sessions/terminal/), or a Claude Code session
 * through the Agent SDK (sdk/), in corrallm's transcript. Terminal comes first: it works
 * with any Claude login, the Agent SDK only with an API key or a cloud provider (Oct 12, 2026).
 */
export const claudeCode: Adapter = {
  descriptor: {
    id: 'claude-code',
    name: 'Claude Code',
    accent: 0,
    logo,
    words: {
      defaults: 'Yours, from Claude Code’s settings',
      mcpHint: 'Add them with claude mcp add, or in the project’s .mcp.json.',
    },
    modes: MODES.map((mode) => ({
      ...mode,
      asks: mode.id !== 'bypassPermissions',
      rank: RANKS[mode.id],
    })),
    runtimeModes: false,
    role: 'append',
    resume: true,
    list: true,
    // https://code.claude.com/docs/en/tools-reference.md, https://code.claude.com/docs/en/commands.md
    // (read 2026-10-11, Claude Code v2.1.287)
    actions: [
      { name: 'Read', description: 'Read files', job: 'read' },
      { name: 'Write', description: 'Create or overwrite files', job: 'write' },
      { name: 'Edit', description: 'Make targeted edits to files', job: 'edit' },
      { name: 'NotebookEdit', description: 'Edit Jupyter notebook cells' },
      { name: 'Glob', description: 'Find files by pattern', job: 'glob' },
      { name: 'Grep', description: 'Search file contents', job: 'grep' },
      { name: 'LSP', description: 'Code intelligence: definitions, references, type errors' },
      { name: 'Bash', description: 'Run shell commands', job: 'shell' },
      { name: 'PowerShell', description: 'Run PowerShell commands' },
      { name: 'Monitor', description: 'Run a background command and watch its output' },
      { name: 'WebFetch', description: 'Fetch a web page', job: 'web-fetch' },
      { name: 'WebSearch', description: 'Search the web', job: 'web-search' },
      { name: 'Agent', description: 'Hand a task to a subagent', job: 'subagent' },
      { name: 'Workflow', description: 'Run a script that orchestrates many subagents' },
      { name: 'EnterWorktree', description: 'Work in an isolated git worktree', job: 'worktree' },
      { name: '/code-review', description: 'Review a diff or PR for bugs', job: 'code-review' },
      { name: '/security-review', description: 'Check changes for security vulnerabilities' },
      { name: '/simplify', description: 'Clean up changed code and apply the fixes' },
      { name: '/verify', description: 'Build and run the app to confirm a change works' },
      { name: '/init', description: 'Write a CLAUDE.md guide for the project', job: 'init' },
      { name: '/plan', description: 'Plan an approach before changing code', job: 'plan' },
      { name: '/batch', description: 'Split a large change into parallel units' },
      { name: '/subtask', description: 'Run a task in a background subagent' },
      { name: '/goal', description: 'Keep working until a condition is met', job: 'goal' },
      { name: '/deep-research', description: 'Research the web and write a cited report' },
      { name: '/compact', description: 'Summarize the conversation to free context' },
      { name: '/clear', description: 'Start over with empty context' },
      { name: '/rewind', description: 'Roll code and conversation back to a checkpoint' },
    ],
    connections: [
      {
        id: CLAUDE_TERMINAL,
        label: 'Terminal',
        short: 'Terminal',
        description: 'Claude Code itself, in a terminal in its view: works with your Claude login',
        view: 'terminal',
        prompts: { approval: 'seen', question: 'seen', plan: 'seen', form: 'none' },
        signals: false,
        context: true,
        api: null,
        startModes: START_MODES,
        live: { effort: false, stopTask: false },
        panels: {},
        images: null,
        usage: CLAUDE_USAGE,
        // A new line in its prompt, as its /terminal-setup binds Shift+Enter.
        keys: { shiftEnter: '\x1b\r' },
        // Its bash mode: what follows runs as a shell command, without asking.
        shellPrefix: '!',
      },
      {
        id: 'claude-code.sdk',
        label: 'Agent SDK',
        short: 'SDK',
        description:
          'Claude Code through the Agent SDK, in corrallm’s transcript: needs an API key or a cloud provider',
        view: 'transcript',
        prompts: {
          approval: 'answerable',
          question: 'answerable',
          plan: 'answerable',
          form: 'answerable',
        },
        // Ask rules and safety checks are reported (sdk/raise.ts' signalsOf), as recorded with
        // Claude Code 2.1.311 (sdk/fixtures/ask-rule.jsonl, safety-check.jsonl): B13 C4.
        signals: true,
        context: true,
        api: null,
        startModes: START_MODES,
        live: { effort: true, stopTask: true },
        panels: {
          resume: true,
          mcp: { changes: ['reconnect', 'disable', 'enable'] },
          rewind: { restores: ['both', 'conversation', 'code'] },
        },
        images: { types: [...IMAGE_TYPES], maxBytes: MAX_IMAGE_BYTES, max: MAX_IMAGES },
        // It runs on an API key or a cloud provider, which have no usage windows.
        usage: null,
        continueIn: {
          connection: CLAUDE_TERMINAL,
          // Claude Code's commands that open a screen of its own, as Claude Code describes them.
          commands: [
            { name: 'login', description: 'Sign in to your Anthropic account' },
            { name: 'logout', description: 'Sign out from your Anthropic account' },
            { name: 'permissions', description: 'Manage allow and deny tool permission rules' },
            { name: 'hooks', description: 'View hook configurations for tool events' },
            { name: 'memory', description: 'Edit CLAUDE.md files and memory settings' },
            {
              name: 'status',
              description: 'Show Claude Code status: version, model, account, API connectivity',
            },
            {
              name: 'export',
              description: 'Export the current conversation to a file or clipboard',
            },
            { name: 'add-dir', description: 'Add a new working directory' },
            { name: 'config', description: 'Open settings' },
            { name: 'theme', description: 'Change the theme' },
            { name: 'ide', description: 'Manage IDE integrations and show status' },
            { name: 'plugin', description: 'Manage Claude Code plugins' },
            { name: 'skills', description: 'List available skills' },
            { name: 'rename', description: 'Rename the current conversation' },
            { name: 'privacy-settings', description: 'View and update your privacy settings' },
            { name: 'help', description: 'Show help and available commands' },
          ].map((command) => ({ ...command, argumentHint: '' })),
          shell: true,
          mcpSignIn: true,
        },
      },
    ],
    registerMcp:
      "claude mcp add --transport http {server} {url} --header 'Authorization: Bearer ${{var}}'",
    // Claude Code runs an HTTP server's headersHelper in a shell at every connect, and again after
    // a 401, reading its JSON object of headers (checked with 2.1.310).
    registerMcpHelper:
      'claude mcp add-json {server} \'{"type":"http","url":"{url}","headersHelper":"{helper}"}\'',
  },
  inheritedEnv: [
    'CLAUDECODE',
    'CLAUDE_PID',
    'CLAUDE_EFFORT',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_BRIDGE_SESSION_ID',
    'CLAUDE_CODE_MESSAGING_SOCKET',
    'CLAUDE_CODE_MESSAGING_TOKEN',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_EXECPATH',
    'CLAUDE_CODE_SESSION_ATTENDED',
    'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_AGENT_SDK_VERSION',
  ],
  find: findClaude,
  isConversationId: isUuid,
  connectors: ({ clientApp, usage, executable }) => ({
    [CLAUDE_TERMINAL]: new TerminalConnector({
      findClaude: executable,
      ...(usage === undefined ? {} : { usage }),
    }),
    'claude-code.sdk': new SdkConnector({ clientApp, findClaude: executable }),
  }),
  readOptions: ({ env, cwd }) => claudeOptions(env, cwd),
  fake: (pause) => new FakeConnector({ pause }),
  fakeOptions: {
    models: FAKE_MODELS,
    // The fake's own default, Manual, asks.
    defaults: { model: null, effort: null, mode: null, asks: true },
  },
  conversations: () => new Conversations(),
  selfTests: [{ name: 'Agent SDK', run: () => checkAgentSdk() }],
  usageBackends: [
    {
      id: CLAUDE_USAGE,
      label: 'Claude',
      source:
        'Read from Claude Code’s status line while a Terminal agent works. Agent SDK agents run on an API key, which has no usage windows: they read nothing.',
      windows: [
        { id: 'fiveHour', label: '5-hour', lengthMs: 5 * HOUR },
        { id: 'weekly', label: 'weekly', lengthMs: 7 * 24 * HOUR },
      ],
    },
  ],
};
