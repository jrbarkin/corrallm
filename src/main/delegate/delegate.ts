import { randomUUID } from 'node:crypto';

import { turnResult } from '../../shared/session';
import type {
  CodexMode,
  SessionEvent,
  ToolStatus,
  TurnResult,
  UsageLimit,
} from '../../shared/session';
import type { Connector, LiveSession } from '../sessions/connector';

/*
 * A task handed to Codex from outside the app (the `delegate` command: cli.ts): one turn of a
 * Codex thread, run through the App Server connection a Codex agent runs on in corrallm, with no
 * one there to answer what it asks. So it runs in Codex's sandbox (Read only, or Default: it writes
 * only in its folder), and when Codex asks something (to leave its sandbox, a question, to use a
 * ChatGPT plan), the turn stops there and the report says what it asked, unless it was told yes to
 * approvals ahead. The thread is Codex's own: a later task continues it.
 */

/** What to hand Codex, and where. */
export interface Task {
  /** The folder Codex works in: usually a git worktree of its own. */
  cwd: string;
  /** Codex's environment: the user's login shell's, cleaned (sessions/environment.ts). */
  env: Readonly<Record<string, string>>;
  text: string;
  /** The thread to continue, or null for a new one. */
  resume: string | null;
  /** The model and reasoning effort, or null for the user's own defaults. */
  model: string | null;
  effort: string | null;
  mode: Extract<CodexMode, 'read-only' | 'auto'>;
  /** Approve what Codex asks to run or change (once each), rather than stopping there. */
  yes: boolean;
  /** How long the turn may take before it is interrupted. */
  timeoutMs: number;
}

/** How the turn went. */
export interface Delegation {
  outcome: 'completed' | 'failed' | 'asked' | 'stopped' | 'timed out';
  /** The thread, to continue it; null if Codex kept none (nothing was sent). */
  thread: string | null;
  model: string;
  effort: string | null;
  /** What Codex said last in the turn. */
  reply: string;
  /** What Codex asked, where the turn stopped on it. */
  asked?: string;
  result: TurnResult;
  /** The warnings and errors the session gave. */
  notices: string[];
  /** The plan's usage limits, as Codex last told them. */
  limits: UsageLimit[];
  seconds: number;
}

type End = Extract<SessionEvent, { type: 'end' }>;

/**
 * Hands `task` to Codex through `connector`: starts (or continues) its thread, sends the task and
 * waits for the turn to end, telling `progress` what Codex does as it goes (a line each). Rejects if
 * Codex would not start. `signal` stops the turn.
 */
