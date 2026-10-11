# CLAUDE.md

corrallm is a cross-platform Electron desktop app (Electron Forge + Vite + React + TypeScript). It will become an agent orchestrator that spawns and manages the Claude Code and Codex CLIs as child processes. Today it is scaffolding only: one IPC channel (`app:ping`) and node-pty installed but unused.

## Commands

Requires Node 24.21.0 (`.nvmrc`) and pnpm 12.11.2 (`packageManager`).

| Command          | Purpose                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `pnpm dev`       | `electron-forge start`: Vite dev server + HMR, main/preload rebuilt on change |
| `pnpm typecheck` | `tsc -b` over the solution (node, web, tooling projects)                      |
| `pnpm lint`      | ESLint, type-aware, zero warnings allowed (`lint:fix` to autofix)             |
| `pnpm format`    | Prettier write (`format:check` to verify)                                     |
| `pnpm test`      | Vitest: `main`, `preload` (Node) and `renderer` (jsdom) projects              |
| `pnpm test:e2e`  | `electron-forge package`, then Playwright against the built (unpackaged) app  |
| `pnpm package`   | Packaged app for the current OS in `out/`                                     |
| `pnpm make`      | Installers for the current OS in `out/make/`                                  |

Run one Vitest project with `pnpm exec vitest run --project main`.

Packaged-app native check: after `pnpm package`, run the app binary with `CORRALLM_NATIVE_SELFTEST=1` (e.g. `CORRALLM_NATIVE_SELFTEST=1 out/corrallm-darwin-arm64/corrallm.app/Contents/MacOS/corrallm`). It loads node-pty, spawns a shell that exits, and exits 0 on success. CI runs this on all three OSes.

## Layout

```
src/main/       Main process (Node). index.ts is the entry; security.ts, app-protocol.ts, csp.ts,
                url-policy.ts hold the security baseline; ipc.ts registers IPC handlers.
src/preload/    Preload script (sandboxed; may import only 'electron'). Exposes window.api.
src/renderer/   React UI. index.html is the Vite root; global.d.ts types window.api.
src/shared/     Types shared by all processes, including the IPC contract (ipc.ts). No Node,
                Electron or DOM imports here.
e2e/            Playwright Electron tests (*.e2e.ts).
build/          Packaging resources (macOS entitlements).
```

TypeScript: `tsconfig.json` is solution-style and references `tsconfig.node.json` (main, preload, shared), `tsconfig.web.json` (renderer, shared) and `tsconfig.tooling.json` (config files, e2e). All extend `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Every new `.ts` file must fall under one of these `include`s, or type-aware lint fails with "not found by the project service".

Forge's Vite plugin builds `src/main/index.ts` to `.vite/build/main.cjs`, `src/preload/index.ts` to `.vite/build/preload.cjs`, and the renderer to `.vite/renderer/main_window/`.

## Security rules (do not regress)

- Never enable `nodeIntegration`, and never disable `contextIsolation`, `sandbox` or `webSecurity`. No `<webview>`.
- The preload exposes one typed function per IPC channel through `contextBridge`. Never expose `ipcRenderer`, a generic `invoke`/`send`, or Electron event objects to the renderer.
- All IPC goes through the contract in `src/shared/ipc.ts` and the `handle()` wrapper in `src/main/ipc.ts`, which validates the sender frame (top-level frame of our own origin) and parses arguments. Never call `ipcMain.handle`/`ipcMain.on` directly.
- Production renderer is served from `app://main_window/` by `src/main/app-protocol.ts` (not `file://`, not `loadFile`). The CSP is a response header from `src/main/csp.ts`: never add `'unsafe-inline'` or `'unsafe-eval'` to `PROD_CSP`. Dev-only relaxations go in `DEV_CSP`.
- Dev vs production is decided by `MAIN_WINDOW_VITE_DEV_SERVER_URL` (defined only under `pnpm dev`), not `app.isPackaged`. e2e runs the production build unpackaged.
- Navigation away from the app origin and renderer-created windows are blocked (`security.ts`). External links open in the default browser only if `isAllowedExternalUrl` passes (https + `EXTERNAL_URL_ALLOWLIST` in `url-policy.ts`).
- All permission requests and checks are denied (`ALLOWED_PERMISSIONS` in `security.ts`). Add entries deliberately.
- Packaged builds exit if launched with `--remote-debugging-port`/`--remote-debugging-pipe`.
- Fuses (`forge.config.mts`) must stay as configured: RunAsNode, `NODE_OPTIONS` and Node inspect flags disabled; ASAR integrity and OnlyLoadAppFromAsar enabled. Consequences: `child_process.fork` throws in packaged builds (use `utilityProcess.fork` or `spawn`), and Playwright cannot drive the packaged app.
- Credentials only come from environment variables (see `.env.example`). Never commit `.env`.

