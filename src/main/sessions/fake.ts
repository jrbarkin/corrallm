import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { z } from 'zod';

import type { AdapterId } from '../../shared/adapter';
import type { ModelChoice, SessionAnswer, SessionMode, UserMessage } from '../../shared/session';
import type { Connector, LiveSession, SessionHost, SessionSpec } from './connector';

/** The models a fake session offers. */
export const FAKE_MODELS: ModelChoice[] = [
  { value: 'default', label: 'Default', description: 'The fake’s default model' },
  { value: 'fast', label: 'Fast', description: 'Another model to pick' },
];

/** The models a fake Codex session offers: with reasoning efforts to choose, as Codex's have. */
export const FAKE_CODEX_MODELS: ModelChoice[] = [
  {
    value: 'default',
    label: 'Default',
    description: 'The fake’s default model',
    efforts: [
      { value: 'low', label: 'Low', description: 'Fast responses' },
      { value: 'high', label: 'High', description: 'Deeper reasoning' },
    ],
    defaultEffort: 'low',
  },
  { value: 'fast', label: 'Fast', description: 'Another model to pick' },
];

const SCRIPT = z.strictObject({
  pause: z.number().int().min(0).max(60_000),
  turns: z
    .array(
      z.strictObject({
        when: z.string().min(1).optional(),
        thinking: z.string().optional(),
        tools: z
          .array(
            z.strictObject({
              tool: z.string().min(1),
              summary: z.string(),
              output: z.string().optional(),
              diff: z
                .array(
                  z.strictObject({ kind: z.enum(['add', 'remove', 'same']), text: z.string() }),
                )
                .optional(),
            }),
          )
          .optional(),
        reply: z.string().min(1),
      }),
    )
    .min(1),
});

/**
 * Scripted turns, for the README's pictures alone (`pnpm media`, e2e/media/): a turn plays the
 * first of `turns` whose `when` its message holds (or that has none), streaming its thinking,
 * tool calls and reply `pause` ms apart, and never asks.
 */
export type FakeScript = z.infer<typeof SCRIPT>;

/**
 * The script in the JSON file CORRALLM_FAKE_SCRIPT names, which only the media capture sets (tests
 * never do): none without it. A file that isn't one is refused, not ignored.
 */
