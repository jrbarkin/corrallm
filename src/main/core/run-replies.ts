import type { CanvasId } from '../../shared/canvas';
import { holdGeneration, needs } from '../../shared/model/needs-selectors';
import type { Answer as RunAnswer } from './engine/run/runner';
import type { PartyId } from '../../shared/model/messages';
import type { NeedsItem } from '../../shared/model/needs';
import { isOpen } from '../../shared/model/session';
import type { Prompt } from '../../shared/model/session';
import type { PromptAnswer, PromptReplyAnswer } from '../../shared/model/prompts';
import type { PromptReader } from '../../shared/model/prompt-views';
import { MAX_CANVAS_PROMPTS } from '../../shared/api/limits';
import type { SessionAnswer } from '../../shared/session';
import type { SessionManager } from '../sessions/manager';
import type { PromptOwner } from './prompts/owner';
import { OpFailure } from './call';
import type { OpContext } from './call';
import {
  decided,
  decidedOf,
  decisionWords,
  deciding,
  landed,
  withdrawnDecision,
} from './decisions';
import type { Engines, OpenCanvas } from './engines';
import { needsInput } from './engines';
import { nameOf, partyText, pausesText, RELEASES } from './parties';
import { fitsChoices, picked, said } from './replies';
import type { Answer, ReplyHandler, ReplyResult } from './replies';

/*
 * The reply router's handlers for what a canvas's runtime asks (B11 Design §7, C7): a run's holds
 * (an OK, a repeat out of rounds, a task's problem, a condition for your yes or no, a usage rule's
 * question, a session that wouldn't start) and its agents' sessions' prompts (a permission, their
 * questions, a plan, an MCP server's request). Both are yours alone until B24 (`by: ['you']`).
 *
 * - The generation an id carries is checked first (the router asks `gone`): a hold asked again since
 *   (its changes asked for, a retry, another run: needs.ts' holdGeneration) or a prompt of another
 *   session (the session manager's generation) is a conflict, never answered for the one waiting.
 * - A hold a pause holds isn't answered (R9's sticky pauses): it waits, as the run does, until that
 *   pause is released, by whoever may release it; no answer releases one.
 * - A hold's answer is decided at once (RunStore.decide), its who-decided record (decisions.ts)
 *   written in the same write as the run it changed.
 * - A refusal's Switch runs Continue in Terminal's own service (`session.continueIn`, through
 *   ctx.call as the same caller: yours alone, D9, whoever may answer the hold), with no input; the
 *   run then sends the held attempt itself, once, as its session starts on the other connection.
 * - A prompt a session raised through B13's protocol (`prompt` events) is the core's prompt owner's
 *   (prompts/owner.ts): found by its PromptId in the canvas's live index, never by its id's text,
 *   checked against the prompt as raised, reserved, recorded as being made, checked again, then
 *   handed to the session that raised it (C3). The handler asks the owner first.
 * - A prompt of the events B13 replaces whose session raised it to the owner too (an adapter
 *   converted to B13's protocol whose consumers aren't yet: B13 C4, until X10 converts the
 *   renderer; X11 removes this) is answered through the owner: its session translates the answer
 *   and names the prompt's key (`SessionManager.bridge`), and the owner answers the prompt that
 *   key names, as above; then the old event is shown answered. A later reply to it is told who
 *   settled it.
 * - Any other prompt of the events B13 replaces (`permission`, `question`, `plan`, `elicitation`,
 *   until their adapters convert: C5, C6) goes to its CLI first, awaited, recorded as being made
 *   before it is told, and told only if the session that asked it still runs (a later one asking
 *   by the same native id asks another prompt): the prompt is shown answered only once the CLI
 *   took it; one the CLI refused still waits, its record withdrawn. A crash in between leaves the
 *   record unresolved, never answered again.
 * - No record holds what was answered: no words, values, answers or feedback (a secret is never
 *   written), only what kind of answer it was. A prompt's is worded as the owner words one
 *   (decisions.ts' decisionWords: B13 §9.2 C9), from its kind, what was chosen and the agent's name,
 *   never its tool's input, its plan's mode, its server or anything else the CLI said.
 */

