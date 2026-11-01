import { MAX_DETAIL_LINES } from '../api/limits';
import type { CanvasId } from '../canvas';
import type { PartyId } from './messages';
import type { NeedChoice, NeedQuestion, NeedsItem } from './needs';
import { detailOf, previewLines } from './needs-selectors';
import type { CoreChoice, Prompt, PromptNeedView } from './prompts';
import type { Entry, OpenPromptEntry, SettledPromptEntry } from './session';
import type { EntryView } from './views';
import { mcpRequestTitle } from './words';

/*
 * What each reader sees of a prompt (B13 Design §9.2 C11): the one selector every read boundary
 * reads a prompt through — `needs` and `status`' items, `session.transcript` and the session
 * topic, the counts `agents` and the summaries give, conflict and error wording, notices and
 * `wait` — so that no boundary, and no summary, is a second way to anything another leaves out.
 *
 * Two readers: you, and a token that reaches the prompt's agent (or a parent, for its team's
 * prompts, through Needs alone). A token that doesn't reach it reads nothing of it; each boundary's
 * reach decides that, before anything here. Field by field:
 *
 * - Its id, kind, agent, `for`, `by`, where it is answered, when it was raised, whether it was cut
 *   and why only you may answer it: everyone's.
 * - Its title, summary, reason and detail preview: everyone's, except a form's, whose title is the
 *   core's words for everyone in Needs (an MCP server's own may hold its link) and whose summary,
 *   reason and detail no token sees; and a terminal's wait its CLI's report alone describes, whose
 *   detail is what its screen shows, yours alone (a token never reads a terminal).
 * - Its subject, plan and questions (with which are secret): everyone's; never an answer.
 * - Its choices (value, label, hint, effects, feedback, whether only you may pick it), the core's
 *   own Not waiting among them: yours alone, until B24's grants say which a lead may pick.
 * - A form's schema and link: yours alone.
 * - How it ended (its live outcome): yours whole; a token's, its type and who settled it.
 * - Its adapter's key, its signals, native ids, callbacks and image bytes: never in a prompt here.
 *
 * Every reader's text is the agent's or its server's words, which a view renders as escaped text,
 * never as instructions.
 *
 * Keep this module free of Node, Electron and DOM imports: it is compiled into every process.
 */

/** Who reads a prompt: you, or a token that reaches its agent (or a parent, its team's). */
export type PromptReader = 'you' | 'token';

/** A prompt the core's prompt owner holds, as this selector reads it. */
export interface PromptOccurrence {
  readonly canvas: CanvasId;
  /** Its Needs item's id: `prompt/<escaped agent>/<generation>/<PromptId>`. */
  readonly need: string;
  readonly prompt: Prompt;
  /** Its agent's name now, for the core's own words. */
  readonly name: string;
  /** The core's stand-in for a terminal's wait it couldn't show whole (B13 C6). */
  readonly standIn: boolean;
}

/** B13 C7's Not waiting: the core's own choice on a terminal's wait its report alone describes. */
export const NOT_WAITING = 'not-waiting';
export const NOT_WAITING_CHOICE: NeedChoice = {
  value: NOT_WAITING,
  label: 'Not waiting',
  humanOnly: 'Only you can tell, from its terminal, that its CLI isn’t waiting for you.',
};

/**
 * Whether a prompt is a terminal's wait raised from its CLI's report alone (B13 C7): no subject,
 * choice, question or plan (no hook described it, and it isn't the trust screen), and not the
 * core's stand-in for one it couldn't show (which a hook may have described). What detail it has
 * is its screen's.
 */
export function undescribed(prompt: Prompt, standIn: boolean): boolean {
  if (standIn || prompt.answerIn !== 'terminal') return false;
  switch (prompt.kind) {
    case 'approval':
      return prompt.subject === undefined && prompt.choices.length === 0;
    case 'question':
      return prompt.questions.length === 0;
    case 'plan':
    case 'form':
      return false;
  }
}

