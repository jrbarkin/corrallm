import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { connectionIn } from '../../../shared/adapter';
import type { Catalog, ConnectionId } from '../../../shared/adapter';
import type { CanvasId } from '../../../shared/canvas';
import {
  MAX_CANVAS_PROMPTS,
  MAX_CORE_PROMPT_BYTES,
  MAX_PROMPT_TEXT_LENGTH,
  MAX_SESSION_PROMPTS,
} from '../../../shared/api/limits';
import type { NodeLike } from '../../../shared/model/canvas';
import type { PartyId } from '../../../shared/model/messages';
import type { NeedChoice, NeedQuestion, NeedsItem } from '../../../shared/model/needs';
import { detailOf, previewLines } from '../../../shared/model/needs-selectors';
import { promptJsonBytes } from '../../../shared/model/prompt-data';
import {
  checkPromptReply,
  Prompt,
  PromptEnded,
  PromptEvent,
  PromptId,
  PromptReplyAnswer,
} from '../../../shared/model/prompts';
import type { AdapterPrompt, PromptAnswer, PromptSubject } from '../../../shared/model/prompts';
import type { PromptAnswers } from '../../sessions/connector';
import type { PromptOrigin, PromptSink } from '../../sessions/manager';
import { linkTarget } from '../../url-policy';
import { OpFailure } from '../call';
import type { OpContext } from '../call';
import { decidedOf, deciding, landed, withdrawnDecision } from '../decisions';
import type { MessageStore } from '../delivery/messages';
import { nameOf, partyText } from '../parties';
import { notFound } from '../replies';
import type { ReplyResult } from '../replies';
import { classify } from './classify';

/*
 * The core's prompt owner (B13 Design §9.2 C2, C3, C6; §7's C3): every prompt an agent's session
 * raises, in each canvas's live index, from its raise to its end, and the one answer it takes.
 *
 * - Raised (`raised`, from the session manager: core/../sessions/manager.ts' PromptSink): checked
 *   whole against the protocol (src/shared/model/prompts.ts) and C6's bounds, its link one
 *   `link.open` would open, its key no other live prompt's of its generation, within the budgets
 *   (MAX_SESSION_PROMPTS a generation, MAX_CANVAS_PROMPTS a canvas, MAX_CORE_PROMPT_BYTES of the
 *   core's), else declined (`decline`: the connection's nonapproval), the agent's transcript told
 *   why in the core's words. A terminal observation is never declined (corrallm answers nothing
 *   there): one it can't show whole waits as a cut stand-in in the core's words. Admitted, it is
 *   classified once (classify.ts, with the generation's effective start mode), given a fresh
 *   PromptId, and never changes after: its NeedId is `prompt/<escaped agent>/<generation>/<id>`.
 * - Ended by its key (`ended`: withdrawn, or answered in the CLI's terminal), or with its
 *   generation (`gone`). An end for a key unknown, settled, or of another generation is ignored, so
 *   a late end never ends a replacement; one after an answer was handed off is ignored too.
 * - Answered (`answer`, the reply router's prompt handler: run-replies.ts), C3's five steps: checked
 *   (current, yours, the answer against the immutable prompt), then reserved with no await
 *   (another reply meanwhile is a conflict naming who answers); its `delivering` record written
 *   and flushed (a failed flush gives nothing and reopens it); checked again (still reserved, its
 *   generation current: an end meanwhile withdraws the record, a conflict saying how it ended);
 *   past `noReturn`, handed synchronously to the session handle captured as it was raised, never
 *   looked up again; then settled, the record landed. A definitive refusal withdraws the record
 *   and leaves the prompt open (unless it ended as it refused). A crash between the record and its
 *   landing leaves it `delivering`, unresolved as the canvas loads again, never given again: open
 *   prompts are never persisted, so a core started again has none.
 * - Answering never starts or resumes a session: it holds no way to.
 * - Who decided is recorded in the core's words from kind, subject type, hint and the agent's name
 *   (decisions.ts), never a title, label, command, path, plan, feedback, answer or value.
 *
 * Its Needs items (`items`) are yours, with their choices; a token's copy drops them (Needs'
 * `withoutChoices`), and a form's title is the core's, never the server's words, which may hold
 * its link. The prompt's other fields (subject, summary, reason, effects) and the transcript and
 * session views of each occurrence are C7's selector's (B13 §9.2 C11), read from `prompts`.
 */

