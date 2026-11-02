import { defineConfig } from '@playwright/test';

// The README's pictures (`pnpm media`): one spec that launches the production build as the e2e
// suite does (global setup builds it, or reuses it with E2E_SKIP_BUILD=1), runs a demo canvas with
// scripted fake agents and writes docs/images/. Not part of `pnpm test:e2e`, nor of CI.
export default defineConfig({
  testDir: './e2e/media',
  testMatch: '**/*.media.ts',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  // A take whose timing slipped (the GIF too long, a press too late) is retaken, twice at most.
  retries: 2,
  timeout: 5 * 60_000,
  reporter: 'list',
});
