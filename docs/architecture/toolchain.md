# Commands and toolchain

[Architecture index](overview.md) · [Canonical instructions](../../AGENTS.md)

## `build/`

Packaging resources (macOS entitlements, patched rpm spec template), the pinned Node manifest and staging helpers, and the shipped command's launcher.

## `scripts/`

corrallm.mjs (`pnpm corrallm`); the three local Linux Docker gates described below. Their image, working-tree copy, architecture mapping, caches and non-root build user are shared in `scripts/lib/linux-common.sh`; container steps live beside it.

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
- Packaged-app native check: after `pnpm package`, run the app binary with `CORRALLM_NATIVE_SELFTEST=1` (e.g. `CORRALLM_NATIVE_SELFTEST=1 out/corrallm-darwin-arm64/corrallm.app/Contents/MacOS/corrallm`). `runNativeSelfTest` (`src/main/native-selftest.ts`) runs `src/main/core/selftest.ts`'s checks in main, then forks the core process (`core.cjs`, an Electron utility process: `host/core-process.ts`) and asks it over CoreLink to run them there too, printing how soon it was ready after the fork and its memory. The checks (Electron-free): a shell that exits in a node-pty pseudo-terminal (through `spawnPty`, as Terminal agents run); a terminal screen copy (@xterm/headless and its addons) reads a status report and snapshots; the bundled Agent SDK (its `import.meta.url` define, its spawning) runs a query against `src/main/sessions/claude-code/selftest-claude.mjs`, a tiny fake `claude` bundled as text (`?raw`, typed in `src/main/raw.d.ts`) only for this, written to a temporary folder and run with the `node` on the PATH (no login); the core's database (`core/store/`, through Node's built-in `node:sqlite`) opens in a temporary profile as the core opens it, and reports SQLite's version, WAL, `synchronous=NORMAL`, on macOS `fullfsync`, its other pragmas as it sets them (naming one that isn't), a write through its lane (its log flushed on Node's thread pool) read back by a read-only connection, a checkpoint on its checkpointer's worker thread, which begins the log anew there, a snapshot (SQLite's backup, on Node's thread pool) read back, and (but on Windows) `core.db`, `-wal` and `-shm` at 0600, then the profile is removed; a loopback HTTP server is called; a shell is spawned; and, packaged, `child_process.fork` throws (the RunAsNode fuse). It exits 0 on success, 2 if a check fails (saying which) or the core process does, 3 on a timeout, 4 on an uncaught error. The local macOS and Linux gates run this; `scripts/check-linux.sh` runs it (and the launch-switch checks, and the CLI's) for Linux arm64 or x64 in Docker; `src/main/core/selftest.test.ts` runs the checks in the unit tests, and `e2e/selftest.e2e.ts` runs the unpackaged build's in main and its core process. `CORRALLM_NATIVE_SELFTEST=1 pnpm corrallm` runs them under plain Node, in the CLI bundle (built by `pnpm build:cli`), exiting the same way.

## Toolchain notes

### The shipped command

Forge's `prePackage` hook runs `pnpm build:cli`. `packageAfterCopy` then stages the command beside the app, outside ASAR: `Resources/bin/corrallm`, `Resources/cli/corrallm.cjs`, `Resources/cli/node`, `Resources/cli/NODE-LICENSE` and `Resources/cli/node_modules/node-pty/` (lowercase `resources` on Linux). Only node-pty remains external; other JavaScript dependencies are bundled. Its copy contains runtime JS, license and only the target's native prebuilds. The app's native modules still have their own copy in ASAR, with binaries unpacked. Windows command distribution is held.

