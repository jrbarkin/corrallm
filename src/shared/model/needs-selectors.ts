import { MAX_DETAIL_LINES } from '../api/limits';
import type { CanvasId } from '../canvas';
import type { AgentNode, CanvasNode } from './canvas';
import type { NeedChoice, NeedQuestion, NeedsItem } from './needs';
import { agentName } from './queries';
import { isOpen } from './session';
import type { Prompt, Session } from './session';
import { mcpRequestTitle, resetTime } from './words';
import type { AskedQuestion, TerminalAsk, ToolDetail } from '../session';
import type { EngineCatalog } from './catalog';
import { heldAsks } from './run-words';
import type { HeldAsk } from './run-words';
import type { AgentRun, Run } from './run';

/*
 * What waits for you on a canvas (API Spec §5.9), derived from the run and the sessions, never
 * stored: the holds the run has for you (run/asks.ts), what each agent's session asks (its open
 * prompts), what each Terminal agent's CLI asks in its terminal, and the agents whose sessions
 * won't start, or run in a mode that never asks, while parties' messages to them wait. One
 * derivation (`needsOf`) for the canvas's
 * Needs you sidebar and the core's `needs`, which words each as a NeedsItem (`needsItem`), in the
 * host's locale. Until leads (B24), each is yours alone to answer: a token sees yours without
 * their choices or forms (`withoutChoices`).
 */

export interface NeedsInput {
  canvas: CanvasId;
  nodes: readonly CanvasNode[];
  run: Run;
  sessions: Readonly<Record<string, Session>>;
  catalog: EngineCatalog;
  /** The time now (epoch ms), for when a usage window resets: the clock's, when not given. */
  now?: number;
  /** The locale times of day are told in (the host's): the runtime's own, when none. */
  locale?: string;
  /**
   * The agents whose sessions would not start while parties' messages to them wait, why, and what
   * would let them (a sentence).
   */
  stuck?: readonly { agent: string; text: string; clears: string }[];
  /**
   * The agents that would act on parties' messages without asking while those wait, and why: their
   * sessions run in a mode that never asks, their CLIs default to one, or corrallm can't tell.
   */
  unasking?: readonly { agent: string; why: UnaskingWhy }[];
  /** Agents spending a backend whose hard limit was hit, until its reset. */
  limited?: readonly { agent: string; backend: string; until: number }[];
  /**
   * The generation of each agent's running session (the core's session manager gives each session
   * it starts a new one), which a prompt's id carries: a prompt of an earlier session whose native
   * id a later one reuses is another prompt. None: 0.
   */
  sessionGenerations?: (agent: string) => number | undefined;
}

/**
 * Why an agent would act on a party's message without asking: its session runs in a mode (or on
 * settings) that never asks; it would run in its CLI's own default, which never asks; or corrallm
 * can't tell what that default or the already-running session does.
 */
export type UnaskingWhy = 'mode' | 'default' | 'unknown' | 'unknown-running';

/** Something that waits for you, as derived: whose it is, and what it is. */
export type Need =
  | { kind: 'hold'; agent: AgentNode; ask: HeldAsk }
  | { kind: 'stuck'; agent: AgentNode; text: string; clears: string }
  | { kind: 'unasking'; agent: AgentNode; why: UnaskingWhy }
  | { kind: 'limited'; agent: AgentNode; backend: string; until: number }
  | { kind: 'prompt'; agent: AgentNode; prompt: Prompt }
  | { kind: 'ask'; agent: AgentNode; ask: TerminalAsk };

/** Why only you pick a hold's choice (Core Server rule R3), by what the hold is. */
const YOURS = {
  approve: 'Only you approve an OK.',
  usage: 'Only you decide to spend more of a usage window.',
  condition: 'Only you judge a condition.',
  switch: 'Only you switch how an agent runs.',
  always: 'Only you allow it always.',
};

/**
 * Everything that waits for you, in order: the run's holds, in graph order; then the agents whose
 * sessions won't start, or run in a mode that never asks, for parties' messages; then each agent's
 * open prompts; then what Terminal agents' CLIs ask in their terminals.
 */
