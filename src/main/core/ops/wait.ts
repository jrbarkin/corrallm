import type { Message } from '../../../shared/model/messages';
import { OpFailure } from '../call';
import { canvasesOf, isTokenCaller, partyIdOf } from '../caller';
import type { TokenCaller } from '../caller';
import { cursorOf, readCursor } from '../delivery/messages';
import type { OpenCanvas } from '../engines';
import { pageOf } from './open';
import type { Implementations, OpServices } from '.';

/*
 * `wait` (decision 20a; API Spec §7.7, Core Server §5.9): what an outside orchestrator calls to
 * learn what came for it, waking as it comes. It reads each canvas the caller reaches from its
 * starting point (a cursor's place in that canvas's store; without one, the party's read position;
 * 0, before everything kept, where a cursor names no place) and returns the messages addressed to
 * the caller's party since, oldest first, a page at most; with none, it waits for the next, until
 * its time limit, its caller gives up, or its token is replaced. It never consumes: a message keeps
 * its state, and a cursor reads it again. A wait without `for` moves the party's read position
 * forward to where it ended, journaled before it returns.
 */

const REPLACED =
  'This token was replaced or expired: call with the token its maker has now (corrallm serve --new-token).';

export function waitOps(services: OpServices): Pick<Implementations, 'wait'> {
  const { engines, tokens } = services;

  return {
    wait: async ({ after, for: about, timeoutSeconds }, ctx) => {
      const { caller } = ctx;
      // Only a token's caller is in its audience.
      if (!isTokenCaller(caller)) throw new OpFailure('forbidden', 'You can’t call wait.');
      const party = partyIdOf(caller);
      const cursor = after === undefined ? undefined : readCursor(after);
      if (after !== undefined && cursor === undefined) {
        throw new OpFailure('invalid', 'That cursor isn’t one corrallm gave.');
      }
      const reached = canvasesOf(caller);
      const open = reached.flatMap((canvas) => engines.canvas(canvas) ?? []);
      /** Where reading starts in each canvas: the cursor's places, else the party's. */
      const start: Record<string, number> = Object.fromEntries(
        reached.flatMap((canvas) => {
          const at = cursor?.[canvas];
          if (at !== undefined) return [[canvas, at]];
          const running = engines.canvas(canvas);
          if (!running) return [];
          return [[canvas, cursor === undefined ? running.reads.of(party) : 0]];
        }),
      );
      const concerns = (message: Message) =>
        message.to === party &&
        (about === undefined || message.id === about || message.replyTo === about);
      const read = () => unread(open, start, concerns);

      let found = read();
      if (found.length === 0 && timeoutSeconds > 0) {
        await arrival(open, concerns, timeoutSeconds, ctx.signal, caller, tokens);
        found = read();
      }
      if (caller.kind === 'outside' && tokens.revoked(caller.token)) {
        throw new OpFailure('refused', REPLACED);
      }
      const page = pageOf(found);
      const next = { ...start };
      for (const { message, seq } of found.slice(0, page.length)) next[message.canvas] = seq;
      if (about === undefined) {
        await Promise.all(
          open.flatMap((running) => {
            const at = next[running.document.id];
            return at === undefined ? [] : [running.reads.advance(party, at)];
          }),
        );
      }
      return { messages: page.map(({ message }) => message), next: cursorOf(next) };
    },
  };
}

/** A message, with its place in its canvas's store. */
interface Placed {
  message: Message;
  seq: number;
}

/**
 * The messages `concerns` picks in each open canvas after its starting place, oldest first: each
 * canvas's in its store's order, merged by when they were sent (a canvas earlier in the caller's
 * list first, at a tie), so that any first part of the list holds a first part of each canvas's.
 */
function unread(
  open: readonly OpenCanvas[],
  start: Readonly<Record<string, number>>,
  concerns: (message: Message) => boolean,
): Placed[] {
  const lanes = open.map(({ document, messages }) =>
    messages.all().flatMap((message): Placed[] => {
      const seq = messages.seqOf(message.id) ?? 0;
      return seq > (start[document.id] ?? 0) && concerns(message) ? [{ message, seq }] : [];
    }),
  );
  const merged: Placed[] = [];
  for (;;) {
    let earliest: Placed[] | undefined;
    for (const lane of lanes) {
      const [head] = lane;
      const best = earliest?.[0];
      if (head && (!best || head.message.at < best.message.at)) earliest = lane;
    }
    const head = earliest?.shift();
    if (!head) return merged;
    merged.push(head);
  }
}

/**
 * Resolves once a message `concerns` picks is added to one of the canvases, `seconds` pass, or the
 * caller's token is replaced; rejects once its caller gives up.
 */
function arrival(
  open: readonly OpenCanvas[],
  concerns: (message: Message) => boolean,
  seconds: number,
  signal: AbortSignal,
  caller: TokenCaller,
  tokens: OpServices['tokens'],
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stops: (() => void)[] = [];
    const done = (settle: () => void) => {
      for (const stop of stops) stop();
      settle();
    };
    const timer = setTimeout(() => {
      done(resolve);
    }, seconds * 1000);
    stops.push(() => {
      clearTimeout(timer);
    });
    for (const { messages } of open) {
      stops.push(
        messages.subscribe((message) => {
          if (concerns(message)) done(resolve);
        }),
      );
    }
    if (caller.kind === 'outside') {
      stops.push(
        tokens.onRevoke((id) => {
          if (id === caller.token) done(resolve);
        }),
      );
    }
    const abort = () => {
      done(() => {
        reject(
          signal.reason instanceof Error ? signal.reason : new Error('The call was cancelled.'),
        );
      });
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    stops.push(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}