/** A prompt's Needs item, as `reader` sees it. */
export function promptNeed(occurrence: PromptOccurrence, reader: PromptReader): NeedsItem {
  const { prompt } = occurrence;
  const yours = reader === 'you';
  const shown = !undescribed(prompt, occurrence.standIn) || yours;
  const base: NeedsItem = {
    id: occurrence.need,
    canvas: occurrence.canvas,
    agent: prompt.agent,
    kind: 'prompt',
    for: 'you',
    by: ['you'],
    answerIn: prompt.answerIn,
    title: needTitle(occurrence),
    choices: yours ? choicesOf(occurrence) : [],
    prompt: needView(occurrence, reader),
  };
  switch (prompt.kind) {
    case 'approval':
      return { ...base, ...(shown ? detailOf(prompt.detail) : {}) };
    case 'plan':
      return { ...base, ...previewLines(prompt.plan) };
    case 'question':
      return {
        ...base,
        ...(shown ? detailOf(prompt.detail) : {}),
        questions: prompt.questions.map(questionOf),
      };
    case 'form':
      // The server's own words may hold its link: no detail, for everyone.
      return { ...base, ...(yours ? { form: prompt.form } : {}) };
  }
}

/**
 * A prompt whole, as `reader` sees it: what the agent window's card shows, from the agent's
 * session topic and transcript, where B13 C9 places it (`entryFor`). You: every field, with each
 * choice as Needs offers it (Not waiting where offered). A token: no choice, no form's schema,
 * link or words (the core's title alone), no terminal's screen; its plan and subject whole.
 */
export function promptFor(occurrence: SeenOccurrence, reader: PromptReader): PromptView {
  const { prompt } = occurrence;
  if (reader === 'you') return { ...prompt, choices: choicesOf(occurrence) };
  if (prompt.kind === 'form') {
    return {
      id: prompt.id,
      agent: prompt.agent,
      raised: prompt.raised,
      kind: 'form',
      title: needTitle(occurrence),
      answerIn: prompt.answerIn,
      ...(prompt.cut === true ? { cut: true } : {}),
      ...(prompt.humanOnly === undefined ? {} : { humanOnly: prompt.humanOnly }),
      choices: [],
    };
  }
  const seen = { ...prompt, choices: [] };
  if (undescribed(prompt, occurrence.standIn)) delete seen.detail;
  return seen;
}

/** What `promptFor` and `settledPrompt` read of an occurrence: not its canvas. */
export type SeenOccurrence = Omit<PromptOccurrence, 'canvas'>;

/**
 * What stays of a prompt once it ends (B13 C9), for every reader alike: its id, kind, agent, when
 * it was raised, where it was answered, its Needs title (a form's in the core's words) and whether
 * it was cut. Nothing of a command, plan, question, form, screen or choice: what was decided is
 * its live outcome's, and B19's records' after that.
 */
export function settledPrompt(occurrence: SeenOccurrence): SettledPromptView {
  const { prompt } = occurrence;
  return {
    id: prompt.id,
    kind: prompt.kind,
    agent: prompt.agent,
    raised: prompt.raised,
    answerIn: prompt.answerIn,
    title: needTitle(occurrence),
    ...(prompt.cut === true ? { cut: true } : {}),
  };
}

/** A prompt in short, once it ended (settledPrompt). */
export interface SettledPromptView {
  readonly id: Prompt['id'];
  readonly kind: Prompt['kind'];
  readonly agent: string;
  readonly raised: number;
  readonly answerIn: Prompt['answerIn'];
  readonly title: string;
  readonly cut?: true;
}

/**
 * A prompt the core's owner holds as an entry of its agent's transcript reads (B13 C9): while it
 * waits, the prompt whole as the reader sees it; once it ended, in short, with how it ended as the
 * reader sees that. `cut`: a page cut it to fit (the whole is on the session topic, for you).
 */
export type PromptEntryView =
  | { id: string; kind: 'prompt'; need: string; prompt: PromptView; cut?: true }
  | {
      id: string;
      kind: 'prompt';
      need: string;
      prompt: SettledPromptView;
      outcome: LiveOutcome;
      cut?: true;
    };

/**
 * What the core's prompt owner places in an agent's transcript (B13 C9): a prompt as it is raised,
 * by its PromptId; or how it ended, settled in place.
 */
export type PromptEntryChange =
  | { type: 'raised'; entry: OpenPromptEntry }
  | { type: 'ended'; id: string; prompt: SettledPromptView; outcome: LiveOutcome };

