import { randomUUID } from 'node:crypto';

import type {
  CodexMode,
  EffortChoice,
  ModelChoice,
  SessionAnswer,
  SessionEvent,
  UserMessage,
} from '../../../../shared/session';
import type { LiveSession, SessionHost } from '../../connector';
import { notice, output, property, text, unifiedDiff } from '../../transcript';
import type { Places } from '../../transcript';
import { PLAN_DECLINED, planPrompt } from '../login';
import type { CodexLogin, PlanConsent } from '../login';
import type { AppServer } from '../rpc';
import { RPC_ERRORS, RpcFailure } from '../rpc';
import { IMPLEMENT_PLAN, INIT_PROMPT, parseMessage, readSkills, slashCommands } from './commands';
import type { CommandName, Skill } from './commands';
import { gitDiff } from './diff';
import type { RunGit } from './diff';
import type { Prompts } from './prompts';
import { imageInput, modeSettings, readSandboxPolicy, sandboxPolicy, textInput } from './protocol';
import type { SandboxPolicy, UserInput } from './protocol';
import type { Translator } from './translate';
import { historyEvents, OUTPUT_EVERY_MS } from './translate';

/*
 * A Codex thread, run through Codex's app server: the session a Codex agent's App Server connection
 * shows in corrallm's transcript. Each message starts a turn (turn/start, with the session's
 * model, reasoning effort, and its mode's approval policy, sandbox and collaboration mode, which
 * Codex keeps for the turns after); what Codex does comes back as notifications, turned into
 * session events by the translator; what it asks waits on the user (prompts.ts). A turn ends with
 * turn/completed. A plan proposed in plan mode is asked about once its turn ends, as Codex's TUI
 * asks "Implement this plan?": approved, the same turn goes on in Default mode ("Implement the
 * plan."), so whoever sent the message hears its end once the plan is carried out.
 *
 * Slash commands (commands.ts) run as Codex's TUI runs them: /review, /compact and /init are turns
 * of the thread; the others are answered here.
 *
 * On a ChatGPT login, the first turn that would use the user's plan asks first (login.ts), unless
 * they allowed it for good: Yes allows it for the session, No sends nothing.
 */

/** A model, as model/list lists it: its choice, and what it takes. */
export interface CodexModel extends ModelChoice {
  /** Whether it reads images. */
  images: boolean;
}

/** What the session knows of its thread when it starts (connector.ts). */
export interface ThreadInfo {
  id: string;
  model: string;
  effort: string | null;
  /** The sandbox Codex reports for it (with the user's own settings in it). */
  sandbox: unknown;
  /** The AGENTS.md files it read, and where it works. */
  instructions: string[];
}

export interface AppServerSessionParts {
  server: AppServer;
  host: SessionHost;
  translator: Translator;
  prompts: Prompts;
  places: Places;
  thread: ThreadInfo;
  mode: CodexMode;
  models: CodexModel[];
  skills: Skill[];
  login: CodexLogin;
  /**
   * On a ChatGPT login: the user's say on using their plan, kept for good. The session asks before
   * its first turn uses it, unless they allowed it for good already.
   */
  consent?: PlanConsent;
  /** Runs git, for /diff. */
  git: RunGit;
  /** Starts a new thread, for /new (in the session's mode, with its model). */
  newThread: (mode: CodexMode, model: string) => Promise<ThreadInfo>;
  /** The time, in milliseconds. */
  now?: () => number;
}

/** A turn of corrallm's: the message it answers, and the Codex turns it takes. */
interface Turn {
  /** The renderer's message it answers (none for a turn Codex started itself). */
  messages: string[];
  began: number;
  /** Codex's turn going on, once known. */
  codex: string | undefined;
  /** Interrupted before Codex's turn was known: it is interrupted once it is. */
  stop: boolean;
  interrupted: boolean;
  /** The plan prompt waiting for the user, between Codex's turns. */
  plan: string | undefined;
  /** /compact's turn: it ends once its compaction has. */
  compact: boolean;
  /** The prompt asking to use the user's ChatGPT plan, while it waits: it ends with the answer. */
  consent: { id: string; settle: (answer: PlanAnswer | undefined) => void } | undefined;
}