export interface RunRepliesDeps {
  engines: Pick<Engines, 'canvas'>;
  sessions: Pick<SessionManager, 'answer' | 'generationOf'> &
    Partial<Pick<SessionManager, 'bridge'>>;
  /** The core's prompt owner (B13 C3), whose prompts the prompt handler answers through it. */
  prompts?: Pick<PromptOwner, 'owns' | 'current' | 'settled' | 'fits' | 'answer'> &
    Partial<Pick<PromptOwner, 'keyed'>>;
  /** The locale holds are worded in. */
  locale?: string;
}

/** A hold's id, read back: its agent, generation and item. */
interface HoldId {
  agent: string;
  generation: string;
  item: string;
}

/** A prompt's id, read back: its agent, its session's generation, and the prompt. */
interface PromptId {
  agent: string;
  generation: string;
  prompt: string;
}

/** The choices of a hold whose words go with them: Retry a problem, or One more round. */
const WITH_WORDS = new Set(['retry', 'more']);

/** The handlers of run holds (and the holds that ask nothing), and of session prompts. */
export function runReplies({
  engines,
  sessions,
  prompts: owner,
  locale,
}: RunRepliesDeps): ReplyHandler[] {
  /** What waits on a canvas the core runs, as derived now. */
  const items = (canvas: CanvasId): readonly NeedsItem[] => {
    const open = engines.canvas(canvas);
    return open === undefined ? [] : needs(needsInput(open, locale));
  };
  const openOf = (canvas: CanvasId): OpenCanvas => {
    const open = engines.canvas(canvas);
    if (open === undefined) {
      throw new OpFailure('unavailable', 'That canvas isn’t open in corrallm.');
    }
    return open;
  };
  /**
   * The owner's NeedId each old event's item was answered through, by canvas, then by that item's
   * id (the newest MAX_CANVAS_PROMPTS a canvas), so a later reply is told who settled it (B13 C4,
   * until X11).
   */
  const bridged = new Map<CanvasId, Map<string, string>>();
  /**
   * Settled already: a conflict naming who settled it, if a record of it is kept; and, to you, how
   * (its record's words). A token is told a prompt's settler alone (B13 C11).
   */
  const settled = (
    canvas: CanvasId,
    to: string,
    reader: PromptReader = 'you',
  ): OpFailure | undefined => {
    const through = bridged.get(canvas)?.get(to);
    if (through !== undefined && owner !== undefined) {
      return owner.settled(canvas, through, reader);
    }
    const open = engines.canvas(canvas);
    const record = open === undefined ? undefined : decidedOf(open.messages, to);
    if (record === undefined || open === undefined) return undefined;
    return new OpFailure(
      'conflict',
      reader === 'you'
        ? `${to} is settled already: ${record.body}`
        : `${to} is settled already: ${partyText(open.document.nodes, record.by ?? 'you')} answered it.`,
    );
  };

  const holds: ReplyHandler = {
    prefixes: ['hold', 'start', 'unasking', 'limited'],
    current: (canvas, to) => items(canvas).find((item) => item.id === to),
    gone: (canvas, to) => {
      const id = holdOf(to);
      const open = engines.canvas(canvas);
      if (id !== undefined && open !== undefined) {
        const { run } = open.engine;
        const snapshot = run.snapshot();
        const at = snapshot.agents[id.agent];
        if (at?.status === 'asking' && at.current === id.item) {
          const name = nameOf(open.document.nodes, id.agent);
          // R9: a reply never releases a pause; what it holds waits until the pause goes.
          const holding = run.holding({ agent: id.agent });
          if (at.paused === true && holding.length > 0) {
            return new OpFailure(
              'refused',
              `${name} is paused by ${pausesText(open.document.nodes, id.agent, holding)}: what it asks waits until that is released (${RELEASES})`,
            );
          }
          if (!snapshot.running) {
            return new OpFailure(
              'unavailable',
              `The run isn’t going: ${name}’s question waits until it is resumed.`,
            );
          }
          if (holdGeneration(at) !== id.generation) {
            return new OpFailure(
              'conflict',
              `${name} has asked again since: answer what it asks now, not ${to}.`,
            );
          }
        }
      }
      return settled(canvas, to);
    },
    fits: (item, answer) => {
      if ('choice' in answer && 'text' in answer && answer.text !== undefined) {
        if (!WITH_WORDS.has(answer.choice)) {
          return `${item.id} takes no words with "${answer.choice}".`;
        }
        if (item.text === undefined) return `${item.id} takes no answer in words.`;
        if (!item.choices.some(({ value }) => value === answer.choice)) {
          return fitsChoices(item, { choice: answer.choice });
        }
        return said(answer.text) ? undefined : 'Say what to try, in words.';
      }
      if ('text' in answer && answer.text !== undefined && !said(answer.text)) {
        return 'Say what should change, in words.';
      }
      return fitsChoices(item, answer);
    },
    act: async (canvas, item, answer, ctx) => {
      const id = holdOf(item.id);
      if (id === undefined) throw new OpFailure('not-found', `${item.id} isn’t a hold.`);
      const open = openOf(canvas);
      const { run } = open.engine;
      const at = run.snapshot().agents[id.agent];
      if (picked(answer) === 'switch') return switched(open, item, id, ctx);
      const before = holdGeneration(at);
      const given: RunAnswer =
        'text' in answer && answer.text !== undefined
          ? {
              reply: answer.text,
              ...(answer.images === undefined ? {} : { images: answer.images }),
            }
          : { choice: picked(answer) ?? '' };
      ctx.noReturn();
      // Stamped with who decided: a token never starts afresh a run another party decided in (R9).
      run.decide(id.agent, id.item, given, ctx.by);
      const after = run.snapshot().agents[id.agent];
      if (
        after?.status === 'asking' &&
        after.current === id.item &&
        holdGeneration(after) === before
      ) {
        throw new OpFailure('conflict', `${item.id} doesn’t take that answer now.`);
      }
      return recorded(open, item, ctx.by, `${chose(item, answer)}.`);
    },
  };

  /**
   * A refusal's Switch: the agent whose session wouldn't start runs on the connection offered,
   * through Continue in Terminal's service as the same caller (D9 decides: yours alone), with no
   * input; the run sends the held attempt there itself, once.
   */
  const switched = async (
    open: OpenCanvas,
    item: NeedsItem,
    id: HoldId,
    ctx: OpContext,
  ): Promise<ReplyResult> => {
    const refused = open.engine.run.snapshot().agents[id.agent]?.refused;
    const connection = refused?.switchTo;
    if (refused === undefined || connection === undefined) {
      throw new OpFailure('invalid', `${item.id} offers no connection to switch to.`);
    }
    const canvas = open.document.id;
    const switchedTo = () => {
      const node = open.document.nodes.find((one) => one.id === refused.agent);
      return node?.type === 'agent' && open.engine.catalog.connectionOf(node.data) === connection;
    };
    try {
      await ctx.call('session.continueIn', { canvas, agent: refused.agent, connection });
    } catch (error) {
      // Switched, but its session didn't start: the switch is still yours, and recorded.
      if (switchedTo())
        await recorded(open, item, ctx.by, switchWords(open, refused.agent, connection));
      throw error;
    }
    return recorded(open, item, ctx.by, switchWords(open, refused.agent, connection));
  };

  const switchWords = (open: OpenCanvas, agent: string, connection: string): string =>
    `switched ${nameOf(open.document.nodes, agent)} to ${open.engine.catalog.connectionLabel(connection) ?? connection}: its held task goes on there.`;

  /** Records who decided, in the write that holds what it changed: its record's id. */
  const recorded = async (
    open: OpenCanvas,
    item: NeedsItem,
    by: PartyId,
    what: string,
  ): Promise<ReplyResult> => {
    const record = decided(open.messages, {
      need: item.id,
      by,
      words: `${who(open, by)} ${what.replace(/[.\s]+$/, '')}.`,
    });
    try {
      await open.messages.durable();
    } catch {
      throw new OpFailure(
        'unavailable',
        'It is done, but it couldn’t be saved, so it may not survive a restart.',
      );
    }
    return { id: record.id, outcome: 'answered' };
  };

  /**
   * Where an old event's prompt is answered through the owner (B13 C4, until X11): the NeedId of
   * the owner's prompt its session raised for it, and `given` as that prompt takes it. None where
   * its session shows no such twin (it answers the old events itself).
   */
  const throughOwner = (
    canvas: CanvasId,
    item: NeedsItem,
    id: PromptId,
    given: SessionAnswer,
  ): { need: string; reply: PromptReplyAnswer } | undefined => {
    if (owner?.keyed === undefined || sessions.bridge === undefined) return undefined;
    let bridged: ReturnType<NonNullable<typeof sessions.bridge>>;
    try {
      bridged = sessions.bridge(canvas, id.agent, id.prompt, given);
    } catch (error) {
      throw new OpFailure(
        'invalid',
        `${item.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (bridged === undefined) return undefined;
    const name = nameOf(engines.canvas(canvas)?.document.nodes ?? [], id.agent);
    if (String(bridged.generation) !== id.generation) {
      throw new OpFailure(
        'conflict',
        `${name}’s session has started again since: answer what it asks now, not ${item.id}.`,
      );
    }
    const need = owner.keyed(canvas, id.agent, bridged.generation, bridged.key);
    if (need === undefined) throw new OpFailure('conflict', `${item.id} isn’t open any more.`);
    return { need, reply: replyOf(bridged.answer) };
  };

  /** The prompts of the events B13 replaces, answered as B11 C7 built them. */
  const legacy: ReplyHandler = {
    prefixes: ['prompt'],
    current: (canvas, to) => items(canvas).find((item) => item.id === to),
    gone: (canvas, to, reader) => {
      const id = promptOf(to);
      const open = engines.canvas(canvas);
      if (id !== undefined && open !== undefined) {
        const asked = items(canvas).find(
          (item) =>
            item.kind === 'prompt' &&
            item.agent === id.agent &&
            promptOf(item.id)?.prompt === id.prompt,
        );
        if (asked !== undefined) {
          return new OpFailure(
            'conflict',
            `${nameOf(open.document.nodes, id.agent)}’s session has started again since: answer what it asks now (${asked.id}), not ${to}.`,
          );
        }
      }
      return settled(canvas, to, reader);
    },
    fits: (item, answer) => {
      if (item.answerIn === 'terminal') {
        return `${item.title} is asked in its agent’s terminal: answer it there.`;
      }
      const prompt = promptEntry(engines, item);
      if (prompt === undefined) return `${item.id} isn’t open any more.`;
      switch (prompt.kind) {
        case 'permission':
          if ('permission' in answer) {
            return item.choices.some(({ value }) => value === answer.permission)
              ? undefined
              : `${item.id} doesn’t offer "${answer.permission}".`;
          }
          if ('choice' in answer && (!('text' in answer) || answer.text === undefined))
            return fitsChoices(item, answer);
          return `${item.id} takes a permission: "once", "deny"${prompt.always ? ' or "always"' : ''}.`;
        case 'question':
          return 'answers' in answer ? undefined : `${item.id} takes answers to its questions.`;
        case 'plan':
          return 'plan' in answer
            ? undefined
            : `${item.id} takes a plan’s approval or what to revise.`;
        case 'elicitation':
          return 'form' in answer ? undefined : `${item.id} takes a form’s answer.`;
      }
    },
    act: async (canvas, item, answer, ctx) => {
      const open = openOf(canvas);
      const id = promptOf(item.id);
      const prompt = promptEntry(engines, item);
      if (id === undefined || prompt === undefined) {
        throw new OpFailure('not-found', `${item.id} isn’t open any more.`);
      }
      const given = sessionAnswer(item, prompt, answer);
      const name = nameOf(open.document.nodes, id.agent);
      // One its session raised to the owner too is answered through the owner (B13 C4, until X11).
      const through = throughOwner(canvas, item, id, given);
      if (through !== undefined && owner !== undefined) {
        const result = await owner.answer(canvas, through.need, through.reply, ctx);
        const answered = bridged.get(canvas) ?? new Map<string, string>();
        bridged.set(canvas, answered);
        answered.set(item.id, through.need);
        for (const oldest of answered.keys()) {
          if (answered.size <= MAX_CANVAS_PROMPTS) break;
          answered.delete(oldest);
        }
        open.engine.sessions.answered(id.agent, prompt.id, given);
        return result;
      }
      // Recorded as being made, on disk, before the CLI is told anything.
      const record = deciding(open.messages, {
        need: item.id,
        by: ctx.by,
        words: `${who(open, ctx.by)} ${answered(name, prompt, given)}.`,
      });
      try {
        await open.messages.durable();
      } catch {
        withdrawnDecision(open.messages, record.id, 'It couldn’t be recorded');
        throw new OpFailure(
          'unavailable',
          'The answer couldn’t be recorded, so it wasn’t given: try again.',
        );
      }
      // Still the session that asked it, now that the record is on disk: one started since (a
      // resumed conversation asking again, by the same native id) asks another prompt, never
      // answered with this one's answer. Nothing is awaited from here until its CLI is told.
      if (String(sessions.generationOf(canvas, id.agent) ?? 0) !== id.generation) {
        withdrawnDecision(open.messages, record.id, `${name}’s session started again first`);
        await open.messages.durable().catch(() => undefined);
        throw new OpFailure(
          'conflict',
          `${name}’s session has started again since: answer what it asks now, not ${item.id}.`,
        );
      }
      ctx.noReturn();
      try {
        await sessions.answer(canvas, id.agent, prompt.id, given);
      } catch (error) {
        withdrawnDecision(open.messages, record.id, `${name}’s CLI didn’t take this answer`);
        await open.messages.durable().catch(() => undefined);
        throw new OpFailure(
          'unavailable',
          `${name}’s CLI didn’t take the answer, so its prompt still waits for one: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      open.engine.sessions.answered(id.agent, prompt.id, given);
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
    },
  };

  /**
   * Every prompt: the owner's first (B13 C3), by its PromptId in the live index; else one of the
   * events B13 replaces. One the owner raised and ended is the owner's to say how it ended, never
   * answered as one of the old events.
   */
  const prompts: ReplyHandler = {
    prefixes: ['prompt'],
    current: (canvas, to) => owner?.current(canvas, to) ?? legacy.current(canvas, to),
    gone: (canvas, to, reader) =>
      owner?.settled(canvas, to, reader) ?? legacy.gone?.(canvas, to, reader),
    fits: (item, answer) =>
      owner?.owns(item.canvas, item.id) === true
        ? owner.fits(item.canvas, item.id, answer)
        : legacy.fits?.(item, answer),
    act: (canvas, item, answer, ctx) =>
      owner !== undefined &&
      (owner.owns(canvas, item.id) || promptEntry(engines, item) === undefined)
        ? owner.answer(canvas, item.id, answer, ctx)
        : legacy.act(canvas, item, answer, ctx),
  };

  return [holds, prompts];
}

/** A session's answer as `reply` gives it to the owner, which checks it again. */
function replyOf(answer: PromptAnswer): PromptReplyAnswer {
  switch (answer.kind) {
    case 'choice':
      return {
        choice: answer.value,
        ...(answer.feedback === undefined ? {} : { feedback: answer.feedback }),
      };
    case 'questions':
      return { answers: answer.answers };
    case 'form':
      return {
        form: {
          action: answer.action,
          ...(answer.values === undefined ? {} : { values: answer.values }),
        },
      };
  }
}

/** A hold's id read back (`hold/<agent>/<generation>/<item>`): none if it isn't one. */
function holdOf(id: string): HoldId | undefined {
  const [kind, agent, generation, ...item] = id.split('/');
  if (kind !== 'hold' || agent === undefined || generation === undefined || item.length === 0) {
    return undefined;
  }
  const named = unescaped(agent);
  return named === undefined ? undefined : { agent: named, generation, item: item.join('/') };
}

/** A prompt's id read back (`prompt/<agent>/<generation>/<prompt>`): none if it isn't one. */
function promptOf(id: string): PromptId | undefined {
  const [kind, agent, generation, ...prompt] = id.split('/');
  if (kind !== 'prompt' || agent === undefined || generation === undefined || prompt.length === 0) {
    return undefined;
  }
  const named = unescaped(agent);
  return named === undefined ? undefined : { agent: named, generation, prompt: prompt.join('/') };
}

/** An agent's id, as an id escaped it: none if it doesn't unescape. */
function unescaped(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/** The prompt entry a prompt item names, open now: none if it isn't. */
function promptEntry(engines: Pick<Engines, 'canvas'>, item: NeedsItem): Prompt | undefined {
  const id = promptOf(item.id);
  const open = engines.canvas(item.canvas);
  if (id === undefined || open === undefined) return undefined;
  const session = open.engine.sessions.of(id.agent);
  const prompts = session.prompts ?? session.entries.filter(isOpen);
  return prompts.find((one) => one.id === id.prompt && isOpen(one));
}

/** A typed answer as the CLI is told it, checked against the prompt: throws, saying why, if it doesn't fit. */
function sessionAnswer(item: NeedsItem, prompt: Prompt, answer: Answer): SessionAnswer {
  switch (prompt.kind) {
    case 'permission': {
      const chosen = 'permission' in answer ? answer.permission : picked(answer);
      if (chosen !== 'once' && chosen !== 'always' && chosen !== 'deny') {
        throw new OpFailure('invalid', `${item.id} takes "once", "always" or "deny".`);
      }
      if (chosen === 'always' && !prompt.always) {
        throw new OpFailure('invalid', `${item.id} doesn’t offer "always".`);
      }
      const feedback = 'permission' in answer ? answer.feedback : undefined;
      return {
        kind: 'permission',
        answer: chosen,
        ...(feedback === undefined || !said(feedback) ? {} : { feedback }),
      };
    }
    case 'question': {
      if (!('answers' in answer)) throw new OpFailure('invalid', `${item.id} takes answers.`);
      // The questions still unanswered, by the ids the item gave them, in order.
      const unanswered = prompt.questions.flatMap((question, index) =>
        question.answer === undefined ? [index] : [],
      );
      const known = new Set(unanswered.map((_index, at) => String(at)));
      const unknown = Object.keys(answer.answers).find((key) => !known.has(key));
      if (unknown !== undefined) {
        throw new OpFailure('invalid', `${item.id} asks no question ${unknown}.`);
      }
      const answers = prompt.questions.map((question, index) => {
        if (question.answer !== undefined) return question.answer;
        const given = answer.answers[String(unanswered.indexOf(index))];
        if (given === undefined) {
          throw new OpFailure('invalid', `Answer every question ${item.id} asks.`);
        }
        if (typeof given !== 'string' && !Array.isArray(given)) {
          throw new OpFailure('invalid', `Answer ${item.id} using its question card.`);
        }
        const text = Array.isArray(given) ? given.join(', ') : given;
        if (!said(text)) throw new OpFailure('invalid', `Answer every question ${item.id} asks.`);
        if (Array.isArray(given) && !question.multiple && given.length > 1) {
          throw new OpFailure('invalid', `${question.header} takes one answer.`);
        }
        return text;
      });
      return { kind: 'question', answers };
    }
    case 'plan': {
      if (!('plan' in answer)) throw new OpFailure('invalid', `${item.id} takes a plan’s answer.`);
      const { plan } = answer;
      if (!plan.approve && !said(plan.feedback)) {
        throw new OpFailure('invalid', 'Say what to revise, in words.');
      }
      return { kind: 'plan', answer: plan };
    }
    case 'elicitation': {
      if (!('form' in answer)) throw new OpFailure('invalid', `${item.id} takes a form’s answer.`);
      const { action, values } = answer.form;
      if (values !== undefined && action !== 'accept') {
        throw new OpFailure('invalid', 'Only an accepted form carries values.');
      }
      if (values !== undefined) {
        if (prompt.url !== undefined || prompt.fields === undefined) {
          throw new OpFailure('invalid', `${item.id} asks for no values: it is a link to open.`);
        }
        const names = new Set(prompt.fields.map(({ name }) => name));
        const unknown = Object.keys(values).find((key) => !names.has(key));
        if (unknown !== undefined) {
          throw new OpFailure('invalid', `${item.id}’s form has no field ${unknown}.`);
        }
      }
      if (action === 'accept' && prompt.fields !== undefined) {
        const missing = prompt.fields.find(
          ({ name, required }) => required && values?.[name] === undefined,
        );
        if (missing !== undefined) {
          throw new OpFailure('invalid', `${missing.label} is required.`);
        }
      }
      return {
        kind: 'elicitation',
        action,
        ...(values === undefined ? {} : { values: values }),
      };
    }
  }
}

/** Who decided, as a record names them: You, or the party. */
function who(open: OpenCanvas, by: PartyId): string {
  if (by === 'you') return 'You';
  const text = partyText(open.document.nodes, by);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What a hold's answer chose, in words, never the words given: "answered Planner’s …: Approve". */
function chose(item: NeedsItem, answer: Answer): string {
  const label =
    'text' in answer && answer.text !== undefined
      ? 'choice' in answer
        ? `${item.choices.find(({ value }) => value === answer.choice)?.label ?? answer.choice}, in your own words`
        : 'in your own words'
      : (item.choices.find(({ value }) => value === picked(answer))?.label ?? picked(answer));
  return `answered “${item.title}”: ${String(label)}`;
}

/**
 * What a prompt's answer was, in the core's words (decisionWords, B13 §9.2 C9): a permission as a
 * tool call allowed once or from now on, or refused; a plan approved or kept planning; questions
 * answered; a form accepted, declined or cancelled. Never its tool's input, its mode, its server,
 * the words or the values given.
 */
function answered(name: string, prompt: Prompt, given: SessionAnswer): string {
  switch (given.kind) {
    case 'permission':
      return decisionWords(name, {
        prompt: { kind: 'approval', subject: 'tool' },
        outcome: {
          type: 'choice',
          value: given.answer,
          hint:
            given.answer === 'once'
              ? 'allow_once'
              : given.answer === 'always'
                ? 'allow_always'
                : 'reject_once',
        },
      });
    case 'question':
      return decisionWords(name, {
        prompt: { kind: 'question' },
        outcome: { type: 'answers', count: Math.max(given.answers.length, 1) },
      });
    case 'plan':
      return decisionWords(name, {
        prompt: { kind: 'plan' },
        outcome: {
          type: 'choice',
          value: given.answer.approve ? 'approve' : 'revise',
          hint: given.answer.approve ? 'allow_once' : 'reject_once',
        },
      });
    case 'elicitation':
      return decisionWords(
        name,
        { prompt: { kind: 'form' }, outcome: { type: 'form', action: given.action } },
        prompt.kind === 'elicitation' && prompt.url !== undefined,
      );
  }
}
