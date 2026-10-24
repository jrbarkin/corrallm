import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread } from 'node:worker_threads';

import { registerTestCli, watchTestLifetime } from './test-lifetime';

// The worker-death regression imports this from an already preloaded stand-in worker.
export { TestChildren } from './test-children';

// This bundle is built only by Vitest's global setup, never by a shipping build.
try {
  if (!isMainThread) {
    // Worker threads inherit --import and share their process's pid. They must not replace
    // its profile record (or race its publication), particularly the SQLite checkpointer.
  } else if (
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
    process.argv[2] === 'watch' &&
    process.argv[3] !== undefined
  ) {
    await watchTestLifetime(process.argv[3], process.stdin);
  } else if (process.env.CORRALLM_TEST_SCOPE !== undefined) {
    await registerTestCli(process.env.CORRALLM_TEST_SCOPE);
  } else {
    throw new Error('No test owner was supplied to the CLI guardian.');
  }
} catch (error) {
  console.error('Test CLI cleanup failed:', error);
  process.exit(1);
}
