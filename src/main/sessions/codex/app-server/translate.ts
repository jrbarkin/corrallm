import path from 'node:path';

import type {
  SessionEvent,
  Todo,
  ToolDetail,
  ToolStatus,
  UsageLimit,
} from '../../../../shared/session';
import type { UsageWindows } from '../../../../shared/usage';
import {
  diff,
  displayPath,
  firstLine,
  notice,
  output,
  property,
  replacement,
  resetTime,
  text,
  unifiedDiff,
  usageLimit,
} from '../../transcript';
import type { Places } from '../../transcript';
import { codexLimits, usageWindows } from '../limits';

/*
 * Turns what Codex's app server says about a thread (its items as they start, stream and complete;
 * its plan; its token usage and the account's rate limits; errors and warnings) into corrallm's
 * session events (src/shared/session.ts): replies and reasoning summaries streaming in, each
 * command with its output, each patch as diffs, web searches, MCP and subagent calls, the plan as
 * a to-do list, notices, usage. Turns and prompts are the session's (session.ts, prompts.ts); this
 * follows the items, keeping what it needs to tie their notifications together. A subagent's
 * thread nests under the call that spawned it.
 *
 * Tools keep the names Codex's model knows them by (exec_command, apply_patch, web_search,
 * spawn_agent; MCP tools as mcp__server__tool), as a simulated Codex agent's do. Entry ids are
 * Codex's item ids, so a resumed thread's history (`historyEvents`) matches what was shown live.
 */

type ToolEvent = Extract<SessionEvent, { type: 'tool' }>;

/** How long a running command's output goes without being shown, at most. */
export const OUTPUT_EVERY_MS = 150;

const LOGIN_HELP =
  'corrallm uses Codex’s own login: log Codex in again in a terminal (`codex login --with-api-key`), then send your message again.';

export interface TranslatorOptions {
  places: Places;
  /**
   * For a resumed thread's history: its items are complete, and what was running when its turn
   * ended was cut off.
   */
  history?: boolean;
  /** The time, in milliseconds (Date.now). */
  now?: () => number;
  /**
   * Takes the plan's usage limits it shows, as usage windows: from account/rateLimits/read (told
   * through `setLimits`) and each update. For main's usage readings (usage.ts).
   */
  usage?: (windows: UsageWindows) => void;
}

/** A proposed plan (plan mode's plan item), complete. */
export interface ProposedPlan {
  id: string;
  text: string;
}

export class Translator {
  readonly #places: Places;
  readonly #history: boolean;
  readonly #now: () => number;
  readonly #usageOut: ((windows: UsageWindows) => void) | undefined;
  /** The thread the session shows; others are its subagents'. */
  thread: string | undefined;
  /** What each text and thinking entry has shown, by id. */
  readonly #streamed = new Map<string, string>();
  /** The summary part each reasoning item streams now, by id. */
  readonly #parts = new Map<string, number>();
  /** Each tool entry as last shown, by id. */
  readonly #tools = new Map<string, ToolEvent>();
  /** Running commands' output so far, and when it was last shown. */
  readonly #outputs = new Map<string, { text: string; shownAt: number }>();
  /** Commands whose output has more to show. */
  readonly #pending = new Set<string>();
  /** File changes' entries, by their item's id: for their approval prompts. */
  readonly #patches = new Map<string, { summary: string; detail: ToolDetail | undefined }>();
  /** Subagents' threads, and the entry their work nests under (the call that spawned each). */
  readonly #children = new Map<string, string>();
  /** The plan proposed in the turn going on. */
  #plan: ProposedPlan | undefined;
  /** Whether the turn going on has shown its error already. */
  #failed = false;
  #context: number | null = null;
  #window: number | null = null;
  #limits: UsageLimit[] | undefined;
  /** The usage last told, so that the same is not told again. */
  #told: string | undefined;
  /** MCP servers that failed to start, shown once each. */
  readonly #failedServers = new Set<string>();

