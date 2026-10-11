import { defineConfig } from '@playwright/test';

// Electron end-to-end tests. They launch the production Vite build (.vite/, produced by
// `electron-forge package`) with the unfused Electron from node_modules: Playwright needs
// Node's --inspect flag, which the EnableNodeCliInspectArguments fuse disables in packaged apps.
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
});
