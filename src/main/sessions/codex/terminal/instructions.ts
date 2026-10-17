import { readDeveloperInstructions } from '../app-server/instructions';
import { askAppServer, startAppServer } from '../rpc';
import type { AppServer, AppServerOptions } from '../rpc';
import { folderTrust } from './hooks';

export interface InstructionsContext {
  codex: string;
  cwd: string;
  env: Readonly<Record<string, string>>;
}

/** Read-only private server: no thread, turn, or changes to the user's config.toml. */
export function nativeDeveloperInstructions(
  context: InstructionsContext,
  {
    start = startAppServer,
    ms = 15_000,
  }: {
    start?: (options: AppServerOptions) => Promise<AppServer>;
    ms?: number;
  } = {},
): Promise<string | undefined> {
  return askAppServer(
    {
      ...context,
      clientInfo: { name: 'corrallm', title: 'corrallm', version: '0.0.0' },
      args: ['-c', folderTrust(context.cwd)],
    },
    (server) => readDeveloperInstructions(server, context.cwd),
    { start, ms, slow: 'Codex took too long to read its developer instructions.' },
  );
}
