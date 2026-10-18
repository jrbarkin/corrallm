import { describe, expect, it } from 'vitest';

import { Scopes, Superseded } from './scopes';

/** An op that runs until released (or aborted), recording when it started and how it ended. */
function controlled(log: string[], name: string) {
  const release = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<AbortSignal>();
  const op = async (signal: AbortSignal) => {
    log.push(`${name} started`);
    started.resolve(signal);
    await Promise.race([
      release.promise,
      new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve();
        });
      }),
    ]);
    log.push(signal.aborted ? `${name} aborted` : `${name} done`);
    return name;
  };
  return {
    op,
    started: started.promise,
    release: () => {
      release.resolve(undefined);
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Scopes', () => {
  it('runs the ops of one scope one at a time, in the order they came', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    const first = controlled(log, 'first');
    const second = controlled(log, 'second');
    const one = scopes.run(['app', 'c', 'a'], false, undefined, first.op);
    const two = scopes.run(['app', 'c', 'a'], false, undefined, second.op);
    await first.started;
    await tick();
    expect(log).toEqual(['first started']);
    first.release();
    await second.started;
    second.release();
    expect(await Promise.all([one, two])).toEqual(['first', 'second']);
    expect(log).toEqual(['first started', 'first done', 'second started', 'second done']);
  });

  it('keeps an op that comes later waiting behind one that started from the queue', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    const first = controlled(log, 'first');
    const second = controlled(log, 'second');
    const third = controlled(log, 'third');
    const one = scopes.run(['app', 'c'], false, undefined, first.op);
    const two = scopes.run(['app', 'c'], false, undefined, second.op);
    first.release();
    await second.started;
    const three = scopes.run(['app', 'c'], false, undefined, third.op);
    await tick();
    expect(log).toEqual(['first started', 'first done', 'second started']);
    second.release();
    await third.started;
    third.release();
    expect(await Promise.all([one, two, three])).toEqual(['first', 'second', 'third']);
  });

  it('runs ops of other scopes, and ops with none, at once', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    const a = controlled(log, 'a');
    const b = controlled(log, 'b');
    const canvas = controlled(log, 'canvas');
    const free = controlled(log, 'free');
    const running = [
      scopes.run(['app', 'c', 'a'], false, undefined, a.op),
      scopes.run(['app', 'c', 'b'], false, undefined, b.op),
      scopes.run(['app', 'c'], false, undefined, canvas.op),
      scopes.run(null, false, undefined, free.op),
    ];
    await Promise.all([a.started, b.started, canvas.started, free.started]);
    for (const op of [a, b, canvas, free]) op.release();
    expect(await Promise.all(running)).toEqual(['a', 'b', 'canvas', 'free']);
  });

  it('lets a preempting op abort what runs in its scope, then run ahead of what is queued', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    const slow = controlled(log, 'slow');
    const queued = controlled(log, 'queued');
    const stop = controlled(log, 'stop');
    const running = scopes.run(['app', 'c', 'a'], false, undefined, slow.op);
    const next = scopes.run(['app', 'c', 'a'], false, undefined, queued.op);
    const slowSignal = await slow.started;
    const stopping = scopes.run(['app', 'c', 'a'], true, undefined, stop.op);
    await stop.started;
    expect(slowSignal.reason).toBeInstanceOf(Superseded);
    expect(log).toEqual(['slow started', 'slow aborted', 'stop started']);
    stop.release();
    await queued.started;
    queued.release();
    expect(await Promise.all([running, next, stopping])).toEqual(['slow', 'queued', 'stop']);
    expect(log).toEqual([
      'slow started',
      'slow aborted',
      'stop started',
      'stop done',
      'queued started',
      'queued done',
    ]);
  });

  it('lets a preempting op abort what runs in the scopes beneath its own', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    const agent = controlled(log, 'agent');
    const elsewhere = controlled(log, 'elsewhere');
    const stop = controlled(log, 'stop');
    const running = scopes.run(['app', 'c', 'a'], false, undefined, agent.op);
    const other = scopes.run(['app', 'd', 'a'], false, undefined, elsewhere.op);
    await Promise.all([agent.started, elsewhere.started]);
    const stopping = scopes.run(['app', 'c'], true, undefined, stop.op);
    await stop.started;
    stop.release();
    elsewhere.release();
    await Promise.all([running, other, stopping]);
    expect(log).toContain('agent aborted');
    expect(log).toContain('elsewhere done');
  });

  it('passes the caller’s signal to the op, and drops a queued op whose caller gave up', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    const first = controlled(log, 'first');
    const second = controlled(log, 'second');
    const caller = new AbortController();
    const running = scopes.run(['app'], false, caller.signal, first.op);
    const waiting = new AbortController();
    const queued = scopes.run(['app'], false, waiting.signal, second.op);
    await first.started;
    waiting.abort(new Error('gone'));
    await expect(queued).rejects.toThrow('gone');
    caller.abort(new Error('left'));
    expect(await running).toBe('first');
    expect(log).toEqual(['first started', 'first aborted']);
    // The scope is free again.
    const third = controlled(log, 'third');
    const after = scopes.run(['app'], false, undefined, third.op);
    await third.started;
    third.release();
    expect(await after).toBe('third');
  });

  it('frees its scope when an op fails', async () => {
    const scopes = new Scopes();
    await expect(
      scopes.run(['app', 'c'], false, undefined, () => Promise.reject(new Error('broken'))),
    ).rejects.toThrow('broken');
    expect(await scopes.run(['app', 'c'], false, undefined, () => Promise.resolve('next'))).toBe(
      'next',
    );
  });
});
