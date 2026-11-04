import type { CanvasId } from '../../shared/canvas';
import { imageRefusal } from '../../shared/images';
import { holdGeneration, needs } from '../../shared/model/needs-selectors';
import type { Answer as RunAnswer } from './engine/run/runner';
import type { PartyId } from '../../shared/model/messages';
import type { NeedsItem } from '../../shared/model/needs';
import type { PromptReader } from '../../shared/model/prompt-views';
import type { PromptOwner } from './prompts/owner';
import { OpFailure } from './call';
import type { OpContext } from './call';
import { decided, decidedOf } from './decisions';
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
 *   handed to the session that raised it (C3). The handler delegates only to that owner.
 * - No record holds what was answered: no words, values, answers or feedback (a secret is never
 *   written), only what kind of answer it was. A prompt's is worded as the owner words one
 *   (decisions.ts' decisionWords: B13 §9.2 C9), from its kind, what was chosen and the agent's name,
 *   never its tool's input, its plan's mode, its server or anything else the CLI said.
 */

export interface RunRepliesDeps {
  engines: Pick<Engines, 'canvas'>;
  /** The core's prompt owner (B13 C3), whose prompts the prompt handler answers through it. */
  prompts?: Pick<PromptOwner, 'current' | 'settled' | 'fits' | 'answer'>;
  /** The locale holds are worded in. */
  locale?: string;
}

/** A hold's id, read back: its agent, generation and item. */
interface HoldId {
  agent: string;
  generation: string;
  item: string;
}

/** The choices of a hold whose words go with them: Retry a problem, or One more round. */
const WITH_WORDS = new Set(['retry', 'more']);

/** The handlers of run holds (and the holds that ask nothing), and of session prompts. */
export function runReplies({ engines, prompts: owner, locale }: RunRepliesDeps): ReplyHandler[] {
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
   * Settled already: a conflict naming who settled it, if a record of it is kept; and, to you, how
   * (its record's words). A token is told a prompt's settler alone (B13 C11).
   */
  const settled = (
    canvas: CanvasId,
    to: string,
    reader: PromptReader = 'you',
  ): OpFailure | undefined => {
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
      // B16 C3: words' images only where the agent they go to now takes them: none decided else.
      if ('text' in answer && answer.images !== undefined && answer.images.length > 0) {
        const to = at?.problem?.agent ?? id.agent;
        const node = open.document.nodes.find((one) => one.id === to);
        const connection =
          node?.type === 'agent' ? open.engine.catalog.connectionOf(node.data) : undefined;
        const refusal = imageRefusal(
          answer.images,
          open.engine.catalog.images(connection),
          `${nameOf(open.document.nodes, to)}’s connection`,
        );
        if (refusal !== undefined) throw new OpFailure('refused', refusal);
      }
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

  const prompts: ReplyHandler = {
    prefixes: ['prompt'],
    current: (canvas, to) => owner?.current(canvas, to),
    gone: (canvas, to, reader) => owner?.settled(canvas, to, reader),
    fits: (item, answer) => owner?.fits(item.canvas, item.id, answer),
    act: (canvas, item, answer, ctx) => {
      if (owner === undefined) throw new OpFailure('not-found', `${item.id} isn’t open any more.`);
      return owner.answer(canvas, item.id, answer, ctx);
    },
  };

  return [holds, prompts];
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

/** An agent's id, as an id escaped it: none if it doesn't unescape. */
function unescaped(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
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