  constructor({ places, history = false, now = Date.now, usage }: TranslatorOptions) {
    this.#places = places;
    this.#history = history;
    this.#now = now;
    this.#usageOut = usage;
  }

  /** Whether a running command has output not shown yet: `flush` shows it. */
  get pendingOutput(): boolean {
    return this.#pending.size > 0;
  }

  /** What a file change would do (its approval prompt shows it): its files and their diffs. */
  patch(itemId: string): { summary: string; detail: ToolDetail | undefined } | undefined {
    return this.#patches.get(itemId);
  }

  /** The plan proposed in the turn that just ended, if any (it is taken: asked once). */
  takePlan(): ProposedPlan | undefined {
    const plan = this.#plan;
    this.#plan = undefined;
    return plan;
  }

  /** Shows what running commands printed since they were last shown. */
  flush(): SessionEvent[] {
    const events = [...this.#pending].flatMap((id) => this.#showOutput(id));
    this.#pending.clear();
    return events;
  }

  /** What Codex's app server notified, as session events. */
  notification(method: string, params: unknown): SessionEvent[] {
    const thread = text(property(params, 'threadId'));
    const parent = this.#parentOf(thread);
    const itemId = text(property(params, 'itemId')) ?? '';
    switch (method) {
      case 'item/started':
        return this.#item(property(params, 'item'), 'started', parent);
      case 'item/completed':
        return this.#item(property(params, 'item'), 'completed', parent);
      case 'item/agentMessage/delta':
        return this.#stream('text', itemId, text(property(params, 'delta')) ?? '', parent);
      case 'item/reasoning/summaryTextDelta': {
        const index = property(params, 'summaryIndex');
        const part = typeof index === 'number' ? index : 0;
        const before = this.#parts.get(itemId) ?? part;
        this.#parts.set(itemId, part);
        // A new part of the summary is a new paragraph.
        const gap = part !== before && (this.#streamed.get(itemId) ?? '') !== '' ? '\n\n' : '';
        return this.#stream(
          'thinking',
          itemId,
          gap + (text(property(params, 'delta')) ?? ''),
          parent,
        );
      }
      case 'item/commandExecution/outputDelta':
        return this.#outputDelta(itemId, text(property(params, 'delta')) ?? '');
      case 'item/mcpToolCall/progress': {
        const shown = this.#tools.get(itemId);
        const message = text(property(params, 'message'));
        if (!shown || message === undefined || shown.status !== 'running') return [];
        return [this.#tool({ ...shown, detail: output(message) })];
      }
      case 'item/fileChange/patchUpdated': {
        const changes = property(params, 'changes');
        return this.#fileChanges(itemId, changes, 'running', parent);
      }
      case 'turn/plan/updated':
        return thread !== undefined && thread !== this.thread ? [] : this.#todos(params);
      case 'thread/tokenUsage/updated':
        return thread !== undefined && thread !== this.thread ? [] : this.#tokens(params);
      case 'account/rateLimits/updated':
        return this.setLimits(property(params, 'rateLimits'));
      case 'error':
        return this.#error(params);
      case 'warning': {
        const message = text(property(params, 'message'));
        return message === undefined ? [] : [notice('warning', message)];
      }
      case 'guardianWarning': {
        const message = text(property(params, 'message'));
        return message === undefined ? [] : [notice('warning', message)];
      }
      case 'configWarning': {
        const summary = text(property(params, 'summary'));
        const details = text(property(params, 'details'));
        return summary === undefined
          ? []
          : [notice('warning', details === undefined ? summary : `${summary}: ${details}`)];
      }
      case 'model/rerouted': {
        const from = text(property(params, 'fromModel')) ?? 'its model';
        const to = text(property(params, 'toModel')) ?? 'another model';
        return [notice('info', `Codex switched from ${from} to ${to} for this request.`)];
      }
      case 'mcpServer/startupStatus/updated':
        return this.#serverStatus(params);
      default:
        return [];
    }
  }

  /**
   * The account's usage limits as Codex reports them (a RateLimitSnapshot: account/rateLimits/read's
   * `rateLimits`, or an update's; ../limits.ts): its 5-hour and weekly windows. Shown with the
   * session's usage, and passed on to the usage readings.
   */
  setLimits(snapshot: unknown): SessionEvent[] {
    // Codex's own limits; others (per model) are not the plan's.
    const limits = codexLimits(snapshot);
    if (!limits) return [];
    this.#limits = limits.map((limit) => usageLimit(limit));
    const windows = usageWindows(limits, this.#now());
    if (windows) this.#usageOut?.(windows);
    return this.#usage();
  }

  /**
   * A turn of the session's thread ended (turn/completed's turn): why it failed, unless its error
   * was shown already. What streams for the next turn starts afresh.
   */
  endTurn(turn: unknown): SessionEvent[] {
    const events = this.flush();
    const status = property(turn, 'status');
    const error = property(turn, 'error');
    if (status === 'failed' && !this.#failed) {
      events.push(notice('error', this.#errorText(error)));
    }
    this.#failed = false;
    this.#parts.clear();
    return events;
  }

  /** A thread's past item (a resumed thread's history), as the events it was. */
  historyItem(item: unknown): SessionEvent[] {
    return this.#item(item, 'completed', undefined);
  }

  /** The entry a thread's items nest under: none for the session's thread, its spawning call for a subagent's. */
  #parentOf(thread: string | undefined): string | undefined {
    if (thread === undefined || this.thread === undefined || thread === this.thread) {
      return undefined;
    }
    return this.#children.get(thread) ?? `thread:${thread}`;
  }

  #item(item: unknown, phase: 'started' | 'completed', parent: string | undefined): SessionEvent[] {
    const id = text(property(item, 'id'));
    if (id === undefined) return [];
    const nest = parent === undefined ? {} : { parent };
    const done = phase === 'completed';
    switch (property(item, 'type')) {
      case 'agentMessage':
        return this.#complete('text', id, text(property(item, 'text')) ?? '', parent);
      case 'reasoning': {
        const summary = property(item, 'summary');
        const full = Array.isArray(summary)
          ? summary.filter((part): part is string => typeof part === 'string').join('\n\n')
          : '';
        return this.#complete('thinking', id, full, parent);
      }
      case 'commandExecution':
        return [this.#command(id, item, done, nest)];
      case 'fileChange':
        return this.#fileChanges(
          id,
          property(item, 'changes'),
          done ? statusOf(property(item, 'status'), this.#history) : 'running',
          parent,
        );
      case 'mcpToolCall':
        return [this.#mcp(id, item, done, nest)];
      case 'dynamicToolCall':
        return [this.#dynamic(id, item, done, nest)];
      case 'collabAgentToolCall':
        return [this.#collab(id, item, done, nest)];
      case 'subAgentActivity':
        return this.#subagent(item, nest);
      case 'webSearch':
        return [
          this.#tool({
            type: 'tool',
            id,
            tool: 'web_search',
            summary: searchSummary(item),
            status: done ? 'done' : 'running',
            ...nest,
          }),
        ];
      case 'imageView':
        return [
          this.#tool({
            type: 'tool',
            id,
            tool: 'view_image',
            summary: this.#path(text(property(item, 'path')) ?? ''),
            status: done ? 'done' : 'running',
            ...nest,
          }),
        ];
      case 'imageGeneration':
        return [this.#imageGeneration(id, item, done, nest)];
      case 'sleep': {
        const ms = property(item, 'durationMs');
        return [
          this.#tool({
            type: 'tool',
            id,
            tool: 'sleep',
            summary: typeof ms === 'number' ? `${String(Math.round(ms / 1000))}s` : '',
            status: done ? 'done' : 'running',
            ...nest,
          }),
        ];
      }
      case 'plan': {
        if (!done) return [];
        const plan = text(property(item, 'text')) ?? '';
        // Live, the session asks to implement it once its turn ends; in history it reads as text.
        if (this.#history) return this.#complete('text', id, plan, parent);
        if (parent === undefined) this.#plan = { id, text: plan };
        return [];
      }
      case 'enteredReviewMode': {
        const review = text(property(item, 'review')) ?? '';
        if (!done || this.#streamed.has(id)) return [];
        this.#streamed.set(id, review);
        return [
          { type: 'notice', id, level: 'info', text: `Code review started: ${review}`.trim() },
        ];
      }
      case 'exitedReviewMode':
        return done ? this.#complete('text', id, text(property(item, 'review')) ?? '', parent) : [];
      case 'contextCompaction':
        if (!done || this.#streamed.has(id)) return [];
        this.#streamed.set(id, '');
        return [{ type: 'notice', id, level: 'info', text: 'Context compacted' }];
      case 'userMessage': {
        // Live, the session told the user's message as it sent it.
        if (!this.#history) return [];
        const clientId = text(property(item, 'clientId'));
        return [{ type: 'user', id: clientId ?? id, text: inputText(property(item, 'content')) }];
      }
      default:
        return [];
    }
  }

  /** Text or thinking streaming in: what it adds. */
  #stream(
    type: 'text' | 'thinking',
    id: string,
    piece: string,
    parent: string | undefined,
  ): SessionEvent[] {
    if (id === '' || piece === '') return [];
    this.#streamed.set(id, (this.#streamed.get(id) ?? '') + piece);
    return [{ type, id, text: piece, ...(parent === undefined ? {} : { parent }) }];
  }

  /** Text or thinking complete: what streaming has not shown of it yet (all of it, if none streamed). */
  #complete(
    type: 'text' | 'thinking',
    id: string,
    full: string,
    parent: string | undefined,
  ): SessionEvent[] {
    const streamed = this.#streamed.get(id) ?? '';
    const rest = full.startsWith(streamed) ? full.slice(streamed.length) : '';
    if (rest === '') return [];
    return this.#stream(type, id, rest, parent);
  }

  #command(id: string, item: unknown, done: boolean, nest: { parent?: string }): ToolEvent {
    const status = done ? statusOf(property(item, 'status'), this.#history) : 'running';
    const streamed = this.#outputs.get(id)?.text;
    let detail: ToolDetail | undefined;
    if (done) {
      this.#outputs.delete(id);
      this.#pending.delete(id);
      const said = text(property(item, 'aggregatedOutput')) ?? streamed ?? '';
      const code = property(item, 'exitCode');
      if (said !== '') detail = output(said);
      else if (property(item, 'status') === 'declined')
        detail = output('Declined: it did not run.');
      else if (typeof code === 'number' && code !== 0) detail = output(`Exit code ${String(code)}`);
    } else if (streamed !== undefined && streamed !== '') {
      detail = output(streamed);
    }
    return this.#tool({
      type: 'tool',
      id,
      tool: 'exec_command',
      summary: firstLine(unwrapShell(text(property(item, 'command')) ?? '')),
      status,
      ...(detail === undefined ? {} : { detail }),
      ...nest,
    });
  }

  /** A running command printed more: shown now, or with the next flush if it was shown lately. */
  #outputDelta(id: string, delta: string): SessionEvent[] {
    if (id === '' || delta === '' || !this.#tools.has(id)) return [];
    const known = this.#outputs.get(id) ?? { text: '', shownAt: 0 };
    known.text += delta;
    this.#outputs.set(id, known);
    if (this.#now() - known.shownAt < OUTPUT_EVERY_MS) {
      this.#pending.add(id);
      return [];
    }
    return this.#showOutput(id);
  }

  #showOutput(id: string): SessionEvent[] {
    const known = this.#outputs.get(id);
    const shown = this.#tools.get(id);
    if (!known || shown?.status !== 'running') return [];
    known.shownAt = this.#now();
    this.#pending.delete(id);
    return [this.#tool({ ...shown, detail: output(known.text) })];
  }

  /** A patch: an entry per file it changes, with its diff. */
  #fileChanges(
    id: string,
    changes: unknown,
    status: ToolStatus,
    parent: string | undefined,
  ): SessionEvent[] {
    if (!Array.isArray(changes) || id === '') return [];
    const files = changes.flatMap((change) => {
      const file = text(property(change, 'path'));
      if (file === undefined) return [];
      const kind = property(change, 'kind');
      const moved = text(property(kind, 'move_path'));
      const patch = text(property(change, 'diff')) ?? '';
      const detail =
        property(kind, 'type') === 'add'
          ? replacement('', patch)
          : property(kind, 'type') === 'delete'
            ? replacement(patch, '')
            : codexDiff(patch);
      const summary =
        moved === undefined ? this.#path(file) : `${this.#path(file)} → ${this.#path(moved)}`;
      return [{ summary, detail }];
    });
    this.#patches.set(id, {
      summary: files.map((file) => file.summary).join(', '),
      detail:
        files.length === 1
          ? files[0]?.detail
          : files.length === 0
            ? undefined
            : diff(
                files.flatMap((file) => [
                  { kind: 'same' as const, text: `── ${file.summary}` },
                  ...(file.detail.kind === 'diff' ? file.detail.lines : []),
                ]),
              ),
    });
    return files.map(({ summary, detail }, i) =>
      this.#tool({
        type: 'tool',
        id: `${id}:${String(i)}`,
        tool: 'apply_patch',
        summary,
        status,
        detail,
        ...(parent === undefined ? {} : { parent }),
      }),
    );
  }

  #mcp(id: string, item: unknown, done: boolean, nest: { parent?: string }): ToolEvent {
    const server = text(property(item, 'server')) ?? '';
    const tool = text(property(item, 'tool')) ?? '';
    const error = text(property(property(item, 'error'), 'message'));
    const status = done ? statusOf(property(item, 'status'), this.#history) : 'running';
    const result = property(item, 'result');
    const said =
      error ??
      contentText(property(result, 'content')) ??
      jsonText(property(result, 'structuredContent'));
    const known = this.#tools.get(id)?.detail;
    const detail = done ? (said === undefined || said === '' ? undefined : output(said)) : known;
    return this.#tool({
      type: 'tool',
      id,
      tool: `mcp__${server}__${tool}`,
      summary: argumentsSummary(property(item, 'arguments')),
      status,
      ...(detail === undefined ? {} : { detail }),
      ...nest,
    });
  }

  #dynamic(id: string, item: unknown, done: boolean, nest: { parent?: string }): ToolEvent {
    const namespace = text(property(item, 'namespace'));
    const tool = text(property(item, 'tool')) ?? '';
    const items = property(item, 'contentItems');
    const said = Array.isArray(items)
      ? items
          .map((part) => text(property(part, 'text')) ?? '')
          .filter((part) => part !== '')
          .join('\n')
      : '';
    return this.#tool({
      type: 'tool',
      id,
      tool: namespace === undefined ? tool : `${namespace}.${tool}`,
      summary: argumentsSummary(property(item, 'arguments')),
      status: done ? statusOf(property(item, 'status'), this.#history) : 'running',
      ...(done && said !== '' ? { detail: output(said) } : {}),
      ...nest,
    });
  }

  /** A call to Codex's subagents (spawn_agent, wait, …): their threads nest under the spawn. */
  #collab(id: string, item: unknown, done: boolean, nest: { parent?: string }): ToolEvent {
    const tool = text(property(item, 'tool')) ?? 'agent';
    const receivers = property(item, 'receiverThreadIds');
    const threads = Array.isArray(receivers)
      ? receivers.filter((thread): thread is string => typeof thread === 'string')
      : [];
    if (tool === 'spawnAgent') {
      for (const thread of threads) if (!this.#children.has(thread)) this.#children.set(thread, id);
    }
    const prompt = text(property(item, 'prompt'));
    const states = property(item, 'agentsStates');
    const report =
      typeof states === 'object' && states !== null
        ? Object.values(states)
            .flatMap((state) => {
              const status = text(property(state, 'status')) ?? '';
              const message = text(property(state, 'message'));
              return message === undefined || message === '' ? [] : [`${status}: ${message}`];
            })
            .join('\n\n')
        : '';
    const status = done ? statusOf(property(item, 'status'), this.#history) : 'running';
    return this.#tool({
      type: 'tool',
      id,
      tool: snakeCase(tool),
      summary:
        prompt === undefined
          ? threads.map((thread) => thread.slice(0, 8)).join(', ')
          : firstLine(prompt),
      status,
      ...(report === '' ? {} : { detail: output(report) }),
      ...nest,
    });
  }

  /** What a subagent did (started, was interrupted, completed): one entry per subagent. */
  #subagent(item: unknown, nest: { parent?: string }): SessionEvent[] {
    const thread = text(property(item, 'agentThreadId'));
    if (thread === undefined) return [];
    const kind = property(item, 'kind');
    return [
      this.#tool({
        type: 'tool',
        id: `subagent:${thread}`,
        tool: 'subagent',
        summary: text(property(item, 'agentPath')) ?? thread,
        status: kind === 'completed' ? 'done' : kind === 'interrupted' ? 'interrupted' : 'running',
        ...nest,
      }),
    ];
  }

  #imageGeneration(id: string, item: unknown, done: boolean, nest: { parent?: string }): ToolEvent {
    const saved = text(property(item, 'savedPath'));
    const failure = property(item, 'failure');
    const failed = failure !== null && failure !== undefined;
    const said = failed ? text(property(failure, 'message')) : undefined;
    return this.#tool({
      type: 'tool',
      id,
      tool: 'image_gen',
      summary: firstLine(text(property(item, 'revisedPrompt')) ?? ''),
      status: done ? (failed ? 'failed' : 'done') : 'running',
      ...(saved === undefined
        ? said === undefined
          ? {}
          : { detail: output(said) }
        : { detail: output(`Saved to ${this.#path(saved)}`) }),
      ...nest,
    });
  }

  /** update_plan's plan, as the turn's to-do list. */
  #todos(params: unknown): SessionEvent[] {
    const turn = text(property(params, 'turnId')) ?? '';
    const plan = property(params, 'plan');
    if (!Array.isArray(plan)) return [];
    const items = plan.flatMap((step): Todo[] => {
      const said = text(property(step, 'step'));
      if (said === undefined) return [];
      const status = property(step, 'status');
      return [
        {
          text: said,
          status: status === 'completed' ? 'done' : status === 'inProgress' ? 'active' : 'pending',
        },
      ];
    });
    return [{ type: 'todos', id: `plan:${turn}`, items }];
  }

  #tokens(params: unknown): SessionEvent[] {
    const usage = property(params, 'tokenUsage');
    // What the last request took in and wrote: how full the context is now.
    const last = property(property(usage, 'last'), 'totalTokens');
    const window = property(usage, 'modelContextWindow');
    if (typeof last === 'number') this.#context = last;
    if (typeof window === 'number') this.#window = window;
    return this.#usage();
  }

  /** The session's usage, if it is not what was last told. */
  #usage(): SessionEvent[] {
    const event: SessionEvent = {
      type: 'usage',
      usage: {
        costUsd: null,
        contextTokens: this.#context,
        contextWindow: this.#window,
        ...(this.#limits === undefined ? {} : { limits: this.#limits }),
      },
    };
    const told = JSON.stringify(event);
    if (told === this.#told) return [];
    this.#told = told;
    return [event];
  }

  /** An error: shown now, unless Codex retries (then a warning that it does). */
  #error(params: unknown): SessionEvent[] {
    const error = property(params, 'error');
    if (property(params, 'willRetry') === true) {
      const message = text(property(error, 'message')) ?? 'The request failed.';
      return [notice('warning', `${message} Codex is retrying.`)];
    }
    if (text(property(params, 'threadId')) === this.thread) this.#failed = true;
    return [notice('error', this.#errorText(error))];
  }

  /** What a turn's error says, with what to do about it (codexErrorInfo says what it was). */
  #errorText(error: unknown): string {
    const said = text(property(error, 'message'))?.trim();
    const message = said === undefined || said === '' ? 'The turn failed.' : said;
    const details = text(property(error, 'additionalDetails'))?.trim();
    const info = property(error, 'codexErrorInfo');
    const status = httpStatus(info);
    if (info === 'unauthorized' || status === 401 || status === 403) {
      return `${message} ${LOGIN_HELP}`;
    }
    if (info === 'usageLimitExceeded' && !/reset/i.test(message)) {
      const resets = this.#resets();
      return resets === undefined ? message : `${message} · resets ${resetTime(resets / 1000)}`;
    }
    if (info === 'contextWindowExceeded') {
      return `${message} Run /compact to free context, or /new to start afresh.`;
    }
    return details === undefined || details === '' || message.includes(details)
      ? message
      : `${message}: ${details}`;
  }

  /** When the usage limit that was hit resets (ms): the full window's, or the soonest. */
  #resets(): number | undefined {
    const limits = (this.#limits ?? []).filter((limit) => limit.resetsAt !== null);
    const full = limits.find((limit) => limit.usedPercent >= 100);
    if (full?.resetsAt != null) return full.resetsAt;
    const times = limits.flatMap((limit) => (limit.resetsAt === null ? [] : [limit.resetsAt]));
    return times.length === 0 ? undefined : Math.min(...times);
  }

  #serverStatus(params: unknown): SessionEvent[] {
    const name = text(property(params, 'name')) ?? 'An MCP server';
    if (property(params, 'status') !== 'failed' || this.#failedServers.has(name)) return [];
    this.#failedServers.add(name);
    if (property(params, 'failureReason') === 'reauthenticationRequired') {
      return [
        notice(
          'warning',
          `The MCP server ${name} needs you to log in again: run \`codex mcp login ${name}\` in a terminal.`,
        ),
      ];
    }
    const error = text(property(params, 'error'));
    return [
      notice(
        'warning',
        `The MCP server ${name} failed to start${error === undefined ? '.' : `: ${error}`}`,
      ),
    ];
  }

  #tool(event: ToolEvent): ToolEvent {
    this.#tools.set(event.id, event);
    return event;
  }

  /** A path as the transcript shows it (Codex gives absolute ones; relative ones are the folder's). */
  #path(file: string): string {
    return path.isAbsolute(file) ? displayPath(file, this.#places) : file;
  }
}

