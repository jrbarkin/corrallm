import { randomUUID } from 'node:crypto';

import type { AdapterPrompt } from '../../../../shared/model/prompts';
import type { HostEvent, PromptAnswers } from '../../connector';
import { notice } from '../../transcript';
import type { Places } from '../../transcript';
import { RPC_ERRORS, RpcFailure } from '../rpc';
import type { RequestId } from '../rpc';
import { nativeResult, nonapproval, raised as raise } from './raise';
import type { Native, Raised } from './raise';
import type { McpCall, Patch } from './translate';

/*
 * What Codex asks through its app server's requests (B13 C5): to run a command or reach a host,
 * to send input to a running command, to apply a patch, for more permissions, its questions
 * (request_user_input), an MCP server's elicitations (an MCP tool call's approval among them), and
 * the session's own asks (implementing a plan, consent to use the ChatGPT plan: session.ts). Each
 * is raised to the core's prompt owner (a `prompt` event) under a key minted fresh for that
 * request, never reused, and kept privately with its typed JSON-RPC id. raise.ts maps each to its
 * prompt and its answer to what Codex is told.
 *
 * - Only the owner answers one (`answers.answer`, by its key: the request's response sent at once,
 *   or a refusal that leaves it waiting) or declines it (`answers.decline`: Codex's nonapproval).
 *   Nothing else answers Codex but its stopping waiting (serverRequest/resolved: the prompt ends,
 *   withdrawn, and the request still gets its nonapproval) or the session closing (every request
 *   still waiting gets its nonapproval, and ends). Every request is answered.
 * - One corrallm can't pass on faithfully (questions it can't key, a form it can't show, an MCP
 *   tool call's approval whose call it can't tell) is declined here, never raised, and the user
 *   told.
 * - Prompts reach the renderer only through the owner's transcript entries.
 */

/** Where prompts go, and what the session knows that they show. */
export interface PromptHost {
  emit(event: HostEvent): void;
  /** A request of Codex's no longer waits on the user, and none other does: the session works on. */
  settled(): void;
  /** A file change's patch, from its item (which came first). */
  patch(itemId: string): Patch | undefined;
  /** An MCP tool call still running, by its item's id. */
  mcpCall(itemId: string): McpCall | undefined;
  /** Every MCP tool call still running. */
  mcpCalls(): readonly McpCall[];
}

/** A request waiting for its answer. */
interface Pending {
  readonly key: string;
  /** Codex's request, by its typed JSON-RPC id (`1` is not `"1"`); none for the session's own. */
  readonly request: RequestId | undefined;
  readonly prompt: AdapterPrompt;
  readonly native: Native;
  /** Whether the owner kept the raise (false if it declined it as it was raised). */
  admitted: boolean;
  /** Answers it: Codex's response, or the session's own answer (undefined: it ended unanswered). */
  readonly settle: (result: unknown) => void;
}

/** One of the session's own asks, raised: its key, and its answer as raise.ts gives it. */
export interface Asked {
  /** None if it was declined as it was raised. */
  key: string | undefined;
  /** Undefined if it ended unanswered (withdrawn, declined, or the session closed). */
  answered: Promise<unknown>;
}

export class Prompts {
  readonly #host: PromptHost;
  readonly #places: Places;
  /** Every request waiting, by its key, in the order raised. */
  readonly #pending = new Map<string, Pending>();

  constructor(host: PromptHost, places: Places) {
    this.#host = host;
    this.#places = places;
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
      // What Codex is told, checked first: one that doesn't fit throws, and it still waits.
      const result = nativeResult(pending.native, answer);
      this.#pending.delete(key);
      pending.settle(result);
      this.#settled(pending);
    },
    decline: (key) => {
      const pending = this.#pending.get(key);
      if (pending === undefined) return;
      this.#pending.delete(key);
      pending.settle(nonapproval(pending.native));
      if (pending.admitted) {
        this.#settled(pending);
      }
    },
  };

  /** Answers a request the app server made: raised, if it is one corrallm asks the user. */
  readonly request = (method: string, params: unknown, id: RequestId): Promise<unknown> => {
    if (method === 'currentTime/read')
      return Promise.resolve({ currentTimeAt: Math.floor(Date.now() / 1000) });
    const asked = raise(method, params, {
      places: this.#places,
      patch: (itemId) => this.#host.patch(itemId),
      mcpCall: (itemId) => this.#host.mcpCall(itemId),
      mcpCalls: () => this.#host.mcpCalls(),
    });
    if (asked === undefined)
      return Promise.reject(
        new RpcFailure(RPC_ERRORS.methodNotFound, `corrallm does not handle ${method}`),
      );
    return this.#raise(asked, id).answered;
  };

  /** One of the session's own asks (raise.ts' implementPrompt, consentPrompt), raised. */
  ask(asked: Raised): Asked {
    return this.#raise(asked, undefined);
  }

  /**
   * One of the session's own asks ends unanswered, by the session's word (its turn interrupted):
   * withdrawn.
   */
  withdraw(key: string): void {
    const pending = this.#pending.get(key);
    if (pending === undefined) return;
    this.#end(pending);
  }

  /** Codex stopped waiting for request `id` (answered elsewhere, or its turn ended): withdrawn. */
  resolved(id: RequestId): void {
    for (const pending of [...this.#pending.values()]) {
      if (pending.request !== id) continue;
      this.#end(pending);
      this.#settled(pending);
    }
  }

  /** As the session closes: every request still waiting gets its nonapproval, and ends. */
  withdrawAll(): void {
    for (const [key, pending] of [...this.#pending]) {
      this.#pending.delete(key);
      pending.settle(nonapproval(pending.native));
      this.#host.emit({ type: 'prompt-ended', key, reason: 'withdrawn' });
    }
  }

  /**
   * Raises a request to the owner under a fresh key: declined at once (the user told) if corrallm
   * can't pass it on faithfully. The owner may decline it as it is raised: then it is never shown.
   */
  #raise(asked: Raised, request: RequestId | undefined): Asked {
    if ('declined' in asked) {
      this.#host.emit(notice('warning', asked.declined));
      return { key: undefined, answered: Promise.resolve(asked.result) };
    }
    const { prompt, native } = asked;
    const key = randomUUID();
    let settle: (result: unknown) => void = () => undefined;
    const answered = new Promise<unknown>((resolve) => {
      settle = resolve;
    });
    this.#pending.set(key, { key, request, prompt, native, admitted: false, settle });
    this.#host.emit({ type: 'prompt', key, prompt });
    const pending = this.#pending.get(key);
    if (pending !== undefined) {
      pending.admitted = true;
      this.#host.emit({ type: 'status', status: 'waiting' });
    }
    return { key, answered };
  }

  /** It ends unanswered: Codex gets its nonapproval, the owner hears. */
  #end(pending: Pending): void {
    this.#pending.delete(pending.key);
    pending.settle(nonapproval(pending.native));
    this.#host.emit({ type: 'prompt-ended', key: pending.key, reason: 'withdrawn' });
  }

  /** A request of Codex's no longer waits: the session works again once none does. */
  #settled(pending: Pending): void {
    if (pending.request !== undefined && this.#pending.size === 0) this.#host.settled();
  }
}
