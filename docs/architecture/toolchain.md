# Commands and toolchain

[Architecture index](overview.md) · [Canonical instructions](../../AGENTS.md)

## `build/`

Packaging resources (macOS entitlements, patched rpm spec template).

## `scripts/`

corrallm.mjs (`pnpm corrallm`); check-linux.sh, the packaged Linux arm64 check in Docker.

TypeScript: `tsconfig.json` is solution-style and references `tsconfig.node.json` (main, preload, shared), `tsconfig.web.json` (renderer, shared) and `tsconfig.tooling.json` (config files, e2e). All extend `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Every new `.ts` file must fall under one of these `include`s, or type-aware lint fails with "not found by the project service".

Forge's Vite plugin builds `src/main/index.ts` to `.vite/build/main.cjs`, `src/main/core/entry.ts` to `.vite/build/core.cjs` (with main's config), `src/preload/index.ts` to `.vite/build/preload.cjs`, and the renderer to `.vite/renderer/main_window/`. `pnpm build:cli` builds `src/main/cli/index.ts` for plain Node to `dist-cli/corrallm.cjs`, outside `.vite/`, which Forge empties on every `pnpm dev` and `pnpm package`.

Forge ships root `NOTICE` and `LICENSE`, plus `claude-agent-sdk-LICENSE.md`, as extra resources outside app.asar (Contents/Resources on macOS, resources elsewhere). Its `generateAssets` hook copies the installed SDK's own LICENSE.md byte for byte into node_modules/.cache/corrallm-licenses on every build; no license copy is checked in. The optional SDK connection bundles Anthropic's unmodified SDK JavaScript under its separate terms; pnpm excludes its per-platform Claude Code binaries, and the connection uses the user's installed executable. `src/main/packaging.test.ts` checks the resource configuration and license bytes.

`.github/dependabot.yml` checks npm (including pnpm) and GitHub Actions weekly, with a one-day version-update cooldown. GitHub does not apply that cooldown to security updates; pnpm's explicit `minimumReleaseAge: 1440` remains the install gate for those. Security alerts/updates and private vulnerability reporting are repository settings enabled by the maintainer, not by this file. CONTRIBUTING.md specifies DCO sign-off and SECURITY.md the private reporting policy.

GitHub's [October 20, 2026 pnpm support announcement](https://github.blog/changelog/2026-10-20-dependabot-now-supports-npm-12-pnpm-11-and-12-and-bun-1-4/) identifies a current limit: version updates support pnpm 12, but the dependency graph cannot read its two-document lockfile, so alerts and security updates are not created for those locked dependencies. This repository's pnpm-lock.yaml has that format. Enabling the repository settings alone does not resolve that upstream limit.

## Commands

Requires Node 24.21.0 (`.nvmrc`) and pnpm 12.11.2 (`packageManager`).

| Command            | Purpose                                                                                                                                                   |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`         | `electron-forge start`: Vite dev server + HMR; press `r` in its terminal UI after main-process changes                                                    |
| `pnpm typecheck`   | `tsc -b` over the solution (node, web, tooling projects)                                                                                                  |
| `pnpm lint`        | ESLint, type-aware, zero warnings allowed (`lint:fix` to autofix)                                                                                         |
| `pnpm format`      | Prettier write (`format:check` to verify)                                                                                                                 |
| `pnpm test`        | Vitest: `main`, `preload` (Node), `renderer` (jsdom), then `store-performance` alone                                                                      |
| `pnpm test:e2e`    | Playwright; its global setup first builds the app unsigned (`electron-forge package`) and the CLI                                                         |
| `pnpm package`     | Packaged app for the current OS in `out/`                                                                                                                 |
| `pnpm make`        | Installers for the current OS in `out/make/`                                                                                                              |
| `pnpm build:cli`   | The `corrallm` CLI for plain Node (`vite.cli.config.mts`) in `dist-cli/corrallm.cjs`                                                                      |
| `pnpm corrallm`    | Runs the CLI bundle: `serve`, `wait`, `dump` (see Headless) or the self-test (`scripts/corrallm.mjs`; it says to run `pnpm build:cli` when it is missing) |
| `pnpm api:surface` | Writes `src/shared/api/surface.snap.json`, every party's surface, after the registry changes                                                              |