`build/node-releases.json` pins Node 24.21.0 for darwin-arm64, darwin-x64, linux-x64 and linux-arm64. Its SHA-256 values come from [the official release manifest](https://nodejs.org/dist/v24.21.0/SHASUMS256.txt). They were checked against the payload of `SHASUMS256.txt.asc`, whose signature was verified with Node's [published release keyring](https://github.com/nodejs/release-keys): Antoine du Hamel's key `5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`, also listed in the release's README. Updating Node requires reviewing and committing new digests, not fetching a manifest during packaging. The build downloads the official target archive, caches it under `node_modules/.cache/corrallm-node/`, and checks its digest on every use, cached or new. A mismatch refuses the build. Only the authenticated archive's executable and license are extracted; npm and headers are omitted. Signing modifies the staged executable, never the archive cache.

`build/corrallm` resolves relative and absolute symlink chains with no utilities on PATH, then replaces itself with the bundled Node and CLI. It forwards arguments and exit status, with no token handling. Debian and RPM installers link `/usr/bin/corrallm` to this launcher; their desktop entry explicitly launches the GUI binary so the link does not change it into a terminal command. Installing a macOS command from settings is B22a, after B11.

macOS signing discovers the bundled Node with the other enclosed binaries. It uses hardened runtime and `build/entitlements.node.plist` (JIT alone), while the app's existing entitlements and fuses stay unchanged. Unsigned builds sign Node ad hoc, then re-sign the enclosing app while preserving entitlements. The packaged native self-test also invokes the shipped launcher with `CORRALLM_NATIVE_SELFTEST=1` and an empty PATH, exercising its Node, bundle and external pty in addition to the main/core checks. The diagnostic adds its own Node directory to PATH only for its fake SDK child. `scripts/check-linux.sh` invokes this shipped launcher directly too. The app's self-test allows a second one-minute budget for the shipped command.

### Build and runtime

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

## Local CI while the repository is private

The GitHub CI workflow is disabled on GitHub until the repository is public; `.github/workflows/ci.yml` stays checked in. Local gates are CI meanwhile. On macOS run the done gate in AGENTS.md, then `pnpm package` and `scripts/check-macos.sh` (or pass `arm64` or `x64` explicitly). The script checks the exact output bundle: `codesign --verify --deep --strict`, executable node-pty spawn-helper, the native self-test in main/core/shipped Node, the three refused launch switches (exit 1), and the shipped command's self-test and --help with an empty PATH. It does not rebuild or download anything, and reports the failed step before stopping. Keep the machine awake and avoid overlapping gates for the load measurements.

On Linux use Docker (Docker Desktop on macOS), from the checkout:

```sh
scripts/ci-linux.sh arm64
scripts/check-linux.sh arm64
scripts/check-linux-packages.sh arm64
scripts/ci-linux.sh x64
scripts/check-linux.sh x64
scripts/check-linux-packages.sh x64
```

All three default to arm64. arm64 is native on Apple Silicon; x64 maps to Docker's linux/amd64 and runs under emulation there (Rosetta when Docker Desktop has it enabled), which is slow. Each prints its current step and stops with a named failure and a nonzero status. No host Node or pnpm is needed.

The shared build image is Debian bookworm with the Node and pnpm pins read from `.nvmrc` and package.json, plus display and packaging tools. It runs as `node`, never root. Git selects tracked and untracked non-ignored working files, retaining local edits, skipping deletions; only that archive enters the container. Ignored credentials, host node_modules, build outputs and .git are not copied. Images and pnpm/Electron/pinned-Node download volumes are retained per architecture (`corrallm-check-linux-arm64` or `corrallm-check-linux-x64`, with -pnpm, -electron and -node volume suffixes). The Dockerfile is the entire image-build context.

Docker containers use an init process, a 1 GiB shared-memory segment and unconfined seccomp/AppArmor profiles so Chromium can create user namespaces. Electron's sandbox stays enabled; do not add --no-sandbox. A host that disallows unprivileged user namespaces must allow them before this gate can pass.

`ci-linux.sh` installs with the frozen lockfile, downloads Electron, runs typecheck, lint, format:check and all unit projects, then runs the whole Playwright suite under xvfb-run with `--retries=0`; a failed first attempt fails the local gate even though `CI=1` enables linear Forge output. It does not set E2E_SKIP_BUILD: the normal global setup makes the production build. There are no new Linux skips. Failed Playwright traces and reports remain in the architecture's -results and -report Docker volumes. To recover diagnostics, for example:

```sh
mkdir -p node_modules/.cache/probes/linux-arm64-results
docker run --rm --volume corrallm-check-linux-arm64-results:/results:ro debian:bookworm tar -C /results -cf - . | tar -C node_modules/.cache/probes/linux-arm64-results -xf -
```

`check-linux.sh` packages and checks the fused app's native self-test (main, utility core and bundled Node), the three refused launch switches, then the shipped command's self-test and --help with an empty PATH.

`check-linux-packages.sh` makes only the deb and rpm through Forge's configured Linux makers (`--targets deb,rpm`: Forge 8 names those instances deb and rpm; module names would construct fresh defaults, losing the launcher, desktop entry and patched spec). A temporary volume carries exactly one installer of each kind and the check scripts into fresh Debian bookworm and Fedora 44 containers; no build tools or checkout are mounted there. apt and dnf install the package with recommends/weak dependencies disabled. Linked libraries are checked before installing the headless harness (Xvfb, xauth, desktop-file-validate and tools for a non-root user). Forge explicitly requires the audio library (Electron links it; the installer's Debian recommendation is insufficient) and procps/procps-ng (the core uses ps to identify its lock owner and CLI process groups). No runtime library is added by hand to rescue an installation.

Each installation checks its package architecture, the /usr/bin/corrallm symlink, the desktop entry and its GUI executable, then runs the same native and refusal checks as a dedicated non-root user. There is no system Node; command checks additionally empty PATH. Purging/removing the package must remove /usr/bin/corrallm, including a dangling link. Containers and the temporary artifact volume are removed on success or failure; the cache and diagnostic volumes remain. [Fedora 44's Xvfb package](https://packages.fedoraproject.org/pkgs/xorg-x11-server/xorg-x11-server-Xvfb/fedora-44.html) includes xvfb-run, so both distributions use the same smoke script.