export function needsOf({
  nodes,
  run,
  sessions,
  catalog,
  now,
  locale,
  stuck = [],
  unasking = [],
  limited = [],
}: NeedsInput): Need[] {
  const agents = nodes.filter((node): node is AgentNode => node.type === 'agent');
  const agent = (id: string) => agents.find((node) => node.id === id);
  return [
    ...heldAsks(nodes, run, catalog, now, locale).map((ask): Need => ({
      kind: 'hold',
      agent: ask.agent,
      ask,
    })),
    ...stuck.flatMap(({ agent: id, text, clears }): Need[] => {
      const found = agent(id);
      return found ? [{ kind: 'stuck', agent: found, text, clears }] : [];
    }),
    ...unasking.flatMap(({ agent: id, why }): Need[] => {
      const found = agent(id);
      return found ? [{ kind: 'unasking', agent: found, why }] : [];
    }),
    ...limited.flatMap(({ agent: id, backend, until }): Need[] => {
      const found = agent(id);
      return found ? [{ kind: 'limited', agent: found, backend, until }] : [];
    }),
    ...agents.flatMap((node) =>
      (sessions[node.id]?.prompts ?? sessions[node.id]?.entries.filter(isOpen) ?? []).map(
        (prompt): Need => ({ kind: 'prompt', agent: node, prompt }),
      ),
    ),
    ...agents.flatMap((node) =>
      (sessions[node.id]?.asking ?? []).map((ask): Need => ({ kind: 'ask', agent: node, ask })),
    ),
  ];
}

/** Everything that waits for you, each worded as a NeedsItem. */
export function needs(input: NeedsInput): NeedsItem[] {
  return needsOf(input).map((need) => needsItem(need, input));
}

/** A need as a NeedsItem, yours: addressed to you, answered by you. */
export function needsItem(
  need: Need,
  { canvas, nodes, run, catalog, now = Date.now(), locale, sessionGenerations }: NeedsInput,
): NeedsItem {
  const yours = { canvas, agent: need.agent.id, for: 'you' as const, by: ['you' as const] };
  switch (need.kind) {
    case 'hold': {
      const { ask, agent } = need;
      const usage = run.agents[agent.id]?.usage;
      const until = usage?.resetsAt;
      return {
        id: idOf('hold', agent.id, ask.item.id, holdGeneration(run.agents[agent.id])),
        ...yours,
        kind: 'hold',
        title: ask.text,
        ...(ask.detail === undefined ? {} : { detail: ask.detail }),
        ...(until === undefined || until === null ? {} : { until }),
        choices: ask.choices.map(({ key, label, title }): NeedChoice => {
          const humanOnly = holdChoiceYours(ask, key, usage !== undefined);
          return {
            value: key,
            label,
            ...(title === undefined ? {} : { description: title }),
            ...(humanOnly === undefined ? {} : { humanOnly }),
          };
        }),
        ...(ask.reply ? { text: { placeholder: ask.reply.label } } : {}),
        answerIn: 'api',
      };
    }
    case 'stuck':
      return {
        id: idOf('start', need.agent.id),
        ...yours,
        kind: 'hold',
        title: `${agentName(nodes, need.agent.id)} can’t start: ${need.text}`,
        detail: `Messages to it wait until it can. ${need.clears}`,
        choices: [],
        answerIn: 'api',
      };
    case 'unasking': {
      const name = agentName(nodes, need.agent.id);
      return {
        id: idOf('unasking', need.agent.id),
        ...yours,
        kind: 'hold',
        title:
          need.why === 'unknown-running'
            ? `corrallm can’t tell whether ${name}’s running session asks, so messages from other parties wait`
            : need.why === 'mode'
              ? `${name} runs without asking, so messages from other parties wait`
              : need.why === 'default'
                ? `${name}’s CLI defaults to a mode that never asks, so messages from other parties wait`
                : `corrallm can’t tell whether ${name}’s CLI defaults to a mode that asks, so messages from other parties wait`,
        detail:
          need.why === 'unknown-running'
            ? 'Check its terminal and switch it to a mode that asks, or enable its hooks if they are off.'
            : need.why === 'mode'
              ? 'They go once it runs in a mode that asks again.'
              : 'They go once it runs in a mode that asks: set it to start in one.',
        choices: [],
        answerIn: 'api',
      };
    }
    case 'limited':
      return {
        id: idOf('limited', need.agent.id),
        ...yours,
        kind: 'hold',
        title: `${agentName(nodes, need.agent.id)}’s ${catalog.backendName(need.backend)} usage is exhausted until ${resetTime(need.until, now, locale)}`,
        until: need.until,
        choices: [],
        answerIn: 'api',
      };
    case 'prompt':
      return {
        id: idOf(
          'prompt',
          need.agent.id,
          need.prompt.id,
          String(sessionGenerations?.(need.agent.id) ?? 0),
        ),
        ...yours,
        ...promptWords(need.prompt),
      };
    case 'ask':
      return {
        id: idOf(
          'prompt',
          need.agent.id,
          need.ask.id,
          String(sessionGenerations?.(need.agent.id) ?? 0),
        ),
        ...yours,
        ...askWords(need.ask),
        choices: [],
        answerIn: 'terminal',
      };
  }
}

