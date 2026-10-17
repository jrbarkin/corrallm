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
    installed: vi
      .fn<SessionBackend['installed']>()
      .mockResolvedValue({ claude: false, codex: false }),
    send: vi.fn<SessionBackend['send']>().mockResolvedValue(null),
    answer: vi.fn<SessionBackend['answer']>().mockResolvedValue(null),
    interrupt: vi.fn<SessionBackend['interrupt']>().mockResolvedValue(null),
    setMode: vi.fn<SessionBackend['setMode']>().mockResolvedValue(null),
    setModel: vi.fn<SessionBackend['setModel']>().mockResolvedValue(null),
    setEffort: vi.fn<SessionBackend['setEffort']>().mockResolvedValue(null),
    stopTask: vi.fn<SessionBackend['stopTask']>().mockResolvedValue(null),
    close: vi.fn<SessionBackend['close']>().mockResolvedValue(null),
    fresh: vi.fn<SessionBackend['fresh']>().mockResolvedValue(null),
    files: vi.fn<SessionBackend['files']>().mockResolvedValue([]),
    options: vi.fn<SessionBackend['options']>().mockResolvedValue({
      models: [],
      defaults: { model: null, effort: null, mode: null },
    }),
    sessions: vi.fn<SessionBackend['sessions']>().mockResolvedValue([]),
    resume: vi.fn<SessionBackend['resume']>().mockResolvedValue(null),
    mcp: vi.fn<SessionBackend['mcp']>().mockResolvedValue([]),
    previewRewind: vi
      .fn<SessionBackend['previewRewind']>()
      .mockResolvedValue({ possible: true, files: [], added: 0, removed: 0 }),
    rewind: vi.fn<SessionBackend['rewind']>().mockResolvedValue({ conversation: false }),
    changeMcp: vi.fn<SessionBackend['changeMcp']>().mockResolvedValue([]),
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
