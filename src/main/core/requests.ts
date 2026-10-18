import type { OpResult } from '../../shared/api/errors';

/*
 * Repeated requests (Core Server §5.4): a write may carry a `request` id, and the same caller's
 * repeat of it gets the first call's result instead of running again, so an MCP client's retry, or
 * a window's double dispatch, applies nothing twice. A result is kept only when its op came to it
 * by itself: a call cancelled (its caller left, a preempting op stopped it) or broken by what
 * nobody expected leaves nothing a retry can count on, so its repeat runs again, once the call
 * before it is done. Each caller keeps its own recent requests, so none pushes out another's.
 */

/** How many of a caller's recent requests are kept. */
export const REMEMBERED_REQUESTS = 100;
/** How many callers' requests are kept: those that called least recently are forgotten first. */
const REMEMBERED_CALLERS = 100;

/** A call's result, and whether a repeat of its request gets it too. */
export interface Attempt {
  result: OpResult<unknown>;
  kept: boolean;
}

export class Requests {
  /** Each caller's recent requests, by its key, the most recent caller last. */
  readonly #byCaller = new Map<string, Map<string, Promise<Attempt>>>();

  /**
   * Returns the result `caller`'s first call of `request` kept, or else runs it: after that call
   * is done, if it is still running.
   */
  async remembered(
    caller: string,
    request: string,
    run: () => Promise<Attempt>,
  ): Promise<OpResult<unknown>> {
    const requests = this.#requestsOf(caller);
    const before = requests.get(request);
    const attempt = before ? before.then((first) => (first.kept ? first : run())) : run();
    requests.delete(request);
    requests.set(request, attempt);
    const oldest = requests.size > REMEMBERED_REQUESTS ? requests.keys().next().value : undefined;
    if (oldest !== undefined) requests.delete(oldest);
    const { result, kept } = await attempt;
    if (!kept && requests.get(request) === attempt) {
      requests.delete(request);
      if (requests.size === 0 && this.#byCaller.get(caller) === requests) {
        this.#byCaller.delete(caller);
      }
    }
    return result;
  }

  /** `caller`'s requests, made its most recent caller. */
  #requestsOf(caller: string): Map<string, Promise<Attempt>> {
    const requests = this.#byCaller.get(caller) ?? new Map<string, Promise<Attempt>>();
    this.#byCaller.delete(caller);
    this.#byCaller.set(caller, requests);
    const oldest =
      this.#byCaller.size > REMEMBERED_CALLERS ? this.#byCaller.keys().next().value : undefined;
    if (oldest !== undefined) this.#byCaller.delete(oldest);
    return requests;
  }
}
