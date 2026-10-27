import { randomUUID } from 'node:crypto';

import type {
  CanUseTool,
  ElicitationResult,
  OnElicitation,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';

import type { AdapterPrompt, PromptAnswer, QuestionAnswer } from '../../../../shared/model/prompts';
import type { AskedQuestion, SessionAnswer, SessionEvent } from '../../../../shared/session';
import type { HostEvent, PromptAnswers } from '../../connector';
import {
  declined,
  elicitationPrompt,
  elicitationResult,
  permissionResult,
  toolPrompt,
} from './raise';
import type { Native, Raised } from './raise';
import type { Places } from './tools';
import { displayPath, property, proposedDetail, text, toolSummary } from './tools';

export { DENIED, DENIED_WITH_FEEDBACK } from './raise';

/*
 * What Claude Code asks through the Agent SDK (B13 C4): its canUseTool calls (a permission,
 * AskUserQuestion's questions, ExitPlanMode's plan) and MCP servers' requests (onElicitation: a
 * form, or a link to open), each raised to the core's prompt owner (a `prompt` event) under a key
 * minted fresh for that native request, never reused. raise.ts maps each to its prompt and its
 * answer to what the CLI is told.
 *
 * - Only the owner answers one (`answers.answer`, by its key: the native callback resolved at once,
 *   or a refusal that leaves it waiting) or declines it (`answers.decline`: the CLI's nonapproval,
 *   which never stops the turn). Nothing else resolves a native request but the CLI ending it
 *   (aborted: `prompt-ended`, withdrawn) or the session closing (every one still waiting gets its
 *   nonapproval, and ends).
 * - One corrallm can't pass on faithfully (questions it can't key, a form it can't show, a plan it
 *   can't read) is declined here, never raised, and the user told.
 * - Until X10 converts the renderer, each raised request is shown as the events B13 replaces too
 *   (`permission`, `question`, `plan`, `elicitation`, `withdrawn` and the session's waiting
 *   status), by the ids they had (a tool call's `<toolUseID>:prompt`, `elicitation:<uuid>`): unless
 *   the owner declined it as it was raised. Their answers never reach the CLI from here: `bridge`
 *   translates one into the prompt's own answer and names its key, for the core to answer it
 *   through the owner (X11 removes this).
 */

/** Where prompts go: the core's owner (prompt events), and the transcript (the events B13 replaces). */
export interface PromptHost {
  emit(event: HostEvent): void;
}

/** A native request waiting for its answer. */
interface Pending {
  readonly key: string;
  /** The id of the event B13 replaces that shows it. */
  readonly shown: string;
  readonly prompt: AdapterPrompt;
  readonly native: Native;
  /** Whether that event was shown (none if the owner declined it as it was raised). */
  visible: boolean;
  /** Tells the CLI: its callback resolved. */
  readonly settle: (result: PermissionResult | ElicitationResult) => void;
  /** What the CLI is told if it ends unanswered (aborted, or the session closed). */
  readonly unanswered: PermissionResult | ElicitationResult;
}

/** What the CLI is told for a request no one answered: no, without stopping the turn. */
const UNANSWERED: PermissionResult = { behavior: 'deny', message: 'The user did not answer.' };

export class Prompts {
  readonly #host: PromptHost;
  readonly #places: Places;
  readonly #modes: readonly string[];
  /** Every request waiting, by its key, in the order raised. */
  readonly #pending = new Map<string, Pending>();

  /** `modes`: those the session offers, by corrallm's names (a plan goes into auto only if listed). */
  constructor(host: PromptHost, places: Places, modes: readonly string[]) {
    this.#host = host;
    this.#places = places;
    this.#modes = modes;
  }

  /** Whether any request waits for an answer. */
  get waiting(): boolean {
    return this.#pending.size > 0;
  }

  /** How the core answers and declines what this session raised, by key. */
  readonly answers: PromptAnswers = {
    answer: (key, answer) => {
      const pending = this.#pending.get(key);
      if (pending === undefined) throw new Error('That request is no longer asked.');
      // What the CLI is told, checked first: one that doesn't fit throws, and it still waits.
      const result =
        pending.native.kind === 'form' || pending.native.kind === 'link'
          ? elicitationResult(pending.native, answer)
          : permissionResult(pending.native, answer);
      this.#pending.delete(key);
      pending.settle(result);
      this.#settled();
    },
    decline: (key, why) => {
      const pending = this.#pending.get(key);
      if (pending === undefined) return;
      this.#pending.delete(key);
      pending.settle(declined(pending.native, why));
      if (pending.visible) {
        this.#host.emit({ type: 'withdrawn', id: pending.shown });
        this.#settled();
      }
    },
  };

  /** The SDK's canUseTool: raised, and the CLI told what the owner's accepted answer says. */
  readonly canUseTool: CanUseTool = (tool, input, options) => {
    const raised = toolPrompt(tool, input, options, {
      places: this.#places,
      modes: this.#modes,
    });
    const shown = `${options.toolUseID}:prompt`;
    return this.#raise(
      raised,
      options.signal,
      (prompt) => shownTool(shown, tool, input, options, prompt, this.#places),
      UNANSWERED,
      (why) => ({ behavior: 'deny', message: why }),
    ) as Promise<PermissionResult>;
  };

  /** The SDK's onElicitation: an MCP server asks for a form, or to open a link. */
  readonly onElicitation: OnElicitation = (request, { signal }) => {
    const shown = `elicitation:${randomUUID()}`;
    return this.#raise(
      elicitationPrompt(request),
      signal,
      (prompt, native) => shownForm(shown, prompt, native),
      { action: 'cancel' },
      () => ({ action: 'decline' }),
    ) as Promise<ElicitationResult>;
  };

  /**
   * Transitional (B13 C4, until X10 converts the renderer; X11 removes it): the key of the request
   * the event B13 replaces `id` shows, and `answer` as its prompt takes it, for the core to answer
   * through its owner. Answers nothing itself. Throws for one no longer asked, or an answer its
   * prompt doesn't offer.
   */
  bridge(id: string, answer: SessionAnswer): { key: string; answer: PromptAnswer } {
    const pending = [...this.#pending.values()].findLast((one) => one.shown === id);
    if (pending === undefined) throw new Error('That request is no longer asked.');
    return { key: pending.key, answer: translated(pending.prompt, answer) };
  }

  /** As the session closes: every request still waiting gets its nonapproval, and ends. */
  withdrawAll(): void {
    for (const [key, pending] of [...this.#pending]) {
      this.#pending.delete(key);
      pending.settle(pending.unanswered);
      this.#host.emit({ type: 'prompt-ended', key, reason: 'withdrawn' });
    }
  }

  /**
   * Raises a request to the owner under a fresh key and waits for what the CLI is told: declined
   * at once (the user told) if corrallm can't pass it on faithfully.
   */
  #raise(
    raised: Raised,
    signal: AbortSignal,
    show: (prompt: AdapterPrompt, native: Native) => SessionEvent & { id: string },
    unanswered: PermissionResult | ElicitationResult,
    refuse: (why: string) => PermissionResult | ElicitationResult,
  ): Promise<PermissionResult | ElicitationResult> {
    return new Promise((resolve) => {
      if ('declined' in raised) {
        this.#host.emit({
          type: 'notice',
          id: randomUUID(),
          level: 'warning',
          text: raised.declined,
        });
        resolve(refuse(raised.declined));
        return;
      }
      if (signal.aborted) {
        resolve(unanswered);
        return;
      }
      const key = randomUUID();
      const { prompt, native } = raised;
      const shown = show(prompt, native);
      this.#pending.set(key, {
        key,
        shown: shown.id,
        prompt,
        native,
        visible: false,
        settle: resolve,
        unanswered,
      });
      signal.addEventListener(
        'abort',
        () => {
          this.#ended(key);
        },
        { once: true },
      );
      this.#host.emit({ type: 'prompt', key, prompt });
      // The owner may decline it as it is raised: then it is never shown.
      const pending = this.#pending.get(key);
      if (pending === undefined) return;
      pending.visible = true;
      this.#host.emit(shown);
      this.#host.emit({ type: 'status', status: 'waiting' });
    });
  }

  /** The CLI stopped waiting (the turn was interrupted): it ends, unanswered. */
  #ended(key: string): void {
    const pending = this.#pending.get(key);
    if (pending === undefined) return;
    this.#pending.delete(key);
    pending.settle(pending.unanswered);
    this.#host.emit({ type: 'prompt-ended', key, reason: 'withdrawn' });
    if (pending.visible) {
      this.#host.emit({ type: 'withdrawn', id: pending.shown });
      this.#settled();
    }
  }

  /** A request no longer waits: the session works again once none does. */
  #settled(): void {
    if (this.#pending.size === 0) this.#host.emit({ type: 'status', status: 'working' });
  }
}