/**
 * A Needs item's id, unique on its canvas: what it is (a run's hold, a session that won't start,
 * one that runs without asking, a prompt), its agent (escaped, so that a slash in an agent's id
 * never runs into what follows), for a hold or a prompt its generation (B11 Design §7: an answer
 * to an earlier one whose textual id is reused never answers the one asked now), and what of the
 * agent's it is (a queue item's id, a prompt's), last, as it may hold slashes.
 */
function idOf(
  kind: 'hold' | 'start' | 'unasking' | 'limited' | 'prompt',
  agent: string,
  of?: string,
  generation?: string,
): string {
  return [
    kind,
    encodeURIComponent(agent),
    ...(generation === undefined ? [] : [generation]),
    ...(of === undefined ? [] : [of]),
  ].join('/');
}

/**
 * The generation of the hold an agent's run is at (B11 Design §7), from what that hold is: its
 * item, its problem, its refusal, its usage window, the round it is on, how many changes were
 * asked of it, and the agent's attempts (each a UUID, so a hold reached again after any task ran
 * again, a retry or another run, is another). What only moves while it waits (a usage reading's
 * percent, a refusal's words) isn't in it. Hex of a 32-bit FNV-1a: stable across restarts.
 */
export function holdGeneration(at: AgentRun | undefined): string {
  if (at === undefined) return '0';
  const item = at.current;
  const fingerprint = JSON.stringify([
    item ?? null,
    at.problem === undefined
      ? null
      : [at.problem.kind, at.problem.reason, at.problem.agent, at.problem.conditionKey ?? null],
    at.refused === undefined
      ? null
      : [
          at.refused.agent,
          at.refused.connection,
          at.refused.switchTo ?? null,
          ...(at.refused.kind === undefined ? [] : [at.refused.kind]),
        ],
    at.usage === undefined ? null : [at.usage.backend, at.usage.window, at.usage.resetsAt],
    item === undefined ? null : [at.rounds?.[item]?.round ?? 0, at.rounds?.[item]?.more ?? 0],
    item === undefined ? 0 : (at.changes?.[item]?.length ?? 0),
    Object.entries(at.attempts ?? {})
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([task, attempts]) => [task, attempts.map(({ id }) => id)]),
  ]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < fingerprint.length; index += 1) {
    hash ^= fingerprint.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * An item of yours as a token sees it: what waits, without the choices only you may make, nor the
 * form only you fill in (an MCP server's link, often a sign-in's, among them: Core Server R3).
 */
export function withoutChoices(item: NeedsItem): NeedsItem {
  const seen: NeedsItem = { ...item, choices: [] };
  delete seen.text;
  delete seen.form;
  return seen;
}

/** Why only you may pick a hold's choice `key`, if only you may (`usage`: a usage rule's hold). */
function holdChoiceYours(ask: HeldAsk, key: string, usage: boolean): string | undefined {
  if (ask.problem) {
    return ask.problem.conditionKey !== undefined && (key === 'yes' || key === 'no')
      ? YOURS.condition
      : undefined;
  }
  if (ask.refusal) return key === 'switch' ? YOURS.switch : undefined;
  // Go on and Wait for the reset decide for every agent on the backend, until the window resets.
  if (usage) return key === 'goOn' || key === 'wait' ? YOURS.usage : undefined;
  return key === 'approve' ? YOURS.approve : undefined;
}

type Worded = Pick<
  NeedsItem,
  'kind' | 'title' | 'detail' | 'choices' | 'questions' | 'form' | 'answerIn'
>;

/** What an open prompt of an agent's session asks, in words, and how you may answer it. */
function promptWords(prompt: Prompt): Worded {
  switch (prompt.kind) {
    case 'permission':
      return {
        kind: 'prompt',
        title: prompt.title ?? approve(prompt.tool, prompt.summary),
        ...detailOf(prompt.detail),
        choices: [
          { value: 'once', label: 'Yes' },
          ...(prompt.always
            ? [{ value: 'always', label: prompt.always, humanOnly: YOURS.always }]
            : []),
          { value: 'deny', label: 'No' },
        ],
        answerIn: 'api',
      };
    case 'question':
      return {
        kind: 'prompt',
        ...questionWords(prompt.questions.filter((question) => question.answer === undefined)),
        choices: [],
        answerIn: 'api',
      };
    case 'plan':
      return {
        kind: 'prompt',
        title: 'Approve its plan?',
        ...previewLines(prompt.plan),
        choices: [],
        answerIn: 'api',
      };
    case 'elicitation':
      // The core's words, for everyone: the server's own may hold its link (B13 C11).
      return {
        kind: 'prompt',
        title: mcpRequestTitle(prompt.server, prompt.url !== undefined),
        ...(prompt.url === undefined ? {} : { form: { url: prompt.url } }),
        choices: [],
        answerIn: 'api',
      };
  }
}

/** What a Terminal agent's CLI asks in its terminal, in words. */
function askWords(ask: TerminalAsk): Pick<NeedsItem, 'kind' | 'title' | 'detail' | 'questions'> {
  switch (ask.kind) {
    case 'permission':
      return { kind: 'prompt', title: approve(ask.tool, ask.summary), ...detailOf(ask.detail) };
    case 'question':
      return { kind: 'prompt', ...questionWords(ask.questions) };
    case 'plan':
      return { kind: 'prompt', title: 'Approve its plan?', ...previewLines(ask.plan) };
    case 'trust':
      return { kind: 'prompt', title: 'Trust the project folder?' };
    case 'other':
      return { kind: 'prompt', title: ask.text };
  }
}

/** "Approve Bash: npm test?" */
function approve(tool: string, summary: string): string {
  return `Approve ${tool}${summary.trim() === '' ? '' : `: ${summary.trim()}`}?`;
}

/** Questions, titled by the first (or by how many there are), each with its answers. */
function questionWords(
  questions: readonly AskedQuestion[],
): Pick<NeedsItem, 'title' | 'questions'> {
  const [first] = questions;
  return {
    title: questions.length === 1 && first ? first.text : `${String(questions.length)} questions`,
    questions: questions.map(({ header, text, options, multiple }, index): NeedQuestion => ({
      id: String(index),
      header,
      text,
      options: options.map(({ label, description }) => ({
        label,
        ...(description === '' || description === label ? {} : { description }),
      })),
      multiple,
      other: true,
    })),
  };
}

/** What a tool call would do, in at most MAX_DETAIL_LINES lines: its diff, or its output. */
export function detailOf(detail: ToolDetail | undefined): Pick<NeedsItem, 'detail'> {
  if (!detail) return {};
  if (detail.kind === 'output') return previewLines(detail.text);
  const marks = { add: '+', remove: '-', same: ' ' } as const;
  return previewLines(detail.lines.map(({ kind, text }) => `${marks[kind]} ${text}`).join('\n'));
}

/** `text` in at most MAX_DETAIL_LINES lines, then how many more. */
export function previewLines(text: string): Pick<NeedsItem, 'detail'> {
  const all = text.trimEnd().split('\n');
  if (all.length === 1 && all[0]?.trim() === '') return {};
  const more = all.length - MAX_DETAIL_LINES;
  return {
    detail:
      more > 0
        ? `${all.slice(0, MAX_DETAIL_LINES).join('\n')}\n… ${String(more)} more line${more === 1 ? '' : 's'}`
        : all.join('\n'),
  };
}
