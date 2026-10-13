import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';

import {
  getSessionMessages as readHistory,
  query as startQuery,
} from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import { PERMISSION_MODES } from '../../../shared/session';
import type { ModelChoice, SessionEvent } from '../../../shared/session';
import { requireClaude } from '../claude';
import type { Connector, LiveSession, SessionHost, SessionSpec } from '../connector';
import { historyEvents } from './history';
import { Inbox } from './inbox';
import {
  authStatus as askAuthStatus,
  onSubscription,
  SUBSCRIPTION_LOGIN,
  uncheckedLogin,
} from './login';
import { Prompts } from './prompts';
import { SdkSession, Stderr, stopped } from './session';
import { modeSettings } from './settings';
import type { Places } from './tools';
import { sdkMode, Translator } from './translate';

/*
 * The Agent SDK connection: a Claude agent runs as a real Claude Code session, through the
 * Agent SDK (@anthropic-ai/claude-agent-sdk), shown in corrallm's own transcript. The SDK runs the
 * user's own `claude` (claude.ts), so that the session has their login, version and settings, as
 * Claude Code in a terminal would: the claude_code system prompt, the user's, project's and local
 * settings (CLAUDE.md, hooks, skills, commands, MCP servers), in the project folder.
 *
 * It starts only with an API key or a cloud provider (login.ts): Anthropic doesn't allow other
 * products to use a Claude subscription login through the Agent SDK. With one, it says so and
 * offers Terminal, which runs Claude Code itself, instead.
 */

export interface SdkConnectorDeps {
  /** What the CLI is told runs it ("corrallm/0.1.0"), for its User-Agent. */
  clientApp: string;
  /** The Agent SDK's query() and getSessionMessages(); fakes in tests. */
  query?: typeof startQuery;
  getSessionMessages?: typeof readHistory;
  /** Where `claude` is, for the agents' environment. */
  findClaude?: (env: Readonly<Record<string, string>>) => Promise<string>;
  /** How that `claude` is logged in (`claude auth status`; a fake in tests). */
  authStatus?: typeof askAuthStatus;
  home?: string;
}

/** What the CLI says when the session it is to resume has no conversation (no transcript). */
const NO_CONVERSATION = /No conversation found/i;

export class SdkConnector implements Connector {
  readonly #deps: Required<SdkConnectorDeps>;

  constructor({
    clientApp,
    query = startQuery,
    getSessionMessages = readHistory,
    findClaude = requireClaude,
    authStatus = askAuthStatus,
    home = homedir(),
  }: SdkConnectorDeps) {
    this.#deps = { clientApp, query, getSessionMessages, findClaude, authStatus, home };
  }

  async start(spec: SessionSpec, host: SessionHost): Promise<LiveSession> {
    const claude = await this.#deps.findClaude(spec.env);
    await this.#checkLogin(claude, spec, host);
    if (spec.resume === null) return this.#open(spec, host, claude, null);
    try {
      return await this.#open(spec, host, claude, spec.resume);
    } catch (error) {
      // The id has no conversation: one remembered from a Terminal session of the agent before its
      // first message (both connections share it), or one whose transcript is gone. A new one
      // starts, as a Terminal session does then.
      const message = error instanceof Error ? error.message : String(error);
      if (NO_CONVERSATION.test(message)) return this.#open(spec, host, claude, null);
      // Its conversation will not load: a new one starts, and the user is told.
      const session = await this.#open(spec, host, claude, null);
      host.emit({
        type: 'notice',
        id: randomUUID(),
        level: 'warning',
        text: `The earlier conversation could not be resumed, so this is a new one. ${message}`,
      });
      return session;
    }
  }