/** How the user answered whether a session may use their ChatGPT plan. */
type PlanAnswer = Extract<SessionAnswer, { kind: 'permission' }>['answer'];

/** How many of an MCP server's tools /mcp names. */
const MCP_TOOLS_SHOWN = 8;

/** Codex's names for its reasoning efforts. */
const EFFORT_NAMES: Readonly<Record<string, string>> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

/** A reasoning effort as the picker shows it. */
export function effortChoice(value: string, description?: string): EffortChoice {
  const label = EFFORT_NAMES[value] ?? value.charAt(0).toUpperCase() + value.slice(1);
  return { value, label, ...(description === undefined ? {} : { description }) };
}

/** The models model/list lists (but the hidden ones), as the model picker offers them. */
export function readModels(result: unknown): CodexModel[] {
  const data = property(result, 'data');
  if (!Array.isArray(data)) return [];
  return data.flatMap((model): CodexModel[] => {
    const value = text(property(model, 'model')) ?? text(property(model, 'id'));
    if (value === undefined || property(model, 'hidden') === true) return [];
    const efforts = property(model, 'supportedReasoningEfforts');
    const modalities = property(model, 'inputModalities');
    const description = text(property(model, 'description'));
    const fallback = text(property(model, 'defaultReasoningEffort'));
    return [
      {
        value,
        label: text(property(model, 'displayName')) ?? value,
        ...(description === undefined ? {} : { description }),
        efforts: Array.isArray(efforts)
          ? efforts.flatMap((effort) => {
              const name = text(property(effort, 'reasoningEffort'));
              return name === undefined
                ? []
                : [effortChoice(name, text(property(effort, 'description')))];
            })
          : [],
        ...(fallback === undefined ? {} : { defaultEffort: fallback }),
        images: !Array.isArray(modalities) || modalities.includes('image'),
      },
    ];
  });
}

export class AppServerSession implements LiveSession<CodexMode> {
  readonly #server: AppServer;
  readonly #host: SessionHost;
  readonly #translator: Translator;
  readonly #prompts: Prompts;
  readonly #places: Places;
  readonly #git: RunGit;
  readonly #newThread: AppServerSessionParts['newThread'];
  readonly #now: () => number;
  readonly #login: CodexLogin;
  /** Whom to ask before using the user's ChatGPT plan: none once it may be used. */
  #consent: PlanConsent | undefined;
  #thread: ThreadInfo;
  /** The thread whose id was last remembered (a thread is kept once it has a turn). */
  #remembered: string | undefined;
  #mode: CodexMode;
  #model: string;
  #effort: string | null;
  readonly #models: CodexModel[];
  #skills: Skill[];
  /** The sandboxes Codex reported, by kind: they carry the user's own settings. */
  readonly #policies = new Map<SandboxPolicy['type'], SandboxPolicy>();
  #turn: Turn | undefined;
  /** Messages sent while a turn is on: each starts once the turn before it ends. */
  readonly #queue: UserMessage[] = [];
  #closing = false;
  #flushing: ReturnType<typeof setTimeout> | undefined;

