import type {
  forkSession,
  getSessionMessages,
  listSessions,
  SDKSessionInfo,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { Conversations } from './conversations';

/** A message of a kept transcript, as getSessionMessages reads it. */
const message = (uuid: string, type: 'user' | 'assistant' = 'user'): SessionMessage => ({
  type,
  uuid,
  session_id: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e10',
  parent_tool_use_id: null,
  parent_agent_id: null,
  message: { role: type, content: uuid },
});

function conversations({
  listed = [],
  messages = [],
}: { listed?: SDKSessionInfo[]; messages?: SessionMessage[] } = {}) {
  const list = vi.fn<typeof listSessions>().mockResolvedValue(listed);
  const read = vi.fn<typeof getSessionMessages>().mockResolvedValue(messages);
  const fork = vi
    .fn<typeof forkSession>()
    .mockResolvedValue({ sessionId: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11' });
  const kept = new Conversations({
    listSessions: list,
    getSessionMessages: read,
    forkSession: fork,
    realpath: (folder) => Promise.resolve(`/real${folder}`),
  });
  return { kept, list, read, fork };
}

describe('Conversations', () => {
  it('keeps valid conversations around malformed ids and warns once', async () => {
    const id = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e12';
    const other = '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e13';
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { kept, read, fork } = conversations({
      listed: [
        { sessionId: id, summary: 'Own', lastModified: 1000 },
        { sessionId: '--resume', summary: 'Unsafe', lastModified: 2000 },
        { sessionId: 'future:session', summary: 'Unknown shape', lastModified: 3000 },
        { sessionId: other, summary: 'Recent', lastModified: 4000 },
      ],
    });
    try {
      await expect(kept.list('/work/shop')).resolves.toEqual([
        { id: other, title: 'Recent', modified: 4000 },
        { id, title: 'Own', modified: 1000 },
      ]);
      expect(warning).toHaveBeenCalledOnce();
      expect(warning.mock.calls[0]?.[0]).toContain('2');
      for (const bad of ['--resume', 'future:session']) {
        await expect(kept.before('/work/shop', bad, 'u1')).rejects.toThrow(/conversation id/);
        await expect(kept.fork('/work/shop', bad, 'u1')).rejects.toThrow(/conversation id/);
      }
      expect(read).not.toHaveBeenCalled();
      expect(fork).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
  it('refuses an option before reading or forking a conversation file', async () => {
    const { kept, read, fork } = conversations();
    await expect(kept.before('/work/shop', '--resume', 'u1')).rejects.toThrow(/conversation id/);
    await expect(kept.fork('/work/shop', '--resume', 'u1')).rejects.toThrow(/conversation id/);
    expect(read).not.toHaveBeenCalled();
    expect(fork).not.toHaveBeenCalled();
  });
  it('lists the folder’s conversations, most recent first, as /resume shows them', async () => {
    const { kept, list } = conversations({
      listed: [
        {
          sessionId: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e12',
          summary: 'Fix the login bug',
          lastModified: 1000,
          fileSize: 2048,
        },
        {
          sessionId: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e13',
          summary: 'Add a cart\nand checkout',
          customTitle: '  Shop  checkout ',
          lastModified: 5000,
          gitBranch: 'main',
        },
        // No branch: the CLI notes HEAD.
        {
          sessionId: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e14',
          summary: '   ',
          lastModified: 3000,
          gitBranch: 'HEAD',
        },
      ],
    });
    await expect(kept.list('/work/shop')).resolves.toEqual([
      {
        id: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e13',
        title: 'Shop checkout',
        modified: 5000,
        branch: 'main',
      },
      {
        id: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e14',
        title: 'Untitled conversation',
        modified: 3000,
      },
      {
        id: '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e12',
        title: 'Fix the login bug',
        modified: 1000,
        bytes: 2048,
      },
    ]);
    // Where the CLI keeps them: by the folder's real path; its own sessions only, not its
    // worktrees' (which resume elsewhere).
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ dir: '/real/work/shop', includeWorktrees: false }),
    );
  });

  it('finds where a rewind to a message forks: the entry before it, or none for the first', async () => {
    const { kept, read } = conversations({
      messages: [message('u1'), message('a1', 'assistant'), message('u2'), message('a2')],
    });
    await expect(
      kept.before('/work/shop', '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e10', 'u2'),
    ).resolves.toBe('a1');
    await expect(
      kept.before('/work/shop', '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e10', 'u1'),
    ).resolves.toBeNull();
    await expect(
      kept.before('/work/shop', '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e10', 'gone'),
    ).rejects.toThrow(/not in this conversation/);
    expect(read).toHaveBeenCalledWith('0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e10', {
      dir: '/real/work/shop',
      includeSystemMessages: true,
    });
  });

  it('forks a conversation up to an entry, as a new one', async () => {
    const { kept, fork } = conversations();
    await expect(
      kept.fork('/work/shop', '0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e10', 'a1'),
    ).resolves.toBe('0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e11');
    expect(fork).toHaveBeenCalledWith('0b3a7d52-6a0c-4f39-9c4e-2f8f0c1d9e10', {
      dir: '/real/work/shop',
      upToMessageId: 'a1',
    });
  });
});