## Adding an IPC channel

1. Declare it in `IpcContract` in `src/shared/ipc.ts`: `'domain:action': { args: [path: string]; result: Thing }`. Add the matching method to `AppApi`.
2. Register it in `registerIpcHandlers` (`src/main/ipc.ts`): `handle('domain:action', parseArgs, handler)`. `parseArgs` receives `unknown[]` from an untrusted renderer and must validate every argument (type, length, allowed values) or throw. Use `noArgs` for channels without arguments.
3. Expose it in `src/preload/index.ts`: `action: (path) => invoke('domain:action', path)`.
4. Call it from the renderer as `window.api.action(...)`.
5. Extend `src/main/ipc.test.ts` (sender rejection, argument validation) and `src/preload/index.test.ts`.

The compiler enforces that main, preload and renderer agree on argument and result types. For main-to-renderer events, add a separate typed event map to `src/shared/ipc.ts` and expose a `subscribe(callback) => unsubscribe` function from the preload; never pass the raw `IpcRendererEvent` to the renderer.

## Native modules

- Forge's Vite plugin packages only `.vite/`. `package.json` `dependencies` therefore holds only native modules that ship unbundled; everything Vite bundles (React, electron-squirrel-startup, …) belongs in `devDependencies`.
- To add one (e.g. `better-sqlite3`): add it to `dependencies`; add it to `external` in `vite.main.config.mts`; add it to `NATIVE_MODULES` in `forge.config.mts` (runtime files, build-only deps); extend `asar.unpack` so its binaries are real files; keep it in `rebuildConfig.ignoreModules` if it ships Node-API prebuilds; approve its install script in `pnpm-workspace.yaml` `allowBuilds` only if it needs one. Verify with the packaged self-test.
- node-pty is pinned to `1.2.0-beta.14` exactly: 1.1.0 ships a non-executable macOS `spawn-helper` and no Linux prebuilds; beta.15 has a Windows regression (microsoft/node-pty#955).
- node-pty on Windows: pass `useConptyDll: true` (its default `kill()` path uses `child_process.fork`, which the RunAsNode fuse breaks). Kill or await every pty before the app quits (teardown crashes, node-pty #904/#951).
- Unit tests must never import native modules or the real `electron` module: `vi.mock('electron', ...)` (importing it downloads the Electron binary).

## Toolchain notes

- TypeScript is pinned to `~6.0.3`. typescript-eslint does not support TypeScript 7 yet; don't upgrade.
- pnpm 11+ reads only auth/registry settings from `.npmrc`. Everything else (`nodeLinker: hoisted`, which Forge requires; `engineStrict`; `allowBuilds`) lives in `pnpm-workspace.yaml`. Dependency build scripts fail the install unless listed in `allowBuilds`.
- pnpm's `minimumReleaseAge` (1 day) blocks freshly published versions. Wait instead of adding `minimumReleaseAgeExclude` entries.
- Electron 44 downloads its binary on first use: `pnpm exec install-electron` fetches it up front.
- Unsigned macOS builds are re-signed ad hoc in the `postPackage` hook so the bundle signature verifies. Signing and notarization turn on from env vars (`.env.example`).
- Forge 8's terminal UI hides plain logs; set `CI=1` for linear output.
- Auto-update is a TODO (Squirrel + ZIP makers are compatible with `update-electron-app`).