  constructor(parts: AppServerSessionParts) {
    this.#server = parts.server;
    this.#host = parts.host;
    this.#translator = parts.translator;
    this.#prompts = parts.prompts;
    this.#places = parts.places;
    this.#git = parts.git;
    this.#newThread = parts.newThread;
    this.#now = parts.now ?? Date.now;
    this.#login = parts.login;
    this.#consent = parts.consent;
    this.#thread = parts.thread;
    this.#mode = parts.mode;
    this.#model = parts.thread.model;
    this.#effort = parts.thread.effort;
    this.#models = parts.models;
    this.#skills = parts.skills;
    this.#keepPolicy(parts.thread.sandbox);
    this.#translator.thread = parts.thread.id;
    void this.#server.exited.then(({ code, stderr }) => {
      if (this.#closing) return;
      this.#closing = true;
      this.#prompts.withdrawAll();
      this.#withdrawConsent();
      const said = stderr
        .split('\n')
        .filter((line) => line.trim() !== '')
        .at(-1);
      this.#host.emit({
        type: 'closed',
        error: `Codex's app server stopped${code === null ? '' : ` (exit code ${String(code)})`}${said === undefined ? '.' : `: ${said}`}`,
      });
    });
  }

  /** The reasoning effort it runs at (null: its model's default), for 'started'. */
  get effort(): string | null {
    return this.#effort;
  }

  send(message: UserMessage): Promise<void> {
    if (this.#turn) this.#queue.push(message);
    else this.#run(message);
    return Promise.resolve();
  }

  answer(promptId: string, answer: SessionAnswer): Promise<void> {
    const turn = this.#turn;
    if (turn?.plan === promptId && answer.kind === 'plan') {
      this.#planAnswered(turn, answer.answer);
      return Promise.resolve();
    }
    if (turn?.consent?.id === promptId && answer.kind === 'permission') {
      turn.consent.settle(answer.answer);
      return Promise.resolve();
    }
    try {
      this.#prompts.answer(promptId, answer);
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async interrupt(): Promise<void> {
    const turn = this.#turn;
    if (!turn) return;
    turn.interrupted = true;
    if (turn.plan !== undefined) {
      this.#host.emit({ type: 'withdrawn', id: turn.plan });
      this.#end(turn, { interrupted: true, failed: false });
      return;
    }
    if (turn.consent !== undefined) {
      this.#withdrawConsent();
      this.#end(turn, { interrupted: true, failed: false });
      return;
    }
    if (turn.codex === undefined) {
      turn.stop = true;
      return;
    }
    await this.#interrupt(turn, turn.codex);
  }

  setMode(mode: CodexMode): Promise<void> {
    // Codex takes it with the next turn: a turn's sandbox cannot change while it runs.
    this.#mode = mode;
    return Promise.resolve();
  }

  setModel(model: string): Promise<void> {
    this.#model = model;
    this.#host.emit({ type: 'model', model });
    // An effort the new model does not offer goes back to its default.
    const efforts = this.#models.find((m) => m.value === model)?.efforts;
    if (this.#effort !== null && efforts && !efforts.some((e) => e.value === this.#effort)) {
      this.#effort = null;
      this.#host.emit({ type: 'effort', effort: null });
    }
    return Promise.resolve();
  }

  setEffort(effort: string | null): Promise<void> {
    this.#effort = effort;
    this.#host.emit({ type: 'effort', effort });
    return Promise.resolve();
  }

  async close(): Promise<void> {
    this.#closing = true;
    if (this.#flushing) clearTimeout(this.#flushing);
    this.#prompts.withdrawAll();
    this.#withdrawConsent();
    await this.#server.close();
  }

  /** What the app server notified (routed here by the connector). */
  notification(method: string, params: unknown): void {
    if (this.#closing) return;
    const thread = text(property(params, 'threadId'));
    const ours = thread === this.#thread.id;
    if (method === 'turn/started' && ours) {
      this.#started(text(property(property(params, 'turn'), 'id')));
    } else if (method === 'serverRequest/resolved') {
      const id = property(params, 'requestId');
      if (typeof id === 'string' || typeof id === 'number') this.#prompts.resolved(id);
    } else if (method === 'skills/changed') {
      void this.#refreshSkills();
    } else if (method === 'thread/settings/updated' && ours) {
      this.#keepPolicy(property(property(params, 'threadSettings'), 'sandboxPolicy'));
    }
    for (const event of this.#translator.notification(method, params)) this.#host.emit(event);
    if (this.#translator.pendingOutput && !this.#flushing) {
      this.#flushing = setTimeout(() => {
        this.#flushing = undefined;
        for (const event of this.#translator.flush()) this.#host.emit(event);
      }, OUTPUT_EVERY_MS);
    }
    if (method === 'turn/completed' && ours) this.#completed(property(params, 'turn'));
    // /compact's compaction is done (should Codex not have run it as a turn of its own).
    const turn = this.#turn;
    if (
      turn?.compact === true &&
      turn.codex === undefined &&
      method === 'item/completed' &&
      ours &&
      property(property(params, 'item'), 'type') === 'contextCompaction'
    ) {
      this.#end(turn, { interrupted: false, failed: false });
    }
  }

  /** A prompt no longer waits and none other does: the turn works on (status is only told within a turn). */
  settled(): void {
    if (this.#turn && this.#turn.plan === undefined) {
      this.#host.emit({ type: 'status', status: 'working' });
    }
  }

  #run(message: UserMessage): void {
    const turn: Turn = {
      messages: [message.id],
      began: this.#now(),
      codex: undefined,
      stop: false,
      interrupted: false,
      plan: undefined,
      compact: false,
      consent: undefined,
    };
    this.#turn = turn;
    this.#host.emit({ type: 'user', id: message.id, text: message.text });
    this.#host.emit({ type: 'status', status: 'working' });
    const parsed = parseMessage(message.text, this.#skills);
    const done = (promise: Promise<void>) => {
      promise.catch((error: unknown) => {
        if (this.#turn !== turn) return;
        this.#host.emit(notice('error', failureText(error)));
        this.#end(turn, { interrupted: false, failed: true });
      });
    };
    if (parsed.kind === 'command') {
      done(this.#command(turn, message, parsed.name, parsed.args));
      return;
    }
    const images = message.images ?? [];
    const model = this.#models.find((m) => m.value === this.#model);
    if (images.length > 0 && model?.images === false) {
      this.#host.emit(notice('warning', `${model.label} doesn't read images: they were left out.`));
    }
    const input: UserInput[] = [
      ...(parsed.text === '' ? [] : [textInput(parsed.text)]),
      ...(model?.images === false ? [] : images.map(imageInput)),
      ...parsed.skills.map((skill) => ({
        type: 'skill' as const,
        name: skill.name,
        path: skill.path,
      })),
    ];
    done(this.#start(turn, input, message.id));
  }

  /** Asks Codex for a turn of the thread, with the session's settings. */
  async #start(turn: Turn, input: UserInput[], clientId?: string): Promise<void> {
    if (!(await this.#mayUsePlan(turn))) return;
    const settings = modeSettings(this.#mode);
    const result = await this.#server.request('turn/start', {
      threadId: this.#thread.id,
      input,
      ...(clientId === undefined ? {} : { clientUserMessageId: clientId }),
      model: this.#model,
      ...(this.#effort === null ? {} : { effort: this.#effort }),
      approvalPolicy: settings.approvalPolicy,
      sandboxPolicy: sandboxPolicy(
        settings.sandbox,
        this.#policies.get(policyKind(settings.sandbox)),
      ),
      collaborationMode: {
        mode: settings.plan ? 'plan' : 'default',
        settings: {
          model: this.#model,
          reasoning_effort: this.#effort,
          developer_instructions: null,
        },
      },
    });
    this.#bind(turn, text(property(property(result, 'turn'), 'id')));
  }

  /**
   * Whether the turn may go on to use the user's ChatGPT plan: at once where it may be used (another
   * login, or allowed for this session or for good), else once the user says so (planPrompt). False
   * if the turn ended meanwhile (interrupted: nothing was sent); throws if they said no.
   */
  async #mayUsePlan(turn: Turn): Promise<boolean> {
    const consent = this.#consent;
    if (consent === undefined || this.#login.kind !== 'chatgpt') return true;
    const given = await consent.given().catch(() => false);
    if (this.#turn !== turn) return false;
    if (turn.stop) {
      this.#end(turn, { interrupted: true, failed: false });
      return false;
    }
    if (!given) {
      const id = `${turn.messages[0] ?? randomUUID()}:chatgpt-plan`;
      const prompt = planPrompt(id, this.#login);
      const answer = await new Promise<PlanAnswer | undefined>((settle) => {
        turn.consent = { id, settle };
        this.#host.emit(prompt);
        this.#host.emit({ type: 'status', status: 'waiting' });
      });
      turn.consent = undefined;
      if (answer === undefined || this.#turn !== turn) return false;
      if (answer === 'deny') throw new Error(PLAN_DECLINED);
      if (answer === 'always') {
        consent.give().catch((error: unknown) => {
          console.error('Could not keep that the ChatGPT plan may be used:', error);
        });
      }
      this.#host.emit({ type: 'status', status: 'working' });
    }
    this.#consent = undefined;
    return true;
  }

  /** The prompt asking to use the user's ChatGPT plan no longer waits (the turn or session ended). */
  #withdrawConsent(): void {
    const consent = this.#turn?.consent;
    if (!consent) return;
    this.#host.emit({ type: 'withdrawn', id: consent.id });
    consent.settle(undefined);
  }

  /** Codex's turn `codex` is the one `turn` waits for: interrupted at once if it was asked to stop. */
  #bind(turn: Turn, codex: string | undefined): void {
    if (codex === undefined || this.#turn !== turn || turn.codex !== undefined) return;
    turn.codex = codex;
    // A thread is kept once it has a turn: from now on it can be resumed.
    if (this.#remembered !== this.#thread.id) {
      this.#remembered = this.#thread.id;
      this.#host.remember(this.#thread.id);
    }
    if (turn.stop) void this.#interrupt(turn, codex);
  }

  /** A turn of the thread started: ours, or one Codex started itself (a turn of its own then). */
  #started(codex: string | undefined): void {
    if (codex === undefined) return;
    const turn = this.#turn;
    if (turn) {
      this.#bind(turn, codex);
      return;
    }
    this.#turn = {
      messages: [],
      began: this.#now(),
      codex,
      stop: false,
      interrupted: false,
      plan: undefined,
      compact: false,
      consent: undefined,
    };
    this.#host.emit({ type: 'status', status: 'working' });
  }

  /** A turn of the thread ended: corrallm's turn ends with it, unless its plan is to be asked about. */
  #completed(codex: unknown): void {
    const turn = this.#turn;
    const id = text(property(codex, 'id'));
    if (!turn || (turn.codex !== undefined && turn.codex !== id)) return;
    for (const event of this.#translator.endTurn(codex)) this.#host.emit(event);
    const status = property(codex, 'status');
    const plan = this.#translator.takePlan();
    if (
      status === 'completed' &&
      plan !== undefined &&
      plan.text.trim() !== '' &&
      !turn.interrupted
    ) {
      // Codex's TUI asks "Implement this plan?" now.
      turn.codex = undefined;
      turn.plan = `${plan.id}:prompt`;
      this.#host.emit({ type: 'plan', id: turn.plan, plan: plan.text });
      this.#host.emit({ type: 'status', status: 'waiting' });
      return;
    }
    this.#end(turn, {
      interrupted: status === 'interrupted' || (turn.interrupted && status !== 'completed'),
      failed: status === 'failed',
    });
  }

  /** The plan was approved (carried out in Default mode), or not (planning goes on, if told how). */
  #planAnswered(turn: Turn, answer: Extract<SessionAnswer, { kind: 'plan' }>['answer']): void {
    turn.plan = undefined;
    let next: string;
    if (answer.approve) {
      this.#mode = 'auto';
      this.#host.emit({ type: 'mode', mode: 'auto' });
      next = IMPLEMENT_PLAN;
    } else {
      next = answer.feedback.trim();
      // "No, stay in Plan mode": the turn ends, the plan not carried out.
      if (next === '') {
        this.#end(turn, { interrupted: false, failed: false });
        return;
      }
    }
    this.#host.emit({ type: 'status', status: 'working' });
    this.#start(turn, [textInput(next)]).catch((error: unknown) => {
      if (this.#turn !== turn) return;
      this.#host.emit(notice('error', failureText(error)));
      this.#end(turn, { interrupted: false, failed: true });
    });
  }

  async #interrupt(turn: Turn, codex: string): Promise<void> {
    try {
      await this.#server.request('turn/interrupt', { threadId: this.#thread.id, turnId: codex });
    } catch (error) {
      // It ended before it heard (no active turn to interrupt): it ends here.
      if (this.#turn === turn && error instanceof RpcFailure) {
        this.#end(turn, { interrupted: true, failed: false });
        return;
      }
      throw error;
    }
  }

  /** Ends corrallm's turn: whoever sent its message hears; the next message, if any, goes. */
  #end(turn: Turn, { interrupted, failed }: { interrupted: boolean; failed: boolean }): void {
    if (this.#turn !== turn) return;
    this.#turn = undefined;
    this.#host.emit({
      type: 'end',
      messages: turn.messages,
      seconds: Math.max(1, Math.round((this.#now() - turn.began) / 1000)),
      interrupted,
      failed,
    });
    const next = this.#queue.shift();
    if (next) this.#run(next);
  }

  /** Runs one of Codex's slash commands (commands.ts). */
  async #command(turn: Turn, message: UserMessage, name: CommandName, args: string): Promise<void> {
    const local = (events: SessionEvent[]) => {
      for (const event of events) this.#host.emit(event);
      this.#end(turn, { interrupted: false, failed: false });
    };
    const said = (markdown: string): SessionEvent => ({
      type: 'text',
      id: `${message.id}:out`,
      text: markdown,
    });
    switch (name) {
      case 'review': {
        if (!(await this.#mayUsePlan(turn))) return;
        const result = await this.#server.request('review/start', {
          threadId: this.#thread.id,
          target:
            args === '' ? { type: 'uncommittedChanges' } : { type: 'custom', instructions: args },
          delivery: 'inline',
        });
        this.#bind(turn, text(property(property(result, 'turn'), 'id')));
        return;
      }
      case 'compact':
        if (!(await this.#mayUsePlan(turn))) return;
        turn.compact = true;
        await this.#server.request('thread/compact/start', { threadId: this.#thread.id });
        return;
      case 'init':
        await this.#start(turn, [textInput(INIT_PROMPT)], message.id);
        return;
      case 'plan':
        this.#mode = 'plan';
        this.#host.emit({ type: 'mode', mode: 'plan' });
        if (args !== '') {
          await this.#start(turn, [textInput(args)], message.id);
          return;
        }
        local([
          notice(
            'info',
            'Plan mode: Codex explores and proposes a plan before it changes anything.',
          ),
        ]);
        return;
      case 'model':
        local(this.#modelCommand(args, said));
        return;
      case 'permissions':
        local(this.#permissionsCommand(args, said));
        return;
      case 'status':
        local([said(this.#status())]);
        return;
      case 'mcp':
        local([said(await this.#mcp())]);
        return;
      case 'skills':
        local([said(skillsList(this.#skills))]);
        return;
      case 'diff':
        local(await this.#diff(message.id));
        return;
      case 'new':
      case 'clear': {
        this.#thread = await this.#newThread(this.#mode, this.#model);
        this.#translator.thread = this.#thread.id;
        this.#keepPolicy(this.#thread.sandbox);
        local([
          notice(
            'info',
            'Started a new chat: Codex starts afresh from here (the earlier one can still be resumed with `codex resume`).',
          ),
        ]);
        return;
      }
      case 'rename':
        if (args === '') {
          local([notice('warning', 'Say what to call it: /rename <name>.')]);
          return;
        }
        await this.#server.request('thread/name/set', { threadId: this.#thread.id, name: args });
        local([notice('info', `Renamed the chat: ${args}`)]);
        return;
    }
  }

  /** /model: lists the models, or switches to one (and an effort it offers). */
  #modelCommand(args: string, said: (markdown: string) => SessionEvent): SessionEvent[] {
    const [wanted, effort] = args.split(/\s+/).filter((part) => part !== '');
    if (wanted === undefined) {
      return [
        said(
          [
            '**Models** (pick one with `/model <model> [effort]`, or in the composer):',
            '',
            ...this.#models.map((model) => {
              const current = model.value === this.#model ? ' — current' : '';
              const efforts = (model.efforts ?? []).map((e) => e.value).join(', ');
              return `- \`${model.value}\` ${model.label}${current}${efforts === '' ? '' : ` (${efforts})`}`;
            }),
          ].join('\n'),
        ),
      ];
    }
    const model = this.#models.find(
      (m) => m.value === wanted || m.label.toLowerCase() === wanted.toLowerCase(),
    );
    if (!model) return [notice('warning', `Codex has no model ${wanted}: /model lists them.`)];
    if (effort !== undefined && !(model.efforts ?? []).some((e) => e.value === effort)) {
      return [notice('warning', `${model.label} has no ${effort} reasoning effort.`)];
    }
    void this.setModel(model.value);
    if (effort !== undefined) void this.setEffort(effort);
    return [
      notice(
        'info',
        `Switched to ${model.label}${effort === undefined ? '' : ` at ${effortChoice(effort).label.toLowerCase()} effort`}.`,
      ),
    ];
  }

  /** /permissions: lists Codex's presets, or switches to one. */
  #permissionsCommand(args: string, said: (markdown: string) => SessionEvent): SessionEvent[] {
    const presets: readonly [CodexMode, string, string][] = [
      ['read-only', 'Read only', 'read-only'],
      ['auto', 'Default', 'default'],
      ['full-access', 'Full access', 'full-access'],
    ];
    if (args === '') {
      return [
        said(
          [
            '**Permissions** (switch with `/permissions <preset>`, or the composer’s mode):',
            '',
            ...presets.map(
              ([mode, label, name]) =>
                `- \`${name}\` ${label}${mode === this.#mode ? ' — current' : ''}`,
            ),
          ].join('\n'),
        ),
      ];
    }
    const wanted = args.toLowerCase().replace(/\s+/g, '-');
    const preset = presets.find(([mode, label, name]) =>
      [mode, name, label.toLowerCase().replace(/\s+/g, '-')].includes(wanted),
    );
    if (!preset)
      return [notice('warning', `Codex has no ${args} permissions: /permissions lists them.`)];
    this.#mode = preset[0];
    return [{ type: 'mode', mode: preset[0] }, notice('info', `Permissions: ${preset[1]}.`)];
  }

  /** /status: the session's settings, its usage and the account's limits. */
  #status(): string {
    const model = this.#models.find((m) => m.value === this.#model);
    const effort = this.#effort ?? model?.defaultEffort;
    const settings = modeSettings(this.#mode);
    const login =
      this.#login.kind === 'apiKey'
        ? 'an API key'
        : this.#login.kind === 'chatgpt'
          ? `ChatGPT${this.#login.plan === null ? '' : ` (${this.#login.plan})`}`
          : this.#login.kind === 'other'
            ? this.#login.type
            : 'none';
    return [
      '**Codex status**',
      '',
      `- Model: ${model?.label ?? this.#model}${effort === undefined ? '' : ` (${effortChoice(effort).label.toLowerCase()} effort)`}`,
      `- Approvals: ${settings.approvalPolicy} · Sandbox: ${settings.sandbox}${settings.plan ? ' · Plan mode' : ''}`,
      `- Folder: ${this.#places.cwd}`,
      `- AGENTS.md: ${this.#thread.instructions.length === 0 ? 'none' : this.#thread.instructions.join(', ')}`,
      `- Thread: ${this.#thread.id}`,
      `- Login: ${login}`,
    ].join('\n');
  }

  /** /mcp: the MCP servers Codex has, and their tools. */
  async #mcp(): Promise<string> {
    const result = await this.#server.request('mcpServerStatus/list', {
      threadId: this.#thread.id,
    });
    const servers = property(result, 'data');
    if (!Array.isArray(servers) || servers.length === 0) {
      return 'No MCP servers are configured (`codex mcp add` adds one).';
    }
    return [
      '**MCP servers**',
      '',
      ...servers.map((server) => {
        const name = text(property(server, 'name')) ?? '?';
        const tools = property(server, 'tools');
        const names = typeof tools === 'object' && tools !== null ? Object.keys(tools) : [];
        const failed = text(property(server, 'toolsError'));
        const shown = names
          .slice(0, MCP_TOOLS_SHOWN)
          .map((tool) => `\`${tool}\``)
          .join(', ');
        const more =
          names.length > MCP_TOOLS_SHOWN
            ? ` and ${String(names.length - MCP_TOOLS_SHOWN)} more`
            : '';
        return `- **${name}**: ${failed ?? (names.length === 0 ? 'no tools' : shown + more)}`;
      }),
    ].join('\n');
  }

  /** /diff: the project folder's changes, a file each. */
  async #diff(id: string): Promise<SessionEvent[]> {
    const files = await gitDiff(this.#git, this.#places.cwd);
    if (files === undefined) return [notice('info', '/diff: not inside a git repository.')];
    if (files.length === 0) return [notice('info', 'No changes.')];
    return files.map((file, i) => {
      const binary = !file.patch.includes('\n@@') && file.patch.includes('Binary files');
      return {
        type: 'tool',
        id: `${id}:diff:${String(i)}`,
        tool: 'git diff',
        summary: file.path,
        status: 'done',
        detail: binary ? output('Binary file') : unifiedDiff(file.patch),
      };
    });
  }

  async #refreshSkills(): Promise<void> {
    try {
      const result = await this.#server.request('skills/list', {
        cwds: [this.#places.cwd],
        forceReload: true,
      });
      this.#skills = readSkills(result);
      this.#host.emit({ type: 'commands', commands: slashCommands(this.#skills) });
    } catch {
      // The skills it had stay.
    }
  }

  #keepPolicy(value: unknown): void {
    const policy = readSandboxPolicy(value);
    if (policy) this.#policies.set(policy.type, policy);
  }
}

/** Which kind of sandbox policy a sandbox mode is. */
function policyKind(sandbox: ReturnType<typeof modeSettings>['sandbox']): SandboxPolicy['type'] {
  return sandbox === 'read-only'
    ? 'readOnly'
    : sandbox === 'workspace-write'
      ? 'workspaceWrite'
      : 'dangerFullAccess';
}

/** Why a request failed, in a sentence. */
function failureText(error: unknown): string {
  if (error instanceof RpcFailure && error.code === RPC_ERRORS.overloaded) {
    return 'Codex is overloaded: try again in a moment.';
  }
  return error instanceof Error ? error.message : String(error);
}

/** /skills: the skills Codex has, to invoke with /name or $name. */
function skillsList(skills: readonly Skill[]): string {
  if (skills.length === 0) return 'Codex has no skills here.';
  return [
    '**Skills** (use one with `/name` or `$name` in a message):',
    '',
    ...skills.map(
      (skill) => `- \`${skill.name}\`${skill.description === '' ? '' : `: ${skill.description}`}`,
    ),
  ].join('\n');
}

/** A resumed thread's past turns (thread/resume's initialTurnsPage, newest first), as history. */
export function resumedHistory(result: unknown, places: Places): SessionEvent[] {
  const page = property(property(result, 'initialTurnsPage'), 'data');
  const turns: unknown[] = Array.isArray(page) ? [...(page as unknown[])].reverse() : [];
  return historyEvents(turns, places);
}
