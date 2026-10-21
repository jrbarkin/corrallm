import path from 'node:path';

import { appProfile } from '../core/host/node';
import { dump } from '../core/store/dump';
import { STORE_FILE } from '../core/store/open';
import type { DumpCommand } from './args';

export interface DumpIO {
  env: NodeJS.ProcessEnv;
  print: (line: string) => Promise<void>;
  error: (line: string) => void;
}

/** Dumps an existing profile, even while its app or serve owns core.lock. */
export async function dumpCommand(command: DumpCommand, io: DumpIO): Promise<number> {
  const profile = path.resolve(command.profile ?? appProfile({ env: io.env }));
  try {
    await dump(path.join(profile, STORE_FILE), io.print);
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // A path or an SQLite error can contain control characters: keep the diagnostic one line.
    io.error(`corrallm dump: ${JSON.stringify(reason).slice(1, -1)}`);
    return 1;
  }
}