  /**
   * Refuses to start (saying why, and offering Terminal) unless `claude` has an API key or a cloud
   * provider: never on a Claude subscription login, nor when how it is logged in can't be told.
   */
  async #checkLogin(claude: string, spec: SessionSpec, host: SessionHost): Promise<void> {
    let refusal: string | undefined;
    try {
      const status = await this.#deps.authStatus(claude, { cwd: spec.cwd, env: spec.env });
      if (onSubscription(status, spec.env)) refusal = SUBSCRIPTION_LOGIN;
    } catch (error) {
      refusal = uncheckedLogin(error instanceof Error ? error.message : String(error));
    }
    if (refusal === undefined) return;
    host.emit({
      type: 'notice',
      id: randomUUID(),
      level: 'error',
      text: refusal,
      switchTo: 'terminal',
    });
    throw new Error(refusal);
  }

  async #open(
    spec: SessionSpec,
    host: SessionHost,
    claude: string,
    resume: string | null,
  ): Promise<SdkSession> {
    const realCwd = await realpath(spec.cwd).catch(() => spec.cwd);
    const places = {
      cwd: spec.cwd,
      home: this.#deps.home,
      ...(realCwd === spec.cwd ? {} : { realCwd }),
    };
    const inbox = new Inbox<SDKUserMessage>();
    const stderr = new Stderr();
    const translator = new Translator({ places });
    // Events before the session runs wait, so that 'started' comes first.
    const early: SessionEvent[] = [];
    const live: { session?: SdkSession } = {};
    const emit = (event: SessionEvent) => {
      if (live.session) host.emit(event);
      else early.push(event);
    };
    const prompts = new Prompts(
      { emit, planApproved: (mode) => live.session?.planApproved(mode) },
      places,
    );
    const model = spec.model === null || spec.model === 'default' ? undefined : spec.model;
    const options: Options = {
      pathToClaudeCodeExecutable: claude,
      cwd: spec.cwd,
      env: {
        ...spec.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: this.#deps.clientApp,
        // 'idle', 'running', 'requires_action'; and startup refusals as results, with their reason.
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
        CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1',
      },
      // Claude Code's own system prompt and settings: without them it is a bare agent.
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      // Only a mode the user chose: otherwise their own default mode applies, as in a terminal.
      ...(spec.mode === null ? {} : { permissionMode: sdkMode(spec.mode) }),
      // So that the mode menu can switch to bypassing permissions once the user confirms it (it
      // is never in the Shift+Tab cycle, as in Claude Code without this flag).
      allowDangerouslySkipPermissions: true,
      // Claude Code's file checkpoints, which a rewind restores (rewindFiles).
      enableFileCheckpointing: true,
      canUseTool: prompts.canUseTool,
      // MCP servers' requests: a form to fill in, or a link to open.
      onElicitation: prompts.onElicitation,
      includePartialMessages: true,
      forwardSubagentText: true,
      // Hooks' failures and blocks are shown as Claude Code shows them (translate.ts).
      includeHookEvents: true,
      // What the user might send next, which the composer offers.
      promptSuggestions: true,
      // Interrupting stops the turn; background subagents and commands go on.
      perTaskStopAffordance: true,
      // Thinking as Claude Code shows it: summarized.
      extraArgs: { 'thinking-display': 'summarized' },
      stderr: stderr.write,
      ...(model === undefined ? {} : { model }),
      ...(resume === null ? {} : { resume }),
    };
    const query = this.#deps.query({ prompt: inbox, options });
    let init;
    try {
      init = await query.initializationResult();
    } catch (error) {
      inbox.end();
      query.close();
      throw new Error(stopped(error, stderr), { cause: error });
    }

    const models = init.models.map((m): ModelChoice => ({
      value: m.value,
      label: m.displayName,
      description: m.description,
      ...(m.supportsEffort === true && m.supportedEffortLevels !== undefined
        ? { efforts: [...m.supportedEffortLevels] }
        : {}),
    }));
    const current = model ?? (models.some((m) => m.value === 'default') ? 'default' : null);
    translator.setModels(init.models, current);
    // The mode chosen, or the user's own default (the CLI says so again at its first turn).
    const settings = await modeSettings(query);
    const mode = spec.mode ?? settings.defaultMode ?? 'manual';
    translator.setMode(mode);
    const session = new SdkSession({
      query,
      inbox,
      host,
      translator,
      prompts,
      stderr,
      mode,
      places,
    });
    live.session = session;
    host.emit({
      type: 'started',
      model: current,
      mode,
      models,
      // Bypassing permissions is not offered where the CLI's settings turn it off.
      ...(settings.bypassDisabled
        ? { modes: PERMISSION_MODES.filter((m) => m !== 'bypassPermissions') }
        : {}),
    });
    host.emit({ type: 'commands', commands: SdkSession.commands(init.commands) });
    if (resume !== null) {
      const history = await this.#history(resume, places);
      if (history.length > 0) host.emit({ type: 'history', events: history });
    }
    for (const event of early) host.emit(event);
    return session;
  }

  /** What a resumed session did before; nothing if its transcript cannot be read. */
  async #history(sessionId: string, places: Places): Promise<SessionEvent[]> {
    try {
      // The CLI keeps it by the folder it worked in: its real path.
      const messages = await this.#deps.getSessionMessages(sessionId, {
        dir: places.realCwd ?? places.cwd,
        includeSystemMessages: true,
      });
      return historyEvents(messages, places);
    } catch (error) {
      console.error('Could not read the session’s history:', error);
      return [];
    }
  }
}
