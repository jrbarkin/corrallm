import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { z } from 'zod';

import type { EffectiveFeatures } from '../../shared/features';
import type { ModelChoice, SessionMode, UserMessage } from '../../shared/session';
import type { Connector, LiveSession, PromptAnswers, SessionHost, SessionSpec } from './connector';
import { checkPromptAnswer } from '../../shared/model/prompts';
import { fakeApproval, fakeConsent, fakeQuestions } from './fake-prompts';
import type { FakeConsent } from './adapter';
import type { AdapterPrompt, PromptAnswer } from '../../shared/model/prompts';

/** Explicit fixture data; the connector never selects behaviour from an adapter id. */
export interface FakeProfile {
  mode: SessionMode | null;
  models: readonly ModelChoice[];
  effort: boolean;
  askingModes: readonly SessionMode[];
  /**
   * What its `started` reports it does (B16 C1), as its adapter declares it: the manager reads it
   * against that adapter's maxima, as it reads any connection's report.
   */
  features: EffectiveFeatures;
  tool?: { tool: string; summary: string };
  plan: () => AdapterPrompt;
}

/** Scheduling and native-default overrides for one test connector. */
export interface FakeOptions {
  pause?: number;
  /** The consent its connection asks before a "/consent" turn (B22a C4). */
  consent?: FakeConsent;
  mode?: SessionMode | null;
  asks?: boolean;
  /** Waits between a turn's events; given the message whose turn it is, to hold that turn alone. */
  step?: (message: UserMessage) => Promise<void>;
  script?: FakeScript | undefined;
  /** What its `started` reports instead of its profile's: a narrower session, for tests (B16 C1). */
  features?: EffectiveFeatures;
}

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
 * A connector that runs no CLI, for tests, using its supplied fixture profile. Each turn
 * echoes the message, thinks, and runs a command, asking in the supplied modes; a message starting "/question" asks the user a
 * question instead, and one starting "/plan" asks to approve a plan. Given its connection's
 * consent (`consent`, B22a C4), a message starting "/consent" first asks it, as a connection asks
 * before a turn uses what the consent covers, unless allowed for the session or for good at the
 * consent's generation now: taken back since, it asks again; an answer to a question asked before
 * that grants nothing. It honours interrupts, modes,
 * models and reasoning efforts where supplied, and remembers a made-up
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
  readonly #step: (message: UserMessage) => Promise<void>;
  readonly #mode: SessionMode | null;
  readonly #asks: boolean | undefined;
  readonly #profile: FakeProfile;
  readonly #script: FakeScript | undefined;
  readonly #consent: FakeConsent | undefined;

  /**
   * `profile`: the explicit models, modes and feature reports; `pause`: ms between events;
   * `mode`: its native setting, which applies when no mode is chosen (null: one it never reports,
   * as a CLI that never says its mode); `asks`: whether that setting asks, as it says where its
   * mode doesn't (a policy that is no mode). `step` replaces the delay with a test-controlled
   * scheduler, so tests of another clock can run turns without advancing that clock. `script`:
   * the turns it plays instead (FakeScript), by default CORRALLM_FAKE_SCRIPT's. `consent`: the one
   * its connection asks before a "/consent" turn, if any.
   */
  constructor({
    pause = 0,
    profile,
    mode,
    asks,
    step = () => new Promise<void>((resolve) => setTimeout(resolve, pause)),
    script = fakeScript(),
    features,
    consent,
  }: FakeOptions & { profile: FakeProfile }) {
    this.#step = step;
    this.#script = script;
    this.#consent = consent;
    const { plan, ...data } = profile;
    this.#profile = {
      ...structuredClone(data),
      plan,
      ...(features === undefined ? {} : { features }),
    };
    this.#mode = mode === undefined ? profile.mode : mode;
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
    const profile = this.#profile;
    const started = {
      type: 'started' as const,
      ...profile.features,
      model: spec.model ?? profile.models[0]?.value ?? null,
      mode,
      models: structuredClone([...profile.models]),
      ...(profile.effort ? { effort: spec.effort ?? null } : {}),
      ...(spec.mode === null && this.#asks !== undefined ? { asks: this.#asks } : {}),
    };
    host.emit(started);
    const session = new FakeSession(mode, host, this.#step, profile, this.#script, this.#consent);
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}

/** A turn going on: whether it was interrupted, and the prompt it waits on. */
interface Turn {
  stopped: boolean;
  /** Ends the wait for the prompt it shows, with the user's answer (or none, when stopped). */
  answered?: (answer: PromptAnswer | undefined) => void;
  /** Entries still open: a running tool, an open prompt. */
  tool: string | undefined;
  prompt: string | undefined;
  /** Ends a scripted turn's pause early, when it is stopped. */
  wake?: (() => void) | undefined;
}

class FakeSession implements LiveSession<SessionMode> {
  /** Every message it was sent, in order. */
  readonly sent: UserMessage[] = [];
  #mode: SessionMode | null;
  readonly #host: SessionHost;
  readonly #step: (message: UserMessage) => Promise<void>;
  readonly #script: FakeScript | undefined;
  readonly #profile: FakeProfile;
  #turn: Turn | undefined;
  #turns = 0;
  readonly prompts: PromptAnswers;
  #owned: { prompt: AdapterPrompt; key: string } | undefined;
  readonly #consent: FakeConsent | undefined;
  /** The consent's generation at which this session may go on: none until it is allowed. */
  #allowed: number | undefined;

  constructor(
    mode: SessionMode | null,
    host: SessionHost,
    step: (message: UserMessage) => Promise<void>,
    profile: FakeProfile,
    script?: FakeScript,
    consent?: FakeConsent,
  ) {
    this.#mode = mode;
    this.#host = host;
    this.#step = step;
    this.#profile = profile;
    this.#script = script;
    this.#consent = consent;
    this.prompts = {
      answer: (key, answer) => {
        const owned = this.#owned;
        if (owned?.key !== key) throw new Error('That prompt is no longer waiting.');
        const checked = checkPromptAnswer(owned.prompt, answer);
        this.#owned = undefined;
        this.#answer(key, checked);
      },
      decline: (key) => {
        if (this.#owned?.key !== key) return;
        this.#owned = undefined;
        if (this.#turn) {
          this.#turn.prompt = undefined;
          this.#turn.answered?.(undefined);
        }
      },
    };
  }

  send(message: UserMessage): Promise<void> {
    this.sent.push(message);
    const turn: Turn = { stopped: false, tool: undefined, prompt: undefined };
    this.#turn = turn;
    void this.#play(message, turn);
    return Promise.resolve();
  }

  #answer(promptId: string, answer: PromptAnswer): void {
    const turn = this.#turn;
    if (turn?.prompt !== promptId) throw new Error(`No prompt ${promptId} is open`);
    turn.prompt = undefined;
    turn.answered?.(answer);
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
      await this.#step({ id, text });
      return !turn.stopped;
    };
    /** Shows a prompt, and waits for its answer (undefined: the turn was stopped). */
    const ask = (prompt: AdapterPrompt) =>
      new Promise<PromptAnswer | undefined>((resolve) => {
        const key = randomUUID();
        this.#owned = { key, prompt };
        turn.prompt = key;
        turn.answered = resolve;
        emit({ type: 'prompt', key, prompt });
        emit({ type: 'status', status: 'waiting' });
      });
    /**
     * Whether a "/consent" turn may go on: at once while allowed at the consent's generation now,
     * else once you say so; an answer to a question asked before it was taken back asks again.
     */
    const allowed = async (): Promise<boolean> => {
      const consent = this.#consent;
      if (consent === undefined || !text.startsWith('/consent')) return true;
      for (;;) {
        const generation = consent.handle.generation();
        if (this.#allowed === generation) return true;
        const given = await consent.handle.given().catch(() => false);
        if (turn.stopped) return false;
        if (consent.handle.generation() !== generation) continue;
        if (!given) {
          const answer = await ask(fakeConsent(consent.key));
          if (answer?.kind !== 'choice' || answer.value === 'no') return false;
          if (consent.handle.generation() !== generation) continue;
          if (answer.value === 'always') void consent.handle.give(generation);
          emit({ type: 'status', status: 'working' });
        }
        this.#allowed = generation;
        return true;
      }
    };
    const run = async (): Promise<boolean> => {
      emit({ type: 'user', id, text });
      emit({ type: 'status', status: 'working' });
      if (!(await allowed())) return false;
      if (!(await step())) return false;
      emit({ type: 'thinking', id: `${id}/thinking`, text: `They wrote “${text}”.` });
      if (!(await step())) return false;
      emit({ type: 'text', id: `${id}/reply`, text: 'You said: ' });
      if (!(await step())) return false;
      emit({ type: 'text', id: `${id}/reply`, text });

      if (text.startsWith('/question')) {
        const answer = await ask(fakeQuestions());
        if (answer?.kind !== 'questions') return false;
        emit({ type: 'status', status: 'working' });
        emit({
          type: 'text',
          id: `${id}/answer`,
          text: `Answer received: ${Object.values(answer.answers)
            .map((one) => ('text' in one ? one.text : one.picked.join(', ')))
            .join('; ')}`,
        });
        return true;
      }

      if (text.startsWith('/plan')) {
        const prompt = this.#profile.plan();
        const answer = await ask(prompt);
        if (answer?.kind !== 'choice') return false;
        emit({ type: 'status', status: 'working' });
        const choice =
          'choices' in prompt
            ? prompt.choices.find((one) => one.value === answer.value)
            : undefined;
        if (choice?.hint === 'allow_once' || choice?.hint === 'allow_always') {
          const mode = choice.effects?.mode as SessionMode | undefined;
          if (mode !== undefined) {
            this.#mode = mode;
            emit({ type: 'mode', mode });
          }
          emit({ type: 'text', id: `${id}/approved`, text: 'Carrying out the plan.' });
        } else {
          emit({ type: 'text', id: `${id}/revise`, text: `Revising: ${answer.feedback ?? ''}` });
        }
        return true;
      }

      const tool = `${id}/tool`;
      const command = this.#profile.tool ?? { tool: 'command', summary: 'echo hello' };
      turn.tool = tool;
      emit({ type: 'tool', id: tool, ...command, status: 'running' });
      if (this.#mode !== null && this.#profile.askingModes.includes(this.#mode)) {
        const answer = await ask(fakeApproval());
        if (answer === undefined) return false;
        emit({ type: 'status', status: 'working' });
        if (answer.kind === 'choice' && answer.value === 'deny') {
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
          ...(this.#profile.tool ?? { tool: 'command', summary: 'echo hello' }),
          status: 'interrupted',
        });
      }
      if (turn.prompt !== undefined) {
        this.#owned = undefined;
        emit({ type: 'prompt-ended', key: turn.prompt, reason: 'withdrawn' });
      }
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