/** Its budgets (B13 Design §9.2 C6), which tests may lower. */
export interface PromptLimits {
  /** Open prompts of one session generation. */
  session: number;
  /** Open prompts on one canvas. */
  canvas: number;
  /** Bytes of normalized prompt JSON open in the core, across canvases. */
  bytes: number;
}

/** What answering on a canvas uses: its messages (who decided) and its nodes (names). */
export interface PromptCanvas {
  messages: MessageStore;
  nodes: readonly NodeLike[];
}

export interface PromptOwnerDeps {
  /** Every adapter's modes, read for the classifier by the raising generation's connection. */
  catalog: Catalog;
  /** The canvas as the core runs it now: none if it doesn't. */
  canvas(canvas: CanvasId): PromptCanvas | undefined;
  /** The generation of the agent's running session now (the session manager's). */
  generationOf(canvas: CanvasId, agent: string): number | undefined;
  /** What waits on the canvas changed: Needs is read again. */
  changed(canvas: CanvasId, agent: string): void;
  /** Tells the agent's transcript something, in the core's words (why a prompt was declined). */
  notice(canvas: CanvasId, agent: string, connection: ConnectionId, text: string): void;
  /** The time now (epoch ms): when a prompt was raised. */
  now?: () => number;
  limits?: Partial<PromptLimits>;
}

/** How an occurrence ended without an answer given here. */
type EndReason = 'withdrawn' | 'answered-natively';

type State =
  | { at: 'open' }
  /** Reserved by a reply, its record being written. */
  | { at: 'answering'; by: PartyId }
  /** Being handed to its session: an end now is kept, and wins only if the session refuses. */
  | { at: 'handing'; by: PartyId; ended?: EndReason }
  | { at: 'ended'; reason: EndReason }
  | { at: 'answered'; by: PartyId };

interface Occurrence {
  readonly canvas: CanvasId;
  readonly agent: string;
  readonly connection: ConnectionId;
  readonly generation: number;
  /** The adapter's key: private to this owner and the session that raised it. */
  readonly key: string;
  readonly need: string;
  readonly prompt: Prompt;
  /** The raising generation's answers, captured as it was raised. */
  readonly answers: PromptAnswers;
  readonly bytes: number;
  state: State;
}

/** How a prompt no longer live ended, kept to say so to a later reply. */
interface Ended {
  agent: string;
  reason: EndReason | 'answered';
  by?: PartyId;
}

interface CanvasPrompts {
  /** Open, or being answered, by PromptId, in the order they were raised. */
  live: Map<string, Occurrence>;
  /** How each that ended here ended, by its NeedId: the newest MAX_CANVAS_PROMPTS. */
  ended: Map<string, Ended>;
}

/** Why a raise was declined, as a clause. */
const DECLINED = {
  ended: 'its session no longer runs',
  invalid: 'it can’t be shown whole',
  duplicate: 'its session raised two requests under one key',
  link: 'its link isn’t one corrallm opens',
  session: 'too many of its session’s requests wait already',
  canvas: 'too many requests wait on its canvas already',
  core: 'corrallm holds too many requests already',
} as const;
type Declined = keyof typeof DECLINED;

/** The core's line in a prompt's reason when its adapter left out a choice it couldn't word. */
const OMITTED = 'corrallm left out a choice its CLI offers, which it can’t show completely.';

/** What a decision's record calls a subject, by its type. */
const SUBJECTS: Readonly<Record<string, string>> = {
  command: 'command',
  fileChange: 'file change',
  mcpTool: 'MCP tool call',
  network: 'network access',
  permissions: 'request for permissions',
  tool: 'tool call',
  trust: 'request to trust its folder',
  consent: 'request for consent',
};