/**
 * A resumed thread's history (its turns, oldest first, with their items in full: thread/resume's
 * initialTurnsPage), as the events it was: each turn's message, what Codex did, and its end.
 */
export function historyEvents(turns: readonly unknown[], places: Places): SessionEvent[] {
  const translator = new Translator({ places, history: true });
  return turns.flatMap((turn): SessionEvent[] => {
    const items = property(turn, 'items');
    const list = Array.isArray(items) ? items : [];
    const events = list.flatMap((item) => translator.historyItem(item));
    const user = events.find((event) => event.type === 'user');
    const status = property(turn, 'status');
    const ms = property(turn, 'durationMs');
    events.push(...translator.endTurn(turn), {
      type: 'end',
      messages: user === undefined ? [] : [user.id],
      seconds: Math.max(1, Math.round((typeof ms === 'number' ? ms : 0) / 1000)),
      interrupted: status === 'interrupted',
      failed: status === 'failed',
    });
    return events;
  });
}

/** How an item that ended went, as a tool call shows it. */
function statusOf(status: unknown, history: boolean): ToolStatus {
  switch (status) {
    case 'completed':
      return 'done';
    case 'failed':
    case 'declined':
      return 'failed';
    case 'interrupted':
      return 'interrupted';
    default:
      // Still running when its turn ended (history), or as Codex last said.
      return history ? 'interrupted' : 'running';
  }
}

