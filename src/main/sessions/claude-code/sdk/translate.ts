import type {
  ModelInfo,
  PermissionMode as SdkMode,
  SDKAssistantMessage,
  SDKHookResponseMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
  SDKToolProgressMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  BackgroundTask,
  PermissionMode,
  SessionEvent,
  Todo,
  ToolDetail,
  ToolProgress,
  ToolStatus,
  TurnResult,
} from '../../../../shared/session';
import { compactAt, tokenCount } from '../context';
import { claudeFailure, isLoginError } from '../claude-errors';
import { notice, resetTime } from '../../transcript';
import type { Places } from './tools';
import { output, property, resultDetail, resultText, text, toolSummary } from './tools';

/*
 * Turns what the Agent SDK says (SDKMessage) into corrallm's session events
 * (src/shared/session.ts): streamed text and thinking, each tool call with what it acted on and
 * how it went (diffs, output, how long it has run; a subagent's progress), a subagent's work
 * nested under its Agent call, to-do lists, the work going on in the background, notices
 * (compaction, retries, usage limits, login problems, hooks that failed or blocked), where /clear
 * cleared the conversation, what the user might send next, usage, and the mode and model the CLI
 * reports. Turns (who sent what, when one ends) and prompts are the session's (session.ts,
 * prompts.ts); this only follows the CLI's messages, keeping what it needs to tie them together.
 */

/** Tools the user answers in a prompt (prompts.ts): live, the prompt shows them, not a tool line. */
const PROMPT_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
/** Tools that keep a to-do list: shown as the list, not as tool lines. */
const TODO_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate']);
/** How Claude Code words a hook's non-blocking failure, before what it printed. */
const NON_BLOCKING = 'Failed with non-blocking status code: ';
const LOGIN_HELP =
  'corrallm uses Claude Code’s own login: run `claude` in a terminal and log in there (or switch this agent to Terminal and use /login), then send your message again.';

/** What the limits' windows are called, as Claude Code words them. */
const LIMITS: Record<string, string> = {
  five_hour: 'session',
  seven_day: 'weekly',
  seven_day_opus: 'weekly Opus',
  seven_day_sonnet: 'weekly Sonnet',
  overage: 'extra usage',
};

/** Claude Code's permission modes by corrallm's names (its settings' names: 'default' is Manual). */
export function sdkMode(mode: PermissionMode): SdkMode {
  return mode === 'manual' ? 'default' : mode;
}

/** corrallm's name for a mode the CLI reports, or undefined for one it has no name for. */
export function corrallmMode(mode: unknown): PermissionMode | undefined {
  switch (mode) {
    case 'default':
      return 'manual';
    case 'acceptEdits':
    case 'plan':
    case 'bypassPermissions':
    case 'auto':
      return mode;
    default:
      return undefined;
  }
}

/** When a limit resets, as Claude Code says it: a time today (its 5-hour limit), or a day and time. */
export function formatReset(epochSeconds: number, window?: string): string {
  return resetTime(epochSeconds, { timeOnly: window === 'five_hour' });
}

export interface TranslatorOptions {
  /** Where the session works, to show paths relative to it. */
  places: Places;
  /** How a limit's reset time reads (epoch seconds, the limit's window). */
  formatReset?: (epochSeconds: number, window?: string) => string;
  /**
   * For a resumed session's history: its prompts were answered long ago, so the questions it
   * asked and the plans it showed are tool lines like any other.
   */
  history?: boolean;
}

/** A tool call it has seen, by its id. */
interface ToolCall {
  tool: string;
  input: unknown;
  summary: string;
  parent: string | undefined;
  /** Whether it shows as a tool line (not a prompt or a to-do list). */
  shown: boolean;
  /** Whether it went on in the background, past its result: it ends with its task. */
  background: boolean;
  status: ToolStatus;
  detail: ToolDetail | undefined;
  progress: ToolProgress | undefined;
}

