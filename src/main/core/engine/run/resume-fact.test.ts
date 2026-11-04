import { afterEach, describe, expect, it } from 'vitest';

import type { AgentNode } from '../../../../shared/model/canvas';
import { TEST_ENGINE } from '../test-engine';
import { RunStore } from './runner';
import type { RunIO } from './runner';
import { expectRestorable, liveRun } from './test-restore';

/*
 * B16 C4's recovery fact: each attempt keeps whether the session it went to could continue its
 * conversation, as known when it went (an optional boolean on the attempt, with the run's durable
 * state, before its send). Restored after a restart, an interrupted attempt whose session couldn't
 * says so, whatever its agent runs now; an older record, or one sent before its session said,
 * promises nothing. Restoring stays uncertain, and nothing is sent again.
 */

afterEach(expectRestorable);

const engine = TEST_ENGINE;
const node = (connection: string): AgentNode => ({
  id: 'a',
  type: 'agent',
  position: { x: 0, y: 0 },
  data: { label: 'A', connection, queue: [{ id: 'ask', message: 'Fix the bug' }] },
});
const CANNOT =
  'Its session couldn’t continue its conversation, so starting it again starts a new one.';

/** A run whose agent's session can continue its conversation as `resumes` says, sending into `sent`. */
function running(resumes: RunIO['resumes'], connection = 'claude-code.sdk') {
  const sent: string[] = [];
  const store = liveRun(engine, {
    send: (_to, text) => {
      sent.push(text);
      return () => undefined;
    },
    tell: () => undefined,
    later: () => () => undefined,
    now: () => 1234,
    ...(resumes === undefined ? {} : { resumes }),
  });
  store.update([node(connection)]);
  return { store, sent };
}

/** The run `checkpoint` restores as a restart restores it, on a canvas whose agent runs `connection`. */
function restarted(checkpoint: string, connection: string) {
  const sent: string[] = [];
  const store = new RunStore(engine, {
    send: (_to, text) => {
      sent.push(text);
      return () => undefined;
    },
    tell: () => undefined,
    later: () => () => undefined,
    now: () => 5678,
    // Its agent can continue now: what its interrupted attempt went to couldn't.
    resumes: () => true,
  });
  store.update([node(connection)]);
  store.restore(checkpoint);
  return { store, sent };
}

describe('an attempt’s resume fact (B16 C4)', () => {
  it('keeps that its session couldn’t continue, and says so once restored, whatever the agent runs now', () => {
    const { store, sent } = running(() => false);
    store.start();
    expect(sent).toEqual(['Fix the bug']);
    expect(store.snapshot().agents.a?.attempts?.ask).toEqual([
      expect.objectContaining({ status: 'running', resumes: false }),
    ]);
    expect(JSON.parse(store.checkpoint())).toMatchObject({
      run: { agents: { a: { attempts: { ask: [{ resumes: false }] } } } },
    });

    const after = restarted(store.checkpoint(), 'claude-code.terminal');
    const at = after.store.snapshot().agents.a;
    expect(at?.problem).toMatchObject({ kind: 'uncertain', reason: 'interrupted' });
    expect(at?.problem?.text).toContain(CANNOT);
    expect(at?.attempts?.ask).toEqual([
      expect.objectContaining({ status: 'uncertain', resumes: false }),
    ]);
    expect(after.store.snapshot().running).toBe(false);
    expect(after.sent).toEqual([]);
  });

  it('says so where the run is held as quitting holds it', () => {
    const { store } = running(() => false);
    store.start();
    store.pause();
    expect(store.snapshot().agents.a?.problem?.text).toContain(CANNOT);
  });

  it('promises nothing for a session that could, one not yet known, or an older record', () => {
    for (const resumes of [() => true, () => undefined, undefined]) {
      const { store } = running(resumes);
      store.start();
      const attempt = store.snapshot().agents.a?.attempts?.ask?.[0];
      if (resumes?.() === true) expect(attempt).toMatchObject({ resumes: true });
      else expect(attempt).not.toHaveProperty('resumes');
      const after = restarted(store.checkpoint(), 'claude-code.sdk');
      expect(after.store.snapshot().agents.a?.problem?.text).not.toContain(CANNOT);
      expect(after.store.snapshot().agents.a?.problem?.text).toContain(
        'Inspect its native conversation before resolving or retrying.',
      );
    }
  });

  it('takes the fact only from the attempt that was going, never one that had ended', () => {
    const { store } = running(() => false);
    store.start();
    const saved = JSON.parse(store.checkpoint()) as {
      run: { agents: { a: { attempts: { ask: Record<string, unknown>[] } } } };
    };
    const [attempt] = saved.run.agents.a.attempts.ask;
    if (attempt === undefined) throw new Error('No attempt');
    // Its last attempt had ended (as between a failure and its next try): no turn of it was going.
    Object.assign(attempt, { status: 'failed', endedAt: 1300, reason: 'error' });
    const after = restarted(JSON.stringify(saved), 'claude-code.sdk');
    expect(after.store.snapshot().agents.a?.problem?.text).not.toContain(CANNOT);
    expect(after.sent).toEqual([]);
  });

  it('refuses a checkpoint whose fact isn’t a boolean', () => {
    const { store } = running(() => false);
    store.start();
    const saved = JSON.parse(store.checkpoint()) as {
      run: { agents: { a: { attempts: { ask: { resumes?: unknown }[] } } } };
    };
    const [attempt] = saved.run.agents.a.attempts.ask;
    if (attempt === undefined) throw new Error('No attempt');
    attempt.resumes = 'no';
    expect(() => restarted(JSON.stringify(saved), 'claude-code.sdk')).toThrow();
  });
});
