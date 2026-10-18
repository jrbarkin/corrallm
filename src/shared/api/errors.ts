/*
 * How an operation fails: one error, as a value on every transport (Core Server §3.1). core.call
 * never throws, so the code survives whatever carries it: a window's port, or MCP, where it is
 * `isError` with the sentence as its first text and `{ error }` as JSON its second.
 */

/**
 * invalid: the arguments don't fit the op. forbidden: the caller's party isn't in its audience.
 * human-only: only you may do it, in corrallm's window. not-found: no such thing, or nothing the
 * caller reaches. conflict: something changed or was settled first. refused: a rule or a limit
 * said no. unavailable: it can't be done now.
 */
export const ERROR_CODES = [
  'invalid',
  'forbidden',
  'human-only',
  'not-found',
  'conflict',
  'refused',
  'unavailable',
] as const;
export type OpErrorCode = (typeof ERROR_CODES)[number];

/** An operation's failure: its code, and one sentence saying why. */
export interface OpError {
  code: OpErrorCode;
  sentence: string;
}

/** What an operation answers: its result, or why it failed. */
export type OpResult<T> = { ok: true; value: T } | { ok: false; error: OpError };
