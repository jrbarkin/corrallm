# Native modules

[Architecture index](overview.md) · [Canonical instructions](../../AGENTS.md)

## `src/main/native-selftest.ts`

The native self-test in the app: main's checks, then the core process's (see Commands).

## Native modules

- Forge's Vite plugin packages only `.vite/`. `package.json` `dependencies` therefore holds only native modules that ship unbundled; everything Vite bundles (React, electron-squirrel-startup, …) belongs in `devDependencies`.
- To add one (e.g. `better-sqlite3`): add it to `dependencies`; add it to `NATIVE_EXTERNALS` in `vite.main.config.mts` (external in main's, the core's and the CLI's bundles); add it to `NATIVE_MODULES` in `forge.config.mts` (runtime files, build-only deps); extend `asar.unpack` so its binaries are real files; keep it in `rebuildConfig.ignoreModules` if it ships Node-API prebuilds; approve its install script in `pnpm-workspace.yaml` `allowBuilds` only if it needs one. Then load and exercise it in the native self-test's checks (`src/main/core/selftest.ts`) so the packaged self-test (in main and in the core process), the CLI's and CI cover it.
- node-pty is pinned to `1.2.0-beta.14` exactly: 1.1.0 ships a non-executable macOS `spawn-helper` and no Linux prebuilds; beta.15 has a Windows regression (microsoft/node-pty#955).
- node-pty runs Terminal agents (`sessions/terminal/pty.ts`, loaded only when one starts) and the native self-test. Its Node-API prebuild loads under plain Node too (the CLI bundle).
- node-pty on Windows: pass `useConptyDll: true` (its default `kill()` path uses `child_process.fork`, which the RunAsNode fuse breaks). The bundled ConPTY sends a DA1 query (`ESC[c`) at startup and holds output for about 3 s until answered: attach the pty to xterm.js (which answers) or, for headless consumers, reply `\x1b[?1;2c` when the query appears. Kill or await every pty before the app quits (teardown crashes, node-pty #904/#951).
- Unit tests must never import native modules or the real `electron` module: `vi.mock('electron', ...)` (importing it downloads the Electron binary).
