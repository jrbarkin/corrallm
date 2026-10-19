import { randomUUID } from 'node:crypto';

import type {
  EffortLevel,
  Query,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { isPermissionMode } from '../../../shared/session';
import type {
  FilesRewind,
  McpChange,
  McpServer,
  PermissionMode,
  PlanMode,
  SessionAnswer,
  SessionEvent,
  SlashCommand,
  UserMessage,
  TurnResult,
} from '../../../shared/session';
import type { LiveSession, SessionHost } from '../connector';
import type { Inbox } from './inbox';
import { mcpServer } from './mcp';
import { displayPath } from './tools';
import type { Places } from './tools';
import type { Prompts } from './prompts';
import type { PeerMessages } from './settings';
import { sdkMode } from './translate';
import type { Translator } from './translate';

/*
 * A Claude Code session run through the Agent SDK: one streaming query, its CLI running for as
 * long as the session does. Messages go in through the query's inbox, one per turn; what the CLI
 * says comes back through the translator as session events; prompts wait on the user. Each turn
 * ends with the CLI's result for the message that started it.
 */

/**
 * Claude Code's /effort levels, least to most, with what its effort menu says of each (as the
 * picker offers them, where a model takes one).
 */
export const CLAUDE_EFFORTS: Readonly<Record<EffortLevel, string>> = {
  low: 'Quick, straightforward implementation',
  medium: 'Balanced approach with standard testing',
  high: 'Comprehensive implementation with extensive testing',
  xhigh: 'Extended reasoning with thorough analysis',
  max: 'Maximum capability with deepest reasoning (this session only)',
};
const CLAUDE_EFFORT_LEVELS = Object.keys(CLAUDE_EFFORTS) as EffortLevel[];

/** How long after a plan is approved the CLI may take to leave plan mode, before the mode is set. */
const PLAN_EXIT_MS = 1500;
/** How long the session's last error output is kept, to say why it stopped. */
const STDERR_CHARS = 4000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An interrupt that also cancels what waits in the CLI's queue (the runtime takes it; its types do not say). */
type Interrupt = (options?: {
  cancelQueued?: boolean;
}) => Promise<SDKControlInterruptResponse | undefined>;

export interface SdkSessionParts {
  query: Query;
  inbox: Inbox<SDKUserMessage>;
  host: SessionHost;
  translator: Translator;
  prompts: Prompts;
  /** What the CLI has written to stderr lately. */
  stderr: Stderr;
  /** The mode it starts in. */
  mode: PermissionMode;
  /** Where it works, to name the files a rewind restores. */
  places: Places;
  /** What the CLI's settings say it does with a message from another session, if they say. */
  peers?: PeerMessages;
}

/** The end of what a CLI wrote to stderr: what it said last, when it stops. */
export class Stderr {
  #text = '';

  readonly write = (data: string): void => {
    this.#text = (this.#text + data).slice(-STDERR_CHARS);
  };

  /** Its last line that says something, if any. */
  last(): string | undefined {
    return this.#text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .at(-1);
  }
}

/** Why the session stopped, in a sentence, with what its CLI said last. */
export function stopped(error: unknown, stderr: Stderr): string {
  const said = error instanceof Error ? error.message : String(error);
  const last = stderr.last();
  return last === undefined || said.includes(last) ? said : `${said}: ${last}`;
}

export class SdkSession implements LiveSession {
  readonly #query: Query;
  readonly #inbox: Inbox<SDKUserMessage>;
  readonly #host: SessionHost;
  readonly #translator: Translator;
  readonly #prompts: Prompts;
  readonly #stderr: Stderr;
  readonly #places: Places;
  readonly #peers: PeerMessages | undefined;
  /** Messages sent whose turn has not ended: the CLI's uuid for each, and the renderer's id. */
  readonly #pending = new Map<string, string>();
  #mode: PermissionMode;
  #interrupting = false;
  #closing = false;
  #sessionId: string | undefined;
  /** The mode a plan just approved is to be carried out in, once the CLI has left plan mode. */
  #afterPlan: { mode: PermissionMode; timer: ReturnType<typeof setTimeout> } | undefined;
  readonly #pump: Promise<void>;

  constructor({
    query,
    inbox,
    host,
    translator,
    prompts,
    stderr,
    mode,
    places,
    peers,
  }: SdkSessionParts) {
    this.#mode = mode;
    this.#places = places;
    this.#peers = peers;
    this.#query = query;
    this.#inbox = inbox;
    this.#host = host;
    this.#translator = translator;
    this.#prompts = prompts;
    this.#stderr = stderr;
    this.#pump = this.#read();
  }

  send({ id, text, images, from }: UserMessage): Promise<void> {
    const refused = from === undefined ? undefined : this.#peerRefusal();
    if (refused !== undefined) return Promise.reject(new Error(refused));
    // The CLI names a message by a uuid, and so does the renderer, usually.
    const uuid = UUID.test(id) ? id : randomUUID();
    const content: SDKUserMessage['message']['content'] =
      images === undefined || images.length === 0
        ? text
        : [
            ...images.map((image) => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: image.mediaType, data: image.data },
            })),
            ...(text === '' ? [] : [{ type: 'text' as const, text }]),
          ];
    this.#pending.set(uuid, id);
    this.#inbox.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      uuid: uuid as SDKUserMessage['uuid'] & string,
      // Another party's message is a peer's, never the user's: declaring no mode for it, its
      // strict trust gates fail it closed (and where the CLI would hold it, it isn't sent).
      origin:
        from === undefined
          ? { kind: 'human' }
          : { kind: 'peer', from: from.party, name: from.name },
    });
    this.#host.emit({ type: 'user', id, text });
    this.#host.emit({ type: 'status', status: 'working' });
    return Promise.resolve();
  }

  /**
   * Why another party's message isn't sent, if it isn't: the CLI would hold it for its user's
   * review, nowhere corrallm shows it, or refuse it, so no result would ever end its turn. Its
   * settings say to hold or refuse messages from other sessions (crossSessionInbound), or, unless
   * they say to accept them, it bypasses permissions, and so holds a peer's message that declares
   * no mode of its own (as corrallm's never do).
   */
  #peerRefusal(): string | undefined {
    if (this.#peers === 'hold') {
      return 'Not sent: this agent’s Claude Code settings hold messages from other sessions for its user to review (crossSessionInbound), which corrallm can’t show.';
    }
    if (this.#peers === 'refuse') {
      return 'Not sent: this agent’s Claude Code settings refuse messages from other sessions (crossSessionInbound).';
    }
    if (this.#peers !== 'accept' && this.#mode === 'bypassPermissions') {
      return 'Not sent: this agent bypasses permissions, and while it does Claude Code holds a message from another party for its user to review, which corrallm can’t show.';
    }
    return undefined;
  }

  answer(promptId: string, answer: SessionAnswer): Promise<void> {
    try {
      this.#prompts.answer(promptId, answer);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async interrupt(): Promise<void> {
    if (this.#pending.size > 0) this.#interrupting = true;
    const interrupt: Interrupt = this.#query.interrupt.bind(this.#query);
    const receipt = await interrupt({ cancelQueued: true });
    // Messages still waiting in the CLI's queue are cancelled: no result will end their turns.
    const cancelled = (receipt?.cancelled ?? []).filter((uuid) => this.#pending.has(uuid));
    if (cancelled.length > 0)
      this.#end(cancelled, {
        seconds: 1,
        result: { status: 'cancelled', reason: 'taken-back' },
      });
  }

  async setMode(mode: PermissionMode): Promise<void> {
    const before = this.#mode;
    this.#mode = mode;
    // The CLI's echo of it is not news.
    this.#translator.setMode(mode);
    try {
      await this.#query.setPermissionMode(sdkMode(mode));
    } catch (error) {
      // The renderer shows the mode it asked for: it goes back.
      this.#mode = before;
      this.#translator.setMode(before);
      this.#host.emit({ type: 'mode', mode: before });
      throw error;
    }
    // Said, so that a view that heard another mode since it asked (the session's 'started', when
    // the mode was picked as it started) shows the one it is in.
    this.#host.emit({ type: 'mode', mode });
  }

  async setModel(model: string): Promise<void> {
    await this.#query.setModel(model);
    this.#translator.setModel(model);
    this.#host.emit({ type: 'model', model });
  }

  /**
   * Restores the files to how they were before a message (one the CLI knows: by its uuid), or with
   * `dryRun` says what that would change; never while a turn goes on.
   */
  async rewindFiles(messageId: string, dryRun: boolean): Promise<FilesRewind> {
    if (!UUID.test(messageId)) throw new Error('That message can’t be rewound to.');
    if (this.#pending.size > 0) {
      throw new Error('Rewinding waits until it is done: stop it first (Esc).');
    }
    const result = await this.#query.rewindFiles(messageId, { dryRun });
    return {
      possible: result.canRewind,
      ...(result.error === undefined || result.error === '' ? {} : { error: result.error }),
      files: (result.filesChanged ?? []).map((file) => displayPath(file, this.#places)),
      added: result.insertions ?? 0,
      removed: result.deletions ?? 0,
    };
  }

  async mcpServers(): Promise<McpServer[]> {
    return (await this.#query.mcpServerStatus()).map(mcpServer);
  }

  async changeMcpServer(name: string, change: McpChange): Promise<void> {
    if (change === 'reconnect') await this.#query.reconnectMcpServer(name);
    else await this.#query.toggleMcpServer(name, change === 'enable');
  }

  /** For this session only, as Claude Code's /effort does without saving it. */
  async setEffort(effort: string | null): Promise<void> {
    const level = effort === null ? null : CLAUDE_EFFORT_LEVELS.find((one) => one === effort);
    if (level === undefined) throw new Error(`Claude Code has no ${String(effort)} effort.`);
    await this.#query.applyFlagSettings({ effortLevel: level });
  }

  /** Stops a task the CLI runs in the background; its notification says it stopped. */
  async stopTask(taskId: string): Promise<void> {
    if (!this.#translator.runsInBackground(taskId)) {
      throw new Error('That task is not running in the background.');
    }
    await this.#query.stopTask(taskId);
  }

  async close(): Promise<void> {
    this.#closing = true;
    if (this.#afterPlan) clearTimeout(this.#afterPlan.timer);
    this.#prompts.withdrawAll();
    this.#inbox.end();
    this.#query.close();
    await this.#pump;
  }

  /** A plan was approved: once the CLI leaves plan mode, the session goes on in `mode`. */
  planApproved(mode: PlanMode): void {
    const wanted: PermissionMode = mode;
    if (this.#afterPlan) clearTimeout(this.#afterPlan.timer);
    // In case the CLI never says it left plan mode.
    const timer = setTimeout(() => {
      this.#leavePlan(undefined);
    }, PLAN_EXIT_MS);
    this.#afterPlan = { mode: wanted, timer };
  }

  /** The slash commands it offers, as the composer completes them. */
  static commands(listed: readonly { name: string; description: string; argumentHint: string }[]) {
    const seen = new Set<string>();
    return listed.flatMap((command): SlashCommand[] => {
      if (seen.has(command.name)) return [];
      seen.add(command.name);
      const { name, description, argumentHint } = command;
      return [{ name, description, argumentHint }];
    });
  }

  async #read(): Promise<void> {
    try {
      for await (const message of this.#query) this.#receive(message);
      if (!this.#closing) {
        this.#host.emit(
          this.#pending.size > 0
            ? {
                type: 'closed',
                error: stopped('Claude Code stopped before the turn ended', this.#stderr),
              }
            : { type: 'closed' },
        );
      }
    } catch (error) {
      if (!this.#closing) this.#host.emit({ type: 'closed', error: stopped(error, this.#stderr) });
    } finally {
      this.#closing = true;
      this.#prompts.withdrawAll();
      if (this.#afterPlan) clearTimeout(this.#afterPlan.timer);
    }
  }

  #receive(message: SDKMessage): void {
    // Its id, once a turn has made it a conversation to resume (its transcript is written from
    // the first message), and again when /clear starts a new one.
    const turned =
      message.type === 'result' || (message.type === 'system' && message.subtype === 'init');
    if (turned && message.session_id !== '' && message.session_id !== this.#sessionId) {
      this.#sessionId = message.session_id;
      this.#host.remember(message.session_id);
    }
    if (message.type === 'system' && message.subtype === 'commands_changed') {
      this.#host.emit({ type: 'commands', commands: SdkSession.commands(message.commands) });
    }
    for (const event of this.#translator.translate(message)) {
      if (event.type === 'mode' && isPermissionMode(event.mode)) this.#mode = event.mode;
      this.#host.emit(event);
    }
    if (
      this.#afterPlan &&
      message.type === 'system' &&
      message.subtype === 'status' &&
      message.permissionMode !== undefined &&
      message.permissionMode !== 'plan'
    ) {
      this.#leavePlan(message.permissionMode);
    }
    if (message.type === 'result') this.#result(message);
  }

  /** The CLI left plan mode (for `reported`): the session goes on in the mode the plan was approved in. */
  #leavePlan(reported: string | undefined): void {
    const after = this.#afterPlan;
    if (!after) return;
    clearTimeout(after.timer);
    this.#afterPlan = undefined;
    const mode = sdkMode(after.mode);
    if (reported === mode) return;
    this.#query.setPermissionMode(mode).catch((error: unknown) => {
      this.#host.emit({
        type: 'notice',
        id: randomUUID(),
        level: 'warning',
        text: `Could not switch to ${after.mode} mode: ${stopped(error, this.#stderr)}`,
      });
    });
  }

  /** A turn ended: the messages it answered (the CLI names them) end with it. */
  #result(result: SDKResultMessage): void {
    const named =
      result.user_message_uuids ??
      (result.user_message_uuid === undefined ? undefined : [result.user_message_uuid]);
    const ours =
      named !== undefined
        ? named.filter((uuid) => this.#pending.has(uuid))
        : result.origin?.kind === 'task-notification'
          ? []
          : [...this.#pending.keys()];
    // Another turn (one a background task started) while one of ours waits: not ours to end.
    if (ours.length === 0 && this.#pending.size > 0) return;
    const interrupted =
      this.#interrupting || result.terminal_reason?.startsWith('aborted') === true;
    this.#end(ours, {
      seconds: result.duration_ms / 1000,
      result: this.#translator.takeResult(result, interrupted),
    });
  }

  #end(uuids: readonly string[], ending: { seconds: number; result: TurnResult }): void {
    const { seconds, result } = ending;
    const messages = uuids.flatMap((uuid) => {
      const id = this.#pending.get(uuid);
      this.#pending.delete(uuid);
      return id === undefined ? [] : [id];
    });
    if (this.#pending.size === 0) this.#interrupting = false;
    const event: SessionEvent = {
      type: 'end',
      messages,
      seconds: Math.max(1, Math.round(seconds)),
      result,
    };
    this.#host.emit(event);
  }
}