/**
 * The command a shell runs, as Codex shows it: `/bin/zsh -lc "npm test"` is `npm test` (Codex runs
 * every command through the user's shell, quoted).
 */
export function unwrapShell(command: string): string {
  const wrapped = /^(?:\S*[\\/])?(?:ba|z|fi|da|k)?sh(?:\.exe)? -l?c (.+)$/s.exec(command.trim());
  const inner = wrapped?.[1];
  if (inner === undefined) return command;
  if (inner.length >= 2 && inner.startsWith('"') && inner.endsWith('"')) {
    return inner.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  }
  if (inner.length >= 2 && inner.startsWith("'") && inner.endsWith("'")) {
    return inner.slice(1, -1).replace(/'\\''/g, "'");
  }
  return inner;
}

/** A command as a list of arguments (an exec policy's prefix), as a shell line. */
export function commandLine(argv: readonly string[]): string {
  if (argv.length === 3 && /(?:^|[\\/])(?:ba|z|fi|da|k)?sh(?:\.exe)?$/.test(argv[0] ?? '')) {
    if (argv[1] === '-lc' || argv[1] === '-c') return argv[2] ?? '';
  }
  return argv
    .map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`))
    .join(' ');
}

/** A unified diff as Codex gives it for an update (hunks; "Moved to: …" after a move). */
function codexDiff(patch: string): ToolDetail {
  const hunks = patch.replace(/\n\nMoved to: [^\n]*\n?$/, '');
  return unifiedDiff(hunks.includes('@@') ? hunks : `@@\n${hunks}`);
}

/** What a web search looked for: its query, the page it opened, what it found in one. */
function searchSummary(item: unknown): string {
  const action = property(item, 'action');
  const query = text(property(item, 'query')) ?? '';
  switch (property(action, 'type')) {
    case 'search': {
      const queries = property(action, 'queries');
      return (
        text(property(action, 'query')) ??
        (Array.isArray(queries) ? queries.filter((q) => typeof q === 'string').join(' · ') : query)
      );
    }
    case 'open_page':
    case 'openPage':
      return text(property(action, 'url')) ?? query;
    case 'find_in_page':
    case 'findInPage': {
      const url = text(property(action, 'url')) ?? '';
      const pattern = text(property(action, 'pattern')) ?? '';
      return pattern === '' ? url : `'${pattern}' in ${url}`;
    }
    default:
      return query;
  }
}

/** A user message's text, as the user wrote it (images as "[Image]"). */
function inputText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((part) => {
      switch (property(part, 'type')) {
        case 'text':
          return [text(property(part, 'text')) ?? ''];
        case 'image':
        case 'localImage':
          return ['[Image]'];
        default:
          return [];
      }
    })
    .join('\n');
}

/** The text of an MCP result's content blocks, joined; undefined if it has none. */
function contentText(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  return content
    .map((block) => {
      const kind = property(block, 'type');
      if (kind === 'text') return text(property(block, 'text')) ?? '';
      if (kind === 'image') return '[image]';
      if (kind === 'resource' || kind === 'resource_link') {
        return (
          text(property(property(block, 'resource'), 'uri')) ?? text(property(block, 'uri')) ?? ''
        );
      }
      return '';
    })
    .filter((part) => part !== '')
    .join('\n');
}

function jsonText(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : JSON.stringify(value, null, 2);
}

/** What a tool's arguments act on, in a line: their first short text, or their JSON. */
function argumentsSummary(args: unknown): string {
  if (typeof args === 'string') return firstLine(args);
  if (typeof args !== 'object' || args === null) return '';
  const first = Object.values(args).find(
    (value): value is string => typeof value === 'string' && value !== '' && value.length <= 200,
  );
  if (first !== undefined) return firstLine(first);
  const json = JSON.stringify(args);
  return json === '{}' ? '' : json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

/** An HTTP failure's status, from a codexErrorInfo that carries one. */
function httpStatus(info: unknown): number | undefined {
  if (typeof info !== 'object' || info === null) return undefined;
  for (const value of Object.values(info)) {
    const status = property(value, 'httpStatusCode');
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/** spawnAgent → spawn_agent: the tool's name as Codex's model calls it. */
function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