/** The main thread's message streaming in: its id, and each text or thinking block's text so far. */
interface Streaming {
  id: string;
  blocks: Map<number, string>;
  /** The block streaming now, by index: the next complete block the CLI sends is this one. */
  open: number | undefined;
}

export class Translator {
  readonly #options: TranslatorOptions;
  #models: readonly ModelInfo[] = [];
  /** The model the session runs, by the value the picker knows it by (or null: the default). */
  #model: string | null = null;
  #mode: PermissionMode | undefined;
  #streaming: Streaming | undefined;
  /** How many blocks each message (by id) has delivered: where its next block goes. */
  readonly #delivered = new Map<string, number>();
  readonly #tools = new Map<string, ToolCall>();
  /** The task list the task tools keep (TaskCreate, TaskUpdate), by task id. */
  readonly #tasks = new Map<string, Todo>();
  /** The tool call that started each task the CLI runs (a subagent, a command), by task id. */
  readonly #taskCalls = new Map<string, string>();
  /** The work going on in the background, as the CLI last listed it (housekeeping left out). */
  #background: BackgroundTask[] = [];
  #cost: number | null = null;
  #context: number | null = null;
  #window: number | null = null;
  #maxOutput: number | null = null;
  #compactAt: number | null = null;
  /** The last top-level response's model (initially init's): whose window to show. */
  #running: string | undefined;
  /** When a limit hit (a rejected request) resets, to say with its error. */
  #reset: { at: number; window: string | undefined } | undefined;
  /** Limit warnings already shown, so that each shows once. */
  readonly #warned = new Set<string>();
  /** Whether this turn's error was shown already (an API error's message, before its result). */
  #failed = false;
  #turnFailure: TurnResult | undefined;
  #declined: string | undefined;

  /** The SDK's terminal outcome, independent of tool calls that may fail within a turn. */
  takeResult(result: SDKResultMessage, interrupted: boolean): TurnResult {
    const failure = this.#turnFailure;
    const declined = this.#declined;
    this.#turnFailure = undefined;
    this.#declined = undefined;
    if (interrupted) return { status: 'cancelled', reason: 'interrupted' };
    if (declined !== undefined) return { status: 'failed', reason: 'declined', message: declined };
    if (result.subtype === 'success' && !result.is_error)
      return { status: 'completed', reason: 'completed' };
    const message =
      result.subtype === 'success'
        ? result.result.trim()
        : result.errors.filter((error) => !error.startsWith('[ede_diagnostic]')).join(' ');
    return {
      status: 'failed',
      reason: failure?.reason ?? 'api',
      ...(failure?.message ? { message: failure.message } : message ? { message } : {}),
      ...(failure?.resetsAt === undefined ? {} : { resetsAt: failure.resetsAt }),
    };
  }
  /** Whether this turn compacted the conversation. */
  #compacted = false;

  constructor(options: TranslatorOptions) {
    this.#options = options;
  }

  /** Whether task `id` runs in the background now: one the user may stop. */
  runsInBackground(id: string): boolean {
    return this.#background.some((task) => task.id === id);
  }

  /** What task `id`, running in the background now, is, as the CLI described it. */
  backgroundTask(id: string): BackgroundTask | undefined {
    return this.#background.find((task) => task.id === id);
  }

  /** The models the session offers, and the one it was started with. */
  setModels(models: readonly ModelInfo[], current: string | null): void {
    this.#models = models;
    this.#model = current;
  }

  /** The model or mode the session was set to: the CLI's echo of it is not news. */
  setModel(model: string): void {
    this.#model = model;
  }

  setMode(mode: PermissionMode | null): void {
    this.#mode = mode ?? undefined;
  }

  /**
   * A turn of history ended: its tool calls still running (not in the background) were cut off.
   * Live, the renderer marks them when the turn ends interrupted.
   */
  endTurn(): SessionEvent[] {
    return [...this.#tools].flatMap(([id, call]) => {
      if (call.status !== 'running' || call.background || !call.shown) return [];
      call.status = 'interrupted';
      return [this.#toolEvent(id, call)];
    });
  }

