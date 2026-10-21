import { describe, expect, it } from 'vitest';

import { Scopes, Superseded } from './scopes';

/**
 * An op that runs until released (or aborted), recording when it started and how it ended; `past`,
 * one that is past its point of no return once it starts.
 */
function controlled(log: string[], name: string, { past = false } = {}) {
  const release = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<AbortSignal>();
  const op = async (signal: AbortSignal, noReturn: () => void) => {
    log.push(`${name} started`);
    if (past) noReturn();
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
  it('releases an inner drain after a cancelled owner without aborting work past its commit point', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    const active = controlled(log, 'active', { past: true });
    const first = scopes.run(['app', 'c', 'a'], {}, undefined, active.op);
    const signal = await active.started;
    const owner = new AbortController();
    let ran = false;
    const draining = scopes.draining(['app', 'c'], [['app', 'c', 'a']], owner.signal, () => {
      ran = true;
      return Promise.resolve();
    });
    const cancelled = expect(draining).rejects.toThrow('left');
    const later = controlled(log, 'later');
    const next = scopes.run(['app', 'c', 'a'], {}, undefined, later.op);
    owner.abort(new Error('left'));
    expect(signal.aborted).toBe(false);
    active.release();
    await first;
    await cancelled;
    await later.started;
    later.release();
    await next;
    expect(ran).toBe(false);
    expect(log).toEqual(['active started', 'active done', 'later started', 'later done']);
  });
  it('drains, for an op in its scope, the lane it runs in without aborting or waiting for it', async () => {
    // Allow's replay of a replace of the canvas its reply is on: the inner op drains the canvas.
    const scopes = new Scopes();
    const log: string[] = [];
    const agent = controlled(log, 'agent');
    const onAgent = scopes.run(['app', 'c', 'a'], {}, undefined, agent.op);
    await agent.started;
    const gate = Promise.withResolvers<undefined>();
    const owner = scopes.run(['app', 'c'], {}, undefined, async (signal) => {
      await gate.promise;
      await scopes.draining(['app'], [['app', 'c']], signal, () => {
        log.push('inner ran');
        return Promise.resolve();
      });
      return signal.aborted ? 'owner aborted' : 'owner done';
    });
    const behind = scopes.run(['app', 'c'], {}, undefined, () => {
      log.push('behind ran');
      return Promise.resolve();
    });
    const superseded = expect(behind).rejects.toBeInstanceOf(Superseded);
    gate.resolve(undefined);
    expect(await owner).toBe('owner done');
    await superseded;
    expect(await onAgent).toBe('agent');
    expect(log).toEqual(['agent started', 'agent aborted', 'inner ran']);
  });
  it('runs the ops of one scope one at a time, in the order they came', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    const first = controlled(log, 'first');
    const second = controlled(log, 'second');
    const one = scopes.run(['app', 'c', 'a'], {}, undefined, first.op);
    const two = scopes.run(['app', 'c', 'a'], {}, undefined, second.op);
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
    const one = scopes.run(['app', 'c'], {}, undefined, first.op);
    const two = scopes.run(['app', 'c'], {}, undefined, second.op);
    first.release();
    await second.started;
    const three = scopes.run(['app', 'c'], {}, undefined, third.op);
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
      scopes.run(['app', 'c', 'a'], {}, undefined, a.op),
      scopes.run(['app', 'c', 'b'], {}, undefined, b.op),
      scopes.run(['app', 'c'], {}, undefined, canvas.op),
      scopes.run(null, {}, undefined, free.op),
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
    const running = scopes.run(['app', 'c', 'a'], {}, undefined, slow.op);
    const next = scopes.run(['app', 'c', 'a'], {}, undefined, queued.op);
    const slowSignal = await slow.started;
    const stopping = scopes.run(['app', 'c', 'a'], { preempt: true }, undefined, stop.op);
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

  it('runs preempting ops that overlap one at a time, in the order they came, before what is queued', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    let running = 0;
    let most = 0;
    const counted =
      <T>(op: (signal: AbortSignal, noReturn: () => void) => Promise<T>) =>
      async (signal: AbortSignal, noReturn: () => void) => {
        most = Math.max(most, ++running);
        try {
          return await op(signal, noReturn);
        } finally {
          running--;
        }
      };
    const path = ['app', 'c', 'a'];
    const slow = controlled(log, 'slow');
    const stop = controlled(log, 'stop');
    const kill = controlled(log, 'kill');
    const queued = controlled(log, 'queued');
    const results = [scopes.run(path, {}, undefined, counted(slow.op))];
    await slow.started;
    // Both come while the slow op unwinds.
    results.push(scopes.run(path, { preempt: true }, undefined, counted(stop.op)));
    results.push(scopes.run(path, { preempt: true }, undefined, counted(kill.op)));
    results.push(scopes.run(path, {}, undefined, counted(queued.op)));
    await stop.started;
    await tick();
    expect(log).toEqual(['slow started', 'slow aborted', 'stop started']);
    // A preempting op never aborts another: each does what it came for.
    stop.release();
    await kill.started;
    await tick();
    expect(log).toEqual([
      'slow started',
      'slow aborted',
      'stop started',
      'stop done',
      'kill started',
    ]);
    kill.release();
    await queued.started;
    queued.release();
    expect(await Promise.all(results)).toEqual(['slow', 'stop', 'kill', 'queued']);
    expect(log.at(-1)).toBe('queued done');
    expect(most).toBe(1);
  });

  it('drops a preempting op whose caller gave up while it waited, leaving the scope to the queue', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    const path = ['app', 'c', 'a'];
    const slow = controlled(log, 'slow');
    const stop = controlled(log, 'stop');
    const queued = controlled(log, 'queued');
    // An op that takes a while to unwind once aborted.
    const unwound = Promise.withResolvers<undefined>();
    const running = scopes.run(path, {}, undefined, async (signal, noReturn) => {
      const result = await slow.op(signal, noReturn);
      await unwound.promise;
      return result;
    });
    await slow.started;
    const caller = new AbortController();
    const stopping = scopes.run(path, { preempt: true }, caller.signal, stop.op);
    const next = scopes.run(path, {}, undefined, queued.op);
    caller.abort(new Error('gone'));
    unwound.resolve(undefined);
    await expect(stopping).rejects.toThrow('gone');
    await queued.started;
    queued.release();
    expect(await Promise.all([running, next])).toEqual(['slow', 'queued']);
    expect(log).toEqual(['slow started', 'slow aborted', 'queued started', 'queued done']);
  });

  it('lets a preempting op abort what runs in the scopes beneath its own', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    const agent = controlled(log, 'agent');
    const elsewhere = controlled(log, 'elsewhere');
    const stop = controlled(log, 'stop');
    const running = scopes.run(['app', 'c', 'a'], {}, undefined, agent.op);
    const other = scopes.run(['app', 'd', 'a'], {}, undefined, elsewhere.op);
    await Promise.all([agent.started, elsewhere.started]);
    const stopping = scopes.run(['app', 'c'], { preempt: true }, undefined, stop.op);
    await stop.started;
    stop.release();
    elsewhere.release();
    await Promise.all([running, other, stopping]);
    expect(log).toContain('agent aborted');
    expect(log).toContain('elsewhere done');
  });

  it('lets a draining op abort what runs in the scopes it drains, then take its turn in its own as usual', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    const agent = controlled(log, 'agent');
    const other = controlled(log, 'other');
    const canvas = controlled(log, 'canvas');
    const drain = controlled(log, 'drain');
    const running = [
      scopes.run(['app', 'c', 'a'], {}, undefined, agent.op),
      scopes.run(['app', 'c', 'b'], {}, undefined, other.op),
      scopes.run(['app', 'c'], {}, undefined, canvas.op),
    ];
    await Promise.all([agent.started, other.started, canvas.started]);
    const draining = scopes.run(['app', 'c'], { drains: [['app', 'c', 'a']] }, undefined, drain.op);
    await tick();
    // The agent it drains is stopped at once; the one it doesn't drain, and what holds its own
    // scope (whose turn came first), go on.
    expect(log).toEqual(['agent started', 'other started', 'canvas started', 'agent aborted']);
    canvas.release();
    await drain.started;
    other.release();
    drain.release();
    expect(await Promise.all([...running, draining])).toEqual([
      'agent',
      'other',
      'canvas',
      'drain',
    ]);
    expect(log).toEqual([
      'agent started',
      'other started',
      'canvas started',
      'agent aborted',
      'canvas done',
      'drain started',
      'other done',
      'drain done',
    ]);
  });

  it('drains every scope beneath a canvas’s when it drains the canvas, and none of another', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    const a = controlled(log, 'a');
    const b = controlled(log, 'b');
    const elsewhere = controlled(log, 'elsewhere');
    const close = controlled(log, 'close');
    const running = [
      scopes.run(['app', 'c', 'a'], {}, undefined, a.op),
      scopes.run(['app', 'c', 'b'], {}, undefined, b.op),
      scopes.run(['app', 'd', 'a'], {}, undefined, elsewhere.op),
    ];
    await Promise.all([a.started, b.started, elsewhere.started]);
    const closing = scopes.run(['app', 'c'], { drains: [['app', 'c']] }, undefined, close.op);
    await close.started;
    close.release();
    elsewhere.release();
    await Promise.all([...running, closing]);
    expect(log.indexOf('a aborted')).toBeLessThan(log.indexOf('close started'));
    expect(log.indexOf('b aborted')).toBeLessThan(log.indexOf('close started'));
    expect(log).toContain('elsewhere done');
  });

  it('supersedes what waits in the scopes it drains, and starts nothing there until it is done', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    const agent = ['app', 'c', 'a'];
    const running = controlled(log, 'running');
    const queued = controlled(log, 'queued');
    const drain = controlled(log, 'drain');
    const later = controlled(log, 'later');
    const fresh = controlled(log, 'fresh');
    const ran = scopes.run(agent, {}, undefined, running.op);
    const waited = scopes.run(agent, {}, undefined, queued.op);
    await running.started;
    const draining = scopes.run(['app', 'c'], { drains: [['app', 'c']] }, undefined, drain.op);
    await expect(waited).rejects.toBeInstanceOf(Superseded);
    await drain.started;
    // What comes meanwhile, in a scope it drains (one that had nothing yet too), waits for it.
    const after = [
      scopes.run(agent, {}, undefined, later.op),
      scopes.run(['app', 'c', 'b'], {}, undefined, fresh.op),
    ];
    await tick();
    expect(log).toEqual(['running started', 'running aborted', 'drain started']);
    drain.release();
    await Promise.all([later.started, fresh.started]);
    later.release();
    fresh.release();
    expect(await Promise.all([ran, draining, ...after])).toEqual([
      'running',
      'drain',
      'later',
      'fresh',
    ]);
    expect(log.slice(0, 4)).toEqual([
      'running started',
      'running aborted',
      'drain started',
      'drain done',
    ]);
  });

  it('waits for a preempting op that runs in a scope it drains, aborting it not', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    const stop = controlled(log, 'stop');
    const drain = controlled(log, 'drain');
    const stopping = scopes.run(['app', 'c', 'a'], { preempt: true }, undefined, stop.op);
    const signal = await stop.started;
    const draining = scopes.run(['app', 'c'], { drains: [['app', 'c', 'a']] }, undefined, drain.op);
    await tick();
    expect(signal.aborted).toBe(false);
    expect(log).toEqual(['stop started']);
    stop.release();
    await drain.started;
    drain.release();
    expect(await Promise.all([stopping, draining])).toEqual(['stop', 'drain']);
    expect(log).toEqual(['stop started', 'stop done', 'drain started', 'drain done']);
  });

  it('lets the scopes it drains go once its caller gives up on it before its turn', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    const canvas = controlled(log, 'canvas');
    const drain = controlled(log, 'drain');
    const later = controlled(log, 'later');
    const holding = scopes.run(['app', 'c'], {}, undefined, canvas.op);
    await canvas.started;
    const caller = new AbortController();
    const draining = scopes.run(
      ['app', 'c'],
      { drains: [['app', 'c', 'a']] },
      caller.signal,
      drain.op,
    );
    const after = scopes.run(['app', 'c', 'a'], {}, undefined, later.op);
    await tick();
    expect(log).toEqual(['canvas started']);
    caller.abort(new Error('gone'));
    await expect(draining).rejects.toThrow('gone');
    await later.started;
    later.release();
    canvas.release();
    expect(await Promise.all([holding, after])).toEqual(['canvas', 'later']);
    expect(log).not.toContain('drain started');
  });

  it('never runs a draining op superseded while it waited for what it drains', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    const agent = controlled(log, 'agent');
    const close = controlled(log, 'close');
    const stop = controlled(log, 'stop');
    // An agent op slow to unwind once aborted.
    const unwound = Promise.withResolvers<undefined>();
    const working = scopes.run(['app', 'c', 'a'], {}, undefined, async (signal, noReturn) => {
      const result = await agent.op(signal, noReturn);
      await unwound.promise;
      return result;
    });
    await agent.started;
    const closing = scopes.run(['app', 'c'], { drains: [['app', 'c']] }, undefined, close.op);
    const stopping = scopes.run(['app', 'c'], { preempt: true }, undefined, stop.op);
    await tick();
    unwound.resolve(undefined);
    await stop.started;
    stop.release();
    await expect(closing).rejects.toBeInstanceOf(Superseded);
    expect(await Promise.all([working, stopping])).toEqual(['agent', 'stop']);
    expect(log).not.toContain('close started');
  });

  it('never aborts an op past its point of no return, but lets what would have wait for it', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    const commit = controlled(log, 'commit', { past: true });
    const agent = controlled(log, 'agent', { past: true });
    const stop = controlled(log, 'stop');
    const close = controlled(log, 'close');
    const committing = scopes.run(['app', 'c'], {}, undefined, commit.op);
    const working = scopes.run(['app', 'c', 'a'], {}, undefined, agent.op);
    const signals = await Promise.all([commit.started, agent.started]);
    const stopping = scopes.run(['app', 'c'], { preempt: true }, undefined, stop.op);
    const closing = scopes.run(['app', 'c'], { drains: [['app', 'c']] }, undefined, close.op);
    await tick();
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
    expect(log).toEqual(['commit started', 'agent started']);
    commit.release();
    agent.release();
    await stop.started;
    stop.release();
    await close.started;
    close.release();
    expect(await Promise.all([committing, working, stopping, closing])).toEqual([
      'commit',
      'agent',
      'stop',
      'close',
    ]);
    expect(log).toEqual([
      'commit started',
      'agent started',
      'commit done',
      'agent done',
      'stop started',
      'stop done',
      'close started',
      'close done',
    ]);
  });

  it('passes the caller’s signal to the op, and drops a queued op whose caller gave up', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    const first = controlled(log, 'first');
    const second = controlled(log, 'second');
    const caller = new AbortController();
    const running = scopes.run(['app'], {}, caller.signal, first.op);
    const waiting = new AbortController();
    const queued = scopes.run(['app'], {}, waiting.signal, second.op);
    await first.started;
    waiting.abort(new Error('gone'));
    await expect(queued).rejects.toThrow('gone');
    caller.abort(new Error('left'));
    expect(await running).toBe('first');
    expect(log).toEqual(['first started', 'first aborted']);
    // The scope is free again.
    const third = controlled(log, 'third');
    const after = scopes.run(['app'], {}, undefined, third.op);
    await third.started;
    third.release();
    expect(await after).toBe('third');
  });

  it('frees its scope when an op fails', async () => {
    const scopes = new Scopes();
    await expect(
      scopes.run(['app', 'c'], {}, undefined, () => Promise.reject(new Error('broken'))),
    ).rejects.toThrow('broken');
    expect(await scopes.run(['app', 'c'], {}, undefined, () => Promise.resolve('next'))).toBe(
      'next',
    );
  });
  it('preemption keeps queued descendant operations behind it', async () => {
    const scopes = new Scopes();
    const log: string[] = [];
    const started = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const active = scopes.run(['app', 'c', 'a'], {}, undefined, async (signal) => {
      started.resolve(undefined);
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });
      log.push('old ended');
    });
    await started.promise;
    const queued = scopes.run(['app', 'c', 'a'], {}, undefined, async () => {
      log.push('queued started');
      await release.promise;
      log.push('queued ended');
    });
    const preempt = scopes.run(['app', 'c'], { preempt: true }, undefined, () => {
      log.push('preempt');
      return Promise.resolve();
    });
    await preempt;
    release.resolve(undefined);
    await Promise.all([active, queued]);
    expect(log.indexOf('preempt')).toBeLessThan(log.indexOf('queued started'));
  });

  it('caller cancellation cannot abort a scope after noReturn', async () => {
    const scopes = new Scopes();
    const caller = new AbortController();
    const entered = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<undefined>();
    const operation = scopes.run(['app', 'c'], {}, caller.signal, async (signal, noReturn) => {
      noReturn();
      entered.resolve(signal);
      await release.promise;
      return signal.aborted;
    });
    await entered.promise;
    caller.abort(new Error('client disconnected'));
    release.resolve(undefined);
    const aborted = await operation;
    expect(aborted).toBe(false);
  });
});
