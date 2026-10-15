import { describe, expect, it, vi } from 'vitest';

import type { RunCheckpoint, RunContext } from '../../shared/run';
import { RunPersistence } from './persistence';
import type { RunSource } from './persistence';

function setup() {
  let stopping: ((request: string) => void) | undefined;
  let snapshot = 'running';
  const context: RunContext = { token: 'original', checkpoint: null, name: null };
  const source: RunSource = {
    get: vi.fn().mockResolvedValue(context),
    save: vi.fn().mockResolvedValue(null),
    ready: vi.fn().mockResolvedValue(null),
    onStopping: (listener) => {
      stopping = listener;
      return () => {
        stopping = undefined;
      };
    },
  };
  const owner = {
    capture: (): RunCheckpoint => ({
      version: 1,
      workflow: '{}',
      state: JSON.stringify({ snapshot }),
      messages: '{}',
      updatedAt: 1,
    }),
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
    stop: () => stopping?.('quit-1'),
    change: (value: string) => {
      snapshot = value;
    },
  };
}

describe('run persistence coordinator', () => {
  it('freezes and durably saves before acknowledging shutdown', async () => {
    const { persistence, source, owner, stop } = setup();
    let release: (() => void) | undefined;
    vi.mocked(source.save).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve(null);
          };
        }),
    );
    await persistence.initialize();
    stop();
    await vi.waitFor(() => {
      expect(source.save).toHaveBeenCalledOnce();
    });
    expect(owner.freeze).toHaveBeenCalledOnce();
    expect(vi.mocked(source.save).mock.calls[0]?.[1]?.state).toBe('{"snapshot":"paused"}');
    expect(source.ready).not.toHaveBeenCalled();
    release?.();
    await vi.waitFor(() => {
      expect(source.ready).toHaveBeenCalledWith('quit-1', null);
    });
  });

  it('reports a write failure and refuses to acknowledge a successful close', async () => {
    const { persistence, source, owner, stop } = setup();
    vi.mocked(source.save).mockRejectedValue(new Error('Disk full'));
    await persistence.initialize();
    stop();
    await vi.waitFor(() => {
      expect(source.ready).toHaveBeenCalledWith('quit-1', 'Disk full');
    });
    expect(owner.freeze).toHaveBeenCalledOnce();
    expect(owner.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'Disk full' }));
  });

  it('holds writes across a canvas identity change and uses the new generation', async () => {
    const { persistence, source } = setup();
    await persistence.initialize();
    let finish: (() => void) | undefined;
    const action = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(source.get).mockResolvedValue({
      token: 'new',
      checkpoint: null,
      name: 'Saved.corral',
    });
    const transition = persistence.transition(() => action, false);
    const save = persistence.flush();
    await Promise.resolve();
    expect(source.save).not.toHaveBeenCalled();
    finish?.();
    await transition;
    await save;
    expect(source.save).toHaveBeenCalledWith('new', expect.any(Object));
  });

  it('waits for a pending identical checkpoint and still saves an edit reverted during the write', async () => {
    const { persistence, source, change } = setup();
    let release: (() => void) | undefined;
    vi.mocked(source.save).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve(null);
          };
        }),
    );
    await persistence.initialize();
    const first = persistence.flush();
    const identical = persistence.flush();
    await vi.waitFor(() => {
      expect(source.save).toHaveBeenCalledOnce();
    });
    change('edited');
    const edit = persistence.flush();
    await Promise.resolve();
    change('running');
    const reverted = persistence.flush();
    await Promise.resolve();
    release?.();
    await Promise.all([first, identical, edit, reverted]);
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

  it('keeps writes blocked until every queued identity transition finishes', async () => {
    const { persistence, source } = setup();
    await persistence.initialize();
    let finishFirst: (() => void) | undefined;
    let finishSecond: (() => void) | undefined;
    const firstAction = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const secondAction = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    let token = 'original';
    vi.mocked(source.get).mockImplementation(() =>
      Promise.resolve({ token, checkpoint: null, name: null }),
    );
    const first = persistence.transition(async () => {
      await firstAction;
      token = 'first';
    }, false);
    const secondStarted = vi.fn();
    const second = persistence.transition(async () => {
      secondStarted();
      await secondAction;
      token = 'second';
    }, false);
    finishFirst?.();
    await first;
    await vi.waitFor(() => {
      expect(secondStarted).toHaveBeenCalledOnce();
    });
    const write = persistence.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(source.save).not.toHaveBeenCalled();
    finishSecond?.();
    await Promise.all([second, write]);
    expect(source.save).toHaveBeenCalledWith('second', expect.any(Object));
  });

  it('recovers a rejected restore as a draft before allowing the original canvas to save', async () => {
    const { persistence, source, owner } = setup();
    await persistence.initialize();
    const invalid = { token: 'invalid-file', checkpoint: null, name: 'invalid.corral' };
    const draft = { token: 'recovered-draft', checkpoint: null, name: null };
    vi.mocked(source.get).mockResolvedValueOnce(invalid).mockResolvedValue(draft);
    owner.restore.mockImplementationOnce(() => {
      throw new Error('Invalid canvas');
    });
    const recover = vi.fn().mockResolvedValue(undefined);
    await expect(
      persistence.transition(() => Promise.resolve('opened'), true, recover),
    ).rejects.toThrow('Invalid canvas');
    expect(recover).toHaveBeenCalledOnce();
    await persistence.flush();
    expect(source.save).toHaveBeenCalledWith('recovered-draft', expect.any(Object));
    expect(owner.restore).toHaveBeenCalledTimes(2);
  });

  it('allows replacement and an unchanged close after initialization rejects without writing the rejected state', async () => {
    const { persistence, source, stop } = setup();
    vi.mocked(source.get).mockRejectedValueOnce(new Error('Corrupt saved state'));
    await expect(persistence.initialize()).rejects.toThrow('Corrupt saved state');
    await persistence.prepareForReplacement();
    stop();
    await vi.waitFor(() => {
      expect(source.ready).toHaveBeenCalledWith('quit-1', null);
    });
    expect(source.save).not.toHaveBeenCalled();
    await persistence.transition(() => Promise.resolve(undefined), false);
    await persistence.flush();
    expect(source.save).toHaveBeenCalledWith('original', expect.any(Object));
  });

  it('refuses to discard changes made after a failed initialization on close', async () => {
    const { persistence, source, stop, change } = setup();
    vi.mocked(source.get).mockRejectedValueOnce(new Error('Corrupt saved state'));
    await expect(persistence.initialize()).rejects.toThrow('Corrupt saved state');
    change('edited after failure');
    stop();
    await vi.waitFor(() => {
      expect(source.ready).toHaveBeenCalledWith('quit-1', expect.stringContaining('New or Open'));
    });
    expect(source.save).not.toHaveBeenCalled();
  });
});