export async function delegate(
  connector: Connector<CodexMode>,
  task: Task,
  progress: (line: string) => void,
  signal?: AbortSignal,
): Promise<Delegation> {
  const began = Date.now();
  const transcript = new Transcript(progress);
  const ended = Promise.withResolvers<End>();
  // Awaited once the task is sent: Codex may stop before that.
  ended.promise.catch(() => undefined);
  let thread = task.resume;
  const live: { session?: LiveSession<CodexMode> } = {};
  let stopped: Delegation['outcome'] | undefined;
  let asked: string | undefined;
  const stop = (why: Delegation['outcome']) => {
    stopped ??= why;
    live.session?.interrupt().catch(() => undefined);
  };
  const ask = (prompt: Prompt) => {
    if (task.yes && prompt.type === 'permission' && prompt.tool !== PLAN_PROMPT) {
      live.session
        ?.answer(prompt.id, { kind: 'permission', answer: 'once' })
        .catch(() => undefined);
      return;
    }
    asked ??= askedText(prompt);
    progress(`? ${asked}`);
    stop('asked');
  };
  const session = await connector.start(
    {
      agentId: 'delegate',
      cwd: task.cwd,
      env: task.env,
      model: task.model,
      mode: task.mode,
      effort: task.effort,
      resume: task.resume,
    },
    {
      emit: (event) => {
        transcript.add(event);
        if (isPrompt(event)) {
          queueMicrotask(() => {
            ask(event);
          });
        } else if (event.type === 'end') ended.resolve(event);
        else if (event.type === 'closed') {
          ended.reject(new Error(event.error ?? 'Codex’s app server stopped.'));
        }
      },
      remember: (id) => {
        thread = id;
      },
    },
  );
  live.session = session;
  const timer = setTimeout(() => {
    stop('timed out');
  }, task.timeoutMs);
  const abort = () => {
    stop('stopped');
  };
  signal?.addEventListener('abort', abort);
  try {
    await session.send({ id: randomUUID(), text: task.text });
    const result = turnResult(await ended.promise);
    return {
      outcome: stopped ?? OUTCOMES[result.status],
      thread,
      model: transcript.model,
      effort: transcript.effort,
      reply: transcript.reply,
      ...(asked === undefined ? {} : { asked }),
      result,
      notices: transcript.notices,
      limits: transcript.limits,
      seconds: Math.round((Date.now() - began) / 1000),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await session.close();
  }
}

const OUTCOMES = {
  completed: 'completed',
  failed: 'failed',
  cancelled: 'stopped',
} as const satisfies Record<TurnResult['status'], Delegation['outcome']>;

/** The prompt asking to use the user's ChatGPT plan (sessions/codex/login.ts planPrompt). */
const PLAN_PROMPT = 'ChatGPT plan';

type Prompt = Extract<SessionEvent, { type: 'permission' | 'question' | 'plan' | 'elicitation' }>;

function isPrompt(event: SessionEvent): event is Prompt {
  return (
    event.type === 'permission' ||
    event.type === 'question' ||
    event.type === 'plan' ||
    event.type === 'elicitation'
  );
}

/** What a prompt asks, in a line. */
function askedText(prompt: Prompt): string {
  switch (prompt.type) {
    case 'permission':
      return prompt.tool === PLAN_PROMPT
        ? `May Codex use your ChatGPT plan (${prompt.summary})? Allow it with --chatgpt-plan.`
        : `${prompt.title ?? `May Codex use ${prompt.tool}?`} ${prompt.summary}`.trim();
    case 'question':
      return prompt.questions.map((question) => question.text).join(' ');
    case 'plan':
      return `Carry out this plan? ${prompt.plan}`;
    case 'elicitation':
      return `${prompt.server} asks: ${prompt.message}`;
  }
}

/** What Codex does in the turn, told as it goes, and what it said last. */
class Transcript {
  model = '';
  effort: string | null = null;
  readonly notices: string[] = [];
  limits: UsageLimit[] = [];
  readonly #progress: (line: string) => void;
  /** Its replies so far (top-level text, not a subagent's), by id, in order. */
  readonly #texts = new Map<string, string>();
  /** How each tool call stands, by id. */
  readonly #tools = new Map<string, ToolStatus>();
  /** The reply streaming in, told once something else comes after it. */
  #open: string | undefined;

  constructor(progress: (line: string) => void) {
    this.#progress = progress;
  }

  /** What Codex said last. */
  get reply(): string {
    return [...this.#texts.values()].at(-1)?.trim() ?? '';
  }

  add(event: SessionEvent): void {
    switch (event.type) {
      case 'started':
        this.model = event.model ?? 'its default model';
        this.effort = event.effort ?? null;
        this.#progress(`Codex ${this.model}${this.effort === null ? '' : ` (${this.effort})`}`);
        return;
      case 'model':
        this.model = event.model;
        return;
      case 'effort':
        this.effort = event.effort;
        return;
      case 'text':
        if (event.parent !== undefined) return;
        if (this.#open !== event.id) this.#tell();
        this.#open = event.id;
        this.#texts.set(event.id, (this.#texts.get(event.id) ?? '') + event.text);
        return;
      case 'tool': {
        this.#tell();
        if (this.#tools.get(event.id) === event.status) return;
        this.#tools.set(event.id, event.status);
        const nested = event.parent === undefined ? '' : '  ';
        this.#progress(`${nested}${TOOL_MARKS[event.status]} ${event.tool} ${event.summary}`);
        return;
      }
      case 'notice':
        if (event.level !== 'info') this.notices.push(event.text);
        this.#progress(`${event.level === 'info' ? '·' : '!'} ${event.text}`);
        return;
      case 'usage':
        if (event.usage.limits !== undefined) this.limits = event.usage.limits;
        return;
      case 'end':
        this.#open = undefined;
        return;
      default:
        return;
    }
  }

  /** Tells the reply that was streaming in, now that something else came after it. */
  #tell(): void {
    if (this.#open === undefined) return;
    const text = this.#texts.get(this.#open)?.trim();
    this.#open = undefined;
    if (text) this.#progress(`› ${text.replaceAll('\n', '\n  ')}`);
  }
}

const TOOL_MARKS: Record<ToolStatus, string> = {
  running: '…',
  done: '✓',
  failed: '✕',
  interrupted: '–',
};
