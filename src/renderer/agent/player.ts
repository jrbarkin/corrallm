import type { Answer, Entry, SessionAction } from './session';

/** One step of a scripted turn. */
export type Step =
  | { kind: 'pause'; ms: number }
  | { kind: 'add'; entry: Entry }
  /** A text entry `id` whose text appears a few words at a time. */
  | { kind: 'stream'; id: string; text: string }
  | { kind: 'update'; id: string; update: (entry: Entry) => Entry }
  /** Ends the turn here, skipping any steps left. */
  | { kind: 'end' }
  /** A permission prompt: the turn waits for its answer, then plays `allow` or `deny`. */
  | {
      kind: 'ask';
      entry: Extract<Entry, { kind: 'permission' }>;
      allow: Step[];
      deny: Step[];
    };

/** What the player needs from its surroundings. */
export interface PlayerIO {
  dispatch: (action: SessionAction) => void;
  /** Runs `run` in `ms`; returns a function that cancels it. */
  later: (run: () => void, ms: number) => () => void;
  now: () => number;
  /** Whether the user always allows `tool`, so it need not ask. */
  allowed: (tool: string) => boolean;
  newId: () => string;
  /** Called once the turn has ended: `interrupted` if it was stopped. */
  done: (interrupted: boolean) => void;
}

export interface Playback {
  answer: (id: string, answer: Answer) => void;
  /** Interrupts the turn, as Escape does in Claude Code. */
  stop: () => void;
}

/** Words per streamed chunk, and the time between chunks. */
const CHUNK_WORDS = 3;
const CHUNK_MS = 40;

/** Plays a scripted turn's steps against a session (see session.ts), in time. */
export function play(steps: readonly Step[], io: PlayerIO): Playback {
  const started = io.now();
  let rest = [...steps];
  let cancel: (() => void) | undefined;
  let asking: Extract<Step, { kind: 'ask' }> | undefined;
  let over = false;

  const end = (interrupted: boolean) => {
    if (over) return;
    over = true;
    cancel?.();
    const seconds = Math.max(1, Math.round((io.now() - started) / 1000));
    io.dispatch({ type: 'end', id: io.newId(), seconds, interrupted });
    io.done(interrupted);
  };

  const next = (): void => {
    if (over) return;
    const step = rest.shift();
    if (!step) {
      end(false);
      return;
    }
    switch (step.kind) {
      case 'pause':
        cancel = io.later(next, step.ms);
        return;
      case 'add':
        io.dispatch({ type: 'add', entry: step.entry });
        next();
        return;
      case 'update':
        io.dispatch({ type: 'update', id: step.id, update: step.update });
        next();
        return;
      case 'end':
        rest = [];
        next();
        return;
      case 'stream': {
        io.dispatch({ type: 'add', entry: { id: step.id, kind: 'text', text: '' } });
        const words = step.text.split(/(?<= )/);
        const chunk = (from: number) => {
          io.dispatch({
            type: 'stream',
            id: step.id,
            text: words.slice(from, from + CHUNK_WORDS).join(''),
          });
          if (from + CHUNK_WORDS < words.length) {
            cancel = io.later(() => {
              chunk(from + CHUNK_WORDS);
            }, CHUNK_MS);
          } else {
            next();
          }
        };
        cancel = io.later(() => {
          chunk(0);
        }, CHUNK_MS);
        return;
      }
      case 'ask':
        if (io.allowed(step.entry.tool)) {
          rest = [...step.allow, ...rest];
          next();
          return;
        }
        asking = step;
        io.dispatch({ type: 'ask', entry: step.entry });
        return;
    }
  };

  next();
  return {
    answer: (id, answer) => {
      if (over || asking?.entry.id !== id) return;
      const { allow, deny } = asking;
      asking = undefined;
      io.dispatch({ type: 'answer', id, answer });
      rest = [...(answer === 'deny' ? deny : allow), ...rest];
      next();
    },
    stop: () => {
      end(true);
    },
  };
}
