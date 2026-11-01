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

/** What an entity of a canvas's document is now: its revision (0: there is none) and its row. */
export interface Current {
  rev: number;
  value: unknown;
}

/**
 * An operation's failure: its code, and one sentence saying why; for a conflict over entities a
 * doc op expected at other revisions, what each of those is now, by its key.
 */
export interface OpError {
  code: OpErrorCode;
  sentence: string;
  current?: Readonly<Record<string, Current>>;
}

/** What an operation answers: its result, or why it failed. */
export type OpResult<T> = { ok: true; value: T } | { ok: false; error: OpError };

/**
 * What a call still going says when its outside token is replaced, revoked or expires meanwhile
 * (`refused`): the one refusal that means the token itself, as a request that brings no token, or
 * a wrong one, is answered 401 before any op runs; the next request of a token its server knew
 * (renewed away, revoked, expired) is answered 401 with these words. `corrallm wait` tells it
 * apart by them.
 */
export const TOKEN_REPLACED =
  'This token was replaced, revoked or expired: call with the token its maker has now (corrallm token renew).';

/**
 * What a call of one of corrallm's own agents is refused with (`refused`) once the session
 * generation its credential was issued for has ended (restarted, closed, switched, its agent
 * deleted): the credential works only for that generation's life.
 */
export const SESSION_ENDED = 'This session has ended; its credential no longer works.';

/**
 * What a token's `wait` is refused with (`refused`) while it has as many going as it may
 * (TOKEN_WAITS): a refusal that passes, which `corrallm wait` tells apart by these words.
 */
export const TOO_MANY_WAITS = 'Too many waits at once; let one end first.';