/** A prompt whole, as a reader sees it (promptFor). */
export type PromptView =
  | (Omit<Extract<Prompt, { kind: 'approval' | 'plan' | 'question' }>, 'choices'> & {
      choices: NeedChoice[];
    })
  | (Omit<FormPrompt, 'form'> & { form?: FormPrompt['form']; choices: NeedChoice[] });
type FormPrompt = Extract<Prompt, { kind: 'form' }>;

/**
 * How a prompt ended, or how it was answered (B13 C3): a choice, answers, a form's action, by whom;
 * withdrawn; answered in its terminal; or said not to be waiting (dismissed). Never a label, words
 * or values (a secret answer says only that it was secret).
 */
export type LiveOutcome =
  | { type: 'choice'; value?: string; hint?: CoreChoice['hint']; by: PartyId }
  | { type: 'answers'; count?: number; secret?: true; by: PartyId }
  | { type: 'form'; action?: 'accept' | 'decline' | 'cancel'; by: PartyId }
  | { type: 'withdrawn' }
  | { type: 'answered-in-terminal'; by: 'terminal' }
  | { type: 'dismissed'; by: PartyId };

/** A prompt's live outcome as `reader` sees it: yours whole, a token's its type and by whom. */
export function outcomeFor(outcome: LiveOutcome, reader: PromptReader): LiveOutcome {
  if (reader === 'you') return outcome;
  switch (outcome.type) {
    case 'choice':
    case 'answers':
    case 'form':
      return { type: outcome.type, by: outcome.by };
    case 'withdrawn':
    case 'answered-in-terminal':
    case 'dismissed':
      return outcome;
  }
}

/**
 * Any item of yours that waits, already worded (a hold of the run, a prompt of the events B13
 * replaces, a proposal, a review), as `reader` sees it: a token's has no choices, no words to give,
 * no form, and a form prompt's own words left out. A prompt the core's owner holds is worded for
 * each reader by `promptNeed`, which reads what this can't (a terminal's screen).
 */
export function needFor(item: NeedsItem, reader: PromptReader): NeedsItem {
  if (reader === 'you') return item;
  const seen: NeedsItem = { ...item, choices: [] };
  delete seen.text;
  delete seen.form;
  if (seen.prompt?.kind === 'form') {
    const view = { ...seen.prompt };
    delete view.summary;
    delete view.reason;
    seen.prompt = view;
  }
  return seen;
}

/**
 * An entry of a transcript (the events B13 replaces, until X11), as `reader` sees it: a message's
 * pasted images only counted. A token's prompt entry has no answer (a question's, a permission's,
 * a plan's or a form's), no feedback and no "always" choice's label; an MCP server's request
 * only the core's words, never its message, form or link. Native user turns made from a prompt
 * answer retain their provenance internally: a token sees only that a prompt was answered.
 * Whether it was withdrawn is everyone's.
 */
export function entryFor(entry: Entry, reader: PromptReader): EntryView {
  switch (entry.kind) {
    case 'user': {
      const { images, promptReply, ...rest } = entry;
      const seen =
        promptReply && reader === 'token' ? { ...rest, text: 'The user answered a prompt.' } : rest;
      return images === undefined || images.length === 0
        ? seen
        : { ...seen, images: images.length };
    }
    case 'permission': {
      if (reader === 'you') return entry;
      const seen = { ...entry };
      delete seen.always;
      delete seen.answer;
      delete seen.feedback;
      return seen;
    }
    case 'question':
      return reader === 'you'
        ? entry
        : {
            ...entry,
            questions: entry.questions.map((question) => {
              const seen = { ...question };
              delete seen.answer;
              return seen;
            }),
          };
    case 'plan': {
      if (reader === 'you') return entry;
      const seen = { ...entry };
      delete seen.answer;
      return seen;
    }
    case 'elicitation': {
      if (reader === 'you') return entry;
      const seen = { ...entry, message: mcpRequestTitle(entry.server, entry.url !== undefined) };
      delete seen.url;
      delete seen.fields;
      delete seen.answer;
      return seen;
    }
    case 'prompt':
      return promptEntryFor(entry, reader);
    default:
      return entry;
  }
}

/**
 * A prompt the core's owner holds, as an entry of its agent's transcript, as `reader` sees it (B13
 * C9 through C11's selector): while it waits, `promptFor`'s; once it ended, in short, with how it
 * ended as `outcomeFor` gives it. Never its agent's name as raised, nor whether it is a stand-in:
 * those are what the core words it from.
 */
