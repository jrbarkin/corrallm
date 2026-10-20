import { describe, expect, it, vi } from 'vitest';
import { newCanvasId } from '../../shared/canvas';
import type { RunCheckpoint, RunContext } from '../../shared/run';
import { RunPersistence } from './persistence';
import type { RunSource } from './persistence';

function setup() {
  const stopping = new Set<(request: string) => void>();
  let snapshot = 'running';
  const context: RunContext = { id: newCanvasId(), token: 'original', checkpoint: null };
  const source: RunSource = {
    get: vi.fn().mockResolvedValue(context),
    save: vi.fn().mockResolvedValue(null),
    ready: vi.fn().mockResolvedValue(null),
    onStopping: (listener) => {
      stopping.add(listener);
      return () => {
        stopping.delete(listener);
      };
    },
  };
  const owner = {
    capture: (): RunCheckpoint => ({
      version: 2,
      state: JSON.stringify({ snapshot }),
      messages: '{}',
      updatedAt: 1,
    }),
    open: vi.fn<(_canvas: ReturnType<typeof newCanvasId>) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    restore: vi.fn(),
    freeze: vi.fn(() => {
      snapshot = 'paused';
    }),
    error: vi.fn(),
  };
  const persistence = new RunPersistence(source, owner);
  return {
    persistence,
    source,
    owner,
    context,
    stop: () => {
      for (const listener of stopping) listener('quit-1');
    },
    listeners: () => stopping.size,
    change: (value: string) => {
      snapshot = value;
    },
  };
}

