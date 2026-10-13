import { realpath as realPath } from 'node:fs/promises';

import {
  forkSession as forkKept,
  getSessionMessages as readKept,
  listSessions as listKept,
} from '@anthropic-ai/claude-agent-sdk';

import type { PastSession } from '../../../shared/session';

/*
 * The conversations Claude Code keeps for a folder: the transcripts its CLI writes, whichever
 * connection ran it (Terminal or the Agent SDK), read with the Agent SDK's session functions. They
 * are listed for /resume. The CLI keeps them by the folder's real path.
 */

/** At most this many conversations are listed, the most recent. */
const LIMIT = 50;
/** The longest title shown, in characters. */
const TITLE_LENGTH = 120;

/** A conversation kept for a folder, as /resume lists it (which is an agent's own is not its to say). */
export type KeptConversation = Omit<PastSession, 'current'>;

export interface ConversationsDeps {
  /** The Agent SDK's session functions; fakes in tests. */
  listSessions?: typeof listKept;
  getSessionMessages?: typeof readKept;
  forkSession?: typeof forkKept;
  /** Resolves a folder's real path (the CLI keeps its conversations by it). */
  realpath?: (folder: string) => Promise<string>;
}

export class Conversations {
  readonly #deps: Required<ConversationsDeps>;

  constructor({
    listSessions = listKept,
    getSessionMessages = readKept,
    forkSession = forkKept,
    realpath = realPath,
  }: ConversationsDeps = {}) {
    this.#deps = { listSessions, getSessionMessages, forkSession, realpath };
  }

  /** The folder's conversations, most recent first. */
  async list(folder: string): Promise<KeptConversation[]> {
    const listed = await this.#deps.listSessions({
      dir: await this.#real(folder),
      limit: LIMIT,
      // A worktree's conversations resume in that worktree, not here.
      includeWorktrees: false,
    });
    return [...listed]
      .sort((a, b) => b.lastModified - a.lastModified)
      .map((info): KeptConversation => {
        const title = line(info.customTitle) || line(info.summary) || line(info.firstPrompt);
        return {
          id: info.sessionId,
          title: title === '' ? 'Untitled conversation' : cut(title),
          modified: info.lastModified,
          ...(info.fileSize === undefined ? {} : { bytes: info.fileSize }),
          ...(info.gitBranch === undefined || info.gitBranch === ''
            ? {}
            : { branch: info.gitBranch }),
        };
      });
  }

  #real(folder: string): Promise<string> {
    return this.#deps.realpath(folder).catch(() => folder);
  }
}

/** Text on one line, its spaces collapsed; '' for none. */
function line(text: string | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

/** A title no longer than TITLE_LENGTH, ended with "…" when cut. */
function cut(title: string): string {
  return title.length <= TITLE_LENGTH ? title : `${title.slice(0, TITLE_LENGTH - 1).trimEnd()}…`;
}
