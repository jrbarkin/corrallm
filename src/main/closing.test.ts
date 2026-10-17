import { describe, expect, it, vi } from 'vitest';

import { Closing } from './closing';

function setup(answer = false) {
  const saving = Promise.withResolvers<undefined>();
  const deps = {
    save: vi.fn(() => saving.promise),
    abandon: vi.fn(() => Promise.resolve()),
    ask: vi.fn(() => Promise.resolve(answer)),
    done: vi.fn(),
  };
  return { closing: new Closing(deps), deps, saving };
}

describe('Closing', () => {
  it('holds the close until the run is saved, then closes', async () => {
    const { closing, deps, saving } = setup();
    expect(closing.request()).toBe(false);
    expect(deps.done).not.toHaveBeenCalled();
    saving.resolve(undefined);
    await vi.waitFor(() => {
      expect(deps.done).toHaveBeenCalledTimes(1);
    });
    // The close it asks for now goes through.
    expect(closing.request()).toBe(true);
    expect(deps.save).toHaveBeenCalledTimes(1);
  });

  it('asks whether to close anyway when saving fails, and closes if told to', async () => {
    const { closing, deps, saving } = setup(true);
    closing.request();
    saving.reject(new Error('The disk is full'));
    await vi.waitFor(() => {
      expect(deps.done).toHaveBeenCalledTimes(1);
    });
    expect(deps.ask).toHaveBeenCalledWith('The disk is full');
    expect(deps.abandon).toHaveBeenCalledTimes(1);
    expect(closing.request()).toBe(true);
  });

  it('stays open when told to, and tries again on the next close', async () => {
    const { closing, deps, saving } = setup(false);
    closing.request();
    saving.reject(new Error('The window did not finish saving its run before closing'));
    await vi.waitFor(() => {
      expect(deps.ask).toHaveBeenCalledTimes(1);
    });
    expect(deps.done).not.toHaveBeenCalled();
    expect(closing.busy).toBe(false);
    closing.request();
    expect(deps.save).toHaveBeenCalledTimes(2);
  });

  it('closes at once when asked again while it saves', async () => {
    const { closing, deps } = setup();
    closing.request();
    expect(closing.busy).toBe(true);
    expect(closing.request()).toBe(false);
    await vi.waitFor(() => {
      expect(deps.done).toHaveBeenCalledTimes(1);
    });
    expect(deps.abandon).toHaveBeenCalledTimes(1);
    expect(deps.ask).not.toHaveBeenCalled();
  });
});
