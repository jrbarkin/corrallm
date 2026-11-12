import { beforeAll, beforeEach } from 'vitest';

/*
 * The writer matrix (Store Writer, step 6a): a setup file for the `main-writer` project
 * (vitest.config.ts), which runs the store, core and delivery suites with every store handed to
 * the writer's thread unless a test says otherwise. 6b flips the default with this evidence.
 */
async function useWriter(): Promise<void> {
  // Import after the test module's mocks, just before its fixture opens the store.
  const { OPEN_DEFAULTS } = await import('./open');
  OPEN_DEFAULTS.writer = true;
}

beforeAll(useWriter);
beforeEach(useWriter);
