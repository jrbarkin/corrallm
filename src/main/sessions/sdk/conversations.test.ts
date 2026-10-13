import type {
  forkSession,
  getSessionMessages,
  listSessions,
  SDKSessionInfo,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';

import { Conversations } from './conversations';

function conversations({
  listed = [],
  messages = [],
}: { listed?: SDKSessionInfo[]; messages?: SessionMessage[] } = {}) {
  const list = vi.fn<typeof listSessions>().mockResolvedValue(listed);
  const read = vi.fn<typeof getSessionMessages>().mockResolvedValue(messages);
  const fork = vi.fn<typeof forkSession>().mockResolvedValue({ sessionId: 'forked' });
  const kept = new Conversations({
    listSessions: list,
    getSessionMessages: read,
    forkSession: fork,
    realpath: (folder) => Promise.resolve(`/real${folder}`),
  });
  return { kept, list, read, fork };
}

describe('Conversations', () => {
  it('lists the folder’s conversations, most recent first, as /resume shows them', async () => {
    const { kept, list } = conversations({
      listed: [
        { sessionId: 'old', summary: 'Fix the login bug', lastModified: 1000, fileSize: 2048 },
        {
          sessionId: 'new',
          summary: 'Add a cart\nand checkout',
          customTitle: '  Shop  checkout ',
          lastModified: 5000,
          gitBranch: 'main',
        },
        { sessionId: 'blank', summary: '   ', lastModified: 3000 },
      ],
    });
    await expect(kept.list('/work/shop')).resolves.toEqual([
      { id: 'new', title: 'Shop checkout', modified: 5000, branch: 'main' },
      { id: 'blank', title: 'Untitled conversation', modified: 3000 },
      { id: 'old', title: 'Fix the login bug', modified: 1000, bytes: 2048 },
    ]);
    // Where the CLI keeps them: by the folder's real path; its own sessions only, not its
    // worktrees' (which resume elsewhere).
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ dir: '/real/work/shop', includeWorktrees: false }),
    );
  });
});