/** A permission request as the event B13 replaces showed it (until X10). */
function shownTool(
  id: string,
  tool: string,
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2],
  prompt: AdapterPrompt,
  places: Places,
): SessionEvent & { id: string } {
  switch (prompt.kind) {
    case 'question':
      return {
        type: 'question',
        id,
        questions: askedQuestions(property(input, 'questions')) ?? [],
      };
    case 'plan':
      return { type: 'plan', id, plan: prompt.plan };
    default: {
      const detail = proposedDetail(tool, input);
      const title =
        options.title ??
        (options.blockedPath === undefined
          ? undefined
          : `Claude wants to access ${displayPath(options.blockedPath, places)}`);
      return {
        type: 'permission',
        id,
        tool,
        summary: toolSummary(tool, input, places),
        always:
          prompt.kind === 'approval'
            ? (prompt.choices.find(({ value }) => value === 'always')?.label ?? null)
            : null,
        ...(detail === undefined ? {} : { detail }),
        ...(title === undefined ? {} : { title }),
      };
    }
  }
}

/** An MCP server's request as the event B13 replaces showed it, in the prompt's words (until X10). */
function shownForm(
  id: string,
  prompt: AdapterPrompt,
  native: Native,
): SessionEvent & { id: string } {
  if (prompt.kind !== 'form') throw new Error('Not a form.');
  return {
    type: 'elicitation',
    id,
    server: prompt.server ?? '',
    message: prompt.title,
    ...('url' in prompt.form
      ? { url: prompt.form.url }
      : { fields: native.kind === 'form' ? [...native.fields] : [] }),
  };
}