export function fakeScript(env: NodeJS.ProcessEnv = process.env): FakeScript | undefined {
  const file = env.CORRALLM_FAKE_SCRIPT;
  return file === undefined || file === ''
    ? undefined
    : SCRIPT.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/**
 * A connector that runs no CLI, for tests, standing in for any connection of `adapter`. Each turn
 * echoes the message, thinks, and runs a command, asking first in the modes
 * that ask (Manual and Plan; Codex's Read only); a message starting "/question" asks the user a
 * question instead, and one starting "/plan" asks to approve a plan. It honours interrupts, modes,
 * models and (for Codex, whose models offer them) reasoning efforts, and remembers a made-up
 * session id.
 *
 * The manager's tests use it, and so do the e2e tests (CORRALLM_FAKE_SESSIONS=1, honoured only by
 * unpackaged builds), to drive the whole path from the renderer through IPC and back.
 */
export class FakeConnector implements Connector<SessionMode> {
  /** Every session it started, as it was started, and the id each one remembered. */
  readonly started: SessionSpec<SessionMode>[] = [];
  readonly ids: string[] = [];
  /** Every session it started, each with the messages it was sent. */
  readonly sessions: FakeSession[] = [];
  readonly #step: () => Promise<void>;
  readonly #mode: SessionMode | null;
  readonly #asks: boolean | undefined;
  readonly #adapter: AdapterId;
  readonly #script: FakeScript | undefined;

  /**
   * `pause`: how long (ms) between the events of a turn; `adapter`: the one it stands in for;
   * `mode`: its native setting, which applies when no mode is chosen (null: one it never reports,
   * as a CLI that never says its mode); `asks`: whether that setting asks, as it says where its
   * mode doesn't (a policy that is no mode). `step` replaces the delay with a test-controlled
   * scheduler, so tests of another clock can run turns without advancing that clock. `script`:
   * the turns it plays instead (FakeScript), by default CORRALLM_FAKE_SCRIPT's.
   */
  constructor({
    pause = 0,
    adapter = 'claude-code',
    mode,
    asks,
    step = () => new Promise<void>((resolve) => setTimeout(resolve, pause)),
    script = fakeScript(),
  }: {
    pause?: number;
    adapter?: AdapterId;
    mode?: SessionMode | null;
    asks?: boolean;
    step?: () => Promise<void>;
    script?: FakeScript | undefined;
  } = {}) {
    this.#step = step;
    this.#script = script;
    this.#adapter = adapter;
    this.#mode = mode === undefined ? (adapter === 'codex' ? 'auto' : 'manual') : mode;
    this.#asks = asks;
  }

  start(spec: SessionSpec<SessionMode>, host: SessionHost): Promise<LiveSession<SessionMode>> {
    this.started.push(spec);
    const id = spec.resume ?? randomUUID();
    this.ids.push(id);
    host.remember(id);
    if (spec.resume !== null) {
      host.emit({ type: 'notice', id: randomUUID(), level: 'info', text: `Resumed ${id}` });
    }
    // The fake's native setting applies when no mode was chosen.
    const mode = spec.mode ?? this.#mode;
    const codex = this.#adapter === 'codex';
    host.emit({
      type: 'started',
      model: spec.model ?? 'default',
      mode,
      models: codex ? FAKE_CODEX_MODELS : FAKE_MODELS,
      ...(codex ? { effort: spec.effort ?? null } : {}),
      ...(spec.mode === null && this.#asks !== undefined ? { asks: this.#asks } : {}),
    });
    const session = new FakeSession(mode, host, this.#step, this.#script);
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}

/** A turn going on: whether it was interrupted, and the prompt it waits on. */
interface Turn {
  stopped: boolean;
  /** Ends the wait for the prompt it shows, with the user's answer (or none, when stopped). */
  answered?: (answer: SessionAnswer | undefined) => void;
  /** Entries still open: a running tool, an open prompt. */
  tool: string | undefined;
  prompt: string | undefined;
  /** Ends a scripted turn's pause early, when it is stopped. */
  wake?: (() => void) | undefined;
}

/** The modes in which a fake session asks before running its command. */
const ASKING: readonly SessionMode[] = ['manual', 'plan', 'read-only'];

class FakeSession implements LiveSession<SessionMode> {
  /** Every message it was sent, in order. */
  readonly sent: UserMessage[] = [];
  #mode: SessionMode | null;
  readonly #host: SessionHost;
  readonly #step: () => Promise<void>;
  readonly #script: FakeScript | undefined;
  #turn: Turn | undefined;
  #turns = 0;

  constructor(
    mode: SessionMode | null,
    host: SessionHost,
    step: () => Promise<void>,
    script?: FakeScript,
  ) {
    this.#mode = mode;
    this.#host = host;
    this.#step = step;
    this.#script = script;
  }

  send(message: UserMessage): Promise<void> {
    this.sent.push(message);
    const turn: Turn = { stopped: false, tool: undefined, prompt: undefined };
    this.#turn = turn;
    void this.#play(message, turn);
    return Promise.resolve();
  }

  answer(promptId: string, answer: SessionAnswer): Promise<void> {
    const turn = this.#turn;
    if (turn?.prompt !== promptId)
      return Promise.reject(new Error(`No prompt ${promptId} is open`));
    turn.prompt = undefined;
    turn.answered?.(answer);
    return Promise.resolve();
  }

  interrupt(): Promise<void> {
    const turn = this.#turn;
    if (turn) {
      turn.stopped = true;
      turn.answered?.(undefined);
      turn.wake?.();
    }
    return Promise.resolve();
  }

  setMode(mode: SessionMode): Promise<void> {
    this.#mode = mode;
    this.#host.emit({ type: 'mode', mode });
    return Promise.resolve();
  }

  setModel(model: string): Promise<void> {
    this.#host.emit({ type: 'model', model });
    return Promise.resolve();
  }

  setEffort(effort: string | null): Promise<void> {
    this.#host.emit({ type: 'effort', effort });
    return Promise.resolve();
  }

  close(): Promise<void> {
    return this.interrupt();
  }

  async #play({ id, text }: UserMessage, turn: Turn): Promise<void> {
    const emit = this.#host.emit.bind(this.#host);
    const started = Date.now();
    const step = async () => {
      await this.#step();
      return !turn.stopped;
    };
    /** Shows a prompt, and waits for its answer (undefined: the turn was stopped). */
    const ask = (prompt: string, show: () => void) =>
      new Promise<SessionAnswer | undefined>((resolve) => {
        turn.prompt = prompt;
        turn.answered = resolve;
        show();
        emit({ type: 'status', status: 'waiting' });
      });
    const run = async (): Promise<boolean> => {
      emit({ type: 'user', id, text });
      emit({ type: 'status', status: 'working' });
      if (!(await step())) return false;
      emit({ type: 'thinking', id: `${id}/thinking`, text: `They wrote “${text}”.` });
      if (!(await step())) return false;
      emit({ type: 'text', id: `${id}/reply`, text: 'You said: ' });
      if (!(await step())) return false;
      emit({ type: 'text', id: `${id}/reply`, text });

      if (text.startsWith('/question')) {
        const answer = await ask(`${id}/question`, () => {
          emit({
            type: 'question',
            id: `${id}/question`,
            questions: [
              {
                header: 'Go on?',
                text: 'Shall I go on?',
                options: [
                  { label: 'Yes', description: 'Carry on' },
                  { label: 'No', description: 'Stop here' },
                ],
                multiple: false,
              },
            ],
          });
        });
        if (answer?.kind !== 'question') return false;
        emit({ type: 'status', status: 'working' });
        emit({
          type: 'text',
          id: `${id}/answer`,
          text: `Answer received: ${answer.answers.join('; ')}`,
        });
        return true;
      }

      if (text.startsWith('/plan')) {
        const answer = await ask(`${id}/plan`, () => {
          emit({ type: 'plan', id: `${id}/plan`, plan: '1. Read the code\n2. Change it' });
        });
        if (answer?.kind !== 'plan') return false;
        emit({ type: 'status', status: 'working' });
        if (answer.answer.approve) {
          this.#mode = answer.answer.mode;
          emit({ type: 'mode', mode: answer.answer.mode });
          emit({ type: 'text', id: `${id}/approved`, text: 'Carrying out the plan.' });
        } else {
          emit({ type: 'text', id: `${id}/revise`, text: `Revising: ${answer.answer.feedback}` });
        }
        return true;
      }

      const tool = `${id}/tool`;
      const command = { tool: 'Bash', summary: 'echo hello' };
      turn.tool = tool;
      emit({ type: 'tool', id: tool, ...command, status: 'running' });
      if (this.#mode !== null && ASKING.includes(this.#mode)) {
        const answer = await ask(`${id}/permission`, () => {
          emit({
            type: 'permission',
            id: `${id}/permission`,
            ...command,
            always: 'Yes, and don’t ask again for echo commands in this folder',
          });
        });
        if (answer === undefined) return false;
        emit({ type: 'status', status: 'working' });
        if (answer.kind === 'permission' && answer.answer === 'deny') {
          emit({ type: 'tool', id: tool, ...command, status: 'failed' });
          turn.tool = undefined;
          emit({ type: 'text', id: `${id}/denied`, text: 'OK, I won’t run it.' });
          return true;
        }
      }
      if (!(await step())) return false;
      emit({
        type: 'tool',
        id: tool,
        ...command,
        status: 'done',
        detail: { kind: 'output', text: 'hello' },
      });
      turn.tool = undefined;
      if (text.includes('End your reply with SUCCEEDED or FAILED'))
        emit({ type: 'text', id: `${id}/verdict`, text: '\nSUCCEEDED' });
      return true;
    };

    const scripted = this.#script?.turns.find(
      (one) => one.when === undefined || text.includes(one.when),
    );
    const finished =
      scripted === undefined || this.#script === undefined
        ? await run()
        : await this.#scripted(id, text, turn, scripted, this.#script.pause);
    if (this.#turn === turn) this.#turn = undefined;
    if (!finished) {
      if (turn.tool !== undefined) {
        emit({
          type: 'tool',
          id: turn.tool,
          tool: 'Bash',
          summary: 'echo hello',
          status: 'interrupted',
        });
      }
      if (turn.prompt !== undefined) emit({ type: 'withdrawn', id: turn.prompt });
    }
    this.#turns += 1;
    emit({
      type: 'usage',
      usage: {
        costUsd: this.#turns / 100,
        context: { used: this.#turns * 1000, window: 200_000, compactAt: 167_000 },
        contextTokens: this.#turns * 1000,
        contextWindow: 200_000,
      },
    });
    emit({
      type: 'end',
      messages: [id],
      seconds: Math.max(1, Math.round((Date.now() - started) / 1000)),
      result: finished
        ? { status: 'completed', reason: 'completed' }
        : { status: 'cancelled', reason: 'interrupted' },
    });
  }

  /** Plays a scripted turn (FakeScript): false if it was stopped. */
  async #scripted(
    id: string,
    text: string,
    turn: Turn,
    scripted: FakeScript['turns'][number],
    pause: number,
  ): Promise<boolean> {
    const emit = this.#host.emit.bind(this.#host);
    const step = async (count = 1) => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pause * count);
        turn.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      turn.wake = undefined;
      return !turn.stopped;
    };
    /** Streams `words` into entry `entry`, a few words at a time (a list marker with its first). */
    const stream = async (type: 'text' | 'thinking', entry: string, words: string) => {
      const pieces = words.match(/(?:(?:[-*]|\d+\.)\s+)?\S+\s*|\s+/g) ?? [];
      for (let i = 0; i < pieces.length; i += 3) {
        emit({ type, id: entry, text: pieces.slice(i, i + 3).join('') });
        if (!(await step())) return false;
      }
      return true;
    };
    emit({ type: 'user', id, text });
    emit({ type: 'status', status: 'working' });
    if (scripted.thinking !== undefined) {
      if (!(await stream('thinking', `${id}/thinking`, scripted.thinking))) return false;
    }
    for (const [i, { tool, summary, output, diff }] of (scripted.tools ?? []).entries()) {
      const call = `${id}/tool-${String(i)}`;
      turn.tool = call;
      emit({ type: 'tool', id: call, tool, summary, status: 'running' });
      if (!(await step(4))) {
        emit({ type: 'tool', id: call, tool, summary, status: 'interrupted' });
        turn.tool = undefined;
        return false;
      }
      emit({
        type: 'tool',
        id: call,
        tool,
        summary,
        status: 'done',
        ...(diff !== undefined
          ? {
              detail: {
                kind: 'diff' as const,
                added: diff.filter((line) => line.kind === 'add').length,
                removed: diff.filter((line) => line.kind === 'remove').length,
                lines: diff,
              },
            }
          : output !== undefined
            ? { detail: { kind: 'output' as const, text: output } }
            : {}),
      });
      turn.tool = undefined;
    }
    return stream('text', `${id}/reply`, scripted.reply);
  }
}