export class PromptOwner implements PromptSink {
  readonly #deps: PromptOwnerDeps;
  readonly #limits: PromptLimits;
  readonly #canvases = new Map<CanvasId, CanvasPrompts>();
  /** Every live occurrence by its generation's key: what ends it, and a duplicate's check. */
  readonly #keys = new Map<string, Occurrence>();
  #bytes = 0;

  constructor(deps: PromptOwnerDeps) {
    this.#deps = deps;
    this.#limits = {
      session: deps.limits?.session ?? MAX_SESSION_PROMPTS,
      canvas: deps.limits?.canvas ?? MAX_CANVAS_PROMPTS,
      bytes: deps.limits?.bytes ?? MAX_CORE_PROMPT_BYTES,
    };
  }

  raised(at: PromptOrigin, event: unknown): void {
    const key = rawKey(event);
    const terminal = rawAnswerIn(event) === 'terminal';
    if (!at.live) {
      // Its session is replaced or closing: what it asked ends with it, unanswered.
      if (key !== undefined && !terminal) this.#decline(at, key, 'ended', false);
      return;
    }
    const parsed = PromptEvent.safeParse(event);
    if (parsed.success) {
      this.#admit(at, parsed.data.key, parsed.data.prompt);
      return;
    }
    if (terminal && key !== undefined && z.uuid().safeParse(key).success) {
      // Corrallm answers nothing in a terminal: what it can't show whole still waits, as the core
      // words it, for you to look at the terminal.
      this.#admit(at, key, {
        kind: 'approval',
        title: `${this.#name(at.canvas, at.agent)}’s CLI waits for you in its terminal: look there to see what it asks.`,
        answerIn: 'terminal',
        choices: [],
        cut: true,
      });
      return;
    }
    if (key !== undefined) {
      this.#decline(at, key, 'invalid', terminal);
      return;
    }
    console.error('A session raised a prompt with no key: it can’t be answered or declined.');
    this.#deps.notice(
      at.canvas,
      at.agent,
      at.connection,
      `corrallm couldn’t read a request from ${this.#name(at.canvas, at.agent)}’s CLI: look at its session.`,
    );
  }

  ended(at: PromptOrigin, event: unknown): void {
    const parsed = PromptEnded.safeParse(event);
    if (!parsed.success) return;
    const occurrence = this.#keys.get(keyOf(at, parsed.data.key));
    if (occurrence === undefined) return;
    this.#ending(occurrence, parsed.data.reason);
  }

  gone(canvas: CanvasId, agent: string, generation: number): void {
    for (const occurrence of [...(this.#canvases.get(canvas)?.live.values() ?? [])]) {
      if (occurrence.agent === agent && occurrence.generation === generation) {
        this.#ending(occurrence, 'withdrawn');
      }
    }
  }

  /** What waits on the canvas, yours: each live prompt of an agent on it, as its Needs item. */
  items(canvas: CanvasId): NeedsItem[] {
    const nodes = this.#deps.canvas(canvas)?.nodes;
    if (nodes === undefined) return [];
    return [...(this.#canvases.get(canvas)?.live.values() ?? [])]
      .filter(({ agent }) =>
        nodes.some((node) => node.id === agent && (node.type ?? 'agent') === 'agent'),
      )
      .map((occurrence) => needOf(occurrence, nodes));
  }

  /** The live prompts on the canvas, as raised and classified: what C7's selector reads. */
  prompts(canvas: CanvasId): readonly Prompt[] {
    return [...(this.#canvases.get(canvas)?.live.values() ?? [])].map(({ prompt }) => prompt);
  }

  /** Whether `to` names a live prompt here: what the reply router's prompt handler answers. */
  owns(canvas: CanvasId, to: string): boolean {
    return this.#resolve(canvas, to) !== undefined;
  }

  /** The Needs item `to` names, if it names a live prompt on the canvas. */
  current(canvas: CanvasId, to: string): NeedsItem | undefined {
    const occurrence = this.#resolve(canvas, to);
    const nodes = this.#deps.canvas(canvas)?.nodes;
    return occurrence === undefined || nodes === undefined ? undefined : needOf(occurrence, nodes);
  }

  /**
   * Why `to` waits no more, if it named a prompt here: settled (who decided, as recorded, a crash's
   * unresolved answer too), withdrawn or answered in its terminal. None: not one this core knows.
   */
  settled(canvas: CanvasId, to: string): OpFailure | undefined {
    const open = this.#deps.canvas(canvas);
    const record = open === undefined ? undefined : decidedOf(open.messages, to);
    if (record !== undefined)
      return new OpFailure('conflict', `${to} is settled already: ${record.body}`);
    const ended = this.#canvases.get(canvas)?.ended.get(to);
    if (ended === undefined) return undefined;
    const nodes = open?.nodes ?? [];
    if (ended.reason === 'answered') {
      return new OpFailure(
        'conflict',
        `${to} is settled already: ${partyText(nodes, ended.by ?? 'you')} answered it.`,
      );
    }
    return new OpFailure('conflict', endedSentence(to, ended.reason, nameOf(nodes, ended.agent)));
  }

  /** Why `answer` isn't one the prompt `to` names takes, if it isn't. */
  fits(canvas: CanvasId, to: string, answer: unknown): string | undefined {
    const occurrence = this.#resolve(canvas, to);
    if (occurrence === undefined) return `${to} isn’t open any more.`;
    try {
      this.#check(occurrence, answer);
      return undefined;
    } catch (error) {
      return error instanceof OpFailure ? error.message : String(error);
    }
  }

  /** Answers the prompt `to` names with `given`, as `ctx`'s caller: C3's steps. */
  async answer(canvas: CanvasId, to: string, given: unknown, ctx: OpContext): Promise<ReplyResult> {
    const occurrence = this.#resolve(canvas, to);
    if (occurrence === undefined) throw this.settled(canvas, to) ?? notFound(to);
    const open = this.#deps.canvas(canvas);
    if (open === undefined) {
      throw new OpFailure('unavailable', 'That canvas isn’t open in corrallm.');
    }
    // Every native prompt is yours alone until B24's grants: no token answers as you.
    if (ctx.by !== 'you') {
      throw new OpFailure(
        'refused',
        `Only the user may answer ${to}: ${needOf(occurrence, open.nodes).title}`,
      );
    }
    const answer = this.#check(occurrence, given);
    const state = stateOf(occurrence);
    if (state.at !== 'open') {
      const by = state.at === 'answering' || state.at === 'handing' ? state.by : 'you';
      throw new OpFailure(
        'conflict',
        `${to} is being answered now: ${partyText(open.nodes, by)} is answering it.`,
      );
    }
    // Reserved, with nothing awaited since it was checked: a second reply now is a conflict.
    occurrence.state = { at: 'answering', by: ctx.by };
    const name = nameOf(open.nodes, occurrence.agent);
    const record = deciding(open.messages, {
      need: to,
      by: ctx.by,
      words: `${who(open.nodes, ctx.by)} ${decisionWords(name, occurrence.prompt, answer)}.`,
    });
    // Recorded as being made, on disk, before its session is told anything.
    try {
      await open.messages.durable();
    } catch {
      withdrawnDecision(open.messages, record.id, 'It couldn’t be recorded');
      this.#reopen(occurrence);
      throw new OpFailure(
        'unavailable',
        'The answer couldn’t be recorded, so it wasn’t given: try again.',
      );
    }
    // Still reserved, and its generation still the agent's: an end meanwhile won.
    const now = stateOf(occurrence);
    if (
      now.at !== 'answering' ||
      this.#deps.generationOf(canvas, occurrence.agent) !== occurrence.generation
    ) {
      const reason = now.at === 'ended' ? now.reason : 'withdrawn';
      if (now.at === 'answering') this.#end(occurrence, 'withdrawn');
      withdrawnDecision(open.messages, record.id, endedFirst(name, reason));
      await open.messages.durable().catch(() => undefined);
      throw new OpFailure('conflict', endedSentence(to, reason, name));
    }
    // From here nothing is awaited until the session has it.
    try {
      ctx.noReturn();
    } catch (error) {
      withdrawnDecision(open.messages, record.id, 'It was given up first');
      this.#reopen(occurrence);
      await open.messages.durable().catch(() => undefined);
      throw error;
    }
    occurrence.state = { at: 'handing', by: ctx.by };
    try {
      occurrence.answers.answer(occurrence.key, answer);
    } catch (error) {
      const during = stateOf(occurrence);
      const ended = during.at === 'handing' ? during.ended : undefined;
      withdrawnDecision(open.messages, record.id, `${name}’s CLI didn’t take this answer`);
      if (ended === undefined) occurrence.state = { at: 'open' };
      else this.#end(occurrence, ended);
      await open.messages.durable().catch(() => undefined);
      const why = error instanceof Error ? error.message : String(error);
      throw new OpFailure(
        'unavailable',
        ended === undefined
          ? `${name}’s CLI didn’t take the answer, so its prompt still waits for one: ${why}`
          : `${name}’s CLI didn’t take the answer, and its prompt has ended: ${why}`,
      );
    }
    this.#settle(occurrence, ctx.by);
    landed(open.messages, record.id);
    try {
      await open.messages.durable();
    } catch {
      throw new OpFailure(
        'unavailable',
        'It is answered, but who answered it couldn’t be saved, so that may not survive a restart.',
      );
    }
    return { id: record.id, outcome: 'answered' };
  }

  /** The answer `given` as the prompt takes it, or an `invalid` failure saying what it takes. */
  #check(occurrence: Occurrence, given: unknown): PromptAnswer {
    const { prompt, need } = occurrence;
    if (prompt.answerIn === 'terminal') {
      throw new OpFailure('invalid', `${need} is asked in its agent’s terminal: answer it there.`);
    }
    if (!PromptReplyAnswer.safeParse(given).success) {
      throw new OpFailure('invalid', expected(need, prompt));
    }
    try {
      return checkPromptReply(prompt, given);
    } catch (error) {
      throw new OpFailure(
        'invalid',
        error instanceof z.ZodError || !(error instanceof Error)
          ? expected(need, prompt)
          : `${need}: ${error.message}`,
      );
    }
  }

  #admit(at: PromptOrigin, key: string, prompt: AdapterPrompt): void {
    const terminal = prompt.answerIn === 'terminal';
    const duplicate = this.#keys.get(keyOf(at, key));
    if (duplicate !== undefined) {
      // A key names one native request: answering either would be a guess, so neither waits.
      this.#ending(duplicate, 'withdrawn');
      this.#decline(at, key, 'duplicate', terminal);
      return;
    }
    if (prompt.kind === 'form' && 'url' in prompt.form && linkTarget(prompt.form.url) === null) {
      this.#decline(at, key, 'link', terminal);
      return;
    }
    const built = this.#build(at, prompt);
    if (built === undefined) {
      this.#decline(at, key, 'invalid', terminal);
      return;
    }
    const prompts = this.#canvasOf(at.canvas);
    const live = [...prompts.live.values()];
    const bytes = promptJsonBytes(built);
    const over: Declined | undefined =
      live.filter(({ agent, generation }) => agent === at.agent && generation === at.generation)
        .length >= this.#limits.session
        ? 'session'
        : live.length >= this.#limits.canvas
          ? 'canvas'
          : this.#bytes + bytes > this.#limits.bytes
            ? 'core'
            : undefined;
    if (over !== undefined) {
      this.#decline(at, key, over, terminal);
      return;
    }
    const occurrence: Occurrence = {
      canvas: at.canvas,
      agent: at.agent,
      connection: at.connection,
      generation: at.generation,
      key,
      need: needIdOf(at.agent, at.generation, built.id),
      prompt: built,
      answers: at.answers,
      bytes,
      state: { at: 'open' },
    };
    prompts.live.set(built.id, occurrence);
    this.#keys.set(keyOf(at, key), occurrence);
    this.#bytes += bytes;
    this.#deps.changed(at.canvas, at.agent);
  }

  /** The core's prompt: classified, given its id, with the core's line for a choice left out. */
  #build(at: PromptOrigin, prompt: AdapterPrompt): Prompt | undefined {
    // Signals and `omitted` never leave the core: the prompt is shown without them.
    const shown: Partial<AdapterPrompt> = { ...prompt };
    delete shown.signals;
    delete shown.omitted;
    const { omitted } = prompt;
    const classified = classify(prompt, {
      modes: connectionIn(this.#deps.catalog, at.connection)?.adapter.modes ?? [],
      startMode: at.startMode,
    });
    let { reason, cut } = shown;
    if (omitted === true) {
      const room = MAX_PROMPT_TEXT_LENGTH - OMITTED.length - 1;
      if (reason === undefined) reason = OMITTED;
      else if (reason.length <= room) reason = `${reason}\n${OMITTED}`;
      else {
        reason = `${cutText(reason, room - 1)}…\n${OMITTED}`;
        cut = true;
      }
    }
    const parsed = Prompt.safeParse({
      ...shown,
      ...(reason === undefined ? {} : { reason }),
      ...(cut === true ? { cut } : {}),
      id: randomUUID(),
      agent: at.agent,
      raised: this.#deps.now?.() ?? Date.now(),
      ...(classified.humanOnly === undefined ? {} : { humanOnly: classified.humanOnly }),
      ...(classified.choices === undefined ? {} : { choices: classified.choices }),
    });
    if (!parsed.success) return undefined;
    const admitted = structuredClone(parsed.data);
    freeze(admitted);
    return admitted;
  }

  /**
   * Declines what a session raised, by its key, unless it is a terminal observation (corrallm
   * answers nothing there): the transcript is told why, unless its session is gone.
   */
  #decline(at: PromptOrigin, key: string, why: Declined, terminal: boolean): void {
    const name = this.#name(at.canvas, at.agent);
    if (!terminal) {
      try {
        at.answers.decline(key, `corrallm declined this request: ${DECLINED[why]}.`);
      } catch (error) {
        console.error('A session’s decline failed:', error);
      }
    }
    if (why === 'ended') return;
    this.#deps.notice(
      at.canvas,
      at.agent,
      at.connection,
      terminal
        ? `corrallm can’t list what ${name}’s CLI asks in its terminal (${DECLINED[why]}): look at its terminal.`
        : `corrallm declined a request from ${name}’s CLI: ${DECLINED[why]}.`,
    );
  }

  /** Ends an occurrence by its session's word, or its generation's end: as its state allows. */
  #ending(occurrence: Occurrence, reason: EndReason): void {
    const state = stateOf(occurrence);
    if (state.at === 'handing') {
      // Handed off: the answer stands if the session took it; this wins only if it refused.
      state.ended ??= reason;
      return;
    }
    if (state.at === 'open' || state.at === 'answering') this.#end(occurrence, reason);
  }

  #end(occurrence: Occurrence, reason: EndReason): void {
    occurrence.state = { at: 'ended', reason };
    this.#forget(occurrence, { agent: occurrence.agent, reason });
  }

  #settle(occurrence: Occurrence, by: PartyId): void {
    occurrence.state = { at: 'answered', by };
    this.#forget(occurrence, { agent: occurrence.agent, reason: 'answered', by });
  }

  /** A reservation given back: open again, unless its session ended it meanwhile. */
  #reopen(occurrence: Occurrence): void {
    const state = stateOf(occurrence);
    if (state.at === 'answering') occurrence.state = { at: 'open' };
    else if (state.at === 'handing') {
      if (state.ended === undefined) occurrence.state = { at: 'open' };
      else this.#end(occurrence, state.ended);
    }
  }

  #forget(occurrence: Occurrence, ended: Ended): void {
    const prompts = this.#canvasOf(occurrence.canvas);
    if (prompts.live.get(occurrence.prompt.id) !== occurrence) return;
    prompts.live.delete(occurrence.prompt.id);
    this.#keys.delete(keyOf(occurrence, occurrence.key));
    this.#bytes -= occurrence.bytes;
    prompts.ended.set(occurrence.need, ended);
    for (const oldest of prompts.ended.keys()) {
      if (prompts.ended.size <= MAX_CANVAS_PROMPTS) break;
      prompts.ended.delete(oldest);
    }
    this.#deps.changed(occurrence.canvas, occurrence.agent);
  }

  /** The live occurrence `to` names, by its PromptId in the index, its agent and generation too. */
  #resolve(canvas: CanvasId, to: string): Occurrence | undefined {
    const id = to.split('/').at(-1);
    if (id === undefined || !PromptId.safeParse(id).success) return undefined;
    const occurrence = this.#canvases.get(canvas)?.live.get(id);
    return occurrence?.need === to ? occurrence : undefined;
  }

  #canvasOf(canvas: CanvasId): CanvasPrompts {
    let prompts = this.#canvases.get(canvas);
    if (prompts === undefined) {
      prompts = { live: new Map(), ended: new Map() };
      this.#canvases.set(canvas, prompts);
    }
    return prompts;
  }

  #name(canvas: CanvasId, agent: string): string {
    return nameOf(this.#deps.canvas(canvas)?.nodes ?? [], agent);
  }
}

