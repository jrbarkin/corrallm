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

/**
 * What a call still going says when its outside token is replaced or expires meanwhile (`refused`):
 * the one refusal that means the token itself, as a request that brings no token, or a wrong one,
 * is answered 401 before any op runs. `corrallm wait` tells it apart by these words.
 */
export const TOKEN_REPLACED =
  'This token was replaced or expired: call with the token its maker has now (corrallm serve --new-token).';

/**
 * What a token's `wait` is refused with (`refused`) while it has as many going as it may
 * (TOKEN_WAITS): a refusal that passes, which `corrallm wait` tells apart by these words.
 */
export const TOO_MANY_WAITS = 'Too many waits at once; let one end first.';
