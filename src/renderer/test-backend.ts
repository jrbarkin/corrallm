import { vi } from 'vitest';

import type { Connection, SessionEvent } from '../shared/session';
import type { SessionBackend } from './agent/connected';

/**
 * For tests: stands in for main's sessions (window.api's session functions). It records what the
 * renderer asks, and `emit` plays events back as a connector would (src/main/sessions/).
 */
export function fakeBackend() {
  let listener:
    ((agentId: string, connection: Connection, event: SessionEvent) => void) | undefined;
  const backend = {
    start: vi.fn<SessionBackend['start']>().mockResolvedValue(null),
    send: vi.fn<SessionBackend['send']>().mockResolvedValue(null),
    answer: vi.fn<SessionBackend['answer']>().mockResolvedValue(null),
    interrupt: vi.fn<SessionBackend['interrupt']>().mockResolvedValue(null),
    setMode: vi.fn<SessionBackend['setMode']>().mockResolvedValue(null),
    setModel: vi.fn<SessionBackend['setModel']>().mockResolvedValue(null),
    setEffort: vi.fn<SessionBackend['setEffort']>().mockResolvedValue(null),
    close: vi.fn<SessionBackend['close']>().mockResolvedValue(null),
    files: vi.fn<SessionBackend['files']>().mockResolvedValue([]),
    onEvent: vi.fn<SessionBackend['onEvent']>((given) => {
      listener = given;
      return () => {
        listener = undefined;
      };
    }),
  };
  return {
    backend,
    /** Main says `events` happened in agent `agentId`'s session, connected through `connection`. */
    emit: (agentId: string, connection: Connection, ...events: SessionEvent[]) => {
      for (const event of events) listener?.(agentId, connection, event);
    },
    /** Whether the renderer listens for session events. */
    listening: () => listener !== undefined,
    /** The id of the message last sent. */
    sent: (): string => {
      const message = backend.send.mock.calls.at(-1)?.[1];
      if (!message) throw new Error('nothing was sent');
      return message.id;
    },
  };
}