describe('run persistence coordinator', () => {
  it('saves only the run checkpoint, never a renderer document', async () => {
    const { persistence, source } = setup();
    await persistence.initialize();
    await persistence.flush();
    expect(source.save).toHaveBeenCalledExactlyOnceWith('original', expect.any(Object));
  });
  it('waits for an asynchronous freeze before capturing and acknowledging shutdown', async () => {
    const { persistence, source, owner, stop, change } = setup();
    await persistence.initialize();
    const frozen = Promise.withResolvers<void>();
    owner.freeze.mockImplementation(() => {
      return frozen.promise.then(() => {
        change('paused after draft');
      });
    });
    stop();
    await Promise.resolve();
    expect(source.save).not.toHaveBeenCalled();
    frozen.resolve();
    await vi.waitFor(() => {
      expect(source.ready).toHaveBeenCalledExactlyOnceWith('quit-1', null);
    });
    expect(source.save).toHaveBeenLastCalledWith(
      'original',
      expect.objectContaining({ state: JSON.stringify({ snapshot: 'paused after draft' }) }),
    );
  });
  it('does not answer stop requests until started', () => {
    const { source, stop, listeners } = setup();
    stop();
    expect(listeners()).toBe(0);
    expect(source.get).not.toHaveBeenCalled();
    expect(source.ready).not.toHaveBeenCalled();
  });
  it.each(['before restart', 'after restart'])(
    'restores once when loading finishes %s after cleanup',
    async (when) => {
      const { persistence, source, owner, listeners } = setup();
      const loaded = Promise.withResolvers<RunContext>();
      vi.mocked(source.get).mockReturnValue(loaded.promise);
      const first = persistence.initialize();
      persistence.dispose();
      expect(listeners()).toBe(0);
      const context = { id: newCanvasId(), token: 'restored', checkpoint: null };
      if (when === 'before restart') {
        loaded.resolve(context);
        await first;
        expect(owner.restore).not.toHaveBeenCalled();
      }
      const second = persistence.initialize();
      loaded.resolve(context);
      await Promise.all([first, second]);
      expect(owner.restore).toHaveBeenCalledExactlyOnceWith(context);
      expect(source.get).toHaveBeenCalledOnce();
      await persistence.flush();
      expect(source.save).toHaveBeenCalledWith('restored', expect.any(Object));
    },
  );
  it('starts hearing shutdown again without restoring over current work', async () => {
    const { persistence, source, owner, stop, listeners, change } = setup();
    await persistence.initialize();
    await persistence.flush();
    persistence.dispose();
    stop();
    await expect(persistence.flush()).rejects.toThrow('not available');
    await persistence.initialize();
    await persistence.initialize();
    expect(listeners()).toBe(1);
    expect(owner.restore).toHaveBeenCalledOnce();
    change('changed');
    persistence.changed();
    await vi.waitFor(() => {
      expect(source.save).toHaveBeenCalledTimes(2);
    });
    stop();
    await vi.waitFor(() => {
      expect(source.ready).toHaveBeenCalledExactlyOnceWith('quit-1', null);
    });
    persistence.dispose();
    expect(listeners()).toBe(0);
  });
  it('freezes and durably saves before acknowledging shutdown', async () => {
    const { persistence, source, owner, stop } = setup();
    const saving = Promise.withResolvers<null>();
    vi.mocked(source.save).mockReturnValue(saving.promise);
    await persistence.initialize();
    stop();
    await vi.waitFor(() => {
      expect(source.save).toHaveBeenCalledOnce();
    });
    expect(owner.freeze).toHaveBeenCalledOnce();
    expect(source.ready).not.toHaveBeenCalled();
    expect(vi.mocked(source.save).mock.calls[0]?.[1]?.state).toBe('{"snapshot":"paused"}');
    saving.resolve(null);
    await vi.waitFor(() => {
      expect(source.ready).toHaveBeenCalledWith('quit-1', null);
    });
  });
  it('reports a failed write and refuses to acknowledge a successful close', async () => {
    const { persistence, source, owner, stop } = setup();
    vi.mocked(source.save).mockRejectedValue(new Error('Disk full'));
    await persistence.initialize();
    stop();
    await vi.waitFor(() => {
      expect(source.ready).toHaveBeenCalledWith('quit-1', 'Disk full');
    });
    expect(owner.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'Disk full' }));
  });
  it('waits for an identical checkpoint and saves a later state reverted while the first write waits', async () => {
    const { persistence, source, change } = setup();
    const held = Promise.withResolvers<null>();
    vi.mocked(source.save).mockReturnValueOnce(held.promise);
    await persistence.initialize();
    const first = persistence.flush(),
      identical = persistence.flush();
    await vi.waitFor(() => {
      expect(source.save).toHaveBeenCalledOnce();
    });
    change('edited');
    const changed = persistence.flush();
    await Promise.resolve();
    change('running');
    const reverted = persistence.flush();
    await Promise.resolve();
    held.resolve(null);
    await Promise.all([first, identical, changed, reverted]);
    expect(vi.mocked(source.save).mock.calls.map(([, checkpoint]) => checkpoint?.state)).toEqual([
      '{"snapshot":"running"}',
      '{"snapshot":"edited"}',
      '{"snapshot":"running"}',
    ]);
  });
  it('retries the same checkpoint after a failed write', async () => {
    const { persistence, source } = setup();
    vi.mocked(source.save).mockRejectedValueOnce(new Error('Disk full'));
    await expect(persistence.flush()).rejects.toThrow('Disk full');
    await persistence.flush();
    expect(source.save).toHaveBeenCalledTimes(2);
  });
  it('flushes before the switching op, resets and waits for the mirror, then reads the new run', async () => {
    const { persistence, source, owner } = setup();
    await persistence.initialize();
    const next = newCanvasId(),
      order: string[] = [];
    vi.mocked(source.save).mockImplementation(() => {
      order.push('save');
      return Promise.resolve();
    });
    owner.open.mockImplementation(async (canvas) => {
      expect(canvas).toBe(next);
      order.push('mirror');
    });
    vi.mocked(source.get).mockImplementation(() => {
      order.push('get');
      return Promise.resolve({ id: next, token: 'new', checkpoint: null });
    });
    owner.restore.mockImplementation(() => {
      order.push('restore');
    });
    await persistence.switch(() => {
      order.push('op');
      return Promise.resolve(next);
    });
    expect(order).toEqual(['save', 'op', 'mirror', 'get', 'restore']);
    await persistence.flush();
    expect(source.save).toHaveBeenLastCalledWith('new', expect.any(Object));
  });
  it.each(['cancelled', 'refused'])(
    'keeps the current token and stores after a %s switch',
    async (why) => {
      const { persistence, source, owner } = setup();
      await persistence.initialize();
      const action = () =>
        why === 'cancelled' ? Promise.resolve(null) : Promise.reject(new Error('Invalid file'));
      const attempt = persistence.switch(action);
      if (why === 'cancelled') await attempt;
      else await expect(attempt).rejects.toThrow('Invalid file');
      expect(owner.open).not.toHaveBeenCalled();
      expect(owner.restore).toHaveBeenCalledOnce();
      await persistence.flush();
      expect(source.save).toHaveBeenLastCalledWith('original', expect.any(Object));
    },
  );
  it('makes shutdown wait through a switch and saves only the new generation afterwards', async () => {
    const { persistence, source } = setup();
    await persistence.initialize();
    const held = Promise.withResolvers<ReturnType<typeof newCanvasId>>();
    vi.mocked(source.get).mockResolvedValue({ id: newCanvasId(), token: 'new', checkpoint: null });
    const switching = persistence.switch(() => held.promise);
    await vi.waitFor(() => {
      expect(source.save).toHaveBeenCalledOnce();
    });
    const flush = persistence.flush();
    await Promise.resolve();
    expect(source.save).toHaveBeenCalledOnce();
    held.resolve(newCanvasId());
    await switching;
    await flush;
    expect(source.save).toHaveBeenLastCalledWith('new', expect.any(Object));
  });
  it('serializes two switches and holds writes until both finish', async () => {
    const { persistence, source } = setup();
    await persistence.initialize();
    const held = Promise.withResolvers<ReturnType<typeof newCanvasId>>();
    let token = 'first';
    vi.mocked(source.get).mockImplementation(() =>
      Promise.resolve({ id: newCanvasId(), token, checkpoint: null }),
    );
    const first = persistence.switch(() => held.promise),
      secondAction = vi.fn(() => {
        token = 'second';
        return Promise.resolve(newCanvasId());
      });
    const second = persistence.switch(secondAction),
      flush = persistence.flush();
    await vi.waitFor(() => {
      expect(source.save).toHaveBeenCalledOnce();
    });
    expect(secondAction).not.toHaveBeenCalled();
    held.resolve(newCanvasId());
    await Promise.all([first, second, flush]);
    expect(source.save).toHaveBeenLastCalledWith('second', expect.any(Object));
  });
  it('refuses a queued flush after disposal during a switch', async () => {
    const { persistence, source } = setup();
    await persistence.initialize();
    const held = Promise.withResolvers<ReturnType<typeof newCanvasId>>();
    const switching = persistence.switch(() => held.promise);
    await vi.waitFor(() => {
      expect(source.save).toHaveBeenCalledOnce();
    });
    const flush = persistence.flush();
    persistence.dispose();
    held.resolve(newCanvasId());
    await switching;
    await expect(flush).rejects.toThrow('not available');
  });
  it.each(['load', 'restore'])(
    'keeps a rejected %s untouched until an explicit switch',
    async (failure) => {
      const { persistence, source, owner, stop } = setup();
      if (failure === 'load')
        vi.mocked(source.get).mockRejectedValueOnce(new Error('Corrupt saved state'));
      else
        owner.restore.mockImplementationOnce(() => {
          throw new Error('Corrupt saved state');
        });
      await expect(persistence.initialize()).rejects.toThrow('Corrupt');
      stop();
      await vi.waitFor(() => {
        expect(source.ready).toHaveBeenCalledWith('quit-1', null);
      });
      expect(source.save).not.toHaveBeenCalled();
      await persistence.switch(() => Promise.resolve(newCanvasId()));
      await persistence.flush();
      expect(source.save).toHaveBeenCalledWith('original', expect.any(Object));
    },
  );
  it('refuses to silently discard a run changed after a failed initialization', async () => {
    const { persistence, source, stop, change } = setup();
    vi.mocked(source.get).mockRejectedValueOnce(new Error('Corrupt'));
    await expect(persistence.initialize()).rejects.toThrow('Corrupt');
    change('changed');
    stop();
    await vi.waitFor(() => {
      expect(source.ready).toHaveBeenCalledWith('quit-1', expect.stringContaining('New or Open'));
    });
    expect(source.save).not.toHaveBeenCalled();
  });
  it('blocks saving if the new canvas cannot restore, then recovers with another switch', async () => {
    const { persistence, source, owner } = setup();
    await persistence.initialize();
    vi.mocked(source.get).mockResolvedValue({ id: newCanvasId(), token: 'new', checkpoint: null });
    owner.restore.mockImplementationOnce(() => {
      throw new Error('Invalid checkpoint');
    });
    await expect(persistence.switch(() => Promise.resolve(newCanvasId()))).rejects.toThrow(
      'Invalid',
    );
    await expect(persistence.flush()).rejects.toThrow('Invalid');
    await persistence.switch(() => Promise.resolve(newCanvasId()));
    await persistence.flush();
    expect(source.save).toHaveBeenLastCalledWith('new', expect.any(Object));
  });
});
