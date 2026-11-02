import { randomUUID } from 'node:crypto';

import type {
  CanUseTool,
  ElicitationResult,
  OnElicitation,
  PermissionResult,
} from '@anthropic-ai/claude-agent-sdk';

import type { AdapterPrompt } from '../../../../shared/model/prompts';
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
 * - Prompts reach the renderer only through the owner's transcript entries.
 */

/** Where prompts go: the core's owner (prompt events) and session status. */
export interface PromptHost {
  emit(event: HostEvent): void;
}

/** A native request waiting for its answer. */
interface Pending {
  readonly key: string;
  readonly prompt: AdapterPrompt;
  readonly native: Native;
  /** Whether the owner kept the raise (false if it declined it as it was raised). */
  admitted: boolean;
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
      if (pending.admitted) {
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
    return this.#raise(raised, options.signal, UNANSWERED, (why) => ({
      behavior: 'deny',
      message: why,
    })) as Promise<PermissionResult>;
  };

  /** The SDK's onElicitation: an MCP server asks for a form, or to open a link. */
  readonly onElicitation: OnElicitation = (request, { signal }) => {
    return this.#raise(elicitationPrompt(request), signal, { action: 'cancel' }, () => ({
      action: 'decline',
    })) as Promise<ElicitationResult>;
  };

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
      this.#pending.set(key, {
        key,
        prompt,
        native,
        admitted: false,
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
      pending.admitted = true;
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
    if (pending.admitted) {
      this.#settled();
    }
  }

  /** A request no longer waits: the session works again once none does. */
  #settled(): void {
    if (this.#pending.size === 0) this.#host.emit({ type: 'status', status: 'working' });
  }
}
