import { TOKEN_REPLACED } from '../../../shared/api/errors';
import type { Message, PartyId } from '../../../shared/model/messages';
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
 * its time limit, its caller gives up, or its token is replaced or expires. It never consumes: a
 * message keeps its state, and a cursor reads it again. A wait without `for` moves the party's read
 * position forward to where it ended, journaled before it returns. Waits that read on from the read
 * position (no `after`, no `for`) take turns, each reading it afresh, so one message wakes only one
 * of them with it.
 */

const NOT_A_CURSOR = 'That cursor isn’t one wait or status gave.';
const PAST_END =
  'That cursor is past the last message a canvas holds, so corrallm didn’t give it: leave out `after` to read on from where you last waited.';

export function waitOps(services: OpServices): Pick<Implementations, 'wait'> {
  const { engines, tokens } = services;
  /** Each party's waits that read on from its read position, in turn: the last one's end. */
  const turns = new Map<PartyId, Promise<unknown>>();

  /** Runs `read` once every wait of `party` before it has had its turn. */
  const inTurn = <T>(party: PartyId, read: () => Promise<T>): Promise<T> => {
    const mine = (turns.get(party) ?? Promise.resolve()).then(read);
    const done = mine.catch(() => undefined);
    turns.set(party, done);
    void done.then(() => {
      if (turns.get(party) === done) turns.delete(party);
    });
    return mine;
  };

  return {
    wait: async ({ after, for: about, timeoutSeconds }, ctx) => {
      const { caller } = ctx;
      // Only a token's caller is in its audience.
      if (!isTokenCaller(caller)) throw new OpFailure('forbidden', 'You can’t call wait.');
      const party = partyIdOf(caller);
      const cursor = after === undefined ? undefined : readCursor(after, ['wait']);
      if (after !== undefined && cursor === undefined) throw new OpFailure('invalid', NOT_A_CURSOR);
      const reached = canvasesOf(caller);
      const open = reached.flatMap((canvas) => engines.canvas(canvas) ?? []);
      for (const { document, messages } of open) {
        if ((cursor?.[document.id] ?? 0) > messages.end()) {
          throw new OpFailure('invalid', PAST_END);
        }
      }
      /** Where reading starts in each canvas: the cursor's places, else the party's. */
      const startOf = (): Record<string, number> =>
        Object.fromEntries(
          open.map(({ document, reads }) => {
            const at = cursor?.[document.id];
            return [document.id, at ?? (cursor === undefined ? reads.of(party) : 0)];
          }),
        );
      const concerns = (message: Message) =>
        message.to === party &&
        (about === undefined || message.id === about || message.replyTo === about);
      const deadline = Date.now() + timeoutSeconds * 1000;
      const readsOn = after === undefined && about === undefined;
      // A wait with a cursor or `for` reads from where it began, whatever another returned since.
      const fixed = readsOn ? undefined : startOf();

      /** What came, as the call returns it; undefined while nothing has and time is left. */
      const look = async () => {
        if (caller.kind === 'outside' && tokens.revoked(caller.token)) {
          throw new OpFailure('refused', TOKEN_REPLACED);
        }
        const start = fixed ?? startOf();
        const found = unread(open, start, concerns);
        if (found.length === 0 && Date.now() < deadline) return undefined;
        const page = pageOf(found);
        const next = { ...start };
        for (const { message, seq } of page) next[message.canvas] = seq;
        if (about === undefined) {
          await Promise.all(
            open.flatMap((running) => {
              const at = next[running.document.id];
              return at === undefined ? [] : [running.reads.advance(party, at)];
            }),
          );
        }
        return { messages: page.map(({ message }) => message), next: cursorOf('wait', next) };
      };

      for (;;) {
        // Listening before it looks, so nothing added meanwhile is missed.
        const woken = arrival(open, concerns, deadline, ctx.signal, caller, tokens);
        try {
          const result = await (readsOn ? inTurn(party, look) : look());
          if (result) return result;
          await woken.promise;
        } finally {
          woken.stop();
        }
      }
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
 * Listens, from now, for a message `concerns` picks added to one of the canvases, the `deadline`,
 * or the caller's token replaced or expiring: its promise resolves on the first, and rejects once
 * its caller gives up; `stop` stops listening.
 */
function arrival(
  open: readonly OpenCanvas[],
  concerns: (message: Message) => boolean,
  deadline: number,
  signal: AbortSignal,
  caller: TokenCaller,
  tokens: OpServices['tokens'],
): { promise: Promise<void>; stop: () => void } {
  const stops: (() => void)[] = [];
  const stop = () => {
    for (const one of stops.splice(0)) one();
  };
  const promise = new Promise<void>((resolve, reject) => {
    const done = (settle: () => void) => {
      stop();
      settle();
    };
    const expires = caller.kind === 'outside' ? tokens.expiresOf(caller.token) : undefined;
    const timer = setTimeout(
      () => {
        done(resolve);
      },
      Math.max(0, Math.min(deadline, expires ?? deadline) - Date.now()),
    );
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
  // Its caller may stop listening before it settles: what it was waiting for is then no one's.
  promise.catch(() => undefined);
  return { promise, stop };
}