export function promptEntryFor(
  entry: OpenPromptEntry | SettledPromptEntry,
  reader: PromptReader,
): PromptEntryView {
  const { id, need } = entry;
  if (entry.outcome === undefined) {
    return {
      id,
      kind: 'prompt',
      need,
      prompt: promptFor(
        { need, prompt: entry.prompt, name: entry.name, standIn: entry.standIn === true },
        reader,
      ),
    };
  }
  return {
    id,
    kind: 'prompt',
    need,
    prompt: entry.prompt,
    outcome: outcomeFor(entry.outcome, reader),
  };
}

/**
 * A prompt's title in Needs, for every reader: its own, but a form's, which is the core's words
 * (the MCP server that asks, by the name it is configured under, else its agent's CLI, asks you to
 * fill in a form or to open a link).
 */
function needTitle({ prompt, name }: SeenOccurrence): string {
  if (prompt.kind !== 'form') return prompt.title;
  const link = 'url' in prompt.form;
  return prompt.server === undefined
    ? `${name}’s CLI asks you to ${link ? 'open a link' : 'fill in a form'}`
    : mcpRequestTitle(prompt.server, link);
}

/**
 * A prompt's own fields beyond the generic ones, as `reader` sees them: a token's form has no
 * summary or reason; a plan is given as its first MAX_DETAIL_LINES lines.
 */
function needView({ prompt }: PromptOccurrence, reader: PromptReader): PromptNeedView {
  const words = prompt.kind !== 'form' || reader === 'you';
  const envelope = {
    id: prompt.id,
    raised: prompt.raised,
    ...(words && prompt.summary !== undefined ? { summary: prompt.summary } : {}),
    ...(words && prompt.reason !== undefined ? { reason: prompt.reason } : {}),
    ...(prompt.cut === true ? { cut: true as const } : {}),
    ...(prompt.humanOnly === undefined ? {} : { humanOnly: prompt.humanOnly }),
  };
  switch (prompt.kind) {
    case 'approval':
      return {
        ...envelope,
        kind: 'approval',
        ...(prompt.subject === undefined ? {} : { subject: prompt.subject }),
      };
    case 'plan':
      return {
        ...envelope,
        kind: 'plan',
        plan: prompt.plan.split('\n').slice(0, MAX_DETAIL_LINES).join('\n'),
      };
    case 'question':
      return { ...envelope, kind: 'question' };
    case 'form':
      return {
        ...envelope,
        kind: 'form',
        ...(prompt.server === undefined ? {} : { server: prompt.server }),
      };
  }
}

/**
 * A prompt's choices, as you may make them: each as its adapter offered it, marked where only you
 * may pick it (every one of a prompt only you may answer, for the router's check too), then the
 * core's own Not waiting where it is offered.
 */
function choicesOf({ prompt, standIn }: SeenOccurrence): NeedChoice[] {
  const own = undescribed(prompt, standIn) ? [NOT_WAITING_CHOICE] : [];
  if (prompt.kind !== 'approval' && prompt.kind !== 'plan') return own;
  return [
    ...prompt.choices.map((choice): NeedChoice => {
      const why = choice.humanOnly ?? prompt.humanOnly;
      return {
        value: choice.value,
        label: choice.label,
        ...(choice.description === undefined ? {} : { description: choice.description }),
        hint: choice.hint,
        ...(choice.effects === undefined ? {} : { effects: choice.effects }),
        ...(choice.feedback === undefined ? {} : { feedback: choice.feedback }),
        ...(choice.endsTurn === undefined ? {} : { endsTurn: choice.endsTurn }),
        ...(why === undefined ? {} : { humanOnly: why }),
      };
    }),
    ...own,
  ];
}

/** A prompt's question as Needs gives it: whole, never an answer. */
function questionOf({
  id,
  header,
  text,
  options,
  multiple,
  other,
  secret,
}: Extract<Prompt, { kind: 'question' }>['questions'][number]): NeedQuestion {
  return {
    id,
    header,
    text,
    options: options.map(({ label, description, preview }) => ({
      label,
      ...(description === undefined ? {} : { description }),
      ...(preview === undefined ? {} : { preview }),
    })),
    multiple,
    other,
    ...(secret === undefined ? {} : { secret }),
  };
}
