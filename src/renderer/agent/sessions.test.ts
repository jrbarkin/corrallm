import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionStore } from './sessions';

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionStore', () => {
  it('tells whoever sent a message when the turn it starts ends, queued or not', () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    // Never asks for permission, so every turn plays to its end.
    store.setMode('a', 'bypassPermissions');
    const heard: string[] = [];
    const tell = (text: string) => (interrupted: boolean) => {
      heard.push(`${text}${interrupted ? ' (interrupted)' : ''}`);
    };
    store.send('a', 'Claude', 'First', tell('First'));
    store.send('a', 'Claude', 'Second', tell('Second'));
    store.send('a', 'Claude', 'Third', tell('Third'));
    // Taken off the queue before it is sent: it never runs.
    const third = store.of('a').queued[1];
    if (!third) throw new Error('Third is not queued');
    store.unqueue('a', third.id);
    vi.runAllTimers();
    expect(heard).toEqual(['Third (interrupted)', 'First', 'Second']);
    // Stopped mid-turn.
    store.send('a', 'Claude', 'Fourth', tell('Fourth'));
    store.stop('a');
    expect(heard.at(-1)).toBe('Fourth (interrupted)');
  });

  it('tells the user what the run says, in the agent’s session', () => {
    const store = new SessionStore();
    store.notice('a', 'warning', 'corrallm took that as no: the answer wasn’t a clear yes or no.');
    expect(store.of('a').entries).toMatchObject([
      {
        kind: 'notice',
        level: 'warning',
        text: 'corrallm took that as no: the answer wasn’t a clear yes or no.',
      },
    ]);
    expect(store.of('a').status).toBe('idle');
  });

  it('sends a message sent as a turn ends after the ones already queued', () => {
    vi.useFakeTimers();
    const store = new SessionStore();
    store.setMode('a', 'bypassPermissions');
    store.send('a', 'Claude', 'First', () => {
      store.send('a', 'Claude', 'Next');
    });
    store.send('a', 'Claude', 'Second');
    vi.runAllTimers();
    const asked = store.of('a').entries.flatMap((e) => (e.kind === 'user' ? [e.text] : []));
    expect(asked).toEqual(['First', 'Second', 'Next']);
  });
});