/** An answer given as the events B13 replaces take it, as the prompt takes it; throws if it can't be. */
function translated(prompt: AdapterPrompt, answer: SessionAnswer): PromptAnswer {
  const offers = (value: string) =>
    (prompt.kind === 'approval' || prompt.kind === 'plan') &&
    prompt.choices.some((choice) => choice.value === value);
  switch (answer.kind) {
    case 'permission': {
      if (prompt.kind !== 'approval') break;
      if (answer.answer === 'once') return { kind: 'choice', value: 'allow' };
      if (answer.answer === 'always') {
        if (!offers('always')) throw new Error('That prompt doesn’t offer "always".');
        return { kind: 'choice', value: 'always' };
      }
      const feedback = answer.feedback?.trim() ?? '';
      return feedback === ''
        ? { kind: 'choice', value: 'deny' }
        : { kind: 'choice', value: 'deny-feedback', feedback };
    }
    case 'question': {
      if (prompt.kind !== 'question') break;
      if (answer.answers.length !== prompt.questions.length)
        throw new Error('Answer every question it asks.');
      const answers: Record<string, QuestionAnswer> = {};
      prompt.questions.forEach((question, index) => {
        const given = answer.answers[index] ?? '';
        answers[question.id] = question.options.some(({ label }) => label === given)
          ? { picked: [given] }
          : { text: given };
      });
      return { kind: 'questions', answers };
    }
    case 'plan': {
      if (prompt.kind !== 'plan') break;
      if (answer.answer.approve) {
        const { mode } = answer.answer;
        if (!offers(mode)) throw new Error(`That plan doesn’t offer ${mode}.`);
        return { kind: 'choice', value: mode };
      }
      const feedback = answer.answer.feedback.trim();
      return {
        kind: 'choice',
        value: 'keep-planning',
        ...(feedback === '' ? {} : { feedback }),
      };
    }
    case 'elicitation':
      if (prompt.kind !== 'form') break;
      return {
        kind: 'form',
        action: answer.action,
        ...(answer.values === undefined ? {} : { values: answer.values }),
      };
  }
  throw new Error('That answer isn’t one this request takes.');
}

/** AskUserQuestion's questions, as corrallm asks them; undefined if they are not what it expects. */
export function askedQuestions(value: unknown): AskedQuestion[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const questions = value.map((item): AskedQuestion | undefined => {
    const asked = text(property(item, 'question'));
    const options = property(item, 'options');
    if (asked === undefined || !Array.isArray(options)) return undefined;
    return {
      header: text(property(item, 'header')) ?? '',
      text: asked,
      options: options.flatMap((option) => {
        const label = text(property(option, 'label'));
        return label === undefined
          ? []
          : [{ label, description: text(property(option, 'description')) ?? '' }];
      }),
      multiple: property(item, 'multiSelect') === true,
    };
  });
  return questions.every((q) => q !== undefined) ? questions : undefined;
}