/** Own every admitted value, including JSON subjects, and keep every read immutable. */
function freeze(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freeze(child);
  Object.freeze(value);
}

/** An occurrence's state as it is now, read afresh (it changes across awaits). */
function stateOf(occurrence: Occurrence): State {
  return occurrence.state;
}

/** The key of a generation's key, among every generation's. */
function keyOf(
  { canvas, agent, generation }: { canvas: CanvasId; agent: string; generation: number },
  key: string,
): string {
  return [canvas, agent, String(generation), key].join('\u0000');
}

/** A prompt's Needs id: `prompt/<escaped agent>/<generation>/<PromptId>`. */
function needIdOf(agent: string, generation: number, id: string): string {
  return ['prompt', encodeURIComponent(agent), String(generation), id].join('/');
}

/** The key a raise names, whatever else it holds, if it names one at all. */
function rawKey(event: unknown): string | undefined {
  if (event === null || typeof event !== 'object') return undefined;
  const { key } = event as { key?: unknown };
  return typeof key === 'string' && key.length > 0 && key.length <= 4096 ? key : undefined;
}

/** Where a raise says it is answered, whatever else it holds. */
function rawAnswerIn(event: unknown): unknown {
  if (event === null || typeof event !== 'object') return undefined;
  const { prompt } = event as { prompt?: unknown };
  if (prompt === null || typeof prompt !== 'object') return undefined;
  return (prompt as { answerIn?: unknown }).answerIn;
}

