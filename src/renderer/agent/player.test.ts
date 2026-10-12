import { describe, expect, it } from 'vitest';

import { play } from './player';
import type { Step } from './player';
import { NEW_SESSION, reduce } from './session';
import type { Session, SessionAction } from './session';

/** Plays `steps` on a clock the test turns by hand. */
function harness(steps: Step[], allowed: string[] = []) {
  let session: Session = { ...NEW_SESSION, status: 'working', allowed };
  let now = 0;
  let timers: { at: number; run: () => void }[] = [];
  let finished = false;
  const playback = play(steps, {
    dispatch: (action: SessionAction) => {
      session = reduce(session, action);
    },
    later: (run, ms) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => {
        timers = timers.filter((t) => t !== timer);
      };
    },
    now: () => now,
    allowed: (tool) => session.allowed.includes(tool),
    newId: (() => {
      let n = 0;
      return () => `id${String(++n)}`;
    })(),
    done: () => {
      finished = true;
    },
  });
  /** Runs every timer due by `ms` from now. */
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = due.at;
      due.run();
    }
    now = until;
  };
  return {
    playback,
    advance,
    session: () => session,
    kinds: () => session.entries.map((e) => e.kind),
    finished: () => finished,
  };
}

const ask: Step = {
  kind: 'ask',
  entry: { id: 'p', kind: 'permission', tool: 'Bash', summary: 'npm test' },
  allow: [
    {
      kind: 'add',
      entry: { id: 'ran', kind: 'tool', tool: 'Bash', summary: 'npm test', status: 'done' },
    },
  ],
  deny: [{ kind: 'add', entry: { id: 'no', kind: 'text', text: 'OK, I will not.' } }],
};

describe('play', () => {
  it('plays its steps in time, streaming text word by word, then ends the turn', () => {
    const h = harness([
      { kind: 'pause', ms: 500 },
      { kind: 'stream', id: 't', text: 'Looking at the code now.' },
    ]);
    expect(h.kinds()).toEqual([]);
    h.advance(500);
    expect(h.kinds()).toEqual(['text']);
    const text = () => {
      const entry = h.session().entries[0];
      return entry?.kind === 'text' ? entry.text : undefined;
    };
    expect(text()).not.toBe('Looking at the code now.');
    h.advance(5000);
    expect(text()).toBe('Looking at the code now.');
    expect(h.kinds()).toEqual(['text', 'end']);
    expect(h.session().status).toBe('idle');
    expect(h.finished()).toBe(true);
  });

  it('waits at a permission prompt until it is answered, then goes the way the answer says', () => {
    const allowed = harness([ask]);
    allowed.advance(10_000);
    expect(allowed.session().status).toBe('waiting');
    expect(allowed.kinds()).toEqual(['permission']);
    allowed.playback.answer('p', 'once');
    allowed.advance(10_000);
    expect(allowed.kinds()).toEqual(['permission', 'tool', 'end']);

    const denied = harness([ask]);
    denied.playback.answer('p', 'deny');
    denied.advance(10_000);
    expect(denied.kinds()).toEqual(['permission', 'text', 'end']);
  });

  it('ends the turn at an end step, skipping what is left', () => {
    const h = harness([
      { kind: 'add', entry: { id: 'a', kind: 'text', text: 'One' } },
      { kind: 'end' },
      { kind: 'add', entry: { id: 'b', kind: 'text', text: 'Two' } },
    ]);
    h.advance(10_000);
    expect(h.kinds()).toEqual(['text', 'end']);
  });

  it('does not ask about a tool the user always allows', () => {
    const h = harness([ask], ['Bash']);
    h.advance(10_000);
    expect(h.kinds()).toEqual(['tool', 'end']);
  });

  it('stops when interrupted: nothing more plays', () => {
    const h = harness([
      {
        kind: 'add',
        entry: { id: 'b', kind: 'tool', tool: 'Bash', summary: 'npm test', status: 'running' },
      },
      { kind: 'pause', ms: 1000 },
      { kind: 'stream', id: 't', text: 'All done.' },
    ]);
    h.advance(10);
    h.playback.stop();
    h.advance(10_000);
    expect(h.kinds()).toEqual(['tool', 'end']);
    const [tool, end] = h.session().entries;
    expect(tool?.kind === 'tool' && tool.status).toBe('interrupted');
    expect(end?.kind === 'end' && end.interrupted).toBe(true);
  });
});
