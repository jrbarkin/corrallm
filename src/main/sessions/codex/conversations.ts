import { realpath } from 'node:fs/promises';

import type { KeptConversation } from '../adapter';
import { property, text } from '../transcript';
import { askAppServer, startAppServer } from './rpc';
import type { AppServer, AppServerOptions } from './rpc';
import type { OptionsContext } from './options';
import { isUuid, requireConversationId } from '../id';

/**
 * Codex 0.160.1's thread/list: cwd filters by exact path, updatedAt is seconds, name or preview
 * supplies the title. No thread is started, resumed or changed by listing it.
 * https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/app-server-protocol/schema/typescript/v2/ThreadListParams.ts
 */
export async function codexConversations(
  context: OptionsContext,
  { start = startAppServer }: { start?: (options: AppServerOptions) => Promise<AppServer> } = {},
): Promise<KeptConversation[]> {
  const cwd = await realpath(context.cwd).catch(() => context.cwd);
  const listed = await askAppServer(
    { ...context, cwd, clientInfo: { name: 'corrallm', title: 'corrallm', version: '0.0.0' } },
    (server) =>
      server.request('thread/list', {
        cwd,
        limit: 50,
        sortKey: 'updated_at',
        archived: false,
        modelProviders: [],
      }),
    { start, ms: 15_000, slow: 'Codex took too long to list its conversations.' },
  );
  const data = property(listed, 'data');
  if (!Array.isArray(data)) throw new Error('Codex did not return its conversations.');
  return data
    .slice(0, 50)
    .flatMap((thread): KeptConversation[] => {
      const id = text(property(thread, 'id'));
      const modified = property(thread, 'updatedAt');
      if (property(thread, 'cwd') !== cwd) return [];
      requireConversationId('codex', id, isUuid);
      if (typeof modified !== 'number' || !Number.isFinite(modified)) return [];
      const line = (value: unknown) => {
        const clean = text(value)?.replace(/\s+/g, ' ').trim();
        return clean === '' ? undefined : clean;
      };
      const title =
        line(property(thread, 'name')) ??
        line(property(thread, 'preview')) ??
        'Untitled conversation';
      const branch = text(property(property(thread, 'gitInfo'), 'branch'));
      return [
        {
          id,
          title: title.slice(0, 120),
          modified: modified * 1000,
          ...(branch === undefined ? {} : { branch }),
        },
      ];
    })
    .sort((a, b) => b.modified - a.modified);
}