  translate(message: SDKMessage): SessionEvent[] {
    switch (message.type) {
      case 'stream_event':
        return this.#stream(message);
      case 'assistant':
        return this.#assistant(message);
      case 'user':
        return this.#user(message.message.content, message.tool_use_result, {
          replay: 'isReplay' in message && message.isReplay,
        });
      case 'system':
        return this.#system(message);
      case 'result':
        return this.#result(message);
      case 'rate_limit_event':
        return this.#limits(message.rate_limit_info);
      case 'tool_progress':
        return this.#toolProgress(message);
      case 'prompt_suggestion':
        return message.suggestion.trim() === ''
          ? []
          : [{ type: 'suggestion', text: message.suggestion.trim() }];
      case 'auth_status':
        return message.error === undefined
          ? []
          : [notice('error', `Claude Code could not log in: ${message.error}. ${LOGIN_HELP}`)];
      case 'conversation_reset':
        return [{ type: 'cleared', id: message.uuid }];
      default:
        return [];
    }
  }

  /** The main thread's reply as it streams: text and thinking, a little at a time. */
  #stream({ event, parent_tool_use_id }: SDKPartialAssistantMessage): SessionEvent[] {
    if (parent_tool_use_id !== null) return [];
    switch (event.type) {
      case 'message_start':
        this.#streaming = { id: event.message.id, blocks: new Map(), open: undefined };
        return [];
      case 'content_block_start': {
        const streaming = this.#streaming;
        if (!streaming) return [];
        streaming.open = event.index;
        const kind = event.content_block.type;
        if (kind === 'text' || kind === 'thinking') streaming.blocks.set(event.index, '');
        return [];
      }
      case 'content_block_delta': {
        const streaming = this.#streaming;
        if (!streaming) return [];
        const { delta, index } = event;
        const piece =
          delta.type === 'text_delta'
            ? { type: 'text' as const, text: delta.text }
            : delta.type === 'thinking_delta'
              ? { type: 'thinking' as const, text: delta.thinking }
              : undefined;
        if (!piece || piece.text === '') return [];
        streaming.blocks.set(index, (streaming.blocks.get(index) ?? '') + piece.text);
        return [{ ...piece, id: blockId(streaming.id, index) }];
      }
      case 'content_block_stop':
        if (this.#streaming) this.#streaming.open = undefined;
        return [];
      default:
        return [];
    }
  }

  /** A complete block of a reply: the rest of streamed text, a tool call, an API error. */
  #assistant(message: SDKAssistantMessage): SessionEvent[] {
    const { id, content, usage } = message.message;
    const parent = message.parent_tool_use_id ?? undefined;
    if (parent === undefined)
      this.#declined =
        message.message.stop_reason === 'refusal'
          ? content
              .map((block) => (block.type === 'text' ? block.text : ''))
              .join('\n')
              .trim()
              .slice(0, 4000) || 'The model declined the request.'
          : undefined;
    const events: SessionEvent[] = [];
    if (parent === undefined && message.error === undefined) {
      if (message.message.model !== this.#running) {
        const hadWindow = this.#window !== null;
        this.#running = message.message.model;
        this.#window = this.#maxOutput = this.#compactAt = null;
        if (hadWindow) events.push(this.#usage());
      }
      // What the reply took in (input, cache) and wrote: how full the context is now. The CLI's
      // own messages (an error, history) may carry no usage.
      const counts = [
        'input_tokens',
        'cache_creation_input_tokens',
        'cache_read_input_tokens',
        'output_tokens',
      ].map((name) => property(usage, name));
      const sum = counts.reduce<number>((sum, value) => sum + (tokenCount(value) ? value : 0), 0);
      const used =
        counts.some((value) => tokenCount(value)) &&
        counts.every((value) => value === undefined || tokenCount(value)) &&
        tokenCount(sum)
          ? sum
          : null;
      if (used !== this.#context) {
        this.#context = used;
        if (this.#window !== null) events.push(this.#usage());
      }
    }
    if (message.error !== undefined) {
      const said = content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n')
        .trim();
      const why = this.#errorText(message.error, said);
      events.push(notice('error', why));
      if (parent === undefined)
        this.#turnFailure = {
          status: 'failed',
          reason: claudeFailure(message.error),
          message: why,
          ...(message.error === 'rate_limit' && this.#reset
            ? { resetsAt: this.#reset.at * 1000 }
            : {}),
        };
      this.#failed = true;
      return events;
    }
    const streaming =
      parent === undefined && this.#streaming?.id === id ? this.#streaming : undefined;
    content.forEach((block, i) => {
      // Where it goes: the block streaming now, or the next of its message.
      const index =
        streaming?.open !== undefined && content.length === 1
          ? streaming.open
          : (this.#delivered.get(id) ?? 0) + i;
      this.#delivered.set(id, Math.max(this.#delivered.get(id) ?? 0, index + 1));
      const entry = blockId(id, index);
      const nest = parent === undefined ? {} : { parent };
      switch (block.type) {
        case 'text':
        case 'thinking': {
          const full = block.type === 'text' ? block.text : block.thinking;
          const streamed = streaming?.blocks.get(index) ?? '';
          // What streaming has not shown yet (all of it, if it did not stream).
          const rest = full.startsWith(streamed) ? full.slice(streamed.length) : '';
          if (streaming) streaming.blocks.set(index, full);
          if (rest !== '') events.push({ type: block.type, id: entry, text: rest, ...nest });
          return;
        }
        case 'tool_use':
          events.push(...this.#toolUse(block.id, block.name, block.input, parent, message.aborted));
          return;
        default:
          return;
      }
    });
    return events;
  }

  /** A tool call starts: shown as running (or, cut off by an interrupt, as interrupted). */
  #toolUse(
    id: string,
    tool: string,
    input: unknown,
    parent: string | undefined,
    aborted: true | undefined,
  ): SessionEvent[] {
    const shown =
      !TODO_TOOLS.has(tool) && (this.#options.history === true || !PROMPT_TOOLS.has(tool));
    const call: ToolCall = {
      tool,
      input,
      summary: toolSummary(tool, input, this.#options.places),
      parent,
      shown,
      background: false,
      status: aborted ? 'interrupted' : 'running',
      detail: undefined,
      progress: undefined,
    };
    this.#tools.set(id, call);
    if (tool === 'TodoWrite') {
      const todos = property(input, 'todos');
      return Array.isArray(todos) ? [{ type: 'todos', id, items: todos.map(todo) }] : [];
    }
    return shown ? [this.#toolEvent(id, call)] : [];
  }

  /**
   * Content the CLI adds as the user: chiefly tool results (`result` is the tool's structured
   * result), and the output of local commands. The rest (a compaction's summary, the prompt it gave
   * a subagent, "[Request interrupted by user]") is the CLI's own business.
   */
  #user(content: unknown, result: unknown, { replay }: { replay: boolean }): SessionEvent[] {
    if (typeof content === 'string') {
      const stdout = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/.exec(content);
      const said = stdout?.[1]?.trim() ?? '';
      // /compact's "Compacted": the compaction's own notice says more.
      if (!replay || said === '' || (this.#compacted && said.startsWith('Compacted'))) return [];
      return [notice('info', said)];
    }
    if (!Array.isArray(content)) return [];
    const results = content.filter((block) => property(block, 'type') === 'tool_result');
    return results.flatMap((block) => {
      const id = text(property(block, 'tool_use_id'));
      const call = id === undefined ? undefined : this.#tools.get(id);
      if (id === undefined || !call) return [];
      const said = resultText(property(block, 'content'));
      const failed = property(block, 'is_error') === true;
      // Its structured result goes with a message carrying one tool result.
      return this.#toolResult(id, call, results.length === 1 ? result : undefined, said, failed);
    });
  }

  #toolResult(
    id: string,
    call: ToolCall,
    result: unknown,
    said: string,
    failed: boolean,
  ): SessionEvent[] {
    if (TODO_TOOLS.has(call.tool)) return failed ? [] : this.#taskList(id, call, result);
    if (!call.shown) {
      call.status = failed ? 'failed' : 'done';
      return [];
    }
    const interrupted = failed && /interrupted by user/i.test(said);
    // Background work (a subagent, a command) goes on after its call returns.
    const background =
      !failed &&
      (call.background ||
        property(result, 'status') === 'async_launched' ||
        text(property(result, 'backgroundTaskId')) !== undefined);
    call.background = background;
    call.status = interrupted ? 'interrupted' : failed ? 'failed' : background ? 'running' : 'done';
    call.detail = failed
      ? said === ''
        ? undefined
        : output(said)
      : resultDetail(call.tool, call.input, result, said);
    return [this.#toolEvent(id, call)];
  }

  /** The to-do list after a task tool's call: the list it wrote, or the tasks as now created. */
  #taskList(id: string, call: ToolCall, result: unknown): SessionEvent[] {
    if (call.tool === 'TaskCreate') {
      const task = property(result, 'task');
      const taskId = text(property(task, 'id'));
      const subject = text(property(task, 'subject')) ?? text(property(call.input, 'subject'));
      if (taskId === undefined || subject === undefined) return [];
      this.#tasks.set(taskId, { text: subject, status: 'pending' });
    } else if (call.tool === 'TaskUpdate') {
      const taskId =
        text(property(call.input, 'taskId')) ??
        text(property(call.input, 'id')) ??
        text(property(call.input, 'task_id'));
      const known = taskId === undefined ? undefined : this.#tasks.get(taskId);
      if (taskId === undefined || !known) return [];
      const status = property(call.input, 'status');
      if (status === 'deleted') this.#tasks.delete(taskId);
      else {
        const subject = text(property(call.input, 'subject'));
        this.#tasks.set(taskId, {
          text: subject ?? known.text,
          status: todoStatus(status) ?? known.status,
        });
      }
    } else {
      return [];
    }
    return [{ type: 'todos', id, items: [...this.#tasks.values()] }];
  }

  #system(message: Extract<SDKMessage, { type: 'system' }>): SessionEvent[] {
    switch (message.subtype) {
      case 'init': {
        this.#running = message.model;
        return [...this.#modeEvent(message.permissionMode), ...this.#modelEvent(message.model)];
      }
      case 'status': {
        const events = this.#modeEvent(message.permissionMode);
        if (message.compact_result === 'failed') {
          events.push(
            notice(
              'error',
              `Compacting the conversation failed${message.compact_error ? `: ${message.compact_error}` : '.'}`,
            ),
          );
        }
        return events;
      }
      case 'compact_boundary': {
        this.#compacted = true;
        const { trigger, pre_tokens: before, post_tokens: after } = message.compact_metadata;
        const how =
          trigger === 'auto'
            ? 'Compacted the conversation automatically'
            : 'Compacted the conversation';
        const events: SessionEvent[] = [
          notice(
            'info',
            after === undefined
              ? `${how} (${tokens(before)} tokens before).`
              : `${how}: ${tokens(before)} → ${tokens(after)} tokens.`,
          ),
        ];
        if (after !== undefined) {
          this.#context = after;
          if (this.#window !== null) events.push(this.#usage());
        }
        return events;
      }
      case 'api_retry': {
        const status = message.error_status === null ? '' : ` ${String(message.error_status)}`;
        const wait = Math.max(1, Math.round(message.retry_delay_ms / 1000));
        return [
          notice(
            'warning',
            `API error${status} (${message.error.replace(/_/g, ' ')}): retrying in ${String(wait)}s (attempt ${String(message.attempt)} of ${String(message.max_retries)}).`,
          ),
        ];
      }
      case 'informational':
        // 'info' lines show only in Claude Code's transcript mode.
        return message.level === 'info' || message.content.trim() === ''
          ? []
          : [notice(message.level === 'warning' ? 'warning' : 'info', message.content.trim())];
      case 'notification':
        return message.priority === 'high' || message.priority === 'immediate'
          ? [notice('info', message.text)]
          : [];
      case 'local_command_output':
        return message.content.trim() === '' ? [] : [notice('info', message.content.trim())];
      case 'permission_denied': {
        const call = this.#tools.get(message.tool_use_id);
        const what = call
          ? `${call.tool}${call.summary === '' ? '' : ` ${call.summary}`}`
          : message.tool_name;
        const why = message.decision_reason ?? message.message;
        return [notice('warning', `Not allowed: ${what}${why === '' ? '' : ` (${why})`}`)];
      }
      case 'task_started': {
        if (message.tool_use_id === undefined) return [];
        this.#taskCalls.set(message.task_id, message.tool_use_id);
        const call = this.#tools.get(message.tool_use_id);
        if (call && message.is_backgrounded === true) call.background = true;
        // The CLI may list it in the background before it says which call started it.
        return this.runsInBackground(message.task_id) ? [this.#tasksEvent()] : [];
      }
      case 'task_updated': {
        if (message.patch.is_backgrounded !== true) return [];
        const known = this.#taskCalls.get(message.task_id);
        const call = known === undefined ? undefined : this.#tools.get(known);
        if (call) call.background = true;
        else {
          for (const other of this.#tools.values()) {
            if (other.status === 'running' && (other.tool === 'Agent' || other.tool === 'Bash')) {
              other.background = true;
            }
          }
        }
        return [];
      }
      case 'task_progress': {
        const id = message.tool_use_id ?? this.#taskCalls.get(message.task_id);
        const call = id === undefined ? undefined : this.#tools.get(id);
        if (id === undefined || !call?.shown || call.status !== 'running') return [];
        const doing = message.summary ?? message.description;
        call.progress = {
          ...(doing.trim() === '' ? {} : { doing: doing.trim() }),
          ...used(message.usage),
        };
        return [this.#toolEvent(id, call)];
      }
      case 'task_notification': {
        const id = message.tool_use_id ?? this.#taskCalls.get(message.task_id);
        this.#taskCalls.delete(message.task_id);
        const call = id === undefined ? undefined : this.#tools.get(id);
        if (id === undefined || !call?.shown || call.status !== 'running') return [];
        call.status =
          message.status === 'completed'
            ? 'done'
            : message.status === 'failed'
              ? 'failed'
              : 'interrupted';
        if (message.summary !== '') call.detail = output(message.summary);
        if (message.usage) call.progress = used(message.usage);
        return [this.#toolEvent(id, call)];
      }
      case 'background_tasks_changed':
        this.#background = message.tasks
          .filter((task) => task.ambient !== true)
          .map((task) => ({
            id: task.task_id,
            description: task.description,
            kind:
              task.task_type === 'local_agent'
                ? 'agent'
                : task.task_type === 'local_bash'
                  ? 'command'
                  : 'other',
          }));
        return [this.#tasksEvent()];
      case 'hook_response':
        return this.#hook(message);
      default:
        return [];
    }
  }

  /** How long a tool call has run, when that is news (a second more). */
  #toolProgress({ tool_use_id: id, elapsed_time_seconds }: SDKToolProgressMessage): SessionEvent[] {
    const call = this.#tools.get(id);
    if (!call?.shown || call.status !== 'running') return [];
    const seconds = Math.floor(elapsed_time_seconds);
    if (call.progress?.seconds === seconds) return [];
    call.progress = { ...call.progress, seconds };
    return [this.#toolEvent(id, call)];
  }

  /** The work going on in the background, each task with the call that started it, if known. */
  #tasksEvent(): SessionEvent {
    return {
      type: 'tasks',
      tasks: this.#background.map((task) => {
        const tool = this.#taskCalls.get(task.id);
        return tool === undefined ? task : { ...task, tool };
      }),
    };
  }

  /**
   * What a hook said, when it failed or blocked something, as Claude Code words it ("PreToolUse:Bash
   * hook returned blocking error: …"). What hooks print when they work is not shown, as in Claude
   * Code.
   */
  #hook(message: SDKHookResponseMessage): SessionEvent[] {
    if (message.outcome !== 'error') return [];
    const printed =
      [message.stderr, message.output, message.stdout]
        .map((said) => said.trim())
        .find((said) => said !== '') ??
      (message.exit_code === undefined ? '' : `exit code ${String(message.exit_code)}`);
    const reason = printed.startsWith(NON_BLOCKING) ? printed.slice(NON_BLOCKING.length) : printed;
    const name = message.hook_name;
    const [level, said]: ['info' | 'error', string] =
      message.exit_code !== 2
        ? ['error', `${name} hook error`]
        : message.hook_event === 'Stop' || message.hook_event === 'SubagentStop'
          ? ['info', `${name} hook feedback`]
          : ['error', `${name} hook returned blocking error`];
    return [notice(level, reason === '' ? said : `${said}: ${reason}`)];
  }

  /** A turn ended: what it cost, and why, if it failed. */
  #result(result: SDKResultMessage): SessionEvent[] {
    this.#cost = result.total_cost_usd;
    const models = Object.entries(result.modelUsage);
    // Never take a subagent's larger window for this session. A single model is unambiguous.
    const usage =
      models.find(([model]) => model === this.#running)?.[1] ??
      (this.#running === undefined && models.length === 1 ? models[0]?.[1] : undefined);
    this.#window =
      tokenCount(usage?.contextWindow) && usage.contextWindow > 0 ? usage.contextWindow : null;
    this.#maxOutput = tokenCount(usage?.maxOutputTokens) ? usage.maxOutputTokens : null;
    const events: SessionEvent[] = [this.#usage()];
    const shown = this.#failed;
    this.#failed = false;
    this.#compacted = false;
    if (result.terminal_reason?.startsWith('aborted') === true) return events;
    if (result.subtype === 'success') {
      if (result.is_error && !shown && result.result.trim() !== '') {
        events.push(notice('error', result.result.trim()));
      }
      return events;
    }
    const errors = result.errors.filter((error) => !error.startsWith('[ede_diagnostic]'));
    const why =
      result.subtype === 'error_max_turns'
        ? 'It stopped: it reached the most turns it may take.'
        : result.subtype === 'error_max_budget_usd'
          ? 'It stopped: it reached its budget.'
          : errors.length > 0
            ? `The turn failed: ${errors.join(' ')}`
            : 'The turn failed.';
    if (!shown) events.push(notice('error', why));
    return events;
  }

  /** A usage limit: hit (its error says when it resets), or nearly (a warning, once). */
  #limits(info: SDKRateLimitInfo): SessionEvent[] {
    const window = info.rateLimitType;
    if (info.status === 'rejected') {
      if (info.resetsAt !== undefined) this.#reset = { at: info.resetsAt, window };
      this.#turnFailure = {
        status: 'failed',
        reason: 'usage-limit',
        ...(info.resetsAt === undefined ? {} : { resetsAt: info.resetsAt * 1000 }),
      };
      return [];
    }
    if (info.status !== 'allowed_warning' || info.utilization === undefined) return [];
    const key = `${window ?? ''}/${String(info.surpassedThreshold ?? '')}`;
    if (this.#warned.has(key)) return [];
    this.#warned.add(key);
    const limit = window === undefined ? 'usage' : (LIMITS[window] ?? window.replace(/_/g, ' '));
    const resets =
      info.resetsAt === undefined
        ? ''
        : ` · resets ${(this.#options.formatReset ?? formatReset)(info.resetsAt, window)}`;
    return [
      notice(
        'warning',
        `You've used ${String(Math.round(info.utilization * 100))}% of your ${limit} limit${resets}`,
      ),
    ];
  }

  /** What an API error says, with what to do about it. */
  #errorText(error: string, said: string): string {
    if (isLoginError(error)) {
      return `${said === '' ? 'Claude Code is not logged in.' : said} ${LOGIN_HELP}`;
    }
    if (error === 'rate_limit' && this.#reset && !/reset/i.test(said)) {
      const { at, window } = this.#reset;
      const resets = `resets ${(this.#options.formatReset ?? formatReset)(at, window)}`;
      return said === '' ? `You've hit your usage limit · ${resets}` : `${said} · ${resets}`;
    }
    return said === '' ? `The request failed (${error.replace(/_/g, ' ')}).` : said;
  }

  #modeEvent(reported: unknown): SessionEvent[] {
    const mode = corrallmMode(reported);
    if (mode === undefined || mode === this.#mode) return [];
    this.#mode = mode;
    return [{ type: 'mode', mode }];
  }

  /** The model the CLI says it runs, by the value the picker knows it by, if that is news. */
  #modelEvent(running: string): SessionEvent[] {
    const current = this.#models.find((m) => m.value === (this.#model ?? 'default'));
    if (current && (current.resolvedModel ?? current.value) === running) return [];
    const named = this.#models.find((m) => (m.resolvedModel ?? m.value) === running);
    if (!named || named.value === this.#model) return [];
    this.#model = named.value;
    return [{ type: 'model', model: named.value }];
  }

  /** The summary read for this result only; an absent threshold uses the CLI's default rule. */
  setContextUsage(summary: unknown): void {
    const threshold = property(summary, 'autoCompactThreshold');
    this.#compactAt = tokenCount(threshold) ? threshold : null;
  }

  #usage(): SessionEvent {
    return {
      type: 'usage',
      usage: {
        costUsd: this.#cost,
        context:
          this.#context === null || this.#window === null
            ? null
            : {
                used: this.#context,
                window: this.#window,
                compactAt: Math.min(
                  this.#window,
                  this.#compactAt ?? compactAt(this.#window, this.#maxOutput),
                ),
              },
        contextTokens: this.#context,
        contextWindow: this.#window,
      },
    };
  }

  #toolEvent(id: string, call: ToolCall): SessionEvent {
    return {
      type: 'tool',
      id,
      tool: call.tool,
      summary: call.summary,
      status: call.status,
      ...(call.detail === undefined ? {} : { detail: call.detail }),
      ...(call.parent === undefined ? {} : { parent: call.parent }),
      ...(call.progress === undefined ? {} : { progress: call.progress }),
    };
  }
}

/** What a task has used so far: its tool uses, tokens and time. */
function used(usage: {
  total_tokens: number;
  tool_uses: number;
  duration_ms: number;
}): ToolProgress {
  return {
    toolUses: usage.tool_uses,
    tokens: usage.total_tokens,
    seconds: Math.floor(usage.duration_ms / 1000),
  };
}

/** The entry a block of a message is: its message's id and its place in it. */
export function blockId(messageId: string, index: number): string {
  return `${messageId}:${String(index)}`;
}

function tokens(count: number): string {
  return count.toLocaleString('en-US');
}

/** A TodoWrite item as a to-do. */
function todo(item: unknown): Todo {
  return {
    text: text(property(item, 'content')) ?? '',
    status: todoStatus(property(item, 'status')) ?? 'pending',
  };
}

function todoStatus(status: unknown): Todo['status'] | undefined {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'in_progress':
      return 'active';
    case 'completed':
      return 'done';
    default:
      return undefined;
  }
}