- Run one Vitest project with `pnpm exec vitest run --project main`.
- `pnpm exec vitest run --project store-performance` runs the large-snapshot loop measurement. Its `sequence.groupOrder` runs it after the parallel pool in a full gate, with its original fixture, timeout and responsiveness bound.
- `E2E_SKIP_BUILD=1 pnpm test:e2e` reuses the existing production build in `.vite/` and the CLI bundle in `dist-cli/` (note `pnpm dev` overwrites `.vite/`). Headless Linux: `xvfb-run -a pnpm test:e2e`.
- `CORRALLM_AGENT_PATHS='{"claude-code":"/absolute/path/to/claude","codex":"/absolute/path/to/codex"}'` selects executables by adapter. A nonempty value is an exclusive JSON map: omitted adapters and missing executables are unavailable, with no fallback. Unset or empty uses the user's installs as usual. Invalid JSON, keys or non-absolute paths refuse core startup with a sentence. The platform's `sessions/locate.ts` resolves each adapter once per agents' environment and supplies its executable to connectors and readers (options, conversations, usage); adapters never discover an executable themselves.
- `CORRALLM_DISTRIBUTION=commercial` (or `hosted`) when building (`pnpm package`, `pnpm make`) makes a build for a commercial or hosted product, whose App Server connection refuses a ChatGPT login (see Codex); the default is `local`.
- Packaged-app native check: after `pnpm package`, run the app binary with `CORRALLM_NATIVE_SELFTEST=1` (e.g. `CORRALLM_NATIVE_SELFTEST=1 out/corrallm-darwin-arm64/corrallm.app/Contents/MacOS/corrallm`). `runNativeSelfTest` (`src/main/native-selftest.ts`) runs `src/main/core/selftest.ts`'s checks in main, then forks the core process (`core.cjs`, an Electron utility process: `host/core-process.ts`) and asks it over CoreLink to run them there too, printing how soon it was ready after the fork and its memory. The checks (Electron-free): a shell that exits in a node-pty pseudo-terminal (through `spawnPty`, as Terminal agents run); a terminal screen copy (@xterm/headless and its addons) reads a status report and snapshots; the bundled Agent SDK (its `import.meta.url` define, its spawning) runs a query against `src/main/sessions/claude-code/selftest-claude.mjs`, a tiny fake `claude` bundled as text (`?raw`, typed in `src/main/raw.d.ts`) only for this, written to a temporary folder and run with the `node` on the PATH (no login); the core's database (`core/store/`, through Node's built-in `node:sqlite`) opens in a temporary profile as the core opens it, and reports SQLite's version, WAL, `synchronous=NORMAL`, on macOS `fullfsync`, its other pragmas as it sets them (naming one that isn't), a write through its lane (its log flushed on Node's thread pool) read back by a read-only connection, a checkpoint on its checkpointer's worker thread, which begins the log anew there, a snapshot (SQLite's backup, on Node's thread pool) read back, and (but on Windows) `core.db`, `-wal` and `-shm` at 0600, then the profile is removed; a loopback HTTP server is called; a shell is spawned; and, packaged, `child_process.fork` throws (the RunAsNode fuse). It exits 0 on success, 2 if a check fails (saying which) or the core process does, 3 on a timeout, 4 on an uncaught error. CI runs this on all three OSes; `scripts/check-linux.sh` runs it (and the launch-switch checks, and the CLI's) for Linux arm64 in Docker; `src/main/core/selftest.test.ts` runs the checks in the unit tests, and `e2e/selftest.e2e.ts` runs the unpackaged build's in main and its core process. `CORRALLM_NATIVE_SELFTEST=1 pnpm corrallm` runs them under plain Node, in the CLI bundle (built by `pnpm build:cli`), exiting the same way.

## Toolchain notes

- TypeScript is pinned to `~6.0.3`. typescript-eslint does not support TypeScript 7 yet; don't upgrade.
- pnpm 11+ reads only auth/registry settings from `.npmrc`. Everything else (`nodeLinker: hoisted`, which Forge requires; `engineStrict`; `allowBuilds`; `minimumReleaseAge`) lives in `pnpm-workspace.yaml`. Dependency build scripts fail the install unless listed in `allowBuilds`.
- `minimumReleaseAge: 1440` is set explicitly, which makes it strict: an install that needs a version under a day old fails. Wait instead of approving it, and treat any `minimumReleaseAgeExclude` diff as a red flag.
- `peerDependencies.electron-winstaller` in `package.json` is intentional (from Forge 8's pnpm template): it keeps maker-squirrel's dependencies resolvable when Forge loads `forge.config.mts` under pnpm. Don't remove it.
- Electron 44 downloads its binary on first use: `pnpm exec install-electron` fetches it up front.
- Unsigned macOS builds are re-signed ad hoc in the `postPackage` hook so the bundle signature verifies. Signing and notarization turn on from env vars (`.env.example`); `CORRALLM_UNSIGNED=1` forces an unsigned build.
- `build/rpm.spec.ejs` is a patched copy of electron-installer-redhat's template (rpmbuild >= 4.20 fix); delete it once upstream ships the fix.
- Forge 8's terminal UI hides plain logs; set `CI=1` for linear output.
- The main, core and CLI bundles are CommonJS, where `import.meta` does not exist: `vite.main.config.mts` defines `import.meta.url` as the bundle's own file URL (`mainDefine`, which `vite.cli.config.mts` reuses; the Agent SDK uses it when loaded). Without it the bundler writes `{}.url` and main crashes at start; `e2e/sdk.e2e.ts` and the native self-test (packaged, and the CLI's) would catch it.
- The CLI bundle must not import Electron: `vite.cli.config.mts` fails the build if it does.
- Packaged app updates use Electron's `autoUpdater` with update-electron-app's fixed public service feed on macOS and Windows; Linux checks GitHub for a newer stable release. Signed macOS only; never in dev, unpackaged e2e, the native self-test, CLI or serve. `CORRALLM_NO_UPDATE_CHECK=1` disables checks. See [App updates](updates.md) for contacted services, schedule, signature detection and the save-before-restart path.