/** `text` cut to at most `length` UTF-16 units, never between a character's two halves. */
function cutText(text: string, length: number): string {
  if (text.length <= length) return text;
  const code = text.charCodeAt(length - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}

/** An occurrence's Needs item, yours: generic fields only, the router's and Needs'. */
function needOf(occurrence: Occurrence, nodes: readonly NodeLike[]): NeedsItem {
  const { prompt } = occurrence;
  const base = {
    id: occurrence.need,
    canvas: occurrence.canvas,
    agent: occurrence.agent,
    kind: 'prompt' as const,
    for: 'you' as const,
    by: ['you' as const],
    answerIn: prompt.answerIn,
  };
  // A whole prompt only you may answer marks each of its choices so, for the router's check too.
  const choices = (): NeedChoice[] =>
    prompt.kind !== 'approval' && prompt.kind !== 'plan'
      ? []
      : prompt.choices.map(({ value, label, description, humanOnly }) => {
          const why = humanOnly ?? prompt.humanOnly;
          return {
            value,
            label,
            ...(description === undefined ? {} : { description }),
            ...(why === undefined ? {} : { humanOnly: why }),
          };
        });
  switch (prompt.kind) {
    case 'approval':
      return { ...base, title: prompt.title, ...detailOf(prompt.detail), choices: choices() };
    case 'plan':
      return { ...base, title: prompt.title, ...previewLines(prompt.plan), choices: choices() };
    case 'question':
      return {
        ...base,
        title: prompt.title,
        ...detailOf(prompt.detail),
        choices: [],
        questions: prompt.questions.map(
          ({ id, header, text, options, multiple, other }): NeedQuestion => ({
            id,
            header,
            text,
            options: options.map(({ label, description }) => ({
              label,
              ...(description === undefined ? {} : { description }),
            })),
            multiple,
            other,
          }),
        ),
      };
    case 'form':
      // The server's own words may hold its link: the core's title, and no detail, for everyone.
      return {
        ...base,
        title: `${nameOf(nodes, occurrence.agent)}’s CLI asks you to ${'url' in prompt.form ? 'open a link' : 'fill in a form'}`,
        choices: [],
        form: prompt.form,
      };
  }
}

/** What a prompt takes, said to an answer that isn't one. */
function expected(need: string, prompt: Prompt): string {
  switch (prompt.kind) {
    case 'approval':
    case 'plan':
      return `${need} takes one of its choices (${prompt.choices.map(({ value }) => `"${value}"`).join(', ')}), with feedback only where that choice takes it.`;
    case 'question':
      return `${need} takes an answer to each of its questions, by id: the labels picked, or, where it takes them, your own words.`;
    case 'form':
      return `${need} takes a form’s answer: accept (with its values), decline or cancel.`;
  }
}

/** How a prompt ended without the answer given, as a reply is told. */
function endedSentence(need: string, reason: EndReason, name: string): string {
  return reason === 'answered-natively'
    ? `${need} was answered in ${name}’s terminal first.`
    : `${need} was withdrawn: ${name}’s session no longer asks it.`;
}

/** Why a record of an answer not given was withdrawn, as a clause. */
function endedFirst(name: string, reason: EndReason): string {
  return reason === 'answered-natively'
    ? `It was answered in ${name}’s terminal first`
    : `${name}’s session withdrew it first`;
}

/** Who decided, as a record names them: You, or the party. */
function who(nodes: readonly NodeLike[], by: PartyId): string {
  if (by === 'you') return 'You';
  const text = partyText(nodes, by);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * What an answer decided, in the core's words from the prompt's kind, its subject's type, the
 * choice's hint and the agent's name: never a title, label, command, path, plan, feedback or value.
 */
function decisionWords(name: string, prompt: Prompt, answer: PromptAnswer): string {
  switch (prompt.kind) {
    case 'approval':
    case 'plan': {
      const chosen = answer.kind === 'choice' ? answer.value : undefined;
      const hint = prompt.choices.find(({ value }) => value === chosen)?.hint;
      if (prompt.kind === 'plan') {
        return hint === 'allow_once' || hint === 'allow_always'
          ? `approved ${name}’s plan`
          : `asked ${name} to keep planning`;
      }
      const what = subjectWords(prompt.subject);
      switch (hint) {
        case 'allow_once':
          return `allowed ${name}’s ${what} once`;
        case 'allow_always':
          return `allowed ${name}’s ${what} from now on`;
        case 'reject_always':
          return `refused ${name}’s ${what} from now on`;
        default:
          return `refused ${name}’s ${what}`;
      }
    }
    case 'question': {
      const count = prompt.questions.length;
      const secret = prompt.questions.some((question) => question.secret === true);
      return `answered ${name}’s question${count === 1 ? '' : 's'}${secret ? ' (secret)' : ''}`;
    }
    case 'form': {
      const action = answer.kind === 'form' ? answer.action : 'cancel';
      const verb =
        action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'cancelled';
      return `${verb} ${name}’s ${'url' in prompt.form ? 'link' : 'form'}`;
    }
  }
}

function subjectWords(subject: PromptSubject | undefined): string {
  if (subject === undefined) return 'request';
  return Object.hasOwn(SUBJECTS, subject.type) ? (SUBJECTS[subject.type] ?? 'request') : 'request';
}
