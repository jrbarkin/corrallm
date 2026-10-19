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
 * The newest settled messages the store keeps per party (a message counts for its sender and its
 * recipient), within STORE_BYTES per canvas; pending and unresolved ones are always kept, and the
 * oldest settled go first (API Spec §5.8).
 */
export const STORE_SETTLED_PER_PARTY = 100;
/** The most bytes of messages a canvas's store keeps (their JSON). */
export const STORE_BYTES = 4 * 1024 * 1024;
/**
 * The most messages one party may have waiting for one agent (pending: not yet delivered); another
 * is refused until one of them goes. You are never limited. The store keeps every message waiting,
 * whatever its byte budget, so this bounds them.
 */
export const MAX_WAITING = 20;

/** The most a page of a list (messages, a transcript) holds. */
export const MAX_PAGE = 200;
/** How many a page of a list holds when a call doesn't say. */
export const DEFAULT_PAGE = 50;
/**
 * The most bytes of JSON a page of a list holds, whatever it was asked for (an MCP client may cap
 * what one tool's result holds: Core Server §4 G): a page ends early rather than pass it, and holds
 * at least one item. A transcript's entry too big alone is cut to fit (the whole of it stays in its
 * session); a message, at most MAX_MESSAGE_BYTES of text, is given whole.
 */
export const MAX_PAGE_BYTES = 60 * 1024;

/** How many lines of a prompt's detail are shown, then how many more there are. */
export const MAX_DETAIL_LINES = 12;

/**
 * How many live agents one party may have created (decision 13, Build Plan Q12), counted per
 * creating party (`agent:<id>` or `outside:<name>`), never per token: a lead's includes its team's.
 */
export const MAX_CREATED_AGENTS = 8;

/** The longest a `wait` waits for what comes, in seconds (API Spec §7.7). */
export const MAX_WAIT_SECONDS = 3600;

/** How long an outside token lasts unless its maker says otherwise, in hours (decision 8). */
export const DEFAULT_TOKEN_HOURS = 1;
/** The longest an outside token may last, in hours (decision 8). */
export const MAX_TOKEN_HOURS = 12;

/**
 * At most this many calls in flight per token (Core Server §6.7), `wait` aside; you are never
 * limited.
 */
export const TOKEN_IN_FLIGHT = 8;
/**
 * At most this many `wait`s in flight per token, apart from its other calls: each holds a
 * connection, for up to MAX_WAIT_SECONDS, so an orchestrator may wait on each of its workers at
 * once, but waits a client left behind can't pile up.
 */
export const TOKEN_WAITS = 16;
/** At most this many writes a second per token. */
export const TOKEN_WRITES_PER_SECOND = 30;
