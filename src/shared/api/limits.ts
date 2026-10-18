/*
 * The numbers corrallm's API is bounded by, the same on every surface (Core Server §3.1). The API
 * Spec cites this table rather than keeping its own copy. Every string and list an operation takes
 * has a maximum, and the worst case of each op's arguments fits MAX_REQUEST_BYTES, which the
 * registry's tests check (src/shared/api/surface.test.ts).
 */

/** The largest request on any surface, and the MCP server's body cap (decision 20j). */
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/** The largest image a message may carry, in bytes (decision 20j). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** At most this many bytes of images in one message, together (decision 20j). */
export const MAX_IMAGE_TOTAL = 20 * 1024 * 1024;
/** At most this many images in one message. */
export const MAX_IMAGES = 20;

/**
 * The longest message a party sends another, in bytes of UTF-8 (decision 17): for every sender,
 * you included, until Build Plan Q16 is answered.
 */
export const MAX_MESSAGE_BYTES = 16 * 1024;

/**
 * How many live agents one party may have created (decision 13, Build Plan Q12), counted per
 * creating party (`agent:<id>` or `outside:<name>`), never per token: a lead's includes its team's.
 */
export const MAX_CREATED_AGENTS = 8;

/** At most this many calls in flight per token (Core Server §6.7); you are never limited. */
export const TOKEN_IN_FLIGHT = 8;
/** At most this many writes a second per token. */
export const TOKEN_WRITES_PER_SECOND = 30;
